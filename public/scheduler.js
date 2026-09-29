// Scheduling engine. Shared by the browser (script tag) and Node (require).
//
// Techniques used (all standard):
//   - Three-point (PERT) estimating: each complexity has best/likely/worst dev-weeks;
//     expected = (best + 4*likely + worst) / 6. Fixed stages are timeboxes.
//   - Resource-constrained scheduling: one shared developer pool, allocated week by week in
//     priority (list) order (serial schedule generation with a priority rule).
//   - Brooks' law: a use case with several developers loses `teamOverhead` of throughput per
//     extra developer, so effort (dev-weeks) and duration are not interchangeable.
//   - WIP limit: at most `wipLimit` use cases in flight at once (no multitasking / Little's law).
//   - Monte Carlo forecast: sample effort from a PERT-beta distribution, re-run the plan many
//     times, report P50/P80/P90 completion.
(function (root) {
  const DAY = 86400000;

  function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function fmtDate(d) { return d.toISOString().slice(0, 10); }
  function addWeeks(d, w) { return new Date(d.getTime() + w * 7 * DAY); }
  function nextMonday(from) {
    const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
    return fmtDate(new Date(d.getTime() + ((8 - d.getUTCDay()) % 7 || 7) * DAY));
  }

  function defaultState() {
    const items = [];
    for (let i = 1; i <= 20; i++) {
      items.push({
        id: 'uc' + i, name: 'AI use case ' + i,
        complexity: ['low', 'medium', 'medium', 'high', 'very high'][(i * 7) % 5],
        teamCap: null, effortOverride: null, earliestStart: null, overrides: {},
      });
    }
    return {
      config: {
        startDate: nextMonday(new Date()),
        devResources: 4,
        defaultTeamCap: 2,
        teamOverhead: 0.1,
        wipLimit: 6,
        stages: [
          { id: 'discovery', name: 'Discovery', weeks: 2 },
          { id: 'pov', name: 'Proof of value', weeks: 4 },
          { id: 'eng', name: 'Engineering', kind: 'eng' },
          { id: 'prod', name: 'Production readiness', weeks: 2 },
          { id: 'deploy', name: 'Deployment', weeks: 1 },
          { id: 'support', name: 'Support transition', weeks: 2 },
        ],
        complexities: [
          { key: 'low', name: 'Low', min: 4, effort: 6, max: 10 },
          { key: 'medium', name: 'Medium', min: 8, effort: 12, max: 20 },
          { key: 'high', name: 'High', min: 16, effort: 24, max: 42 },
          { key: 'very high', name: 'Very high', min: 26, effort: 40, max: 75 },
        ],
      },
      items,
    };
  }

  // Upgrade older saved shapes and fill in missing fields.
  function normalize(state) {
    const c = state.config;
    if (!c.stages) {
      c.stages = [
        ...(c.preStages || []).map(s => ({ id: s.key, name: s.name, weeks: s.weeks })),
        { id: 'eng', name: 'Engineering', kind: 'eng' },
        ...(c.postStages || []).map(s => ({ id: s.key, name: s.name, weeks: s.weeks })),
      ];
      delete c.preStages; delete c.postStages;
    }
    if (c.teamOverhead == null) c.teamOverhead = 0.1;
    if (c.wipLimit == null) c.wipLimit = 6;
    c.complexities.forEach(x => {
      if (x.min == null) x.min = Math.round(x.effort * 0.7);
      if (x.max == null) x.max = Math.round(x.effort * 1.75);
    });
    state.items.forEach(it => { if (!it.overrides) it.overrides = {}; });
    return state;
  }

  const pertMean = x => (x.min + 4 * x.effort + x.max) / 6;

  function schedule(state, opts = {}) {
    normalize(state);
    const { config, items } = state;
    const start = parseDate(config.startDate);
    const stages = config.stages;
    const engIdx = stages.findIndex(s => s.kind === 'eng');
    const cx = Object.fromEntries(config.complexities.map(c => [c.key, c]));
    const pool = Number(config.devResources) || 0;
    const overhead = Math.max(0, Number(config.teamOverhead) || 0);
    const wip = Number(config.wipLimit) || 0;
    const weeksFor = (it, s) => {
      const o = it.overrides && it.overrides[s.id];
      return Math.max(0, Number(o != null && o !== '' ? o : s.weeks) || 0);
    };
    const sum = (it, list) => list.reduce((a, s) => a + weeksFor(it, s), 0);

    const rows = items.map(it => {
      const earliest = it.earliestStart
        ? Math.max(0, Math.round((parseDate(it.earliestStart) - start) / (7 * DAY))) : 0;
      let effort = 0;
      if (engIdx >= 0) {
        if (Number(it.effortOverride) > 0) effort = Number(it.effortOverride);
        else if (opts.efforts && opts.efforts[it.id] != null) effort = opts.efforts[it.id];
        else if (cx[it.complexity]) effort = pertMean(cx[it.complexity]);
      }
      const cap = Math.max(0.1, Number(it.teamCap) || Number(config.defaultTeamCap) || 1);
      return {
        item: it, effort, cap, remaining: effort, earliest,
        pre: engIdx < 0 ? 0 : sum(it, stages.slice(0, engIdx)),
        post: engIdx < 0 ? 0 : sum(it, stages.slice(engIdx + 1)),
        started: false, startWk: null, readyAt: Infinity, engStart: null, engEnd: null, finish: null,
      };
    });

    if (engIdx < 0) {
      rows.forEach(r => { r.started = true; r.startWk = r.earliest; });
    } else if (pool > 0) {
      const eff = a => Math.max(0.3, 1 - overhead * Math.max(0, a - 1));
      for (let t = 0; t < 1000 && rows.some(r => r.finish === null); t++) {
        // Start work while under the WIP limit, in priority order.
        let inflight = rows.filter(r => r.started && (r.finish === null || r.finish > t)).length;
        for (const r of rows) {
          if (r.started || r.earliest > t || (wip && inflight >= wip)) continue;
          r.started = true; r.startWk = t; r.readyAt = t + r.pre; inflight++;
          if (r.effort <= 1e-9) { r.engStart = r.engEnd = r.readyAt; r.finish = r.engEnd + r.post; }
        }
        // Hand out the developer pool.
        let free = pool;
        for (const r of rows) {
          if (free <= 1e-9) break;
          if (!r.started || r.finish !== null || r.readyAt > t) continue;
          const alloc = Math.min(r.cap, free), prog = alloc * eff(alloc);
          if (r.engStart === null) r.engStart = t;
          if (r.remaining <= prog) {
            const frac = r.remaining / prog;
            r.engEnd = t + frac; r.finish = r.engEnd + r.post;
            free -= alloc * frac; r.remaining = 0;
          } else { r.remaining -= prog; free -= alloc; }
        }
      }
    }

    let overallEnd = 0;
    const out = rows.map(r => {
      const it = r.item, bars = [];
      const scheduled = r.started && (engIdx < 0 || r.engEnd !== null);
      let t = r.startWk ?? r.earliest;
      if (r.started && r.startWk > r.earliest) bars.push({ key: 'wait', stageId: null, name: 'Waiting for capacity to start', type: 'queue', start: r.earliest, end: r.startWk });
      stages.forEach((s, i) => {
        if (!r.started) return;
        if (i === engIdx) {
          if (!scheduled) return;
          if (r.engStart > t) bars.push({ key: 'queue', stageId: null, name: 'Waiting for developers', type: 'queue', start: t, end: r.engStart });
          if (r.engEnd > r.engStart) bars.push({ key: s.id, stageId: s.id, stageIdx: i, name: s.name, type: 'stage', start: r.engStart, end: r.engEnd });
          t = r.engEnd;
        } else if (engIdx < 0 || i < engIdx || scheduled) {
          const w = weeksFor(it, s);
          bars.push({ key: s.id, stageId: s.id, stageIdx: i, name: s.name, type: 'stage', start: t, end: t + w });
          t += w;
        }
      });
      if (scheduled) overallEnd = Math.max(overallEnd, t);
      const dec = b => ({ ...b, startDate: fmtDate(addWeeks(start, b.start)), endDate: fmtDate(addWeeks(start, b.end)) });
      return {
        id: it.id, name: it.name, complexity: it.complexity, effort: r.effort, teamCap: r.cap, scheduled,
        queueWeeks: r.engStart !== null ? r.engStart - r.readyAt : null,
        bars: bars.map(dec), end: scheduled ? t : null, endDate: scheduled ? fmtDate(addWeeks(start, t)) : null,
      };
    });

    return {
      startDate: config.startDate, rows: out, totalWeeks: overallEnd,
      endDate: fmtDate(addWeeks(start, overallEnd)),
      totalEffort: rows.reduce((s, r) => s + r.effort, 0),
      unscheduled: out.filter(r => !r.scheduled).length,
    };
  }

  /* ---------- Monte Carlo forecast ---------- */
  function mulberry32(a) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function gamma(k, rnd) { // Marsaglia-Tsang, k >= 1
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do {
        x = Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rnd();
      if (Math.log(u || 1e-12) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
    }
  }
  function samplePert(x, rnd) {
    const { min: o, effort: m, max: p } = x;
    if (!(p > o)) return m;
    const a = 1 + 4 * (m - o) / (p - o), b = 1 + 4 * (p - m) / (p - o);
    const ga = gamma(a, rnd), gb = gamma(b, rnd);
    return o + (ga / (ga + gb)) * (p - o);
  }
  const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

  function forecast(state, iterations = 300, seed = 42) {
    normalize(state);
    const rnd = mulberry32(seed), start = parseDate(state.config.startDate);
    const cx = Object.fromEntries(state.config.complexities.map(c => [c.key, c]));
    const totals = [], per = {};
    for (let i = 0; i < iterations; i++) {
      const efforts = {};
      state.items.forEach(it => { if (cx[it.complexity]) efforts[it.id] = samplePert(cx[it.complexity], rnd); });
      const r = schedule(state, { efforts });
      if (r.unscheduled) return null;
      totals.push(r.totalWeeks);
      r.rows.forEach(row => (per[row.id] = per[row.id] || []).push(row.end));
    }
    const d = w => fmtDate(addWeeks(start, w));
    const summary = p => { const w = pct(totals, p); return { weeks: w, date: d(w) }; };
    const rowsOut = {};
    for (const id in per) rowsOut[id] = { p50: pct(per[id], .5), p80: pct(per[id], .8), p80Date: d(pct(per[id], .8)) };
    return { p50: summary(.5), p80: summary(.8), p90: summary(.9), rows: rowsOut, iterations };
  }

  const api = { schedule, forecast, defaultState, normalize, pertMean, parseDate, fmtDate, addWeeks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scheduler = api;
})(typeof window !== 'undefined' ? window : globalThis);
