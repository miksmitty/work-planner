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
//   - Dependencies: a use case can depend (finish-to-start) on others, optionally until a given stage completes.
//     With `fromBuild`, the dependent skips the stages before Build and starts at Build once that predecessor is done.
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
  const OOS = 'oos';   // out of scope: kept in the list, never scheduled
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
    // Sample portfolio: a forward plan, so every use case starts at Ideation.
    const stagePlan = Array(17).fill('ideation');
    const items = [];
    for (let i = 1; i <= 17; i++) {
      items.push({
        id: 'uc' + i, name: 'AI use case ' + i,
        complexity: ['low', 'medium', 'medium', 'high', 'very high'][(i * 7) % 5],
        stage: stagePlan[i - 1], priority: i, stageStart: null, sme: ['H', 'M', 'L', 'M', 'H', null][i % 6],
        reuse: [null, 'M', 'H', null, 'L', 'H'][i % 6], buildsOn: i === 5 ? 'uc1' : i === 6 ? 'uc2' : i === 9 ? 'uc3' : null,
        dependsOn: i === 10 ? [{ id: 'uc2', until: 'eng' }] : i === 12 ? [{ id: 'uc7', until: null }] : [],
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
        triageWeeks: 4,
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
    if (c.triageWeeks == null) c.triageWeeks = 4;
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
    // Heal stage lists damaged by earlier edits: unique ids, a name on every stage, at most one engineering stage.
    { const seen = new Set(); let eng = false;
      c.stages.forEach((st, i) => {
        if (!st.id || seen.has(st.id)) st.id = 's' + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 5);
        seen.add(st.id);
        if (!String(st.name || '').trim()) st.name = 'Stage ' + (i + 1);
        if (st.kind === 'eng') { if (eng) { delete st.kind; if (st.weeks == null) st.weeks = 2; } eng = true; }
        else if (st.weeks == null || isNaN(Number(st.weeks))) st.weeks = 2;
      }); }
    const first = c.stages[0] && c.stages[0].id;
    state.items.forEach(it => {
      if (!it.overrides) it.overrides = {};
      if (it.stage !== TRIAGE && it.stage !== OOS && !c.stages.some(s => s.id === it.stage)) it.stage = first; // missing / removed stage
      if (typeof it.comments !== 'string') it.comments = '';
      if (it.priority === undefined || it.priority === '') it.priority = null;
      if (it.stageStart === undefined) it.stageStart = null;
      if (typeof it.dueDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(it.dueDate)) it.dueDate = null;   // required-by date
      if (it.triageWeeks === undefined || it.triageWeeks === '') it.triageWeeks = null;
      if (!['H', 'M', 'L'].includes(it.sme)) it.sme = null;
      if (!['H', 'M', 'L'].includes(it.reuse)) it.reuse = null;
      if (!it.buildsOn) it.buildsOn = null;
      // dependsOn: [{ id, until }] - finish-to-start; `until` = a stage id the predecessor must complete (null = its finish); `fromBuild` = start at Build afterwards
      Object.keys(it.overrides).forEach(k => { if (!c.stages.some(x => x.id === k)) delete it.overrides[k]; });
      it.dependsOn = (Array.isArray(it.dependsOn) ? it.dependsOn : []).filter(d => d && d.id).map(d => ({ id: d.id, until: d.until && c.stages.some(x => x.id === d.until) ? d.until : null, fromBuild: !!d.fromBuild, holdBuild: !!d.holdBuild }));
    });
    return state;
  }

  const pertMean = x => (x.min + 4 * x.effort + x.max) / 6;

  // Position in the pipeline: -1 = Stakeholder Triage (clock not started), 0.. = index of the current stage.
  function stageRank(state, it) {
    if (it.stage === TRIAGE) return -1;
    if (it.stage === OOS) return -2;   // sorts after everything else
    const i = state.config.stages.findIndex(s => s.id === it.stage);
    return i < 0 ? 0 : i;
  }
  const prioVal = it => (it.priority == null || it.priority === '' || isNaN(Number(it.priority))) ? Infinity : Number(it.priority);
  // Work already under way goes first (most advanced stage, then priority). Everything not yet started
  // (Stakeholder Triage or an unstarted first stage) is ordered purely by priority (1 = highest), then original order,
  // so raising a priority moves it ahead of lower-priority work whatever its stage.
  const underWay = (state, it) => { const r = stageRank(state, it); return r > 0 || (r === 0 && !!it.stageStart); };
  function orderItems(state) {
    return state.items.map((it, i) => ({ it, i, rank: stageRank(state, it), uw: underWay(state, it), p: prioVal(it) }))
      .sort((a, b) => (b.uw - a.uw) || (a.uw ? (b.rank - a.rank) : 0) || (a.p === b.p ? 0 : a.p < b.p ? -1 : 1) || (a.i - b.i))
      .map(x => x.it);
  }

  function schedule(state, opts = {}) {
    normalize(state);
    const { config } = state;
    const allItems = orderItems(state);
    const items = allItems.filter(it => it.stage !== OOS);
    const oosItems = allItems.filter(it => it.stage === OOS);
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
      const rank = stageRank(state, it), triage = rank < 0, cur = triage ? 0 : rank;   // triage is projected as entering stage 1 once triage ends
      // Time already spent in the current stage before the plan starts.
      const since = it.stageStart && !triage ? (start - parseDate(it.stageStart)) / (7 * DAY) : 0;
      let earliest = it.earliestStart ? Math.max(0, Math.round((parseDate(it.earliestStart) - start) / (7 * DAY))) : 0;
      if (since < 0) earliest = Math.max(earliest, Math.round(-since));
      // Stakeholder Triage: the clock has not started, but we still predict the timeline by assuming triage
      // takes an estimated number of weeks (per use case, else the default) before work begins.
      const triageW = triage ? Math.max(0, Math.ceil(Number(it.triageWeeks != null ? it.triageWeeks : config.triageWeeks) || 0)) : 0;
      if (triage) earliest = Math.max(earliest, triageW);
      const elapsed = Math.max(0, since);
      const durOf = (s, i) => { const w = weeksFor(it, s); return i === cur && i !== engIdx ? Math.max(0, w - elapsed) : w; };
      const pastEng = engIdx >= 0 && cur > engIdx;
      const hasEng = engIdx >= 0 && !pastEng;
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
        item: it, cur, triage, triageW, durOf, pastEng, effort, effortBase: effort, reuseOnEffort, reuseApplied: false, dep: it.buildsOn || null,
        cap, remaining: effort, earliest,
        deps: (it.dependsOn || []).filter(d => d.id !== it.id), depCycle: false, depAt: 0,
        forced: !triage && (cur > 0 || !!it.stageStart),   // already under way: never held back by the WIP limit
        pre: hasEng ? sumDur(cur, engIdx) : 0,
        post: engIdx < 0 ? 0 : sumDur(Math.max(cur, engIdx + 1), stages.length),
        started: false, startWk: null, readyAt: Infinity, engStart: null, engEnd: null, finish: null,
      };
    });
    const active = rows;   // triage rows are predicted too (they enter after their triage period, behind everything else)
    const rowById = Object.fromEntries(rows.map(r => [r.item.id, r]));
    // Dependencies (finish-to-start). A link to a missing use case is ignored; circular links are ignored and flagged.
    rows.forEach(r => { r.deps = r.deps.filter(d => rowById[d.id]); });
    rows.forEach(r => {
      const seen = new Set(), stack = r.deps.map(d => d.id);
      while (stack.length) { const id = stack.pop(); if (id === r.item.id) { r.depCycle = true; break; } if (seen.has(id)) continue; seen.add(id); rowById[id].deps.forEach(d => stack.push(d.id)); }
    });
    rows.forEach(r => { if (r.depCycle) r.deps = []; });
    // "Start at Build": once the predecessor is done, the dependent skips the stages before Build (it builds on what exists).
    rows.forEach(r => { r.skip = engIdx >= 0 && r.cur < engIdx && r.effort > 0 && r.deps.some(d => d.fromBuild); if (r.skip) r.pre = 0; });
    // When does row p finish stage k (in weeks)? null = not known yet.
    const stageEndOf = (p, k) => {
      if (p.cur > k) return 0;                 // already past that stage when the plan starts
      if (!p.started) return null;
      let t = p.startWk;
      for (let i = p.cur; i <= k; i++) {
        if (i === engIdx) { if (p.engEnd === null) return null; t = p.engEnd; } else t += p.durOf(stages[i], i);
      }
      return t;
    };
    const depEnd = d => { const k = d.until ? stages.findIndex(s => s.id === d.until) : stages.length - 1; return stageEndOf(rowById[d.id], k < 0 ? stages.length - 1 : k); };
    // `holdBuild` dependencies don't delay the start: the early stages run at once and only Build waits.
    rows.forEach(r => { r.holds = r.deps.some(d => d.holdBuild); });
    const metAt = (list, t) => list.every(d => { const e = depEnd(d); return e !== null && e <= t + 1e-9; });
    const depsMet = (r, t) => metAt(r.deps.filter(d => !d.holdBuild), t);
    const buildMet = (r, t) => metAt(r.forced ? r.deps : r.deps.filter(d => d.holdBuild), t);

    if (engIdx < 0) {
      active.forEach(r => { r.started = true; r.startWk = r.earliest; });
    } else {
      const eff = a => Math.max(0.3, 1 - overhead * Math.max(0, a - 1));
      const begin = (r, t, inflight) => {
        r.started = true; r.startWk = t; r.readyAt = t + r.pre;
        r.depAt = r.deps.reduce((m, d) => Math.max(m, depEnd(d) || 0), 0);
        r.startDepAt = r.deps.filter(d => !d.holdBuild).reduce((m, d) => Math.max(m, depEnd(d) || 0), 0);
        if (r.effort <= 1e-9) { r.engStart = r.engEnd = r.readyAt; r.finish = r.engEnd + r.post; }
      };
      for (let t = 0; t < 1000 && active.some(r => r.finish === null); t++) {
        let inflight = active.filter(r => r.started && (r.finish === null || r.finish > t)).length;
        for (const r of active) if (!r.started && r.forced && r.earliest <= t) { begin(r, t); inflight++; }
        for (const r of active) {
          if (r.started || r.earliest > t || !depsMet(r, t) || (wip && inflight >= wip)) continue;
          begin(r, t); inflight++;
        }
        let free = pool;
        for (const r of active) {
          if (free <= 1e-9) break;
          if (!r.started || r.finish !== null || r.readyAt > t) continue;
          // Already under way (so not held at the start): its Build waits until its dependencies are met.
          if (r.engStart === null && !buildMet(r, t)) continue;
          const alloc = Math.min(r.cap, free), prog = alloc * eff(alloc);
          if (r.engStart === null) {
            r.engStart = t;
            if (r.forced || r.holds) r.depAt = r.deps.reduce((m, d) => Math.max(m, depEnd(d) || 0), 0);
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

    // The dependency that is holding a use case back the longest (shown on its "Waiting for a dependency" bar).
    const crit = list => {
      let best = null, bt = -1;
      list.forEach(d => { const e = depEnd(d) || 0; if (e >= bt) { bt = e; best = d; } });
      return best ? { id: best.id, name: rowById[best.id].item.name, until: best.until || null, at: bt } : null;
    };
    let overallEnd = 0;
    const out = rows.map(r => {
      const it = r.item, bars = [];
      const stageName = r.triage ? 'Stakeholder Triage' : (stages[r.cur] || {}).name || '';
      const base = { triageWeeks: r.triageW, id: it.id, name: it.name, complexity: it.complexity, stage: it.stage, stageName, priority: it.priority, sme: it.sme, reuse: it.reuse, buildsOn: it.buildsOn, triage: r.triage };
      const scheduled = r.started && (engIdx < 0 || r.engEnd !== null);
      let t = r.startWk ?? r.earliest;
      if (r.triage && r.triageW > 0) bars.push({ key: 'triage', stageId: null, name: 'Stakeholder Triage (estimated)', type: 'triage', start: 0, end: r.triageW });
      const waitFrom = r.triage ? r.triageW : r.earliest;
      if (r.started && r.startWk > waitFrom + 1e-9) {
        const depTo = Math.min(r.startWk, r.startDepAt ?? r.depAt);   // part of the wait that is a dependency, then any wait for capacity
        if (depTo > waitFrom + 1e-9) bars.push({ key: 'depwait', stageId: null, name: 'Waiting for a dependency', type: 'queue', start: waitFrom, end: depTo, blocker: crit(r.deps.filter(d => !d.holdBuild)) });
        const from = Math.max(waitFrom, depTo);
        if (r.startWk > from + 1e-9) bars.push({ key: 'wait', stageId: null, name: 'Waiting for capacity to start', type: 'queue', start: from, end: r.startWk });
      }
      const push = (s, i, a, b) => { if (b > a) bars.push({ key: s.id, stageId: s.id, stageIdx: i, name: s.name, type: 'stage', start: a, end: b }); };
      if (r.started) for (let i = r.cur; i < stages.length; i++) {
        const s = stages[i];
        if (r.skip && i < engIdx) continue;   // stages before Build are skipped
        if (i === engIdx) {
          if (!scheduled) continue;
          if (r.engStart > t) {
            const depTo = (r.forced || r.holds) ? Math.min(r.engStart, Math.max(t, r.depAt)) : t;   // part of the wait that is a dependency
            if (depTo > t + 1e-9) bars.push({ key: 'depwait', stageId: null, name: 'Waiting for a dependency', type: 'queue', start: t, end: depTo, blocker: crit(r.forced ? r.deps : r.deps.filter(d => d.holdBuild)) });
            if (r.engStart > depTo + 1e-9) bars.push({ key: 'queue', stageId: null, name: 'Waiting for developers', type: 'queue', start: depTo, end: r.engStart });
          }
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
        bars: bars.map(dec), begin: first ? first.start : (r.startWk ?? r.earliest), depIssue: r.depCycle ? 'circular' : null, skipsToBuild: !!r.skip,
        stageEnd: Object.fromEntries(bars.filter(b => b.type === 'stage').map(b => [b.stageId, b.end])),
        end: scheduled ? t : null, endDate: scheduled ? fmtDate(addWeeks(start, t)) : null,
      };
    });

    // Arrows for the Gantt: predecessor's completion point -> successor's start.
    const outById = Object.fromEntries(out.map(o => [o.id, o]));
    const links = [];
    rows.forEach(r => r.deps.forEach(d => {
      const from = outById[d.id], to = outById[r.item.id];
      if (!from || !to || !from.scheduled || !to.scheduled) return;
      const at = d.until && from.stageEnd[d.until] != null ? from.stageEnd[d.until] : (d.until ? from.begin : from.end);
      links.push({ from: d.id, to: r.item.id, at, toStart: to.begin });
    }));
    // Out-of-scope use cases stay in the list (greyed, no bars) but take no part in the plan.
    oosItems.forEach(it => out.push({ id: it.id, name: it.name, complexity: it.complexity, stage: it.stage, stageName: 'Out of scope', priority: it.priority, sme: it.sme, reuse: it.reuse, buildsOn: it.buildsOn,
      oos: true, triage: false, effort: 0, effortBase: 0, scheduled: false, teamCap: null, queueWeeks: null, bars: [], begin: 0, depIssue: null, skipsToBuild: false, stageEnd: {}, end: null, endDate: null, reuseApplied: false, reuseSaved: 0, reusePending: false }));
    return {
      links,
      startDate: config.startDate, rows: out, totalWeeks: overallEnd,
      endDate: fmtDate(addWeeks(start, overallEnd)),
      totalEffort: rows.reduce((s, r) => s + r.effort, 0),
      triage: out.filter(r => r.triage).length,
      unscheduled: out.filter(r => !r.scheduled && !r.oos).length,
      oos: oosItems.length,
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

  // Required-by status from ISO dates: after (planned finish after the date), tight (planned finish meets it but the 80% date does not), ok, none (no forecast).
  function dueStatus(due, planned, p80) {
    if (!due) return null;
    if (!planned) return { kind: 'none', days: null, p80Days: null };
    const days = Math.round((Date.parse(due) - Date.parse(planned)) / 86400000), p80Days = p80 ? Math.round((Date.parse(due) - Date.parse(p80)) / 86400000) : null;
    return { kind: days < 0 ? 'after' : (p80Days != null && p80Days < 0 ? 'tight' : 'ok'), days, p80Days };
  }

  const api = { dueStatus, schedule, forecast, defaultState, normalize, orderItems, stageRank, pertMean, parseDate, fmtDate, addWeeks, TRIAGE, OOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scheduler = api;
})(typeof window !== 'undefined' ? window : globalThis);
