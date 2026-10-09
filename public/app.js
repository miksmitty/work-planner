const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmt = d => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd}-${MON[+m - 1]}-${y}`; }; // dd-mmm-yyyy
// Accepts dd-mmm-yyyy, d/m/yyyy, d.m.yyyy or yyyy-mm-dd. Returns ISO yyyy-mm-dd, '' for blank, null if invalid.
function parseDateText(t) {
  t = String(t || '').trim(); if (!t) return '';
  let y, m, d, x;
  if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = t.match(/^(\d{1,2})[-\/ .]+([A-Za-z]{3,9})[-\/ .,]+(\d{2,4})$/))) { d = +x[1]; m = MON.findIndex(n => n.toLowerCase() === x[2].slice(0, 3).toLowerCase()) + 1; y = +x[3]; }
  else if ((x = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/))) { d = +x[1]; m = +x[2]; y = +x[3]; }
  else return null;
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (!m || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Scheduler.fmtDate(dt);
}
// Text input showing dd-mmm-yyyy; calls onValue(iso|'') when the text parses, reverts otherwise.
function bindDate(el, get, onValue) {
  el.value = get() ? fmt(get()) : '';
  el.onchange = () => {
    const iso = parseDateText(el.value);
    if (iso === null) { el.classList.add('bad'); setTimeout(() => el.classList.remove('bad'), 900); el.value = get() ? fmt(get()) : ''; return; }
    onValue(iso); el.value = iso ? fmt(iso) : '';
  };
}
const wk = n => Math.round(n * 10) / 10;
const num = v => v === '' || v == null ? null : Number(v);
const color = i => `var(--s${i % 8})`;
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
let state, plan, fc, saveTimer, noSave = false;
const open = new Set(); // use case ids with details expanded

// Relative URLs (no leading slash) so the app also works behind a proxy or under a sub-path.
async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('json')) {
    throw new Error(`GET ${path} returned ${res.status} ${type || '(no content type)'} - expected the planner's JSON API. Is the request being redirected or blocked by a proxy?`);
  }
  return res.json();
}
async function init() {
  window.__appStarted = true;
  try {
    state = Scheduler.normalize(await getJSON('api/state'));
  } catch (e) {
    // Never leave the page dead: report why, then run on built-in data so the UI still works.
    if (window.__diag) window.__diag('Could not load saved data: ' + e.message + '\nRunning with built-in sample data; changes may not be saved.');
    state = Scheduler.normalize(Scheduler.defaultState());
    noSave = true; // never overwrite the real saved plan with fallback data
  }
  bind(); renderStages(); renderSizes(); renderSme(); renderReuse(); renderRows(); update();
}
function bind() {
  const c = () => state.config;
  $('#devs').oninput = e => { c().devResources = Number(e.target.value); update(); };
  $('#cap').oninput = e => { c().defaultTeamCap = Number(e.target.value); update(); };
  $('#wip').oninput = e => { c().wipLimit = Number(e.target.value) || 0; update(); };
  $('#ovh').oninput = e => { c().teamOverhead = (Number(e.target.value) || 0) / 100; update(); };
  bindDate($('#start'), () => c().startDate, iso => { if (iso) { c().startDate = iso; update(); } });
  $('#spbase').oninput = e => { c().spLinkBase = e.target.value.trim() || undefined; renderRows(); update(); };
  document.querySelectorAll('.capbar .setting').forEach(el => { const h = el.querySelector('.hint'); if (h) el.title = h.textContent.trim(); });
  const g = $('#gantt');
  g.addEventListener('click', e => {
    const c = e.target.closest && e.target.closest('[data-cmt]'); if (c) return editComment(c);
    const gf = e.target.closest && e.target.closest('[data-gfilter]');
    if (gf) { const k = gf.dataset.gfilter; if (fpop && fpop.dataset.k === 'g' + k) return closeFilter(); return openGanttFilter(k, gf.getBoundingClientRect()), fpop.dataset.k = 'g' + k; }
    const h = e.target.closest && e.target.closest('[data-gsort]'); if (!h) return;
    const k = h.dataset.gsort;
    if (gsort.key !== k) { gsort.key = k; gsort.dir = 1; } else if (gsort.dir === 1) gsort.dir = -1; else gsort.key = null;
    update();
  });
  g.addEventListener('mousedown', e => {
    const hd = e.target.closest('[data-resize]'); if (!hd) return;
    e.preventDefault();
    const key = hd.dataset.resize, x0 = e.clientX, w0 = COLW[key]; let raf = 0;
    const mv = ev => { COLW[key] = Math.min(COL_MAX, Math.max(COL_MIN, Math.round(w0 + ev.clientX - x0))); cancelAnimationFrame(raf); raf = requestAnimationFrame(renderGantt); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); saveColW(); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
  g.addEventListener('dblclick', e => {   // fit the column to its widest content
    const hd = e.target.closest('[data-resize]'); if (!hd) return;
    const key = hd.dataset.resize, k = cols().findIndex(c => c[0] === key);
    const longest = Math.max(cols()[k][2].length * 1.1, ...leftRows(true).map(r => String(r.vals[k]).length));
    COLW[key] = Math.min(COL_MAX, Math.max(COL_MIN, Math.round(longest * 6.3 + 16))); saveColW(); renderGantt();
  });
  bindGrid(g);
  $('#zoom').oninput = () => { $('#fit').checked = false; lsSet('fit', '0'); renderGantt(); };
  if (lsGet('fitReset') !== '1') { lsSet('fit', '1'); lsSet('fitReset', '1'); }   // earlier zoom shortcuts could leave Fit to width switched off
  const fitBtn = $('#fit');   // a toggle button; `checked` keeps the rest of the code unchanged
  Object.defineProperty(fitBtn, 'checked', { get: () => fitBtn.classList.contains('on'), set: v => { fitBtn.classList.toggle('on', !!v); fitBtn.setAttribute('aria-pressed', String(!!v)); } });
  fitBtn.checked = lsGet('fit') !== '0';
  fitBtn.onclick = () => { fitBtn.checked = true; lsSet('fit', '1'); renderGantt(); };
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  showTab(lsGet('tab') || 'timeline');
  window.addEventListener('resize', () => { if (activeTab === 'timeline') renderGantt(); });
  try { if (localStorage.getItem('todayLine') === '0') $('#today').checked = false; } catch {}
  $('#today').onchange = () => { try { localStorage.setItem('todayLine', $('#today').checked ? '1' : '0'); } catch {} renderGantt(); };
  $('#png').onclick = downloadPNG;
  $('#analysis').onclick = exportAnalysis;
  $('#resetcols').onclick = () => { COLW = { ...DEF_COLW }; saveColW(); renderGantt(); };
  $('#gclear').onclick = () => { Object.keys(gfilter).forEach(k => delete gfilter[k]); update(); };
  $('#setupexport').onclick = exportSetup;
  $('#setupimport').onclick = importSetup;
  $('#add').onclick = () => { state.items.push(newItem('New use case')); renderRows(); update(); };
  $('#import').onclick = openImport;
  $('#export').onclick = downloadCSV;
  // Take over Ctrl/Cmd +/-/0 and Ctrl/Cmd+wheel (pinch) so zoom is one consistent level across all tabs
  document.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); stepZoom(e.deltaY < 0 ? 0.05 : -0.05); } }, { passive: false });
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); stepZoom(0.1); }
    else if (e.key === '-') { e.preventDefault(); stepZoom(-0.1); }
    else if (e.key === '0') { e.preventDefault(); stepZoom(0, true); }
  });
  $('#bulk').onclick = () => {
    const t = prompt('One use case name per line:'); if (!t) return;
    t.split('\n').map(s => s.trim()).filter(Boolean).forEach(n => state.items.push(newItem(n)));
    renderRows(); update();
  };
  $('#reset').onclick = async () => {
    if (!confirm('Replace everything with the sample data?')) return;
    state = Scheduler.normalize(await getJSON('api/seed')); syncInputs(); renderStages(); renderSizes(); renderSme(); renderReuse(); renderRows(); update();
  };
  document.querySelectorAll('.capbar input[data-nudge]').forEach(inp => {
    const wrap = document.createElement('span'); wrap.className = 'step';
    inp.before(wrap);
    const mk = (t, dir, tip) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.title = tip; b.onclick = () => nudge(inp, dir); return b; };
    wrap.append(mk('−', -1, 'Decrease'), inp, mk('+', 1, 'Increase'));
  });
  syncInputs();
}
// Inline picker over a Gantt cell: stage or complexity.
// Popover to edit a use case's dependencies from the Gantt: tick predecessors, choose "until when" for each.
function pickDeps(rect) {
  document.querySelectorAll('.cxpick').forEach(x => { x.onblur = null; if (x.parentNode) x.parentNode.removeChild(x); });
  const it = state.items.find(x => x.id === rect.dataset.id); if (!it) return;
  const box = $('.gleft'), br = box.getBoundingClientRect(), rr = rect.getBoundingClientRect(), zf = Number(document.body.style.zoom) || 1;
  const others = Scheduler.orderItems(state).filter(o => o.id !== it.id);
  const cur = Object.fromEntries((it.dependsOn || []).map(d => [d.id, d.until || '']));
  const curHb = Object.fromEntries((it.dependsOn || []).map(d => [d.id, !!d.holdBuild]));
  const curFb = Object.fromEntries((it.dependsOn || []).map(d => [d.id, !!d.fromBuild]));
  const snap = JSON.stringify(state.items);
  const stageOpts = sel => `<option value="">finishes</option>` + state.config.stages.map((s, i) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>completes ${i + 1}. ${esc(s.name)}</option>`).join('');
  const pop = document.createElement('div'); pop.className = 'cxpick deppop';
  pop.style.left = Math.max(8, Math.min(rr.left, innerWidth - 736 * zf)) / zf + 'px'; pop.style.top = Math.max(8, Math.min(rr.bottom + 2, innerHeight - 560 * zf)) / zf + 'px';
  pop.innerHTML = `<div class="dp-head"><b>Depends on</b> · ${esc(it.name)}<span class="grow"></span><button class="ghost dp-x" title="Discard changes (Esc)">Cancel</button><button class="primary dp-ok">Done</button></div>
    <div class="hint" style="margin:2px 0 8px">Tick the use cases that must finish (or reach a stage) before this one can start. <b>Only Build waits</b> lets its earlier stages (Ideation, Discovery…) run straight away and holds just Build until the predecessor is done. <b>Start at Build</b> instead skips those earlier stages.</div>
    <input type="text" class="dp-filter" placeholder="Filter use cases…">
    <div class="dp-list">${others.map(o => `<label class="dp-row${o.id in cur ? ' on' : ''}" data-name="${esc((o.spId || '') + ' ' + o.name).toLowerCase()}"><input type="checkbox" data-id="${esc(o.id)}" ${o.id in cur ? 'checked' : ''}><span class="dp-name">${esc((o.spId ? o.spId + ' · ' : '') + o.name)}</span><span class="dp-opts"><select data-until="${esc(o.id)}" ${o.id in cur ? '' : 'disabled'}>${stageOpts(cur[o.id])}</select><label class="dp-fb" title="Once this predecessor is done, skip the stages before Build and start at Build instead of from scratch"><input type="checkbox" data-fb="${esc(o.id)}" ${curFb[o.id] ? 'checked' : ''} ${o.id in cur ? '' : 'disabled'}>start at Build</label><label class="dp-fb" title="The earlier stages (before Build) start straight away; only Build waits until this predecessor is done"><input type="checkbox" data-hb="${esc(o.id)}" ${curHb[o.id] ? 'checked' : ''} ${o.id in cur ? '' : 'disabled'}>only Build waits</label></span></label>`).join('') || '<div class="hint">No other use cases yet.</div>'}</div>`;
  document.body.appendChild(pop);
  let closed = false;
  const close = save => {
    if (closed) return; closed = true; document.removeEventListener('mousedown', away, true);
    if (pop.parentNode) pop.parentNode.removeChild(pop);
    if (save) {
      const next = [...pop.querySelectorAll('input[data-id]:checked')].map(c => ({ id: c.dataset.id, until: pop.querySelector(`select[data-until="${CSS.escape(c.dataset.id)}"]`).value || null, fromBuild: pop.querySelector(`input[data-fb="${CSS.escape(c.dataset.id)}"]`).checked, holdBuild: pop.querySelector(`input[data-hb="${CSS.escape(c.dataset.id)}"]`).checked }));
      if (JSON.stringify(next) !== JSON.stringify(it.dependsOn || [])) { undoStack.push(snap); it.dependsOn = next; renderRows(); update(); gmsg(`Dependencies updated (${next.length})`); }
    }
    $('#gantt').focus({ preventScroll: true });
  };
  const away = e => { if (!e.composedPath().includes(pop)) close(true); };
  setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  pop.addEventListener('change', e => { const c = e.target; if (!c.dataset.id) return; pop.querySelector(`select[data-until="${CSS.escape(c.dataset.id)}"]`).disabled = !c.checked; pop.querySelector(`input[data-fb="${CSS.escape(c.dataset.id)}"]`).disabled = pop.querySelector(`input[data-hb="${CSS.escape(c.dataset.id)}"]`).disabled = !c.checked; c.closest('.dp-row').classList.toggle('on', c.checked); });
  pop.querySelector('.dp-filter').addEventListener('input', e => { const q = e.target.value.trim().toLowerCase(); pop.querySelectorAll('.dp-row').forEach(r => { r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'; }); });
  pop.querySelector('.dp-ok').onclick = () => close(true); pop.querySelector('.dp-x').onclick = () => close(false);
  pop.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } else if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); close(true); } });
  pop.querySelector('.dp-filter').focus();
}
function editComment(rect) {
  document.querySelectorAll('.cxpick').forEach(x => { x.onblur = null; if (x.parentNode) x.parentNode.removeChild(x); });
  const it = state.items.find(x => x.id === rect.dataset.id); if (!it) return;
  const box = $('.gleft'), br = box.getBoundingClientRect(), rr = rect.getBoundingClientRect(), zf = Number(document.body.style.zoom) || 1;
  const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'cxpick'; inp.value = it.comments || '';
  inp.style.cssText = `left:${(rr.left - br.left) / zf}px;top:${(rr.top - br.top) / zf}px;width:${Math.max(rr.width, 320) / zf}px;height:${rr.height / zf}px`;
  let done = false;
  const finish = save => { if (done) return; done = true; inp.onblur = null; const v = inp.value.trim();
    if (inp.parentNode) inp.parentNode.removeChild(inp);
    if (save && v !== (it.comments || '')) { pushUndo(); it.comments = v; renderRows(); update(); }
    $('#gantt').focus({ preventScroll: true }); };
  inp.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation(); };
  inp.onblur = () => finish(true);
  box.appendChild(inp); inp.focus(); inp.select();
}
function pickField(rect) {
  document.querySelectorAll('.cxpick').forEach(x => { x.onblur = null; if (x.parentNode) x.parentNode.removeChild(x); });
  const it = state.items.find(x => x.id === rect.dataset.id), kind = rect.dataset.pick; if (!it) return;
  if (kind === 'dep') return pickDeps(rect);
  const box = $('.gleft'), br = box.getBoundingClientRect(), rr = rect.getBoundingClientRect(), zf = Number(document.body.style.zoom) || 1;
  if (kind === 'pri') {   // priority is a number, so use an input rather than a list
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = 1; inp.step = 1; inp.className = 'cxpick'; inp.value = it.priority ?? '';
    inp.style.cssText = `left:${(rr.left - br.left) / zf}px;top:${(rr.top - br.top) / zf}px;width:${rr.width / zf}px;height:${rr.height / zf}px`;
    let done = false;
    const finish = save => { if (done) return; done = true; inp.onblur = null; const v = num(inp.value);
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (save && v !== it.priority) { pushUndo(); it.priority = v; renderRows(); update(); }
      $('#gantt').focus({ preventScroll: true }); };
    inp.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation(); };
    inp.onblur = () => finish(true);
    box.appendChild(inp); inp.focus(); inp.select(); return;
  }
  const sel = document.createElement('select'); sel.className = 'cxpick';
  sel.style.cssText = `left:${(rr.left - br.left) / zf}px;top:${(rr.top - br.top) / zf}px;width:${rr.width / zf}px;height:${rr.height / zf}px`;
  sel.innerHTML = kind === 'stage' ? stageOptions(it.stage) : kind === 'sme' ? smeOptions(it.sme) : kind === 'reuse' ? reuseOptions(it.reuse)
    : state.config.complexities.map(c => `<option value="${c.key}" ${c.key === it.complexity ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  // close() is safe to call more than once: removing a focused select fires blur, which calls it again.
  let closed = false;
  const close = () => { if (closed) return; closed = true; sel.onblur = null; if (sel.parentNode) sel.parentNode.removeChild(sel); };
  sel.onchange = () => { pushUndo(); if (kind === 'stage') it.stage = sel.value; else if (kind === 'sme') it.sme = sel.value || null; else if (kind === 'reuse') it.reuse = sel.value || null; else it.complexity = sel.value; close(); renderRows(); update(); $('#gantt').focus({ preventScroll: true }); };
  sel.onblur = close;
  sel.onkeydown = e => { if (e.key === 'Escape') { close(); $('#gantt').focus({ preventScroll: true }); } };
  box.appendChild(sel); sel.focus(); try { sel.showPicker(); } catch {}
}
function nudge(inp, dir) {
  const n = Number(inp.dataset.nudge);
  if (inp.id === 'start') {
    inp.value = fmt(Scheduler.fmtDate(Scheduler.addWeeks(Scheduler.parseDate(state.config.startDate), dir * n / 7)));
    inp.dispatchEvent(new Event('change'));
    return;
  } else {
    const min = inp.min !== '' ? Number(inp.min) : 0, max = inp.max !== '' ? Number(inp.max) : Infinity;
    inp.value = Math.min(max, Math.max(min, Math.round(((Number(inp.value) || 0) + dir * n) * 100) / 100));
  }
  inp.dispatchEvent(new Event('input'));
}
function syncInputs() {
  const c = state.config;
  $('#devs').value = c.devResources; $('#cap').value = c.defaultTeamCap; $('#wip').value = c.wipLimit || ''; $('#ovh').value = Math.round((c.teamOverhead || 0) * 100); $('#start').value = fmt(c.startDate); $('#spbase').value = c.spLinkBase || '';
}
const TRIAGE = Scheduler.TRIAGE, OOS = Scheduler.OOS;
// "0. Stakeholder Triage" = clock not started; then the configured stages in order.
const SME_LABEL = { H: 'High', M: 'Medium', L: 'Low' };
const smeOptions = sel => `<option value="" ${!sel ? 'selected' : ''}>–</option>` + ['H', 'M', 'L'].map(k => `<option value="${k}" ${k === sel ? 'selected' : ''}>${SME_LABEL[k]}</option>`).join('');
const reuseOptions = sel => `<option value="" ${!sel ? 'selected' : ''}>–</option>` + ['H', 'M', 'L'].map(k => `<option value="${k}" ${k === sel ? 'selected' : ''}>${SME_LABEL[k]}</option>`).join('');
const stageOptions = sel => `<option value="${TRIAGE}" ${sel === TRIAGE ? 'selected' : ''}>0. Stakeholder Triage</option>` +
  state.config.stages.map((s, i) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${i + 1}. ${esc(s.name)}</option>`).join('') +
  `<option value="${OOS}" ${sel === OOS ? 'selected' : ''}>Out of scope</option>`;
const newItem = name => ({ id: uid('uc'), name, complexity: state.config.complexities[1]?.key || state.config.complexities[0].key,
  stage: state.config.stages[0]?.id, priority: null, stageStart: null, sme: null, reuse: null, buildsOn: null, dependsOn: [], teamCap: null, effortOverride: null, earliestStart: null, comments: '', overrides: {} });

/* ---- stages: one ordered list of editable chips ---- */
function renderStages() {
  const st = state.config.stages, box = $('#stages'); box.innerHTML = '';
  { const el = document.createElement('div'); el.className = 'chip triage'; el.style.setProperty('--c', '#8a94a3');
    el.title = "Stakeholder Triage: back-and-forth with the submitter before approval. The delivery clock hasn't started, but the plan still predicts the use case by assuming triage takes this many weeks, then work begins.";
    el.innerHTML = `<span class="stagenum">0</span><span class="tname">Stakeholder Triage</span><input type="number" min="0" step="1" value="${state.config.triageWeeks ?? 4}" aria-label="Estimated triage weeks"><span class="muted">wk est.</span>`;
    el.querySelector('input').oninput = e => { state.config.triageWeeks = Math.max(0, Number(e.target.value) || 0); update(); };
    box.appendChild(el); box.insertAdjacentHTML('beforeend', '<span class="arrow">→</span>'); }
  st.forEach((s, i) => {
    const eng = s.kind === 'eng';
    const el = document.createElement('div'); el.className = 'chip' + (eng ? ' eng' : ''); el.style.setProperty('--c', color(i));
    el.innerHTML = `<span class="stagenum">${i + 1}</span><input type="text" value="${esc(s.name)}" aria-label="Stage name"><span class="tags"></span>
      ${eng ? `<span class="by" title="Set by complexity and developers">by complexity</span>`
            : `<input type="number" min="0" step="1" value="${s.weeks ?? 0}" aria-label="Weeks"><span class="muted">wk</span>`}
      <span class="tools">
        <button data-a="sme">SME</button><button data-a="reuse">Reuse</button><button data-a="l" title="Move earlier">◀</button><button data-a="r" title="Move later">▶</button>
        ${eng ? '' : `<button data-a="eng" title="Make this the engineering stage (length driven by complexity &amp; developers)">⚙</button><button data-a="del" title="Remove stage">✕</button>`}
      </span>`;
    // SME / Reuse toggles update the chip in place: rebuilding it would drop the hover tray from under the pointer.
    const paint = () => {
      el.querySelector('.tags').innerHTML = (s.sme ? '<span class="smetag" title="This stage is stretched for use cases that need Medium or High SME involvement">SME</span>' : '') + (s.reuse ? '<span class="smetag reusetag" title="This stage is shortened by reuse of existing components">REUSE</span>' : '');
      el.querySelector('[data-a=sme]').title = (s.sme ? 'Stop' : 'Start') + ' stretching this stage by how much SME time the use case needs';
      el.querySelector('[data-a=reuse]').title = (s.reuse ? 'Stop' : 'Start') + ' shortening this stage by reuse of existing components';
      el.querySelector('[data-a=sme]').classList.toggle('on', !!s.sme); el.querySelector('[data-a=reuse]').classList.toggle('on', !!s.reuse);
    };
    paint();
    const [name, weeks] = el.querySelectorAll('input');   // number span is not an input
    name.oninput = () => { s.name = name.value; update(); };
    name.onchange = () => { if (!name.value.trim()) name.value = 'Stage ' + (i + 1); s.name = name.value.trim(); renderRows(); update(); };   // refresh stage pickers with the new name
    if (weeks) { weeks.oninput = () => { const w = Number(weeks.value); if (weeks.value !== '' && w >= 0) { s.weeks = w; update(); } };
      weeks.onchange = () => { if (weeks.value === '' || !(Number(weeks.value) >= 0)) weeks.value = s.weeks ?? 0; }; }
    el.querySelectorAll('[data-a]').forEach(b => b.onclick = ev => {
      const a = b.dataset.a;
      if (ev.detail) b.blur();   // mouse click: don't leave the tray pinned open by focus
      if (a === 'l' || a === 'r') { const k = i + (a === 'l' ? -1 : 1); if (k < 0 || k >= st.length) return;
        [st[i], st[k]] = [st[k], st[i]]; }   // use cases stay in their stage; only the order changes
      else if (a === 'del') {
        if (st.length < 2) return;
        st.splice(i, 1);
        state.items.forEach(it => (it.dependsOn || []).forEach(d => { if (d.until === s.id) d.until = null; }));
        const fallback = (st[Math.max(0, i - 1)] || {}).id;   // use cases in the removed stage move back one stage
        state.items.forEach(it => { if (it.stage === s.id) it.stage = fallback; if (it.overrides) delete it.overrides[s.id]; });
      }
      else if (a === 'sme' || a === 'reuse') { s[a] = !s[a]; paint(); update(); return; }
      else if (a === 'eng') { const old = st.find(x => x.kind === 'eng'); if (old) { delete old.kind; old.weeks = 2; } delete s.weeks; s.kind = 'eng'; }
      renderStages(); renderRows(); update();
    });
    box.appendChild(el);
    if (i < st.length - 1) box.insertAdjacentHTML('beforeend', '<span class="arrow">→</span>');
  });
  const add = document.createElement('button'); add.textContent = '+ Stage';
  add.onclick = () => { st.push({ id: uid('s'), name: 'New stage', weeks: 2 }); renderStages(); renderRows(); update(); };
  box.appendChild(add);
}
function renderSme() {
  const box = $('#smef'); box.innerHTML = '';
  ['H', 'M', 'L'].forEach(k => {
    const el = document.createElement('div'); el.className = 'chip';
    el.innerHTML = `<span>${SME_LABEL[k]}</span><span class="muted">×</span><input type="number" min="1" max="5" step="0.05" value="${state.config.smeFactors[k]}" aria-label="${SME_LABEL[k]} SME requirement factor">`;
    el.querySelector('input').oninput = e => { state.config.smeFactors[k] = Math.max(0.1, Number(e.target.value) || 1); update(); };
    box.appendChild(el);
  });
}
function renderReuse() {
  const box = $('#reusef'); box.innerHTML = '';
  ['H', 'M', 'L'].forEach(k => {
    const el = document.createElement('div'); el.className = 'chip';
    el.innerHTML = `<span>${SME_LABEL[k]}</span><span class="muted">×</span><input type="number" min="0.1" max="1" step="0.05" value="${state.config.reuseFactors[k]}" aria-label="${SME_LABEL[k]} reuse factor">`;
    el.querySelector('input').oninput = e => { state.config.reuseFactors[k] = Math.min(1, Math.max(0.1, Number(e.target.value) || 1)); update(); };
    box.appendChild(el);
  });
}
function renderSizes() {
  const box = $('#sizes'); box.innerHTML = '';
  state.config.complexities.forEach(x => {
    const el = document.createElement('div'); el.className = 'chip';
    const inp = k => `<input type="number" min="0" step="1" data-k="${k}" value="${x[k]}" aria-label="${esc(x.name)} ${k}">`;
    el.innerHTML = `<span>${esc(x.name)}</span>${inp('min')}${inp('effort')}${inp('max')}<span class="muted" data-e title="PERT expected"></span>`;
    const showExp = () => el.querySelector('[data-e]').textContent = '≈ ' + wk(Scheduler.pertMean(x));
    el.querySelectorAll('input').forEach(i => i.oninput = () => { x[i.dataset.k] = Number(i.value); showExp(); update(); });
    showExp(); box.appendChild(el);
  });
}

/* ---- use cases: simple row + optional details ---- */
const view = { key: null, dir: 1, filters: {} };   // Use cases table: sort column/direction; filters[col] = Set of allowed cell texts (absent = no filter)
function viewVal(it, rank, k) {   // { text: what the cell shows (filtered on), sort: comparable value }
  const r = plan && plan.allRows.find(x => x.id === it.id), lab = (list, key) => (list.find(c => c.key === key) || {}).name || key || '';
  const eng = r && r.bars.find(b => b.type === 'stage' && state.config.stages[b.stageIdx]?.kind === 'eng'), f = fc && fc.rows[it.id];
  const d = (date, pre) => ({ text: date ? (pre || '') + fmt(date) : '', sort: date ? new Date(date).getTime() : null });
  switch (k) {
    case 'num': return { text: String(rank), sort: rank };
    case 'id': return { text: it.spId || '', sort: it.spId || '' };
    case 'name': return { text: it.name || '', sort: it.name || '' };
    case 'stage': { const st = state.config.stages.find(s => s.id === it.stage); return { text: st ? st.name : String(it.stage || ''), sort: Math.max(0, state.config.stages.findIndex(s => s.id === it.stage)) }; }
    case 'priority': return { text: it.priority ?? '', sort: it.priority ?? null };
    case 'complexity': return { text: lab(state.config.complexities, it.complexity), sort: lab(state.config.complexities, it.complexity) };
    case 'sme': return { text: it.sme || '', sort: ['Low', 'Medium', 'High'].indexOf(it.sme) };
    case 'reuse': return { text: it.reuse || '', sort: ['Low', 'Medium', 'High'].indexOf(it.reuse) };
    case 'eng': return eng ? d(eng.startDate) : { text: '', sort: null };
    case 'end': return r ? d(r.endDate, r.triage ? '~' : '') : { text: '', sort: null };
    case 'p80': return f ? d(f.p80Date) : { text: '', sort: null };
    case 'comments': return { text: it.comments || '', sort: it.comments || '' };
  }
}
function viewItems() {
  let list = Scheduler.orderItems(state).map((it, i) => ({ it, rank: i + 1 }));
  const fs = Object.entries(view.filters);
  if (fs.length) list = list.filter(x => fs.every(([k, set]) => set.has(String(viewVal(x.it, x.rank, k).text))));
  if (view.key) list.sort((a, b) => {
    const x = viewVal(a.it, a.rank, view.key).sort, y = viewVal(b.it, b.rank, view.key).sort;
    if (x == null || x === '' ) return (y == null || y === '') ? 0 : 1;   // blanks always last
    if (y == null || y === '') return -1;
    return view.dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }));
  });
  return list;
}
document.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => {
  const k = th.dataset.sort;
  if (view.key !== k) { view.key = k; view.dir = 1; } else if (view.dir === 1) view.dir = -1; else view.key = null;
  renderRows();
});
// Excel-style column filter: a ▾ on each heading opens a searchable checklist of that column's values
let fpop = null;
function closeFilter() { if (fpop) { fpop.remove(); fpop = null; } }
// o = { rect, label, values: [every cell text], current: Set|undefined, sortDir: 1|-1|0 (active sort on this column), onSort(dir|0), onApply(Set|null) }
function openFilterPop(o) {
  closeFilter();
  const counts = new Map(); o.values.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  const vals = [...counts.keys()].sort((a, b) => !a ? 1 : !b ? -1 : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const chosen = new Set(o.current || vals);
  fpop = document.createElement('div'); fpop.className = 'fpop';
  fpop.innerHTML = `<button data-s="1">Sort A → Z</button><button data-s="-1">Sort Z → A</button><button data-s="0" ${o.sortDir ? '' : 'disabled'}>Clear sort</button><hr>
    <input type="search" class="fq" placeholder="Search ${esc(o.label)}"><label class="fall"><input type="checkbox" class="fa"> (Select all)</label><div class="flist"></div>
    <div class="fact"><button class="primary fok">OK</button><button class="fclr">Clear filter</button></div>`;
  const list = fpop.querySelector('.flist'), q = fpop.querySelector('.fq'), fa = fpop.querySelector('.fa');
  const shown = () => vals.filter(v => (v || '(Blanks)').toLowerCase().includes(q.value.trim().toLowerCase()));
  const sync = () => { const sh = shown(); fa.checked = sh.length > 0 && sh.every(v => chosen.has(v)); fa.indeterminate = !fa.checked && sh.some(v => chosen.has(v)); };
  const draw = () => {
    list.innerHTML = shown().map(v => `<label><input type="checkbox" data-v="${esc(v)}" ${chosen.has(v) ? 'checked' : ''}> ${esc(v || '(Blanks)')} <span class="muted">${counts.get(v)}</span></label>`).join('') || '<div class="muted">No matches</div>';
    sync();
  };
  q.oninput = draw;
  fa.onchange = () => { shown().forEach(v => fa.checked ? chosen.add(v) : chosen.delete(v)); draw(); };
  list.onchange = e => { const v = e.target.dataset.v; e.target.checked ? chosen.add(v) : chosen.delete(v); sync(); };
  fpop.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { closeFilter(); o.onSort(Number(b.dataset.s)); });
  fpop.querySelector('.fok').onclick = () => { closeFilter(); o.onApply(vals.every(v => chosen.has(v)) ? null : new Set(chosen)); };
  fpop.querySelector('.fclr').onclick = () => { closeFilter(); o.onApply(null); };
  document.body.appendChild(fpop);
  const r = o.rect, z = pageZoom();
  fpop.style.left = Math.max(4, Math.min(r.left / z, innerWidth / z - 250)) + 'px'; fpop.style.top = (r.bottom / z + 2) + 'px';
  draw(); q.focus();
}
function openFilter(th) {   // Use cases table
  const k = th.dataset.sort;
  openFilterPop({ rect: th.getBoundingClientRect(), label: th.firstChild.textContent.trim(), values: Scheduler.orderItems(state).map((it, i) => String(viewVal(it, i + 1, k).text)),
    current: view.filters[k], sortDir: view.key === k ? view.dir : 0,
    onSort: d => { if (d) { view.key = k; view.dir = d; } else view.key = null; renderRows(); },
    onApply: set => { set ? view.filters[k] = set : delete view.filters[k]; renderRows(); } });
}
document.querySelectorAll('th[data-sort]').forEach(th => {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'fbtn'; b.title = 'Filter this column'; b.textContent = '▾';
  b.onclick = e => { e.stopPropagation(); fpop && fpop.dataset.k === th.dataset.sort ? closeFilter() : (openFilter(th), fpop.dataset.k = th.dataset.sort); };
  th.appendChild(b);
});
document.addEventListener('mousedown', e => { if (fpop && !fpop.contains(e.target) && !e.target.closest('.fbtn, [data-gfilter]')) closeFilter(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFilter(); });
$('#clearfilters').onclick = () => { view.filters = {}; renderRows(); };
function renderRows() {
  const tb = $('#rows'); tb.innerHTML = '';
  $('#clearfilters').hidden = !Object.keys(view.filters).length;
  document.querySelectorAll('th[data-sort]').forEach(th => { th.classList.toggle('on', !!view.filters[th.dataset.sort]); th.classList.toggle('asc', th.dataset.sort === view.key && view.dir === 1); th.classList.toggle('desc', th.dataset.sort === view.key && view.dir === -1); });
  viewItems().forEach(({ it, rank: i1 }) => { const i = i1 - 1;
    const tr = document.createElement('tr'); tr.dataset.id = it.id; tr.classList.toggle('oos', it.stage === OOS);
    const opts = state.config.complexities.map(c => `<option value="${c.key}" ${c.key === it.complexity ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const link = itemUrl(it);
    tr.innerHTML = `<td class="num">${i + 1}</td>
      <td class="calc">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener" title="Open in SharePoint">${esc(it.spId || 'link')} ↗</a>` : esc(it.spId || '')}</td>
      <td><input type="text" data-f="name" value="${esc(it.name)}"></td>
      <td><select data-f="stage">${stageOptions(it.stage)}</select></td>
      <td><input type="number" class="pri" min="1" step="1" data-f="priority" placeholder="–" value="${it.priority ?? ''}"></td>
      <td><select data-f="complexity">${opts}</select></td>
      <td><select data-f="sme" title="SME required: how much subject-matter-expert time this use case needs">${smeOptions(it.sme)}</select></td>
      <td><select data-f="reuse" title="Reuse: how much of the plumbing already exists">${reuseOptions(it.reuse)}</select></td>
      <td class="calc" data-c="eng"></td><td class="calc" data-c="end"></td><td class="calc" data-c="p80"></td>
      <td><input type="text" data-f="comments" class="comment" placeholder="Comments" value="${esc(it.comments || '')}"></td>
      <td style="white-space:nowrap">
        <button class="ghost" data-a="details" title="Overrides">${open.has(it.id) ? '▾' : '▸'} details</button>
        <button class="ghost" data-a="del" title="Delete">✕</button>
      </td>`;
    tr.querySelectorAll('[data-f]').forEach(el => {
      const f = el.dataset.f;
      if (f === 'name' || f === 'comments') el.oninput = () => { it[f] = el.value; update(); };
      else el.onchange = () => {   // stage / priority change the sort order, so redraw the (re-sorted) list
        it[f] = f === 'priority' ? num(el.value) : (f === 'sme' || f === 'reuse' ? (el.value || null) : el.value);
        renderRows(); update();
      };
    });
    tr.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a, j = state.items.indexOf(it);
      if (a === 'details') { open.has(it.id) ? open.delete(it.id) : open.add(it.id); }
      else if (a === 'del') state.items.splice(j, 1);
      renderRows(); update();
    });
    tb.appendChild(tr);
    if (open.has(it.id)) tb.appendChild(detailsRow(it));
  });
}
// Dependencies: finish-to-start links. "Until" = the predecessor's finish, or completion of one of its stages.
function renderDeps(box, it) {
  const others = Scheduler.orderItems(state).filter(o => o.id !== it.id);
  const label = o => (o.spId ? o.spId + ' · ' : '') + o.name;
  const stageOpts = sel => `<option value="" ${!sel ? 'selected' : ''}>finishes (whole use case)</option>` +
    state.config.stages.map((s, i) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>completes ${i + 1}. ${esc(s.name)}</option>`).join('');
  box.innerHTML = `<div class="hint" style="margin:8px 0 4px" title="Finish-to-start: this use case cannot start until every use case listed here has reached the point you choose. Circular links are ignored."><b>Depends on</b> (this use case can't start until each of these …)</div>` +
    it.dependsOn.map((d, i) => `<div class="deprow"><select data-di="${i}" data-dk="id" title="Predecessor use case">${others.some(o => o.id === d.id) ? '' : `<option value="${esc(d.id)}" selected>(missing use case)</option>`}${others.map(o => `<option value="${esc(o.id)}" ${o.id === d.id ? 'selected' : ''}>${esc(label(o))}</option>`).join('')}</select>
      <select data-di="${i}" data-dk="until" title="What the predecessor must complete first">${stageOpts(d.until)}</select><label title="Once this predecessor is done, skip the stages before Build and start at Build instead of from scratch"><input type="checkbox" data-di="${i}" data-dfb ${d.fromBuild ? 'checked' : ''}> start at Build</label><label title="The earlier stages (before Build) start straight away; only Build waits until this predecessor is done"><input type="checkbox" data-di="${i}" data-dhb ${d.holdBuild ? 'checked' : ''}> only Build waits</label><button class="ghost" data-dx="${i}" title="Remove this dependency">✕</button></div>`).join('') +
    `<button data-dadd ${others.length ? '' : 'disabled'}>+ Add dependency</button>`;
  box.querySelectorAll('select[data-dk]').forEach(el => el.onchange = () => { it.dependsOn[Number(el.dataset.di)][el.dataset.dk] = el.value || null; update(); });
  box.querySelectorAll('[data-dhb]').forEach(el => el.onchange = () => { it.dependsOn[Number(el.dataset.di)].holdBuild = el.checked; update(); });
  box.querySelectorAll('[data-dfb]').forEach(el => el.onchange = () => { it.dependsOn[Number(el.dataset.di)].fromBuild = el.checked; update(); });
  box.querySelectorAll('[data-dx]').forEach(b => b.onclick = () => { it.dependsOn.splice(Number(b.dataset.dx), 1); renderDeps(box, it); update(); });
  const add = box.querySelector('[data-dadd]');
  if (add) add.onclick = () => { it.dependsOn.push({ id: others[0].id, until: null, fromBuild: false }); renderDeps(box, it); update(); };
}
function detailsRow(it) {
  const tr = document.createElement('tr'); tr.className = 'details';
  const fixed = state.config.stages.filter(s => s.kind !== 'eng');
  tr.innerHTML = `<td></td><td colspan="12"><div class="dgrid">
    <label title="Free-text notes about this use case (shown as a tooltip on the timeline)" style="flex-basis:100%">Comments <textarea data-t="comments" rows="2" style="width:100%">${esc(it.comments ?? '')}</textarea></label>
    <label title="ID of the item in the SharePoint list">SharePoint ID <input type="text" data-t="spId" value="${esc(it.spId ?? '')}"></label>
    <label title="Link to the SharePoint list item (http/https)">URL <input type="text" data-t="url" style="width:280px" placeholder="https://…" value="${esc(it.url ?? '')}"></label>
    <label title="Another use case in this plan whose delivered components this one extends. The reuse saving only applies once that use case's Build has finished (or if it is already past Build). Blank = the reuse rating applies straight away.">Builds on <select data-b="buildsOn"><option value="">— none —</option>${Scheduler.orderItems(state).filter(o => o.id !== it.id).map(o => `<option value="${esc(o.id)}" ${o.id === it.buildsOn ? 'selected' : ''}>${esc((o.spId ? o.spId + ' · ' : '') + o.name)}</option>`).join('')}</select></label>
    <label title="Expected weeks of Stakeholder Triage for this use case (only used while it is in triage). Blank = the default on the Setup tab.">Triage weeks <input type="number" min="0" step="1" data-k="triageWeeks" placeholder="default" value="${it.triageWeeks ?? ''}"></label>
    <label title="Date this use case entered its current stage. Time already spent counts towards that stage's length (fixed-length stages only). Blank = starts fresh at the plan start.">In stage since <input type="text" class="dateinp" data-d="stageStart" placeholder="dd-mmm-yyyy"></label>
    <label title="Developer-weeks of Build work still to do, replacing the estimate from complexity. Use this for a use case already part-way through Build. Blank = use complexity.">Build dev-weeks left <input type="number" min="0" data-k="effortOverride" placeholder="auto" value="${it.effortOverride ?? ''}"></label>
    <label title="Most developers on this use case at once. Blank = use the global Max per use case.">Max devs <input type="number" min="0.5" step="0.5" data-k="teamCap" placeholder="default" value="${it.teamCap ?? ''}"></label>
    <label title="Earliest date this use case may start. Blank = as soon as a slot is free.">Not before <input type="text" class="dateinp" data-d="earliestStart" placeholder="dd-mmm-yyyy"></label>
    ${fixed.map(s => `<label title="Weeks for this stage on this use case only. Blank = the stage default (${s.weeks}).">${esc(s.name)} wks <input type="number" min="0" data-s="${s.id}" placeholder="${s.weeks}" value="${it.overrides[s.id] ?? ''}"></label>`).join('')}
  </div><div class="depbox"></div><div class="hint">Overrides apply to this use case only. Leave a box empty to use the default shown in grey.</div></td>`;
  renderDeps(tr.querySelector('.depbox'), it);
  tr.querySelectorAll('[data-b]').forEach(el => el.onchange = () => { it.buildsOn = el.value || null; update(); });
  tr.querySelectorAll('[data-d]').forEach(el => bindDate(el, () => it[el.dataset.d], iso => { it[el.dataset.d] = iso || null; update(); }));
  tr.querySelectorAll('[data-t]').forEach(el => el.oninput = () => { it[el.dataset.t] = el.dataset.t === 'comments' ? el.value : (el.value.trim() || null); if (el.dataset.t === 'comments') { const c = document.querySelector(`tr[data-id="${it.id}"] input[data-f=comments]`); if (c) c.value = el.value; } update(); });
  tr.querySelectorAll('[data-k]').forEach(el => el.oninput = () => { it[el.dataset.k] = num(el.value); update(); });
  tr.querySelectorAll('[data-s]').forEach(el => el.oninput = () => {
    const v = num(el.value); if (v == null) delete it.overrides[el.dataset.s]; else it.overrides[el.dataset.s] = v; update();
  });
  return tr;
}


/* ---- CSV import (SharePoint list export) ---- */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const head = text.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].map(d => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}
const GUESS = {
  id: /^(id|item ?id|list ?item ?id|sharepoint ?id|sp ?id|use ?case ?id)$/i,
  name: /^(title|name|use ?case( ?name| ?title)?|project( ?name)?)$/i,
  complexity: /complex|t-?shirt|^size$/i,
  url: /url|link|href|item ?path/i,
  stage: /stage|status|phase/i,
  priority: /priorit|rank/i,
  sme: /sme|expert/i,
  reuse: /reus/i,
  dep: /depend|predecess|prereq|blocked ?by/i,
  comments: /comment|note|remark/i,
};
function matchComplexity(val) {
  const cxs = state.config.complexities, v = String(val || '').trim().toLowerCase();
  if (!v) return null;
  const hit = cxs.find(c => c.key.toLowerCase() === v || c.name.toLowerCase() === v); if (hit) return hit.key;
  const alias = { l:0, s:0, xs:0, small:0, simple:0, easy:0, '1':0, m:1, med:1, medium:1, moderate:1, '2':1, h:2, large:2, complex:2, hard:2, '3':2,
    vh:3, xl:3, xlarge:3, 'extra large':3, 'very complex':3, '4':3 };
  return v in alias ? cxs[Math.min(alias[v], cxs.length - 1)].key : null;
}
// Stage: "0"/triage, "1".."n", or a stage name (case-insensitive, whole or partial).
function matchStage(val) {
  const v = String(val || '').trim().toLowerCase(); if (!v) return null;
  if (v === '0' || /triage/.test(v)) return TRIAGE;
  if (/out.?of.?scope|^oos$|descoped?/.test(v)) return OOS;
  const st = state.config.stages;
  if (/^\d+$/.test(v)) return (st[+v - 1] || {}).id || null;
  const num = v.match(/^(\d+)[.)\s-]+/); if (num && st[+num[1] - 1]) return st[+num[1] - 1].id;
  const name = v.replace(/^\d+[.)\s-]+/, '');
  const hit = st.find(s => s.name.toLowerCase() === name) || st.find(s => s.name.toLowerCase().includes(name) || name.includes(s.name.toLowerCase()));
  return hit ? hit.id : null;
}
// Priority: a number (lower = more important) or High / Medium / Low text ("(1) High" also works).
function parsePriority(val) {
  const v = String(val || '').trim().toLowerCase(); if (!v) return null;
  const n = v.match(/-?\d+(\.\d+)?/); if (n) return Number(n[0]);
  const w = { critical: 1, urgent: 1, high: 1, medium: 2, normal: 2, med: 2, low: 3 }; 
  const k = Object.keys(w).find(x => v.includes(x)); return k ? w[k] : null;
}
// SME required: H / M / L or High / Medium / Low.
function parseSme(val) {
  const v = String(val || '').trim().toLowerCase(); if (!v) return null;
  if (v === 'h' || v.includes('high')) return 'H';
  if (v === 'm' || v.includes('med')) return 'M';
  if (v === 'l' || v.includes('low')) return 'L';
  return null;
}
function openImport() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.csv,text/csv,.txt';
  inp.onchange = async () => { const f = inp.files[0]; if (f) showImport(parseCSV(await f.text()), f.name); };
  inp.click();
}
function planImport(rows, map, prefix, mode) {
  const head = rows[0], col = k => map[k] === '' ? -1 : head.indexOf(map[k]);
  const ci = { id: col('id'), name: col('name'), cx: col('complexity'), url: col('url'), stage: col('stage'), pri: col('priority'), sme: col('sme'), reuse: col('reuse'), dep: col('dep'), comments: col('comments') };
  const out = { items: [], adds: 0, updates: 0, skipped: 0, unmatched: new Set(), unmatchedStage: new Set() };
  const seen = new Set();
  rows.slice(1).forEach(r => {
    const g = i => i < 0 ? '' : String(r[i] ?? '').replace(/\s+/g, ' ').trim();
    const spId = g(ci.id), name = g(ci.name);
    if (!name && !spId) { out.skipped++; return; }
    const url = safeUrl(g(ci.url));  // only a URL the file supplies is stored; the base URL is applied live
    let cx = ci.cx >= 0 ? matchComplexity(g(ci.cx)) : null;
    if (ci.cx >= 0 && !cx && g(ci.cx)) out.unmatched.add(g(ci.cx));
    let stage = ci.stage >= 0 ? matchStage(g(ci.stage)) : null;
    if (ci.stage >= 0 && !stage && g(ci.stage)) out.unmatchedStage.add(g(ci.stage));
    const priority = ci.pri >= 0 ? parsePriority(g(ci.pri)) : null;
    const sme = ci.sme >= 0 ? parseSme(g(ci.sme)) : null;
    const reuse = ci.reuse >= 0 ? parseSme(g(ci.reuse)) : null;   // H / M / L, same wording
    const existing = mode === 'update' && spId && state.items.find(i => i.spId === spId);
    out.items.push({ spId, name: name || ('Use case ' + spId), url, cx, stage, priority, sme, reuse, existing, dep: ci.dep >= 0 ? g(ci.dep) : null, comments: ci.comments >= 0 ? String(r[ci.comments] ?? '').trim() : '' });
    existing ? out.updates++ : out.adds++;
  });
  return out;
}
function showImport(rows, fileName) {
  if (rows.length < 2) { alert('That file has no data rows.'); return; }
  const head = rows[0].map(h => h.trim());
  rows[0] = head;
  const guess = k => head.find(h => GUESS[k].test(h)) || '';
  const opts = sel => `<option value="">— none —</option>` + head.map(h => `<option ${h === sel ? 'selected' : ''}>${esc(h)}</option>`).join('');
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<h3>Import use cases</h3><div class="hint">${esc(fileName)} · ${rows.length - 1} rows. Match your SharePoint columns to the fields below.</div>
    <div class="map">
      <label>SharePoint ID</label><select data-m="id">${opts(guess('id'))}</select>
      <label>Name</label><select data-m="name">${opts(guess('name'))}</select>
      <label>Complexity</label><select data-m="complexity">${opts(guess('complexity'))}</select>
      <label>Item URL</label><select data-m="url">${opts(guess('url'))}</select>
      <label title="Stakeholder Triage / 0, a stage number 1-${state.config.stages.length}, or a stage name">Stage / status</label><select data-m="stage">${opts(guess('stage'))}</select>
      <label title="A number (1 = highest) or High / Medium / Low">Priority</label><select data-m="priority">${opts(guess('priority'))}</select>
      <label title="How much of the needed plumbing already exists: High / Medium / Low (or H / M / L)">Reuse</label><select data-m="reuse">${opts(guess('reuse'))}</select>
      <label title="How much SME time the use case needs: High / Medium / Low (or H / M / L)">SME required</label><select data-m="sme">${opts(guess('sme'))}</select>
      <label title="Free-text notes for each use case">Comments</label><select data-m="comments">${opts(guess('comments'))}</select>
      <label title="Predecessors: SharePoint IDs (or names) separated by ; or ,. Optional >Stage = until that stage completes, then @build (start at Build) or @hold (only Build waits). Matches what Download CSV writes.">Depends on</label><select data-m="dep">${opts(guess('dep'))}</select>
      <label title="Used for any row with no URL: this text + the item's ID (or put {id} where the ID goes)">Base URL</label>
      <input type="text" id="imp-prefix" placeholder="https://tenant.sharepoint.com/sites/team/Lists/UseCases/DispForm.aspx?ID=" value="${esc(state.config.spLinkBase || '')}">
      <label>If ID already exists</label>
      <select id="imp-mode"><option value="update">Update it, add the rest</option><option value="add">Add everything as new</option><option value="replace">Replace all existing use cases</option></select>
    </div>
    <div class="preview" id="imp-prev"></div>
    <div class="actions"><span class="hint grow">Complexity can be a level name (Low, Medium…), S/M/L/XL, or 1–4. Existing items keep their overrides. The Base URL is also editable on the Setup tab.</span><button id="imp-cancel">Cancel</button><button class="primary" id="imp-go">Import</button></div>`;
  document.body.appendChild(dlg);
  const read = () => ({ map: Object.fromEntries([...dlg.querySelectorAll('[data-m]')].map(e => [e.dataset.m, e.value])), prefix: dlg.querySelector('#imp-prefix').value.trim(), mode: dlg.querySelector('#imp-mode').value });
  const preview = () => {
    const { map, prefix, mode } = read();
    const p = planImport(rows, map, prefix, mode === 'update' ? 'update' : 'add');
    const sample = p.items.slice(0, 4).map(i => `<div>${esc(i.spId || '–')} · ${esc(i.name)} · ${esc(i.cx || 'default complexity')} · ${esc(i.stage === TRIAGE ? 'Triage' : i.stage === OOS ? 'Out of scope' : (state.config.stages.find(x => x.id === i.stage) || {}).name || 'first stage')} · P${i.priority ?? '–'} · SME ${i.sme || '–'} · reuse ${i.reuse || '–'} · ${esc(i.url || resolveBase(prefix, i.spId) || 'no link')}</div>`).join('');
    dlg.querySelector('#imp-prev').innerHTML = `<b>${mode === 'replace' ? p.items.length + ' will replace all existing' : p.adds + ' new, ' + p.updates + ' updated'}</b>${p.skipped ? ` · ${p.skipped} blank rows skipped` : ''}` +
      (!map.name ? `<div class="warn">Choose a Name column.</div>` : '') +
      (p.unmatchedStage.size ? `<div class="warn">Unrecognised stage (will use ${esc(state.config.stages[0]?.name || 'first stage')}): ${[...p.unmatchedStage].slice(0, 8).map(esc).join(', ')}</div>` : '') +
      (!map.stage ? `<div class="muted">No stage column chosen: new use cases start at ${esc(state.config.stages[0]?.name || 'the first stage')}.</div>` : '') +
      (p.unmatched.size ? `<div class="warn">Unrecognised complexity (will use ${esc(state.config.complexities[1]?.name || 'default')}): ${[...p.unmatched].slice(0, 8).map(esc).join(', ')}</div>` : '') + `<div class="muted" style="margin-top:6px">${sample}</div>`;
  };
  dlg.addEventListener('input', preview); dlg.addEventListener('change', preview); preview();
  dlg.querySelector('#imp-cancel').onclick = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('cancel', () => setTimeout(() => dlg.remove()));
  dlg.querySelector('#imp-go').onclick = () => {
    const { map, prefix, mode } = read();
    if (!map.name) return;
    if (mode === 'replace' && !confirm('Replace ALL existing use cases with the imported ones?')) return;
    const p = planImport(rows, map, prefix, mode === 'replace' ? 'add' : mode);
    if (mode === 'replace') state.items = [];
    const dflt = state.config.complexities[1]?.key || state.config.complexities[0].key;
    const applied = [];
    const own = i => (i.url && i.url !== resolveBase(prefix || state.config.spLinkBase, i.spId)) ? i.url : null;   // a link that is just base URL + ID stays derived
    p.items.forEach(i => {
      if (i.existing) { applied.push([i, i.existing]); i.existing.name = i.name; if (own(i)) i.existing.url = own(i); if (i.cx) i.existing.complexity = i.cx; if (i.stage) i.existing.stage = i.stage; if (i.priority != null) i.existing.priority = i.priority; if (i.sme) i.existing.sme = i.sme; if (i.reuse) i.existing.reuse = i.reuse; if (i.comments) i.existing.comments = i.comments; return; }
      state.items.push({ id: uid('uc'), spId: i.spId || null, name: i.name, url: own(i), complexity: i.cx || dflt, stage: i.stage || state.config.stages[0]?.id, priority: i.priority ?? null, sme: i.sme || null, reuse: i.reuse || null, buildsOn: null, stageStart: null,
        teamCap: null, effortOverride: null, earliestStart: null, comments: i.comments || '', overrides: {} });
      applied.push([i, state.items[state.items.length - 1]]);
    });
    // Dependencies last, once every imported use case exists so rows can refer to each other
    let depMiss = 0;
    applied.forEach(([i, it]) => { if (i.dep == null) return; const deps = [];
      for (const tok of i.dep.split(/[,;]+/).map(x => x.trim()).filter(Boolean)) { const r = parseCell('dependsOn', tok, it); if (r.ok && r.value[0]) { if (!deps.some(d => d.id === r.value[0].id)) deps.push(r.value[0]); } else depMiss++; }
      it.dependsOn = deps; });
    if (prefix) state.config.spLinkBase = prefix;
    $('#spbase').value = state.config.spLinkBase || '';
    $('#importMsg').textContent = `Imported ${p.adds} new, ${p.updates} updated` + (depMiss ? ` · ${depMiss} dependency reference${depMiss > 1 ? 's' : ''} not matched` : '');
    dlg.close(); dlg.remove(); renderRows(); update();
  };
  dlg.showModal();
}

/* ---- Setup export / import (state.config as JSON; use cases travel separately as CSV) ---- */
function exportSetup() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'work-planner-setup', version: 1, config: state.config }, null, 2)], { type: 'application/json' }));
  a.download = `work-planner-setup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(a.href);
  $('#setupMsg').textContent = 'Setup exported';
}
function applySetup(text) {
  let d; try { d = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const c = d && d.app === 'work-planner-setup' ? d.config : null;
  if (!c || typeof c !== 'object') throw new Error('That file is not a Work Planner setup export.');
  if (!Array.isArray(c.stages) || !c.stages.length || !Array.isArray(c.complexities) || !c.complexities.length) throw new Error('The setup file has no stages or complexities.');
  const trial = Scheduler.normalize({ config: JSON.parse(JSON.stringify(c)), items: [] }).config;   // validate/heal on a copy first
  state.config = trial;
  const dflt = trial.complexities[1]?.key || trial.complexities[0].key;
  state.items.forEach(it => { if (!trial.complexities.some(x => x.key === it.complexity)) it.complexity = dflt; });
  Scheduler.normalize(state);   // moves use cases in removed stages to the first stage, drops stale overrides and dependency stages
  syncInputs(); renderStages(); renderSizes(); renderSme(); renderReuse(); renderRows(); update();
  $('#setupMsg').textContent = `Imported setup: ${trial.stages.length} stages, ${trial.complexities.length} sizes`;
}
function importSetup() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try { const t = await f.text(); if (!confirm('Replace the current setup (stages, sizes, factors, developers, start date, base URL) with the one in ' + f.name + '? Use cases are kept.')) return; applySetup(t); }
    catch (e) { $('#setupMsg').textContent = e.message; alert(e.message); }
  };
  inp.click();
}
function openGanttFilter(k, rect) {
  openFilterPop({ rect, label: cols().find(c => c[0] === k)[2], values: plan.allCells.map(r => gcellText(r, k)), current: gfilter[k], sortDir: gsort.key === k ? gsort.dir : 0,
    onSort: d => { if (d) { gsort.key = k; gsort.dir = d; } else gsort.key = null; update(); },
    onApply: set => { set ? gfilter[k] = set : delete gfilter[k]; update(); } });
}
/* ---- Gantt sort: click a column heading; reorders plan.rows (every Gantt row lookup goes through that array) ---- */
const gsort = { key: null, dir: 1 };
const gfilter = {};   // Gantt column filters: key -> Set of allowed cell texts. Filtered rows are dropped from plan.rows (plan.allRows keeps every row for totals and the table)
const gcellText = (r, k) => k === 'name' ? String(r.name) : String(r.vals[cols().findIndex(c => c[0] === k)]);
function filterGantt() {
  const fs = Object.entries(gfilter); plan.allCells = leftRows(false).slice(1);
  if (!fs.length) return;
  const keep = plan.allCells.map(r => fs.every(([k, set]) => set.has(gcellText(r, k))));
  plan.rows = plan.rows.filter((r, i) => keep[i]);
}
function sortGantt() {
  if (!gsort.key) return;
  const k = gsort.key, rows = leftRows(false).slice(1), pos = new Map(plan.rows.map((r, i) => [r, i]));
  const val = i => { const r = rows[i]; let v = ({ id: r.id, name: r.name, stage: r.stage, pri: r.pri, cx: r.cx, sme: ['Low', 'Medium', 'High'].indexOf(r.sme), reuse: ['Low', 'Medium', 'High'].indexOf(r.reuse),
    dep: r.dep, dur: r.dur, start: r.start, end: r.end, cmt: r.comments })[k]; if (v instanceof Date) v = v.getTime(); return v === '' || v === undefined || v === null || v === -1 ? null : v; };
  const keyed = plan.rows.map((r, i) => ({ r, v: val(i), i }));
  keyed.sort((a, b) => {
    if (a.v == null || b.v == null) return a.v == null ? (b.v == null ? a.i - b.i : 1) : -1;   // blanks last
    const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), undefined, { numeric: true, sensitivity: 'base' });
    return c ? c * gsort.dir : a.i - b.i;
  });
  plan.rows = keyed.map(x => x.r);
}
/* ---- recompute + draw ---- */
function update() {
  plan = Scheduler.schedule(state);
  fc = plan.unscheduled ? null : Scheduler.forecast(state);
  plan.allRows = plan.rows;
  plan.rows.forEach((r, i) => r.rank = i + 1);   // default-order number, so the numbers shown for items without an ID don't change when the Gantt is sorted
  sortGantt();
  filterGantt();
  const hasEng = state.config.stages.some(s => s.kind === 'eng');
  const inScope = plan.allRows.length - plan.oos;
  $('#summary').innerHTML = hasEng && inScope && plan.unscheduled === inScope
    ? `<span class="warn">No developers — engineering can't be scheduled</span>`
    : `<b>${inScope}</b> use cases${plan.oos ? ` <span class="muted">(+${plan.oos} out of scope)</span>` : ''} · <b>${Math.round(plan.totalEffort)}</b> dev-weeks · planned finish <b>${fmt(plan.endDate)}</b> <span class="muted">(${wk(plan.totalWeeks)} wks)</span>` +
      (fc ? ` · <span title="Monte Carlo: ${fc.iterations} simulated runs sampling effort between best and worst case">50%: <b>${fmt(fc.p50.date)}</b> · 80%: <b>${fmt(fc.p80.date)}</b> · 90%: <b>${fmt(fc.p90.date)}</b></span>` : '') +
      (plan.triage ? ` · <span class="muted" title="Stakeholder Triage: the delivery clock has not started. These are predicted assuming triage takes its estimated weeks (Setup tab), so their dates are tentative.">${plan.triage} in triage (tentative)</span>` : '') +
      (plan.unscheduled ? ` · <span class="warn">${plan.unscheduled} unscheduled</span>` : '');
  plan.allRows.forEach(r => {
    const tr = document.querySelector(`tr[data-id="${r.id}"]`); if (!tr) return;
    const e = r.bars.find(b => b.type === 'stage' && state.config.stages[b.stageIdx]?.kind === 'eng');
    tr.querySelector('[data-c=eng]').textContent = e ? `${fmt(e.startDate)} → ${fmt(e.endDate)}` + (r.queueWeeks > 0 ? ` · queued ${wk(r.queueWeeks)}w` : '') : '—';
    { const td = tr.querySelector('[data-c=eng]');
      if (r.reuseApplied) { td.textContent += ` · reuse saves ${wk(r.reuseSaved)} dev-wks`; td.title = 'Reuse of existing components reduced Build effort'; }
      else if (r.reusePending) { td.textContent += ' · reuse pending'; td.title = 'Builds on a use case whose Build is not finished when this one starts, so no reuse saving yet'; }
      else td.title = '';
      if (r.skipsToBuild) { td.textContent += ' · starts at Build (earlier stages skipped)'; td.title = 'Depends on a use case with "start at Build": skips the stages before Build'; }
      if (r.depIssue) { td.textContent += ' · dependency ignored (circular)'; td.title = 'This use case is part of a circular dependency, so its dependencies are ignored'; } }
    tr.querySelector('[data-c=end]').textContent = r.endDate ? (r.triage ? '~' : '') + fmt(r.endDate) : '—';
    const f = fc && fc.rows[r.id]; tr.querySelector('[data-c=p80]').textContent = f ? fmt(f.p80Date) : '—';
  });
  { const n = Object.keys(gfilter).length; $('#gclear').hidden = !n; $('#gfiltmsg').textContent = n ? `Filtered: showing ${plan.rows.length} of ${plan.allRows.length}` : ''; }
  renderGantt();
  clearTimeout(saveTimer);
  if (noSave) { $('#saved').textContent = 'Not saving: saved data failed to load'; return; }
  $('#saved').textContent = 'Saving…';
  saveTimer = setTimeout(async () => {
    try {
      const res = await fetch('api/state', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(state) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      $('#saved').textContent = 'Saved';
    } catch (e) { $('#saved').textContent = 'Save failed (' + e.message + ')'; }
  }, 400);
}


/* ---- spreadsheet-style editing in the Gantt table: select, copy / paste, fill handle, delete, undo ---- */
const COLKEY = { 2: 'stage', 3: 'priority', 4: 'complexity', 5: 'sme', 6: 'reuse', 7: 'dependsOn' };   // editable columns (indexes in cols())
const C_FIRST = 2, C_LAST = 7;
let gsel = null;         // { anchor:{c,id}, cur:{c,id}, c0, c1, ids:[] }  - rows tracked by id so re-sorting can't move them
let fillPrev = null;     // { p0, p1 } rows previewed while dragging the fill handle
const undoStack = [];
const rowPos = id => plan.rows.findIndex(r => r.id === id);
// How a use case is shown in the ID column: its SharePoint ID, else its row number.
const displayId = id => { const o = state.items.find(i => i.id === id), p = plan.allRows.find(x => x.id === id); return o ? (o.spId || String(p ? p.rank : '?')) : '?'; };
const itemOf = id => state.items.find(i => i.id === id);
const pushUndo = () => { undoStack.push(JSON.stringify(state.items)); if (undoStack.length > 40) undoStack.shift(); };
function undo() {
  if (!undoStack.length) return gmsg('Nothing to undo');
  state.items = JSON.parse(undoStack.pop()); Scheduler.normalize(state); renderRows(); update(); gmsg('Undone');
}
let gmsgTimer;
function gmsg(t) { const el = $('#gmsg'); if (!el) return; el.textContent = t; clearTimeout(gmsgTimer); gmsgTimer = setTimeout(() => { el.textContent = ''; }, 4500); }

function setRange(a, b) {   // a, b = { c, p } (column index, row position)
  const c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c), lo = Math.min(a.p, b.p), hi = Math.max(a.p, b.p);
  gsel = { anchor: { c: a.c, id: plan.rows[a.p].id }, cur: { c: b.c, id: plan.rows[b.p].id }, c0, c1, ids: plan.rows.slice(lo, hi + 1).map(r => r.id) };
}
const cellPos = el => ({ c: Number(el.dataset.ci), p: Number(el.dataset.p) });
const gridActive = () => gsel && $('#gantt').contains(document.activeElement) && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
const cellText = (it, key) => key === 'stage' ? (it.stage === TRIAGE ? 'Stakeholder Triage' : it.stage === OOS ? 'Out of scope' : (state.config.stages.find(s => s.id === it.stage) || {}).name || '')
  : key === 'priority' ? String(it.priority ?? '')
  : key === 'complexity' ? (state.config.complexities.find(c => c.key === it.complexity) || {}).name || ''
  : key === 'dependsOn' ? (it.dependsOn || []).map(d => displayId(d.id) + (d.until ? '>' + ((state.config.stages.find(s => s.id === d.until) || {}).name || d.until) : '') + (d.fromBuild ? ' @build' : '') + (d.holdBuild ? ' @hold' : '')).join(', ')
  : SME_LABEL[it[key]] || '';
