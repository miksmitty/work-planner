// Scheduling engine. Shared by the browser (script tag) and Node (require).
//
// Techniques used (all standard):
//   - Three-point (PERT) estimating: each complexity has best/likely/worst dev-weeks;
//     expected = (best + 4*likely + worst) / 6. Fixed stages are timeboxes.
//   - Resource-constrained scheduling: one shared developer pool, allocated week by week in
//     priority (list) order (serial schedule generation with a priority rule).
//   - Brooks' law: a use case with several developers loses `teamOverhead` of throughput per
//     extra developer, so effort (dev-weeks) and duration are not interchangeable.
//   - Reuse: a rating (and optional "builds on" link) reduces the effort of reuse-flagged stages (Build by default).
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

  const TRIAGE = 'triage';
  // SME REQUIRED by the use case: stretch applied to SME-dependent stages. Stage default lengths assume
  // little SME involvement (Low = no delay). Assumption, editable in the app.
  const DEFAULT_SME = () => ({ L: 1, M: 1.25, H: 1.6 });
  // REUSE of existing components/plumbing: multiplier on the effort of reuse-flagged stages (Build by default).
  // High = most of what is needed already exists. Assumption, editable in the app.
  const DEFAULT_REUSE = () => ({ H: 0.5, M: 0.7, L: 0.85 });
  const DEFAULT_STAGES = () => [
    { id: 'ideation', name: 'Ideation', weeks: 2, sme: true },
    { id: 'discovery', name: 'Discovery', weeks: 2, sme: true },
    { id: 'feasibility', name: 'Feasibility', weeks: 4, sme: true },
    { id: 'eng', name: 'Build', kind: 'eng', reuse: true },
    { id: 'release', name: 'Validate and Release', weeks: 3, sme: true },
    { id: 'operate', name: 'Operate', weeks: 2 },
  ];

  function defaultState() {
    // Sample portfolio spread across the pipeline: most advanced first, then priority.
    const stagePlan = ['eng', 'eng', 'release', 'operate', 'feasibility', 'feasibility', 'discovery', 'discovery',
      'ideation', 'ideation', 'ideation', 'ideation', TRIAGE, TRIAGE, TRIAGE, TRIAGE, TRIAGE];
    const items = [];
    for (let i = 1; i <= 17; i++) {
      items.push({
        id: 'uc' + i, name: 'AI use case ' + i,
        complexity: ['low', 'medium', 'medium', 'high', 'very high'][(i * 7) % 5],
        stage: stagePlan[i - 1], priority: i, stageStart: null, sme: ['H', 'M', 'L', 'M', 'H', null][i % 6],
        reuse: [null, 'M', 'H', null, 'L', 'H'][i % 6], buildsOn: i === 5 ? 'uc1' : i === 6 ? 'uc2' : i === 9 ? 'uc3' : null,
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
        smeFactors: DEFAULT_SME(),
        smeSemantics: 'required',
        reuseFactors: DEFAULT_REUSE(),
        stages: DEFAULT_STAGES(),
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
    if (!c.smeFactors) { c.smeFactors = DEFAULT_SME(); c.smeSemantics = 'required'; }
    if (c.smeSemantics !== 'required') {
      // Upgrade from the short-lived "SME availability" meaning (High = no delay) to "SME required"
      // (High = most delay), keeping every use case's effect unchanged.
      const flip = { H: 'L', M: 'M', L: 'H' };
      state.items.forEach(it => { if (flip[it.sme]) it.sme = flip[it.sme]; });
      c.smeFactors = { H: c.smeFactors.L, M: c.smeFactors.M, L: c.smeFactors.H };
      c.smeSemantics = 'required';
    }
    if (!c.reuseFactors) c.reuseFactors = DEFAULT_REUSE();
    c.stages.forEach(st => { if (st.reuse === undefined) st.reuse = st.kind === 'eng'; });
    c.stages.forEach(st => { if (st.sme === undefined) st.sme = ['ideation', 'discovery', 'feasibility', 'release'].includes(st.id); });
    c.complexities.forEach(x => {
      if (x.min == null) x.min = Math.round(x.effort * 0.7);
      if (x.max == null) x.max = Math.round(x.effort * 1.75);
    });
    const first = c.stages[0] && c.stages[0].id;
    state.items.forEach(it => {
      if (!it.overrides) it.overrides = {};
      if (it.stage !== TRIAGE && !c.stages.some(s => s.id === it.stage)) it.stage = first; // missing / removed stage
      if (it.priority === undefined || it.priority === '') it.priority = null;
      if (it.stageStart === undefined) it.stageStart = null;
      if (!['H', 'M', 'L'].includes(it.sme)) it.sme = null;
      if (!['H', 'M', 'L'].includes(it.reuse)) it.reuse = null;
      if (!it.buildsOn) it.buildsOn = null;
    });
    return state;
  }

  const pertMean = x => (x.min + 4 * x.effort + x.max) / 6;

  // Position in the pipeline: -1 = Stakeholder Triage (clock not started), 0.. = index of the current stage.
  function stageRank(state, it) {
    if (it.stage === TRIAGE) return -1;
    const i = state.config.stages.findIndex(s => s.id === it.stage);
    return i < 0 ? 0 : i;
  }
  const prioVal = it => (it.priority == null || it.priority === '' || isNaN(Number(it.priority))) ? Infinity : Number(it.priority);
  // Most advanced stage first, then priority (1 = highest), then original order.
  function orderItems(state) {
    return state.items.map((it, i) => ({ it, i, rank: stageRank(state, it), p: prioVal(it) }))
      .sort((a, b) => (b.rank - a.rank) || (a.p === b.p ? 0 : a.p < b.p ? -1 : 1) || (a.i - b.i))
      .map(x => x.it);
  }

  function schedule(state, opts = {}) {
    normalize(state);
    const { config } = state;
    const items = orderItems(state);
    const start = parseDate(config.startDate);
    const stages = config.stages;
    const engIdx = stages.findIndex(s => s.kind === 'eng');
    const cx = Object.fromEntries(config.complexities.map(c => [c.key, c]));
    const pool = Number(config.devResources) || 0;
    const overhead = Math.max(0, Number(config.teamOverhead) || 0);
    const wip = Number(config.wipLimit) || 0;
    // A use case that needs a lot of SME time (High) stretches SME-dependent stages. A blank rating has no effect,
    // and a per-use-case override is used exactly as entered.
    const smeF = it => (config.smeFactors && config.smeFactors[it.sme]) || 1;
    // Reuse of existing plumbing shortens reuse-flagged stages. A "builds on" link with no rating counts as Medium.
    // (On fixed stages the rating always applies; on the engineering stage a "builds on" link is timed, see below.)
    const reuseKey = it => it.reuse || (it.buildsOn ? 'M' : null);
    const reuseF = it => (config.reuseFactors && config.reuseFactors[reuseKey(it)]) || 1;
    const weeksFor = (it, s) => {
      const o = it.overrides && it.overrides[s.id];
      if (o != null && o !== '') return Math.max(0, Number(o) || 0);
      return Math.max(0, (Number(s.weeks) || 0) * (s.sme ? smeF(it) : 1) * (s.reuse ? reuseF(it) : 1));
    };

    const rows = items.map(it => {
      const cur = stageRank(state, it), triage = cur < 0;
      // Time already spent in the current stage before the plan starts.
      const since = it.stageStart ? (start - parseDate(it.stageStart)) / (7 * DAY) : 0;
      let earliest = it.earliestStart ? Math.max(0, Math.round((parseDate(it.earliestStart) - start) / (7 * DAY))) : 0;
      if (since < 0) earliest = Math.max(earliest, Math.round(-since));
      const elapsed = Math.max(0, since);
      const durOf = (s, i) => { const w = weeksFor(it, s); return i === cur && i !== engIdx ? Math.max(0, w - elapsed) : w; };
      const pastEng = engIdx >= 0 && cur > engIdx;
      const hasEng = engIdx >= 0 && !triage && !pastEng;
      const sumDur = (from, to) => { let a = 0; for (let i = from; i < to; i++) a += durOf(stages[i], i); return a; };
      let effort = 0, reuseOnEffort = 1;
      if (hasEng) {
        if (Number(it.effortOverride) > 0) effort = Number(it.effortOverride);
        else {
          const base = opts.efforts && opts.efforts[it.id] != null ? opts.efforts[it.id] : cx[it.complexity] ? pertMean(cx[it.complexity]) : 0;
          effort = base * (stages[engIdx].sme ? smeF(it) : 1);
          reuseOnEffort = stages[engIdx].reuse ? reuseF(it) : 1;
        }
      }
      const cap = Math.max(0.1, Number(it.teamCap) || Number(config.defaultTeamCap) || 1);
      return {
        item: it, cur, triage, durOf, pastEng, effort, effortBase: effort, reuseOnEffort, reuseApplied: false, dep: it.buildsOn || null,
        cap, remaining: effort, earliest,
        forced: !triage && (cur > 0 || !!it.stageStart),   // already under way: never held back by the WIP limit
        pre: hasEng ? sumDur(cur, engIdx) : 0,
        post: engIdx < 0 || triage ? 0 : sumDur(Math.max(cur, engIdx + 1), stages.length),
        started: false, startWk: null, readyAt: Infinity, engStart: null, engEnd: null, finish: null,
      };
    });
    const active = rows.filter(r => !r.triage);
    const rowById = Object.fromEntries(rows.map(r => [r.item.id, r]));

    if (engIdx < 0) {
      active.forEach(r => { r.started = true; r.startWk = r.earliest; });
    } else {
      const eff = a => Math.max(0.3, 1 - overhead * Math.max(0, a - 1));
      const begin = (r, t, inflight) => {
        r.started = true; r.startWk = t; r.readyAt = t + r.pre;
        if (r.effort <= 1e-9) { r.engStart = r.engEnd = r.readyAt; r.finish = r.engEnd + r.post; }
      };
      for (let t = 0; t < 1000 && active.some(r => r.finish === null); t++) {
        let inflight = active.filter(r => r.started && (r.finish === null || r.finish > t)).length;
        for (const r of active) if (!r.started && r.forced && r.earliest <= t) { begin(r, t); inflight++; }
        for (const r of active) {
          if (r.started || r.earliest > t || (wip && inflight >= wip)) continue;
          begin(r, t); inflight++;
        }
        let free = pool;
        for (const r of active) {
          if (free <= 1e-9) break;
          if (!r.started || r.finish !== null || r.readyAt > t) continue;
          const alloc = Math.min(r.cap, free), prog = alloc * eff(alloc);
          if (r.engStart === null) {
            r.engStart = t;
            // Reuse is realised when Build starts. If this use case builds on another, the saving only
            // applies once that use case's Build has finished (its plumbing then exists).
            if (r.reuseOnEffort !== 1) {
              const d = r.dep ? rowById[r.dep] : null;
              if (!r.dep || (d && d.engEnd !== null && d.engEnd <= t)) {
                r.reuseApplied = true; r.effort = r.effortBase * r.reuseOnEffort; r.remaining = r.effort;
              }
            }
          }
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
      const stageName = r.triage ? 'Stakeholder Triage' : (stages[r.cur] || {}).name || '';
      const base = { id: it.id, name: it.name, complexity: it.complexity, stage: it.stage, stageName, priority: it.priority, sme: it.sme, reuse: it.reuse, buildsOn: it.buildsOn, triage: r.triage };
      if (r.triage) return { ...base, effort: 0, teamCap: r.cap, scheduled: false, queueWeeks: null, bars: [], end: null, endDate: null };
      const scheduled = r.started && (engIdx < 0 || r.engEnd !== null);
      let t = r.startWk ?? r.earliest;
      if (r.started && r.startWk > r.earliest) bars.push({ key: 'wait', stageId: null, name: 'Waiting for capacity to start', type: 'queue', start: r.earliest, end: r.startWk });
      const push = (s, i, a, b) => { if (b > a) bars.push({ key: s.id, stageId: s.id, stageIdx: i, name: s.name, type: 'stage', start: a, end: b }); };
      if (r.started) for (let i = r.cur; i < stages.length; i++) {
        const s = stages[i];
        if (i === engIdx) {
          if (!scheduled) continue;
          if (r.engStart > t) bars.push({ key: 'queue', stageId: null, name: 'Waiting for developers', type: 'queue', start: t, end: r.engStart });
          push(s, i, r.engStart, r.engEnd);
          t = r.engEnd;
        } else if (engIdx < 0 || i < engIdx || scheduled) {
          const w = r.durOf(s, i);
          push(s, i, t, t + w);
          t += w;
        }
      }
      if (scheduled) overallEnd = Math.max(overallEnd, t);
      const dec = b => ({ ...b, startDate: fmtDate(addWeeks(start, b.start)), endDate: fmtDate(addWeeks(start, b.end)) });
      const first = bars.find(b => b.type === 'stage');
      return {
        ...base, effort: r.effort, effortBase: r.effortBase, reuseApplied: r.reuseApplied, reuseSaved: r.reuseApplied ? r.effortBase - r.effort : 0,
        reusePending: r.reuseOnEffort !== 1 && !r.reuseApplied && r.effortBase > 0 && (r.engStart === null || !!r.dep),
        teamCap: r.cap, scheduled,
        queueWeeks: r.engStart !== null && r.readyAt !== Infinity ? r.engStart - r.readyAt : null,
        bars: bars.map(dec), begin: first ? first.start : (r.startWk ?? r.earliest),
        end: scheduled ? t : null, endDate: scheduled ? fmtDate(addWeeks(start, t)) : null,
      };
    });

    return {
      startDate: config.startDate, rows: out, totalWeeks: overallEnd,
      endDate: fmtDate(addWeeks(start, overallEnd)),
      totalEffort: rows.reduce((s, r) => s + r.effort, 0),
      triage: out.filter(r => r.triage).length,
      unscheduled: out.filter(r => !r.triage && !r.scheduled).length,
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
      r.rows.forEach(row => { if (row.end != null) (per[row.id] = per[row.id] || []).push(row.end); });
    }
    const d = w => fmtDate(addWeeks(start, w));
    const summary = p => { const w = pct(totals, p); return { weeks: w, date: d(w) }; };
    const rowsOut = {};
    for (const id in per) rowsOut[id] = { p50: pct(per[id], .5), p80: pct(per[id], .8), p80Date: d(pct(per[id], .8)) };
    return { p50: summary(.5), p80: summary(.8), p90: summary(.9), rows: rowsOut, iterations };
  }

  const api = { schedule, forecast, defaultState, normalize, orderItems, stageRank, pertMean, parseDate, fmtDate, addWeeks, TRIAGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scheduler = api;
})(typeof window !== 'undefined' ? window : globalThis);
