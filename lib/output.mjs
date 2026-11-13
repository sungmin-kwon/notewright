// Turns the model's reply into the note file and the PR notes, and pins the frontmatter fields
// that the app, not the model, decides.
import { PR_MARK } from './prompt.mjs';

export function splitReply(text) {
  let [note, ...rest] = text.split(new RegExp(`^\\s*${PR_MARK}\\s*$`, 'm'));
  let prNotes = rest.join('\n').trim();
  note = note.trim();
  // A model may wrap the file in a fence anyway, or say something before it.
  let preamble = '';
  const fenced = note.match(/^([\s\S]*?)```(?:markdown|md)?\n(---\n[\s\S]*?)\n```$/);
  if (fenced) [preamble, note] = [fenced[1].trim(), fenced[2].trim()];
  const start = note.indexOf('---\n');
  if (start > 0) {
    preamble = [preamble, note.slice(0, start).trim()].filter(Boolean).join(' ');
    note = note.slice(start);
  }
  return { markdown: `${note}\n`, prNotes, preamble };
}

/** The frontmatter as { lines, start, end } (line indexes of the two `---`), or null. */
function frontmatter(md) {
  const lines = md.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  return end > 0 ? { lines, end } : null;
}

export function getField(md, key) {
  const fm = frontmatter(md);
  if (!fm) return undefined;
  const line = fm.lines.slice(1, fm.end).find((l) => l.startsWith(`${key}:`));
  if (!line) return undefined;
  return line.slice(key.length + 1).trim().replace(/^"(.*)"$/, '$1');
}

/** Sets `key: value` in the frontmatter (replacing or adding the line). Returns the new text. */
export function setField(md, key, value) {
  const fm = frontmatter(md);
  if (!fm) return `---\n${key}: ${value}\n---\n\n${md}`;
  const i = fm.lines.findIndex((l, j) => j > 0 && j < fm.end && l.startsWith(`${key}:`));
  if (i > 0) fm.lines[i] = `${key}: ${value}`;
  else fm.lines.splice(fm.end, 0, `${key}: ${value}`);
  return fm.lines.join('\n');
}

/** Fixes date, tags and model to the app's values and reports what it changed. */
export function pinFrontmatter(md, { date, tags, modelLabels }) {
  const changed = [];
  const want = { date, tags: `[${tags.join(', ')}]`, model: `[${modelLabels.join(', ')}]` };
  for (const [k, v] of Object.entries(want)) {
    const had = getField(md, k);
    if (k === 'date' && had) continue; // keep a date the model wrote
    if (had !== v) {
      md = setField(md, k, v);
      changed.push(had === undefined ? `added \`${k}: ${v}\`` : `set \`${k}\` to \`${v}\` (was \`${had}\`)`);
    }
  }
  return { markdown: md, changed };
}

/** The file name the PR notes give (`**File:** x.md`), else one made from the title. */
export function guessSlug(md, prNotes) {
  const named = prNotes.match(/\*\*File:\*\*\s*`?([a-z0-9-]+)\.md/i)?.[1];
  if (named) return named.toLowerCase();
  const title = getField(md, 'title') ?? 'untitled-note';
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-$/, '');
}

/** The research reply from its `## Sources` heading on: drops any plan the model wrote first. */
export function researchNotes(text) {
  const i = text.search(/^## Sources\s*$/m);
  return (i > 0 ? text.slice(i) : text).trim();
}