// Parse pasted text for a column. Returns { ok, value }.
function parseCell(key, text, it) {
  const t = String(text ?? '').trim();
  if (key === 'dependsOn') {   // "12>Build, 15 @build": use case (SharePoint ID, name or row number), optional ">stage" = until that stage completes
    const out = [];
    for (const tok of t.split(/[,;]+/).map(x => x.trim()).filter(Boolean)) {
      const fromBuild = /\s*@build\b/i.test(tok), holdBuild = /\s*@hold\b/i.test(tok);
      const [ref, st] = tok.replace(/\s*@(build|hold)\b/gi, '').split(/\s*>\s*/), low = ref.trim().toLowerCase();
      let cand = state.items.find(o => o.spId && o.spId.toLowerCase() === low) || state.items.find(o => o.name.toLowerCase() === low);
      if (!cand && /^\d+$/.test(low)) { const r = plan.allRows.find(x => x.rank === +low), o = r && state.items.find(i => i.id === r.id); if (o && !o.spId) cand = o; }
      if (!cand) return { ok: false };
      let until = null;
      if (st) { until = matchStage(st); if (!until || until === TRIAGE || until === OOS) return { ok: false }; }
      if (it && cand.id === it.id) continue;          // a use case can't depend on itself
      if (!out.some(d => d.id === cand.id)) out.push({ id: cand.id, until, fromBuild, holdBuild });
    }
    return { ok: true, value: out };
  }
  if (key === 'stage') { const v = matchStage(t); return v ? { ok: true, value: v } : { ok: false }; }
  if (key === 'priority') { if (t === '') return { ok: true, value: null }; const v = parsePriority(t); return v == null ? { ok: false } : { ok: true, value: v }; }
  if (key === 'complexity') { const v = matchComplexity(t); return v ? { ok: true, value: v } : { ok: false }; }
  if (t === '' || t === '-' || t === '–' || /^none$/i.test(t)) return { ok: true, value: null };
  const v = parseSme(t); return v ? { ok: true, value: v } : { ok: false };
}
const selRowsOrdered = () => gsel.ids.map(rowPos).filter(p => p >= 0).sort((a, b) => a - b);
function commit(msg) { renderRows(); update(); gmsg(msg); }

