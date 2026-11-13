// The page: the brief form, the draft with preview, checks and cost, revisions, and the PR.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const usd = (x) => `$${(x ?? 0).toFixed(4)}`;
const num = (x) => (x ?? 0).toLocaleString('en-US');
const calls = (o) => Object.entries(o ?? {}).map(([k, v]) => `${v} ${k}`).join(', ') || '0';

let config;
let current; // the latest result from the server
let edited = false; // the Markdown tab was changed by hand
let tagOrder = []; // tags in the order they were ticked

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

// ---- Views and tabs -------------------------------------------------------------------------
document.querySelectorAll('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
    $('#view-draft').hidden = b.dataset.view !== 'draft';
    $('#view-runs').hidden = b.dataset.view !== 'runs';
    if (b.dataset.view === 'runs') showRuns();
  }),
);
document.querySelectorAll('[data-pane]').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-pane]').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.id !== `pane-${b.dataset.pane}`));
    if (b.dataset.pane === 'preview') renderPreview();
  }),
);

// ---- Form setup -----------------------------------------------------------------------------
function status() {
  const s = config.site;
  const keys = [config.keys.mistral ? 'Mistral key set' : '<span class="error">no MISTRAL_API_KEY</span>', config.keys.github ? 'GitHub token set' : '<span class="error">no GITHUB_TOKEN</span>'];
  $('#status').innerHTML = `Guides from <code>${esc(s.repo)}</code> at <code>${esc(s.branch)}</code> (${esc(s.sha?.slice(0, 7))}), fetched ${new Date(s.fetchedAt).toLocaleTimeString()}. ${keys.join(' · ')}. <button type="button" class="tab" id="reload">Reload the guides</button>`;
  $('#reload').onclick = async () => {
    $('#status').textContent = 'Reloading…';
    config = await api('/api/reload', {});
    status();
  };
}

function setup() {
  status();
  const sec = $('#section');
  sec.innerHTML = config.sections.map((s) => `<option value="${esc(s.path)}">${esc(s.title)}</option>`).join('');
  sec.onchange = sectionChanged;
  $('#conventions').innerHTML =
    config.conventions.map((c) => `<label><input type="checkbox" name="conventions" value="${esc(c.path)}"> <code>${esc(c.name)}</code> <span class="muted">${esc(c.title)}</span></label>`).join('') ||
    '<span class="muted">none in the repo</span>';
  $('#reference').innerHTML = ['<option value="">none</option>', ...config.noteIds.map((id) => `<option>${esc(id)}</option>`)].join('');
  document.querySelectorAll('.model-select').forEach((sel) => {
    sel.innerHTML = config.models
      .map((m) => `<option value="${esc(m.id)}" ${m.id === config.defaultModel ? 'selected' : ''}>${esc(m.label)} · $${m.price.inputPerM}/$${m.price.outputPerM} per M tokens</option>`)
      .join('');
    sel.onchange = toolsChanged;
  });
  sectionChanged();
  toolsChanged();
}

function sectionChanged() {
  const s = config.sections.find((x) => x.path === $('#section').value);
  tagOrder = [s.tags[0]];
  $('#tags').innerHTML = s.tags.map((t) => `<label><input type="checkbox" name="tags" value="${esc(t)}" ${t === s.tags[0] ? 'checked' : ''}> ${esc(t)}</label>`).join('');
  $('#tags').querySelectorAll('input').forEach((i) =>
    i.addEventListener('change', () => {
      tagOrder = i.checked ? [...tagOrder, i.value] : tagOrder.filter((t) => t !== i.value);
    }),
  );
  const ref = config.referenceNotes[s.path];
  $('#reference').value = ref && config.noteIds.includes(ref) ? ref : '';
}

const priceNote = (t) => {
  const info = config.tools[t];
  return info && typeof info.pricePerCall === 'number' ? ` · $${info.pricePerCall} per call` : info ? ' · price per call not set' : '';
};
const modelOf = (step) => config.models.find((x) => x.id === document.querySelector(`.model-select[data-step=${step}]`).value);

