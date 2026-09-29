const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = d => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day:'numeric', month:'short', year:'2-digit', timeZone:'UTC' });
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
  bind(); renderStages(); renderSizes(); renderRows(); update();
}
function bind() {
  const c = () => state.config;
  $('#devs').oninput = e => { c().devResources = Number(e.target.value); update(); };
  $('#cap').oninput = e => { c().defaultTeamCap = Number(e.target.value); update(); };
  $('#wip').oninput = e => { c().wipLimit = Number(e.target.value) || 0; update(); };
  $('#ovh').oninput = e => { c().teamOverhead = (Number(e.target.value) || 0) / 100; update(); };
  $('#start').oninput = e => { if (e.target.value) { c().startDate = e.target.value; update(); } };
  $('#zoom').oninput = () => { $('#fit').checked = false; lsSet('fit', '0'); renderGantt(); };
  $('#fit').checked = lsGet('fit') !== '0';
  $('#fit').onchange = () => { lsSet('fit', $('#fit').checked ? '1' : '0'); renderGantt(); };
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  showTab(lsGet('tab') || 'timeline');
  window.addEventListener('resize', () => { if (activeTab === 'timeline') renderGantt(); });
  try { if (localStorage.getItem('todayLine') === '0') $('#today').checked = false; } catch {}
  $('#today').onchange = () => { try { localStorage.setItem('todayLine', $('#today').checked ? '1' : '0'); } catch {} renderGantt(); };
  $('#png').onclick = downloadPNG;
  $('#add').onclick = () => { state.items.push(newItem('New use case')); renderRows(); update(); };
  $('#import').onclick = openImport;
  $('#bulk').onclick = () => {
    const t = prompt('One use case name per line:'); if (!t) return;
    t.split('\n').map(s => s.trim()).filter(Boolean).forEach(n => state.items.push(newItem(n)));
    renderRows(); update();
  };
  $('#reset').onclick = async () => {
    if (!confirm('Replace everything with the sample data?')) return;
    state = Scheduler.normalize(await getJSON('api/seed')); syncInputs(); renderStages(); renderSizes(); renderRows(); update();
  };
  document.querySelectorAll('.capbar input[data-nudge]').forEach(inp => {
    const wrap = document.createElement('span'); wrap.className = 'step';
    inp.before(wrap);
    const mk = (t, dir, tip) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.title = tip; b.onclick = () => nudge(inp, dir); return b; };
    wrap.append(mk('−', -1, 'Decrease'), inp, mk('+', 1, 'Increase'));
  });
  syncInputs();
}
function nudge(inp, dir) {
  const n = Number(inp.dataset.nudge);
  if (inp.type === 'date') {
    inp.value = Scheduler.fmtDate(Scheduler.addWeeks(Scheduler.parseDate(inp.value || state.config.startDate), dir * n / 7));
  } else {
    const min = inp.min !== '' ? Number(inp.min) : 0, max = inp.max !== '' ? Number(inp.max) : Infinity;
    inp.value = Math.min(max, Math.max(min, Math.round(((Number(inp.value) || 0) + dir * n) * 100) / 100));
  }
  inp.dispatchEvent(new Event('input'));
}
function syncInputs() {
  const c = state.config;
  $('#devs').value = c.devResources; $('#cap').value = c.defaultTeamCap; $('#wip').value = c.wipLimit || ''; $('#ovh').value = Math.round((c.teamOverhead || 0) * 100); $('#start').value = c.startDate;
}
const newItem = name => ({ id: uid('uc'), name, complexity: state.config.complexities[1]?.key || state.config.complexities[0].key,
  teamCap: null, effortOverride: null, earliestStart: null, overrides: {} });