function copySelection() {
  const lines = selRowsOrdered().map(p => { const it = itemOf(plan.rows[p].id); const out = [];
    for (let c = gsel.c0; c <= gsel.c1; c++) out.push(cellText(it, COLKEY[c])); return out.join('\t'); });
  return lines.join('\n');
}
function pasteText(text) {
  const ps = selRowsOrdered(); if (!ps.length) return;
  let rows = String(text).replace(/\r/g, '').split('\n'); if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  const grid = rows.map(r => r.split('\t')); let ok = 0, bad = 0;
  pushUndo();
  const put = (id, c, val) => { const key = COLKEY[c], r = parseCell(key, val, itemOf(id)); if (!r.ok) { bad++; return; } itemOf(id)[key] = r.value; ok++; };
  if (grid.length === 1 && grid[0].length === 1 && (ps.length > 1 || gsel.c1 > gsel.c0)) {
    gsel.ids.forEach(id => { for (let c = gsel.c0; c <= gsel.c1; c++) put(id, c, grid[0][0]); });   // one value fills the whole selection
  } else {
    const p0 = ps[0], c0 = gsel.c0, width = Math.max(...grid.map(r => r.length));
    grid.forEach((row, ri) => { const r = plan.rows[p0 + ri]; if (r) row.forEach((v, ci) => { if (c0 + ci <= C_LAST) put(r.id, c0 + ci, v); }); });
    const p1 = Math.min(plan.rows.length - 1, p0 + grid.length - 1);
    setRange({ c: c0, p: p0 }, { c: Math.min(C_LAST, c0 + width - 1), p: p1 });   // select what was pasted
  }
  commit(`Pasted ${ok} value${ok === 1 ? '' : 's'}` + (bad ? `; ${bad} not recognised and skipped` : ''));
}
function clearSelection() {   // Delete: blank optional columns (priority, SME, reuse); stage and complexity can't be blank
  pushUndo(); let n = 0;
  gsel.ids.forEach(id => { for (let c = gsel.c0; c <= gsel.c1; c++) { const k = COLKEY[c]; if (k === 'priority' || k === 'sme' || k === 'reuse' || k === 'dependsOn') { itemOf(id)[k] = k === 'dependsOn' ? [] : null; n++; } } });
  commit(n ? `Cleared ${n} value${n === 1 ? '' : 's'}` : 'Stage and complexity cannot be blank');
}
// Copy the selected block into target rows (fill handle / Ctrl+D). Sources repeat in order.
function fillRows(sourcePos, targetPos) {
  pushUndo(); let n = 0;
  const src = sourcePos.map(p => itemOf(plan.rows[p].id)), lo = sourcePos[0];
  targetPos.forEach(tp => {
    const k = tp > sourcePos[sourcePos.length - 1] ? (tp - lo) % src.length : (src.length - 1 - ((lo - 1 - tp) % src.length));
    const s = src[k], d = itemOf(plan.rows[tp].id);
    for (let c = gsel.c0; c <= gsel.c1; c++) {
      const k = COLKEY[c];
      d[k] = k === 'dependsOn' ? (s.dependsOn || []).filter(x => x.id !== d.id).map(x => ({ ...x })) : s[k]; n++;
    }
  });
  const all = [...sourcePos, ...targetPos]; const a = Math.min(...all), b = Math.max(...all);
  setRange({ c: gsel.c0, p: a }, { c: gsel.c1, p: b });
  commit(`Filled ${targetPos.length} row${targetPos.length === 1 ? '' : 's'}`);
}

