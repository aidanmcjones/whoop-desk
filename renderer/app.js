'use strict';

/* ---------------------------------------------------------------
   Whoop Desk — renderer app.js (desktop layout)
   Vanilla JS. Every chart/gauge/ring is inline SVG built here. No deps.

   Data contract: window.whoop.getDashboard() -> the payload normalized by
   src/whoop-client.mjs (profile, recovery[], sleep[], cycles[], workouts[]).
   Falls back to ./mock-data.json when running outside Electron.

   Element contract expected from index.html:
     #reconnect-state, #reconnect-message, #reconnect-retry-btn
     #main-shell, #sidebar, #nav, .nav-item[data-view], #refresh-btn,
     #last-updated
     #top-bar, #greeting, #selected-date, #day-strip
     #content, .view (#view-overview/#view-sleep/#view-strain/
                      #view-health/#view-trends)
     overview: #recovery-hero #strain-card-overview #sleep-summary-card
               #metric-cards #overview-trend #overview-activities
     sleep:    #sleep-hero #sleep-hours-card #sleep-stage-card
               #sleep-stats-card #sleep-trend-card #sleep-breakdown-card
     strain:   #strain-hero #strain-stats-card #workouts-card
               #strain-trend-card #calories-trend-card
     health:   #health-hero #health-tiles #health-table
     trends:   #trends-range-toggle #range-7d #range-30d
               #trend-recovery #trend-hrv #trend-rhr #trend-sleep
               #trend-strain #trend-dashboard
   --------------------------------------------------------------- */

