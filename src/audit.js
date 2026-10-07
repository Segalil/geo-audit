// Core audit engine: fetches a page plus robots.txt, llms.txt and sitemap,
// runs checks grouped by category, and returns a scored report with fixes.
// Zero dependencies (Node 18+ for global fetch).

const UA = 'GEO-Audit/0.1 (+https://github.com/; AI visibility checker)';

// AI crawlers that matter. "search" bots decide whether you can be cited in
// live answers; "training" bots decide whether you're in model training data.
const AI_BOTS = [
  { name: 'OAI-SearchBot', owner: 'OpenAI (ChatGPT search)', kind: 'search' },
  { name: 'ChatGPT-User', owner: 'OpenAI (user-triggered browsing)', kind: 'search' },
  { name: 'GPTBot', owner: 'OpenAI (training)', kind: 'training' },
  { name: 'Claude-SearchBot', owner: 'Anthropic (Claude search)', kind: 'search' },
  { name: 'Claude-User', owner: 'Anthropic (user-triggered fetch)', kind: 'search' },
  { name: 'ClaudeBot', owner: 'Anthropic (training)', kind: 'training' },
  { name: 'PerplexityBot', owner: 'Perplexity (search index)', kind: 'search' },
  { name: 'Perplexity-User', owner: 'Perplexity (user-triggered fetch)', kind: 'search' },
  { name: 'Google-Extended', owner: 'Google (Gemini training/grounding)', kind: 'training' },
  { name: 'Googlebot', owner: 'Google (Search + AI Overviews)', kind: 'search' },
  { name: 'Bingbot', owner: 'Microsoft (Bing + Copilot)', kind: 'search' },
  { name: 'Applebot-Extended', owner: 'Apple (Apple Intelligence training)', kind: 'training' },
  { name: 'CCBot', owner: 'Common Crawl (used by many LLMs)', kind: 'training' },
  { name: 'meta-externalagent', owner: 'Meta (AI)', kind: 'training' },
  { name: 'Amazonbot', owner: 'Amazon (Alexa/AI)', kind: 'search' },
];

async function get(url, timeoutMs = 15000) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, headers: res.headers, body, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, error: err.cause?.message || err.message, body: '', ms: Date.now() - started };
  }
}

// ---------- robots.txt ----------
function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  const sitemaps = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'sitemap') { sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function ruleMatches(rulePath, path) {
  if (rulePath === '') return false;
  const anchored = rulePath.endsWith('$');
  const pattern = rulePath.replace(/\$$/, '').split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + pattern + (anchored ? '$' : '')).test(path);
}

// Standard robots semantics: most specific matching group, longest matching rule wins.
function isAllowed(robots, bot, path) {
  const name = bot.toLowerCase();
  let group = robots.groups.find(g => g.agents.includes(name))
    || robots.groups.find(g => g.agents.some(a => a !== '*' && name.startsWith(a)))
    || robots.groups.find(g => g.agents.includes('*'));
  if (!group) return { allowed: true, via: 'no matching group' };
  let best = null;
  for (const r of group.rules) {
    if (ruleMatches(r.path, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  const via = group.agents.includes('*') && !group.agents.includes(name) ? 'User-agent: *' : `User-agent: ${bot}`;
  return { allowed: !best || best.allow, via };
}

// ---------- HTML helpers (regex based; good enough for an audit) ----------
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTags = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function metaContent(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const n = (attr(tag, 'name') || attr(tag, 'property') || '').toLowerCase();
    if (n === key) return attr(tag, 'content');
  }
  return null;
}

function visibleText(html) {
  let body = (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [, html])[1];
  body = body.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  return stripTags(body);
}

function mainText(html) {
  const m = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  return m ? visibleText(m[2]) : null;
}

function headings(html) {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m => ({ level: +m[1], text: stripTags(m[2]) }));
}

function jsonLd(html) {
  const blocks = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { blocks.push({ ok: true, data: JSON.parse(m[1].trim()) }); }
    catch (e) { blocks.push({ ok: false, error: e.message }); }
  }
  const types = new Set();
  const nodes = [];
  const walk = n => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n['@type']) { [].concat(n['@type']).forEach(t => types.add(String(t))); nodes.push(n); }
    for (const v of Object.values(n)) if (typeof v === 'object') walk(v);
  };
  blocks.filter(b => b.ok).forEach(b => walk(b.data));
  return { blocks, types: [...types], nodes };
}

