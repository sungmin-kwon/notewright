// Quick checks on a draft, for the WRITING.md rules a script can see without the site's build.
// They run in the app before the PR; the site's own `npm run check` runs on the PR in CI and is
// the real test. Each problem is { line, msg } (line counted from 1, 0 for the whole file).
import { getField } from './output.mjs';

export function checkDraft(md, { sections, tags = [] }) {
  const out = [];
  const add = (line, msg) => out.push({ line, msg });
  const lines = md.split('\n');
  if (lines[0] !== '---' || lines.indexOf('---', 1) < 0) {
    add(1, 'no frontmatter: the file must start with a `---` block');
    return out;
  }
  const fmEnd = lines.indexOf('---', 1);
  const title = getField(md, 'title');
  if (!getField(md, 'date')) add(0, 'frontmatter has no `date`');
  if (!getField(md, 'model')) add(0, 'frontmatter has no `model`');
  if (title && !getField(md, 'summary')) add(0, 'a long note (with a title) needs a `summary`');
  const distillate = getField(md, 'distillate');
  if (title && !distillate) add(0, 'a long note (with a title) needs a `distillate`');
  if (distillate && /\[[^\]]*\]\(|\*\*|`/.test(distillate)) add(0, 'the distillate is plain text: no links, bold or code');
  const all = sections.flatMap((s) => s.tags);
  for (const t of tags) if (!all.includes(t)) add(0, `unknown tag "${t}"`);
  if (!tags.length) add(0, 'no tags: the note would land in purgatorial thoughts');
  for (const [i, l] of lines.slice(1, fmEnd).entries()) {
    if (/^\w+: [^"].*: /.test(l)) add(i + 2, 'a frontmatter value with ": " in it must be quoted');
  }

  let inCode = false;
  let inSources = false;
  let sawSources = false;
  for (let i = fmEnd + 1; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1;
    if (/^\s*```/.test(l)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      if (l.length > 70) add(n, `code line is ${l.length} characters (at most 70)`);
      continue;
    }
    if (/^## /.test(l)) {
      inSources = /^## Sources\s*$/.test(l);
      sawSources ||= inSources;
    }
    if (/^# /.test(l)) add(n, 'no H1 in the body: the title comes from the frontmatter');
    if (/^## Limits\b/.test(l)) add(n, 'no `## Limits` section: put each caveat where it applies');
    if (/\$\$\S|\S\$\$/.test(l) && !/^\s*\$\$\s*$/.test(l)) add(n, 'display math: `$$` must be alone on its own line');
    const prose = l.replace(/`[^`]*`/g, '').replace(/\$[^$]*\$/g, '');
    if (/(^|[^\w'’])(I|me|my|I'm|I’m|I've|I’ve)(?=[^\w'’]|$)/.test(prose) && !/^\s*>/.test(l) && !inSources) {
      add(n, 'first person ("I", "me", "my"): notes don\'t use it');
    }
    if (!inSources && /—/.test(prose)) add(n, 'em dash in body text');
    if (/\]\((\/|https?:\/\/sungmin-kwon\.github\.io)/.test(l)) add(n, 'link to another note: notes stand on their own');
  }
  if (inCode) add(0, 'a code fence is never closed');
  if (title && !sawSources) add(0, 'no `## Sources` section');
  return out;
}