function toolsChanged() {
  // Research: one search tool, required.
  const rm = modelOf('research');
  const searchTools = rm.tools.filter((t) => t.startsWith('web_search'));
  const was = $('#research-tool').value;
  $('#research-tool').innerHTML = searchTools.map((t) => `<option value="${esc(t)}">${esc(config.tools[t]?.label ?? t)}${esc(priceNote(t))}</option>`).join('');
  if (searchTools.includes(was)) $('#research-tool').value = was;
  $('#research-btn').disabled = !searchTools.length;
  // Draft: any tools, off by default.
  const dm = modelOf('draft');
  const on = new Set([...document.querySelectorAll('input[name=draft-tools]:checked')].map((i) => i.value));
  $('#draft-tools').innerHTML =
    dm.tools.map((t) => `<label><input type="checkbox" name="draft-tools" value="${esc(t)}" ${on.has(t) ? 'checked' : ''}> ${esc(config.tools[t]?.label ?? t)} <span class="muted">${esc(priceNote(t))}</span></label>`).join('') ||
    '<span class="muted">this model has no built-in tools</span>';
  draftHint();
}

function draftHint() {
  const hasResearch = !$('#research-out').hidden && $('#research').value.trim();
  $('#draft-hint').textContent = hasResearch
    ? 'Drafts from the research notes above. Search while drafting is usually unnecessary; tick it only to let the model check what the notes leave open.'
    : 'No research notes: the model drafts from the brief alone. Tick web search so it can check its sources while drafting, or run step 1 first.';
}

// ---- Streaming calls -------------------------------------------------------------------------
// The server answers a model call with JSON lines: progress events, then a result or an error.
async function stream(path, body, after) {
  const live = $('#live');
  after.insertAdjacentElement('afterend', live);
  live.insertAdjacentElement('afterend', $('#step-error'));
  $('#step-error').textContent = '';
  $('#live-queries').innerHTML = '';
  $('#live-text').textContent = '';
  live.hidden = false;
  const buttons = document.querySelectorAll('#research-btn, #draft-btn, #revise-btn');
  buttons.forEach((b) => (b.disabled = true));
  const t0 = Date.now();
  let phase = 'Waiting for the model…';
  const tick = () => ($('#live-status').textContent = `${phase} ${Math.round((Date.now() - t0) / 1000)} s`);
  const timer = setInterval(tick, 1000);
  tick();
  const queries = new Map();
  let events = 0;
  $('#live-events').textContent = '';
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (ev.type === 'start') phase = `${ev.model}: ${ev.stage}. Waiting for the API…`;
        else if (ev.type === 'open') phase = ev.status === 200 ? 'Connected; waiting for the first event…' : `The API answered ${ev.status}…`;
        else if (ev.type === 'raw') {
          events++;
          $('#live-events').textContent = `${events} event${events > 1 ? 's' : ''} received, last: ${ev.name}`;
        }
        else if (ev.type === 'tool' || ev.type === 'tool-done') {
          let li = queries.get(ev.id);
          if (!li) {
            li = document.createElement('li');
            queries.set(ev.id, li);
            $('#live-queries').append(li);
          }
          li.className = ev.type === 'tool' ? 'running' : '';
          li.textContent = `${ev.tool === 'web_search' ? '' : `${ev.tool}: `}${ev.query || '…'}${ev.type === 'tool' ? ' (searching)' : ''}`;
          phase = ev.type === 'tool' ? 'Searching…' : 'Reading the results…';
        } else if (ev.type === 'text') {
          phase = 'Writing…';
          const pre = $('#live-text');
          const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
          pre.textContent += ev.text;
          if (atEnd) pre.scrollTop = pre.scrollHeight;
        } else if (ev.type === 'error') throw new Error(ev.error);
        else if (ev.type === 'result') return ev.result;
      }
    }
    throw new Error('the server closed the stream without a result');
  } catch (err) {
    $('#step-error').textContent = err.message;
    return null;
  } finally {
    clearInterval(timer);
    buttons.forEach((b) => (b.disabled = false));
    toolsChanged();
    live.hidden = !$('#step-error').textContent;
    $('#live-status').textContent = $('#step-error').textContent ? `Stopped after ${Math.round((Date.now() - t0) / 1000)} s.` : '';
  }
}

function brief() {
  const f = new FormData($('#brief'));
  const ticked = [...document.querySelectorAll('input[name=tags]:checked')].map((i) => i.value);
  return {
    topic: f.get('topic'),
    notes: f.get('notes'),
    tags: [...tagOrder.filter((t) => ticked.includes(t)), ...ticked.filter((t) => !tagOrder.includes(t))],
    bar: f.get('bar'),
    conventions: f.getAll('conventions'),
    reference: f.get('reference'),
    slug: f.get('slug'),
    length: f.get('length'),
  };
}

