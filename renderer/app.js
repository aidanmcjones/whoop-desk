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
     #last-updated, #settings-btn
     #top-bar, #greeting, #selected-date, #day-strip
     #content, .view (#view-overview/#view-sleep/#view-strain/
                      #view-health/#view-trends/#view-coach)
     overview: #anomaly-banner #recovery-hero #strain-card-overview
               #sleep-summary-card #metric-cards #overview-trend
               #overview-activities
     sleep:    #sleep-hero #sleep-hours-card #sleep-stage-card
               #sleep-stats-card #sleep-trend-card #sleep-respiratory-card
               #sleep-debt-card #sleep-breakdown-card
     strain:   #strain-hero #strain-stats-card #workouts-card
               #strain-acwr-card #strain-zones-card #strain-trend-card
               #calories-trend-card
     health:   #health-hero #health-tiles #health-table
     trends:   #trends-range-toggle #range-7d #range-30d #range-90d
               #range-6m #range-ytd #trend-recovery #trend-hrv #trend-rhr
               #trend-sleep #trend-strain #trend-compare #trend-dashboard
               #trends-export-group .export-btn[data-kind]
     coach:    #coach-gate-card #coach-chat #coach-messages
               #coach-thinking #coach-input-form #coach-input
               #coach-send-btn
     settings: #settings-overlay #settings-panel #settings-close-btn
               #settings-body (fields built dynamically)
     global:   #toast
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
    trendRange: 7, // number of days, or the string 'ytd'
    settings: null,
    coachStatus: null,
    heartRate: null,
    workout: null,
    coachHistory: [], // [{role:'user'|'assistant', content}]
    coachBusy: false,
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

  function escapeHTML(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

  function xLabelLayer(g, dates, centerFor, format) {
    var n = dates.length;
    if (!n) return '';
    var maxLabels = clamp(Math.floor(g.plotW / 78), 3, 14);
    var step = Math.max(1, Math.ceil(n / maxLabels));
    var contiguous = format ? false : isContiguous(dates);
    var out = '';
    for (var i = 0; i < n; i++) {
      if (i % step !== 0 && i !== n - 1) continue;
      if (i !== n - 1 && n - 1 - i < step * 0.6) continue;
      var label = format ? format(dates[i]) : axisLabel(dates[i], n, contiguous);
      out += txt(centerFor(i), g.h - 8, label, { size: 10, fill: C.disabled });
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
      xLabelLayer(g, dates, centerFor, o.xFormat) +
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

  // Window of `count` dates ending at the given list index (oldest -> newest).
  function windowDatesFromIndex(idx, count, offset) {
    var from = idx + (offset || 0);
    return state.dateList.slice(from, from + count).slice().reverse();
  }

  // Window of `count` dates ending at the selected day (oldest -> newest).
  function windowDates(count, offset) {
    return windowDatesFromIndex(state.selectedIndex, count, offset);
  }

  function windowDatesFromDate(dateStr, count, offset) {
    var idx = state.dateList.indexOf(dateStr);
    if (idx === -1) return [];
    return windowDatesFromIndex(idx, count, offset);
  }

  function addDaysISO(dateStr, delta) {
    var d = parseLocalDate(dateStr);
    d.setDate(d.getDate() + delta);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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

  /* ---------------- IPC bridge + mock fallback ---------------- */

  // Every window.whoop.* call is routed through here: if the real bridge
  // exposes the method, use it; otherwise (mock mode, or a bridge that
  // hasn't wired this method yet) fall back to a client-side emulation
  // built from mock-data.json + localStorage. Every call resolves to a
  // value or an {error} object — never throws.
  //
  // A bounded timeout guards every real-bridge call: renderOverview/
  // renderSleep/etc. await this before filling in their core (non-analytics)
  // card HTML, so a slow or hung IPC call (e.g. getAnalytics blocking on a
  // live network fetch with no local cache yet) must never be allowed to
  // stall the whole view indefinitely — it degrades to an {error} result
  // instead, same as any other failure, and the view renders with "--"
  // placeholders for the parts that didn't arrive in time.
  var API_TIMEOUT_MS = 6000;

  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve({ error: true, message: 'Timed out waiting for a response.' });
      }, ms);
      promise.then(
        function (val) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(val);
        },
        function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ error: true, message: (err && err.message) || 'Something went wrong.' });
        }
      );
    });
  }

  // Slow calls that legitimately exceed the default budget (model round-trips).
  var LONG_TIMEOUTS = { askCoach: 150000 };

  // Backend errors arrive as { error: '<text>' }; renderer-side failures
  // (timeouts, thrown IPC) as { error: true, message: '<text>' }.
  function apiErrorText(res, fallback) {
    if (!res) return fallback;
    if (typeof res.error === 'string' && res.error) return res.error;
    if (typeof res.message === 'string' && res.message) return res.message;
    return fallback;
  }

  async function callApi(name, args, mockFn) {
    args = args || [];
    try {
      if (window.whoop && typeof window.whoop[name] === 'function') {
        var budget = LONG_TIMEOUTS[name] || API_TIMEOUT_MS;
        return await withTimeout(window.whoop[name].apply(window.whoop, args), budget);
      }
      return await mockFn.apply(null, args);
    } catch (err) {
      return { error: true, message: (err && err.message) || 'Something went wrong.' };
    }
  }

  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* ignore (private mode / quota) */ }
  }

  var LS_SETTINGS = 'whoopdesk.mock.settings';
  var LS_DISMISSED = 'whoopdesk.mock.dismissedAnomalies';

  function mockGetHistory(args) {
    var days = args && args.days;
    var data = state.data || {};
    function filterArr(arr) {
      if (!days) return (arr || []).slice();
      var ref = state.dateList[0];
      if (!ref) return (arr || []).slice();
      var cutoff = addDaysISO(ref, -(days - 1));
      return (arr || []).filter(function (r) { return r.date && r.date >= cutoff; });
    }
    return {
      profile: data.profile || null,
      recovery: filterArr(data.recovery),
      sleep: filterArr(data.sleep),
      cycles: filterArr(data.cycles),
      workouts: filterArr(data.workouts),
    };
  }

  function meanSd(values) {
    var present = values.filter(isNum);
    if (!present.length) return { mean: null, sd: null, n: 0 };
    var n = present.length;
    var mean = present.reduce(function (a, b) { return a + b; }, 0) / n;
    var variance = n > 1
      ? present.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1)
      : 0;
    return { mean: mean, sd: Math.sqrt(variance), n: n };
  }

  function deviationFor(value, baselineValues, decimals) {
    var d = isNum(decimals) ? decimals : 1;
    var ms = meanSd(baselineValues);
    var out = {
      value: isNum(value) ? Number(value.toFixed(d)) : null,
      mean: isNum(ms.mean) ? Number(ms.mean.toFixed(d)) : null,
      sd: isNum(ms.sd) ? Number(ms.sd.toFixed(Math.max(d, 2))) : null,
      z: null,
      pctDelta: null,
    };
    if (!isNum(value) || !isNum(ms.mean) || ms.n < 3) return out;
    if (ms.sd > 0) out.z = Number(((value - ms.mean) / ms.sd).toFixed(2));
    else out.z = 0;
    if (ms.mean !== 0) out.pctDelta = Number((((value - ms.mean) / Math.abs(ms.mean)) * 100).toFixed(1));
    return out;
  }

  function rollingBaseline(dates, source, field, windowSize) {
    windowSize = windowSize || 7;
    return dates.map(function (d) {
      var idx = state.dateList.indexOf(d);
      if (idx === -1) return { date: d, mean: null, sd: null, n: 0 };
      var slice = state.dateList.slice(idx, idx + windowSize);
      var vals = slice.map(function (dd) {
        var rec = state.byDate[source][dd];
        return rec && isNum(rec[field]) ? rec[field] : null;
      });
      var ms = meanSd(vals);
      return {
        date: d,
        mean: isNum(ms.mean) ? Number(ms.mean.toFixed(1)) : null,
        sd: isNum(ms.sd) ? Number(ms.sd.toFixed(2)) : null,
        n: ms.n,
      };
    });
  }

  function strainTargetFor(score) {
    if (!isNum(score)) return { low: null, high: null, center: null, label: 'No recovery data yet' };
    if (score >= 67) return { low: 14, high: 18, center: 16, label: 'Push it — high recovery' };
    if (score >= 34) return { low: 10, high: 14, center: 12, label: 'Maintain — moderate recovery' };
    return { low: 4, high: 8, center: 6, label: 'Take it easy — low recovery' };
  }

  function mockAcwr() {
    var acuteDates = windowDates(7, 1);
    var chronicDates = windowDates(28, 1);
    var acuteVals = valuesFor(acuteDates, 'cycle', 'strain');
    var chronicVals = valuesFor(chronicDates, 'cycle', 'strain');
    var acutePresent = acuteVals.filter(isNum);
    var chronicPresent = chronicVals.filter(isNum);
    if (acutePresent.length < 3 || chronicPresent.length < 14) return { insufficient: true };
    var acute7 = avgOf(acuteVals, 2);
    var chronic28 = avgOf(chronicVals, 2);
    var ratio = (isNum(acute7) && isNum(chronic28) && chronic28 > 0)
      ? Number((acute7 / chronic28).toFixed(2)) : null;
    var zone = null;
    if (isNum(ratio)) {
      zone = ratio < 0.8 ? 'undertraining'
        : ratio <= 1.3 ? 'optimal'
        : ratio <= 1.5 ? 'high'
        : 'danger';
    }
    return { acute7: acute7, chronic28: chronic28, ratio: ratio, zone: zone };
  }

  function mockSleepDebt(days) {
    var dates = windowDates(days);
    var rolling = [];
    return dates.map(function (d) {
      var s = state.byDate.sleep[d];
      var debt = s && isNum(s.debtMin) ? s.debtMin : null;
      rolling.push(isNum(debt) ? debt : 0);
      if (rolling.length > 7) rolling.shift();
      var cum7 = rolling.reduce(function (a, b) { return a + b; }, 0);
      return { date: d, debtMin: debt, cumulative7dMin: Math.round(cum7) };
    });
  }

  var DEVIATION_LABELS = {
    hrv: 'HRV', rhr: 'Resting heart rate', spo2: 'Blood oxygen',
    skinTempC: 'Skin temperature', respiratoryRateBpm: 'Respiratory rate',
  };

  function mockAnomaly(deviations) {
    var reasons = [], score = 0;
    Object.keys(deviations).forEach(function (k) {
      var d = deviations[k];
      if (isNum(d.z) && Math.abs(d.z) >= 2) {
        score += Math.abs(d.z);
        reasons.push((DEVIATION_LABELS[k] || k) + ' is unusually ' + (d.z > 0 ? 'high' : 'low') + ' vs. your baseline');
      }
    });
    return { flagged: reasons.length > 0, score: Number(score.toFixed(2)), reasons: reasons };
  }

  function compareField(source, field, decimals, transform) {
    var tf = transform || function (v) { return v; };
    var a = avgOf(valuesFor(windowDates(7), source, field).map(tf), decimals);
    var b = avgOf(valuesFor(windowDates(7, 7), source, field).map(tf), decimals);
    var delta = (isNum(a) && isNum(b)) ? Number((a - b).toFixed(decimals)) : null;
    var pctDelta = (isNum(a) && isNum(b) && b !== 0) ? Number((((a - b) / Math.abs(b)) * 100).toFixed(1)) : null;
    return { a: a, b: b, delta: delta, pctDelta: pctDelta };
  }

  function mockGetAnalytics(args) {
    var days = (args && args.days) || 30;
    var dateStr = state.dateList[state.selectedIndex];
    var rec = state.byDate.recovery[dateStr] || null;
    var slp = state.byDate.sleep[dateStr] || null;
    var baselineDates = windowDates(Math.max(days, 14), 1);

    var deviations = {
      hrv: deviationFor(rec && rec.hrv, valuesFor(baselineDates, 'recovery', 'hrv'), 0),
      rhr: deviationFor(rec && rec.rhr, valuesFor(baselineDates, 'recovery', 'rhr'), 0),
      spo2: deviationFor(rec && rec.spo2, valuesFor(baselineDates, 'recovery', 'spo2'), 1),
      skinTempC: deviationFor(rec && rec.skinTempC, valuesFor(baselineDates, 'recovery', 'skinTempC'), 1),
      respiratoryRateBpm: deviationFor(slp && slp.respiratoryRateBpm, valuesFor(baselineDates, 'sleep', 'respiratoryRateBpm'), 1),
    };

    var trendDates = windowDates(days);

    return {
      deviations: deviations,
      hrvBaseline: rollingBaseline(trendDates, 'recovery', 'hrv', 7),
      rhrBaseline: rollingBaseline(trendDates, 'recovery', 'rhr', 7),
      strainTarget: strainTargetFor(rec && rec.score),
      acwr: mockAcwr(),
      sleepDebt: mockSleepDebt(days),
      anomaly: mockAnomaly(deviations),
      compare7v7: {
        recovery: compareField('recovery', 'score', 0),
        hrv: compareField('recovery', 'hrv', 0),
        rhr: compareField('recovery', 'rhr', 0),
        sleepHours: compareField('sleep', 'durationMin', 1, function (v) { return isNum(v) ? v / 60 : null; }),
        strain: compareField('cycle', 'strain', 1),
      },
    };
  }

  // Mock mode has no main process to sample the cycle, so show the warm-up
  // state rather than inventing a heart-rate trace.
  function mockGetHeartRate() {
    return {
      points: [], activities: [], cycleAvgHr: null, cycleMaxHr: null,
      latestBpm: null, latestAt: null, rangeBpm: null,
      sampleCount: 0, lastSampleAt: null, warmingUp: true,
      sampleEverySeconds: 30, model: null,
    };
  }

  function mockAddStrapSession() { return { added: true }; }
  function mockSetStrapInfo() { return { ok: true }; }

  function mockCoachStatus() {
    return (state.data && state.data.coachStatus) || { available: false, source: null };
  }

  function mockAskCoach(payload) {
    payload = payload || {};
    var status = mockCoachStatus();
    if (!status.available) {
      return {
        reply: null,
        error: 'The coach isn’t configured in mock mode. Connect a Claude API key or CLI to chat live.',
        source: null,
      };
    }
    // (Unreachable while mock coachStatus.available stays false, kept for
    // completeness / to mirror the real askCoach() success shape.)
    return { reply: "Here's what I'm seeing in your recent data.", source: status.source || 'mock' };
  }

  function mockExportCsv(payload) {
    payload = payload || {};
    var kind = payload.kind || 'recovery';
    var rows = 0;
    var data = state.data || {};
    if (kind === 'recovery') rows = (data.recovery || []).length;
    else if (kind === 'sleep') rows = (data.sleep || []).length;
    else if (kind === 'cycles') rows = (data.cycles || []).length;
    else if (kind === 'workouts') rows = (data.workouts || []).length;
    return { path: null, rows: rows, mock: true };
  }

  function mockGetSettings() {
    var stored = lsGet(LS_SETTINGS, null);
    if (stored) return stored;
    var seed = (state.data && state.data.settings) ||
      { launchAtLogin: false, notificationsEnabled: true, morningHour: 8, autoRefreshMins: 10, autoConnectStrap: true, restingAlertEnabled: false, restingAlertBpm: 100 };
    lsSet(LS_SETTINGS, seed);
    return seed;
  }

  function mockSetSettings(patch) {
    var cur = mockGetSettings();
    var updated = Object.assign({}, cur, patch || {});
    lsSet(LS_SETTINGS, updated);
    return updated;
  }

  function mockOnUpdated() {
    return function () {}; // no live push feed in mock mode
  }

  // Merge a same-shape-as-dashboard payload (from getHistory) into the
  // currently loaded data set, de-duping by date (existing/fresher records
  // win) and re-indexing. Used to backfill wider trend ranges (90D/6M/YTD)
  // beyond the initial dashboard window without discarding what's loaded.
  function mergeByDate(current, incoming, allowMultiple) {
    current = current || [];
    incoming = incoming || [];
    if (allowMultiple) {
      var seen = {}, out = [];
      current.concat(incoming).forEach(function (r) {
        var key = r.date + '|' + (r.start || '') + '|' + (r.sport || '');
        if (seen[key]) return;
        seen[key] = true;
        out.push(r);
      });
      return out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    }
    var byDate = {};
    current.forEach(function (r) { if (r.date) byDate[r.date] = r; });
    incoming.forEach(function (r) { if (r.date && !byDate[r.date]) byDate[r.date] = r; });
    return Object.keys(byDate).sort().reverse().map(function (d) { return byDate[d]; });
  }

  function mergeHistory(hist) {
    var base = state.data || {};
    var merged = Object.assign({}, base, {
      recovery: mergeByDate(base.recovery, hist.recovery),
      sleep: mergeByDate(base.sleep, hist.sleep),
      cycles: mergeByDate(base.cycles, hist.cycles),
      workouts: mergeByDate(base.workouts, hist.workouts, true),
    });
    state.data = merged;
    buildIndexes(merged);
  }

  // Fetches a wider history window via getHistory({days}) if fewer than
  // `days` are currently indexed, preserving the selected day.
  async function ensureHistoryFor(days) {
    if (!isNum(days) || days <= 0) return;
    if (state.dateList.length >= days) return;
    var res = await callApi('getHistory', [{ days: days }], mockGetHistory);
    if (!res || res.error) return;
    var prevSelectedDate = state.dateList[state.selectedIndex];
    mergeHistory(res);
    if (prevSelectedDate) {
      var idx = state.dateList.indexOf(prevSelectedDate);
      if (idx >= 0) state.selectedIndex = idx;
    }
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

  // Small ▲/▼ pct-vs-baseline badge used on the overview metric cards.
  function deviationBadge(dev, higherIsBetter) {
    if (!dev || !isNum(dev.z) || !isNum(dev.pctDelta)) return '';
    var flat = Math.abs(dev.z) < 0.3;
    var up = dev.pctDelta > 0;
    var good = higherIsBetter == null ? true : (higherIsBetter ? up : !up);
    var kind = flat ? 'neutral' : (Math.abs(dev.z) >= 2 ? (good ? 'green' : 'amber') : (good ? 'green' : 'neutral'));
    var glyph = flat ? '&#9679;' : (up ? '&#9650;' : '&#9660;');
    return (
      '<span class="deviation-badge deviation-' + kind + '">' + glyph + ' ' +
      (flat ? 'baseline' : Math.abs(dev.pctDelta).toFixed(0) + '%') + '</span>'
    );
  }

  function acwrZoneChip(acwr) {
    if (!acwr || acwr.insufficient || !isNum(acwr.ratio)) return chip('Building baseline', 'neutral');
    var labels = { undertraining: 'Undertraining', optimal: 'Optimal', high: 'High load', danger: 'Danger zone' };
    var kind = acwr.zone === 'optimal' ? 'green' : acwr.zone === 'danger' ? 'red' : 'neutral';
    return '<span class="chip acwr-chip acwr-' + kind + '">' + (labels[acwr.zone] || acwr.zone) + '</span>';
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
      var isToday = dateStr === todayISO();
      return (
        '<button class="day-item' + (active ? ' active' : '') + (isToday ? ' today' : '') +
        '" type="button" data-date="' + dateStr + '" aria-pressed="' + active + '"' +
        (isToday ? ' aria-current="date"' : '') + '>' +
        '<span class="day-weekday">' + (isToday ? 'TODAY' : dt.toLocaleDateString(undefined, { weekday: 'narrow' })) + '</span>' +
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

  function renderAnomalyBanner(dateStr, analytics) {
    var el = document.getElementById('anomaly-banner');
    if (!el) return;
    var anomaly = analytics && analytics.anomaly;
    var dismissed = lsGet(LS_DISMISSED, {});
    if (!anomaly || !anomaly.flagged || dismissed[dateStr]) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML =
      '<div class="anomaly-banner-inner">' +
      '<span class="anomaly-banner-icon" aria-hidden="true">&#9888;</span>' +
      '<div class="anomaly-banner-body">' +
      '<span class="anomaly-banner-title">Unusual readings today</span>' +
      '<span class="anomaly-banner-reasons">' + anomaly.reasons.join(' &middot; ') + '</span>' +
      '</div>' +
      '<button type="button" class="anomaly-dismiss-btn" data-dismiss-date="' + dateStr + '">Dismiss</button>' +
      '</div>';
  }

  /* ---------------- overview strap strip ---------------- */

  // Plain-language status for a connection nobody has to manage. "Looking for
  // your strap" covers both scanning and connecting, since the distinction
  // only matters to the helper.
  function strapStatusText() {
    switch (ble.status) {
      case 'starting':
      case 'scanning':
      case 'connecting':
        return 'Looking for your strap…';
      case 'off':
        return 'Bluetooth is off';
      case 'unauthorized':
        return 'Bluetooth permission needed';
      case 'unavailable':
        return 'Strap support unavailable in this build';
      default:
        return 'Strap out of range';
    }
  }

  // Battery badge shown beside the strap pill. While connected it is the live
  // level; otherwise the last level the strap reported, dimmed, so a stale
  // number is never mistaken for a current one.
  function strapBatteryHTML(connected) {
    var info = ble.info || (state.heartRate && state.heartRate.strapInfo);
    var pct = info && isNum(info.battery) ? clamp(Math.round(info.battery), 0, 100) : null;
    if (pct == null) return '';
    var tone = pct <= 20 ? 'low' : pct <= 50 ? 'mid' : 'ok';
    var title = connected ? 'Strap battery ' + pct + '%' : 'Last reported strap battery ' + pct + '%';
    // 18x10 body, 2px cap; the fill width tracks the level (min 1px so 1% shows).
    var fillW = Math.max(1, Math.round((pct / 100) * 14));
    return '<span class="strap-battery ' + tone + (connected ? '' : ' stale') + '" title="' + title +
      '" aria-label="' + title + '">' +
      '<svg class="strap-battery-icon" viewBox="0 0 22 12" width="22" height="12" aria-hidden="true">' +
      '<rect x="0.75" y="0.75" width="18" height="10.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>' +
      '<rect x="20" y="4" width="1.75" height="4" rx="0.8" fill="currentColor" opacity="0.55"/>' +
      '<rect class="strap-battery-fill" x="2.75" y="2.75" width="' + fillW + '" height="6.5" rx="1.2" fill="currentColor"/>' +
      '</svg><span class="strap-battery-pct">' + pct + '%</span></span>';
  }

  function renderOverviewStrap() {
    var el = document.getElementById('overview-strap-card');
    if (!el) return;
    var connected = ble.status === 'connected';
    var maxHr = profileMaxHr();
    var zone = hrZoneFor(ble.bpm, maxHr);

    el.hidden = false;

    var left;
    if (connected) {
      left =
        '<span class="hr-live-dot beating" style="background:' + zone.color +
        (isNum(ble.bpm) ? ';animation-duration:' + (60 / clamp(ble.bpm, 30, 220)).toFixed(2) + 's' : '') +
        '" aria-hidden="true"></span>' +
        '<span class="strap-strip-value" style="color:' + zone.color + '"><span id="ov-ble-num">' +
        fmt(ble.bpm) + '</span><span class="unit">bpm</span></span>' +
        '<span class="strap-strip-meta">measured &middot; ' + zone.label +
        (isNum(ble.rmssd) ? ' &middot; HRV ' + ble.rmssd + ' ms' : '') +
        '</span>';
    } else {
      left = '<span class="strap-strip-meta">' + escapeHTML(strapStatusText()) + '</span>';
    }

    el.innerHTML =
      '<span class="micro-label">Live HR</span>' +
      '<span class="strap-strip-left">' + left + '</span>' +
      '<span class="strap-status-group">' + strapBatteryHTML(connected) +
      '<span class="strap-strip-state' + (connected ? ' on' : '') + '">' +
      (connected ? 'Strap live' : 'Auto') + '</span></span>';
  }

  // Every strap state change repaints whichever strap surfaces are on screen.
  function renderStrapSurfaces() {
    if (state.activeView === 'health') renderHeartRate(state.heartRate);
    if (state.activeView === 'overview') renderOverviewStrap();
  }

  async function renderOverview(dateStr) {
    renderOverviewStrap();
    var rec = state.byDate.recovery[dateStr] || null;
    var slp = state.byDate.sleep[dateStr] || null;
    var cyc = state.byDate.cycle[dateStr] || null;
    var analyticsRes = await callApi('getAnalytics', [{ days: 30 }], mockGetAnalytics);
    var analytics = (analyticsRes && !analyticsRes.error) ? analyticsRes : null;

    renderAnomalyBanner(dateStr, analytics);

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
    var strainTarget = analytics && analytics.strainTarget;
    var targetChipHTML = strainTarget && isNum(strainTarget.low)
      ? '<div class="hero-chip-row"><span class="chip strain-target-chip">Target ' + fmt(strainTarget.low, 1) +
        '&ndash;' + fmt(strainTarget.high, 1) + '</span></div>'
      : '';
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
      targetChipHTML +
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
      var dev = analytics && analytics.deviations && analytics.deviations[m.key];
      return (
        '<div class="metric-card">' +
        '<div class="metric-card-head"><span class="metric-card-label">' + m.label + '</span>' +
        deviationBadge(dev, m.better) + '</div>' +
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

  /* ---------------- view: recovery ---------------- */

  var RECOVERY_BANDS = [
    { label: 'High', color: C.green, range: '67&ndash;100%', min: 67 },
    { label: 'Moderate', color: C.yellow, range: '34&ndash;66%', min: 34 },
    { label: 'Low', color: C.red, range: '0&ndash;33%', min: 0 },
  ];

  function recoveryBandFor(score) {
    if (!isNum(score)) return null;
    return score >= 67 ? RECOVERY_BANDS[0] : score >= 34 ? RECOVERY_BANDS[1] : RECOVERY_BANDS[2];
  }

  // Mirrors the mobile app's daily-outlook copy: what the body can take on
  // today, tied to the strain target derived from this recovery score.
  function recoveryOutlookCopy(score, target) {
    var hasTarget = target && isNum(target.low) && isNum(target.high);
    var range = hasTarget ? fmt(target.low, 1) + '&ndash;' + fmt(target.high, 1) : null;
    if (!isNum(score)) {
      return 'No recovery score for this day yet. Recovery is calculated from your sleep, so it appears once a night is recorded.';
    }
    if (score >= 67) {
      return 'Your body is primed to take on a challenge today.' +
        (range ? ' Aim for a Day Strain of <strong>' + range + '</strong> to build fitness without digging a hole.' : '');
    }
    if (score >= 34) {
      return 'Your body is capable of moderate effort today.' +
        (range ? ' For optimal recovery, keep Day Strain between <strong>' + range + '</strong>.' : '');
    }
    return 'Your body is asking for rest today.' +
      (range ? ' Keep Day Strain under <strong>' + fmt(target.high, 1) + '</strong> and make sleep tonight the priority.' : '');
  }

  function driverRow(label, dev, valueHTML, priorHTML, better) {
    return (
      '<div class="stat-row"><span class="stat-row-label">' + label + '</span>' +
      deviationBadge(dev, better) +
      '<span class="stat-row-right"><span class="stat-row-value">' + valueHTML + '</span>' +
      (priorHTML ? '<span class="stat-row-prior">' + priorHTML + '</span>' : '') +
      '</span></div>'
    );
  }

  async function renderRecovery(dateStr) {
    var rec = state.byDate.recovery[dateStr] || null;
    var slp = state.byDate.sleep[dateStr] || null;
    var cyc = state.byDate.cycle[dateStr] || null;
    var analyticsRes = await callApi('getAnalytics', [{ days: 30 }], mockGetAnalytics);
    var analytics = (analyticsRes && !analyticsRes.error) ? analyticsRes : null;
    var devs = (analytics && analytics.deviations) || {};

    var score = rec ? rec.score : null;
    var band = recoveryBandFor(score);
    var color = recoveryColor(score);

    /* hero ring */
    var scoreWindow = valuesFor(windowDates(30, 1), 'recovery', 'score');
    var scorePrior = avgOf(scoreWindow, 0);
    document.getElementById('recovery-detail-hero').innerHTML =
      cardHead('Recovery', band ? '<strong>' + band.label + '</strong> ' + band.range : '') +
      '<div class="hero-body">' +
      heroRing({
        size: 188, stroke: 15, pct: isNum(score) ? clamp(score, 0, 100) / 100 : 0, color: color,
        centerHTML:
          '<div class="ring-value" style="color:' + color + '">' + fmt(score) +
          (isNum(score) ? '<span class="ring-unit">%</span>' : '') + '</div>' +
          '<div class="ring-sublabel">Recovery</div>',
      }) +
      '<div class="hero-caption">HRV <strong>' + fmt(rec && rec.hrv) + '</strong> ms &nbsp;&middot;&nbsp; RHR <strong>' +
      fmt(rec && rec.rhr) + '</strong> bpm</div>' +
      (scorePrior == null
        ? ''
        : '<div class="hero-chip-row"><span class="chip chip-neutral">30-day avg ' + scorePrior + '%</span></div>') +
      '</div>';

    /* daily outlook */
    var target = analytics && analytics.strainTarget;
    var strainSoFar = cyc ? cyc.strain : null;
    document.getElementById('recovery-outlook-card').innerHTML =
      cardHead('Daily Outlook', band ? '<span class="chip" style="color:' + band.color + '">' + band.label + '</span>' : '') +
      '<p class="outlook-copy">' + recoveryOutlookCopy(score, target) + '</p>' +
      '<div class="stat-list">' +
      statRow('Strain target',
        target && isNum(target.low) ? fmt(target.low, 1) + '&ndash;' + fmt(target.high, 1) : '--',
        target && target.label ? target.label : '') +
      statRow('Day strain so far', fmt(strainSoFar, 1),
        target && isNum(target.center) ? 'target ' + fmt(target.center, 1) : '') +
      statRow('Sleep performance', slp && isNum(slp.performancePct) ? slp.performancePct + '%' : '--',
        slp && isNum(slp.debtMin) ? fmtHM(slp.debtMin) + ' debt' : '') +
      '</div>';

    /* recovery drivers: today vs prior 30 days */
    var prior = windowDates(30, 1);
    var hrvPrior = avgOf(valuesFor(prior, 'recovery', 'hrv'), 0);
    var rhrPrior = avgOf(valuesFor(prior, 'recovery', 'rhr'), 0);
    var spo2Prior = avgOf(valuesFor(prior, 'recovery', 'spo2'), 0);
    var tempPrior = avgOf(valuesFor(prior, 'recovery', 'skinTempC'), 1);
    var respPrior = avgOf(valuesFor(prior, 'sleep', 'respiratoryRateBpm'), 1);
    var perfPrior = avgOf(valuesFor(prior, 'sleep', 'performancePct'), 0);
    document.getElementById('recovery-drivers-card').innerHTML =
      cardHead('Recovery Drivers', '<strong>Today</strong> vs. prior 30 days') +
      '<div class="stat-list">' +
      driverRow('Heart Rate Variability', devs.hrv, fmt(rec && rec.hrv) + ' ms',
        hrvPrior == null ? '' : hrvPrior + ' ms avg', true) +
      driverRow('Resting Heart Rate', devs.rhr, fmt(rec && rec.rhr) + ' bpm',
        rhrPrior == null ? '' : rhrPrior + ' bpm avg', false) +
      driverRow('Blood Oxygen', devs.spo2, fmt(rec && rec.spo2, 1) + '%',
        spo2Prior == null ? '' : spo2Prior + '% avg', true) +
      driverRow('Skin Temperature', devs.skinTempC, fmt(rec && rec.skinTempC, 1) + '&deg;C',
        tempPrior == null ? '' : tempPrior + '&deg;C avg', null) +
      driverRow('Respiratory Rate', devs.respiratoryRateBpm, fmt(slp && slp.respiratoryRateBpm, 1) + ' brpm',
        respPrior == null ? '' : respPrior + ' brpm avg', null) +
      statRow('Sleep Performance', slp && isNum(slp.performancePct) ? slp.performancePct + '%' : '--',
        perfPrior == null ? '' : perfPrior + '% avg') +
      '</div>';

    /* metric tiles with 14-day sparklines */
    var spark = windowDates(14);
    document.getElementById('recovery-metric-cards').innerHTML = METRICS.map(function (m) {
      var vals = valuesFor(spark, 'recovery', m.key);
      var mean = avgOf(vals, m.decimals);
      var dev = devs[m.key];
      return (
        '<div class="metric-card">' +
        '<div class="metric-card-head"><span class="metric-card-label">' + m.label + '</span>' +
        deviationBadge(dev, m.better) + '</div>' +
        '<div class="metric-card-value">' + fmt(rec && rec[m.key], m.decimals) +
        '<span class="unit">' + m.unit + '</span></div>' +
        '<div class="metric-card-sub">14-day avg ' + (mean == null ? '--' : mean + (m.unit === '%' ? '%' : ' ' + m.unit)) + '</div>' +
        chartSlot(function (w) { return sparklineSVG({ width: w, height: 44, values: vals, color: m.color }); }, 220) +
        '</div>'
      );
    }).join('');

    /* 30-day recovery trend, dots colored by band */
    var tDates = windowDates(30);
    var tVals = valuesFor(tDates, 'recovery', 'score');
    var tAvg = avgOf(tVals, 0);
    document.getElementById('recovery-trend-card').innerHTML =
      cardHead('Recovery &mdash; last 30 days', 'Avg <strong>' + (tAvg == null ? '--' : tAvg + '%') + '</strong>') +
      chartSlot(function (w) {
        return lineChartSVG({
          width: w, height: 250, dates: tDates, values: tVals, avg: tAvg,
          yMin: 0, yMax: 100, color: C.label, lineColor: C.label, lineOpacity: 0.55,
          dotColors: tVals.map(recoveryColor),
          fmtTick: function (t) { return fmt(t) + '%'; },
        });
      }, 700) +
      '<div class="trend-legend">' +
      RECOVERY_BANDS.slice().reverse().map(function (b) {
        return '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + b.color +
          '"></span>' + b.label + ' ' + b.range + '</span>';
      }).join('') +
      '</div>';

    /* band breakdown over the same 30 days */
    var present = tVals.filter(isNum);
    var buckets = RECOVERY_BANDS.map(function (b) {
      return {
        label: b.label + ' (' + b.range + ')', color: b.color,
        n: present.filter(function (v) { return recoveryBandFor(v) === b; }).length,
      };
    });
    document.getElementById('recovery-breakdown-card').innerHTML =
      cardHead('Recovery Breakdown', present.length + ' days') +
      (present.length
        ? '<div class="breakdown-bar">' +
          buckets.map(function (b) {
            return b.n ? '<div style="flex:' + b.n + ' 0 0%;background:' + b.color + '"></div>' : '';
          }).join('') +
          '</div><div class="breakdown-legend">' +
          buckets.map(function (b) {
            return '<span class="breakdown-item"><span class="stage-swatch" style="background:' + b.color +
              '"></span><b>' + b.n + 'x</b> ' + b.label + '</span>';
          }).join('') + '</div>'
        : '<div class="empty-state">No recovery scores in range</div>');

    /* how each night fed the next morning's recovery */
    var linkDates = windowDates(7).slice().reverse();
    var linkRows = linkDates.map(function (d) {
      var r = state.byDate.recovery[d];
      var s = state.byDate.sleep[d];
      var rv = r && isNum(r.score) ? r.score : null;
      var parts = [];
      if (s && isNum(s.performancePct)) parts.push('Sleep ' + s.performancePct + '%');
      if (s && isNum(s.durationMin)) parts.push(fmtHM(s.durationMin));
      if (r && isNum(r.hrv)) parts.push('HRV ' + fmt(r.hrv) + ' ms');
      if (r && isNum(r.rhr)) parts.push('RHR ' + fmt(r.rhr) + ' bpm');
      return statRow(
        headerDateLabel(d, state.dateList.indexOf(d)),
        '<span style="color:' + recoveryColor(rv) + '">' + fmt(rv) + (isNum(rv) ? '%' : '') + '</span>',
        parts.join(' &middot; ')
      );
    }).join('');
    document.getElementById('recovery-sleep-link-card').innerHTML =
      cardHead('Sleep &rarr; Recovery, last 7 days', 'Each morning&rsquo;s score next to the night before it') +
      (linkRows ? '<div class="stat-list">' + linkRows + '</div>' : '<div class="empty-state">No data in range</div>');
  }

  /* ---------------- view: sleep ---------------- */

  var STAGES = [
    { key: 'awakeMin', label: 'Awake', color: C.stageAwake },
    { key: 'lightMin', label: 'Light', color: C.stageLight },
    { key: 'deepMin', label: 'SWS (Deep)', color: C.stageDeep },
    { key: 'remMin', label: 'REM', color: C.stageRem },
  ];

  async function renderSleep(dateStr) {
    var slp = state.byDate.sleep[dateStr] || null;
    var perf = slp ? slp.performancePct : null;
    var dur = slp ? slp.durationMin : null;
    var need = slp ? slp.needMin : null;
    var analyticsRes = await callApi('getAnalytics', [{ days: 30 }], mockGetAnalytics);
    var analytics = (analyticsRes && !analyticsRes.error) ? analyticsRes : null;

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

    /* respiratory rate */
    var respDev = analytics && analytics.deviations && analytics.deviations.respiratoryRateBpm;
    var respSpark = windowDates(14);
    var respVals = valuesFor(respSpark, 'sleep', 'respiratoryRateBpm');
    document.getElementById('sleep-respiratory-card').innerHTML =
      cardHead('Respiratory Rate', deviationBadge(respDev, null)) +
      '<div class="metric-card-value">' + fmt(slp && slp.respiratoryRateBpm, 1) +
      '<span class="unit">brpm</span></div>' +
      '<div class="metric-card-sub">' +
      (respDev && isNum(respDev.mean) ? 'Baseline ' + fmt(respDev.mean, 1) + ' brpm' : 'Building baseline') +
      '</div>' +
      chartSlot(function (w) { return sparklineSVG({ width: w, height: 44, values: respVals, color: C.strain }); }, 220);

    /* sleep debt */
    var sleepDebt = (analytics && analytics.sleepDebt) || [];
    var todayDebt = sleepDebt.length ? sleepDebt[sleepDebt.length - 1] : null;
    var debtVals = sleepDebt.map(function (d) { return d.debtMin; });
    var debtDates = sleepDebt.map(function (d) { return d.date; });
    var cum7 = todayDebt ? todayDebt.cumulative7dMin : null;
    document.getElementById('sleep-debt-card').innerHTML =
      cardHead('Sleep Debt', isNum(cum7) ? '7-day total <strong>' + fmtHM(cum7) + '</strong>' : '') +
      '<div class="big-figure"><span class="big-num">' + fmtHM(todayDebt && todayDebt.debtMin) +
      '</span><span class="vs">owed last night</span></div>' +
      (debtVals.length
        ? chartSlot(function (w) {
            return barChartSVG({
              width: w, height: 150, dates: debtDates, values: debtVals, color: C.amber,
              highlightIdx: debtDates.length - 1, fmtTick: function (t) { return fmtHM(t); },
            });
          }, 320)
        : '<div class="empty-state">Not enough data yet</div>');

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

  var HR_ZONES = [
    { key: 'z1Min', label: 'Zone 1', color: '#4a90d9' },
    { key: 'z2Min', label: 'Zone 2', color: '#3ddc84' },
    { key: 'z3Min', label: 'Zone 3', color: '#f5c542' },
    { key: 'z4Min', label: 'Zone 4', color: '#e8a33d' },
    { key: 'z5Min', label: 'Zone 5', color: '#ff4d4d' },
  ];

  async function renderStrain(dateStr) {
    var cyc = state.byDate.cycle[dateStr] || null;
    var strain = cyc ? cyc.strain : null;
    var kcal = kcalFromKj(cyc && cyc.kilojoules);
    var workouts = state.workoutsByDate[dateStr] || [];
    var analyticsRes = await callApi('getAnalytics', [{ days: 30 }], mockGetAnalytics);
    var analytics = (analyticsRes && !analyticsRes.error) ? analyticsRes : null;

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

    /* ACWR (acute:chronic workload ratio) */
    var acwr = analytics && analytics.acwr;
    document.getElementById('strain-acwr-card').innerHTML =
      cardHead('Training Load (ACWR)', acwrZoneChip(acwr)) +
      (acwr && !acwr.insufficient
        ? '<div class="big-figure"><span class="big-num">' + fmt(acwr.ratio, 2) + '</span>' +
          '<span class="vs">acute&nbsp;:&nbsp;chronic</span></div>' +
          '<div class="stat-list">' +
          statRow('7-day acute', fmt(acwr.acute7, 1)) +
          statRow('28-day chronic', fmt(acwr.chronic28, 1)) +
          '</div>'
        : '<div class="empty-state">Need at least 4 weeks of strain data to compute ACWR</div>');

    /* HR-zone stacked bar for today's workouts */
    var zoneTotals = HR_ZONES.map(function () { return 0; });
    var haveZones = false;
    workouts.forEach(function (w) {
      if (!w.zones) return;
      HR_ZONES.forEach(function (z, i) {
        if (isNum(w.zones[z.key])) { zoneTotals[i] += w.zones[z.key]; haveZones = true; }
      });
    });
    var zoneTotalMin = zoneTotals.reduce(function (a, b) { return a + b; }, 0);
    document.getElementById('strain-zones-card').innerHTML =
      cardHead('Heart Rate Zones — Today', haveZones ? fmtHM(zoneTotalMin) + ' tracked' : '') +
      (haveZones
        ? '<div class="stage-bar-track">' +
          HR_ZONES.map(function (z, i) {
            return zoneTotals[i] > 0
              ? '<div class="stage-bar-seg" style="flex:' + zoneTotals[i] + ' 0 0%;background:' + z.color + '"></div>'
              : '';
          }).join('') +
          '</div><div class="breakdown-legend">' +
          HR_ZONES.map(function (z, i) {
            return '<span class="breakdown-item"><span class="stage-swatch" style="background:' + z.color +
              '"></span>' + z.label + ' <b>' + fmtHM(zoneTotals[i]) + '</b></span>';
          }).join('') + '</div>'
        : '<div class="empty-state">No zone data for today’s activities</div>');

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

  /* ---------------- strap Bluetooth (true measured heart rate) ------- */

  // The strap connection lives in the main process, which talks to
  // CoreBluetooth through a native helper (native/hr-bridge.swift). The
  // renderer is a pure consumer of that stream: it holds no device, starts no
  // scan and needs no click. Web Bluetooth is deliberately not used — it
  // cannot connect without a user gesture, which is what forced the old
  // "Connect strap" button to exist.
  var ble = {
    status: 'starting', // starting | scanning | connecting | connected | disconnected | off | unauthorized | unavailable
    bpm: null,
    lastAt: null,
    buffer: [],    // [msEpoch, bpm], rolling ~20 min
    error: null,
    quiet: true,   // the connection is automatic; never surface it as an error
    rmssd: null,
    info: null,    // battery / firmware / model, from the helper
  };
  var bleRerenderTimer = null;

  // Tiny local copies of tested helpers in src/hr-monitor.mjs (the renderer
  // cannot import ESM).
  function rmssdOf(rrMs) {
    var diffs = [];
    for (var i = 1; i < rrMs.length; i++) {
      var a = rrMs[i - 1], b = rrMs[i];
      if (a > 250 && a < 2500 && b > 250 && b < 2500) diffs.push(b - a);
    }
    if (diffs.length < 3) return null;
    var meanSq = diffs.reduce(function (x, d) { return x + d * d; }, 0) / diffs.length;
    return Math.round(Math.sqrt(meanSq));
  }

  function kjPerMinAt(bpm) {
    var m = state.heartRate && state.heartRate.model;
    if (!m || !isNum(m.intercept) || !isNum(m.slope) || !isNum(bpm)) return null;
    var x = (bpm - m.intercept) / m.slope;
    return x > 0 ? x * x : 0;
  }

  function approxStrainOf(zoneSec) {
    var w = { z1: 1, z2: 2, z3: 4, z4: 8, z5: 16 };
    var raw = 0;
    Object.keys(w).forEach(function (k) { raw += ((zoneSec[k] || 0) / 60) * w[k]; });
    return Number((21 * (1 - Math.exp(-raw / 200))).toFixed(1));
  }

  function onStrapSample(reading) {
    var bpm = reading && reading.bpm;
    if (!isNum(bpm) || bpm < 25 || bpm > 240) return;
    var now = isNum(reading.at) ? reading.at : Date.now();
    ble.bpm = bpm;
    ble.lastAt = now;
    ble.buffer.push([now, bpm]);
    var cutoff = now - 20 * 60000;
    while (ble.buffer.length && ble.buffer[0][0] < cutoff) ble.buffer.shift();

    // Live workout accumulation, one tick per broadcast (~1 s).
    if (state.workout && state.workout.active) {
      var w = state.workout;
      var dt = Math.min(3, Math.max(0.5, (now - (w.lastTickAt || now)) / 1000));
      w.lastTickAt = now;
      var zi = HR_ZONE_BANDS.indexOf(hrZoneFor(bpm, profileMaxHr()));
      var zk = 'z' + (zi + 1);
      w.zoneSec[zk] = (w.zoneSec[zk] || 0) + dt;
      var rate = kjPerMinAt(bpm);
      if (isNum(rate)) w.kcal += (rate / 4.184) * (dt / 60);
      if (!isNum(w.maxHr) || bpm > w.maxHr) w.maxHr = bpm;
      w.hrSum += bpm * dt;
      w.hrSec += dt;
      w.recent.push([now, bpm]);
      while (w.recent.length && w.recent[0][0] < now - 40000) w.recent.shift();
      updateWorkoutFastPath();
    }

    // Overview shows the live number too, so it must not be excluded here.
    if (state.activeView !== 'health' && state.activeView !== 'overview') return;
    // Fast path: bump the number/time in place at broadcast rate, redraw the
    // whole card (with its strip chart) at most every 2 s.
    var ovNum = document.getElementById('ov-ble-num');
    if (ovNum) ovNum.textContent = fmt(bpm);
    var numEl = document.getElementById('hr-ble-num');
    var timeEl = document.getElementById('hr-ble-time');
    if (numEl) {
      numEl.textContent = fmt(bpm);
      if (timeEl) timeEl.textContent = hrClock(new Date(now).toISOString(), true);
      if (!bleRerenderTimer) {
        bleRerenderTimer = setTimeout(function () {
          bleRerenderTimer = null;
          renderStrapSurfaces();
        }, 2000);
      }
    } else if (state.activeView === 'health') {
      renderHeartRate(state.heartRate);
    } else if (state.activeView === 'overview' && !ovNum) {
      renderOverviewStrap();
    }
  }

  function profileMaxHr() {
    return (state.data && state.data.profile && state.data.profile.maxHr) || null;
  }

  // Every strap event from the main process lands here. Beats arrive about
  // once a second; status changes arrive as they happen.
  function applyStrapLive(live) {
    if (!live) return;
    var prevStatus = ble.status;
    var prevAt = ble.lastAt;
    var prevBattery = ble.info && ble.info.battery;
    ble.status = live.status || 'off';
    ble.rmssd = isNum(live.rmssd) ? live.rmssd : ble.rmssd;
    if (live.info) ble.info = live.info;
    var batteryChanged = !!(ble.info && isNum(ble.info.battery) && ble.info.battery !== prevBattery);

    if (ble.status !== 'connected') {
      ble.bpm = null;
      if (prevStatus !== ble.status) renderStrapSurfaces();
      return;
    }

    // A new beat drives the workout engine and the in-place number update;
    // a repeated timestamp (a status-only push) must not double-count.
    if (isNum(live.bpm) && live.lastAt && live.lastAt !== prevAt) {
      ble.lastAt = live.lastAt;
      onStrapSample({ bpm: live.bpm, at: live.lastAt });
    }
    // The badge lives outside the per-beat fast path, so a new level needs
    // its own repaint.
    if (prevStatus !== 'connected' || batteryChanged) renderStrapSurfaces();
  }

  function startStrapWatch() {
    if (window.whoop && typeof window.whoop.onStrap === 'function') {
      window.whoop.onStrap(applyStrapLive);
    }
    // A stream that goes silent without a status change (asleep strap, helper
    // wedged) should not leave a stale number on screen.
    setInterval(function () {
      if (ble.status !== 'connected') return;
      if (ble.lastAt && Date.now() - ble.lastAt > 20000) {
        ble.status = 'disconnected';
        ble.bpm = null;
        renderStrapSurfaces();
      }
    }, 10000);
  }

  /* ---------------- live workout sessions ---------------- */

  function startWorkout() {
    if (ble.status !== 'connected') return;
    state.workout = {
      active: true,
      startedAt: Date.now(),
      lastTickAt: Date.now(),
      zoneSec: {},
      kcal: 0,
      maxHr: null,
      hrSum: 0,
      hrSec: 0,
      recent: [], // last 40 s of beats, for the stop-peak
      hrrPending: null,
    };
    // Main suppresses the resting-rate alert while a workout is running.
    if (window.whoop && typeof window.whoop.setStrapWorkout === 'function') {
      window.whoop.setStrapWorkout(true);
    }
    renderHeartRate(state.heartRate);
  }

  function stopWorkout() {
    var w = state.workout;
    if (!w || !w.active) return;
    w.active = false;
    w.endedAt = Date.now();
    if (window.whoop && typeof window.whoop.setStrapWorkout === 'function') {
      window.whoop.setStrapWorkout(false);
    }
    // Peak near the stop: max over the last 40 s of effort.
    var stopPeak = w.recent.length
      ? Math.max.apply(null, w.recent.map(function (x) { return x[1]; }))
      : (isNum(ble.bpm) ? ble.bpm : null);
    w.hrrPending = { stopPeak: stopPeak, resolveAt: Date.now() + 60000 };
    renderHeartRate(state.heartRate);
    showToast('Workout stopped — measuring 60s heart-rate recovery…');
    setTimeout(function () { finalizeWorkout(); }, 60500);
  }

  function finalizeWorkout() {
    var w = state.workout;
    if (!w || w.active || !w.hrrPending) return;
    var pending = w.hrrPending;
    w.hrrPending = null;
    var freshBpm = (ble.lastAt && Date.now() - ble.lastAt < 10000) ? ble.bpm : null;
    var hrr60 = (isNum(pending.stopPeak) && isNum(freshBpm) && pending.stopPeak > freshBpm)
      ? pending.stopPeak - freshBpm
      : null;
    var durationMin = Math.max(0.1, (w.endedAt - w.startedAt) / 60000);
    var zonesMin = {};
    Object.keys(w.zoneSec).forEach(function (k) { zonesMin[k] = Number((w.zoneSec[k] / 60).toFixed(1)); });
    var session = {
      startedAt: new Date(w.startedAt).toISOString(),
      endedAt: new Date(w.endedAt).toISOString(),
      durationMin: Number(durationMin.toFixed(1)),
      avgHr: w.hrSec > 0 ? Math.round(w.hrSum / w.hrSec) : null,
      maxHr: w.maxHr,
      kcal: Math.round(w.kcal),
      approxStrain: approxStrainOf(w.zoneSec),
      zonesMin: zonesMin,
      hrr60: hrr60,
    };
    state.workout = null;
    callApi('addStrapSession', [session], function () { return { added: true }; });
    if (state.heartRate) state.heartRate.lastSession = session;
    showToast(hrr60 != null
      ? 'Workout saved — HRR60 ' + hrr60 + ' bpm'
      : 'Workout saved');
    if (state.activeView === 'health') renderHeartRate(state.heartRate);
  }

  function updateWorkoutFastPath() {
    var w = state.workout;
    if (!w || !w.active) return;
    var dur = document.getElementById('wo-dur');
    if (!dur) return;
    var sec = Math.floor((Date.now() - w.startedAt) / 1000);
    dur.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    var kcalEl = document.getElementById('wo-kcal');
    if (kcalEl) kcalEl.textContent = fmtInt(Math.round(w.kcal));
    var strainEl = document.getElementById('wo-strain');
    if (strainEl) strainEl.textContent = fmt(approxStrainOf(w.zoneSec), 1);
    var peakEl = document.getElementById('wo-peak');
    if (peakEl) peakEl.textContent = fmt(w.maxHr);
    var avgEl = document.getElementById('wo-avg');
    if (avgEl) avgEl.textContent = w.hrSec > 0 ? fmt(Math.round(w.hrSum / w.hrSec)) : '--';
  }

  function workoutBlockHTML() {
    var w = state.workout;
    if (w && w.active) {
      var totalSec = Object.keys(w.zoneSec).reduce(function (a, k) { return a + w.zoneSec[k]; }, 0);
      var bars = HR_ZONE_BANDS.map(function (band, i) {
        var v = w.zoneSec['z' + (i + 1)] || 0;
        if (v <= 0 || totalSec <= 0) return '';
        return '<div style="flex:' + v + ' 0 0%;background:' + band.color + '"></div>';
      }).join('');
      var sec = Math.floor((Date.now() - w.startedAt) / 1000);
      return (
        '<div class="wo-panel">' +
        '<div class="wo-stats">' +
        '<div class="hr-stat"><span class="hr-stat-label">Duration</span><span class="hr-stat-value" id="wo-dur">' +
        Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') + '</span></div>' +
        '<div class="hr-stat"><span class="hr-stat-label">Avg HR</span><span class="hr-stat-value" id="wo-avg">' +
        (w.hrSec > 0 ? fmt(Math.round(w.hrSum / w.hrSec)) : '--') + '</span></div>' +
        '<div class="hr-stat"><span class="hr-stat-label">Peak</span><span class="hr-stat-value" id="wo-peak" style="color:' + C.red + '">' + fmt(w.maxHr) + '</span></div>' +
        '<div class="hr-stat"><span class="hr-stat-label">Calories</span><span class="hr-stat-value" id="wo-kcal">' + fmtInt(Math.round(w.kcal)) + '</span></div>' +
        '<div class="hr-stat"><span class="hr-stat-label">Strain (approx)</span><span class="hr-stat-value" id="wo-strain" style="color:' + C.strain + '">' + fmt(approxStrainOf(w.zoneSec), 1) + '</span></div>' +
        '<button type="button" id="wo-stop-btn" class="hr-live-btn wo-stop">Stop workout</button>' +
        '</div>' +
        (bars ? '<div class="breakdown-bar wo-zonebar">' + bars + '</div>' : '') +
        '</div>'
      );
    }
    if (w && !w.active && w.hrrPending) {
      var left = Math.max(0, Math.ceil((w.hrrPending.resolveAt - Date.now()) / 1000));
      return '<div class="wo-panel"><p class="hr-foot">Measuring heart-rate recovery&hellip; ' +
        left + 's — keep the strap on and stay still.</p></div>';
    }
    var lastSession = state.heartRate && state.heartRate.lastSession;
    var pieces = '';
    if (ble.status === 'connected') {
      pieces += '<button type="button" id="wo-start-btn" class="hr-live-btn wo-start">Start workout</button>';
    }
    if (lastSession) {
      pieces += '<span class="hr-foot wo-last">Last session: ' +
        fmt(lastSession.durationMin, 0) + ' min &middot; avg ' + fmt(lastSession.avgHr) +
        ' &middot; max ' + fmt(lastSession.maxHr) + ' &middot; ' + fmtInt(lastSession.kcal) + ' cal &middot; ~' +
        fmt(lastSession.approxStrain, 1) + ' strain' +
        (isNum(lastSession.hrr60) ? ' &middot; HRR60 <b>' + lastSession.hrr60 + '</b> bpm' : '') +
        '</span>';
    }
    return pieces ? '<div class="wo-panel wo-idle">' + pieces + '</div>' : '';
  }

  /* ---------------- guided breathing ---------------- */

  var breath = { open: false, startedAt: 0, startHr: null, startRmssd: null, timer: null };

  function ensureBreathOverlay() {
    if (document.getElementById('breath-overlay')) return;
    var el = document.createElement('div');
    el.id = 'breath-overlay';
    el.hidden = true;
    el.innerHTML =
      '<div class="breath-panel">' +
      '<p class="micro-label">Guided breathing</p>' +
      '<div class="breath-circle-wrap"><div class="breath-circle" id="breath-circle"></div>' +
      '<span class="breath-phase" id="breath-phase">Inhale</span></div>' +
      '<p class="breath-live" id="breath-live">--</p>' +
      '<p class="hr-foot">5.5 seconds in, 5.5 seconds out. A few minutes is plenty.</p>' +
      '<button type="button" id="breath-close" class="hr-live-btn">End session</button>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      if (e.target === el || e.target.closest('#breath-close')) closeBreathing();
    });
  }

  function openBreathing() {
    ensureBreathOverlay();
    breath.open = true;
    breath.startedAt = Date.now();
    breath.startHr = isNum(ble.bpm) ? ble.bpm : null;
    breath.startRmssd = ble.rmssd;
    document.getElementById('breath-overlay').hidden = false;
    breath.timer = setInterval(function () {
      var t = (Date.now() - breath.startedAt) % 11000;
      var phaseEl = document.getElementById('breath-phase');
      if (phaseEl) phaseEl.textContent = t < 5500 ? 'Inhale' : 'Exhale';
      var liveEl = document.getElementById('breath-live');
      if (liveEl) {
        var fresh = ble.lastAt && Date.now() - ble.lastAt < 10000;
        liveEl.innerHTML = fresh
          ? '<b>' + fmt(ble.bpm) + '</b> bpm' + (isNum(ble.rmssd) ? ' &nbsp;&middot;&nbsp; HRV ' + ble.rmssd + ' ms' : '')
          : 'connect your strap to see your pulse respond';
      }
    }, 250);
  }

  function closeBreathing() {
    if (!breath.open) return;
    breath.open = false;
    clearInterval(breath.timer);
    var el = document.getElementById('breath-overlay');
    if (el) el.hidden = true;
    var elapsed = (Date.now() - breath.startedAt) / 1000;
    var fresh = ble.lastAt && Date.now() - ble.lastAt < 10000;
    if (elapsed >= 60 && isNum(breath.startHr) && fresh && isNum(ble.bpm)) {
      var delta = breath.startHr - ble.bpm;
      var msg = 'Breathing done: ' + breath.startHr + ' → ' + ble.bpm + ' bpm';
      if (isNum(breath.startRmssd) && isNum(ble.rmssd)) {
        msg += ', HRV ' + breath.startRmssd + ' → ' + ble.rmssd + ' ms';
      }
      showToast(msg);
    }
  }

  /* ---------------- live heart rate (health hero) ---------------- */

  // WHOOP's public API has no heart-rate time series, so the series here is
  // built in the main process by polling the in-progress cycle's running
  // average and differencing consecutive readings. See src/hr-monitor.mjs.
  var HR_ZONE_BANDS = [
    { label: 'Rest', color: C.sleep },
    { label: 'Light', color: '#4a90d9' },
    { label: 'Moderate', color: C.green },
    { label: 'Hard', color: C.yellow },
    { label: 'Max', color: C.red },
  ];

  function hrZoneFor(bpm, maxHr) {
    if (!isNum(bpm) || !isNum(maxHr) || maxHr <= 0) return HR_ZONE_BANDS[0];
    var pct = bpm / maxHr;
    if (pct >= 0.9) return HR_ZONE_BANDS[4];
    if (pct >= 0.8) return HR_ZONE_BANDS[3];
    if (pct >= 0.7) return HR_ZONE_BANDS[2];
    if (pct >= 0.6) return HR_ZONE_BANDS[1];
    return HR_ZONE_BANDS[0];
  }

  function hrClock(iso, withSeconds) {
    if (!iso) return '--';
    var d = new Date(iso);
    if (isNaN(d)) return '--';
    var opts = { hour: 'numeric', minute: '2-digit' };
    if (withSeconds) opts.second = '2-digit';
    return d.toLocaleTimeString(undefined, opts);
  }

  function renderHeartRate(hr) {
    var el = document.getElementById('health-hr-card');
    if (!el) return;

    if (!hr || hr.error) {
      el.innerHTML =
        cardHead('Heart Rate &mdash; today') +
        '<div class="empty-state">Heart rate is unavailable right now.</div>';
      return;
    }

    var maxHr = (state.data && state.data.profile && state.data.profile.maxHr) || null;
    var pts = hr.points || [];
    var latest = hr.latestBpm;
    var zone = hrZoneFor(latest, maxHr);
    var liveColor = isNum(latest) ? zone.color : C.label;

    var noteHTML = isNum(hr.sampleEverySeconds)
      ? 'Every <strong>' + fmtInt(hr.sampleEverySeconds) + 's</strong>' +
        (hr.model && isNum(hr.model.rmse)
          ? ' &middot; estimate &plusmn;<strong>' + fmt(hr.model.rmse, 0) + ' bpm</strong>'
          : '')
      : '';

    var strapOn = ble.status === 'connected';
    // Status, not a control: the strap connects and reconnects by itself.
    var strapBtn =
      '<span class="strap-status-group">' + strapBatteryHTML(strapOn) +
      '<span class="strap-strip-state' + (strapOn ? ' on' : '') + '">' +
      (strapOn ? 'Strap live' : escapeHTML(strapStatusText())) +
      '</span></span>';

    var head =
      '<div class="card-head hr-head"><span class="micro-label">Heart Rate &mdash; today</span>' +
      '<span class="hr-head-right">' +
      (noteHTML ? '<span class="card-head-note">' + noteHTML + '</span>' : '') +
      '<button type="button" id="hr-breathe-btn" class="hr-live-btn">Breathe</button>' +
      strapBtn +
      '</span></div>';

    var strapFresh = strapOn && isNum(ble.bpm) && (Date.now() - ble.lastAt) < 15000;
    var readout;
    if (strapOn) {
      var strapZone = hrZoneFor(ble.bpm, maxHr);
      readout =
        '<div class="hr-readout">' +
        '<div class="hr-live">' +
        '<span class="hr-live-dot beating" style="background:' + strapZone.color +
        (isNum(ble.bpm) ? ';animation-duration:' + (60 / clamp(ble.bpm, 30, 220)).toFixed(2) + 's' : '') +
        '" aria-hidden="true"></span>' +
        '<span class="hr-live-value" style="color:' + strapZone.color + '"><span id="hr-ble-num">' +
        fmt(ble.bpm) + '</span><span class="unit">bpm</span></span>' +
        '<span class="hr-live-meta">measured &middot; strap &middot; <span id="hr-ble-time">' +
        (ble.lastAt ? hrClock(new Date(ble.lastAt).toISOString(), true) : '--') + '</span>' +
        (strapFresh ? '' : ' &middot; waiting for broadcast') + '</span>' +
        '</div>' +
        '<div class="hr-stats">' +
        '<div class="hr-stat"><span class="hr-stat-label">Day avg &middot; measured</span>' +
        '<span class="hr-stat-value">' + fmt(hr.cycleAvgHr) + '</span></div>' +
        '<div class="hr-stat"><span class="hr-stat-label">Day max &middot; measured</span>' +
        '<span class="hr-stat-value" style="color:' + C.red + '">' + fmt(hr.cycleMaxHr) + '</span></div>' +
        (hr.measured && hr.measured.rangeBpm
          ? '<div class="hr-stat"><span class="hr-stat-label">Strap range</span>' +
            '<span class="hr-stat-value">' + fmt(hr.measured.rangeBpm.lo) + '&ndash;' +
            fmt(hr.measured.rangeBpm.hi) + '</span></div>'
          : '') +
        (isNum(ble.rmssd)
          ? '<div class="hr-stat"><span class="hr-stat-label">Live HRV &middot; RMSSD</span>' +
            '<span class="hr-stat-value" style="color:' + C.sleep + '">' + ble.rmssd +
            '<span class="unit">ms</span></span></div>'
          : '') +
        '</div>' +
        '</div>';
    } else {
      readout =
      '<div class="hr-readout">' +
      '<div class="hr-live">' +
      '<span class="hr-live-dot' + (isNum(latest) ? ' beating' : '') +
      '" style="background:' + liveColor + '" aria-hidden="true"></span>' +
      '<span class="hr-live-value" style="color:' + liveColor + '">' + fmt(latest) +
      '<span class="unit">bpm</span></span>' +
      '<span class="hr-live-meta">' +
      (isNum(latest)
        ? 'est. &middot; ' + zone.label + ' &middot; ' + hrClock(hr.latestAt)
        : 'waiting for the first reading') +
      '</span>' +
      '</div>' +
      '<div class="hr-stats">' +
      '<div class="hr-stat"><span class="hr-stat-label">Day avg &middot; measured</span>' +
      '<span class="hr-stat-value">' + fmt(hr.cycleAvgHr) + '</span></div>' +
      '<div class="hr-stat"><span class="hr-stat-label">Day max &middot; measured</span>' +
      '<span class="hr-stat-value" style="color:' + C.red + '">' + fmt(hr.cycleMaxHr) + '</span></div>' +
      '<div class="hr-stat"><span class="hr-stat-label">Today&rsquo;s range</span>' +
      '<span class="hr-stat-value">' +
      (hr.rangeBpm ? fmt(hr.rangeBpm.lo) + '&ndash;' + fmt(hr.rangeBpm.hi) : '--') +
      '</span></div>' +
      '</div>' +
      '</div>';
    }

    var body;
    var strip = ble.buffer.length >= 2 ? ble.buffer : null;
    if (!strip && hr.measured && hr.measured.recent && hr.measured.recent.length >= 2) {
      strip = hr.measured.recent.map(function (m) { return [new Date(m.t).getTime(), m.bpm]; });
    }
    if (strapOn && strip) {
      // Live strip: the last ~20 minutes of truly measured beats.
      var step = Math.max(1, Math.floor(strip.length / 480));
      var sPts = strip.filter(function (_, i) { return i % step === 0; });
      var sLabels = sPts.map(function (x) { return new Date(x[0]).toISOString(); });
      var sVals = sPts.map(function (x) { return x[1]; });
      body = chartSlot(function (w) {
        return lineChartSVG({
          width: w, height: 300, dates: sLabels, values: sVals,
          color: C.red, lineColor: C.red,
          fmtTick: function (t) { return fmt(t); },
          xFormat: function (iso) { return hrClock(iso, true); },
        });
      }, 900) +
      '<p class="hr-foot">Measured from your strap&rsquo;s Bluetooth heart-rate broadcast, about once a second. ' +
      'Showing the last 20 minutes.</p>';
    } else if (strapOn) {
      body =
        '<div class="hr-warmup">' +
        '<p class="hr-warmup-title">Connected &mdash; waiting for the first beats</p>' +
        '<p class="hr-warmup-body">The strip draws as broadcasts arrive, about one per second.</p>' +
        '</div>';
    } else if ((hr.dayPoints || pts).length >= 2) {
      var dayPts = (hr.dayPoints && hr.dayPoints.length >= 2) ? hr.dayPoints : pts;
      var anyMeasured = dayPts.some(function (p) { return p.source === 'measured'; });
      var labels = dayPts.map(function (p) { return p.t; });
      var values = dayPts.map(function (p) { return p.bpm; });
      var avg = avgOf(values, 0);
      body = chartSlot(function (w) {
        return lineChartSVG({
          width: w, height: 300, dates: labels, values: values, avg: avg,
          color: C.red, lineColor: C.red,
          dotColors: dayPts.map(function (p) {
            return p.source === 'measured' ? '#ffffff' : hrZoneFor(p.bpm, maxHr).color;
          }),
          fmtTick: function (t) { return fmt(t); },
          xFormat: hrClock,
        });
      }, 900) +
      (anyMeasured
        ? '<p class="hr-foot">White dots are measured by your strap; colored dots are estimated from energy burn.</p>'
        : '');
    } else {
      body =
        '<div class="hr-warmup">' +
        '<p class="hr-warmup-title">Building today&rsquo;s line</p>' +
        '<p class="hr-warmup-body">WHOOP&rsquo;s API publishes no live heart-rate feed. Whoop+ reads your ' +
        'in-progress day every ' + fmtInt(hr.sampleEverySeconds || 30) + ' second' +
        (hr.sampleEverySeconds === 1 ? '' : 's') + ' and estimates heart rate ' +
        'from the energy burned between readings, using a model fitted to your own workout history' +
        (hr.model && isNum(hr.model.n) ? ' (' + fmtInt(hr.model.n) + ' sessions, &plusmn;' + fmt(hr.model.rmse, 0) + ' bpm)' : '') +
        '. The line starts once two readings with new data have arrived.</p>' +
        '<p class="hr-warmup-count">' + fmtInt(hr.sampleCount) + ' reading' +
        (hr.sampleCount === 1 ? '' : 's') + ' so far' +
        (hr.lastSampleAt ? ', last at ' + hrClock(hr.lastSampleAt) : '') + '</p>' +
        '</div>';
    }

    var acts = (hr.activities || []).length
      ? '<div class="hr-activities">' +
        hr.activities.map(function (a) {
          var az = hrZoneFor(a.bpm, maxHr);
          return '<span class="hr-activity">' +
            '<span class="stage-swatch" style="background:' + az.color + '"></span>' +
            '<b>' + escapeHTML(a.sport) + '</b> ' + hrClock(a.t) + ' &middot; avg ' + fmt(a.bpm) +
            (isNum(a.maxBpm) ? ' &middot; max ' + fmt(a.maxBpm) : '') + ' bpm</span>';
        }).join('') +
        '</div>'
      : '';

    var foot = (pts.length >= 2 && hr.model)
      ? '<p class="hr-foot">Line is estimated from energy burn, fitted to ' + fmtInt(hr.model.n) +
        ' of your own sessions (R&sup2; ' + fmt(hr.model.r2, 2) + ', typical error &plusmn;' +
        fmt(hr.model.rmse, 0) + ' bpm). Day average, day max and activity figures are measured by WHOOP.</p>'
      : '';

    var infoSrc = ble.info || hr.strapInfo;
    var strapInfoLine = '';
    if (infoSrc && (strapOn || infoSrc.battery != null)) {
      var infoBits = [];
      if (infoSrc.name) infoBits.push(escapeHTML(infoSrc.name));
      if (isNum(infoSrc.battery)) infoBits.push('battery ' + infoSrc.battery + '%');
      if (infoSrc.firmware) infoBits.push('fw ' + escapeHTML(infoSrc.firmware));
      if (infoSrc.rrSupported != null) {
        infoBits.push(infoSrc.rrSupported ? 'RR intervals: yes (live HRV on)' : 'RR intervals: not broadcast');
      }
      if (infoBits.length) strapInfoLine = '<p class="hr-foot hr-strap-info">' + infoBits.join(' &middot; ') + '</p>';
    }

    var bleNote = '';
    if (ble.status === 'error' && ble.error) {
      bleNote = '<p class="hr-foot hr-ble-error">' + escapeHTML(ble.error) + '</p>';
    } else if (ble.status === 'scanning' && !ble.quiet) {
      bleNote = '<p class="hr-foot">Scanning for your strap&hellip; make sure Broadcast Heart Rate is on in the WHOOP app (Device Settings). The scan gives up after 25 seconds.</p>';
    }

    el.innerHTML = head + bleNote + readout + workoutBlockHTML() + body + acts + strapInfoLine + foot;
    fillCharts(el);
  }

  async function loadHeartRate() {
    var res = await callApi('getHeartRate', [], mockGetHeartRate);
    state.heartRate = res;
    renderHeartRate(res);
  }

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

  // trendRange is either a day-count (7/30/90/182) or the string 'ytd',
  // which is resolved here to "days since Jan 1" of the reference date.
  function resolveRangeDays(rangeSpec) {
    if (rangeSpec === 'ytd') {
      var ref = state.dateList[state.selectedIndex] || state.dateList[0];
      if (!ref) return 30;
      var refDate = parseLocalDate(ref);
      var jan1 = new Date(refDate.getFullYear(), 0, 1);
      return Math.max(1, Math.round((refDate - jan1) / 86400000) + 1);
    }
    var n = Number(rangeSpec);
    return isNum(n) && n > 0 ? n : 30;
  }

  function rangeLabel(rangeSpec, days) {
    return rangeSpec === 'ytd' ? 'year to date' : ('last ' + days + ' days');
  }

  function compareRowHTML(label, cmp, unit, decimals, better) {
    cmp = cmp || {};
    var av = isNum(cmp.a) ? fmt(cmp.a, decimals) : '--';
    var bv = isNum(cmp.b) ? fmt(cmp.b, decimals) : '--';
    return (
      '<div class="dash-row"><span class="dash-label">' + label + '</span>' +
      '<span class="stat-row-right"><span class="dash-value">' + av +
      (unit ? '<span class="unit">' + unit + '</span>' : '') + trendGlyph(cmp.a, cmp.b, better) + '</span>' +
      '<span class="stat-row-prior">was ' + bv + (unit ? ' ' + unit : '') + '</span></span></div>'
    );
  }

  function renderCompareCard(analytics) {
    var el = document.getElementById('trend-compare');
    if (!el) return;
    var cmp = analytics && analytics.compare7v7;
    if (!cmp) {
      el.innerHTML = cardHead('This Week vs. Last') + '<div class="empty-state">Not enough data yet</div>';
      return;
    }
    el.innerHTML =
      cardHead('This Week vs. Last', 'Trailing 7 days') +
      '<div class="dash-list">' +
      compareRowHTML('Recovery', cmp.recovery, '%', 0, true) +
      compareRowHTML('HRV', cmp.hrv, 'ms', 0, true) +
      compareRowHTML('Resting HR', cmp.rhr, 'bpm', 0, false) +
      compareRowHTML('Sleep', cmp.sleepHours, 'hr', 1, true) +
      compareRowHTML('Strain', cmp.strain, '', 1, null) +
      '</div>';
  }

  async function renderTrends(rangeSpec) {
    var range = resolveRangeDays(rangeSpec);
    await ensureHistoryFor(range);
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
      cardHead('My Dashboard', 'vs. prior period, ' + rangeLabel(rangeSpec, range)) +
      '<div class="dash-list">' + listHTML + '</div>';

    var analyticsRes = await callApi('getAnalytics', [{ days: Math.min(Math.max(range, 14), 90) }], mockGetAnalytics);
    renderCompareCard((analyticsRes && !analyticsRes.error) ? analyticsRes : null);
  }

  /* ---------------- view: coach ---------------- */

  // Minimal, safe Markdown for coach replies: text is HTML-escaped first,
  // then only bold/italic/code/bullets/numbered lists/paragraphs are added.
  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  }

  function renderMarkdown(text) {
    var lines = escapeHTML(String(text || '')).replace(/\r\n?/g, '\n').split('\n');
    var html = '';
    var para = [];
    var list = null; // { tag, items }

    function flushPara() {
      if (para.length) {
        html += '<p>' + para.map(inlineMd).join('<br>') + '</p>';
        para = [];
      }
    }
    function flushList() {
      if (list) {
        html += '<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inlineMd(i) + '</li>'; }).join('') + '</' + list.tag + '>';
        list = null;
      }
    }

    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      var bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      var numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      var heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (!line.trim()) { flushPara(); flushList(); return; }
      if (bullet || numbered) {
        flushPara();
        var tag = bullet ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [] }; }
        list.items.push((bullet || numbered)[1]);
        return;
      }
      flushList();
      if (heading) { flushPara(); html += '<p><strong>' + inlineMd(heading[1]) + '</strong></p>'; return; }
      para.push(line.trim());
    });
    flushPara();
    flushList();
    return html;
  }

  function renderCoachMessages() {
    var el = document.getElementById('coach-messages');
    if (!el) return;
    if (!state.coachHistory.length) {
      el.innerHTML = '<div class="empty-state">Ask about your recovery, sleep, or strain to get started.</div>';
    } else {
      el.innerHTML = state.coachHistory.map(function (m) {
        if (m.role === 'user') {
          return '<div class="coach-msg coach-msg-user"><p>' + escapeHTML(m.content) + '</p></div>';
        }
        return '<div class="coach-msg coach-msg-assistant">' + renderMarkdown(m.content) + '</div>';
      }).join('');
    }
    el.scrollTop = el.scrollHeight;
  }

  async function renderCoach() {
    var statusRes = await callApi('coachStatus', [], mockCoachStatus);
    state.coachStatus = (statusRes && !statusRes.error) ? statusRes : { available: false, source: null };
    var gate = document.getElementById('coach-gate-card');
    var chat = document.getElementById('coach-chat');
    if (!gate || !chat) return;
    if (!state.coachStatus.available) {
      gate.hidden = false;
      chat.hidden = true;
      gate.innerHTML =
        '<span class="micro-label">Coach</span>' +
        '<h3 class="coach-gate-title">Coach isn&rsquo;t connected yet</h3>' +
        '<p class="coach-gate-body">Sign in with the claude CLI (<code>claude auth login</code>) or paste an ' +
        'Anthropic API key in Settings to chat about your recovery, sleep, and strain trends here.</p>';
    } else {
      gate.hidden = true;
      chat.hidden = false;
      renderCoachMessages();
    }
  }

  async function handleCoachSubmit() {
    if (state.coachBusy) return;
    var input = document.getElementById('coach-input');
    var question = input && input.value.trim();
    if (!question) return;
    input.value = '';
    state.coachHistory.push({ role: 'user', content: question });
    renderCoachMessages();
    state.coachBusy = true;
    var thinking = document.getElementById('coach-thinking');
    if (thinking) thinking.hidden = false;
    var sendBtn = document.getElementById('coach-send-btn');
    if (sendBtn) sendBtn.disabled = true;
    var history = state.coachHistory.slice(0, -1);
    var res = await callApi('askCoach', [{ question: question, history: history }], mockAskCoach);
    state.coachBusy = false;
    if (thinking) thinking.hidden = true;
    if (sendBtn) sendBtn.disabled = false;
    if (res && typeof res.reply === 'string' && res.reply) {
      state.coachHistory.push({ role: 'assistant', content: res.reply });
    } else {
      state.coachHistory.push({ role: 'assistant', content: apiErrorText(res, 'Sorry, something went wrong.') });
    }
    renderCoachMessages();
  }

  /* ---------------- settings panel ---------------- */

  async function renderSettings() {
    var res = await callApi('getSettings', [], mockGetSettings);
    state.settings = (res && !res.error) ? res
      : { launchAtLogin: false, notificationsEnabled: true, morningHour: 8, autoRefreshMins: 10, autoConnectStrap: true, restingAlertEnabled: false, restingAlertBpm: 100 };
    var el = document.getElementById('settings-body');
    if (!el) return;
    var s = state.settings;
    el.innerHTML =
      '<div class="settings-row">' +
      '<span class="settings-label">Launch at login</span>' +
      '<button type="button" class="settings-toggle' + (s.launchAtLogin ? ' on' : '') +
      '" data-key="launchAtLogin" role="switch" aria-checked="' + !!s.launchAtLogin + '"><span></span></button>' +
      '</div>' +
      '<div class="settings-row">' +
      '<span class="settings-label">Notifications</span>' +
      '<button type="button" class="settings-toggle' + (s.notificationsEnabled ? ' on' : '') +
      '" data-key="notificationsEnabled" role="switch" aria-checked="' + !!s.notificationsEnabled + '"><span></span></button>' +
      '</div>' +
      '<div class="settings-row">' +
      '<label class="settings-label" for="setting-hour">Morning sync hour</label>' +
      '<input type="number" id="setting-hour" class="settings-number" min="0" max="23" step="1" value="' +
      fmtInt(s.morningHour) + '" data-key="morningHour" />' +
      '</div>' +
      '<div class="settings-row">' +
      '<label class="settings-label" for="setting-refresh">Auto-refresh (minutes)</label>' +
      '<input type="number" id="setting-refresh" class="settings-number" min="5" max="120" step="5" value="' +
      fmtInt(s.autoRefreshMins) + '" data-key="autoRefreshMins" />' +
      '</div>' +
      '<div class="settings-row settings-row-stacked">' +
      '<label class="settings-label" for="setting-api-key">Anthropic API key (optional)</label>' +
      '<input type="password" id="setting-api-key" class="settings-text" autocomplete="off" spellcheck="false" ' +
      'placeholder="Blank = use the signed-in claude CLI" value="' + escapeHTML(s.anthropicApiKey || '') +
      '" data-key="anthropicApiKey" />' +
      '<span class="settings-hint">Coach runs Claude Sonnet 5 (medium effort) on your own account.</span>' +
      '</div>' +
      '<div class="settings-row">' +
      '<span class="settings-label">Auto-connect strap<small>Reconnect whenever your WHOOP is in Bluetooth range</small></span>' +
      '<button type="button" class="settings-toggle' + (s.autoConnectStrap !== false ? ' on' : '') +
      '" data-key="autoConnectStrap" role="switch" aria-checked="' + (s.autoConnectStrap !== false) + '"><span></span></button>' +
      '</div>' +
      '<div class="settings-row">' +
      '<span class="settings-label">Resting heart-rate alert<small>Notify when 3-min median exceeds the threshold outside workouts</small></span>' +
      '<button type="button" class="settings-toggle' + (s.restingAlertEnabled ? ' on' : '') +
      '" data-key="restingAlertEnabled" role="switch" aria-checked="' + !!s.restingAlertEnabled + '"><span></span></button>' +
      '</div>' +
      '<div class="settings-row">' +
      '<label class="settings-label" for="setting-alert-bpm">Alert threshold (bpm)</label>' +
      '<input type="number" id="setting-alert-bpm" class="settings-number" min="60" max="200" step="5" value="' +
      fmtInt(s.restingAlertBpm || 100) + '" data-key="restingAlertBpm" />' +
      '</div>';
  }

  /* ---------------- toast ---------------- */

  var toastTimer = null;
  function showToast(message) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
      el.hidden = true;
    }, 3000);
  }

  /* ---------------- view switching ---------------- */

  async function renderActiveView() {
    pendingCharts = {};
    var dateStr = state.dateList[state.selectedIndex];
    var view = state.activeView;
    if (view === 'overview') await renderOverview(dateStr);
    else if (view === 'recovery') await renderRecovery(dateStr);
    else if (view === 'sleep') await renderSleep(dateStr);
    else if (view === 'strain') await renderStrain(dateStr);
    else if (view === 'health') { renderHealth(dateStr); loadHeartRate(); }
    else if (view === 'trends') await renderTrends(state.trendRange);
    else if (view === 'coach') await renderCoach();

    var root = document.getElementById('view-' + view);
    fillCharts(root);
    animateRingsIn(root);
    animateBarsIn(root);
  }

  async function setActiveView(view) {
    if (!view) return;
    state.activeView = view;
    document.querySelectorAll('.view').forEach(function (v) {
      v.hidden = v.id !== 'view-' + view;
    });
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    document.getElementById('content').scrollTop = 0;
    await renderActiveView();
  }

  async function selectDay(dateStr) {
    var idx = state.dateList.indexOf(dateStr);
    if (idx < 0) return;
    state.selectedIndex = idx;
    renderHeader();
    renderDayStrip();
    await renderActiveView();
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
    await renderActiveView();
  }

  // Re-render triggered by window.whoop.onUpdated(cb) — a background
  // refresh/backfill pushed fresh data. Unlike loadAndRender(), this must
  // NOT reset the selected day or active view (FEATURE 9).
  async function applyUpdate(data) {
    if (!data || data.error) return;
    var prevSelectedDate = state.dateList[state.selectedIndex];
    // Someone looking at the newest day wants "today", including after
    // midnight rolls a new day in; a deliberately picked older day stays put.
    var followNewest = state.selectedIndex === 0;
    state.data = data;
    buildIndexes(data);
    var idx = prevSelectedDate ? state.dateList.indexOf(prevSelectedDate) : -1;
    state.selectedIndex = followNewest ? 0 : (idx >= 0 ? idx : 0);
    renderHeader();
    renderDayStrip();
    await renderActiveView();
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

    var RANGE_BTN_IDS = ['range-7d', 'range-30d', 'range-90d', 'range-6m', 'range-ytd'];
    document.getElementById('trends-range-toggle').addEventListener('click', function (e) {
      var btn = e.target.closest('.segmented-btn');
      if (!btn) return;
      var raw = btn.dataset.range;
      state.trendRange = raw === 'ytd' ? 'ytd' : Number(raw);
      RANGE_BTN_IDS.forEach(function (id) {
        var b = document.getElementById(id);
        if (b) b.classList.toggle('active', b === btn);
      });
      renderActiveView();
    });

    document.getElementById('trends-export-group').addEventListener('click', async function (e) {
      var btn = e.target.closest('.export-btn');
      if (!btn) return;
      btn.disabled = true;
      var kind = btn.dataset.kind;
      var res = await callApi('exportCsv', [{ kind: kind }], mockExportCsv);
      btn.disabled = false;
      if (res && res.error) {
        showToast('Export failed: ' + apiErrorText(res, 'unknown error'));
      } else if (res) {
        showToast(res.path
          ? 'Exported ' + res.rows + ' rows to ' + res.path
          : 'Exported ' + res.rows + ' rows (mock mode — no file written)');
      }
    });

    document.getElementById('refresh-btn').addEventListener('click', handleRefresh);
    document.getElementById('reconnect-retry-btn').addEventListener('click', loadAndRender);

    /* anomaly banner dismissal */
    document.getElementById('view-overview').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-dismiss-date]');
      if (!btn) return;
      var d = lsGet(LS_DISMISSED, {});
      d[btn.dataset.dismissDate] = true;
      lsSet(LS_DISMISSED, d);
      var banner = document.getElementById('anomaly-banner');
      if (banner) { banner.hidden = true; banner.innerHTML = ''; }
    });

    /* live heart-rate toggle */
    var viewHealth = document.getElementById('view-health');
    if (viewHealth) {
      viewHealth.addEventListener('click', async function (e) {
        if (e.target.closest('#wo-start-btn')) { startWorkout(); return; }
        if (e.target.closest('#wo-stop-btn')) { stopWorkout(); return; }
        if (e.target.closest('#hr-breathe-btn')) { openBreathing(); return; }
      });
    }

    /* settings panel */
    var settingsBtn = document.getElementById('settings-btn');
    var settingsOverlay = document.getElementById('settings-overlay');
    if (settingsBtn && settingsOverlay) {
      settingsBtn.addEventListener('click', function () {
        settingsOverlay.hidden = false;
        renderSettings();
      });
      document.getElementById('settings-close-btn').addEventListener('click', function () {
        settingsOverlay.hidden = true;
      });
      settingsOverlay.addEventListener('click', function (e) {
        if (e.target === settingsOverlay) settingsOverlay.hidden = true;
      });
      settingsOverlay.addEventListener('click', async function (e) {
        var toggle = e.target.closest('.settings-toggle');
        if (!toggle) return;
        var key = toggle.dataset.key;
        var next = !toggle.classList.contains('on');
        toggle.classList.toggle('on', next);
        toggle.setAttribute('aria-checked', String(next));
        var patch = {};
        patch[key] = next;
        var res = await callApi('setSettings', [patch], mockSetSettings);
        if (res && !res.error) state.settings = res;
      });
      settingsOverlay.addEventListener('change', async function (e) {
        var input = e.target.closest('.settings-number, .settings-text');
        if (!input) return;
        var key = input.dataset.key;
        var val;
        if (input.classList.contains('settings-text')) {
          val = String(input.value || '').trim();
        } else {
          val = Number(input.value);
          if (!isNum(val)) return;
        }
        var patch = {};
        patch[key] = val;
        var res = await callApi('setSettings', [patch], mockSetSettings);
        if (res && !res.error) state.settings = res;
      });
    }

    /* coach view */
    var viewCoach = document.getElementById('view-coach');
    if (viewCoach) {
      viewCoach.addEventListener('submit', function (e) {
        if (!e.target.closest('#coach-input-form')) return;
        e.preventDefault();
        handleCoachSubmit();
      });
    }

    window.addEventListener('resize', debounce(function () {
      if (state.data) renderActiveView();
    }, 180));

    if (window.whoop && typeof window.whoop.onUpdated === 'function') {
      window.whoop.onUpdated(function (freshData) { applyUpdate(freshData); });
    }
    startStrapWatch();
    if (window.whoop && typeof window.whoop.onHeartRate === 'function') {
      window.whoop.onHeartRate(function (hr) {
        state.heartRate = hr;
        if (state.activeView === 'health') renderHeartRate(hr);
      });
    }

    loadAndRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