function bindGrid(g) {
  g.setAttribute('tabindex', '0');
  // mouse: click / drag to select, shift-click to extend, drag the handle to fill
  g.addEventListener('mousedown', e => {
    const fh = e.target.closest('[data-fill]'), cell = e.target.closest('[data-cell]');
    if (fh && gsel) {
      e.preventDefault(); g.focus({ preventScroll: true });
      const ps = selRowsOrdered(), pmin = ps[0], pmax = ps[ps.length - 1], svgTop = g.querySelector('.gleft svg').getBoundingClientRect().top;
      const posAt = ev => Math.max(0, Math.min(plan.rows.length - 1, Math.floor((ev.clientY - svgTop - HH) / RH) - 1));
      let raf = 0;
      const mv = ev => { const tp = posAt(ev);
        fillPrev = tp > pmax ? { p0: pmax + 1, p1: tp } : tp < pmin ? { p0: tp, p1: pmin - 1 } : null;
        cancelAnimationFrame(raf); raf = requestAnimationFrame(renderGantt); };
      const up = ev => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
        const fp = fillPrev; fillPrev = null;
        if (fp) { const t = []; for (let p = fp.p0; p <= fp.p1; p++) t.push(p); fillRows(ps, t); } else renderGantt(); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      return;
    }
    if (!cell) return;
    e.preventDefault(); g.focus({ preventScroll: true });
    const here = cellPos(cell);
    if (e.shiftKey && gsel) { const a = { c: gsel.anchor.c, p: Math.max(0, rowPos(gsel.anchor.id)) }; setRange(a, here); }
    else setRange(here, here);
    renderGantt();
    const anchor = { c: gsel.anchor.c, p: rowPos(gsel.anchor.id) }; let moved = false;
    const mv = ev => { const t = document.elementFromPoint(ev.clientX, ev.clientY), c = t && t.closest && t.closest('[data-cell]');
      if (!c) return;
      const cp = cellPos(c);
      if (cp.c !== anchor.c || cp.p !== anchor.p) moved = true;
      if (moved) { setRange(anchor, cp); renderGantt(); } };
    const up = ev => {
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      if (moved || e.shiftKey) return;   // a drag / shift-click just selects; a plain click also opens the dropdown
      const el = g.querySelector(`[data-cell][data-ci="${anchor.c}"][data-p="${anchor.p}"]`); if (el) pickField(el);
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
  // keyboard
  g.addEventListener('keydown', e => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || !gsel) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); return undo(); }
    if (mod && k.toLowerCase() === 'd') {   // fill down from the top row of the selection
      e.preventDefault(); const ps = selRowsOrdered(); if (ps.length < 2) return;
      return fillRows([ps[0]], ps.slice(1));
    }
    if (k === 'Escape') { gsel = null; return renderGantt(); }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); return clearSelection(); }
    const cur = { c: gsel.cur.c, p: Math.max(0, rowPos(gsel.cur.id)) };
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); const c = g.querySelector(`[data-cell][data-ci="${cur.c}"][data-p="${cur.p}"]`); return c && pickField(c); }
    const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[k]; if (!d) return;
    e.preventDefault();
    const n = { c: Math.min(C_LAST, Math.max(C_FIRST, cur.c + d[0])), p: Math.min(plan.rows.length - 1, Math.max(0, cur.p + d[1])) };
    if (e.shiftKey) setRange({ c: gsel.anchor.c, p: Math.max(0, rowPos(gsel.anchor.id)) }, n); else setRange(n, n);
    renderGantt();
  });
}
// Clipboard (works with Excel / Sheets: tab-separated cells, one row per line)
document.addEventListener('copy', e => {
  if (!gridActive()) return;
  e.clipboardData.setData('text/plain', copySelection()); e.preventDefault();
  gmsg(`Copied ${gsel.ids.length} row${gsel.ids.length === 1 ? '' : 's'} × ${gsel.c1 - gsel.c0 + 1} column${gsel.c1 > gsel.c0 ? 's' : ''}`);
});
document.addEventListener('cut', e => {
  if (!gridActive()) return;
  e.clipboardData.setData('text/plain', copySelection()); e.preventDefault(); clearSelection();
});
document.addEventListener('paste', e => {
  if (!gridActive()) return;
  e.preventDefault(); pasteText(e.clipboardData.getData('text/plain'));
});
document.addEventListener('mousedown', e => {   // clicking away drops the selection
  // Use the event's original path: the grid re-renders during its own mousedown, so e.target may already be detached.
  const path = e.composedPath ? e.composedPath() : [];
  if (gsel && !path.includes($('#gantt')) && !path.some(n => n.tagName === 'DIALOG' || (n.classList && n.classList.contains('cxpick')))) { gsel = null; if (activeTab === 'timeline') renderGantt(); }
});

