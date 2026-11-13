// What the app knows about the site repo, fetched from GitHub: the writing guide, the
// conventions files, the notebooks and their tags (from site.config.mjs), and the existing note
// ids. Cached in memory; "Reload the guides" in the app fetches it again.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, listDir, branchSha } from './github.mjs';

let cache = null;

export async function siteContext(cfg, { refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const { repo, branch, guide, conventionsDir, siteConfig, notesDir } = cfg.site;
  const [sha, writing, configText, convEntries, noteEntries] = await Promise.all([
    branchSha(repo, branch),
    readFile(repo, guide, branch),
    readFile(repo, siteConfig, branch),
    listDir(repo, conventionsDir, branch),
    listDir(repo, notesDir, branch),
  ]);
  if (!writing) throw new Error(`could not read ${guide} from ${repo}@${branch}`);
  if (!configText) throw new Error(`could not read ${siteConfig} from ${repo}@${branch}`);

  const conventions = await Promise.all(
    convEntries
      .filter((e) => e.type === 'file' && e.name.endsWith('.md'))
      .map(async (e) => {
        const text = await readFile(repo, e.path, branch);
        const heading = text.match(/^# (.+)$/m)?.[1] ?? e.name;
        return { name: e.name, path: e.path, title: heading, text };
      }),
  );

  // site.config.mjs is plain JavaScript with no imports; load it as a module from a temp file.
  const dir = mkdtempSync(join(tmpdir(), 'notewright-'));
  const file = join(dir, 'site.config.mjs');
  writeFileSync(file, configText);
  const { SECTIONS } = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  const sections = SECTIONS.map((s) => ({
    path: s.path,
    title: s.title,
    untagged: !!s.untagged,
    tags: (s.tags ?? []).map((t) => t.name),
    // WRITING.md: the qualitative bar is marginalia's default, the quantitative bar the others'.
    bar: s.path === 'marginalia' ? 'qualitative' : 'quantitative',
  })).filter((s) => s.tags.length);

  const noteIds = noteEntries.filter((e) => e.name.endsWith('.md')).map((e) => e.name.replace(/\.md$/, ''));
  cache = { sha, fetchedAt: new Date().toISOString(), writing, conventions, sections, noteIds };
  return cache;
}

export async function referenceNote(cfg, id) {
  if (!id) return null;
  const text = await readFile(cfg.site.repo, `${cfg.site.notesDir}/${id}.md`, cfg.site.branch);
  return text && { id, text };
}
