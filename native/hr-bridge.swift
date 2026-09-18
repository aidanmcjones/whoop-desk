// hr-bridge — a standalone CoreBluetooth heart-rate listener for Whoop+.
//
// Why this exists: Chromium's Web Bluetooth requires a real user gesture to
// start a scan, so an Electron renderer can never connect to the strap on its
// own. Driving it from a synthetic gesture crashed the browser process. This
// helper talks to CoreBluetooth directly, so it can scan, connect, and
// reconnect forever with no UI and no click.
//
// Protocol: one JSON object per line on stdout. Never write anything else to
// stdout; diagnostics go to stderr.
//
//   {"t":"state","v":"scanning|connecting|connected|disconnected|unauthorized|off"}
//   {"t":"device","id":"<uuid>","name":"WHOOP 4B0"}
//   {"t":"hr","bpm":72,"rr":[0.812],"energy":140,"contact":true,"at":1750000000000}
//   {"t":"battery","pct":76}
//   {"t":"info","fw":"4.1.12","model":"WHOOP 4.0"}
//
// Optional argv[1] is a preferred peripheral UUID to reconnect to first.

import Foundation
import CoreBluetooth

let heartRateService = CBUUID(string: "180D")
let heartRateMeasurement = CBUUID(string: "2A37")
let batteryService = CBUUID(string: "180F")
let batteryLevel = CBUUID(string: "2A19")
let deviceInfoService = CBUUID(string: "180A")
let firmwareRevision = CBUUID(string: "2A26")
let modelNumber = CBUUID(string: "2A24")

/// stdout is line-buffered per event so the parent sees beats in real time.
func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func log(_ message: String) {
    FileHandle.standardError.write("hr-bridge: \(message)\n".data(using: .utf8)!)
}

func nowMillis() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

/// Parse a Heart Rate Measurement (0x2A37) payload. The flags byte decides the
/// width of the bpm field and which optional fields follow it, so every field
/// has to be walked in order — there are no fixed offsets.
func parseMeasurement(_ data: Data) -> [String: Any]? {
    let bytes = [UInt8](data)
    guard bytes.count >= 2 else { return nil }
    let flags = bytes[0]
    var i = 1

    let wide = flags & 0x01 != 0
    var bpm = 0
    if wide {
        guard bytes.count >= 3 else { return nil }
        bpm = Int(bytes[1]) | (Int(bytes[2]) << 8)
        i = 3
    } else {
        bpm = Int(bytes[1])
        i = 2
    }

    var out: [String: Any] = ["t": "hr", "bpm": bpm, "at": nowMillis()]

    // Bits 1-2: sensor contact — supported, and whether contact is detected.
    if flags & 0x04 != 0 {
        out["contact"] = flags & 0x02 != 0
    }

    // Bit 3: energy expended, 16-bit kJ. Skipped past, but reported.
    if flags & 0x08 != 0, bytes.count >= i + 2 {
        out["energy"] = Int(bytes[i]) | (Int(bytes[i + 1]) << 8)
        i += 2
    }

    // Bit 4: RR intervals, 1/1024 s units, however many fit in the remainder.
    if flags & 0x10 != 0 {
        var rr: [Double] = []
        while bytes.count >= i + 2 {
            let raw = Int(bytes[i]) | (Int(bytes[i + 1]) << 8)
            rr.append(Double(raw) / 1024.0)
            i += 2
        }
        if !rr.isEmpty { out["rr"] = rr }
    }

    return out
}