let session = null; // the server's id for this note

// Enter in the brief doesn't submit anything; the steps have their own buttons.
$('#brief').addEventListener('submit', (e) => e.preventDefault());
$('#research').addEventListener('input', draftHint);

$('#research-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('#brief').reportValidity()) return;
  const f = new FormData(e.target);
  const r = await stream('/api/research', { ...brief(), model: f.get('model'), tools: [f.get('tool')] }, e.target);
  if (!r) return;
  session = r.session;
  $('#research-out').hidden = false;
  $('#research').value = r.research;
  $('#queries').innerHTML = r.queries.map((q) => `<li>${esc(q.query)}</li>`).join('') || '<li class="muted">none reported</li>';
  $('#research-refs').innerHTML = refList(r.references);
  showCost(r);
  draftHint();
});

$('#draft-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('#brief').reportValidity()) return;
  const f = new FormData(e.target);
  const research = $('#research-out').hidden ? '' : $('#research').value;
  const r = await stream(
    '/api/draft',
    { ...brief(), session, research, model: f.get('model'), tools: f.getAll('draft-tools'), temperature: f.get('temperature') === '' ? null : Number(f.get('temperature')) },
    e.target,
  );
  if (r) show(r);
});

$('#revise').addEventListener('submit', async (e) => {
  e.preventDefault();
  const instruction = new FormData(e.target).get('instruction');
  const r = await stream('/api/revise', { session: current.session, instruction }, e.target);
  if (!r) return;
  e.target.reset();
  show(r);
});

const refList = (refs) =>
  refs.length
    ? refs.map((x) => `<li>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)} <span class="muted">${esc(x.stage ?? x.tool)}</span></li>`).join('')
    : '<li class="muted">The model returned no search results.</li>';

function showCost(r) {
  $('#cost-wrap').hidden = false;
  $('#cost').innerHTML = costTable(r.calls, r.total);
}

function show(r) {
  current = r;
  session = r.session;
  edited = false;
  $('#result').hidden = false;
  $('#markdown').value = r.markdown;
  $('#prnotes').value = r.prNotes;
  $('#pr [name=slug]').value = r.slug;
  $('#pr-out').textContent = '';
  showCost(r);
  $('#refs').innerHTML = refList(r.references);
  notices(r);
  renderPreview();
  $('#cost-wrap').scrollIntoView({ behavior: 'smooth' });
}

function notices(r) {
  const out = [];
  if (r.preamble) out.push(`<div class="notice">The model wrote this before the file; it was dropped: <em>${esc(r.preamble.slice(0, 300))}</em></div>`);
  if (r.pinned?.length) out.push(`<div class="notice">The app fixed the frontmatter: <ul>${r.pinned.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`);
  if (!r.prNotes) out.push('<div class="notice bad">The reply had no PR notes (no <code>=== PR NOTES ===</code> line). Write the Not verified list yourself, or ask for a revision.</div>');
  if (r.exists) out.push(`<div class="notice bad">A note called <code>${esc(r.slug)}</code> already exists. Change the file name before opening the PR.</div>`);
  out.push(
    r.checks.length
      ? `<div class="notice bad">Quick checks found ${r.checks.length} problem${r.checks.length > 1 ? 's' : ''} (the site's own <code>npm run check</code> runs on the PR): <ul>${r.checks.map((c) => `<li>${c.line ? `line ${c.line}: ` : ''}${esc(c.msg)}</li>`).join('')}</ul></div>`
      : '<div class="notice good">Quick checks passed. The site\'s own <code>npm run check</code> runs on the PR.</div>',
  );
  $('#notices').innerHTML = out.join('');
}

