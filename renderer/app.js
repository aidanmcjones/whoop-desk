'use strict';

/* ---------------------------------------------------------------
   Whoop Desk — renderer app.js
   Vanilla JS. Builds every chart/gauge as inline SVG. No deps.

   Element/class contract this file expects from index.html:
     #reconnect-state, #reconnect-message, #reconnect-retry-btn
     #main-shell, #top-bar, #greeting, #selected-date, #refresh-btn
     #day-strip
     #content, .view (#view-overview/#view-sleep/#view-strain/#view-trends)
     #recovery-ring-wrap, #metric-cards, #strain-card-overview, #sleep-summary-card
     #sleep-ring-wrap, #sleep-hours-card, #sleep-stage-card, #sleep-stats-row
     #strain-hero-wrap, #workouts-list
     #trends-range-toggle, #range-7d, #range-30d,
     #trend-recovery, #trend-hrv, #trend-rhr, #trend-sleep, #trend-strain
     #tab-bar, .tab-btn[data-view], #tab-overview/#tab-sleep/#tab-strain/#tab-trends
   --------------------------------------------------------------- */

(function () {
  var COLORS = {
    green: '#25e087',
    yellow: '#ffde5a',
    red: '#ff4d5a',
    strain: '#35a7ff',
    sleepAccent: '#7ea6ff',
    deep: '#2b5cff',
    light: '#4a90d9',
    awake: '#8b93a1',
    hairline: '#262b33',
    textSecondary: '#8b93a1',
    rhr: '#ff9f5a',
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

  /* ---------------- formatting helpers ---------------- */

  function isNum(v) {
    return typeof v === 'number' && !Number.isNaN(v);
  }

  function fmt(v, decimals) {
    if (!isNum(v)) return '--';
    return decimals ? v.toFixed(decimals) : String(Math.round(v));
  }

  function fmtDuration(min) {
    if (!isNum(min)) return '--';
    var h = Math.floor(min / 60);
    var m = Math.round(min % 60);
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return m + 'm';
  }

  function fmtTime(iso) {
    if (!iso) return '--';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function parseLocalDate(dateStr) {
    var parts = dateStr.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function headerDateLabel(dateStr, idx) {
    if (idx === 0) return 'Today';
    if (idx === 1) return 'Yesterday';
    var dt = parseLocalDate(dateStr);
    return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function dayAxisLabel(dateStr, n) {
    var dt = parseLocalDate(dateStr);
    return n <= 7 ? dt.toLocaleDateString(undefined, { weekday: 'narrow' }) : String(dt.getDate());
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function avgOf(values, decimals) {
    var present = values.filter(isNum);
    if (!present.length) return null;
    var avg = present.reduce(function (a, b) { return a + b; }, 0) / present.length;
    return Number(avg.toFixed(decimals || 0));
  }

  function recoveryColor(score) {
    if (!isNum(score)) return COLORS.textSecondary;
    if (score >= 67) return COLORS.green;
    if (score >= 34) return COLORS.yellow;
    return COLORS.red;
  }

  function greetingText() {
    var h = new Date().getHours();
    var word = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    var name = state.data && state.data.profile && state.data.profile.firstName;
    return name ? word + ', ' + name : word;
  }

  function chartInnerWidth() {
    var w = (window.innerWidth || 390) - 72; // content padding + card padding, both sides
    return Math.max(230, Math.min(400, w));
  }

  /* ---------------- SVG builders ---------------- */

  function ringSVG(opts) {
    var size = opts.size, stroke = opts.stroke, pct = clamp(opts.pct || 0, 0, 1), color = opts.color;
    var r = (size - stroke) / 2;
    var c = 2 * Math.PI * r;
    var target = c * (1 - pct);
    return (
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="position:absolute;inset:0;transform:rotate(-90deg)">' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + COLORS.hairline + '" stroke-width="' + stroke + '" />' +
      '<circle class="ring-fg" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="' + stroke +
      '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + c + '" data-target-offset="' + target + '" />' +
      '</svg>'
    );
  }

  function heroRing(opts) {
    var size = opts.size;
    return (
      '<div class="ring-figure" style="width:' + size + 'px;height:' + size + 'px">' +
      ringSVG(opts) +
      '<div class="ring-center">' + (opts.centerHTML || '') + '</div>' +
      '</div>'
    );
  }

  function sparklineSVG(values, opts) {
    var width = opts.width, height = opts.height, color = opts.color, strokeWidth = opts.strokeWidth || 2;
    var nums = values.map(function (v) { return isNum(v) ? v : null; });
    var present = nums.filter(function (v) { return v != null; });
    if (!present.length) {
      return '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"></svg>';
    }
    var min = Math.min.apply(null, present);
    var max = Math.max.apply(null, present);
    var span = (max - min) || 1;
    var n = nums.length;
    var stepX = n > 1 ? width / (n - 1) : 0;
    var pad = strokeWidth + 1;
    function toY(v) {
      return height - pad - ((v - min) / span) * (height - 2 * pad);
    }
    var segs = [];
    var cur = [];
    nums.forEach(function (v, i) {
      if (v == null) {
        if (cur.length) { segs.push(cur); cur = []; }
        return;
      }
      cur.push([i * stepX, toY(v)]);
    });
    if (cur.length) segs.push(cur);
    var pathD = segs.map(function (seg) {
      return 'M' + seg.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' L');
    }).join(' ');
    var lastPoint = null;
    for (var i = nums.length - 1; i >= 0; i--) {
      if (nums[i] != null) { lastPoint = [i * stepX, toY(nums[i])]; break; }
    }
    var dot = lastPoint
      ? '<circle cx="' + lastPoint[0].toFixed(1) + '" cy="' + lastPoint[1].toFixed(1) + '" r="2.5" fill="' + color + '" />'
      : '';
    return (
      '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
      '<path d="' + pathD + '" fill="none" stroke="' + color + '" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round" />' +
      dot +
      '</svg>'
    );
  }

  function lineTrendSVG(opts) {
    var dates = opts.dates, values = opts.values, color = opts.color, dotColors = opts.dotColors, height = opts.height || 108;
    var w = chartInnerWidth();
    var labelH = 18;
    var padTop = 10, padBottom = 6;
    var nums = values.map(function (v) { return isNum(v) ? v : null; });
    var present = nums.filter(function (v) { return v != null; });
    var min = present.length ? Math.min.apply(null, present) : 0;
    var max = present.length ? Math.max.apply(null, present) : 1;
    if (max === min) { max += 1; min -= 1; }
    var span = max - min;
    var n = nums.length;
    var x0 = 8;
    var stepX = n > 1 ? (w - x0 * 2) / (n - 1) : 0;
    var plotH = height - padTop - padBottom;
    function toY(v) { return padTop + plotH - ((v - min) / span) * plotH; }
    var pts = nums.map(function (v, i) { return v == null ? null : [x0 + i * stepX, toY(v)]; });
    var segs = [];
    var cur = [];
    pts.forEach(function (p) {
      if (!p) { if (cur.length) { segs.push(cur); cur = []; } return; }
      cur.push(p);
    });
    if (cur.length) segs.push(cur);
    var pathD = segs.map(function (seg) {
      return 'M' + seg.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' L');
    }).join(' ');
    var dots = pts.map(function (p, i) {
      if (!p) return '';
      var c = (dotColors && dotColors[i]) || color;
      return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.2" fill="' + c + '" />';
    }).join('');
    var showEvery = n <= 7 ? 1 : Math.ceil(n / 6);
    var labels = dates.map(function (d, i) {
      if (i % showEvery !== 0 && i !== n - 1) return '';
      var x = x0 + i * stepX;
      return '<text x="' + x.toFixed(1) + '" y="' + (height + labelH - 4) + '" font-size="9" fill="' + COLORS.textSecondary + '" text-anchor="middle">' + dayAxisLabel(d, n) + '</text>';
    }).join('');
    var lineColor = dotColors ? '#3a4148' : color;
    return (
      '<svg width="' + w + '" height="' + (height + labelH) + '" viewBox="0 0 ' + w + ' ' + (height + labelH) + '">' +
      '<path d="' + pathD + '" fill="none" stroke="' + lineColor + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />' +
      dots + labels +
      '</svg>'
    );
  }

  function barTrendSVG(opts) {
    var dates = opts.dates, values = opts.values, color = opts.color, height = opts.height || 108, needValues = opts.needValues;
    var w = chartInnerWidth();
    var labelH = 18;
    var padTop = 10, padBottom = 4;
    var nums = values.map(function (v) { return isNum(v) ? v : null; });
    var present = nums.filter(function (v) { return v != null; });
    var needPresent = (needValues || []).filter(isNum);
    var maxCandidates = present.concat(needPresent);
    var max = maxCandidates.length ? Math.max.apply(null, maxCandidates) * 1.12 : 1;
    var n = nums.length;
    var gap = n <= 7 ? 6 : 2;
    var barW = Math.max(3, (w - gap * (n - 1)) / n);
    var plotH = height - padTop - padBottom;
    function barH(v) { return v == null ? 0 : (v / max) * plotH; }
    var bars = '';
    var ticks = '';
    nums.forEach(function (v, i) {
      var x = i * (barW + gap);
      if (v != null) {
        var h = Math.max(2, barH(v));
        var y = height - padBottom - h;
        bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2.5" fill="' + color + '" />';
      }
      if (needValues && isNum(needValues[i])) {
        var ny = height - padBottom - barH(needValues[i]);
        ticks += '<line x1="' + (x - 1).toFixed(1) + '" y1="' + ny.toFixed(1) + '" x2="' + (x + barW + 1).toFixed(1) + '" y2="' + ny.toFixed(1) + '" stroke="#ffffff" stroke-width="1.3" stroke-dasharray="2,2" opacity="0.55" />';
      }
    });
    var showEvery = n <= 7 ? 1 : Math.ceil(n / 6);
    var labels = dates.map(function (d, i) {
      if (i % showEvery !== 0 && i !== n - 1) return '';
      var x = i * (barW + gap) + barW / 2;
      return '<text x="' + x.toFixed(1) + '" y="' + (height + labelH - 4) + '" font-size="9" fill="' + COLORS.textSecondary + '" text-anchor="middle">' + dayAxisLabel(d, n) + '</text>';
    }).join('');
    return (
      '<svg width="' + w + '" height="' + (height + labelH) + '" viewBox="0 0 ' + w + ' ' + (height + labelH) + '">' +
      bars + ticks + labels +
      '</svg>'
    );
  }

  function stageBarParts(stages) {
    stages = stages || {};
    var segs = [
      { min: stages.awakeMin, color: COLORS.awake, label: 'Awake' },
      { min: stages.lightMin, color: COLORS.light, label: 'Light' },
      { min: stages.remMin, color: COLORS.sleepAccent, label: 'REM' },
      { min: stages.deepMin, color: COLORS.deep, label: 'Deep (SWS)' },
    ];
    var anyData = segs.some(function (s) { return isNum(s.min) && s.min > 0; });
    var bar = anyData
      ? segs.map(function (s) {
          if (!isNum(s.min) || s.min <= 0) return '';
          return '<div class="stage-bar-seg" style="flex:' + s.min + ' 0 0%;background:' + s.color + '"></div>';
        }).join('')
      : '<div class="stage-bar-seg" style="flex:1 0 0%;background:' + COLORS.hairline + '"></div>';
    var legend = segs.map(function (s) {
      return (
        '<div class="stage-legend-item">' +
        '<span class="stage-swatch" style="background:' + s.color + '"></span>' +
        '<span class="stage-legend-text"><span class="stage-legend-name">' + s.label + '</span>' +
        '<span class="stage-legend-value">' + fmtDuration(s.min) + '</span></span>' +
        '</div>'
      );
    }).join('');
    return { bar: bar, legend: legend };
  }

  /* ---------------- animation kickers ---------------- */

  function animateRingsIn(root) {
    var els = root.querySelectorAll('.ring-fg');
    els.forEach(function (el) {
      var target = el.getAttribute('data-target-offset');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          el.style.strokeDashoffset = target;
        });
      });
    });
  }

  function animateBarsIn(root) {
    var els = root.querySelectorAll('.bar-fill[data-target-width]');
    els.forEach(function (el) {
      var target = el.getAttribute('data-target-width');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          el.style.width = target;
        });
      });
    });
  }

  /* ---------------- data indexing ---------------- */

  function buildIndexes(data) {
    var recovery = data.recovery || [];
    var sleep = data.sleep || [];
    var cycles = data.cycles || [];
    var workouts = data.workouts || [];

    var byRecovery = {}, bySleep = {}, byCycle = {}, byWorkouts = {};
    recovery.forEach(function (r) { byRecovery[r.date] = r; });
    sleep.forEach(function (s) { bySleep[s.date] = s; });
    cycles.forEach(function (c) { byCycle[c.date] = c; });
    workouts.forEach(function (w) {
      if (!byWorkouts[w.date]) byWorkouts[w.date] = [];
      byWorkouts[w.date].push(w);
    });

    var dateSet = {};
    recovery.forEach(function (r) { dateSet[r.date] = true; });
    cycles.forEach(function (c) { dateSet[c.date] = true; });
    sleep.forEach(function (s) { dateSet[s.date] = true; });
    var dateList = Object.keys(dateSet).sort().reverse();

    state.dateList = dateList;
    state.byDate = { recovery: byRecovery, sleep: bySleep, cycle: byCycle };
    state.workoutsByDate = byWorkouts;
  }

  function trailingValues(field, count) {
    var slice = state.dateList.slice(state.selectedIndex, state.selectedIndex + count);
    slice = slice.slice().reverse(); // oldest -> newest
    return {
      dates: slice,
      values: slice.map(function (d) {
        var rec = state.byDate.recovery[d];
        return rec ? rec[field] : null;
      }),
    };
  }

  /* ---------------- render: day strip + header ---------------- */

  function renderHeader() {
    document.getElementById('greeting').textContent = greetingText();
    var dateStr = state.dateList[state.selectedIndex];
    document.getElementById('selected-date').textContent = dateStr ? headerDateLabel(dateStr, state.selectedIndex) : '--';
  }

  function renderDayStrip() {
    var last14 = state.dateList.slice(0, 14).slice().reverse();
    var selectedDate = state.dateList[state.selectedIndex];
    var html = last14.map(function (dateStr) {
      var rec = state.byDate.recovery[dateStr];
      var score = rec ? rec.score : null;
      var color = recoveryColor(score);
      var pct = isNum(score) ? clamp(score, 0, 100) / 100 : 0;
      var dt = parseLocalDate(dateStr);
      var weekday = dt.toLocaleDateString(undefined, { weekday: 'narrow' });
      var dayNum = dt.getDate();
      var active = dateStr === selectedDate;
      return (
        '<button class="day-item' + (active ? ' active' : '') + '" data-date="' + dateStr + '" aria-pressed="' + active + '">' +
        '<span class="day-weekday">' + weekday + '</span>' +
        '<span class="day-ring-wrap">' + ringSVG({ size: 34, stroke: 3, pct: pct, color: color }) +
        '<span class="day-number">' + dayNum + '</span></span>' +
        '</button>'
      );
    }).join('');
    var stripEl = document.getElementById('day-strip');
    stripEl.innerHTML = html;
    requestAnimationFrame(function () { stripEl.scrollLeft = stripEl.scrollWidth; });
    animateRingsIn(stripEl);
  }

  /* ---------------- render: overview ---------------- */

  var METRIC_CONFIG = [
    { key: 'hrv', label: 'HRV', unit: 'ms', color: COLORS.sleepAccent, decimals: 0 },
    { key: 'rhr', label: 'RHR', unit: 'bpm', color: COLORS.rhr, decimals: 0 },
    { key: 'spo2', label: 'SpO2', unit: '%', color: COLORS.strain, decimals: 0 },
    { key: 'skinTempC', label: 'Skin Temp', unit: '°C', color: COLORS.green, decimals: 1 },
  ];

  function renderOverview(dateStr) {
    var rec = state.byDate.recovery[dateStr];
    var slp = state.byDate.sleep[dateStr];
    var cyc = state.byDate.cycle[dateStr];

    var score = rec ? rec.score : null;
    var color = recoveryColor(score);
    var centerHTML =
      '<div class="ring-value" style="color:' + color + '">' + fmt(score) + (isNum(score) ? '<span class="ring-unit">%</span>' : '') + '</div>' +
      '<div class="ring-sublabel">Recovery</div>';
    var ringHTML = heroRing({ size: 176, stroke: 14, pct: isNum(score) ? score / 100 : 0, color: color, centerHTML: centerHTML });
    var caption =
      '<div class="hero-caption">HRV <strong>' + fmt(rec && rec.hrv) + '</strong> ms &nbsp;&middot;&nbsp; RHR <strong>' +
      fmt(rec && rec.rhr) + '</strong> bpm</div>';
    document.getElementById('recovery-ring-wrap').innerHTML = ringHTML + caption;

    var metricsHTML = METRIC_CONFIG.map(function (cfg) {
      var val = rec ? rec[cfg.key] : null;
      var tv = trailingValues(cfg.key, 7);
      var spark = sparklineSVG(tv.values, { width: 100, height: 28, color: cfg.color });
      return (
        '<div class="metric-card">' +
        '<div class="metric-card-top"><div class="metric-card-value">' + fmt(val, cfg.decimals) +
        '<span class="unit">' + cfg.unit + '</span></div></div>' +
        '<div class="metric-card-label">' + cfg.label + '</div>' +
        '<div class="metric-card-spark">' + spark + '</div>' +
        '</div>'
      );
    }).join('');
    document.getElementById('metric-cards').innerHTML = metricsHTML;

    var strain = cyc ? cyc.strain : null;
    var kcal = cyc && isNum(cyc.kilojoules) ? Math.round(cyc.kilojoules * 0.239) : null;
    var strainRing = heroRing({
      size: 76, stroke: 8, pct: isNum(strain) ? strain / 21 : 0, color: COLORS.strain,
      centerHTML: '<div style="font-size:19px;font-weight:800">' + fmt(strain, 1) + '</div>',
    });
    document.getElementById('strain-card-overview').innerHTML =
      '<div class="summary-card-head"><span class="summary-card-title">Day Strain</span></div>' +
      '<div class="strain-row">' +
      '<div class="strain-figure">' + strainRing + '</div>' +
      '<div class="strain-stats">' +
      '<div class="stat-line"><span class="stat-num">' + fmt(kcal) + '</span><span class="stat-name">Calories</span></div>' +
      '<div class="stat-line"><span class="stat-num">' + fmt(cyc && cyc.avgHr) + '</span><span class="stat-name">Avg HR</span></div>' +
      '</div></div>';

    var perf = slp ? slp.performancePct : null;
    var dur = slp ? slp.durationMin : null;
    var need = slp ? slp.needMin : null;
    var ratio = (isNum(dur) && isNum(need) && need > 0) ? clamp(dur / need, 0, 1.25) : 0;
    var fillPct = Math.min(100, ratio * 100);
    document.getElementById('sleep-summary-card').innerHTML =
      '<div class="summary-card-head"><span class="summary-card-title">Sleep</span></div>' +
      '<div class="sleep-summary-row">' +
      '<div class="sleep-summary-pct" style="color:' + COLORS.sleepAccent + '">' + fmt(perf) +
      '<span style="font-size:15px;font-weight:700;color:var(--text-secondary)">%</span></div>' +
      '<div class="sleep-summary-bar-wrap">' +
      '<div class="bar-track"><div class="bar-fill" data-target-width="' + fillPct + '%" style="background:' + COLORS.sleepAccent + '"></div>' +
      (isNum(need) ? '<div class="bar-need-tick" style="left:' + Math.min(100, (need / need) * 100) + '%"></div>' : '') +
      '</div>' +
      '<div class="bar-caption"><span>' + fmtDuration(dur) + '</span><span>Need ' + fmtDuration(need) + '</span></div>' +
      '</div></div>';
  }

  /* ---------------- render: sleep ---------------- */

  function renderSleep(dateStr) {
    var slp = state.byDate.sleep[dateStr];
    var perf = slp ? slp.performancePct : null;

    var ringHTML = heroRing({
      size: 168, stroke: 14, pct: isNum(perf) ? clamp(perf, 0, 100) / 100 : 0, color: COLORS.sleepAccent,
      centerHTML: '<div class="ring-value">' + fmt(perf) + (isNum(perf) ? '<span class="ring-unit">%</span>' : '') + '</div><div class="ring-sublabel">Performance</div>',
    });
    var bedWake = slp ? fmtTime(slp.start) + ' &rarr; ' + fmtTime(slp.end) : '--';
    document.getElementById('sleep-ring-wrap').innerHTML = ringHTML + '<div class="hero-caption">' + bedWake + '</div>';

    var dur = slp ? slp.durationMin : null;
    var need = slp ? slp.needMin : null;
    var ratio = (isNum(dur) && isNum(need) && need > 0) ? clamp(dur / need, 0, 1.25) : 0;
    document.getElementById('sleep-hours-card').innerHTML =
      '<div class="summary-card-head"><span class="summary-card-title">Hours vs Need</span></div>' +
      '<div class="sleep-hours-figure"><span class="big-num">' + fmtDuration(dur) + '</span><span class="vs">of ' + fmtDuration(need) + ' need</span></div>' +
      '<div class="bar-track"><div class="bar-fill" data-target-width="' + Math.min(100, ratio * 100) + '%" style="background:' + COLORS.sleepAccent + '"></div>' +
      '<div class="bar-need-tick" style="left:100%"></div></div>';

    var stage = stageBarParts(slp && slp.stages);
    document.getElementById('sleep-stage-card').innerHTML =
      '<div class="summary-card-head"><span class="summary-card-title">Sleep Stages</span></div>' +
      '<div class="stage-bar-track">' + stage.bar + '</div>' +
      '<div class="stage-legend">' + stage.legend + '</div>';

    var eff = slp ? slp.efficiencyPct : null;
    var cons = slp ? slp.consistencyPct : null;
    document.getElementById('sleep-stats-row').innerHTML =
      '<div class="stat-block"><span class="stat-block-value">' + fmt(eff) + '%</span><span class="stat-block-label">Efficiency</span></div>' +
      '<div class="stat-block"><span class="stat-block-value">' + fmt(cons) + '%</span><span class="stat-block-label">Consistency</span></div>' +
      '<div class="stat-block"><span class="stat-block-value">' + (slp ? fmtTime(slp.start) : '--') + '</span><span class="stat-block-label">Bedtime</span></div>' +
      '<div class="stat-block"><span class="stat-block-value">' + (slp ? fmtTime(slp.end) : '--') + '</span><span class="stat-block-label">Wake</span></div>';
  }

  /* ---------------- render: strain ---------------- */

  var SPORT_EMOJI = {
    Running: '\u{1F3C3}', Cycling: '\u{1F6B4}', Weightlifting: '\u{1F3CB}️',
    Yoga: '\u{1F9D8}', Swimming: '\u{1F3CA}', Walking: '\u{1F6B6}', HIIT: '\u{1F525}',
  };

  function renderStrain(dateStr) {
    var cyc = state.byDate.cycle[dateStr];
    var strain = cyc ? cyc.strain : null;
    var kcal = cyc && isNum(cyc.kilojoules) ? Math.round(cyc.kilojoules * 0.239) : null;

    var ringHTML = heroRing({
      size: 180, stroke: 14, pct: isNum(strain) ? strain / 21 : 0, color: COLORS.strain,
      centerHTML: '<div class="ring-value strain-hero-num">' + fmt(strain, 1) + '</div><div class="ring-sublabel">Strain</div>',
    });
    document.getElementById('strain-hero-wrap').innerHTML =
      ringHTML +
      '<div class="hero-caption">' + fmt(kcal) + ' cal &nbsp;&middot;&nbsp; Avg HR <strong>' + fmt(cyc && cyc.avgHr) +
      '</strong> &nbsp;&middot;&nbsp; Max HR <strong>' + fmt(cyc && cyc.maxHr) + '</strong></div>';

    var workouts = state.workoutsByDate[dateStr] || [];
    var listEl = document.getElementById('workouts-list');
    if (!workouts.length) {
      listEl.innerHTML = '<div class="empty-state">No activities logged</div>';
      return;
    }
    listEl.innerHTML = workouts.map(function (w) {
      var glyph = w.emoji || SPORT_EMOJI[w.sport] || '\u{1F3C3}';
      return (
        '<div class="workout-card">' +
        '<div class="workout-emoji">' + glyph + '</div>' +
        '<div class="workout-main">' +
        '<div class="workout-sport">' + (w.sport || 'Workout') + '</div>' +
        '<div class="workout-meta">' + fmtTime(w.start) + ' &middot; ' + fmtDuration(w.durationMin) + '</div>' +
        '</div>' +
        '<div class="workout-metrics">' +
        '<div class="workout-strain">' + fmt(w.strain, 1) + '</div>' +
        '<div class="workout-hr">' + fmt(w.avgHr) + '/' + fmt(w.maxHr) + ' bpm</div>' +
        '</div>' +
        '</div>'
      );
    }).join('');
  }

  /* ---------------- render: trends ---------------- */

  function renderTrends(range) {
    var n = range;
    var dates = state.dateList.slice(0, n).slice().reverse();

    function fieldValues(map, field) {
      return dates.map(function (d) { var rec = map[d]; return rec ? rec[field] : null; });
    }

    // Recovery
    var recVals = fieldValues(state.byDate.recovery, 'score');
    var recDots = recVals.map(recoveryColor);
    var recAvg = avgOf(recVals, 0);
    document.getElementById('trend-recovery').innerHTML =
      '<div class="trend-card-head"><span class="trend-card-title">Recovery</span><span class="trend-card-avg">Avg <strong>' +
      (recAvg == null ? '--' : recAvg + '%') + '</strong></span></div>' +
      lineTrendSVG({ dates: dates, values: recVals, color: COLORS.green, dotColors: recDots }) +
      '<div class="trend-legend">' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + COLORS.red + '"></span>Low</span>' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + COLORS.yellow + '"></span>Med</span>' +
      '<span class="trend-legend-item"><span class="trend-legend-dot" style="background:' + COLORS.green + '"></span>High</span>' +
      '</div>';

    // HRV
    var hrvVals = fieldValues(state.byDate.recovery, 'hrv');
    var hrvAvg = avgOf(hrvVals, 0);
    document.getElementById('trend-hrv').innerHTML =
      '<div class="trend-card-head"><span class="trend-card-title">HRV</span><span class="trend-card-avg">Avg <strong>' +
      (hrvAvg == null ? '--' : hrvAvg + ' ms') + '</strong></span></div>' +
      lineTrendSVG({ dates: dates, values: hrvVals, color: COLORS.sleepAccent });

    // RHR
    var rhrVals = fieldValues(state.byDate.recovery, 'rhr');
    var rhrAvg = avgOf(rhrVals, 0);
    document.getElementById('trend-rhr').innerHTML =
      '<div class="trend-card-head"><span class="trend-card-title">Resting Heart Rate</span><span class="trend-card-avg">Avg <strong>' +
      (rhrAvg == null ? '--' : rhrAvg + ' bpm') + '</strong></span></div>' +
      lineTrendSVG({ dates: dates, values: rhrVals, color: COLORS.rhr });

    // Sleep hours vs need
    var durVals = fieldValues(state.byDate.sleep, 'durationMin').map(function (v) { return isNum(v) ? v / 60 : null; });
    var needVals = fieldValues(state.byDate.sleep, 'needMin').map(function (v) { return isNum(v) ? v / 60 : null; });
    var durAvg = avgOf(durVals, 1);
    document.getElementById('trend-sleep').innerHTML =
      '<div class="trend-card-head"><span class="trend-card-title">Sleep Hours</span><span class="trend-card-avg">Avg <strong>' +
      (durAvg == null ? '--' : durAvg + 'h') + '</strong></span></div>' +
      barTrendSVG({ dates: dates, values: durVals, color: COLORS.sleepAccent, needValues: needVals });

    // Strain
    var strainVals = fieldValues(state.byDate.cycle, 'strain');
    var strainAvg = avgOf(strainVals, 1);
    document.getElementById('trend-strain').innerHTML =
      '<div class="trend-card-head"><span class="trend-card-title">Strain</span><span class="trend-card-avg">Avg <strong>' +
      (strainAvg == null ? '--' : strainAvg) + '</strong></span></div>' +
      barTrendSVG({ dates: dates, values: strainVals, color: COLORS.strain });
  }

  /* ---------------- view switching ---------------- */

  function renderActiveView() {
    var dateStr = state.dateList[state.selectedIndex];
    if (state.activeView === 'overview') renderOverview(dateStr);
    else if (state.activeView === 'sleep') renderSleep(dateStr);
    else if (state.activeView === 'strain') renderStrain(dateStr);
    else if (state.activeView === 'trends') renderTrends(state.trendRange);
    animateRingsIn(document);
    animateBarsIn(document);
  }

  function setActiveView(view) {
    state.activeView = view;
    document.querySelectorAll('.view').forEach(function (v) {
      v.hidden = v.id !== 'view-' + view;
    });
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
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
    if (data && typeof data.message === 'string' && data.message) {
      msgEl.textContent = data.message;
    } else {
      msgEl.textContent = "We couldn't reach your Whoop data. Check your connection and try again.";
    }
  }

  function hideReconnect() {
    document.getElementById('reconnect-state').hidden = true;
    document.getElementById('main-shell').hidden = false;
  }

  /* ---------------- data loading ---------------- */

  async function fetchDashboard() {
    try {
      var data = window.whoop
        ? await window.whoop.getDashboard()
        : await (await fetch('./mock-data.json')).json();
      return data;
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

    document.getElementById('tab-bar').addEventListener('click', function (e) {
      var btn = e.target.closest('.tab-btn');
      if (btn) setActiveView(btn.dataset.view);
    });

    document.getElementById('trends-range-toggle').addEventListener('click', function (e) {
      var btn = e.target.closest('.segmented-btn');
      if (!btn) return;
      state.trendRange = Number(btn.dataset.range);
      document.getElementById('range-7d').classList.toggle('active', state.trendRange === 7);
      document.getElementById('range-30d').classList.toggle('active', state.trendRange === 30);
      renderTrends(state.trendRange);
      animateBarsIn(document);
    });

    document.getElementById('refresh-btn').addEventListener('click', handleRefresh);
    document.getElementById('reconnect-retry-btn').addEventListener('click', loadAndRender);

    window.addEventListener('resize', debounce(function () {
      if (state.data && state.activeView === 'trends') {
        renderTrends(state.trendRange);
      }
    }, 200));

    loadAndRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
