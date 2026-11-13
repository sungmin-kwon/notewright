// The Mistral provider against a local stand-in that streams server-sent events the way the
// Conversations API does, slowly, plus the error cases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let server;
const seenBodies = [];
const sse = (res, events, gap) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let i = 0;
  const next = () => {
    if (i === events.length) return res.end();
    const [name, data] = events[i++];
    res.write(`event: ${name}\r\ndata: ${JSON.stringify({ type: name, ...data })}\r\n\r\n`);
    setTimeout(next, gap);
  };
  next();
};

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body);
      assert.equal(b.stream, true);
      seenBodies.push({ url: req.url, body: b });
      if (b.model === 'many') {
        return sse(res, [
          ['conversation.response.started', { conversation_id: 'conv_many' }],
          ...[1, 2, 3, 4].flatMap((i) => [
            ['tool.execution.started', { id: `t${i}`, name: 'web_search', arguments: JSON.stringify(i === 2 ? { url: 'https://ctext.org/x' } : { query: `q${i}` }) }],
            ['tool.execution.done', { id: `t${i}`, name: 'web_search' }],
          ]),
          ['message.output.delta', { content: 'never reached' }],
          ['conversation.response.done', { usage: { prompt_tokens: 999 } }],
        ], 20);
      }
      if (req.url.endsWith('/conv_many')) {
        return sse(res, [
          ['conversation.response.started', { conversation_id: 'conv_many' }],
          ['message.output.delta', { content: '## Sources\n\n- [S1] x' }],
          ['conversation.response.done', { usage: { prompt_tokens: 50, completion_tokens: 5, connectors: {} } }],
        ], 5);
      }
      if (b.model === 'err') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end('{"detail":"bad tool"}');
      }
      if (b.model === 'midway') return sse(res, [['conversation.response.started', { conversation_id: 'c' }], ['conversation.response.error', { message: 'overloaded', code: 3000 }]], 5);
      if (b.model === 'cut') return sse(res, [['conversation.response.started', { conversation_id: 'c' }], ['message.output.delta', { content: 'half' }]], 5);
      sse(
        res,
        [
          ['conversation.response.started', { conversation_id: req.url.includes('/conversations/') ? 'conv_same' : 'conv_new' }],
          ['tool.execution.started', { id: 'a', name: 'web_search', arguments: '{"query":"q1"}' }],
          ['tool.execution.done', { id: 'a', name: 'web_search' }],
          ['message.output.delta', { model: 'mistral-large-x', content: 'one ' }],
          ['message.output.delta', { content: [{ type: 'tool_reference', tool: 'web_search', title: 'T', url: 'https://t.org' }, { type: 'text', text: 'two' }] }],
          ['conversation.response.done', { usage: { prompt_tokens: 10, completion_tokens: 2, connector_tokens: 5, connectors: { web_search: 1 } } }],
        ],
        30,
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.MISTRAL_API_KEY = 'test';
  process.env.MISTRAL_API_BASE = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

const { call } = await import('../providers/mistral.mjs');

test('streams events and returns the whole reply', async () => {
  const seen = [];
  const r = await call({ model: 'ok', instructions: 'sys', input: 'hi', tools: ['web_search'], onEvent: (e) => seen.push(e) });
  assert.equal(r.text, 'one two');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 2, connectorTokens: 5, toolCalls: { web_search: 1 } });
  assert.deepEqual(r.state, { conversationId: 'conv_new' });
  assert.deepEqual(seen[0], { type: 'open', status: 200 });
  assert.equal(seen.filter((e) => e.type === 'raw').length, 6);
  const parsed = seen.filter((e) => !['open', 'raw'].includes(e.type));
  assert.deepEqual(parsed.map((e) => e.type), ['tool', 'tool-done', 'text', 'text']);
  assert.equal(parsed[1].query, 'q1');
  const again = await call({ input: 'more', state: r.state });
  assert.deepEqual(again.state, { conversationId: 'conv_same' });
});

test('reports an HTTP error with its status and body', async () => {
  await assert.rejects(call({ model: 'err', instructions: '', input: 'x' }), (e) => e.status === 422 && /bad tool/.test(e.message) && e.request.model === 'err');
});

test('reports an error event mid-stream, and a stream cut short', async () => {
  await assert.rejects(call({ model: 'midway', instructions: '', input: 'x' }), /overloaded/);
  await assert.rejects(call({ model: 'cut', instructions: '', input: 'x' }), (e) => e.code === 'INCOMPLETE');
});

test('stops at the tool limit and asks for the reply without tools', async () => {
  const seen = [];
  const r = await call({ model: 'many', instructions: 'sys', input: 'hi', tools: ['web_search'], maxToolCalls: 2, onEvent: (e) => seen.push(e) });
  assert.equal(r.text, '## Sources\n\n- [S1] x');
  assert.deepEqual(r.usage.toolCalls, { web_search: 2 });
  assert.equal(r.usage.incomplete, true);
  assert.equal(r.usage.inputTokens, 50);
  assert.ok(seen.some((e) => e.type === 'limit' && e.max === 2));
  assert.deepEqual(seen.filter((e) => e.type === 'tool-done').map((e) => e.query), ['q1', 'open https://ctext.org/x']);
  const wrap = seenBodies.find((x) => x.url.endsWith('/conv_many'));
  assert.equal(wrap.body.completion_args.tool_choice, 'none');
  assert.match(wrap.body.inputs[0].content, /limit of 2/);
});
