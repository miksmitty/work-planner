const assert = require('assert');
const { schedule, forecast, defaultState, pertMean, orderItems, TRIAGE } = require('./public/scheduler.js');

// Deterministic baseline: no variance, no team overhead, no WIP limit. Default stages:
// Ideation 2, Discovery 2, Feasibility 4, Build (engineering), Validate and Release 3, Operate 2.
const PRE = 2 + 2 + 4, POST = 3 + 2;
function state(devs, items) {
  const s = defaultState();
  s.config.startDate = '2026-01-05';
  s.config.devResources = devs;
  s.config.defaultTeamCap = 2;
  s.config.teamOverhead = 0;
  s.config.wipLimit = 0;
  s.config.complexities.forEach(c => { c.min = c.max = c.effort; });
  s.items = items.map((c, i) => ({ id: 'x' + i, name: 'x' + i, complexity: c, stage: 'ideation', priority: i + 1, stageStart: null, sme: null, sme: null,
    teamCap: null, effortOverride: null, earliestStart: null, overrides: {} }));
  return s;
}
const eng = r => r.bars.find(b => b.key === 'eng');
const row = (r, id) => r.rows.find(x => x.id === id);

// One low item (6 dev-weeks), team cap 2 => 3 weeks of Build.
let r = schedule(state(4, ['low']));
assert.strictEqual(eng(r.rows[0]).start, PRE);
assert.strictEqual(eng(r.rows[0]).end, PRE + 3);
assert.strictEqual(r.totalWeeks, PRE + 3 + POST);

// Two items, 2 devs: the second queues behind the first.
r = schedule(state(2, ['low', 'low']));
assert.strictEqual(eng(r.rows[1]).start, PRE + 3);
assert.ok(r.rows[1].bars.some(b => b.type === 'queue'));

// More developers never lengthens the plan.
const items = ['low', 'medium', 'high', 'very high', 'medium', 'low', 'high'];
let prev = Infinity;
for (const d of [1, 2, 3, 4, 6, 8, 12]) {
  const w = schedule(state(d, items)).totalWeeks;
  assert.ok(w <= prev + 1e-9, `devs=${d} took ${w} > ${prev}`);
  prev = w;
}

// Configurable stages.
let c = state(4, ['low']);
c.config.stages.splice(1, 0, { id: 'sec', name: 'Security review', weeks: 3 });
assert.strictEqual(eng(schedule(c).rows[0]).start, PRE + 3);
c.items[0].overrides = { sec: 1 };
assert.strictEqual(eng(schedule(c).rows[0]).start, PRE + 1);
c.config.stages = c.config.stages.filter(s => s.id !== 'eng');
assert.strictEqual(schedule(c).unscheduled, 0);

// PERT: expected = (min + 4*likely + max) / 6.
assert.strictEqual(pertMean({ min: 4, effort: 6, max: 10 }), (4 + 24 + 10) / 6);

// Brooks' law: team overhead lengthens engineering for multi-developer teams.
c = state(2, ['medium']);
const noOverhead = eng(schedule(c).rows[0]).end;
c.config.teamOverhead = 0.25;
assert.ok(eng(schedule(c).rows[0]).end > noOverhead);

// WIP limit staggers items still at the first stage.
c = state(4, ['low', 'low', 'low', 'low']);
c.config.wipLimit = 2;
r = schedule(c);
assert.ok(r.rows[3].bars[0].type === 'queue' || r.rows[3].bars[0].start > 0);
assert.ok(r.totalWeeks > schedule(state(4, ['low', 'low', 'low', 'low'])).totalWeeks);

/* ---- stages, triage, ordering ---- */
// Stakeholder Triage: clock not started - no bars, not counted, not "unscheduled".
c = state(4, ['low', 'low']);
c.items[1].stage = TRIAGE;
r = schedule(c);
assert.strictEqual(r.triage, 1);
assert.strictEqual(r.unscheduled, 0);
assert.strictEqual(row(r, 'x1').bars.length, 0);
assert.strictEqual(row(r, 'x1').end, null);
assert.strictEqual(r.totalWeeks, schedule(state(4, ['low'])).totalWeeks);

// Current stage: earlier stages are skipped, so the item finishes sooner.
c = state(4, ['low']);
const fromIdeation = schedule(c).totalWeeks;
c.items[0].stage = 'feasibility';
r = schedule(c);
assert.deepStrictEqual(r.rows[0].bars.filter(b => b.type === 'stage').map(b => b.key), ['feasibility', 'eng', 'release', 'operate']);
assert.strictEqual(eng(r.rows[0]).start, 4);
assert.ok(r.totalWeeks < fromIdeation);

// Already in Build: engineering starts immediately; past Build: no engineering at all.
c.items[0].stage = 'eng';
assert.strictEqual(eng(schedule(c).rows[0]).start, 0);
c.items[0].stage = 'release';
r = schedule(c);
assert.ok(!eng(r.rows[0]));
assert.strictEqual(r.totalWeeks, 3 + 2);

// "In stage since" reduces the time left in a fixed stage.
c.items[0].stage = 'feasibility';
c.items[0].stageStart = '2025-12-22'; // 2 weeks before the plan starts
assert.strictEqual(eng(schedule(c).rows[0]).start, 4 - 2);

