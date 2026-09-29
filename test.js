const assert = require('assert');
const { schedule, forecast, defaultState, pertMean } = require('./public/scheduler.js');

// Deterministic baseline: no variance, no team overhead, no WIP limit.
function state(devs, items) {
  const s = defaultState();
  s.config.startDate = '2026-01-05';
  s.config.devResources = devs;
  s.config.defaultTeamCap = 2;
  s.config.teamOverhead = 0;
  s.config.wipLimit = 0;
  s.config.complexities.forEach(c => { c.min = c.max = c.effort; });
  s.items = items.map((c, i) => ({ id: 'x' + i, name: 'x' + i, complexity: c, teamCap: null, effortOverride: null, earliestStart: null, overrides: {} }));
  return s;
}
const eng = r => r.bars.find(b => b.key === 'eng');

// One low item (6 dev-weeks), team cap 2 => 3 weeks engineering; 2+4 pre, 2+1+2 post.
let r = schedule(state(4, ['low']));
assert.strictEqual(eng(r.rows[0]).start, 6);
assert.strictEqual(eng(r.rows[0]).end, 9);
assert.strictEqual(r.totalWeeks, 14);

// Two items, 2 devs: the second queues behind the first.
r = schedule(state(2, ['low', 'low']));
assert.strictEqual(eng(r.rows[1]).start, 9);
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
assert.strictEqual(eng(schedule(c).rows[0]).start, 2 + 3 + 4);
c.items[0].overrides = { sec: 1 };
assert.strictEqual(eng(schedule(c).rows[0]).start, 2 + 1 + 4);
c.config.stages = c.config.stages.filter(s => s.id !== 'eng');
assert.strictEqual(schedule(c).unscheduled, 0);

// PERT: expected = (min + 4*likely + max) / 6.
assert.strictEqual(pertMean({ min: 4, effort: 6, max: 10 }), (4 + 24 + 10) / 6);

// Brooks' law: team overhead lengthens engineering for multi-developer teams.
c = state(2, ['medium']);
const noOverhead = eng(schedule(c).rows[0]).end;
c.config.teamOverhead = 0.25;
assert.ok(eng(schedule(c).rows[0]).end > noOverhead);

// WIP limit staggers starts.
c = state(4, ['low', 'low', 'low', 'low']);
c.config.wipLimit = 2;
r = schedule(c);
assert.strictEqual(r.rows[0].bars[0].start, 0);
assert.ok(r.rows[3].bars[0].start > 0 || r.rows[3].bars[0].type === 'queue');
assert.ok(r.totalWeeks > schedule(state(4, ['low', 'low', 'low', 'low'])).totalWeeks);

// Monte Carlo: ordered percentiles, reproducible, and P50 close to the planned finish.
const d = defaultState();
const f = forecast(d), f2 = forecast(d);
assert.ok(f.p50.weeks <= f.p80.weeks && f.p80.weeks <= f.p90.weeks);
assert.deepStrictEqual(f.p80, f2.p80);
assert.ok(Math.abs(f.p50.weeks - schedule(d).totalWeeks) / schedule(d).totalWeeks < 0.15);

// Defaults schedule fully; zero devs schedules nothing.
assert.strictEqual(schedule(defaultState()).unscheduled, 0);
assert.strictEqual(schedule(state(0, ['low'])).unscheduled, 1);

// Old saved shape is migrated.
const old = defaultState();
old.config.preStages = [{ key: 'd', name: 'D', weeks: 2 }]; old.config.postStages = [{ key: 'p', name: 'P', weeks: 1 }];
delete old.config.stages;
assert.strictEqual(schedule(old).unscheduled, 0);
console.log('all tests passed');