/* ---- stages: one ordered list of editable chips ---- */
function renderStages() {
  const st = state.config.stages, box = $('#stages'); box.innerHTML = '';
  st.forEach((s, i) => {
    const eng = s.kind === 'eng';
    const el = document.createElement('div'); el.className = 'chip' + (eng ? ' eng' : ''); el.style.setProperty('--c', color(i));
    el.innerHTML = `<input type="text" value="${esc(s.name)}" aria-label="Stage name">
      ${eng ? `<span class="by" title="Set by complexity and developers">by complexity</span>`
            : `<input type="number" min="0" step="1" value="${s.weeks ?? 0}" aria-label="Weeks"><span class="muted">wk</span>`}
      <span class="tools">
        <button data-a="l" title="Move earlier">◀</button><button data-a="r" title="Move later">▶</button>
        ${eng ? '' : `<button data-a="eng" title="Make this the engineering stage (length driven by complexity &amp; developers)">⚙</button><button data-a="del" title="Remove stage">✕</button>`}
      </span>`;
    const [name, weeks] = el.querySelectorAll('input');
    name.oninput = () => { s.name = name.value; update(); };
    if (weeks) weeks.oninput = () => { s.weeks = Number(weeks.value); update(); };
    el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'l' || a === 'r') { const k = i + (a === 'l' ? -1 : 1); if (k < 0 || k >= st.length) return; [st[i], st[k]] = [st[k], st[i]]; }
      else if (a === 'del') { st.splice(i, 1); }
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
function renderRows() {
  const tb = $('#rows'); tb.innerHTML = '';
  state.items.forEach((it, i) => {
    const tr = document.createElement('tr'); tr.dataset.id = it.id;
    const opts = state.config.complexities.map(c => `<option value="${c.key}" ${c.key === it.complexity ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const link = safeUrl(it.url);
    tr.innerHTML = `<td class="num">${i + 1}</td>
      <td class="calc">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener" title="Open in SharePoint">${esc(it.spId || 'link')} ↗</a>` : esc(it.spId || '')}</td>
      <td><input type="text" data-f="name" value="${esc(it.name)}"></td>
      <td><select data-f="complexity">${opts}</select></td>
      <td class="calc" data-c="eng"></td><td class="calc" data-c="end"></td><td class="calc" data-c="p80"></td>
      <td style="white-space:nowrap">
        <button class="ghost" data-a="details" title="Overrides">${open.has(it.id) ? '▾' : '▸'} details</button>
        <button class="ghost" data-a="up" title="Higher priority">↑</button><button class="ghost" data-a="down" title="Lower priority">↓</button><button class="ghost" data-a="del" title="Delete">✕</button>
      </td>`;
    tr.querySelectorAll('[data-f]').forEach(el => el.oninput = () => { it[el.dataset.f] = el.value; update(); });
    tr.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a, j = state.items.indexOf(it);
      if (a === 'details') { open.has(it.id) ? open.delete(it.id) : open.add(it.id); }
      else if (a === 'del') state.items.splice(j, 1);
      else { const k = a === 'up' ? j - 1 : j + 1; if (k < 0 || k >= state.items.length) return; [state.items[j], state.items[k]] = [state.items[k], state.items[j]]; }
      renderRows(); update();
    });
    tb.appendChild(tr);
    if (open.has(it.id)) tb.appendChild(detailsRow(it));
  });
}
function detailsRow(it) {
  const tr = document.createElement('tr'); tr.className = 'details';
  const fixed = state.config.stages.filter(s => s.kind !== 'eng');
  tr.innerHTML = `<td></td><td colspan="7"><div class="dgrid">
    <label title="ID of the item in the SharePoint list">SharePoint ID <input type="text" data-t="spId" value="${esc(it.spId ?? '')}"></label>
    <label title="Link to the SharePoint list item (http/https)">URL <input type="text" data-t="url" style="width:280px" placeholder="https://…" value="${esc(it.url ?? '')}"></label>
    <label title="Fixed engineering effort for this use case, replacing the estimate from its complexity. Blank = use complexity.">Engineering dev-weeks <input type="number" min="0" data-k="effortOverride" placeholder="auto" value="${it.effortOverride ?? ''}"></label>
    <label title="Most developers on this use case at once. Blank = use the global Max per use case.">Max devs <input type="number" min="0.5" step="0.5" data-k="teamCap" placeholder="default" value="${it.teamCap ?? ''}"></label>
    <label title="Earliest date this use case may start. Blank = as soon as a slot is free.">Not before <input type="date" data-k="earliestStart" value="${it.earliestStart ?? ''}"></label>
    ${fixed.map(s => `<label title="Weeks for this stage on this use case only. Blank = the stage default (${s.weeks}).">${esc(s.name)} wks <input type="number" min="0" data-s="${s.id}" placeholder="${s.weeks}" value="${it.overrides[s.id] ?? ''}"></label>`).join('')}
  </div><div class="hint">Overrides apply to this use case only. Leave a box empty to use the default shown in grey.</div></td>`;
  tr.querySelectorAll('[data-t]').forEach(el => el.oninput = () => { it[el.dataset.t] = el.value.trim() || null; update(); });
  tr.querySelectorAll('[data-k]').forEach(el => el.oninput = () => { it[el.dataset.k] = el.type === 'date' ? (el.value || null) : num(el.value); update(); });
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
};
function matchComplexity(val) {
  const cxs = state.config.complexities, v = String(val || '').trim().toLowerCase();
  if (!v) return null;
  const hit = cxs.find(c => c.key.toLowerCase() === v || c.name.toLowerCase() === v); if (hit) return hit.key;
  const alias = { l:0, s:0, xs:0, small:0, simple:0, easy:0, '1':0, m:1, med:1, medium:1, moderate:1, '2':1, h:2, large:2, complex:2, hard:2, '3':2,
    vh:3, xl:3, xlarge:3, 'extra large':3, 'very complex':3, '4':3 };
  return v in alias ? cxs[Math.min(alias[v], cxs.length - 1)].key : null;
}
function openImport() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.csv,text/csv,.txt';
  inp.onchange = async () => { const f = inp.files[0]; if (f) showImport(parseCSV(await f.text()), f.name); };
  inp.click();
}
function planImport(rows, map, prefix, mode) {
  const head = rows[0], col = k => map[k] === '' ? -1 : head.indexOf(map[k]);
  const ci = { id: col('id'), name: col('name'), cx: col('complexity'), url: col('url') };
  const out = { items: [], adds: 0, updates: 0, skipped: 0, unmatched: new Set() };
  const seen = new Set();
  rows.slice(1).forEach(r => {
    const g = i => i < 0 ? '' : String(r[i] ?? '').replace(/\s+/g, ' ').trim();
    const spId = g(ci.id), name = g(ci.name);
    if (!name && !spId) { out.skipped++; return; }
    let url = safeUrl(g(ci.url));
    if (!url && prefix && spId) url = safeUrl(prefix + encodeURIComponent(spId));
    let cx = ci.cx >= 0 ? matchComplexity(g(ci.cx)) : null;
    if (ci.cx >= 0 && !cx && g(ci.cx)) out.unmatched.add(g(ci.cx));
    const existing = mode === 'update' && spId && state.items.find(i => i.spId === spId);
    out.items.push({ spId, name: name || ('Use case ' + spId), url, cx, existing });
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
      <label title="Used when a row has no URL: this text + the item's ID">Link prefix</label>
      <input type="text" id="imp-prefix" placeholder="https://tenant.sharepoint.com/sites/team/Lists/UseCases/DispForm.aspx?ID=" value="${esc(state.config.spLinkBase || '')}">
      <label>If ID already exists</label>
      <select id="imp-mode"><option value="update">Update it, add the rest</option><option value="add">Add everything as new</option><option value="replace">Replace all existing use cases</option></select>
    </div>
    <div class="preview" id="imp-prev"></div>
    <div class="actions"><span class="hint grow">Complexity can be a level name (Low, Medium…), S/M/L/XL, or 1–4. Existing items keep their overrides.</span><button id="imp-cancel">Cancel</button><button class="primary" id="imp-go">Import</button></div>`;
  document.body.appendChild(dlg);
  const read = () => ({ map: Object.fromEntries([...dlg.querySelectorAll('[data-m]')].map(e => [e.dataset.m, e.value])), prefix: dlg.querySelector('#imp-prefix').value.trim(), mode: dlg.querySelector('#imp-mode').value });
  const preview = () => {
    const { map, prefix, mode } = read();
    const p = planImport(rows, map, prefix, mode === 'update' ? 'update' : 'add');
    const sample = p.items.slice(0, 4).map(i => `<div>${esc(i.spId || '–')} · ${esc(i.name)} · ${esc(i.cx || 'default complexity')} · ${i.url ? esc(i.url) : 'no link'}</div>`).join('');
    dlg.querySelector('#imp-prev').innerHTML = `<b>${mode === 'replace' ? p.items.length + ' will replace all existing' : p.adds + ' new, ' + p.updates + ' updated'}</b>${p.skipped ? ` · ${p.skipped} blank rows skipped` : ''}` +
      (!map.name ? `<div class="warn">Choose a Name column.</div>` : '') +
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
    p.items.forEach(i => {
      if (i.existing) { i.existing.name = i.name; if (i.url) i.existing.url = i.url; if (i.cx) i.existing.complexity = i.cx; return; }
      state.items.push({ id: uid('uc'), spId: i.spId || null, name: i.name, url: i.url || null, complexity: i.cx || dflt,
        teamCap: null, effortOverride: null, earliestStart: null, overrides: {} });
    });
    state.config.spLinkBase = prefix || undefined;
    $('#importMsg').textContent = `Imported ${p.adds} new, ${p.updates} updated`;
    dlg.close(); dlg.remove(); renderRows(); update();
  };
  dlg.showModal();
}

/* ---- recompute + draw ---- */
function update() {
  plan = Scheduler.schedule(state);
  fc = plan.unscheduled ? null : Scheduler.forecast(state);
  const hasEng = state.config.stages.some(s => s.kind === 'eng');
  $('#summary').innerHTML = hasEng && plan.rows.length && plan.unscheduled === plan.rows.length
    ? `<span class="warn">No developers — engineering can't be scheduled</span>`
    : `<b>${plan.rows.length}</b> use cases · <b>${Math.round(plan.totalEffort)}</b> dev-weeks · planned finish <b>${fmt(plan.endDate)}</b> <span class="muted">(${wk(plan.totalWeeks)} wks)</span>` +
      (fc ? ` · <span title="Monte Carlo: ${fc.iterations} simulated runs sampling effort between best and worst case">50%: <b>${fmt(fc.p50.date)}</b> · 80%: <b>${fmt(fc.p80.date)}</b> · 90%: <b>${fmt(fc.p90.date)}</b></span>` : '') +
      (plan.unscheduled ? ` · <span class="warn">${plan.unscheduled} unscheduled</span>` : '');
  plan.rows.forEach(r => {
    const tr = document.querySelector(`tr[data-id="${r.id}"]`); if (!tr) return;
    const e = r.bars.find(b => b.type === 'stage' && state.config.stages[b.stageIdx]?.kind === 'eng');
    tr.querySelector('[data-c=eng]').textContent = e ? `${fmt(e.startDate)} → ${fmt(e.endDate)}` + (r.queueWeeks > 0 ? ` · queued ${wk(r.queueWeeks)}w` : '') : '—';
    tr.querySelector('[data-c=end]').textContent = r.endDate ? fmt(r.endDate) : '—';
    const f = fc && fc.rows[r.id]; tr.querySelector('[data-c=p80]').textContent = f ? fmt(f.p80Date) : '—';
  });
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

/* ---- Gantt: one SVG design used for both screen and PNG export ---- */
const PAL = ['#8b6fd6','#e39a2d','#2f6fed','#1aa39a','#3aa356','#8a94a3','#d6577f','#a0803a'];
const pal = i => PAL[i % PAL.length];
const RH = 24, HH = 44, DAYMS = 86400000;
const LCOLS = [['id',56,'ID'],['name',206,'Task name'],['dur',66,'Duration'],['start',82,'Start'],['end',82,'Finish']];
const LW = LCOLS.reduce((a, c) => a + c[1], 0);
let activeTab = 'timeline';
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function showTab(t) {
  if (!document.getElementById('tab-' + t)) t = 'timeline';
  activeTab = t; lsSet('tab', t);
  document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== 'tab-' + t);
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if (t === 'timeline' && plan) renderGantt();
}
const showToday = () => $('#today').checked;
const safeUrl = u => { try { const x = new URL(String(u || '').trim()); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const clip = (t, w) => { t = String(t); const n = Math.floor(w / 6.2); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const shortDate = d => fmt(typeof d === 'string' ? d : Scheduler.fmtDate(d));

function layout(exportW) {
  const start = Scheduler.parseDate(plan.startDate);
  const endW = Math.max(plan.totalWeeks, fc ? fc.p80.weeks : 0) + 2;
  const last = Scheduler.addWeeks(start, endW);
  const first = showToday() && Date.now() < start ? new Date() : start;
  const t0 = new Date(Date.UTC(first.getUTCFullYear(), Math.floor(first.getUTCMonth() / 3) * 3, 1));
  const t1 = new Date(Date.UTC(last.getUTCFullYear(), Math.floor(last.getUTCMonth() / 3) * 3 + 3, 1));
  const avail = (exportW || $('#gantt').clientWidth) - LW - 4;
  const ppd = (exportW || $('#fit').checked) && avail > 200 ? avail / ((t1 - t0) / DAYMS) : Number($('#zoom').value) / 2;
  const X = ms => (ms - t0) / DAYMS * ppd;
  return { ppd, start, t0, t1, X, XW: w => X(start.getTime() + w * 7 * DAYMS), width: Math.ceil(X(t1)), height: HH + (plan.rows.length + 1) * RH };
}

function leftSVG(L) {
  const H = L.height; let o = `<rect width="${LW}" height="${H}" fill="#fff"/><rect width="${LW}" height="${HH}" fill="#e9edf3"/>`;
  let x = 0; const xs = [];
  LCOLS.forEach(c => { xs.push(x); o += `<text x="${x + 6}" y="${HH / 2 + 14}" font-size="11" font-weight="600" fill="#33404f">${c[2]}</text>`; x += c[1]; o += `<line x1="${x}" x2="${x}" y1="0" y2="${H}" stroke="#d5dae1"/>`; });
  const rows = [{ id: 0, name: 'Programme', bold: true, dur: plan.totalWeeks, start: plan.startDate, end: plan.endDate }]
    .concat(plan.rows.map((r, i) => { const f = r.bars.find(b => b.type === 'stage') || r.bars[0];
      const it = state.items[i] || {};
      return { id: it.spId || (i + 1), url: safeUrl(it.url), name: r.name, dur: r.end != null && f ? r.end - f.start : null, start: f ? f.startDate : null, end: r.endDate }; }));
  rows.forEach((r, i) => {
    const y = HH + i * RH, ty = y + RH / 2 + 4, w = r.bold ? 'font-weight="700"' : '';
    o += `<line x1="0" x2="${LW}" y1="${y + RH}" y2="${y + RH}" stroke="#e8eaed"/>`;
    const vals = [i === 0 ? '' : r.id, clip(r.name, LCOLS[1][1] - 10), r.dur != null ? wk(r.dur) + ' wks' : '—', r.start ? shortDate(r.start) : '—', r.end ? shortDate(r.end) : '—'];
    vals.forEach((v, k) => {
      const linked = r.url && k < 2 && v !== '';
      const t = `<text x="${xs[k] + 6}" y="${ty}" font-size="11.5" fill="${linked ? '#0b57d0' : '#1c2430'}" ${w}${linked ? ' text-decoration="underline"' : ''}>${esc(v)}</text>`;
      o += linked ? `<a href="${esc(r.url)}" target="_blank" rel="noopener"><title>Open in SharePoint: ${esc(r.name)}</title>${t}</a>` : t;
    });
  });
  return `<line x1="0" x2="${LW}" y1="${HH}" y2="${HH}" stroke="#9aa3ad"/>` + o;
}

function rightSVG(L) {
  const H = L.height, W = L.width;
  let o = `<rect width="${W}" height="${H}" fill="#fff"/><rect width="${W}" height="${HH}" fill="#e9edf3"/>`;
  let grid = '', hdr = '';
  for (let d = new Date(L.t0); d < L.t1;) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), nx = new Date(Date.UTC(y, m + 1, 1));
    const x1 = L.X(d), x2 = L.X(nx), isQ = m % 3 === 0;
    hdr += `<text x="${(x1 + x2) / 2}" y="${HH - 7}" font-size="10.5" text-anchor="middle" fill="#33404f">${d.toLocaleDateString('en', { month: (x2 - x1) > 30 ? 'short' : 'narrow', timeZone: 'UTC' })}</text>`;
    grid += `<line x1="${x1}" x2="${x1}" y1="${isQ ? 0 : HH / 2}" y2="${H}" stroke="${isQ ? '#8b95a1' : '#e2e5ea'}"/>`;
    if (isQ) {
      const q2 = L.X(new Date(Date.UTC(y, m + 3, 1)));
      hdr += `<text x="${(x1 + q2) / 2}" y="${HH / 2 - 6}" font-size="11" font-weight="600" text-anchor="middle" fill="#1c2430">Q${m / 3 + 1} ${y}</text>`;
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
      const tip = `<title>${esc(r.name)} — ${esc(b.name)}: ${esc(shortDate(b.startDate))} → ${esc(shortDate(b.endDate))} (${wk(b.end - b.start)} wks)</title>`;
      if (b.type === 'queue') o += `<g>${tip}<rect x="${x}" y="${y + 9}" width="${w}" height="6" fill="url(#hatch)" stroke="#b3bac4" stroke-dasharray="3 2"/></g>`;
      else {
        o += `<g>${tip}<rect x="${x}" y="${y + 5}" width="${w}" height="${RH - 10}" rx="2" fill="${pal(b.stageIdx)}" stroke="rgba(0,0,0,.35)" stroke-width=".8"/>`;
        if (w > 64) o += `<text x="${x + 5}" y="${y + RH / 2 + 3.5}" font-size="10" fill="#fff">${esc(clip(b.name, w - 8))}</text>`;
        o += '</g>';
      }
    });
    const f = fc && fc.rows[r.id];
    if (f && r.end != null && f.p80 > r.end + 0.05) {
      const x1 = L.XW(r.end), x2 = L.XW(f.p80), my = y + RH / 2;
      o += `<g><title>${esc(r.name)}: 80% likely done by ${esc(shortDate(f.p80Date))}</title><line x1="${x1}" x2="${x2}" y1="${my}" y2="${my}" stroke="#5f6b7a" stroke-dasharray="2 2"/><line x1="${x2}" x2="${x2}" y1="${my - 4}" y2="${my + 4}" stroke="#5f6b7a"/></g>`;
    }
  });
  if (showToday()) {
    const now = Date.now();
    if (now >= L.t0 && now <= L.t1) {
      const x = L.X(now), lab = 'Today ' + shortDate(new Date(now));
      o += `<line x1="${x}" x2="${x}" y1="${HH}" y2="${H}" stroke="#d93025" stroke-width="1.5"/><rect x="${x - 34}" y="${HH + 1}" width="68" height="14" rx="3" fill="#d93025"/><text x="${x}" y="${HH + 11.5}" font-size="9.5" text-anchor="middle" fill="#fff" font-weight="600">Today</text>`;
    }
  }
  return o;
}
const SVG_DEFS = `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fff"/><line x1="0" y1="0" x2="0" y2="6" stroke="#b3bac4" stroke-width="2.5"/></pattern></defs>`;

function renderGantt() {
  if (activeTab !== 'timeline') return;
  const L = layout();
  $('#gantt').innerHTML = `<div class="gflex"><div class="gleft"><svg xmlns="http://www.w3.org/2000/svg" width="${LW}" height="${L.height}">${SVG_DEFS}${leftSVG(L)}</svg></div>
    <div class="gscroll"><svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}">${SVG_DEFS}${rightSVG(L)}</svg></div></div>`;
  $('#legend').innerHTML = legendItems().map(i => `<span><i style="background:${i.c}"></i>${esc(i.t)}</span>`).join('');
}
function legendItems() {
  return [...state.config.stages.map((s, i) => ({ c: pal(i), t: s.name })),
    { c: '#b3bac4', t: 'Waiting (capacity / developers)' }, { c: '#5f6b7a', t: '80% confidence tail' }];
}

function downloadPNG() {
  const L = layout(1800), TH = 34, LG = 30, W = LW + L.width, H = TH + L.height + LG;
  const title = `Work plan · ${state.config.devResources} developers · planned finish ${shortDate(plan.endDate)}` +
    (fc ? ` · 80% confident by ${shortDate(fc.p80.date)}` : '');
  let lg = '', x = 10;
  legendItems().forEach(i => { lg += `<rect x="${x}" y="${TH + L.height + 10}" width="10" height="10" rx="2" fill="${i.c}"/><text x="${x + 15}" y="${TH + L.height + 19}" font-size="11" fill="#33404f">${esc(i.t)}</text>`; x += 15 + i.t.length * 6 + 18; });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Helvetica, Arial, sans-serif">${SVG_DEFS}
    <rect width="${W}" height="${H}" fill="#fff"/><text x="10" y="22" font-size="15" font-weight="700" fill="#1c2430">${esc(title)}</text>
    <g transform="translate(0,${TH})">${leftSVG(L)}</g><g transform="translate(${LW},${TH})">${rightSVG(L)}</g>${lg}</svg>`;
  const scale = Math.min(2, 16000 / W), img = new Image();
  img.onload = () => {
    const cv = document.createElement('canvas'); cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height);
    cv.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `work-plan-${Scheduler.fmtDate(new Date())}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }, 'image/png');
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
init();