final class Bridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private let preferredId: UUID?
    private var state = ""

    init(preferredId: UUID?) {
        self.preferredId = preferredId
        super.init()
        // showPowerAlert: false — the parent app decides how to surface a
        // powered-off adapter; a system dialog from a helper would be wrong.
        central = CBCentralManager(delegate: self, queue: nil,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: false])
        startAttachPoll()
    }

    private func setState(_ next: String) {
        guard next != state else { return }
        state = next
        emit(["t": "state", "v": next])
    }

    /// Attach to the strap without scanning wherever possible.
    ///
    /// A strap that is already paired to this Mac is *connected* at the system
    /// level, and a connected peripheral stops advertising — so it never shows
    /// up in a scan, no matter how long one runs. retrieveConnectedPeripherals
    /// finds it anyway, and connecting to it is immediate. This is the path
    /// that makes a click unnecessary; the scan below is only for a strap that
    /// this Mac has never seen.
    private func startScan() {
        guard central.state == .poweredOn else { return }

        let attached = central.retrieveConnectedPeripherals(withServices: [heartRateService])
        if let p = attached.first {
            setState("connecting")
            connect(p)
            return
        }

        if let id = preferredId {
            if let p = central.retrievePeripherals(withIdentifiers: [id]).first {
                setState("connecting")
                connect(p)
                return
            }
        }

        setState("scanning")
        central.scanForPeripherals(withServices: [heartRateService],
                                   options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    /// While scanning, the strap may instead reappear as a system-level
    /// connection, which a scan can never observe. Re-check on a timer so
    /// either route picks it up.
    private func startAttachPoll() {
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            guard self.state == "scanning" else { return }
            let attached = self.central.retrieveConnectedPeripherals(withServices: [heartRateService])
            if let p = attached.first {
                self.central.stopScan()
                self.setState("connecting")
                self.connect(p)
            }
        }
    }

    private func connect(_ p: CBPeripheral) {
        peripheral = p
        p.delegate = self
        central.connect(p, options: nil)
    }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            startScan()
        case .unauthorized:
            setState("unauthorized")
        case .poweredOff:
            setState("off")
        default:
            setState("off")
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        c.stopScan()
        setState("connecting")
        connect(p)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        emit(["t": "device", "id": p.identifier.uuidString, "name": p.name ?? ""])
        setState("connected")
        p.discoverServices([heartRateService, batteryService, deviceInfoService])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        log("connect failed: \(error?.localizedDescription ?? "unknown")")
        retry()
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        setState("disconnected")
        retry()
    }

    /// A strap that walks out of range must be picked up again the moment it
    /// returns, so a failed attempt always schedules another one.
    private func retry() {
        peripheral = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self else { return }
            if let p = self.peripheral, p.state == .connected { return }
            self.startScan()
        }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        for service in p.services ?? [] {
            switch service.uuid {
            case heartRateService:
                p.discoverCharacteristics([heartRateMeasurement], for: service)
            case batteryService:
                p.discoverCharacteristics([batteryLevel], for: service)
            case deviceInfoService:
                p.discoverCharacteristics([firmwareRevision, modelNumber], for: service)
            default:
                break
            }
        }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for ch in service.characteristics ?? [] {
            switch ch.uuid {
            case heartRateMeasurement:
                p.setNotifyValue(true, for: ch)
            case batteryLevel:
                p.readValue(for: ch)
                p.setNotifyValue(true, for: ch)
            case firmwareRevision, modelNumber:
                p.readValue(for: ch)
            default:
                break
            }
        }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard let data = ch.value else { return }
        switch ch.uuid {
        case heartRateMeasurement:
            if let payload = parseMeasurement(data) { emit(payload) }
        case batteryLevel:
            if let pct = [UInt8](data).first { emit(["t": "battery", "pct": Int(pct)]) }
        case firmwareRevision:
            emit(["t": "info", "fw": String(data: data, encoding: .utf8) ?? ""])
        case modelNumber:
            emit(["t": "info", "model": String(data: data, encoding: .utf8) ?? ""])
        default:
            break
        }
    }
}

let preferred = CommandLine.arguments.count > 1 ? UUID(uuidString: CommandLine.arguments[1]) : nil
let bridge = Bridge(preferredId: preferred)

// Exit when the parent's stdin closes, so the helper can never outlive the app.
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
stdinSource.setEventHandler {
    var buf = [UInt8](repeating: 0, count: 256)
    let n = read(STDIN_FILENO, &buf, buf.count)
    if n <= 0 { exit(0) }
}
stdinSource.resume()

_ = bridge
RunLoop.main.run()
