// Zero-dependency server: serves ./public and persists planner state to data.json.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { defaultState, schedule, normalize } = require('./public/scheduler.js');

const PORT = process.env.PORT || 3417;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data.json');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
};

function loadState() {
  try { return normalize(JSON.parse(fs.readFileSync(DATA, 'utf8'))); }
  catch { return defaultState(); }
}
function saveState(state) {
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA);
}
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
function valid(s) {
  return s && s.config && Array.isArray(s.items) && Array.isArray(s.config.stages) &&
    Array.isArray(s.config.complexities) &&
    /^\d{4}-\d{2}-\d{2}$/.test(s.config.startDate);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, loadState());
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const state = JSON.parse(await readBody(req));
      if (!valid(state)) return json(res, 400, { error: 'invalid state' });
      saveState(state);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/schedule' && req.method === 'GET') return json(res, 200, schedule(loadState()));

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`Work planner running at http://localhost:${PORT}`));