/* ---- Gantt: one SVG design used for both screen and PNG export ---- */
const PAL = ['#8b6fd6','#e39a2d','#2f6fed','#1aa39a','#3aa356','#8a94a3','#d6577f','#a0803a'];
const pal = i => PAL[i % PAL.length];
const RH = 24, HH = 44, DAYMS = 86400000;
// Mouse-over explanations for the table columns (Gantt header and Use cases table).
const COLHELP = {
  id: 'SharePoint ID of the use case (or its row number if it has none). Click the ID or name to open the SharePoint item.',
  name: 'Name of the use case.',
  stage: 'Current stage: 0. Stakeholder Triage, then the pipeline stages in order. Earlier stages are skipped; triage is predicted after its estimated weeks. Double-click a cell to change it.',
  pri: 'Priority, 1 = highest. Rows are ordered by most advanced stage first, then priority, and developers are handed out in that order.',
  cx: 'Complexity of the use case. It sets the Build effort in developer-weeks (see Engineering size on the Setup tab).',
  sme: 'SME required: how much subject-matter-expert time the use case needs (H / M / L). Higher stretches the SME-flagged stages.',
  reuse: 'Reuse: how much of the plumbing already exists from earlier deliveries (H / M / L). Higher reduces Build effort.',
  dep: 'Depends on: use cases (by ID) that must finish first before this one can start (finish-to-start). A use case already under way keeps running its current stage; its Build waits. Click a cell to choose them (or edit under "details" on the Use cases tab); copy/paste uses IDs, with ">Stage" for "until that stage completes", e.g. "12>Build, 15". Add " @build" (e.g. "12 @build") for a dependency that lets this use case skip its earlier stages and start at Build once that predecessor is done. Grey arrows in the chart show each link.',
  cmt: 'Free-text notes for the use case. Click a cell to edit; the full text shows on hover.',
  dur: 'Predicted elapsed weeks from when work starts to when the use case finishes.',
  start: 'Predicted date work starts (the first stage after any triage period). ~ marks a tentative date for a use case still in Stakeholder Triage.',
  end: 'Predicted finish date at the end of the last stage. ~ marks a tentative date for a use case still in Stakeholder Triage.',
  eng: 'Predicted Build dates. "queued" = waiting for a free developer; "reuse saves" = dev-weeks saved by reuse; "reuse pending" = it builds on a use case whose Build is not finished yet.',
  p80: 'Date the use case is 80% likely to be finished by, from the Monte Carlo forecast (effort varies between best and worst case).',
};
// Timeline table columns: every width is draggable and remembered in this browser.
const DEF_COLW = { id: 56, name: 206, stage: 154, pri: 54, cx: 84, sme: 54, reuse: 50, dep: 150, dur: 66, start: 88, end: 88, cmt: 220 };
const COL_MIN = 30, COL_MAX = 700;
function loadColW() {
  let saved = {}; try { saved = JSON.parse(lsGet('colW') || '{}') || {}; } catch {}
  const legacy = Number(lsGet('nameW')); if (legacy && saved.name == null) saved.name = legacy;   // older single-column setting
  const out = { ...DEF_COLW };
  for (const k in out) { const v = Number(saved[k]); if (v >= COL_MIN && v <= COL_MAX) out[k] = v; }
  return out;
}
let COLW = loadColW();
const saveColW = () => lsSet('colW', JSON.stringify(COLW));
const cols = () => [['id', COLW.id, 'ID'], ['name', COLW.name, 'Task name'], ['stage', COLW.stage, 'Stage'], ['pri', COLW.pri, 'Pri'], ['cx', COLW.cx, 'Complexity'],
  ['sme', COLW.sme, 'SME req'], ['reuse', COLW.reuse, 'Reuse'], ['dep', COLW.dep, 'Depends on'], ['dur', COLW.dur, 'Duration'], ['start', COLW.start, 'Start'], ['end', COLW.end, 'Finish'], ['cmt', COLW.cmt, 'Comments']];
