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
  s.items = items.map((c, i) => ({ id: 'x' + i, name: 'x' + i, complexity: c, stage: 'ideation', priority: i + 1, stageStart: null, sme: null, reuse: null, buildsOn: null, dependsOn: [], sme: null,
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
// Stakeholder Triage: the clock has not started, but the timeline is still predicted. The use case enters
// the first stage after an estimated triage period (default 4 weeks), with a tentative 'triage' bar first.
c = state(4, ['low', 'low']);
c.items[1].stage = TRIAGE;
r = schedule(c);
assert.strictEqual(r.triage, 1);
assert.strictEqual(r.unscheduled, 0);
const tri = row(r, 'x1');
assert.strictEqual(tri.bars[0].type, 'triage');
assert.strictEqual(tri.bars[0].end, 4);
assert.strictEqual(tri.bars.find(b => b.key === 'ideation').start, 4);     // work starts when triage ends
assert.ok(eng(tri) && tri.end != null);                                     // full predicted timeline
assert.ok(tri.end > row(r, 'x0').end);                                      // triage is behind started work
c.items[1].triageWeeks = 7; assert.strictEqual(row(schedule(c), 'x1').bars.find(b => b.key === 'ideation').start, 7);
c.items[1].triageWeeks = null; c.config.triageWeeks = 2; assert.strictEqual(row(schedule(c), 'x1').bars.find(b => b.key === 'ideation').start, 2);
c.config.triageWeeks = 0; assert.strictEqual(row(schedule(c), 'x1').bars.some(b => b.type === 'triage'), false);
// Triage never takes developers or WIP slots from work already under way.
c = state(2, ['high', 'high']); c.items[0].stage = 'eng'; c.items[1].stage = TRIAGE; c.config.wipLimit = 1;
assert.strictEqual(eng(row(schedule(c), 'x0')).start, 0);

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

// Sort order: work under way first (most advanced stage, then priority); unstarted work (incl. triage) purely by priority (1 = highest).
c = state(4, ['low', 'low', 'low', 'low', 'low']);
c.items[0].stage = 'ideation';  c.items[0].priority = 1;
c.items[1].stage = 'eng';       c.items[1].priority = 9;
c.items[2].stage = 'ideation';  c.items[2].priority = 2;
c.items[3].stage = TRIAGE;      c.items[3].priority = 1;
c.items[4].stage = 'eng';       c.items[4].priority = 3;
assert.deepStrictEqual(orderItems(c).map(i => i.id), ['x4', 'x1', 'x0', 'x3', 'x2']);
assert.deepStrictEqual(schedule(c).rows.map(x => x.id), ['x4', 'x1', 'x0', 'x3', 'x2']);   // triage P1 ties with x0 and keeps original order, ahead of P2
c.items[2].priority = null; // no priority sorts after numbered ones
assert.deepStrictEqual(orderItems(c).map(i => i.id).slice(2, 4), ['x0', 'x3']);

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

/* ---- SME required ---- */
// Factors: Low 1.0, Medium 1.25, High 1.6 on SME-dependent stages (ideation, discovery, feasibility, release).
c = state(4, ['low']);
const smeTotal = () => schedule(c).rows[0].bars.filter(b => b.type === 'stage' && b.key !== 'eng').reduce((a, b) => a + (b.end - b.start), 0);
const neutral = smeTotal();
assert.strictEqual(neutral, 2 + 2 + 4 + 3 + 2);                       // blank = no effect
c.items[0].sme = 'L'; assert.strictEqual(smeTotal(), neutral);         // needs little SME time = no delay
c.items[0].sme = 'H';
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
// A higher SME requirement never shortens the plan.
let last = 0;
for (const a of ['L', 'M', 'H']) { c = state(4, ['low', 'medium']); c.items.forEach(i => i.sme = a); const w = schedule(c).totalWeeks; assert.ok(w >= last); last = w; }
// Data without factors gets the defaults; the earlier "availability" data is flipped, effect unchanged.
const nosme = defaultState(); delete nosme.config.smeFactors; delete nosme.config.smeSemantics; nosme.config.stages.forEach(s => delete s.sme);
schedule(nosme);
assert.deepStrictEqual(nosme.config.smeFactors, { L: 1, M: 1.25, H: 1.6 });
assert.ok(nosme.config.stages.find(s => s.id === 'discovery').sme && !nosme.config.stages.find(s => s.id === 'eng').sme);
const avail = state(4, ['low']);                                        // as saved by the availability version
avail.config.smeFactors = { H: 1, M: 1.25, L: 1.6 }; delete avail.config.smeSemantics;
avail.items[0].sme = 'L';                                               // Low availability = 60% delay
const mig1 = schedule(avail).totalWeeks;
assert.strictEqual(avail.items[0].sme, 'H');                            // ...is now High requirement
assert.deepStrictEqual(avail.config.smeFactors, { L: 1, M: 1.25, H: 1.6 });
assert.strictEqual(schedule(avail).totalWeeks, mig1);                   // migrating twice changes nothing
// 1.6 x (2+2+4) = 12.8 weeks before Build; Build starts on a whole week (13), then 3 + 4.8 + 2.
assert.ok(Math.abs(mig1 - (13 + 3 + 3 * 1.6 + 2)) < 1e-9);

/* ---- reuse of existing plumbing ---- */
// Factors on Build effort: High x0.5, Medium x0.7, Low x0.85. 'low' = 6 dev-weeks, team cap 2, no overhead.
const buildWeeks = (st, id = 'x0') => { const b = eng(row(schedule(st), id)); return b ? +(b.end - b.start).toFixed(6) : 0; };
c = state(4, ['low']);
assert.strictEqual(buildWeeks(c), 3);                                    // no rating = no reuse
c.items[0].reuse = 'H'; assert.strictEqual(buildWeeks(c), 1.5);          // 6 x 0.5 = 3 dev-weeks / 2
c.items[0].reuse = 'M'; assert.strictEqual(buildWeeks(c), +(6 * 0.7 / 2).toFixed(6));
c.items[0].reuse = 'L'; assert.strictEqual(buildWeeks(c), +(6 * 0.85 / 2).toFixed(6));
assert.ok(schedule(c).rows[0].reuseApplied && Math.abs(schedule(c).rows[0].reuseSaved - 0.9) < 1e-9);
c.items[0].effortOverride = 6; assert.strictEqual(buildWeeks(c), 3);     // explicit effort is used as entered
c.items[0].effortOverride = null;
c.config.stages.find(s => s.id === 'eng').reuse = false; assert.strictEqual(buildWeeks(c), 3);   // stage not flagged
c.config.stages.find(s => s.id === 'eng').reuse = true;
c.config.stages.find(s => s.id === 'discovery').reuse = true;             // fixed stages can be flagged too
c.items[0].reuse = 'H';
assert.strictEqual(eng(schedule(c).rows[0]).start, 2 + 1 + 4);            // discovery 2 -> 1
// "Builds on": the saving only applies once the source use case's Build has finished.
c = state(4, ['low', 'low']);
c.items[0].stage = 'eng'; c.items[0].priority = 1;                        // source, already in Build (3 weeks)
c.items[1].buildsOn = 'x0'; c.items[1].reuse = 'H'; c.items[1].stage = 'eng'; // starts Build at once: source not done
r = schedule(c);
assert.ok(!row(r, 'x1').reuseApplied && row(r, 'x1').reusePending);
assert.strictEqual(buildWeeks(c, 'x1'), 3);                               // no benefit yet
c.items[1].stage = 'feasibility';                                          // Build starts at week 4 > source done at 3
r = schedule(c);
assert.ok(row(r, 'x1').reuseApplied);
assert.strictEqual(buildWeeks(c, 'x1'), 1.5);
c.items[0].stage = 'release';                                              // source already past Build
c.items[1].stage = 'eng';
assert.strictEqual(buildWeeks(c, 'x1'), 1.5);
c.items[0].stage = TRIAGE;                                                 // source not in the plan: never delivered
assert.strictEqual(buildWeeks(c, 'x1'), 3);
c.items[0].stage = 'ideation'; c.items[0].buildsOn = 'x1'; c.items[1].buildsOn = 'x0'; // circular link: no benefit, no hang
assert.strictEqual(buildWeeks(c, 'x1'), 3);
// A link with no rating counts as Medium.
c = state(4, ['low', 'low']); c.items[0].stage = 'release'; c.items[1].stage = 'eng'; c.items[1].buildsOn = 'x0';
assert.strictEqual(buildWeeks(c, 'x1'), +(6 * 0.7 / 2).toFixed(6));
// More reuse never lengthens the plan.
last = Infinity;
for (const a of [null, 'L', 'M', 'H']) { c = state(4, ['medium', 'high']); c.items.forEach(i => i.reuse = a); const w = schedule(c).totalWeeks; assert.ok(w <= last); last = w; }
// Old data gets factors and flags.
const noreuse = defaultState(); delete noreuse.config.reuseFactors; noreuse.config.stages.forEach(s => delete s.reuse); noreuse.items.forEach(i => { delete i.reuse; delete i.buildsOn; });
schedule(noreuse);
assert.deepStrictEqual(noreuse.config.reuseFactors, { H: 0.5, M: 0.7, L: 0.85 });
assert.ok(noreuse.config.stages.find(s => s.id === 'eng').reuse && !noreuse.config.stages.find(s => s.id === 'discovery').reuse);

/* ---- dependencies (finish-to-start) ---- */
const startOf = (r, id) => { const x = row(r, id); const b = x.bars.find(b => b.type === 'stage'); return b ? b.start : null; };
c = state(8, ['low', 'low']); c.config.wipLimit = 0;
r = schedule(c);
assert.strictEqual(startOf(r, 'x1'), 0);                                    // independent: both start together
c.items[1].dependsOn = [{ id: 'x0', until: null }];
r = schedule(c);
assert.ok(Math.abs(startOf(r, 'x1') - Math.ceil(row(r, 'x0').end)) < 1e-9);  // starts after x0 fully finishes
assert.ok(row(r, 'x1').bars.some(b => b.key === 'depwait'));
assert.strictEqual(r.links.length, 1);
assert.strictEqual(r.links[0].from, 'x0'); assert.strictEqual(r.links[0].to, 'x1');
// ...or after just one stage completes (Build): starts earlier than waiting for the whole finish
c.items[1].dependsOn = [{ id: 'x0', until: 'eng' }];
const afterBuild = startOf(schedule(c), 'x1');
assert.ok(afterBuild < startOf(r, 'x1') && afterBuild >= eng(row(schedule(c), 'x0')).end);
c.items[1].dependsOn = [{ id: 'x0', until: 'discovery' }];
assert.ok(startOf(schedule(c), 'x1') >= 4 && startOf(schedule(c), 'x1') < afterBuild);   // ideation 2 + discovery 2
// Several predecessors: waits for the slowest
c = state(8, ['low', 'high', 'low']); c.config.wipLimit = 0;
c.items[2].dependsOn = [{ id: 'x0', until: null }, { id: 'x1', until: null }];
r = schedule(c);
assert.ok(startOf(r, 'x2') >= Math.max(row(r, 'x0').end, row(r, 'x1').end) - 1e-9);
// Already-in-flight predecessor beyond the stage: dependency met immediately
c = state(8, ['low', 'low']); c.items[0].stage = 'operate'; c.items[0].stageStart = '2025-12-01';   // finished before the plan starts
c.items[1].dependsOn = [{ id: 'x0', until: null }];
assert.strictEqual(startOf(schedule(c), 'x1'), 0);
// A use case already under way keeps running its current stage; its Build waits for the dependency.
c = state(8, ['low', 'low']); c.config.wipLimit = 0;
c.items[1].stage = 'feasibility'; c.items[1].dependsOn = [{ id: 'x0', until: null }];
r = schedule(c);
assert.strictEqual(startOf(r, 'x1'), 0);                                           // Feasibility runs straight away
assert.ok(eng(row(r, 'x1')).start >= row(r, 'x0').end - 1e-9);                     // Build waits for x0 to finish
assert.ok(row(r, 'x1').bars.some(b => b.key === 'depwait'));
// Circular dependencies are ignored and flagged (no hang)
c = state(8, ['low', 'low']); c.items[0].dependsOn = [{ id: 'x1', until: null }]; c.items[1].dependsOn = [{ id: 'x0', until: null }];
r = schedule(c);
assert.strictEqual(r.unscheduled, 0); assert.strictEqual(row(r, 'x0').depIssue, 'circular'); assert.strictEqual(startOf(r, 'x0'), 0);
// Missing predecessor / self link ignored; a triage predecessor is predicted, so the successor waits for it
c = state(8, ['low', 'low']); c.items[0].dependsOn = [{ id: 'nope', until: null }, { id: 'x0', until: null }];
assert.strictEqual(startOf(schedule(c), 'x0'), 0);
c = state(8, ['low', 'low']); c.items[0].stage = TRIAGE; c.items[1].dependsOn = [{ id: 'x0', until: null }];
r = schedule(c); assert.ok(startOf(r, 'x1') >= row(r, 'x0').end - 1e-9 && r.unscheduled === 0);
// A dependency never shortens the plan
c = state(8, ['low', 'low']); const free = schedule(c).totalWeeks; c.items[1].dependsOn = [{ id: 'x0', until: null }]; assert.ok(schedule(c).totalWeeks >= free);
// "Start at Build": skips the stages before Build once the predecessor is done
c = state(8, ['low', 'low']); c.items[1].dependsOn = [{ id: 'x0', until: null }];
const scratch = schedule(c); const skipC = state(8, ['low', 'low']); skipC.items[1].dependsOn = [{ id: 'x0', until: null, fromBuild: true }];
const sk = schedule(skipC);
assert.ok(row(sk, 'x1').skipsToBuild && !row(scratch, 'x1').skipsToBuild);
assert.strictEqual(startOf(sk, 'x1'), row(scratch, 'x1').begin);
assert.ok(!row(sk, 'x1').bars.some(b => b.type === 'stage' && ['ideation', 'discovery', 'feasibility'].includes(b.stageId)));
assert.ok(row(sk, 'x1').end < row(scratch, 'x1').end);
assert.ok(row(sk, 'x1').bars.some(b => b.stageId === 'eng'));
// Old data without dependsOn is fine
const nodep = defaultState(); nodep.items.forEach(i => delete i.dependsOn); schedule(nodep); assert.ok(nodep.items.every(i => Array.isArray(i.dependsOn)));

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