(function () {
  /* Palette mirrors the tokens in styles.css, which follow the captured
     design catalog (reference/notes.md, "Global conventions"). */
  var C = {
    bg: '#0b0e14',
    surface: '#1c1f26',
    raised: '#20242c',
    hairline: '#2a2e36',
    text: '#ffffff',
    label: '#9aa0aa',
    secondary: '#6e7480',
    disabled: '#4a4f58',
    green: '#3ddc84',
    yellow: '#f5c542',
    red: '#ff4d4d',
    strain: '#3b82f6',
    sleep: '#8fa6c4',
    amber: '#e8a33d',
    stageLight: '#9e8fe0',
    stageDeep: '#e37fc0',
    stageRem: '#8b5cf6',
    stageAwake: '#6e7480',
  };

  var state = {
    data: null,
    dateList: [], // newest first
    byDate: { recovery: {}, sleep: {}, cycle: {} },
    workoutsByDate: {},
    selectedIndex: 0,
    activeView: 'overview',
    trendRange: 7,
  };

  // Charts are declared as slots while a card's HTML is built, then filled
  // once the slot is in the DOM and its real pixel width is measurable.
  var pendingCharts = {};
  var chartSeq = 0;

  function chartSlot(builder, fallbackWidth) {
    var id = 'c' + ++chartSeq;
    pendingCharts[id] = { build: builder, fallback: fallbackWidth || 420 };
    return '<div class="chart-slot" data-chart="' + id + '"></div>';
  }

  function fillCharts(root) {
    (root || document).querySelectorAll('[data-chart]').forEach(function (slot) {
      var spec = pendingCharts[slot.getAttribute('data-chart')];
      if (!spec) return;
      var w = Math.round(slot.getBoundingClientRect().width) || spec.fallback;
      slot.innerHTML = spec.build(w);
    });
  }

  /* ---------------- formatting helpers ---------------- */

  function isNum(v) {
    return typeof v === 'number' && !Number.isNaN(v);
  }

  function fmt(v, decimals) {
    if (!isNum(v)) return '--';
    return decimals ? v.toFixed(decimals) : String(Math.round(v));
  }

  function fmtInt(v) {
    if (!isNum(v)) return '--';
    return Math.round(v).toLocaleString();
  }

  // Durations render as h:mm, matching the catalog ("6:14", "10:36").
  function fmtHM(min) {
    if (!isNum(min)) return '--';
    var total = Math.round(min);
    var h = Math.floor(total / 60);
    var m = total % 60;
    return h + ':' + String(m).padStart(2, '0');
  }

  function fmtTime(iso) {
    if (!iso) return '--';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function fmtSigned(v, decimals) {
    if (!isNum(v)) return '--';
    var s = v.toFixed(decimals || 1);
    return (v > 0 ? '+' : '') + s;
  }

  function parseLocalDate(dateStr) {
    var p = String(dateStr).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function headerDateLabel(dateStr, idx) {
    if (idx === 0) return 'Today';
    if (idx === 1) return 'Yesterday';
    var dt = parseLocalDate(dateStr);
    return dt.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // Weekday names only read correctly when the window really is consecutive
  // calendar days; WHOOP skips unworn days, so fall back to "Sep 3".
  function isContiguous(dates) {
    for (var i = 1; i < dates.length; i++) {
      var diff = (parseLocalDate(dates[i]) - parseLocalDate(dates[i - 1])) / 86400000;
      if (Math.round(diff) !== 1) return false;
    }
    return true;
  }

  function axisLabel(dateStr, n, contiguous) {
    var dt = parseLocalDate(dateStr);
    if (n <= 7 && contiguous) return dt.toLocaleDateString(undefined, { weekday: 'short' });
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function avgOf(values, decimals) {
    var present = values.filter(isNum);
    if (!present.length) return null;
    var a = present.reduce(function (x, y) { return x + y; }, 0) / present.length;
    return Number(a.toFixed(decimals == null ? 0 : decimals));
  }

  function percentile(values, p) {
    var s = values.filter(isNum).slice().sort(function (a, b) { return a - b; });
    if (!s.length) return null;
    var i = clamp(Math.round((s.length - 1) * p), 0, s.length - 1);
    return s[i];
  }

  function recoveryColor(score) {
    if (!isNum(score)) return C.disabled;
    if (score >= 67) return C.green;
    if (score >= 34) return C.yellow;
    return C.red;
  }

  function greetingText() {
    var h = new Date().getHours();
    var word = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    var name = state.data && state.data.profile && state.data.profile.firstName;
    return name ? word + ', ' + name : word;
  }

  function endTime(w) {
    if (!w || !w.start || !isNum(w.durationMin)) return null;
    var t = new Date(w.start).getTime();
    if (Number.isNaN(t)) return null;
    return new Date(t + w.durationMin * 60000).toISOString();
  }

  function kcalFromKj(kj) {
    return isNum(kj) ? Math.round(kj * 0.239006) : null;
  }

  function trendGlyph(cur, prior, higherIsBetter) {
    if (!isNum(cur) || !isNum(prior)) return '';
    var diff = cur - prior;
    if (Math.abs(diff) < Math.max(0.0001, Math.abs(prior) * 0.005)) {
      return '<span class="trend-glyph" style="color:' + C.secondary + '">&#9679;</span>';
    }
    var up = diff > 0;
    var good = higherIsBetter === false ? !up : up;
    var color = good ? C.green : C.amber;
    return '<span class="trend-glyph" style="color:' + color + '">' + (up ? '&#9650;' : '&#9660;') + '</span>';
  }

  /* ---------------- SVG: rings ---------------- */

  function ringSVG(o) {
    var size = o.size, stroke = o.stroke, pct = clamp(o.pct || 0, 0, 1), color = o.color;
    var r = (size - stroke) / 2;
    var c = 2 * Math.PI * r;
    var target = c * (1 - pct);
    var half = size / 2;
    return (
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size +
      '" style="position:absolute;inset:0;transform:rotate(-90deg)" aria-hidden="true">' +
      '<circle cx="' + half + '" cy="' + half + '" r="' + r + '" fill="none" stroke="' + C.hairline +
      '" stroke-width="' + stroke + '" />' +
      '<circle class="ring-fg" cx="' + half + '" cy="' + half + '" r="' + r + '" fill="none" stroke="' + color +
      '" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c.toFixed(2) +
      '" stroke-dashoffset="' + c.toFixed(2) + '" data-target-offset="' + target.toFixed(2) + '" />' +
      '</svg>'
    );
  }

  function heroRing(o) {
    return (
      '<div class="ring-figure" style="width:' + o.size + 'px;height:' + o.size + 'px">' +
      ringSVG(o) +
      '<div class="ring-center">' + (o.centerHTML || '') + '</div>' +
      '</div>'
    );
  }

  /* ---------------- SVG: charts ---------------- */

  function niceTicks(min, max, count) {
    if (!(max > min)) { max = min + 1; }
    var span = max - min;
    var raw = span / count;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var err = raw / mag;
    var step = mag;
    if (err >= 7.5) step = mag * 10;
    else if (err >= 3.5) step = mag * 5;
    else if (err >= 1.5) step = mag * 2;
    var out = [];
    var start = Math.ceil(min / step - 1e-9) * step;
    for (var v = start; v <= max + step * 1e-6; v += step) {
      out.push(Number(v.toPrecision(12)));
    }
    return out;
  }

  function geom(width, height) {
    var padL = 48, padR = 16, padT = 18, padB = 26;
    return {
      padL: padL, padR: padR, padT: padT, padB: padB,
      w: width, h: height,
      plotW: Math.max(30, width - padL - padR),
      plotH: Math.max(30, height - padT - padB),
    };
  }

  function txt(x, y, str, o) {
    o = o || {};
    return (
      '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" font-size="' + (o.size || 10) +
      '" font-weight="' + (o.weight || 700) + '" fill="' + (o.fill || C.secondary) +
      '" text-anchor="' + (o.anchor || 'middle') + '"' +
      (o.spacing ? ' letter-spacing="' + o.spacing + '"' : '') + '>' + str + '</text>'
    );
  }

  function gridLayer(g, ticks, yFor, fmtTick) {
    return ticks.map(function (t) {
      var y = yFor(t);
      return (
        '<line x1="' + g.padL + '" y1="' + y.toFixed(1) + '" x2="' + (g.padL + g.plotW) + '" y2="' + y.toFixed(1) +
        '" stroke="' + C.hairline + '" stroke-width="1" />' +
        txt(g.padL - 9, y + 3.4, fmtTick(t), { anchor: 'end', size: 10, fill: C.disabled })
      );
    }).join('');
  }

  function xLabelLayer(g, dates, centerFor) {
    var n = dates.length;
    if (!n) return '';
    var maxLabels = clamp(Math.floor(g.plotW / 78), 3, 14);
    var step = Math.max(1, Math.ceil(n / maxLabels));
    var contiguous = isContiguous(dates);
    var out = '';
    for (var i = 0; i < n; i++) {
      if (i % step !== 0 && i !== n - 1) continue;
      if (i !== n - 1 && n - 1 - i < step * 0.6) continue;
      out += txt(centerFor(i), g.h - 8, axisLabel(dates[i], n, contiguous), { size: 10, fill: C.disabled });
    }
    return out;
  }

  function avgLayer(g, avg, yFor, label) {
    if (!isNum(avg)) return '';
    var y = yFor(avg);
    return (
      '<line x1="' + g.padL + '" y1="' + y.toFixed(1) + '" x2="' + (g.padL + g.plotW) + '" y2="' + y.toFixed(1) +
      '" stroke="' + C.label + '" stroke-width="1.2" stroke-dasharray="4,4" opacity="0.85" />' +
      '<rect x="' + (g.padL + 6) + '" y="' + (y - 10).toFixed(1) + '" width="42" height="19" rx="5" fill="#ffffff" />' +
      txt(g.padL + 27, y + 3.6, label || 'AVG.', { size: 9.5, weight: 800, fill: '#0b0e14', spacing: '0.06em' })
    );
  }

  function svgOpen(w, h) {
    return '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
      '" preserveAspectRatio="xMidYMid meet" role="img">';
  }

  function barChartSVG(o) {
    var g = geom(o.width, o.height || 200);
    var dates = o.dates, values = o.values;
    var n = values.length;
    var present = values.filter(isNum);
    var needPresent = (o.needValues || []).filter(isNum);
    var yMin = isNum(o.yMin) ? o.yMin : 0;
    var yMax = isNum(o.yMax)
      ? o.yMax
      : Math.max.apply(null, present.concat(needPresent).concat([1])) * 1.16;
    function yFor(v) {
      return g.padT + g.plotH - ((clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * g.plotH;
    }
    var slotW = g.plotW / Math.max(1, n);
    var barW = Math.min(30, Math.max(3, slotW * 0.56));
    function centerFor(i) { return g.padL + slotW * (i + 0.5); }

    var highlight = '';
    if (isNum(o.highlightIdx) && o.highlightIdx >= 0) {
      highlight =
        '<rect x="' + (g.padL + slotW * o.highlightIdx).toFixed(1) + '" y="' + g.padT + '" width="' +
        slotW.toFixed(1) + '" height="' + g.plotH + '" fill="#ffffff" opacity="0.04" rx="4" />';
    }

    var bars = '', ticks = '', labels = '';
    for (var i = 0; i < n; i++) {
      var v = values[i];
      var cx = centerFor(i);
      if (isNum(v)) {
        var y = yFor(v);
        var h = Math.max(2.5, g.padT + g.plotH - y);
        var color = typeof o.color === 'function' ? o.color(v, i) : o.color;
        bars +=
          '<rect x="' + (cx - barW / 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) +
          '" height="' + h.toFixed(1) + '" rx="' + Math.min(4, barW / 2).toFixed(1) + '" fill="' + color + '" />';
        if (o.valueLabels && n <= 10) {
          labels += txt(cx, y - 7, o.fmtV ? o.fmtV(v) : fmt(v), { size: 10.5, weight: 800, fill: C.label });
        }
      }
      if (o.needValues && isNum(o.needValues[i])) {
        var ny = yFor(o.needValues[i]);
        ticks +=
          '<line x1="' + (cx - barW / 2 - 2).toFixed(1) + '" y1="' + ny.toFixed(1) + '" x2="' +
          (cx + barW / 2 + 2).toFixed(1) + '" y2="' + ny.toFixed(1) +
          '" stroke="#ffffff" stroke-width="1.6" stroke-dasharray="2.5,2.5" opacity="0.6" />';
      }
    }

    var tickVals = niceTicks(yMin, yMax, 4);
    return (
      svgOpen(g.w, g.h) +
      highlight +
      gridLayer(g, tickVals, yFor, o.fmtTick || function (t) { return fmt(t); }) +
      bars + ticks + labels +
      avgLayer(g, o.avg, yFor, o.avgLabel) +
      xLabelLayer(g, dates, centerFor) +
      '</svg>'
    );
  }

  function lineChartSVG(o) {
    var g = geom(o.width, o.height || 200);
    var dates = o.dates, values = o.values;
    var n = values.length;
    var present = values.filter(isNum);
    var band = o.band && isNum(o.band[0]) && isNum(o.band[1]) ? o.band : null;
    var lo = present.length ? Math.min.apply(null, present) : 0;
    var hi = present.length ? Math.max.apply(null, present) : 1;
    if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
    var pad = (hi - lo) * 0.22 || 1;
    var yMin = isNum(o.yMin) ? o.yMin : lo - pad;
    var yMax = isNum(o.yMax) ? o.yMax : hi + pad;
    function yFor(v) {
      return g.padT + g.plotH - ((clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * g.plotH;
    }
    var slotW = g.plotW / Math.max(1, n);
    function centerFor(i) { return g.padL + slotW * (i + 0.5); }

    var bandHTML = '';
    if (band) {
      var yTop = yFor(band[1]);
      var yBot = yFor(band[0]);
      bandHTML =
        '<rect x="' + g.padL + '" y="' + yTop.toFixed(1) + '" width="' + g.plotW + '" height="' +
        Math.max(2, yBot - yTop).toFixed(1) + '" fill="' + (o.bandColor || C.label) + '" opacity="0.09" rx="3" />';
    }

    var segs = [], cur = [];
    for (var i = 0; i < n; i++) {
      if (!isNum(values[i])) { if (cur.length) { segs.push(cur); cur = []; } continue; }
      cur.push([centerFor(i), yFor(values[i])]);
    }
    if (cur.length) segs.push(cur);
    var d = segs.map(function (seg) {
      return 'M' + seg.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' L');
    }).join(' ');

    var dots = '';
    for (var j = 0; j < n; j++) {
      if (!isNum(values[j])) continue;
      var dc = (o.dotColors && o.dotColors[j]) || o.color;
      dots += '<circle cx="' + centerFor(j).toFixed(1) + '" cy="' + yFor(values[j]).toFixed(1) +
        '" r="3.6" fill="' + dc + '" stroke="' + C.surface + '" stroke-width="1.4" />';
    }

    var tickVals = niceTicks(yMin, yMax, 4);
    return (
      svgOpen(g.w, g.h) +
      gridLayer(g, tickVals, yFor, o.fmtTick || function (t) { return fmt(t); }) +
      bandHTML +
      '<path d="' + d + '" fill="none" stroke="' + (o.lineColor || o.color) +
      '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" opacity="' + (o.lineOpacity || 1) + '" />' +
      dots +
      avgLayer(g, o.avg, yFor, o.avgLabel) +
      xLabelLayer(g, dates, centerFor) +
      '</svg>'
    );
  }

  // Compact sparkline for the metric/vitals tiles.
  function sparklineSVG(o) {
    var w = o.width, h = o.height || 44, color = o.color;
    var values = o.values;
    var present = values.filter(isNum);
    if (!present.length) {
      return svgOpen(w, h) + txt(w / 2, h / 2 + 3, 'NO DATA', { size: 9.5, fill: C.disabled, spacing: '0.1em' }) + '</svg>';
    }
    var min = Math.min.apply(null, present);
    var max = Math.max.apply(null, present);
    var span = (max - min) || 1;
    // Days with no record are dropped rather than left as gaps, so the line
    // spans the full card width instead of floating in the middle of it.
    var padX = 4, padY = 6;
    var innerW = Math.max(10, w - padX * 2);
    var stepX = present.length > 1 ? innerW / (present.length - 1) : 0;
    function yFor(v) { return h - padY - ((v - min) / span) * (h - padY * 2); }

    var pts = present.map(function (v, i) { return [padX + i * stepX, yFor(v)]; });
    var coords = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); });
    var last = pts[pts.length - 1];
    var d = pts.length > 1 ? 'M' + coords.join(' L') : '';
    var area = pts.length > 1
      ? '<path d="M' + pts[0][0].toFixed(1) + ',' + h + ' L' + coords.join(' L') +
        ' L' + last[0].toFixed(1) + ',' + h + ' Z" fill="' + color + '" opacity="0.10" />'
      : '';
    return (
      svgOpen(w, h) + area +
      (d ? '<path d="' + d + '" fill="none" stroke="' + color +
        '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />' : '') +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.8" fill="' + color + '" />' +
      '</svg>'
    );
  }

  /* ---------------- animation kickers ---------------- */

  function animateRingsIn(root) {
    (root || document).querySelectorAll('.ring-fg').forEach(function (el) {
      var target = el.getAttribute('data-target-offset');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          el.style.strokeDashoffset = target;
        });
      });
    });
  }

  function animateBarsIn(root) {
    (root || document).querySelectorAll('.bar-fill[data-target-width]').forEach(function (el) {
      var target = el.getAttribute('data-target-width');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          el.style.width = target;
        });
      });
    });
  }

  /* ---------------- data indexing ---------------- */

  // WHOOP hands back placeholder records for days it never scored (every
  // numeric field zeroed). Treat those as missing so they don't drag
  // averages and personal ranges toward zero.
  function positive(v) {
    return isNum(v) && v > 0 ? v : null;
  }

  function cleanCycle(c) {
    var blank = !positive(c.avgHr) && !positive(c.maxHr) && !positive(c.kilojoules);
    return {
      date: c.date,
      strain: blank ? null : (isNum(c.strain) ? c.strain : null),
      kilojoules: positive(c.kilojoules),
      avgHr: positive(c.avgHr),
      maxHr: positive(c.maxHr),
    };
  }

  function cleanRecovery(r) {
    return {
      date: r.date,
      score: positive(r.score),
      rhr: positive(r.rhr),
      hrv: positive(r.hrv),
      spo2: positive(r.spo2),
      skinTempC: positive(r.skinTempC),
      calibrating: r.calibrating,
    };
  }

  function buildIndexes(data) {
    var recovery = data.recovery || [];
    var sleep = data.sleep || [];
    var cycles = data.cycles || [];
    var workouts = data.workouts || [];

    // Records arrive newest-first, and a date can carry more than one cycle
    // (e.g. the in-progress one plus the one that ended this morning). The
    // first record for a date is the current one, so it wins.
    var byRecovery = {}, bySleep = {}, byCycle = {}, byWorkouts = {};
    recovery.forEach(function (r) { if (r.date && !byRecovery[r.date]) byRecovery[r.date] = cleanRecovery(r); });
    sleep.forEach(function (s) { if (s.date && !bySleep[s.date]) bySleep[s.date] = s; });
    cycles.forEach(function (c) { if (c.date && !byCycle[c.date]) byCycle[c.date] = cleanCycle(c); });
    workouts.forEach(function (w) {
      if (!w.date) return;
      if (!byWorkouts[w.date]) byWorkouts[w.date] = [];
      byWorkouts[w.date].push(w);
    });

    var dateSet = {};
    [recovery, cycles, sleep].forEach(function (arr) {
      arr.forEach(function (r) { if (r.date) dateSet[r.date] = true; });
    });

    state.dateList = Object.keys(dateSet).sort().reverse();
    state.byDate = { recovery: byRecovery, sleep: bySleep, cycle: byCycle };
    state.workoutsByDate = byWorkouts;
  }

  // Window of `count` dates ending at the selected day (oldest -> newest).
  function windowDates(count, offset) {
    var from = state.selectedIndex + (offset || 0);
    return state.dateList.slice(from, from + count).slice().reverse();
  }

  function valuesFor(dates, source, field) {
    var map = state.byDate[source];
    return dates.map(function (d) {
      var rec = map[d];
      if (!rec) return null;
      var v = rec[field];
      return isNum(v) ? v : null;
    });
  }

  function sleepStageValue(dates, key) {
    return dates.map(function (d) {
      var s = state.byDate.sleep[d];
      return s && s.stages && isNum(s.stages[key]) ? s.stages[key] : null;
    });
  }

  /* ---------------- shared card fragments ---------------- */

  function cardHead(title, noteHTML) {
    return (
      '<div class="card-head"><span class="micro-label">' + title + '</span>' +
      (noteHTML ? '<span class="card-head-note">' + noteHTML + '</span>' : '') +
      '</div>'
    );
  }

  function statRow(label, valueHTML, priorHTML) {
    return (
      '<div class="stat-row"><span class="stat-row-label">' + label + '</span>' +
      '<span class="stat-row-right"><span class="stat-row-value">' + valueHTML + '</span>' +
      (priorHTML ? '<span class="stat-row-prior">' + priorHTML + '</span>' : '') +
      '</span></div>'
    );
  }

  function segMeter(fraction, color) {
    var lit = !isNum(fraction) ? 0 : clamp(Math.ceil(fraction * 3), 0, 3);
    var out = '';
    for (var i = 0; i < 3; i++) {
      out += '<span' + (i < lit ? ' style="background:' + color + '"' : '') + '></span>';
    }
    return '<span class="seg-meter">' + out + '</span>';
  }

  function chip(text, kind) {
    return '<span class="chip chip-' + kind + '">' + text + '</span>';
  }

  /* ---------------- header + day strip ---------------- */

  function renderHeader() {
    document.getElementById('greeting').textContent = greetingText();
    var dateStr = state.dateList[state.selectedIndex];
    document.getElementById('selected-date').textContent =
      dateStr ? headerDateLabel(dateStr, state.selectedIndex) : '--';

    var stamp = state.data && state.data.generatedAt ? new Date(state.data.generatedAt) : null;
    var el = document.getElementById('last-updated');
    el.textContent = stamp && !Number.isNaN(stamp.getTime())
      ? 'Synced ' + stamp.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : '';
  }

  function renderDayStrip() {
    var last14 = state.dateList.slice(0, 14).slice().reverse();
    var selected = state.dateList[state.selectedIndex];
    var stripEl = document.getElementById('day-strip');
    stripEl.innerHTML = last14.map(function (dateStr) {
      var rec = state.byDate.recovery[dateStr];
      var score = rec ? rec.score : null;
      var dt = parseLocalDate(dateStr);
      var active = dateStr === selected;
      return (
        '<button class="day-item' + (active ? ' active' : '') + '" type="button" data-date="' + dateStr +
        '" aria-pressed="' + active + '">' +
        '<span class="day-weekday">' + dt.toLocaleDateString(undefined, { weekday: 'narrow' }) + '</span>' +
        '<span class="day-ring-wrap">' +
        ringSVG({ size: 38, stroke: 3.4, pct: isNum(score) ? clamp(score, 0, 100) / 100 : 0, color: recoveryColor(score) }) +
        '<span class="day-number">' + dt.getDate() + '</span></span>' +
        '</button>'
      );
    }).join('');
    requestAnimationFrame(function () { stripEl.scrollLeft = stripEl.scrollWidth; });
    animateRingsIn(stripEl);
  }

  /* ---------------- view: overview ---------------- */

  var METRICS = [
    { key: 'hrv', label: 'HRV', unit: 'ms', color: C.sleep, decimals: 0, better: true },
    { key: 'rhr', label: 'Resting HR', unit: 'bpm', color: C.amber, decimals: 0, better: false },
    { key: 'spo2', label: 'Blood Oxygen', unit: '%', color: C.strain, decimals: 0, better: true },
    { key: 'skinTempC', label: 'Skin Temp', unit: '°C', color: C.green, decimals: 1, better: null },
  ];

  function renderOverview(dateStr) {
    var rec = state.byDate.recovery[dateStr] || null;
    var slp = state.byDate.sleep[dateStr] || null;
    var cyc = state.byDate.cycle[dateStr] || null;

    /* recovery hero */
    var score = rec ? rec.score : null;
    var color = recoveryColor(score);
    var band = !isNum(score) ? 'No data' : score >= 67 ? 'High' : score >= 34 ? 'Moderate' : 'Low';
    document.getElementById('recovery-hero').innerHTML =
      cardHead('Recovery', isNum(score) ? '<strong>' + band + '</strong>' : '') +
      '<div class="hero-body">' +
      heroRing({
        size: 172, stroke: 14, pct: isNum(score) ? clamp(score, 0, 100) / 100 : 0, color: color,
        centerHTML:
          '<div class="ring-value" style="color:' + color + '">' + fmt(score) +
          (isNum(score) ? '<span class="ring-unit">%</span>' : '') + '</div>' +
          '<div class="ring-sublabel">Recovery</div>',
      }) +
      '<div class="hero-caption">HRV <strong>' + fmt(rec && rec.hrv) + '</strong> ms &nbsp;&middot;&nbsp; RHR <strong>' +
      fmt(rec && rec.rhr) + '</strong> bpm</div>' +
      '</div>';

    /* strain */
    var strain = cyc ? cyc.strain : null;
    document.getElementById('strain-card-overview').innerHTML =
      cardHead('Day Strain', '<strong>0&ndash;21</strong> scale') +
      '<div class="hero-body">' +
      heroRing({
        size: 172, stroke: 14, pct: isNum(strain) ? clamp(strain / 21, 0, 1) : 0, color: C.strain,
        centerHTML:
          '<div class="ring-value">' + fmt(strain, 1) + '</div><div class="ring-sublabel">Strain</div>',
      }) +
      '<div class="hero-caption">' + fmtInt(kcalFromKj(cyc && cyc.kilojoules)) + ' cal &nbsp;&middot;&nbsp; Avg HR <strong>' +
      fmt(cyc && cyc.avgHr) + '</strong> &nbsp;&middot;&nbsp; Max HR <strong>' + fmt(cyc && cyc.maxHr) + '</strong></div>' +
      '</div>';

    /* sleep */
    var perf = slp ? slp.performancePct : null;
    var dur = slp ? slp.durationMin : null;
    var need = slp ? slp.needMin : null;
    document.getElementById('sleep-summary-card').innerHTML =
      cardHead('Sleep', slp ? fmtTime(slp.start) + ' &rarr; ' + fmtTime(slp.end) : '') +
      '<div class="hero-body">' +
      heroRing({
        size: 172, stroke: 14, pct: isNum(perf) ? clamp(perf, 0, 100) / 100 : 0, color: C.sleep,
        centerHTML:
          '<div class="ring-value" style="color:' + C.sleep + '">' + fmt(perf) +
          (isNum(perf) ? '<span class="ring-unit">%</span>' : '') + '</div>' +
          '<div class="ring-sublabel">Sleep</div>',
      }) +
      '<div class="hero-caption"><strong>' + fmtHM(dur) + '</strong> slept of <strong>' + fmtHM(need) +
      '</strong> needed</div>' +
      '</div>';

    /* metric cards with sparklines */
    var spark = windowDates(14);
    document.getElementById('metric-cards').innerHTML = METRICS.map(function (m) {
      var vals = valuesFor(spark, 'recovery', m.key);
      var mean = avgOf(vals, m.decimals);
      return (
        '<div class="metric-card">' +
        '<div class="metric-card-head"><span class="metric-card-label">' + m.label + '</span></div>' +
        '<div class="metric-card-value">' + fmt(rec && rec[m.key], m.decimals) +
        '<span class="unit">' + m.unit + '</span></div>' +
        '<div class="metric-card-sub">14-day avg ' + (mean == null ? '--' : mean + (m.unit === '%' ? '%' : ' ' + m.unit)) + '</div>' +
        chartSlot(function (w) { return sparklineSVG({ width: w, height: 44, values: vals, color: m.color }); }, 220) +
        '</div>'
      );
    }).join('');

    /* recovery trend */
    var tDates = windowDates(14);
    var tVals = valuesFor(tDates, 'recovery', 'score');
    var tAvg = avgOf(tVals, 0);
    document.getElementById('overview-trend').innerHTML =
      cardHead('Recovery &mdash; last 14 days',
        'Avg <strong>' + (tAvg == null ? '--' : tAvg + '%') + '</strong>') +
      chartSlot(function (w) {
        return barChartSVG({
          width: w, height: 236, dates: tDates, values: tVals, avg: tAvg,
          yMin: 0, yMax: 100, color: recoveryColor, valueLabels: false,
          highlightIdx: tDates.length - 1,
          fmtTick: function (t) { return fmt(t) + '%'; },
        });
      }, 700) +
      '<div class="trend-legend">' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + C.red + '"></span>Low 0&ndash;33%</span>' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + C.yellow + '"></span>Moderate 34&ndash;66%</span>' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + C.green + '"></span>High 67&ndash;100%</span>' +
      '</div>';

    /* today's activities */
    var rows = '';
    if (slp && isNum(slp.durationMin)) {
      rows +=
        '<div class="activity-row">' +
        '<span class="activity-chip" style="background:' + C.sleep + '">' + fmtHM(slp.durationMin) + '</span>' +
        '<span class="activity-name">Sleep</span>' +
        '<span class="activity-times"><span>' + fmtTime(slp.start) + '</span><span>' + fmtTime(slp.end) + '</span></span>' +
        '<span class="activity-accent" style="background:' + C.sleep + '"></span>' +
        '</div>';
    }
    (state.workoutsByDate[dateStr] || []).forEach(function (w) {
      rows +=
        '<div class="activity-row">' +
        '<span class="activity-chip" style="background:' + C.strain + '">' + fmt(w.strain, 1) + '</span>' +
        '<span class="activity-name">' + (w.sport || 'Activity') + '</span>' +
        '<span class="activity-times"><span>' + fmtTime(w.start) + '</span><span>' + fmtTime(endTime(w)) + '</span></span>' +
        '<span class="activity-accent" style="background:' + C.strain + '"></span>' +
        '</div>';
    });
    document.getElementById('overview-activities').innerHTML =
      cardHead("Today's Activities") +
      (rows || '<div class="empty-state">No activities logged</div>');
  }

  /* ---------------- view: sleep ---------------- */

  var STAGES = [
    { key: 'awakeMin', label: 'Awake', color: C.stageAwake },
    { key: 'lightMin', label: 'Light', color: C.stageLight },
    { key: 'deepMin', label: 'SWS (Deep)', color: C.stageDeep },
    { key: 'remMin', label: 'REM', color: C.stageRem },
  ];

  function renderSleep(dateStr) {
    var slp = state.byDate.sleep[dateStr] || null;
    var perf = slp ? slp.performancePct : null;
    var dur = slp ? slp.durationMin : null;
    var need = slp ? slp.needMin : null;

    document.getElementById('sleep-hero').innerHTML =
      cardHead('Sleep Performance', slp ? '<strong>' + fmtHM(dur) + '</strong> in bed' : '') +
      '<div class="hero-body">' +
      heroRing({
        size: 172, stroke: 14, pct: isNum(perf) ? clamp(perf, 0, 100) / 100 : 0, color: C.sleep,
        centerHTML:
          '<div class="ring-value" style="color:' + C.sleep + '">' + fmt(perf) +
          (isNum(perf) ? '<span class="ring-unit">%</span>' : '') + '</div>' +
          '<div class="ring-sublabel">Performance</div>',
      }) +
      '<div class="hero-caption">' + (slp ? fmtTime(slp.start) + ' &rarr; ' + fmtTime(slp.end) : '--') + '</div>' +
      '</div>';

    /* hours vs needed */
    var ratio = (isNum(dur) && isNum(need) && need > 0) ? clamp(dur / need, 0, 1) : 0;
    var hvnPct = (isNum(dur) && isNum(need) && need > 0) ? Math.round((dur / need) * 100) : null;
    document.getElementById('sleep-hours-card').innerHTML =
      cardHead('Hours vs. Needed', isNum(hvnPct) ? '<strong>' + hvnPct + '%</strong>' : '') +
      '<div class="big-figure"><span class="big-num">' + fmtHM(dur) + '</span>' +
      '<span class="vs">of ' + fmtHM(need) + ' needed</span></div>' +
      '<div class="bar-track"><div class="bar-fill" data-target-width="' + (ratio * 100).toFixed(1) +
      '%" style="background:' + C.sleep + '"></div><div class="bar-need-tick" style="left:100%"></div></div>' +
      '<div class="bar-caption"><span>Asleep</span><span>Need ' + fmtHM(need) + '</span></div>' +
      '<div class="legend-pill">' +
      '<span class="legend-pill-item"><span class="legend-dash" style="background:' + C.amber + '"></span>Poor &lt;70%</span>' +
      '<span class="legend-pill-item"><span class="legend-dash" style="background:' + C.label + '"></span>Sufficient 70&ndash;85%</span>' +
      '<span class="legend-pill-item"><span class="legend-dash" style="background:' + C.green + '"></span>Optimal &gt;85%</span>' +
      '</div>';

    /* stages */
    var stages = (slp && slp.stages) || {};
    var totalStage = STAGES.reduce(function (sum, s) {
      return sum + (isNum(stages[s.key]) ? stages[s.key] : 0);
    }, 0);
    var barHTML = totalStage > 0
      ? STAGES.map(function (s) {
          var v = isNum(stages[s.key]) ? stages[s.key] : 0;
          if (v <= 0) return '';
          return '<div class="stage-bar-seg" style="flex:' + v + ' 0 0%;background:' + s.color + '"></div>';
        }).join('')
      : '<div class="stage-bar-seg" style="flex:1 0 0%;background:' + C.hairline + '"></div>';
    var restorative = (isNum(stages.deepMin) ? stages.deepMin : 0) + (isNum(stages.remMin) ? stages.remMin : 0);
    document.getElementById('sleep-stage-card').innerHTML =
      cardHead('Sleep Stages',
        totalStage > 0 ? 'Restorative <strong>' + fmtHM(restorative) + '</strong>' : '') +
      '<div class="stage-bar-track">' + barHTML + '</div>' +
      '<div class="stage-rows">' +
      STAGES.map(function (s) {
        var v = isNum(stages[s.key]) ? stages[s.key] : null;
        var pct = (isNum(v) && totalStage > 0) ? Math.round((v / totalStage) * 100) : null;
        return (
          '<div class="stage-row">' +
          '<span class="stage-swatch" style="background:' + s.color + '"></span>' +
          '<span class="stage-name">' + s.label + '</span>' +
          '<span class="stage-pct" style="color:' + s.color + '">' + (pct == null ? '--' : pct + '%') + '</span>' +
          '<span class="stage-dur">' + fmtHM(v) + '</span>' +
          '</div>'
        );
      }).join('') +
      '</div>';

    /* stat list: efficiency / consistency / bed / wake */
    var eff = slp ? slp.efficiencyPct : null;
    var cons = slp ? slp.consistencyPct : null;
    var prior = windowDates(30, 1);
    var effPrior = avgOf(valuesFor(prior, 'sleep', 'efficiencyPct'), 0);
    var durPrior = avgOf(valuesFor(prior, 'sleep', 'durationMin'), 0);
    document.getElementById('sleep-stats-card').innerHTML =
      cardHead('Last Night', '<strong>Today</strong> vs. prior 30 days') +
      '<div class="stat-list">' +
      '<div class="stat-row"><span class="stat-row-label">Hours vs. Needed</span>' +
      segMeter(isNum(hvnPct) ? hvnPct / 100 : null, hvnPct >= 85 ? C.green : hvnPct >= 70 ? C.label : C.amber) +
      '<span class="stat-row-right"><span class="stat-row-value">' + (isNum(hvnPct) ? hvnPct + '%' : '--') + '</span></span></div>' +
      '<div class="stat-row"><span class="stat-row-label">Sleep Efficiency</span>' +
      segMeter(isNum(eff) ? eff / 100 : null, C.green) +
      '<span class="stat-row-right"><span class="stat-row-value">' + fmt(eff) +
      (isNum(eff) ? '%' : '') + '</span><span class="stat-row-prior">' +
      (effPrior == null ? '' : effPrior + '% avg') + '</span></span></div>' +
      '<div class="stat-row"><span class="stat-row-label">Sleep Consistency</span>' +
      '<span class="stat-row-right">' +
      (isNum(cons) && cons > 0
        ? '<span class="stat-row-value">' + fmt(cons) + '%</span>'
        : '<span class="stat-row-dim">Calibrating</span>') +
      '</span></div>' +
      statRow('Time in Bed', fmtHM(dur), durPrior == null ? '' : fmtHM(durPrior) + ' avg') +
      statRow('Bedtime', slp ? fmtTime(slp.start) : '--') +
      statRow('Wake Time', slp ? fmtTime(slp.end) : '--') +
      statRow('Naps', slp && isNum(slp.naps) ? String(slp.naps) : '--') +
      '</div>';

    /* weekly trend: hours of sleep vs need */
    var dates = windowDates(14);
    var durVals = valuesFor(dates, 'sleep', 'durationMin').map(function (v) { return isNum(v) ? v / 60 : null; });
    var needVals = valuesFor(dates, 'sleep', 'needMin').map(function (v) { return isNum(v) ? v / 60 : null; });
    var durAvg = avgOf(durVals, 1);
    document.getElementById('sleep-trend-card').innerHTML =
      cardHead('Hours vs. Needed &mdash; last 14 days',
        'Avg <strong>' + (durAvg == null ? '--' : durAvg + ' hr') + '</strong>') +
      chartSlot(function (w) {
        return barChartSVG({
          width: w, height: 244, dates: dates, values: durVals, needValues: needVals,
          color: C.sleep, avg: durAvg, highlightIdx: dates.length - 1,
          fmtTick: function (t) { return fmt(t) + 'h'; },
        });
      }, 620) +
      '<div class="trend-legend">' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + C.sleep + '"></span>Hours of sleep</span>' +
      '<span class="trend-legend-item"><span class="legend-dash" style="background:#ffffff;opacity:.6"></span>Sleep needed</span>' +
      '</div>';

    /* sleep breakdown (days) — catalog's segmented proportional bar */
    var perfWindow = valuesFor(windowDates(30), 'sleep', 'performancePct').filter(isNum);
    var buckets = [
      { label: 'Optimal (&gt;85%)', color: C.green, n: perfWindow.filter(function (v) { return v > 85; }).length },
      { label: 'Sufficient (70&ndash;85%)', color: C.label, n: perfWindow.filter(function (v) { return v >= 70 && v <= 85; }).length },
      { label: 'Poor (&lt;70%)', color: C.amber, n: perfWindow.filter(function (v) { return v < 70; }).length },
    ];
    document.getElementById('sleep-breakdown-card').innerHTML =
      cardHead('Sleep Breakdown (days)', perfWindow.length + ' nights recorded') +
      (perfWindow.length
        ? '<div class="breakdown-bar">' +
          buckets.map(function (b) {
            return b.n ? '<div style="flex:' + b.n + ' 0 0%;background:' + b.color + '"></div>' : '';
          }).join('') +
          '</div><div class="breakdown-legend">' +
          buckets.map(function (b) {
            return '<span class="breakdown-item"><span class="stage-swatch" style="background:' + b.color +
              '"></span><b>' + b.n + 'x</b> ' + b.label + '</span>';
          }).join('') + '</div>'
        : '<div class="empty-state">No sleep records in range</div>');
  }

  /* ---------------- view: strain ---------------- */

  function renderStrain(dateStr) {
    var cyc = state.byDate.cycle[dateStr] || null;
    var strain = cyc ? cyc.strain : null;
    var kcal = kcalFromKj(cyc && cyc.kilojoules);
    var workouts = state.workoutsByDate[dateStr] || [];

    document.getElementById('strain-hero').innerHTML =
      cardHead('Day Strain', '<strong>0&ndash;21</strong> scale') +
      '<div class="hero-body">' +
      heroRing({
        size: 196, stroke: 15, pct: isNum(strain) ? clamp(strain / 21, 0, 1) : 0, color: C.strain,
        centerHTML: '<div class="ring-value" style="font-size:52px">' + fmt(strain, 1) + '</div>' +
          '<div class="ring-sublabel">Strain</div>',
      }) +
      '<div class="hero-caption">' + fmtInt(kcal) + ' cal &nbsp;&middot;&nbsp; ' + workouts.length +
      ' logged ' + (workouts.length === 1 ? 'activity' : 'activities') + '</div>' +
      '</div>';

    var prior = windowDates(30, 1);
    document.getElementById('strain-stats-card').innerHTML =
      cardHead('Today', '<strong>Today</strong> vs. prior 30 days') +
      '<div class="stat-list">' +
      statRow('Day Strain', fmt(strain, 1),
        (function () { var a = avgOf(valuesFor(prior, 'cycle', 'strain'), 1); return a == null ? '' : a + ' avg'; })()) +
      statRow('Calories', fmtInt(kcal) + '<span class="unit">cal</span>',
        (function () {
          var a = avgOf(valuesFor(prior, 'cycle', 'kilojoules').map(kcalFromKj), 0);
          return a == null ? '' : fmtInt(a) + ' avg';
        })()) +
      statRow('Average Heart Rate', fmt(cyc && cyc.avgHr) + '<span class="unit">bpm</span>',
        (function () { var a = avgOf(valuesFor(prior, 'cycle', 'avgHr'), 0); return a == null ? '' : a + ' avg'; })()) +
      statRow('Max Heart Rate', fmt(cyc && cyc.maxHr) + '<span class="unit">bpm</span>',
        (function () { var a = avgOf(valuesFor(prior, 'cycle', 'maxHr'), 0); return a == null ? '' : a + ' avg'; })()) +
      statRow('Activity Time',
        fmtHM(workouts.reduce(function (s, w) { return s + (isNum(w.durationMin) ? w.durationMin : 0); }, 0))) +
      '</div>';

    document.getElementById('workouts-card').innerHTML =
      cardHead('Workouts', workouts.length ? workouts.length + ' today' : '') +
      (workouts.length
        ? workouts.map(function (w) {
            return (
              '<div class="activity-row">' +
              '<span class="activity-chip" style="background:' + C.strain + '">' + fmt(w.strain, 1) + '</span>' +
              '<span class="activity-name">' + (w.sport || 'Activity') + '</span>' +
              '<span class="activity-times"><span>' + fmtTime(w.start) + ' &middot; ' + fmtHM(w.durationMin) + '</span>' +
              '<span>' + fmt(w.avgHr) + '/' + fmt(w.maxHr) + ' bpm</span></span>' +
              '<span class="activity-accent" style="background:' + C.strain + '"></span>' +
              '</div>'
            );
          }).join('')
        : '<div class="empty-state">No activities logged</div>');

    var dates = windowDates(14);
    var strainVals = valuesFor(dates, 'cycle', 'strain');
    var strainAvg = avgOf(strainVals, 1);
    document.getElementById('strain-trend-card').innerHTML =
      cardHead('Strain &mdash; last 14 days', 'Avg <strong>' + (strainAvg == null ? '--' : strainAvg) + '</strong>') +
      chartSlot(function (w) {
        return barChartSVG({
          width: w, height: 244, dates: dates, values: strainVals, color: C.strain,
          avg: strainAvg, yMin: 0, yMax: 21, valueLabels: false, highlightIdx: dates.length - 1,
          fmtTick: function (t) { return fmt(t); },
        });
      }, 700);

    var calVals = valuesFor(dates, 'cycle', 'kilojoules').map(kcalFromKj);
    var calAvg = avgOf(calVals, 0);
    document.getElementById('calories-trend-card').innerHTML =
      cardHead('Calories', 'Avg <strong>' + (calAvg == null ? '--' : fmtInt(calAvg)) + '</strong>') +
      chartSlot(function (w) {
        return barChartSVG({
          width: w, height: 244, dates: dates, values: calVals, color: C.amber,
          avg: calAvg, highlightIdx: dates.length - 1,
          fmtTick: function (t) { return t >= 1000 ? (t / 1000).toFixed(1) + 'k' : fmt(t); },
        });
      }, 320);
  }

  /* ---------------- view: health ---------------- */

  // Personal "normal range" from the trailing 30 days of the metric,
  // excluding the selected day itself (catalog's green "within range" chip).
  function normalRange(source, field, decimals) {
    var vals = valuesFor(windowDates(30, 1), source, field).filter(isNum);
    if (vals.length < 3) return null;
    var lo = percentile(vals, 0.2);
    var hi = percentile(vals, 0.8);
    var d = decimals || 0;
    return { lo: Number(lo.toFixed(d)), hi: Number(hi.toFixed(d)) };
  }

  function rangeChip(value, range, decimals, unit) {
    if (!isNum(value) || !range) return chip('No baseline yet', 'neutral');
    var d = decimals || 0;
    var label = range.lo.toFixed(d) + '–' + range.hi.toFixed(d) + (unit ? ' ' + unit : '');
    if (value >= range.lo && value <= range.hi) return chip('&#10003; within ' + label, 'green');
    return chip((value > range.hi ? '&#9650; above ' : '&#9660; below ') + label, 'amber');
  }

  var VITALS = [
    { key: 'hrv', source: 'recovery', label: 'HRV', unit: 'ms', decimals: 0, color: C.sleep, better: true },
    { key: 'spo2', source: 'recovery', label: 'Blood Oxygen (SpO₂)', unit: '%', decimals: 0, color: C.strain, better: true },
    { key: 'skinTempC', source: 'recovery', label: 'Skin Temp', unit: '°C', decimals: 1, color: C.green, better: null },
    { key: 'avgHr', source: 'cycle', label: 'Average Heart Rate', unit: 'bpm', decimals: 0, color: C.red, better: false },
  ];

  function renderHealth(dateStr) {
    var rec = state.byDate.recovery[dateStr] || null;
    var cyc = state.byDate.cycle[dateStr] || null;

    /* hero: resting heart rate + personal range track */
    var rhr = rec ? rec.rhr : null;
    var rhrRange = normalRange('recovery', 'rhr', 0);
    var rhrAll = valuesFor(windowDates(30), 'recovery', 'rhr').filter(isNum);
    var scaleLo = rhrAll.length ? Math.min.apply(null, rhrAll) - 3 : 40;
    var scaleHi = rhrAll.length ? Math.max.apply(null, rhrAll) + 3 : 80;
    function pctOf(v) { return clamp(((v - scaleLo) / Math.max(1, scaleHi - scaleLo)) * 100, 0, 100); }

    // Count how many tracked vitals sit inside their personal range today.
    var inRange = 0, scored = 0;
    var vitalState = VITALS.map(function (v) {
      var rowRec = v.source === 'recovery' ? rec : cyc;
      var value = rowRec && isNum(rowRec[v.key]) ? rowRec[v.key] : null;
      var range = normalRange(v.source, v.key, v.decimals);
      if (isNum(value) && range) {
        scored++;
        if (value >= range.lo && value <= range.hi) inRange++;
      }
      return { cfg: v, value: value, range: range };
    });
    if (isNum(rhr) && rhrRange) {
      scored++;
      if (rhr >= rhrRange.lo && rhr <= rhrRange.hi) inRange++;
    }

    var bandHTML = rhrRange
      ? '<div class="range-band" style="left:' + pctOf(rhrRange.lo) + '%;width:' +
        Math.max(2, pctOf(rhrRange.hi) - pctOf(rhrRange.lo)) + '%"></div>'
      : '';
    document.getElementById('health-hero').innerHTML =
      cardHead('Health Monitor',
        scored ? '<strong>' + inRange + '/' + scored + '</strong> metrics within range' : '') +
      '<div class="health-hero-row">' +
      '<div class="health-hero-figure">' +
      '<div class="micro-label" style="margin-bottom:8px">Resting Heart Rate</div>' +
      '<div class="health-hero-value">' + fmt(rhr) + '<span class="unit">bpm</span></div>' +
      '<div class="health-hero-sub">' + (rhrRange ? 'Personal range ' + rhrRange.lo + '–' + rhrRange.hi + ' bpm' : 'Building baseline') + '</div>' +
      '</div>' +
      '<div class="range-track">' +
      '<div class="range-line"></div>' + bandHTML +
      (isNum(rhr) ? '<div class="range-fill" style="width:' + pctOf(rhr) + '%"></div>' : '') +
      (isNum(rhr) ? '<div class="range-dot" style="left:' + pctOf(rhr) + '%"></div>' : '') +
      '<div class="range-scale"><span>' + Math.round(scaleLo) + '</span><span>' + Math.round(scaleHi) + '</span></div>' +
      '</div>' +
      '<div style="flex:0 0 auto">' + rangeChip(rhr, rhrRange, 0, 'bpm') + '</div>' +
      '</div>';

    /* vitals tiles */
    var spark = windowDates(14);
    document.getElementById('health-tiles').innerHTML = vitalState.map(function (v) {
      var vals = valuesFor(spark, v.cfg.source, v.cfg.key);
      return (
        '<div class="metric-card">' +
        '<div class="metric-card-head"><span class="metric-card-label tile-label-2">' + v.cfg.label + '</span></div>' +
        '<div class="metric-card-value">' + fmt(v.value, v.cfg.decimals) +
        '<span class="unit">' + v.cfg.unit + '</span></div>' +
        '<div>' + rangeChip(v.value, v.range, v.cfg.decimals, '') + '</div>' +
        chartSlot(function (w) { return sparklineSVG({ width: w, height: 44, values: vals, color: v.cfg.color }); }, 220) +
        '</div>'
      );
    }).join('');

    /* 30-day vitals table, dashboard-row styling */
    var win = windowDates(30);
    var priorWin = windowDates(30, 30);
    var tableRows = [{ cfg: { key: 'rhr', source: 'recovery', label: 'Resting Heart Rate', unit: 'bpm', decimals: 0, better: false }, value: rhr }]
      .concat(vitalState.map(function (v) { return { cfg: v.cfg, value: v.value }; }))
      .map(function (row) {
        var cur = avgOf(valuesFor(win, row.cfg.source, row.cfg.key), row.cfg.decimals);
        var prev = avgOf(valuesFor(priorWin, row.cfg.source, row.cfg.key), row.cfg.decimals);
        return (
          '<div class="dash-row"><span class="dash-label">' + row.cfg.label + '</span>' +
          '<span class="stat-row-right"><span class="dash-value">' +
          (isNum(row.value) ? fmt(row.value, row.cfg.decimals) : '--') +
          '<span class="unit">' + row.cfg.unit + '</span>' + trendGlyph(cur, prev, row.cfg.better) + '</span>' +
          '<span class="stat-row-prior">30-day avg ' + (cur == null ? '--' : cur) + '</span></span></div>'
        );
      }).join('');
    document.getElementById('health-table').innerHTML =
      cardHead('Vitals &mdash; today vs. 30-day average', 'Personal ranges come from your trailing 30 days') +
      '<div class="dash-list">' + tableRows + '</div>';
  }

  /* ---------------- view: trends ---------------- */

  function renderTrends(range) {
    var dates = windowDates(range);
    var priorDates = windowDates(range, range);

    /* recovery */
    var recVals = valuesFor(dates, 'recovery', 'score');
    var recAvg = avgOf(recVals, 0);
    document.getElementById('trend-recovery').innerHTML =
      cardHead('Recovery', 'Avg <strong>' + (recAvg == null ? '--' : recAvg + '%') + '</strong>') +
      chartSlot(function (w) {
        return barChartSVG({
          width: w, height: 250, dates: dates, values: recVals, color: recoveryColor,
          avg: recAvg, yMin: 0, yMax: 100, valueLabels: range <= 7,
          fmtV: function (v) { return fmt(v) + '%'; },
          fmtTick: function (t) { return fmt(t) + '%'; },
        });
      }, 760) +
      '<div class="trend-legend">' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + C.red + '"></span>Low</span>' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + C.yellow + '"></span>Moderate</span>' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + C.green + '"></span>High</span>' +
      '</div>';

    /* hrv */
    var hrvVals = valuesFor(dates, 'recovery', 'hrv');
    var hrvAvg = avgOf(hrvVals, 0);
    var hrvBand = (function () {
      var all = valuesFor(windowDates(30), 'recovery', 'hrv');
      var lo = percentile(all, 0.25), hi = percentile(all, 0.75);
      return isNum(lo) && isNum(hi) ? [lo, hi] : null;
    })();
    document.getElementById('trend-hrv').innerHTML =
      cardHead('Heart Rate Variability', 'Avg <strong>' + (hrvAvg == null ? '--' : hrvAvg + ' ms') + '</strong>') +
      chartSlot(function (w) {
        return lineChartSVG({
          width: w, height: 230, dates: dates, values: hrvVals, color: C.sleep,
          band: hrvBand, bandColor: C.sleep, avg: hrvAvg,
          fmtTick: function (t) { return fmt(t); },
        });
      }, 760) +
      '<div class="trend-legend"><span class="trend-legend-item">' +
      '<span class="legend-dash" style="background:' + C.sleep + ';opacity:.45"></span>Typical range (30d)</span></div>';

    /* rhr */
    var rhrVals = valuesFor(dates, 'recovery', 'rhr');
    var rhrAvg = avgOf(rhrVals, 0);
    document.getElementById('trend-rhr').innerHTML =
      cardHead('Resting Heart Rate', 'Avg <strong>' + (rhrAvg == null ? '--' : rhrAvg + ' bpm') + '</strong>') +
      chartSlot(function (w) {
        return lineChartSVG({
          width: w, height: 230, dates: dates, values: rhrVals, color: C.amber, avg: rhrAvg,
          fmtTick: function (t) { return fmt(t); },
        });
      }, 760);

    /* sleep hours */
    var durVals = valuesFor(dates, 'sleep', 'durationMin').map(function (v) { return isNum(v) ? v / 60 : null; });
    var needVals = valuesFor(dates, 'sleep', 'needMin').map(function (v) { return isNum(v) ? v / 60 : null; });
    var durAvg = avgOf(durVals, 1);
    document.getElementById('trend-sleep').innerHTML =
      cardHead('Hours of Sleep', 'Avg <strong>' + (durAvg == null ? '--' : durAvg + ' hr') + '</strong>') +
      chartSlot(function (w) {
        return barChartSVG({
          width: w, height: 250, dates: dates, values: durVals, needValues: needVals,
          color: C.sleep, avg: durAvg, valueLabels: false,
          fmtTick: function (t) { return fmt(t) + 'h'; },
        });
      }, 760) +
      '<div class="trend-legend">' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + C.sleep + '"></span>Hours of sleep</span>' +
      '<span class="trend-legend-item"><span class="legend-dash" style="background:#ffffff;opacity:.6"></span>Sleep needed</span>' +
      '</div>';

    /* strain */
    var strainVals = valuesFor(dates, 'cycle', 'strain');
    var strainAvg = avgOf(strainVals, 1);
    document.getElementById('trend-strain').innerHTML =
      cardHead('Day Strain', 'Avg <strong>' + (strainAvg == null ? '--' : strainAvg) + '</strong>') +
      chartSlot(function (w) {
        return barChartSVG({
          width: w, height: 250, dates: dates, values: strainVals, color: C.strain,
          avg: strainAvg, yMin: 0, yMax: 21, valueLabels: range <= 7,
          fmtV: function (v) { return v.toFixed(1); },
          fmtTick: function (t) { return fmt(t); },
        });
      }, 760);

    /* dashboard-style metric list (catalog screen 4) */
    var rows = [
      { label: 'Recovery', source: 'recovery', field: 'score', unit: '%', d: 0, better: true },
      { label: 'HRV', source: 'recovery', field: 'hrv', unit: 'ms', d: 0, better: true },
      { label: 'Resting Heart Rate', source: 'recovery', field: 'rhr', unit: 'bpm', d: 0, better: false },
      { label: 'Blood Oxygen', source: 'recovery', field: 'spo2', unit: '%', d: 0, better: true },
      { label: 'Skin Temp', source: 'recovery', field: 'skinTempC', unit: '°C', d: 1, better: null },
      { label: 'Sleep Performance', source: 'sleep', field: 'performancePct', unit: '%', d: 0, better: true },
      { label: 'Sleep Efficiency', source: 'sleep', field: 'efficiencyPct', unit: '%', d: 0, better: true },
      { label: 'Day Strain', source: 'cycle', field: 'strain', unit: '', d: 1, better: null },
      { label: 'Average Heart Rate', source: 'cycle', field: 'avgHr', unit: 'bpm', d: 0, better: false },
    ];
    var listHTML = rows.map(function (r) {
      var cur = avgOf(valuesFor(dates, r.source, r.field), r.d);
      var prev = avgOf(valuesFor(priorDates, r.source, r.field), r.d);
      return (
        '<div class="dash-row"><span class="dash-label">' + r.label + '</span>' +
        '<span class="stat-row-right"><span class="dash-value">' + (cur == null ? '--' : cur) +
        (r.unit ? '<span class="unit">' + r.unit + '</span>' : '') + trendGlyph(cur, prev, r.better) + '</span>' +
        '<span class="stat-row-prior">' + (prev == null ? 'no prior data' : 'was ' + prev) + '</span></span></div>'
      );
    }).join('');

    /* time in bed / hours row uses h:mm rather than a decimal */
    var bedCur = avgOf(valuesFor(dates, 'sleep', 'durationMin'), 0);
    var bedPrev = avgOf(valuesFor(priorDates, 'sleep', 'durationMin'), 0);
    var needCur = avgOf(valuesFor(dates, 'sleep', 'needMin'), 0);
    var needPrev = avgOf(valuesFor(priorDates, 'sleep', 'needMin'), 0);
    listHTML +=
      '<div class="dash-row"><span class="dash-label">Time in Bed</span>' +
      '<span class="stat-row-right"><span class="dash-value">' + fmtHM(bedCur) + trendGlyph(bedCur, bedPrev, true) + '</span>' +
      '<span class="stat-row-prior">' + (bedPrev == null ? 'no prior data' : 'was ' + fmtHM(bedPrev)) + '</span></span></div>' +
      '<div class="dash-row"><span class="dash-label">Sleep Needed</span>' +
      '<span class="stat-row-right"><span class="dash-value">' + fmtHM(needCur) + trendGlyph(needCur, needPrev, false) + '</span>' +
      '<span class="stat-row-prior">' + (needPrev == null ? 'no prior data' : 'was ' + fmtHM(needPrev)) + '</span></span></div>';

    document.getElementById('trend-dashboard').innerHTML =
      cardHead('My Dashboard', 'Last ' + range + ' days vs. prior ' + range) +
      '<div class="dash-list">' + listHTML + '</div>';
  }

  /* ---------------- view switching ---------------- */

  function renderActiveView() {
    pendingCharts = {};
    var dateStr = state.dateList[state.selectedIndex];
    var view = state.activeView;
    if (view === 'overview') renderOverview(dateStr);
    else if (view === 'sleep') renderSleep(dateStr);
    else if (view === 'strain') renderStrain(dateStr);
    else if (view === 'health') renderHealth(dateStr);
    else if (view === 'trends') renderTrends(state.trendRange);

    var root = document.getElementById('view-' + view);
    fillCharts(root);
    animateRingsIn(root);
    animateBarsIn(root);
  }

  function setActiveView(view) {
    if (!view) return;
    state.activeView = view;
    document.querySelectorAll('.view').forEach(function (v) {
      v.hidden = v.id !== 'view-' + view;
    });
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    document.getElementById('content').scrollTop = 0;
    renderActiveView();
  }

  function selectDay(dateStr) {
    var idx = state.dateList.indexOf(dateStr);
    if (idx < 0) return;
    state.selectedIndex = idx;
    renderHeader();
    renderDayStrip();
    renderActiveView();
  }

  /* ---------------- reconnect state ---------------- */

  function showReconnect(data) {
    document.getElementById('main-shell').hidden = true;
    document.getElementById('reconnect-state').hidden = false;
    var msgEl = document.getElementById('reconnect-message');
    msgEl.textContent = (data && typeof data.message === 'string' && data.message)
      ? data.message
      : "We couldn't reach your Whoop data. Check your connection and try again.";
  }

  function hideReconnect() {
    document.getElementById('reconnect-state').hidden = true;
    document.getElementById('main-shell').hidden = false;
  }

  /* ---------------- data loading ---------------- */

  async function fetchDashboard() {
    try {
      return window.whoop
        ? await window.whoop.getDashboard()
        : await (await fetch('./mock-data.json')).json();
    } catch (err) {
      return { error: true, message: "We couldn't reach your Whoop data. Check your connection and try again." };
    }
  }

  async function loadAndRender() {
    var data = await fetchDashboard();
    if (!data || data.error) {
      showReconnect(data);
      return;
    }
    hideReconnect();
    state.data = data;
    buildIndexes(data);
    state.selectedIndex = 0;

    if (window.whoop) {
      document.getElementById('refresh-btn').hidden = false;
    }

    renderHeader();
    renderDayStrip();
    renderActiveView();
  }

  async function handleRefresh() {
    var btn = document.getElementById('refresh-btn');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spinning');
    try {
      if (window.whoop && typeof window.whoop.refresh === 'function') {
        await window.whoop.refresh();
      }
      await loadAndRender();
    } finally {
      btn.classList.remove('spinning');
      btn.disabled = false;
    }
  }

  /* ---------------- wiring ---------------- */

  function debounce(fn, wait) {
    var t;
    return function () {
      clearTimeout(t);
      var args = arguments;
      t = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  function init() {
    document.getElementById('day-strip').addEventListener('click', function (e) {
      var btn = e.target.closest('.day-item');
      if (btn) selectDay(btn.dataset.date);
    });

    document.getElementById('nav').addEventListener('click', function (e) {
      var btn = e.target.closest('.nav-item');
      if (btn) setActiveView(btn.dataset.view);
    });

    document.getElementById('trends-range-toggle').addEventListener('click', function (e) {
      var btn = e.target.closest('.segmented-btn');
      if (!btn) return;
      state.trendRange = Number(btn.dataset.range);
      document.getElementById('range-7d').classList.toggle('active', state.trendRange === 7);
      document.getElementById('range-30d').classList.toggle('active', state.trendRange === 30);
      renderActiveView();
    });

    document.getElementById('refresh-btn').addEventListener('click', handleRefresh);
    document.getElementById('reconnect-retry-btn').addEventListener('click', loadAndRender);

    window.addEventListener('resize', debounce(function () {
      if (state.data) renderActiveView();
    }, 180));

    loadAndRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
