// Builds the drafting prompt: the model's situation, the note's settings and the output format,
// then WRITING.md, the chosen conventions files and one reference note, all fetched from the
// site repo so that the prompt always follows the current guide.
export const PR_MARK = '=== PR NOTES ===';

export function buildDraftPrompt({ ctx, brief, modelLabel, tools, conventions, reference, date }) {
  const section = ctx.sections.find((s) => brief.tags.every((t) => s.tags.includes(t)));
  const bar = brief.bar && brief.bar !== 'default' ? brief.bar : section?.bar ?? 'quantitative';
  const search = tools.some((t) => t.startsWith('web_search'));
  const code = tools.includes('code_interpreter');

  const situation = [
    'You are drafting one note for a website of personal notebooks. Its writing guide, WRITING.md, follows in full below. Follow it exactly. Where the guide assumes things you cannot do, the points in this section win.',
    '',
    '## Your situation',
    '',
    '- You cannot run shell commands or open a browser. The guide\'s steps that need them (`npm run check`, `npm run build`, `npm run similar`, opening the page) are done by people after you. Never claim you did them; leave those self-check boxes unticked.',
    code
      ? '- You have a code interpreter (Python). Run every Python block in the note with it, and paste output only from a real run. R cannot be run: write R code carefully and list its output under Not verified.'
      : '- You cannot run code. If the note shows code output, write it only when you are certain of it, and list every such output under Not verified as "output not from a real run".',
    search
      ? '- You have a web search tool. Use it to check every source before you cite it: find the work\'s own page, confirm its authors, title, year, venue and DOI or URL, and read its abstract. Cite only works you found this way, with the URL you found. Also use it to check facts and numbers you are not sure of. List anything you could not confirm under Not verified.'
      : '- You have no web access. Cite only works you are sure of, and list every source under Not verified, since none was checked.',
    '- You are not given the other notes on the site, and must not refer or link to them.',
    '',
    '## This note',
    '',
    `- Notebook: ${section ? `${section.title} (/${section.path}/)` : 'unknown'}`,
    `- Tags, in this order: [${brief.tags.join(', ')}]`,
    `- The bar to meet: the ${bar} version.`,
    `- Frontmatter \`date: ${date}\` and \`model: [${modelLabel}]\`, exactly as written here.`,
    brief.slug ? `- File name: \`${brief.slug}.md\`` : '- Choose a short kebab-case file name and give it in the PR notes.',
    brief.length ? `- Length: ${brief.length}` : '',
    '',
    '## Output format',
    '',
    'Reply with exactly two parts and nothing before, between or after them:',
    '',
    '1. The complete Markdown file, starting with the `---` line of its frontmatter. Do not wrap it in a code fence.',
    `2. A line containing only \`${PR_MARK}\`, then the notes for the pull request, in Markdown: a line \`**File:** <name>.md\`; which bar the note was held to and how it meets tests 1 and 2; the self-check list from section 9 with each box ticked only if you actually checked it; and a **Not verified** section listing every claim, number or source you could not check.`,
  ].filter((l) => l !== '');

  const parts = [situation.join('\n'), `# WRITING.md\n\n${ctx.writing}`];
  for (const c of conventions) parts.push(`# ${c.path}\n\n${c.text}`);
  if (reference) {
    parts.push(
      `# Reference note: ${reference.id}.md\n\nA finished note, given only as a model of style, structure and depth. Do not reuse its topic, examples or wording.\n\n${reference.text}`,
    );
  }
  const instructions = parts.join('\n\n---\n\n');

  const input = [
    `Draft a note on this topic: ${brief.topic.trim()}`,
    brief.notes?.trim() ? `\nNotes and source material from Sungmin:\n\n${brief.notes.trim()}` : '',
  ].join('\n');

  return { instructions, input, bar, section };
}

export function revisePrompt(instruction) {
  return `Revise the note: ${instruction.trim()}\n\nReply in the same two-part format as before: the complete Markdown file, then the line ${PR_MARK} and the updated PR notes.`;
}