function costTable(list, t) {
  const row = (c, i) =>
    `<tr><td>${i + 1}</td><td>${esc(c.stage)}</td><td>${esc(c.label)}${c.servedModel ? ` <span class="muted">${esc(c.servedModel)}</span>` : ''}</td><td class="n">${num(c.usage.inputTokens)}</td><td class="n">${num(c.usage.outputTokens)}</td><td class="n">${num(c.usage.connectorTokens)}</td><td class="n">${esc(calls(c.usage.toolCalls))}</td><td class="n">${(c.ms / 1000).toFixed(0)} s</td><td class="n">${usd(c.cost.total)}</td></tr>`;
  const unpriced = t.unpriced?.length ? `<p class="muted">Dollar figures count tokens only: config.json has no price per call for ${esc(t.unpriced.join(', '))}. Search-result tokens are priced as input tokens (an assumption; check it against the Mistral billing page).</p>` : '';
  return `<div class="scroll"><table><thead><tr><th>#</th><th>stage</th><th>model</th><th class="n">input</th><th class="n">output</th><th class="n">search-result tokens</th><th class="n">tool calls</th><th class="n">time</th><th class="n">est. cost</th></tr></thead><tbody>${list.map(row).join('')}<tr class="total"><td></td><td>note total</td><td></td><td class="n">${num(t.inputTokens)}</td><td class="n">${num(t.outputTokens)}</td><td class="n">${num(t.connectorTokens)}</td><td class="n">${esc(calls(t.toolCalls))}</td><td></td><td class="n">${usd(t.cost)}</td></tr></tbody></table></div>${unpriced}`;
}

// ---- Preview --------------------------------------------------------------------------------
// Not the site's renderer: Markdown with marked and math with KaTeX, close enough to read the
// draft and catch broken math. The real check is the site's build.
function renderPreview() {
  const md = $('#markdown').value;
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm = {};
  if (m) for (const l of m[1].split('\n')) { const i = l.indexOf(':'); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1'); }
  let body = m ? md.slice(m[0].length) : md;
  const math = [];
  const keep = (tex, display) => {
    let html;
    try { html = katex.renderToString(tex, { displayMode: display, throwOnError: true }); }
    catch (e) { html = `<span class="error">[KaTeX error: ${esc(e.message)}]</span>`; }
    math.push(html);
    return `@@MATH${math.length - 1}@@`;
  };
  // Code first, so $ inside code is left alone.
  const code = [];
  body = body.replace(/^```[\s\S]*?^```/gm, (c) => { code.push(c); return `@@CODE${code.length - 1}@@`; });
  body = body.replace(/^\$\$\n([\s\S]*?)\n\$\$$/gm, (_, t) => keep(t, true));
  body = body.replace(/\$\$([^\n]+?)\$\$/g, (_, t) => keep(t, false)); // one-line $$ renders inline on the site
  body = body.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, pre, t) => pre + keep(t, false));
  body = body.replace(/@@CODE(\d+)@@/g, (_, i) => code[i]);
  let html = marked.parse(body);
  html = html.replace(/@@MATH(\d+)@@/g, (_, i) => math[i]);
  const head = [
    fm.title ? `<h1>${esc(fm.title)}</h1>` : '',
    fm.summary ? `<p class="summary">${esc(fm.summary)}</p>` : '',
    `<p class="meta">${esc(fm.date ?? '')} · ${esc(fm.tags ?? '')}${fm.rough === 'true' ? ' · rough' : ''} · model ${esc(fm.model ?? '?')}</p>`,
    fm.distillate ? `<div class="distillate"><strong>Distillate</strong><br>${esc(fm.distillate)}</div>` : '',
  ].join('');
  $('#pane-preview').innerHTML = head + html;
}

$('#markdown').addEventListener('input', () => (edited = true));
$('#recheck').addEventListener('click', async () => {
  const r = await api('/api/check', { markdown: $('#markdown').value, slug: $('#pr [name=slug]').value });
  notices({ ...current, ...r, pinned: [], preamble: '' });
});

// ---- PR -------------------------------------------------------------------------------------
$('#pr').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#pr-btn');
  btn.disabled = true;
  $('#pr-out').textContent = 'Opening…';
  try {
    const pr = await api('/api/pr', {
      session: current.session,
      slug: new FormData(e.target).get('slug'),
      markdown: $('#markdown').value,
      prNotes: $('#prnotes').value,
      research: $('#research-out').hidden ? '' : $('#research').value,
      edited,
    });
    $('#pr-out').innerHTML = `Opened <a href="${esc(pr.url)}" target="_blank" rel="noopener">PR #${pr.number}</a> from <code>${esc(pr.branch)}</code>.`;
  } catch (err) {
    $('#pr-out').innerHTML = `<span class="error">${esc(err.message)}</span>`;
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
});

