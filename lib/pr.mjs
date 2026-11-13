// The pull request description: the model's PR notes (self-check and Not verified, as
// WRITING.md section 10 asks), what was not run, the search results it was given, and the cost.
import { sumUsage } from './cost.mjs';

const usd = (x) => `$${x.toFixed(4)}`;
const n = (x) => (x ?? 0).toLocaleString('en-US');
const calls = (o) => Object.entries(o ?? {}).map(([k, v]) => `${v} ${k}`).join(', ') || '0';

export function costTable(list) {
  const rows = list.map(
    (c, i) =>
      `| ${i + 1} | ${c.stage} | ${c.label}${c.servedModel ? ` (\`${c.servedModel}\`)` : ''} | ${n(c.usage.inputTokens)} | ${n(c.usage.outputTokens)} | ${n(c.usage.connectorTokens)} | ${calls(c.usage.toolCalls)} | ${usd(c.cost.total)} |`,
  );
  const t = sumUsage(list);
  rows.push(`| | **total** | | **${n(t.inputTokens)}** | **${n(t.outputTokens)}** | **${n(t.connectorTokens)}** | **${calls(t.toolCalls)}** | **${usd(t.cost)}** |`);
  const note = t.unpriced.length
    ? `\n\nThe cost is for tokens only: no price per call is set in notewright's config.json for ${t.unpriced.join(', ')}.`
    : '';
  return `| # | stage | model | input tokens | output tokens | search-result tokens | tool calls | est. cost |\n|---|---|---|--:|--:|--:|--:|--:|\n${rows.join('\n')}${note}`;
}

export function prBody({ slug, calls: list, prNotes, references, edited, cfg }) {
  const models = [...new Set(list.map((c) => c.label))].join(', ');
  const tools = [...new Set(list.flatMap((c) => c.tools ?? []))];
  const refs = references.length
    ? references.map((r) => `- ${r.url ? `[${r.title}](${r.url})` : r.title}`).join('\n')
    : '_none_';
  return `Drafted with [notewright](https://github.com/sungmin-kwon/notewright) by ${models}${tools.length ? `, with ${tools.join(', ')}` : ', without tools'}. ${edited ? 'Sungmin edited the draft in the app before opening this PR.' : 'The file is the model\'s draft as returned, with `date`, `tags` and `model` set by the app.'}

New file: \`${cfg.site.notesDir}/${slug}.md\`

## Commands

None were run by the drafting model, which can't run them. CI runs \`npm run check\` on this PR. \`npm run build\`, \`npm run similar -- ${slug}\` and opening the page are left for the review.

## Notes from the drafting model

${prNotes.trim() || '_The model gave no PR notes._'}

## Search results the model was given

${refs}

## Cost

${costTable(list)}

Prices from notewright's config.json; estimates, not the bill.
`;
}
