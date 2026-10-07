#!/usr/bin/env node
// Usage: node src/cli.js <url> [--json]
const { audit } = require('./audit');

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));
if (!url) { console.error('Usage: geo-audit <url> [--json]'); process.exit(1); }

const icon = { pass: '\x1b[32m✔\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✘\x1b[0m', info: '\x1b[36mi\x1b[0m' };

audit(url).then(r => {
  if (args.includes('--json')) return console.log(JSON.stringify(r, null, 2));
  if (r.error) { console.error(r.error); process.exit(2); }
  console.log(`\nAI visibility score for ${r.finalUrl}: ${r.score}/100 (${r.grade})\n`);
  for (const c of r.categories) console.log(`  ${String(c.score).padStart(3)}  ${c.label}`);
  for (const cat of r.categories) {
    console.log(`\n== ${cat.label} ==`);
    for (const c of r.checks.filter(x => x.category === cat.key)) console.log(`  ${icon[c.status]} ${c.title}\n      ${c.detail}`);
  }
  console.log('\n== Top fixes ==');
  r.fixes.slice(0, 8).forEach((f, i) => console.log(`  ${i + 1}. ${f.title}: ${f.fix.split('\n')[0]}`));
  if (r.generated.llmsTxt) console.log('\n== Draft /llms.txt ==\n' + r.generated.llmsTxt);
  if (r.generated.jsonLd) console.log('== Draft JSON-LD ==\n' + r.generated.jsonLd);
}).catch(e => { console.error(e); process.exit(2); });
