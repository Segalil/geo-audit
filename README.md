# GEO Audit: make a site visible to generative AI

Paste a URL, get an "AI visibility" score (0–100), a per-category breakdown,
a prioritized fix list, and ready-to-paste `/llms.txt` and JSON-LD drafts.

```
node src/server.js          # web UI at http://localhost:3000
node src/cli.js example.com # terminal report (add --json for raw output)
node test/run.js            # tests against two local fixture sites
```
Zero dependencies, Node 18+.

## What it checks (and why)

| Category | Checks | Why it matters |
|---|---|---|
| Crawler access | robots.txt rules for 15 AI bots (OAI-SearchBot, ChatGPT-User, GPTBot, Claude-SearchBot, Claude-User, ClaudeBot, PerplexityBot, Google-Extended, Googlebot, Bingbot, CCBot…), noindex / noai, HTTP status, HTTPS, response time | If the answer engine's fetcher is blocked or times out, you cannot be cited. Search bots and training bots are scored separately: blocking training is a business choice, blocking search bots is a visibility failure. |
| AI discovery files | /llms.txt (format), /llms-full.txt, sitemap.xml, canonical | Curated, machine-friendly map of your key content. |
| Readable without JS | words of text in raw HTML, SPA-shell detection, text/code ratio, `<main>/<article>` | Most AI crawlers don't execute JavaScript; a client-rendered page looks empty to them. |
| Structured data | JSON-LD validity and types, Organization/Person entity, sameAs, content type (Article/Product/FAQPage…) | Tells models unambiguously who you are and what the page is. |
| Content clarity | title, meta description, lang, Open Graph, one H1, section headings, question-style headings/FAQ, lists/tables, concrete numbers | Models retrieve and quote passages; direct answers to real questions with specific facts get cited. |
| Trust & freshness | outbound citations, author, visible/structured dates, About/Contact links, image alt text | E-E-A-T style signals; GEO research found citing sources and adding statistics raise citation rates. |

Hard gate: if AI search bots are blocked, the page is noindex, or the content
needs JavaScript, the score is capped at 39 (F), whatever else is right.

## Product plan

**MVP (this prototype):** single-URL audit, score, fixes, generated llms.txt and JSON-LD.

**Next:**
1. Site-wide crawl: follow the sitemap, audit top N pages, site-level report.
2. Rendered vs raw comparison with a headless browser, to show exactly what JS hides from bots.
3. "Am I cited?" monitoring: ask ChatGPT/Claude/Perplexity/Gemini a set of buyer questions on a schedule and track whether and how the brand is mentioned and linked (share of voice vs competitors).
4. Fix generators: full llms.txt from the sitemap, FAQ drafting from page content with an LLM, schema per page type.
5. Monetize: free single-page audit as the lead magnet; paid tier for site crawls, monitoring, competitor tracking and a WordPress/Shopify plugin that applies fixes.