// ---------- checks ----------
// Each check: { id, category, title, status: pass|warn|fail|info, weight, detail, fix }
function check(category, id, title, status, weight, detail, fix) {
  return { category, id, title, status, weight, detail, fix: status === 'pass' || status === 'info' ? null : fix };
}

async function audit(inputUrl, opts = {}) {
  let url = inputUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const target = new URL(url);
  const origin = target.origin;

  const [page, robotsRes, llmsRes, llmsFullRes] = await Promise.all([
    get(target.href, opts.timeoutMs),
    get(origin + '/robots.txt', opts.timeoutMs),
    get(origin + '/llms.txt', opts.timeoutMs),
    get(origin + '/llms-full.txt', opts.timeoutMs),
  ]);

  if (!page.ok && !page.body) {
    return { url: target.href, error: `Could not fetch page: ${page.error || 'HTTP ' + page.status}`, score: 0, checks: [] };
  }

  const html = page.body;
  const finalUrl = new URL(page.url || target.href);
  const path = finalUrl.pathname + finalUrl.search;
  const checks = [];
  const C = (...a) => checks.push(check(...a));

  // ===== 1. Crawler access =====
  const robotsOk = robotsRes.ok && !/<html/i.test(robotsRes.body.slice(0, 500));
  const robots = robotsOk ? parseRobots(robotsRes.body) : { groups: [], sitemaps: [] };
  const botAccess = AI_BOTS.map(b => ({ ...b, ...isAllowed(robots, b.name, path) }));
  const blockedSearch = botAccess.filter(b => b.kind === 'search' && !b.allowed);
  const blockedTraining = botAccess.filter(b => b.kind === 'training' && !b.allowed);

  C('access', 'robots-present', 'robots.txt is reachable', robotsOk ? 'pass' : 'warn', 1,
    robotsOk ? `${robots.groups.length} user-agent group(s) found.` : `No valid robots.txt (HTTP ${robotsRes.status}). Crawlers will assume everything is allowed, but you lose control and a place to list your sitemap.`,
    'Add a /robots.txt that explicitly allows the AI search crawlers and lists your sitemap.');
  C('access', 'ai-search-bots', 'AI search & answer crawlers can read this page', blockedSearch.length === 0 ? 'pass' : 'fail', 5,
    blockedSearch.length ? `Blocked: ${blockedSearch.map(b => `${b.name} (${b.owner})`).join(', ')}. These bots fetch pages to cite them in live answers.` : 'OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot, Googlebot, Bingbot and others are allowed.',
    `Allow these in robots.txt:\n${blockedSearch.map(b => `User-agent: ${b.name}\nAllow: /`).join('\n\n')}`);
  C('access', 'ai-training-bots', 'AI training crawlers', blockedTraining.length === 0 ? 'pass' : 'info', 0,
    blockedTraining.length ? `Blocked: ${blockedTraining.map(b => b.name).join(', ')}. This is a business choice: blocking training bots keeps content out of future models but does not stop live citations.` : 'All training crawlers allowed, so your content can shape what future models know about you.',
    null);

  const xRobots = (page.headers?.get('x-robots-tag') || '').toLowerCase();
  const metaRobots = (metaContent(html, 'robots') || '').toLowerCase();
  const noindex = /noindex|none/.test(xRobots + ' ' + metaRobots);
  const noai = /noai|noimageai/.test(xRobots + ' ' + metaRobots);
  C('access', 'indexable', 'Page is indexable', noindex ? 'fail' : 'pass', 4,
    noindex ? `Found noindex (meta robots: "${metaRobots}", X-Robots-Tag: "${xRobots}"). Search engines that feed AI answers will drop this page.` : 'No noindex directive.',
    'Remove noindex from the robots meta tag / X-Robots-Tag header.');
  if (noai) C('access', 'noai', '"noai" directive present', 'warn', 1, 'A noai/noimageai directive signals AI systems not to use this content.', 'Remove "noai" unless you intend to opt out of AI usage.');

  C('access', 'status', 'Page returns HTTP 200', page.status === 200 ? 'pass' : 'fail', 3,
    `HTTP ${page.status} in ${page.ms} ms${finalUrl.href !== target.href ? ` (redirected to ${finalUrl.href})` : ''}.`, 'Make sure the canonical URL returns 200 directly.');
  C('access', 'https', 'Served over HTTPS', finalUrl.protocol === 'https:' ? 'pass' : 'warn', 1, finalUrl.protocol, 'Serve the site over HTTPS and redirect HTTP to it.');
  C('access', 'speed', 'Responds quickly', page.ms < 1500 ? 'pass' : page.ms < 4000 ? 'warn' : 'fail', 2,
    `First response in ${page.ms} ms. AI fetchers often give up after a few seconds.`, 'Cache HTML at the edge/CDN and reduce server response time below ~1.5s.');

  // ===== 2. Machine-readable discovery =====
  const llms = llmsRes.ok && !/<html/i.test(llmsRes.body.slice(0, 500)) ? llmsRes.body : null;
  if (llms) {
    const hasH1 = /^#\s+\S/m.test(llms);
    const hasSummary = /^>\s+\S/m.test(llms);
    const links = (llms.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;
    const good = hasH1 && links > 0;
    C('discovery', 'llms-txt', '/llms.txt exists', good ? 'pass' : 'warn', 3,
      `Found (${llms.length} chars, ${links} links, H1: ${hasH1 ? 'yes' : 'no'}, summary blockquote: ${hasSummary ? 'yes' : 'no'}).`,
      'Follow the llms.txt format: "# Site name", a "> one-line summary", then "## Sections" of markdown links to your key pages.');
  } else {
    C('discovery', 'llms-txt', '/llms.txt exists', 'warn', 3,
      'No /llms.txt. This emerging standard gives LLMs a curated, markdown map of your most important content.',
      'Publish /llms.txt (see the generated draft in this report).');
  }
  C('discovery', 'llms-full', '/llms-full.txt exists', llmsFullRes.ok && !/<html/i.test(llmsFullRes.body.slice(0, 500)) ? 'pass' : 'info', 0,
    llmsFullRes.ok ? 'Found.' : 'Optional: a single markdown file with your full docs/content, handy for developer docs.', null);

  let sitemapUrl = robots.sitemaps[0] || origin + '/sitemap.xml';
  const sm = await get(sitemapUrl, opts.timeoutMs);
  const smOk = sm.ok && /<(urlset|sitemapindex)\b/i.test(sm.body);
  C('discovery', 'sitemap', 'XML sitemap available', smOk ? 'pass' : 'warn', 2,
    smOk ? `${sitemapUrl} (${(sm.body.match(/<loc>/gi) || []).length} entries)${robots.sitemaps.length ? ', referenced in robots.txt' : ', not referenced in robots.txt'}.` : `No sitemap at ${sitemapUrl}.`,
    'Publish /sitemap.xml with <lastmod> dates and reference it in robots.txt with "Sitemap: https://…/sitemap.xml".');

  const canonical = (html.match(/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i) || [])[0];
  C('discovery', 'canonical', 'Canonical URL set', canonical ? 'pass' : 'warn', 1,
    canonical ? attr(canonical, 'href') : 'No <link rel="canonical">, so duplicate URLs may split citations.', 'Add <link rel="canonical" href="…"> with the preferred URL.');

  // ===== 3. Rendering: can a non-JS bot see the content? =====
  const text = visibleText(html);
  const words = text ? text.split(/\s+/).length : 0;
  const scriptBytes = (html.match(/<script\b[\s\S]*?<\/script>/gi) || []).join('').length;
  const spaShell = /<div[^>]+id\s*=\s*["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html);
  const ssrStatus = words >= 150 ? 'pass' : words >= 40 ? 'warn' : 'fail';
  C('rendering', 'ssr', 'Content is in the HTML (no JavaScript needed)', ssrStatus, 5,
    `${words} words of visible text in the raw HTML${spaShell ? '; looks like an empty client-side app shell' : ''}. Most AI crawlers (GPTBot, ClaudeBot, PerplexityBot) do not run JavaScript.`,
    'Server-render or pre-render pages (SSR/SSG, e.g. Next.js/Nuxt/Astro static output) so the text is in the initial HTML.');
  const ratio = html.length ? Math.round((text.length / html.length) * 100) : 0;
  C('rendering', 'text-ratio', 'Healthy text-to-code ratio', ratio >= 10 ? 'pass' : 'warn', 1,
    `${ratio}% of the HTML is readable text (${Math.round(html.length / 1024)} KB HTML, ${Math.round(scriptBytes / 1024)} KB inline script).`,
    'Move large inline scripts/JSON blobs to external files; keep the HTML lean and text-first.');
  C('rendering', 'semantic', 'Uses semantic <main>/<article>', /<(main|article)\b/i.test(html) ? 'pass' : 'warn', 1,
    /<(main|article)\b/i.test(html) ? 'Found.' : 'No <main> or <article>, so extractors must guess which text is the real content.',
    'Wrap the primary content in <main> (and posts in <article>) so it is separated from nav and footer.');

  // ===== 4. Structured data =====
  const ld = jsonLd(html);
  const badLd = ld.blocks.filter(b => !b.ok);
  C('structured', 'jsonld', 'Has JSON-LD structured data', ld.types.length ? (badLd.length ? 'warn' : 'pass') : 'fail', 4,
    ld.blocks.length ? `Types: ${ld.types.join(', ') || 'none'}${badLd.length ? `; ${badLd.length} block(s) are invalid JSON (${badLd[0].error})` : ''}.` : 'No schema.org JSON-LD. Structured data tells AI exactly what entity, product, article or FAQ this page is about.',
    badLd.length && ld.types.length ? 'Fix the invalid JSON-LD blocks.' : 'Add schema.org JSON-LD (see the generated snippet in this report).');
  const hasEntity = ld.types.some(t => /^(Organization|LocalBusiness|Corporation|Person|WebSite|.*Store|Restaurant|ProfessionalService)$/.test(t));
  C('structured', 'entity', 'Identifies who is behind the site (Organization/Person)', hasEntity ? 'pass' : 'warn', 2,
    hasEntity ? 'Entity markup found.' : 'No Organization/Person/WebSite markup. AI uses this to connect your brand to facts about it.',
    'Add Organization (or Person) JSON-LD with name, url, logo and sameAs links to your official profiles (LinkedIn, Wikipedia, Crunchbase, social).');
  const sameAs = ld.nodes.some(n => n.sameAs);
  C('structured', 'sameas', 'Links to official profiles (sameAs)', sameAs ? 'pass' : 'warn', 1,
    sameAs ? 'Found sameAs.' : 'No sameAs links, so models have a harder time confirming your identity across the web.', 'Add "sameAs": [ … ] to your Organization/Person JSON-LD.');
  const contentType = ld.types.find(t => /Article|BlogPosting|NewsArticle|Product|FAQPage|HowTo|Recipe|Event|Course|SoftwareApplication|Service|QAPage/.test(t));
  C('structured', 'content-type', 'Describes the page content type', contentType ? 'pass' : 'info', 1,
    contentType ? `Content type: ${contentType}.` : 'If this page is an article, product, FAQ or how-to, mark it up with the matching schema.org type.', null);

  // ===== 5. Content clarity & meta =====
  const title = stripTags((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  C('content', 'title', 'Descriptive <title>', title.length >= 15 && title.length <= 70 ? 'pass' : title ? 'warn' : 'fail', 2,
    title ? `"${title}" (${title.length} chars)` : 'Missing <title>.', 'Write a 15–70 character title that names the topic and the brand.');
  const desc = metaContent(html, 'description') || '';
  C('content', 'description', 'Meta description summarises the page', desc.length >= 50 && desc.length <= 170 ? 'pass' : desc ? 'warn' : 'fail', 2,
    desc ? `"${desc.slice(0, 160)}" (${desc.length} chars)` : 'Missing meta description; AI snippets and link previews will guess.',
    'Add a 50–160 character meta description that states plainly what the page offers.');
  const lang = attr((html.match(/<html\b[^>]*>/i) || [''])[0], 'lang');
  C('content', 'lang', 'Language declared', lang ? 'pass' : 'warn', 1, lang ? `lang="${lang}"` : 'No lang on <html>.', 'Add <html lang="en"> (or your language).');
  const og = ['og:title', 'og:description', 'og:image'].filter(k => metaContent(html, k));
  C('content', 'opengraph', 'Open Graph tags', og.length === 3 ? 'pass' : 'warn', 1, `Found ${og.length}/3: ${og.join(', ') || 'none'}.`, 'Add og:title, og:description and og:image.');

  const hs = headings(html);
  const h1s = hs.filter(h => h.level === 1);
  C('content', 'h1', 'Exactly one clear H1', h1s.length === 1 ? 'pass' : 'warn', 2,
    h1s.length ? `${h1s.length} H1: ${h1s.map(h => `"${h.text.slice(0, 60)}"`).join(', ')}` : 'No H1.', 'Use one H1 that states the page topic in plain words.');
  const sub = hs.filter(h => h.level === 2 || h.level === 3);
  C('content', 'structure', 'Content is broken into sections', sub.length >= 3 || words < 300 ? 'pass' : 'warn', 2,
    `${sub.length} H2/H3 headings for ${words} words.`, 'Split long content into sections with descriptive H2/H3 headings; AI retrieves and quotes passages section by section.');
  const questions = hs.filter(h => /\?$|^(what|how|why|when|who|which|can|does|is|are|should)\b/i.test(h.text));
  const hasFaq = ld.types.includes('FAQPage') || questions.length >= 2;
  C('content', 'questions', 'Answers real questions (Q&A / FAQ)', hasFaq ? 'pass' : 'warn', 2,
    hasFaq ? `${questions.length} question-style headings${ld.types.includes('FAQPage') ? ', FAQPage markup' : ''}.` : 'No question-style headings or FAQ. People ask AI questions; pages that answer them directly get quoted.',
    'Add an FAQ section with headings phrased as the questions customers ask, each followed by a direct 1–3 sentence answer, and mark it up with FAQPage JSON-LD.');
  const lists = (html.match(/<(ul|ol|table|dl)\b/gi) || []).length;
  C('content', 'scannable', 'Uses lists or tables', lists > 0 ? 'pass' : 'warn', 1, `${lists} list/table element(s).`, 'Present key facts, steps, specs and comparisons as lists or tables, which models extract cleanly.');
  const body = mainText(html) || text;
  const stats = (body.match(/\b\d+(?:[.,]\d+)?\s?(%|percent|million|billion|k\b|x\b|users|customers|years)/gi) || []).length;
  C('content', 'facts', 'Contains concrete facts and numbers', stats >= 2 ? 'pass' : 'warn', 1,
    `${stats} statistic-like phrases found.`, 'Add specific, verifiable facts (numbers, dates, prices, results). Studies of generative engines show quotable statistics raise citation rates.');

  // ===== 6. Trust & freshness (E-E-A-T) =====
  const outLinks = [...html.matchAll(/<a\b[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map(m => { try { return new URL(m[1]).host; } catch { return null; } })
    .filter(h => h && h !== finalUrl.host);
  C('trust', 'citations', 'Cites external sources', new Set(outLinks).size >= 2 ? 'pass' : 'warn', 1,
    `${new Set(outLinks).size} distinct external domains linked.`, 'Link to authoritative sources for claims you make; citing sources is one of the strongest measured GEO signals.');
  const author = metaContent(html, 'author') || ld.nodes.find(n => n.author)?.author || /\brel\s*=\s*["']author["']/i.test(html) || /\bby\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(body);
  C('trust', 'author', 'Shows who wrote / owns the content', author ? 'pass' : 'warn', 1, author ? 'Author or owner signal found.' : 'No author byline or author markup.',
    'Show an author byline with credentials and add "author" to Article JSON-LD.');
  const dateLd = ld.nodes.find(n => n.dateModified || n.datePublished);
  const timeTag = /<time\b[^>]*datetime/i.test(html) || metaContent(html, 'article:modified_time') || metaContent(html, 'article:published_time');
  const lastMod = page.headers?.get('last-modified');
  C('trust', 'freshness', 'Publish / update date is visible', dateLd || timeTag ? 'pass' : 'warn', 1,
    dateLd ? `JSON-LD date: ${dateLd.dateModified || dateLd.datePublished}` : timeTag ? 'Found <time>/article date meta.' : `No machine-readable date${lastMod ? ` (Last-Modified header: ${lastMod})` : ''}. AI prefers fresh, dated content.`,
    'Show "Last updated <date>" in a <time datetime="…"> tag and add datePublished/dateModified to JSON-LD.');
  const internal = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map(m => m[1].toLowerCase());
  const hasAbout = internal.some(h => /about|team|company|who-we-are/.test(h));
  const hasContact = internal.some(h => /contact|support|mailto:/.test(h));
  C('trust', 'about-contact', 'Links to About and Contact pages', hasAbout && hasContact ? 'pass' : 'warn', 1,
    `About: ${hasAbout ? 'yes' : 'no'}, Contact: ${hasContact ? 'yes' : 'no'}.`, 'Link to About and Contact pages from every page; they establish who you are.');
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter(t => !attr(t, 'alt'));
  C('trust', 'alt', 'Images have alt text', noAlt.length === 0 ? 'pass' : noAlt.length / imgs.length < 0.2 ? 'warn' : 'fail', 1,
    `${imgs.length - noAlt.length}/${imgs.length} images have alt text.`, 'Describe every meaningful image with alt text; multimodal models and crawlers rely on it.');

  // ===== scoring =====
  const CATS = {
    access: 'Crawler access', discovery: 'AI discovery files', rendering: 'Readable without JavaScript',
    structured: 'Structured data', content: 'Content clarity', trust: 'Trust & freshness',
  };
  const val = { pass: 1, warn: 0.5, fail: 0 };
  const categories = Object.entries(CATS).map(([key, label]) => {
    const cs = checks.filter(c => c.category === key && c.weight > 0 && c.status !== 'info');
    const w = cs.reduce((s, c) => s + c.weight, 0);
    const got = cs.reduce((s, c) => s + c.weight * val[c.status], 0);
    return { key, label, score: w ? Math.round((got / w) * 100) : 100 };
  });
  const scored = checks.filter(c => c.status !== 'info');
  const totalW = scored.reduce((s, c) => s + c.weight, 0);
  const got = scored.reduce((s, c) => s + c.weight * val[c.status], 0);
  let score = Math.round((got / totalW) * 100);
  // Hard gate: if AI can't fetch or read the page, nothing else matters much.
  if (blockedSearch.length || noindex || ssrStatus === 'fail') score = Math.min(score, 39);

  const fixes = checks.filter(c => c.fix).sort((a, b) => (b.weight * (1 - val[b.status])) - (a.weight * (1 - val[a.status])));

  return {
    url: target.href, finalUrl: finalUrl.href, fetchedAt: new Date().toISOString(),
    score, grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F',
    categories, checks, fixes, bots: botAccess,
    generated: {
      llmsTxt: llms ? null : draftLlmsTxt({ title, desc, origin, html, finalUrl }),
      jsonLd: ld.types.length ? null : draftJsonLd({ title, desc, origin, html }),
    },
  };
}

function draftLlmsTxt({ title, desc, origin, html, finalUrl }) {
  const siteName = metaContent(html, 'og:site_name') || title.split(/\s[|\-–—]\s/).pop() || finalUrl.host;
  const seen = new Set();
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u; try { u = new URL(m[1], finalUrl); } catch { continue; }
    const label = stripTags(m[2]);
    if (u.origin !== origin || !label || label.length > 60 || seen.has(u.pathname) || u.pathname === '/') continue;
    seen.add(u.pathname); links.push(`- [${label}](${u.href})`);
    if (links.length >= 12) break;
  }
  return `# ${siteName}\n\n> ${desc || 'One-sentence description of what this site/company offers and for whom.'}\n\nKey facts: who you are, where you operate, what makes you different (edit me).\n\n## Main pages\n\n${links.join('\n') || `- [Home](${origin}/): Overview`}\n\n## Optional\n\n- [About](${origin}/about): Company background\n- [Contact](${origin}/contact): How to reach us\n`;
}

function draftJsonLd({ title, desc, origin, html }) {
  const name = metaContent(html, 'og:site_name') || title.split(/\s[|\-–—]\s/).pop() || new URL(origin).host;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': origin + '/#org', name, url: origin + '/', logo: origin + '/logo.png', sameAs: ['https://www.linkedin.com/company/…', 'https://x.com/…'] },
      { '@type': 'WebSite', '@id': origin + '/#website', url: origin + '/', name, publisher: { '@id': origin + '/#org' } },
      { '@type': 'WebPage', name: title, description: desc || undefined, isPartOf: { '@id': origin + '/#website' }, dateModified: new Date().toISOString().slice(0, 10) },
    ],
  }, null, 2);
}

module.exports = { audit, parseRobots, isAllowed, AI_BOTS };