const lw = () => cols().reduce((a, c) => a + c[1], 0);
let activeTab = 'timeline';
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
// One zoom level for every tab, so text and controls stay the same size when switching screens
const pageZoom = () => { const z = Number(lsGet('pageZoom')); return z >= 0.5 && z <= 3 ? z : 1; };
function applyZoom() { const z = pageZoom(); document.body.style.zoom = z === 1 ? '' : z; }
function stepZoom(d, reset) {
  const z = reset ? 1 : Math.min(3, Math.max(0.5, Math.round((pageZoom() + d) * 100) / 100));
  lsSet('pageZoom', String(z)); applyZoom(); if (activeTab === 'timeline' && plan) renderGantt();
}
function showTab(t) {
  if (!document.getElementById('tab-' + t)) t = 'timeline';
  activeTab = t; lsSet('tab', t);
  document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== 'tab-' + t);
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  applyZoom();
  if (t === 'timeline' && plan) renderGantt();
}
const showToday = () => $('#today').checked;
function resolveBase(base, id) {
  base = String(base || '').trim(); if (!base || !id) return '';
  return safeUrl(/\{id\}/i.test(base) ? base.replace(/\{id\}/gi, encodeURIComponent(id)) : base + encodeURIComponent(id));
}
// A use case's own URL wins; otherwise base URL + SharePoint ID.
const itemUrl = it => safeUrl(it.url) || resolveBase(state.config.spLinkBase, it.spId);
const safeUrl = u => { try { const x = new URL(String(u || '').trim()); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const clip = (t, w) => { t = String(t); const n = Math.floor(w / 6.7); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const shortDate = d => fmt(typeof d === 'string' ? d : Scheduler.fmtDate(d));

function layout(exportW) {
  const start = Scheduler.parseDate(plan.startDate);
  const endW = Math.max(plan.totalWeeks, fc ? fc.p80.weeks : 0) + 2;
  const last = Scheduler.addWeeks(start, endW);
  const first = showToday() && Date.now() < start ? new Date() : start;
  // whole months, not whole quarters, so no empty quarter is left before the start or after the end
  const t0 = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const t1 = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1));
  const avail = (exportW || $('#gantt').clientWidth) - lw() - 4;
  const fitPpd = avail > 200 ? avail / ((t1 - t0) / DAYMS) : 0;
  const ppd = (exportW || $('#fit').checked) && fitPpd ? fitPpd : Math.max(Number($('#zoom').value) / 2, fitPpd);   // never leave empty space to the right
  const X = ms => (ms - t0) / DAYMS * ppd;
  return { ppd, start, t0, t1, X, XW: w => X(start.getTime() + w * 7 * DAYMS), width: Math.ceil(X(t1)), height: HH + (plan.rows.length + 1) * RH };
}

// Row data for the left-hand table (text of every cell, before clipping).
function leftRows(ui = true) {
  const byId = Object.fromEntries(state.items.map(it => [it.id, it]));
  const cxName = k => (state.config.complexities.find(c => c.key === k) || {}).name || '';
  const rows = [{ id: 0, name: 'Programme', bold: true, dur: plan.totalWeeks, start: plan.startDate, end: plan.endDate }]
    .concat(plan.rows.map((r, i) => {
      const it = byId[r.id] || {}, f = r.bars.find(b => b.type === 'stage');
      const idText = displayId;
      const deps = (it.dependsOn || []);
      return { dep: deps.map(d => (byId[d.id] ? byId[d.id].name : '?')).join(', '), depTip: deps.map(d => (byId[d.id] ? byId[d.id].name : 'missing') + (d.until ? ' (until ' + ((state.config.stages.find(s => s.id === d.until) || {}).name || d.until) + ' completes)' : ' (until it finishes)')).join('; '), itemId: r.id, cx: cxName(it.complexity), sme: it.sme || '', reuse: it.reuse || '', stage: r.stageName, pri: r.priority ?? '', id: it.spId || r.rank, url: itemUrl(it), name: r.name, triage: r.triage,
        dur: r.end != null && r.begin != null ? r.end - r.begin : null, start: f ? f.startDate : null, end: r.endDate, none: r.triage ? 'Not started' : r.oos ? 'Out of scope' : '—', oos: !!r.oos, comments: it.comments || '' }; }));
  return rows.map((r, i) => {
    const vals = [i === 0 ? '' : r.id, (r.comments ? '💬 ' : '') + r.name, r.stage || '', String(r.pri ?? ''), r.cx || '', r.sme || '', r.reuse || '', r.dep || '', r.dur != null ? wk(r.dur) + ' wks' : '—', r.start ? (r.triage ? '~' : '') + shortDate(r.start) : '—', r.end ? (r.triage ? '~' : '') + shortDate(r.end) : (r.none || '—'), r.comments || ''];
    if (ui && i > 0) { if (vals[2]) vals[2] += ' ▾'; if (vals[4]) vals[4] += ' ▾'; vals[5] = (vals[5] || '–') + ' ▾'; vals[6] = (vals[6] || '–') + ' ▾'; vals[7] = (vals[7] || '–') + ' ▾'; }
    return { ...r, vals };
  });
}
function leftSVG(L, ui = true) {
  const H = L.height, W = lw(); let o = `<rect width="${W}" height="${H}" fill="#fff"/><rect width="${W}" height="${HH}" fill="#e9edf3"/>`;
  let x = 0; const xs = [], cs = cols();
  cs.forEach(c => {
    xs.push(x); o += `<g class="gh"><title>${esc(c[2] + ': ' + (COLHELP[c[0]] || '') + (ui ? ' Click to sort.' : ''))}</title><rect ${ui ? `data-gsort="${c[0]}" style="cursor:pointer" ` : ''}x="${x}" y="0" width="${c[1]}" height="${HH}" fill="transparent"/><text x="${x + 6}" y="${HH / 2 + 14}" font-size="12" font-weight="600" fill="#33404f" pointer-events="none">${esc(clip(c[2], c[1] - (gfilter[c[0]] || gsort.key === c[0] ? 30 : 10)))}${gsort.key === c[0] ? (gsort.dir === 1 ? ' ▲' : ' ▼') : ''}</text>${ui ? `<g data-gfilter="${c[0]}" class="${gfilter[c[0]] || gsort.key === c[0] ? 'on' : ''}" style="cursor:pointer"><title>Filter ${esc(c[2])}</title><rect x="${x + c[1] - 22}" y="${HH / 2 + 3}" width="18" height="${HH / 2 - 6}" rx="3" fill="${gfilter[c[0]] ? '#2f6fed' : 'transparent'}"/><text x="${x + c[1] - 13}" y="${HH / 2 + 15}" font-size="10" text-anchor="middle" fill="${gfilter[c[0]] ? '#fff' : '#5f6b7a'}" pointer-events="none">▾</text></g>` : ''}</g>`; x += c[1]; o += `<line x1="${x}" x2="${x}" y1="0" y2="${H}" stroke="#d5dae1"/>`;
    if (ui) o += `<rect data-resize="${c[0]}" x="${x - 4}" y="0" width="8" height="${HH}" fill="transparent" style="cursor:col-resize"><title>Drag to resize this column (double-click to fit)</title></rect><line x1="${x - 1}" x2="${x - 1}" y1="14" y2="${HH - 14}" stroke="#8b95a1" stroke-width="2" pointer-events="none"/>`;
  });
  const selPos = ui && gsel ? gsel.ids.map(id => plan.rows.findIndex(r => r.id === id)).filter(p => p >= 0).sort((a, b) => a - b) : [];
  if (selPos.length) {   // shade selected cells under the text
    const sx = xs[gsel.c0], sw = xs[gsel.c1] + cs[gsel.c1][1] - sx;
    selPos.forEach(p => { o += `<rect x="${sx}" y="${HH + (p + 1) * RH}" width="${sw}" height="${RH}" fill="rgba(47,111,237,.16)" pointer-events="none"/>`; });
  }
  leftRows(ui).forEach((r, i) => {
    const y = HH + i * RH, ty = y + RH / 2 + 4, w = r.bold ? 'font-weight="700"' : '';
    o += `<line x1="0" x2="${W}" y1="${y + RH}" y2="${y + RH}" stroke="#e8eaed"/>`;
    r.vals.forEach((v, k) => {
      const linked = r.url && k < 2 && v !== '';
      const dim = (r.triage && k === 2) || r.oos;
      const t = `<text x="${xs[k] + 6}" y="${ty}" font-size="13" fill="${linked ? '#0b57d0' : dim ? '#8a94a3' : '#1c2430'}" ${w}${linked ? ' text-decoration="underline"' : ''}>${esc(clip(v, cs[k][1] - 8))}</text>`;
      if (r.comments && k === 1) { o += `<g><title>${esc(r.comments)}</title><rect x="${xs[k]}" y="${y}" width="${cs[k][1]}" height="${RH}" fill="transparent"/></g>`; }
      o += linked ? `<a href="${esc(r.url)}" target="_blank" rel="noopener"><title>Open in SharePoint: ${esc(r.name)}</title>${t}</a>` : (k === 7 && r.depTip ? `<g><title>Depends on: ${esc(r.depTip)}</title>${t}</g>` : t);
    });
    if (ui && i > 0) {   // one hit target per editable cell: select / drag-select / edit
      const hit = (kind, k) => `<rect data-cell data-ci="${k}" data-p="${i - 1}" data-id="${esc(r.itemId)}" data-pick="${kind}" x="${xs[k]}" y="${y}" width="${cs[k][1]}" height="${RH}" fill="transparent" style="cursor:pointer"><title>Click to change · drag to select a range (then Ctrl/Cmd+C, Ctrl/Cmd+V) · shift-click extends</title></rect>`;
      o += hit('stage', 2) + hit('pri', 3) + hit('cx', 4) + hit('sme', 5) + hit('reuse', 6) + hit('dep', 7)
        + `<rect data-cmt data-id="${esc(r.itemId)}" x="${xs[11]}" y="${y}" width="${cs[11][1]}" height="${RH}" fill="transparent" style="cursor:text"><title>${esc(r.comments || 'Click to add a comment')}</title></rect>`;
    }
  });
  if (selPos.length) {   // outline + fill handle
    const sx = xs[gsel.c0], sw = xs[gsel.c1] + cs[gsel.c1][1] - sx, pmin = selPos[0], pmax = selPos[selPos.length - 1];
    o += `<rect x="${sx + 1}" y="${HH + (pmin + 1) * RH + 1}" width="${sw - 2}" height="${(pmax - pmin + 1) * RH - 2}" fill="none" stroke="#2f6fed" stroke-width="2" pointer-events="none"/>`;
    if (fillPrev) o += `<rect x="${sx + 1}" y="${HH + (fillPrev.p0 + 1) * RH + 1}" width="${sw - 2}" height="${(fillPrev.p1 - fillPrev.p0 + 1) * RH - 2}" fill="rgba(47,111,237,.08)" stroke="#2f6fed" stroke-dasharray="4 3" pointer-events="none"/>`;
    o += `<rect data-fill x="${sx + sw - 5}" y="${HH + (pmax + 2) * RH - 5}" width="9" height="9" fill="#2f6fed" stroke="#fff" stroke-width="1.5" style="cursor:ns-resize"><title>Drag up or down to copy these values into other rows</title></rect>`;
  }
  return `<line x1="0" x2="${W}" y1="${HH}" y2="${HH}" stroke="#9aa3ad"/>` + o;
}

function rightSVG(L) {
  const H = L.height, W = L.width;
  let o = `<rect width="${W}" height="${H}" fill="#fff"/><rect width="${W}" height="${HH}" fill="#e9edf3"/>`;
  let grid = '', hdr = '';
  for (let d = new Date(L.t0); d < L.t1;) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), nx = new Date(Date.UTC(y, m + 1, 1));
    const x1 = L.X(d), x2 = L.X(nx), isQ = m % 3 === 0;
    hdr += `<text x="${(x1 + x2) / 2}" y="${HH - 7}" font-size="12" text-anchor="middle" fill="#33404f">${d.toLocaleDateString('en', { month: (x2 - x1) > 30 ? 'short' : 'narrow', timeZone: 'UTC' })}</text>`;
    grid += `<line x1="${x1}" x2="${x1}" y1="${isQ ? 0 : HH / 2}" y2="${H}" stroke="${isQ ? '#8b95a1' : '#e2e5ea'}"/>`;
    if (isQ || +d === +L.t0) {   // label each quarter, including a partial first one
      const qm = m - m % 3, q2 = Math.min(L.X(new Date(Date.UTC(y, qm + 3, 1))), L.X(L.t1));
      hdr += `<text x="${(x1 + q2) / 2}" y="${HH / 2 - 6}" font-size="12" font-weight="600" text-anchor="middle" fill="#1c2430">Q${qm / 3 + 1} ${y}</text>`;
    }
    d = nx;
  }
  o += grid + hdr + `<line x1="0" x2="${W}" y1="${HH / 2}" y2="${HH / 2}" stroke="#c9ced6"/><line x1="0" x2="${W}" y1="${HH}" y2="${HH}" stroke="#9aa3ad"/>`;
  for (let i = 0; i <= plan.rows.length; i++) o += `<line x1="0" x2="${W}" y1="${HH + (i + 1) * RH}" y2="${HH + (i + 1) * RH}" stroke="#e8eaed"/>`;

  // summary bracket (MS Project style)
  { const y = HH, x1 = L.XW(0), x2 = L.XW(plan.totalWeeks);
    o += `<g><title>Programme: ${esc(shortDate(plan.startDate))} → ${esc(shortDate(plan.endDate))}</title><rect x="${x1}" y="${y + 7}" width="${Math.max(2, x2 - x1)}" height="6" fill="#222"/>
      <polygon points="${x1},${y + 13} ${x1 + 8},${y + 13} ${x1},${y + 19}" fill="#222"/><polygon points="${x2},${y + 13} ${x2 - 8},${y + 13} ${x2},${y + 19}" fill="#222"/></g>`; }

  plan.rows.forEach((r, i) => {
    const y = HH + (i + 1) * RH;
    r.bars.forEach(b => {
      const x = L.XW(b.start), w = Math.max(2, L.XW(b.end) - x);
      const bl = b.blocker, blName = bl && bl.name, blStage = bl && bl.until ? ((state.config.stages.find(s => s.id === bl.until) || {}).name || bl.until) : '';
      const tip = `<title>${esc(r.name)} — ${esc(b.name)}${blName ? ' on ' + esc(blName) + (bl.until ? ' to finish ' + esc(blStage) : ' to finish') + ' (' + esc(shortDate(L0(bl.at))) + ')' : ''}: ${esc(shortDate(b.startDate))} → ${esc(shortDate(b.endDate))} (${wk(b.end - b.start)} wks)</title>`;
      if (b.key === 'depwait') {
        o += `<g data-r="${esc(r.id)}">${tip}<rect x="${x}" y="${y + 5}" width="${w}" height="${RH - 10}" rx="2" fill="#fff4e0" stroke="#e08a00" stroke-width="1.2" stroke-dasharray="4 2"/>`;
        if (w > 60) o += `<text x="${x + 5}" y="${y + RH / 2 + 3.5}" font-size="12" font-weight="600" fill="#9a5b00">${esc(clip('⏳ Waiting on ' + (blName || 'a dependency'), w - 8))}</text>`;
        o += '</g>';
      } else if (b.type === 'queue') o += `<g data-r="${esc(r.id)}">${tip}<rect x="${x}" y="${y + 9}" width="${w}" height="6" fill="url(#hatch)" stroke="#b3bac4" stroke-dasharray="3 2"/></g>`;
      else if (b.type === 'triage') {
        o += `<g data-r="${esc(r.id)}">${tip}<rect x="${x}" y="${y + 5}" width="${w}" height="${RH - 10}" rx="2" fill="#e6e9ee" stroke="#8a94a3" stroke-dasharray="3 2"/>`;
        if (w > 40) o += `<text x="${x + 5}" y="${y + RH / 2 + 3.5}" font-size="12" fill="#5f6b7a">${esc(clip('Triage (est.)', w - 8))}</text>`;
        o += '</g>';
      } else {
        o += `<g data-r="${esc(r.id)}">${tip}<rect x="${x}" y="${y + 5}" width="${w}" height="${RH - 10}" rx="2" fill="${pal(b.stageIdx)}" ${r.triage ? 'fill-opacity=".55" ' : ''}stroke="rgba(0,0,0,.35)" stroke-width=".8"/>`;
        if (w > 64) o += `<text x="${x + 5}" y="${y + RH / 2 + 3.5}" font-size="12" fill="#fff">${esc(clip(b.name, w - 8))}</text>`;
        o += '</g>';
      }
    });
    const f = fc && fc.rows[r.id];
    if (f && r.end != null && f.p80 > r.end + 0.05) {
      const x1 = L.XW(r.end), x2 = L.XW(f.p80), my = y + RH / 2;
      o += `<g data-r="${esc(r.id)}"><title>${esc(r.name)}: 80% likely done by ${esc(shortDate(f.p80Date))}</title><line x1="${x1}" x2="${x2}" y1="${my}" y2="${my}" stroke="#5f6b7a" stroke-dasharray="2 2"/><line x1="${x2}" x2="${x2}" y1="${my - 4}" y2="${my + 4}" stroke="#5f6b7a"/></g>`;
    }
  });
  // dependency arrows (predecessor's completion point -> successor's start)
  (plan.links || []).forEach(l => {
    const pf = plan.rows.findIndex(r => r.id === l.from), pt = plan.rows.findIndex(r => r.id === l.to); if (pf < 0 || pt < 0) return;
    const y1 = HH + (pf + 1) * RH + RH / 2, y2 = HH + (pt + 1) * RH + RH / 2, x1 = L.XW(l.at), x2 = L.XW(l.toStart), xm = x1 + Math.min(6, Math.max(2, (x2 - x1) / 2));
    o += `<g class="dl" data-from="${esc(l.from)}" data-to="${esc(l.to)}"><title>Dependency: ${esc(plan.rows[pt].name)} starts after ${esc(plan.rows[pf].name)}</title><path class="dp" d="M${x1},${y1} H${xm} V${y2} H${x2 - 1}" fill="none" stroke="#5f6b7a" stroke-width="1.6" opacity=".9"/><polygon class="dh" points="${x2},${y2} ${x2 - 6},${y2 - 4} ${x2 - 6},${y2 + 4}" fill="#5f6b7a"/><circle cx="${x1}" cy="${y1}" r="2.5" fill="#5f6b7a" class="dh"/></g>`;
  });
  if (showToday()) {
    const now = Date.now();
    if (now >= L.t0 && now <= L.t1) {
      const x = L.X(now), lab = 'Today ' + shortDate(new Date(now));
      o += `<line x1="${x}" x2="${x}" y1="${HH}" y2="${H}" stroke="#d93025" stroke-width="1.5"/><rect x="${x - 34}" y="${HH + 1}" width="68" height="14" rx="3" fill="#d93025"/><text x="${x}" y="${HH + 11.5}" font-size="10.5" text-anchor="middle" fill="#fff" font-weight="600">Today</text>`;
    }
  }
  return o;
}
const L0 = w => Scheduler.addWeeks(Scheduler.parseDate(plan.startDate), w);
const SVG_DEFS = `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fff"/><line x1="0" y1="0" x2="0" y2="6" stroke="#b3bac4" stroke-width="2.5"/></pattern></defs>`;