// Sort order: most advanced stage first, then priority (1 = highest); triage last.
c = state(4, ['low', 'low', 'low', 'low', 'low']);
c.items[0].stage = 'ideation';  c.items[0].priority = 1;
c.items[1].stage = 'eng';       c.items[1].priority = 9;
c.items[2].stage = 'ideation';  c.items[2].priority = 2;
c.items[3].stage = TRIAGE;      c.items[3].priority = 1;
c.items[4].stage = 'eng';       c.items[4].priority = 3;
assert.deepStrictEqual(orderItems(c).map(i => i.id), ['x4', 'x1', 'x0', 'x2', 'x3']);
assert.deepStrictEqual(schedule(c).rows.map(x => x.id), ['x4', 'x1', 'x0', 'x2', 'x3']);
c.items[2].priority = null; // no priority sorts after numbered ones
assert.deepStrictEqual(orderItems(c).map(i => i.id).slice(2, 4), ['x0', 'x2']);

// Developers go to the more advanced use case first, even with a worse priority number.
c = state(2, ['high', 'high']);
c.items[0].stage = 'ideation'; c.items[0].priority = 1;
c.items[1].stage = 'eng';      c.items[1].priority = 5;
r = schedule(c);
assert.strictEqual(eng(row(r, 'x1')).start, 0);
assert.ok(eng(row(r, 'x0')).start > eng(row(r, 'x1')).start);

// Items already under way ignore the WIP limit (but still count towards it).
c = state(4, ['low', 'low', 'low']);
c.config.wipLimit = 1;
c.items[0].stage = 'eng'; c.items[1].stage = 'eng';
r = schedule(c);
assert.strictEqual(eng(row(r, 'x0')).start, 0);
assert.strictEqual(eng(row(r, 'x1')).start, 0);
assert.ok(row(r, 'x2').bars[0].type === 'queue'); // ideation-stage item has to wait for a slot

/* ---- SME availability ---- */
// Factors: H 1.0, M 1.25, L 1.6 on SME-dependent stages (ideation, discovery, feasibility, release).
c = state(4, ['low']);
const smeTotal = () => schedule(c).rows[0].bars.filter(b => b.type === 'stage' && b.key !== 'eng').reduce((a, b) => a + (b.end - b.start), 0);
const neutral = smeTotal();
assert.strictEqual(neutral, 2 + 2 + 4 + 3 + 2);                       // blank = no effect
c.items[0].sme = 'H'; assert.strictEqual(smeTotal(), neutral);         // High = no delay
c.items[0].sme = 'L';
assert.ok(Math.abs(smeTotal() - ((2 + 2 + 4 + 3) * 1.6 + 2)) < 1e-9);  // Operate is not SME-dependent
assert.strictEqual(eng(schedule(c).rows[0]).end - eng(schedule(c).rows[0]).start, 3); // Build unaffected by default
// Explicit override is used as entered.
c.items[0].overrides = { discovery: 2 };
assert.ok(Math.abs(smeTotal() - ((2 + 4 + 3) * 1.6 + 2 + 2)) < 1e-9);
// Flag Build as SME-dependent: effort scales too (6 dev-weeks x 1.6, team of 2 => 4.8 weeks).
c.config.stages.find(s => s.id === 'eng').sme = true;
assert.ok(Math.abs((eng(schedule(c).rows[0]).end - eng(schedule(c).rows[0]).start) - 4.8) < 1e-9);
c.items[0].effortOverride = 6;                                          // ...unless the effort is set explicitly
assert.strictEqual(eng(schedule(c).rows[0]).end - eng(schedule(c).rows[0]).start, 3);
// Lower availability never shortens the plan.
let last = 0;
for (const a of ['H', 'M', 'L']) { c = state(4, ['low', 'medium']); c.items.forEach(i => i.sme = a); const w = schedule(c).totalWeeks; assert.ok(w >= last); last = w; }
// Old data without smeFactors / flags is migrated.
const nosme = defaultState(); delete nosme.config.smeFactors; nosme.config.stages.forEach(s => delete s.sme);
schedule(nosme);
assert.deepStrictEqual(nosme.config.smeFactors, { H: 1, M: 1.25, L: 1.6 });
assert.ok(nosme.config.stages.find(s => s.id === 'discovery').sme && !nosme.config.stages.find(s => s.id === 'eng').sme);

// Monte Carlo: ordered percentiles, reproducible, ignores triage rows.
const d = defaultState();
const f = forecast(d), f2 = forecast(d);
assert.ok(f && f.p50.weeks <= f.p80.weeks && f.p80.weeks <= f.p90.weeks);
assert.deepStrictEqual(f.p80, f2.p80);
assert.ok(Math.abs(f.p50.weeks - schedule(d).totalWeeks) / schedule(d).totalWeeks < 0.2);

// Defaults schedule fully; zero devs leaves engineering work unscheduled.
assert.strictEqual(schedule(defaultState()).unscheduled, 0);
assert.strictEqual(schedule(state(0, ['low'])).unscheduled, 1);

// Old saved shapes are migrated (stage list and missing item fields).
const old = defaultState();
old.config.preStages = [{ key: 'd', name: 'D', weeks: 2 }]; old.config.postStages = [{ key: 'p', name: 'P', weeks: 1 }];
delete old.config.stages;
old.items.forEach(i => { delete i.stage; delete i.priority; });
assert.strictEqual(schedule(old).unscheduled, 0);
assert.ok(old.items.every(i => i.stage === 'd'));
console.log('all tests passed');