// ---- Runs -----------------------------------------------------------------------------------
async function showRuns() {
  const all = await api('/api/runs');
  const callsOk = all.filter((c) => c.ok && c.usage);
  const prs = new Map(all.filter((c) => c.stage === 'pr').map((c) => [c.session, c.pr]));
  const notes = new Map();
  for (const c of callsOk) {
    const n = notes.get(c.session) ?? { model: c.label, calls: 0, input: 0, output: 0, conn: 0, tools: 0, cost: 0, ms: 0, topic: c.topic };
    n.calls++; n.input += c.usage.inputTokens; n.output += c.usage.outputTokens; n.conn += c.usage.connectorTokens ?? 0;
    n.tools += Object.values(c.usage.toolCalls ?? {}).reduce((a, b) => a + b, 0); n.cost += c.cost.total; n.ms += c.ms;
    notes.set(c.session, n);
  }
  const by = new Map();
  for (const n of notes.values()) {
    const m = by.get(n.model) ?? { notes: 0, calls: 0, input: 0, output: 0, conn: 0, tools: 0, cost: 0, ms: 0 };
    for (const k of ['calls', 'input', 'output', 'conn', 'tools', 'cost', 'ms']) m[k] += n[k];
    m.notes++;
    by.set(n.model, m);
  }
  const failed = all.filter((c) => c.ok === false).length;
  $('#by-model').innerHTML = by.size
    ? `<div class="scroll"><table><thead><tr><th>model</th><th class="n">notes</th><th class="n">calls</th><th class="n">avg input / note</th><th class="n">avg output / note</th><th class="n">avg search-result tokens</th><th class="n">avg tool calls</th><th class="n">avg time</th><th class="n">avg cost / note</th><th class="n">total cost</th></tr></thead><tbody>${[...by]
        .map(([k, m]) => `<tr><td>${esc(k)}</td><td class="n">${m.notes}</td><td class="n">${m.calls}</td><td class="n">${num(Math.round(m.input / m.notes))}</td><td class="n">${num(Math.round(m.output / m.notes))}</td><td class="n">${num(Math.round(m.conn / m.notes))}</td><td class="n">${(m.tools / m.notes).toFixed(1)}</td><td class="n">${Math.round(m.ms / m.notes / 1000)} s</td><td class="n">${usd(m.cost / m.notes)}</td><td class="n">${usd(m.cost)}</td></tr>`)
        .join('')}</tbody></table></div>${failed ? `<p class="muted">${failed} failed call${failed > 1 ? 's' : ''} not counted.</p>` : ''}`
    : '<p class="muted">No runs yet.</p>';
  $('#calls').innerHTML = all.length
    ? `<div class="scroll"><table><thead><tr><th>when</th><th>stage</th><th>model</th><th>topic</th><th class="n">input</th><th class="n">output</th><th class="n">tool calls</th><th class="n">est. cost</th><th></th></tr></thead><tbody>${all
        .slice()
        .reverse()
        .map((c) => c.stage === 'pr'
          ? `<tr><td>${esc(new Date(c.ts).toLocaleString())}</td><td>pr</td><td></td><td>${esc(c.slug)}</td><td></td><td></td><td></td><td class="n">${usd(c.total?.cost)}</td><td><a href="${esc(c.pr)}" target="_blank" rel="noopener">PR</a></td></tr>`
          : `<tr><td>${esc(new Date(c.ts).toLocaleString())}</td><td>${esc(c.stage)}</td><td>${esc(c.label)}</td><td>${esc((c.topic ?? '').slice(0, 40))}</td><td class="n">${c.ok ? num(c.usage.inputTokens) : ''}</td><td class="n">${c.ok ? num(c.usage.outputTokens) : ''}</td><td class="n">${c.ok ? esc(calls(c.usage.toolCalls)) : ''}</td><td class="n">${c.ok ? usd(c.cost.total) : ''}</td><td>${c.ok ? (prs.has(c.session) ? `<a href="${esc(prs.get(c.session))}" target="_blank" rel="noopener">PR</a>` : '') : `<span class="error" title="${esc(c.error)}">failed</span>`}</td></tr>`)
        .join('')}</tbody></table></div><p class="muted">The log is <code>runs/calls.jsonl</code>; each reply is kept in <code>runs/drafts/</code>.</p>`
    : '';
}

// ---- Start ----------------------------------------------------------------------------------
api('/api/config')
  .then((c) => { config = c; setup(); })
  .catch((e) => ($('#status').innerHTML = `<span class="error">Could not load the guides: ${esc(e.message)}</span>`));