function renderGantt() {
  if (activeTab !== 'timeline') return;
  const L = layout();
  // Detach any open inline picker first: replacing the markup under a focused picker fires its blur handler mid-removal.
  document.querySelectorAll('.cxpick').forEach(x => { x.onblur = null; if (x.parentNode) x.parentNode.removeChild(x); });
  $('#gantt').innerHTML = `<div class="gflex"><div class="gleft"><svg xmlns="http://www.w3.org/2000/svg" width="${lw()}" height="${L.height}">${SVG_DEFS}${leftSVG(L)}</svg></div>
    <div class="gscroll"><svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}">${SVG_DEFS}${rightSVG(L)}</svg></div></div>`;
  ganttHover(null);
  $('#legend').innerHTML = legendItems().map(i => `<span><i style="background:${i.c}"></i>${esc(i.t)}</span>`).join('');
}
function legendItems() {
  return [...state.config.stages.map((s, i) => ({ c: pal(i), t: s.name })),
    { c: '#e6e9ee', t: 'Stakeholder Triage (estimated, tentative)' }, { c: '#b3bac4', t: 'Waiting (capacity / developers)' }, { c: '#5f6b7a', t: '80% confidence tail' }];
}

function downloadCSV() {
  const cxName = k => (state.config.complexities.find(c => c.key === k) || {}).name || '';
  const stName = k => k === OOS ? 'Out of scope' : (state.config.stages.find(x => x.id === k) || {}).name || '';
  const q = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const idOf = id => { const i = state.items.find(x => x.id === id); return i ? (i.spId || i.name) : id; };
  const rows = [['ID', 'Title', 'Stage', 'Priority', 'Complexity', 'SME Required', 'Reuse', 'Item URL', 'Depends On', 'Comments']]
    .concat(state.items.map(i => [i.spId, i.name, stName(i.stage), i.priority, cxName(i.complexity), i.sme, i.reuse, itemUrl(i), (i.dependsOn || []).map(d => idOf(d.id) + (d.until ? '>' + stName(d.until) : '') + (d.fromBuild ? ' @build' : '') + (d.holdBuild ? ' @hold' : '')).join('; '), i.comments || '']));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' }));
  a.download = `work-planner-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
}


/* ---- Export analysis: one self-contained HTML report (summary, timeline, every use case with the values used, settings by category) ---- */
function exportAnalysis() {
  const c = state.config, stages = c.stages, stName = id => id === TRIAGE ? 'Stakeholder Triage' : id === OOS ? 'Out of scope' : (stages.find(x => x.id === id) || {}).name || '';
  const cxName = k => (c.complexities.find(x => x.key === k) || {}).name || '';
  const lvl = { H: 'High', M: 'Medium', L: 'Low' }, byId = Object.fromEntries(state.items.map(i => [i.id, i]));
  const d = x => x ? shortDate(x) : '';
  const dash = '<span class="na">–</span>';
  const td = (v, cls) => `<td${cls ? ` class="${cls}"` : ''}>${v === '' || v == null ? dash : v}</td>`;
  const th = (v, cls) => `<th${cls ? ` class="${cls}"` : ''}>${esc(v)}</th>`;
  const all = plan.allRows, rowOf = Object.fromEntries(all.map(r => [r.id, r]));
  const eng = r => r.bars.find(b => b.type === 'stage' && stages[b.stageIdx]?.kind === 'eng');
  const label = (it, r) => (it.spId || (r && r.rank) || '') + ' · ' + it.name;

  // Timeline: bars at true size (12px text), labelled with ID and name only. Always every use case in default order.
  const keep = plan.rows; let svg = '';
  try {
    plan.rows = all;
    const L = layout(lw() + 1000), LW = 250, W = LW + L.width, H = L.height + 34, ord = Scheduler.orderItems(state);
    let left = `<rect width="${LW}" height="${H}" fill="#fff"/><rect width="${LW}" height="${HH}" fill="#e9edf3"/><text x="8" y="${HH / 2 + 14}" font-size="12" font-weight="600" fill="#33404f">Use case</text>` +
      `<text x="8" y="${HH + RH / 2 + 4}" font-size="12" font-weight="700" fill="#1c2430">Programme</text><line x1="0" x2="${LW}" y1="${HH + RH}" y2="${HH + RH}" stroke="#e8eaed"/>`;
    ord.forEach((it, i) => { const y = HH + (i + 1) * RH; left += `<text x="8" y="${y + RH / 2 + 4}" font-size="12" fill="${it.stage === OOS ? '#8a94a3' : '#1c2430'}">${esc(clip(label(it, rowOf[it.id]), LW - 12))}</text><line x1="0" x2="${LW}" y1="${y + RH}" y2="${y + RH}" stroke="#e8eaed"/>`; });
    left += `<line x1="${LW}" x2="${LW}" y1="0" y2="${L.height}" stroke="#d5dae1"/>`;
    let lg = '', x = 10; legendItems().forEach(i => { lg += `<rect x="${x}" y="${L.height + 12}" width="10" height="10" rx="2" fill="${i.c}"/><text x="${x + 15}" y="${L.height + 21}" font-size="12" fill="#33404f">${esc(i.t)}</text>`; x += 15 + i.t.length * 6.2 + 18; });
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">${SVG_DEFS}<rect width="${W}" height="${H}" fill="#fff"/>${left}<g transform="translate(${LW},0)">${rightSVG(L)}</g>${lg}</svg>`;
  } finally { plan.rows = keep; }

  // Use cases: what was entered | the values the planner used | the forecast
  const depText = it => (it.dependsOn || []).map(x => { const o = byId[x.id]; return esc(o ? label(o, rowOf[o.id]) : '(missing)') + (x.until ? ` (until ${esc(stName(x.until))} is done)` : '') + (x.fromBuild ? ' (then starts at Build)' : '') + (x.holdBuild ? ' (only Build waits)' : ''); }).join('; ');
  const overrides = it => { const o = [];
    Object.entries(it.overrides || {}).forEach(([k, w]) => { if (w != null && w !== '') o.push(`${esc(stName(k))} fixed at ${wk(w)} wks`); });
    if (it.effortOverride != null && it.effortOverride !== '') o.push(`effort fixed at ${wk(it.effortOverride)} dev-wks`);
    if (it.teamCap != null && it.teamCap !== '') o.push(`max ${it.teamCap} developers`);
    if (it.earliestStart) o.push(`not before ${d(it.earliestStart)}`);
    if (it.stageStart) o.push(`in stage since ${d(it.stageStart)}`);
    if (it.triageWeeks != null && it.triageWeeks !== '') o.push(`triage ${wk(it.triageWeeks)} wks`);
    return o.join('; '); };
  const note = (k, v) => v ? `<div class="sub2"><b>${k}</b> ${v}</div>` : '';
  const rows = Scheduler.orderItems(state).map((it, i) => {
    const r = rowOf[it.id] || {}, e = r.bars && eng(r), f = fc && fc.rows[it.id], url = itemUrl(it);
    const smeF = it.sme ? c.smeFactors[it.sme] : null, reF = it.reuse ? c.reuseFactors[it.reuse] : (it.buildsOn ? c.reuseFactors.M : null);
    const base = r.effortBase != null ? wk(r.effortBase) : '', used = r.effort != null ? `<b>${wk(r.effort)}</b>` : '';
    const finish = r.endDate ? (r.triage ? '~' : '') + d(r.endDate) : (it.stage === OOS ? 'Out of scope' : '');
    return `<tr${it.stage === OOS ? ' class="oos"' : ''}>${td(i + 1, 'n')}<td class="name"><b>${esc(it.name)}</b>${url ? ` <a href="${esc(url)}">${esc(it.spId || 'link')} ↗</a>` : it.spId ? ` <span class="id">${esc(it.spId)}</span>` : ''}` +
      note('Depends on', depText(it)) + note('Overrides', overrides(it)) + note('Comment', esc(it.comments || '')) + '</td>' +
      td(esc(stName(it.stage))) + td(it.priority ?? '', 'n') + td(esc(cxName(it.complexity))) + td(it.sme ? `${lvl[it.sme]} (×${smeF})` : '') + td(it.reuse ? `${lvl[it.reuse]} (×${reF})${r.reusePending ? ' – pending' : ''}` : '') +
      td(base, 'n') + td(used, 'n') + td(e ? `${d(e.startDate)} → ${d(e.endDate)}${r.queueWeeks > 0 ? `<div class="sub2">waits ${wk(r.queueWeeks)} wks for developers</div>` : ''}` : '') + td(finish, 'n') + td(f ? d(f.p80Date) : '', 'n') + '</tr>';
  });
  const useCases = `<table class="uc"><thead><tr class="grp"><th></th><th></th><th colspan="5" class="g1">What you entered</th><th colspan="2" class="g2">Build effort (dev-wks)</th><th colspan="3" class="g3">Forecast</th></tr>
    <tr>${th('#', 'n')}${th('Use case')}${th('Stage')}${th('Priority', 'n')}${th('Complexity')}${th('SME required')}${th('Reuse')}${th('From complexity', 'n')}${th('Used (after Reuse)', 'n')}${th('Build dates')}${th('Planned finish', 'n')}${th('80% confident', 'n')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;

  // Settings: four equal cards
  const kv = (k, v, n) => `<tr>${th(k)}<td>${v}${n ? `<div class="sub2">${esc(n)}</div>` : ''}</td></tr>`;
  const general = `<table class="kv"><tbody>${kv('Developers', c.devResources, 'Shared engineering pool')}${kv('Max per use case', c.defaultTeamCap, 'Most developers on one use case')}${kv('Max in flight', c.wipLimit || 'none', 'Most use cases in progress at once')}${kv('Team overhead', Math.round((c.teamOverhead || 0) * 100) + '%', 'Throughput lost per extra developer')}${kv('Start date', d(c.startDate))}${kv('Triage estimate', wk(c.triageWeeks) + ' wks', 'Default Stakeholder Triage length')}${kv('SharePoint base URL', esc(c.spLinkBase || '') || dash)}</tbody></table>`;
  const stageTbl = `<table><thead><tr>${th('#', 'n')}${th('Stage')}${th('Length', 'n')}${th('SME applies')}${th('Reuse applies')}</tr></thead><tbody>${stages.map((st, i) => `<tr>${td(i + 1, 'n')}${td(esc(st.name))}${td(st.kind === 'eng' ? 'from size' : wk(st.weeks) + ' wks', 'n')}${td(st.sme ? 'Yes' : 'No')}${td(st.reuse ? 'Yes' : 'No')}</tr>`).join('')}</tbody></table>`;
  const sizeTbl = `<table><thead><tr>${th('Complexity')}${th('Best', 'n')}${th('Likely', 'n')}${th('Worst', 'n')}${th('Expected', 'n')}</tr></thead><tbody>${c.complexities.map(x => `<tr>${td(esc(x.name))}${td(x.min, 'n')}${td(x.effort, 'n')}${td(x.max, 'n')}${td(wk(Scheduler.pertMean(x)), 'n')}</tr>`).join('')}</tbody></table><div class="sub2">Developer-weeks of Build effort. Expected = (best + 4 × likely + worst) ÷ 6.</div>`;
  const facTbl = `<table><thead><tr>${th('Level')}${th('SME required', 'n')}${th('Reuse', 'n')}</tr></thead><tbody>${['H', 'M', 'L'].map(k => `<tr>${td(lvl[k])}${td('×' + c.smeFactors[k], 'n')}${td('×' + c.reuseFactors[k], 'n')}</tr>`).join('')}</tbody></table>
    <div class="sub2">SME multiplies the length of: ${stages.filter(s => s.sme).map(s => esc(s.name)).join(', ') || 'no stages'}.<br>Reuse multiplies the effort of: ${stages.filter(s => s.reuse).map(s => esc(s.name)).join(', ') || 'no stages'}.</div>`;

  const inScope = all.length - plan.oos, hasFc = !!fc, when = new Date().toISOString().slice(0, 10);
  const kpi = (k, v) => `<div class="kpi"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Work plan analysis ${when}</title><style>
  :root{--text:#1c2430;--muted:#5f6b7a;--line:#dfe3e8;--bg:#f6f7f9;--accent:#2f6fed}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  main{max-width:1400px;margin:0 auto;padding:28px 20px 56px}
  h1{font-size:24px;margin:0 0 2px} h2{font-size:16px;margin:32px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line)} h3{font-size:13px;margin:0 0 8px}
  .lead{color:var(--muted);margin:0 0 16px} .sub2{color:var(--muted);font-size:12px;margin-top:2px} .na{color:#b3bac4}
  .kpis{display:flex;flex-wrap:wrap;gap:10px} .kpi{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 16px;min-width:140px} .kpi .v{font-size:18px;font-weight:700} .kpi .k{color:var(--muted);font-size:12px}
  .card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:12px;align-items:start}
  table{border-collapse:collapse;width:100%;font-size:12px} th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top} thead th{background:#eef1f5;font-weight:600;white-space:nowrap}
  .n{text-align:right;font-variant-numeric:tabular-nums} table.kv th{background:none;font-weight:600;width:140px;white-space:normal} table.kv td{vertical-align:top;overflow-wrap:anywhere} .grid thead th{white-space:normal}
  .uc .grp th{background:none;border-bottom:2px solid var(--line);text-align:center;color:var(--muted);font-size:12px;padding-bottom:2px} .uc .g1{border-left:1px solid var(--line)} .uc .g2,.uc .g3{border-left:1px solid var(--line)}
  .uc td.name{min-width:260px} .uc tbody tr:nth-child(even){background:#fafbfc} tr.oos td{color:#8a94a3} .id{color:var(--muted)} a{color:var(--accent);text-decoration:none}
  .foot{color:var(--muted);font-size:12px;margin-top:20px} svg{display:block;max-width:100%;height:auto}
  @media print{body{background:#fff} main{padding:0} h2{break-after:avoid} tr{break-inside:avoid} .card{border:none;padding:0}} @page{size:A3 landscape;margin:12mm}
  </style></head><body><main>
  <h1>Work plan analysis</h1><p class="lead">Generated ${when} · ${inScope} use cases${plan.oos ? ` (+${plan.oos} out of scope)` : ''} · ${c.devResources} developers · starts ${d(c.startDate)}</p>
  <div class="kpis">${kpi('Planned finish', d(plan.endDate))}${kpi('Total duration', wk(plan.totalWeeks) + ' wks')}${kpi('Total effort', Math.round(plan.totalEffort) + ' dev-wks')}${hasFc ? kpi('50% confident by', d(fc.p50.date)) + kpi('80% confident by', d(fc.p80.date)) + kpi('90% confident by', d(fc.p90.date)) : ''}${plan.triage ? kpi('In triage (tentative)', plan.triage) : ''}${plan.unscheduled ? kpi('Unscheduled', plan.unscheduled) : ''}</div>
  <h2>Timeline</h2><div class="card">${svg}</div>
  <h2>Use cases</h2><div class="card">${useCases}</div>
  <p class="foot">Use cases are handed developers in this order: most advanced stage first, then priority. <b>Build effort</b>: “From complexity” is the expected developer-weeks for the use case's complexity (Settings); “Used” is that figure after the Reuse factor, which is what the plan schedules. <b>Planned finish</b> uses the expected effort; “~” marks a tentative date for a use case still in triage. ${hasFc ? `<b>80% confident</b> comes from ${fc.iterations} simulated runs that vary effort between best and worst case.` : ''}</p>
  <h2>Settings</h2><div class="grid"><div class="card"><h3>General</h3>${general}</div><div class="card"><h3>Stages</h3>${stageTbl}</div><div class="card"><h3>Engineering size by complexity</h3>${sizeTbl}</div><div class="card"><h3>SME required and Reuse factors</h3>${facTbl}</div></div>
  <script type="application/json" id="work-planner-data">${JSON.stringify({ app: 'work-planner-analysis', version: 1, exported: when, config: c, items: state.items }).replace(/</g, '\\u003c')}</script>
  </main></body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = `work-planner-analysis-${when}.html`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return html;
}

function downloadPNG() {
  const L = layout(1800), TH = 34, LG = 30, W = lw() + L.width, H = TH + L.height + LG;
  const title = `Work plan · ${state.config.devResources} developers · planned finish ${shortDate(plan.endDate)}` +
    (fc ? ` · 80% confident by ${shortDate(fc.p80.date)}` : '');
  let lg = '', x = 10;
  legendItems().forEach(i => { lg += `<rect x="${x}" y="${TH + L.height + 10}" width="10" height="10" rx="2" fill="${i.c}"/><text x="${x + 15}" y="${TH + L.height + 19}" font-size="12" fill="#33404f">${esc(i.t)}</text>`; x += 15 + i.t.length * 6 + 18; });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Helvetica, Arial, sans-serif">${SVG_DEFS}
    <rect width="${W}" height="${H}" fill="#fff"/><text x="10" y="22" font-size="15" font-weight="700" fill="#1c2430">${esc(title)}</text>
    <g transform="translate(0,${TH})">${leftSVG(L, false)}</g><g transform="translate(${lw()},${TH})">${rightSVG(L)}</g>${lg}</svg>`;
  const scale = Math.min(2, 16000 / W), img = new Image();
  img.onload = () => {
    const cv = document.createElement('canvas'); cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height);
    cv.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `work-plan-${Scheduler.fmtDate(new Date())}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }, 'image/png');
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
init();


// Hover highlighting: the row under the mouse, the use cases it waits on (amber) and the ones waiting on it (purple),
// with the connecting arrows emphasised and everything else faded.
let hoverRow = null;
function chainOf(id) {
  const links = plan.links || [], up = new Set(), down = new Set();
  const walk = (set, from, key, other) => { const st = [from]; while (st.length) { const c = st.pop(); links.forEach(l => { if (l[key] === c && !set.has(l[other]) && l[other] !== id) { set.add(l[other]); st.push(l[other]); } }); } };
  walk(up, id, 'to', 'from'); walk(down, id, 'from', 'to');
  return { up, down };
}
function ganttHover(id) {
  const g = $('#gantt'); if (!g || !plan) return;
  hoverRow = id;
  const svgs = g.querySelectorAll('svg');
  g.querySelectorAll('.hlband').forEach(x => x.remove());
  g.querySelectorAll('[data-r]').forEach(x => x.style.opacity = '');
  g.querySelectorAll('.dl').forEach(x => { x.style.opacity = ''; x.querySelector('.dp').setAttribute('stroke', '#5f6b7a'); x.querySelector('.dp').setAttribute('stroke-width', '1.6'); x.querySelectorAll('.dh').forEach(h => h.setAttribute('fill', '#5f6b7a')); });
  let info = document.getElementById('chaininfo');
  if (!info) { info = document.createElement('div'); info.id = 'chaininfo'; info.className = 'hint'; $('#legend').insertAdjacentElement('afterend', info); }
  if (!id) { info.textContent = 'Hover a row to see what it waits on and what waits on it.'; return; }
  const { up, down } = chainOf(id), all = new Set([id, ...up, ...down]);
  const name = x => (plan.allRows.find(r => r.id === x) || {}).name || x;
  const tint = x => x === id ? 'rgba(47,111,237,.14)' : up.has(x) ? 'rgba(224,138,0,.18)' : 'rgba(124,58,237,.14)';
  svgs.forEach(svg => {
    if (!svg.closest('.gscroll')) return;
    const bg = svg.querySelector(':scope > rect'); const ref = bg.nextSibling;
    plan.rows.forEach((r, i) => {
      if (!all.has(r.id)) return;
      const rc = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rc.setAttribute('class', 'hlband'); rc.setAttribute('x', 0); rc.setAttribute('width', svg.getAttribute('width'));
      rc.setAttribute('y', HH + (i + 1) * RH); rc.setAttribute('height', RH); rc.setAttribute('fill', tint(r.id)); rc.setAttribute('pointer-events', 'none');
      svg.insertBefore(rc, ref);
    });
  });
  g.querySelectorAll('[data-r]').forEach(x => { if (!all.has(x.dataset.r)) x.style.opacity = '.3'; });
  g.querySelectorAll('.dl').forEach(x => {
    const f = x.dataset.from, t = x.dataset.to;
    const hit = (t === id || up.has(t)) && up.has(f) || (f === id || down.has(f)) && down.has(t) || (t === id && f !== id && up.has(f)) || (f === id && down.has(t));
    if (!hit) { x.style.opacity = '.12'; return; }
    const col = (t === id || up.has(t)) ? '#e08a00' : '#7c3aed';
    x.querySelector('.dp').setAttribute('stroke', col); x.querySelector('.dp').setAttribute('stroke-width', '2.6'); x.querySelectorAll('.dh').forEach(h => h.setAttribute('fill', col));
  });
  const parts = [];
  if (up.size) parts.push(`<b style="color:#9a5b00">Waits on</b> ${[...up].map(x => esc(name(x))).join(', ')}`);
  if (down.size) parts.push(`<b style="color:#6d28d9">Blocks</b> ${[...down].map(x => esc(name(x))).join(', ')}`);
  info.innerHTML = `<b>${esc(name(id))}</b>` + (parts.length ? ' — ' + parts.join(' · ') : ' — no dependencies');
}
document.addEventListener('DOMContentLoaded', () => {
  const g = $('#gantt'); if (!g) return;
  g.addEventListener('mousemove', e => {
    if (!plan || !e.target.closest) return;
    const svg = e.target.closest('svg'); if (!svg) return;
    if (!svg.closest('.gscroll')) { if (hoverRow) ganttHover(null); return; }   // only the chart side, not the table
    const zf = Number(document.body.style.zoom) || 1, y = (e.clientY - svg.getBoundingClientRect().top) / zf;
    const i = Math.floor((y - HH) / RH) - 1, r = i >= 0 ? plan.rows[i] : null, id = r ? r.id : null;
    if (id !== hoverRow) ganttHover(id);
  });
  g.addEventListener('mouseleave', () => { if (hoverRow) ganttHover(null); });
});
