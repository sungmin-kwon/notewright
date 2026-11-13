import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitReply, pinFrontmatter, guessSlug, getField } from '../lib/output.mjs';
import { checkDraft } from '../lib/checks.mjs';
import { estimateCost, sumUsage } from '../lib/cost.mjs';
import { newAccumulator } from '../providers/mistral.mjs';
import { buildDraftPrompt, buildResearchPrompt, citationRules } from '../lib/prompt.mjs';

const sections = [{ path: 'working-notes', title: 'working notes', tags: ['stats', 'genes', 'data'], bar: 'quantitative' }];

test('splitReply separates the file and the PR notes, and drops a fence and a preamble', () => {
  const r = splitReply('Here is the note:\n```markdown\n---\ntitle: A\n---\n\nBody\n```\n=== PR NOTES ===\n**File:** a-b.md\n');
  assert.equal(r.markdown, '---\ntitle: A\n---\n\nBody\n');
  assert.equal(r.prNotes, '**File:** a-b.md');
  assert.equal(r.preamble, 'Here is the note:');
  assert.equal(guessSlug(r.markdown, r.prNotes), 'a-b');
  assert.equal(guessSlug(r.markdown, ''), 'a');
});

test('pinFrontmatter sets tags and model, keeps a date the model wrote', () => {
  const md = '---\ntitle: X\ndate: 2026-11-01\ntags: [genes]\nmodel: Mistral\n---\n\nHi\n';
  const { markdown, changed } = pinFrontmatter(md, { date: '2026-11-13', tags: ['stats', 'genes'], modelLabels: ['Mistral Large 4'] });
  assert.equal(getField(markdown, 'date'), '2026-11-01');
  assert.equal(getField(markdown, 'tags'), '[stats, genes]');
  assert.equal(getField(markdown, 'model'), '[Mistral Large 4]');
  assert.equal(changed.length, 2);
});

test('checkDraft catches the common slips', () => {
  const md = [
    '---', 'title: X', 'date: 2026-11-13', 'tags: [stats]', 'model: [M]', '---', '',
    '# Heading', 'Here I show it — badly.', '$$x = 1$$', '[other](/working-notes/notes/y/)',
    '```', 'x' .repeat(71), '```', '## Limits',
  ].join('\n');
  const msgs = checkDraft(md, { sections, tags: ['stats'] }).map((c) => c.msg).join('\n');
  for (const s of ['summary', 'distillate', 'H1', 'first person', 'em dash', '`$$`', 'another note', '71 characters', 'Limits', 'Sources']) {
    assert.match(msgs, new RegExp(s.replace(/[$`]/g, '\\$&')), s);
  }
  const ok = ['---', 'date: 2026-11-13', 'tags: [stats]', 'model: [M]', '---', '', 'A short note, with $x$ and', '', '$$', 'y = 2', '$$'].join('\n');
  assert.deepEqual(checkDraft(ok, { sections, tags: ['stats'] }), []);
});

test('Mistral stream parsing and cost', () => {
  const acc = newAccumulator();
  const events = [
    ['conversation.response.started', { type: 'conversation.response.started', conversation_id: 'conv_1' }],
    ['tool.execution.started', { type: 'tool.execution.started', id: 't1', name: 'web_search', arguments: '' }],
    ['tool.execution.delta', { type: 'tool.execution.delta', id: 't1', name: 'web_search', arguments: '{"query": "姓 氏' }],
    ['tool.execution.delta', { type: 'tool.execution.delta', id: 't1', name: 'web_search', arguments: ' origin"}' }],
    ['tool.execution.done', { type: 'tool.execution.done', id: 't1', name: 'web_search' }],
    ['message.output.delta', { type: 'message.output.delta', model: 'mistral-large-2511', content: 'Hello ' }],
    ['message.output.delta', { type: 'message.output.delta', content: [{ type: 'tool_reference', tool: 'web_search', title: 'Paper', url: 'https://x.org' }, { type: 'text', text: 'world' }] }],
    ['conversation.response.done', { type: 'conversation.response.done', usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, connector_tokens: 10_000, connectors: { web_search: 3 } } }],
  ];
  const out = events.map(([n, d]) => acc.add(n, d)).filter(Boolean);
  assert.deepEqual(out.find((e) => e.type === 'tool-done'), { type: 'tool-done', id: 't1', tool: 'web_search', query: '姓 氏 origin' });
  assert.ok(acc.done);
  const r = acc.result();
  assert.equal(r.text, 'Hello world');
  assert.equal(r.references[0].url, 'https://x.org');
  assert.equal(r.servedModel, 'mistral-large-2511');
  assert.deepEqual(r.state, { conversationId: 'conv_1' });
  const model = { price: { inputPerM: 0.7, outputPerM: 2.1 } };
  const c = estimateCost(r.usage, model, { connectorTokens: 'input', tools: { web_search: { pricePerCall: null } } });
  assert.ok(Math.abs(c.total - (0.7 * 1.01 + 0.21)) < 1e-9);
  assert.deepEqual(c.unpriced, ['web_search']);
  const c2 = estimateCost(r.usage, model, { tools: { web_search: { pricePerCall: 0.03 } } });
  assert.ok(Math.abs(c2.total - (0.7 + 0.21 + 0.09)) < 1e-9);
  const s = sumUsage([{ usage: r.usage, cost: c }, { usage: r.usage, cost: c2 }]);
  assert.equal(s.toolCalls.web_search, 6);
});

test('the prompt carries the guide, the conventions and the settings', () => {
  const ctx = { sections, writing: 'GUIDE TEXT' };
  const p = buildDraftPrompt({
    ctx, brief: { topic: 'Delta method', tags: ['stats'], slug: 'delta-method' }, modelLabel: 'Mistral Large 4',
    tools: ['web_search'], conventions: [{ path: 'conventions/x.md', text: 'CONV' }], reference: { id: 'r', text: 'REF' }, date: '2026-11-13',
  });
  for (const s of ['GUIDE TEXT', 'CONV', 'REF', 'web search tool', '`model: [Mistral Large 4]`', 'delta-method.md', 'quantitative', '=== PR NOTES ===']) {
    assert.ok(p.instructions.includes(s), s);
  }
  assert.match(p.input, /Delta method/);
});

test('the research prompt asks for sources, key facts and open questions, with the citation rules', () => {
  const writing = 'x\n\n**Citations.** Name the authors.\n\n**Cite only what a reader can check.** Be specific.\n\n**Next.** no';
  assert.equal(citationRules(writing), '**Citations.** Name the authors.\n\n**Cite only what a reader can check.** Be specific.');
  const p = buildResearchPrompt({ ctx: { sections, writing }, brief: { topic: 'Xing and shi', notes: 'use Zuo zhuan', tags: ['stats'] }, conventions: [{ path: 'conventions/east-asian.md', text: 'EA' }] });
  for (const s of ['## Sources', '## Key facts', '## Open questions', '**Citations.**', 'EA', 'Do not draft']) assert.ok(p.instructions.includes(s), s);
  assert.ok(!p.instructions.includes('**Next.**'));
  assert.match(p.input, /Xing and shi[\s\S]*Zuo zhuan/);
  const d = buildDraftPrompt({ ctx: { sections, writing }, brief: { topic: 'T', tags: ['stats'] }, modelLabel: 'M', tools: [], conventions: [], reference: null, date: '2026-11-13', research: '## Sources\n- [S1] A' });
  assert.match(d.input, /# Research notes[\s\S]*\[S1\] A/);
  assert.ok(d.instructions.includes('Cite only works listed there'));
});
