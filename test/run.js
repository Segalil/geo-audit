// Spins up two local fixture sites and checks the audit tells them apart.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { audit, parseRobots, isAllowed } = require('../src/audit');

function serve(dir, port) {
  return new Promise(r => {
    const s = http.createServer((req, res) => {
      const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const f = path.join(__dirname, 'fixtures', dir, p);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200); fs.createReadStream(f).pipe(res);
    }).listen(port, () => r(s));
  });
}

(async () => {
  // robots parsing unit checks
  const r = parseRobots('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/ok$\n');
  assert.equal(isAllowed(r, 'ClaudeBot', '/').allowed, false);
  assert.equal(isAllowed(r, 'PerplexityBot', '/').allowed, true);
  assert.equal(isAllowed(r, 'PerplexityBot', '/private/x').allowed, false);
  assert.equal(isAllowed(r, 'PerplexityBot', '/private/ok').allowed, true);

  const servers = [await serve('good', 4101), await serve('bad', 4102)];
  const good = await audit('http://127.0.0.1:4101/');
  const bad = await audit('http://127.0.0.1:4102/');
  servers.forEach(s => s.close());

  const fmt = rep => `${rep.score} (${rep.grade}) ` + rep.categories.map(c => `${c.key}=${c.score}`).join(' ');
  console.log('good:', fmt(good));
  console.log('  remaining fixes:', good.fixes.map(f => f.id).join(', ') || 'none');
  console.log('bad: ', fmt(bad));
  console.log('  top fixes:', bad.fixes.slice(0, 5).map(f => f.id).join(', '));

  assert(good.score >= 85, 'good site should score >= 85');
  assert(bad.score <= 40, 'bad site should be capped at 40');
  assert.equal(bad.checks.find(c => c.id === 'ai-search-bots').status, 'fail');
  assert.equal(bad.checks.find(c => c.id === 'ssr').status, 'fail');
  assert(bad.generated.llmsTxt && bad.generated.jsonLd, 'bad site gets generated drafts');
  assert.equal(good.generated.llmsTxt, null);
  console.log('\nAll tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
