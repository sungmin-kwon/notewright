// notewright: a local web app that drafts a note for the site with an LLM API, shows the tokens
// and estimated cost of every call, and opens the draft as a pull request on the site repo.
// Start with `npm start` and open http://localhost:4318. Needs Node 20.12+; `npm install` fetches the two preview libraries.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadEnv } from './lib/env.mjs';
import { siteContext, referenceNote } from './lib/site.mjs';
import { buildDraftPrompt, revisePrompt } from './lib/prompt.mjs';
import { splitReply, pinFrontmatter, guessSlug, getField } from './lib/output.mjs';
import { checkDraft } from './lib/checks.mjs';
import { estimateCost, sumUsage } from './lib/cost.mjs';
import { logCall, saveDraft, readCalls } from './lib/log.mjs';
import { openFilePR } from './lib/github.mjs';
import { prBody } from './lib/pr.mjs';
import { provider, TOOLS } from './providers/index.mjs';

loadEnv();
const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const PORT = Number(process.env.PORT) || 4318;
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

// One session per note being drafted: its settings and every call made for it.
const sessions = new Map();

const modelById = (id) => {
  const m = cfg.models.find((x) => x.id === id);
  if (!m) throw new Error(`model "${id}" is not in config.json`);
  return m;
};

async function runCall({ session, stage, model, request }) {
  const started = Date.now();
  const entry = { ts: new Date().toISOString(), session: session.id, stage, provider: model.provider, model: model.id, label: model.label };
  try {
    const r = await provider(model.provider).call({ model: model.id, ...request });
    const cost = estimateCost(r.usage, model, cfg);
    const done = { ...entry, servedModel: r.servedModel, tools: request.tools ?? session.tools, usage: r.usage, cost, ms: Date.now() - started, ok: true, references: r.references.length };
    logCall({ ...done, topic: session.brief.topic, tags: session.brief.tags });
    session.calls.push(done);
    session.state = r.state;
    for (const ref of r.references) if (!session.references.some((x) => (x.url ?? x.title) === (ref.url ?? ref.title))) session.references.push(ref);
    saveDraft(`${session.id}-${session.calls.length}.md`, r.text);
    return r;
  } catch (e) {
    logCall({ ...entry, topic: session.brief.topic, ms: Date.now() - started, ok: false, error: String(e.message ?? e) });
    throw e;
  }
}

async function result(session, r, ctx) {
  const { markdown: raw, prNotes, preamble } = splitReply(r.text);
  const { markdown, changed } = pinFrontmatter(raw, { date: today(), tags: session.brief.tags, modelLabels: [...session.modelLabels] });
  const slug = session.brief.slug || guessSlug(markdown, prNotes);
  session.prNotes = prNotes;
  return {
    session: session.id,
    markdown,
    prNotes,
    preamble,
    pinned: changed,
    slug,
    exists: ctx.noteIds.includes(slug),
    checks: checkDraft(markdown, { sections: ctx.sections, tags: session.brief.tags }),
    references: session.references,
    calls: session.calls,
    total: sumUsage(session.calls),
  };
}

