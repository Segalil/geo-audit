// Tiny web server: serves the UI and exposes GET /api/audit?url=...
const http = require('http');
const fs = require('fs');
const path = require('path');
const { audit } = require('./audit');

const PORT = process.env.PORT || 3000;
const indexHtml = path.join(__dirname, '..', 'public', 'index.html');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/audit') {
    const target = u.searchParams.get('url');
    if (!target) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"url is required"}'); }
    try {
      const report = await audit(target);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(indexHtml).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log(`GEO Audit running at http://localhost:${PORT}`));
