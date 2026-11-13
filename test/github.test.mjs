import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFilePR } from '../lib/github.mjs';

test('openFilePR cuts a free branch from main, commits the file and opens the PR', async () => {
  process.env.GITHUB_TOKEN = 'test';
  const seen = [];
  globalThis.fetch = async (url, opt = {}) => {
    const path = url.replace('https://api.github.com', '');
    const method = opt.method ?? 'GET';
    seen.push(`${method} ${path}`);
    const json = (code, data) => new Response(JSON.stringify(data), { status: code });
    if (method === 'GET' && path.includes('/contents/')) return json(404, {});
    if (path.endsWith('/git/ref/heads/main')) return json(200, { object: { sha: 'abc' } });
    if (path.endsWith('/git/ref/heads/notewright/x')) return json(200, { object: { sha: 'old' } });
    if (path.includes('/git/ref/heads/')) return json(404, {});
    if (method === 'POST' && path.endsWith('/git/refs')) {
      assert.deepEqual(JSON.parse(opt.body), { ref: 'refs/heads/notewright/x-2', sha: 'abc' });
      return json(201, {});
    }
    if (method === 'PUT') {
      const b = JSON.parse(opt.body);
      assert.equal(Buffer.from(b.content, 'base64').toString(), 'hello');
      assert.equal(b.branch, 'notewright/x-2');
      return json(201, {});
    }
    if (path.endsWith('/pulls')) return json(201, { html_url: 'https://github.com/o/r/pull/9', number: 9 });
    return json(500, { path });
  };
  const pr = await openFilePR({ repo: 'o/r', base: 'main', branch: 'notewright/x', path: 'src/content/notes/x.md', content: 'hello', message: 'm', title: 't', body: 'b' });
  assert.deepEqual(pr, { url: 'https://github.com/o/r/pull/9', number: 9, branch: 'notewright/x-2' });
  assert.ok(seen.includes('PUT /repos/o/r/contents/src/content/notes/x.md'));
});