const routes = {
  'GET /api/config': async () => {
    const ctx = await siteContext(cfg);
    return {
      models: cfg.models.map(({ id, label, provider: p, price }) => ({ id, label, provider: p, price, tools: TOOLS[p] ?? [] })),
      defaultModel: cfg.defaultModel,
      tools: cfg.tools,
      referenceNotes: cfg.referenceNotes,
      site: { repo: cfg.site.repo, branch: cfg.site.branch, sha: ctx.sha, fetchedAt: ctx.fetchedAt },
      sections: ctx.sections,
      conventions: ctx.conventions.map(({ name, path, title }) => ({ name, path, title })),
      noteIds: ctx.noteIds,
      keys: { mistral: !!process.env.MISTRAL_API_KEY, github: !!process.env.GITHUB_TOKEN },
      today: today(),
    };
  },

  'POST /api/reload': async () => {
    await siteContext(cfg, { refresh: true });
    return routes['GET /api/config']();
  },

  'POST /api/draft': async (body) => {
    const ctx = await siteContext(cfg);
    const model = modelById(body.model);
    const brief = {
      topic: String(body.topic ?? '').trim(),
      notes: body.notes ?? '',
      tags: body.tags ?? [],
      slug: (body.slug ?? '').trim(),
      bar: body.bar,
      length: body.length,
    };
    if (!brief.topic) throw new Error('give a topic');
    if (!brief.tags.length) throw new Error('pick at least one tag');
    const tools = (body.tools ?? []).filter((t) => (TOOLS[model.provider] ?? []).includes(t));
    const conventions = ctx.conventions.filter((c) => (body.conventions ?? []).includes(c.path));
    const reference = await referenceNote(cfg, body.reference);
    const { instructions, input } = buildDraftPrompt({ ctx, brief, modelLabel: model.label, tools, conventions, reference, date: today() });
    const session = { id: `${today()}-${randomUUID().slice(0, 8)}`, brief, tools, calls: [], references: [], modelLabels: new Set([model.label]), state: null, model: model.id };
    sessions.set(session.id, session);
    saveDraft(`${session.id}-prompt.md`, `${instructions}\n\n=== USER ===\n\n${input}\n`);
    const r = await runCall({ session, stage: 'draft', model, request: { instructions, input, tools, temperature: body.temperature ?? null } });
    return result(session, r, ctx);
  },

  'POST /api/revise': async (body) => {
    const session = sessions.get(body.session);
    if (!session) throw new Error('this draft\'s session is gone (the app was restarted); start a new draft');
    if (!String(body.instruction ?? '').trim()) throw new Error('say what to change');
    const ctx = await siteContext(cfg);
    const model = modelById(session.model);
    const r = await runCall({ session, stage: 'revise', model, request: { input: revisePrompt(body.instruction), tools: session.tools, state: session.state, temperature: body.temperature ?? null } });
    return result(session, r, ctx);
  },

  'POST /api/check': async (body) => {
    const ctx = await siteContext(cfg);
    const tags = (getField(body.markdown, 'tags') ?? '').replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean);
    return { checks: checkDraft(body.markdown, { sections: ctx.sections, tags }), exists: ctx.noteIds.includes(body.slug) };
  },

  'POST /api/pr': async (body) => {
    const session = sessions.get(body.session);
    const calls = session?.calls ?? readCalls().filter((c) => c.session === body.session && c.ok);
    const slug = String(body.slug ?? '').trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error('the file name must be kebab-case: lowercase letters, digits and hyphens');
    const title = getField(body.markdown, 'title') ?? slug;
    const pr = await openFilePR({
      repo: cfg.site.repo,
      base: cfg.site.branch,
      branch: `notewright/${slug}`,
      path: `${cfg.site.notesDir}/${slug}.md`,
      content: body.markdown,
      message: `Add note: ${title}`,
      title: `Add note: ${title}`,
      body: prBody({ slug, calls, prNotes: body.prNotes ?? session?.prNotes ?? '', references: session?.references ?? [], edited: !!body.edited, cfg }),
    });
    logCall({ ts: new Date().toISOString(), session: body.session, stage: 'pr', ok: true, pr: pr.url, slug, total: sumUsage(calls) });
    return pr;
  },

  'GET /api/runs': async () => readCalls(),
};

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };
// The preview's Markdown and math renderers, served from node_modules (`npm install`).
const VENDOR = { marked: './node_modules/marked/', katex: './node_modules/katex/dist/' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, type, data) => {
    res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(data);
  };
  const file = STATIC[url.pathname];
  if (req.method === 'GET' && file) {
    const path = new URL(`./public/${file}`, import.meta.url);
    if (existsSync(path)) return send(200, TYPES[file.split('.').pop()], readFileSync(path));
  }
  const v = url.pathname.match(/^\/vendor\/(marked|katex)\/([\w./-]+)$/);
  if (req.method === 'GET' && v && !v[2].includes('..')) {
    const path = new URL(`${VENDOR[v[1]]}${v[2]}`, import.meta.url);
    if (existsSync(path)) {
      res.writeHead(200, { 'Content-Type': TYPES[v[2].split('.').pop()] ?? 'application/octet-stream' });
      return res.end(readFileSync(path));
    }
  }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return send(404, 'text/plain', 'not found');
  try {
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      body = raw ? JSON.parse(raw) : {};
    }
    send(200, 'application/json', JSON.stringify(await route(body)));
  } catch (e) {
    console.error(e);
    send(400, 'application/json', JSON.stringify({ error: String(e.message ?? e) }));
  }
});
// Drafting with web search can take minutes; don't let Node cut the request off.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
// Local only: listen on the loopback address, so nothing else on the network can reach it.
server.listen(PORT, '127.0.0.1', () => console.log(`notewright on http://localhost:${PORT}`));
