// The few GitHub REST calls the app needs, with plain fetch. Reads work without a token on a
// public repo (but with a low rate limit); writes need GITHUB_TOKEN.
const API = 'https://api.github.com';

export async function gh(path, { method = 'GET', body, raw = false, auth = true } = {}) {
  const headers = {
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'notewright',
  };
  if (auth && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  }
  return raw ? res.text() : res.json();
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

/** A file's text at a ref, or null if it doesn't exist. */
export const readFile = (repo, path, ref) => gh(`/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`, { raw: true });

/** The entries of a directory at a ref ([] if it doesn't exist). */
export async function listDir(repo, path, ref) {
  return (await gh(`/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`)) ?? [];
}

export async function branchSha(repo, branch) {
  const ref = await gh(`/repos/${repo}/git/ref/heads/${enc(branch)}`);
  return ref?.object.sha ?? null;
}

/**
 * Commits one new file to a new branch cut from `base` and opens a PR. Picks a free branch name
 * (`name`, then `name-2`, …). Refuses to overwrite a file that already exists on `base`.
 */
export async function openFilePR({ repo, base, branch, path, content, message, title, body, draft = false }) {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set, so the app cannot push. See .env.example.');
  if ((await readFile(repo, path, base)) !== null) throw new Error(`${path} already exists on ${base}; pick another file name.`);
  const sha = await branchSha(repo, base);
  if (!sha) throw new Error(`branch ${base} not found in ${repo}`);
  let name = branch;
  for (let i = 2; await branchSha(repo, name); i++) name = `${branch}-${i}`;
  await gh(`/repos/${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${name}`, sha } });
  await gh(`/repos/${repo}/contents/${enc(path)}`, {
    method: 'PUT',
    body: { message, content: Buffer.from(content, 'utf8').toString('base64'), branch: name },
  });
  const pr = await gh(`/repos/${repo}/pulls`, { method: 'POST', body: { title, head: name, base, body, draft } });
  return { url: pr.html_url, number: pr.number, branch: name };
}
