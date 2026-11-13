// The prompts. Two steps, each its own conversation:
//
// 1. Research: the model plans and runs web searches and writes research notes (sources with
//    what each supports, key facts, open questions). Sungmin can read and edit them.
// 2. Draft: the model writes the note from WRITING.md, the chosen conventions files, one
//    reference note and the research notes. Revisions continue this conversation.
//
// The guide and conventions are fetched from the site repo, so the prompts follow the current
// rules.
export const PR_MARK = '=== PR NOTES ===';

function sectionOf(ctx, brief) {
  const section = ctx.sections.find((s) => brief.tags.every((t) => s.tags.includes(t)));
  const bar = brief.bar && brief.bar !== 'default' ? brief.bar : section?.bar ?? 'quantitative';
  return { section, bar };
}

/**
 * WRITING.md's rules on citations: from the "**Citations.**" paragraph to the end of the
 * "**Cite only what a reader can check.**" paragraph. The whole guide if they aren't found.
 */
export function citationRules(writing) {
  const start = writing.indexOf('**Citations.**');
  const last = writing.indexOf('**Cite only what a reader can check.**', start);
  if (start < 0 || last < 0) return writing;
  const end = writing.indexOf('\n\n', last);
  return writing.slice(start, end < 0 ? undefined : end).trim();
}

const briefText = (brief) =>
  [`Topic: ${brief.topic.trim()}`, brief.notes?.trim() ? `\nNotes and source material from Sungmin:\n\n${brief.notes.trim()}` : ''].join('\n');

export function buildResearchPrompt({ ctx, brief, conventions, maxSearches }) {
  const { section, bar } = sectionOf(ctx, brief);
  const sources = citationRules(ctx.writing);
  const lines = [
    'You are the research step for one note on a website of personal notebooks. A separate drafting step will write the note later from your research notes, usually without web access, so everything it needs about sources must be in your notes. Do not draft the note.',
    '',
    '## The note',
    '',
    `- Notebook: ${section ? `${section.title} (/${section.path}/)` : 'unknown'}, tags [${brief.tags.join(', ')}].`,
    `- It must meet the ${bar} version of the site's bar: ${bar === 'qualitative' ? 'a position argued from primary sources and scholarship, each view attributed to the author who holds it' : 'a central result derived or traced to a mechanism, and a worked example that shows something the formula alone does not'}.`,
    '',
    '## What to do',
    '',
    '1. Plan before searching: the main claims the note will need to support, the primary sources, and the standard scholarship. Then search. When the sources are in other languages (Chinese, Korean, Japanese, …), search in those languages too.',
    maxSearches
      ? `   Each search takes the better part of a minute, so make at most ${maxSearches} searches in all. Use short queries of a few key terms, not long quoted phrases, and make each search cover something the earlier ones did not. When the budget is spent, write the notes from what you have and list the rest under Open questions.`
      : '',
    '2. Open and read sources rather than relying on search snippets. Prefer primary texts, peer-reviewed work and standard reference works over blogs and encyclopedias that summarize them.',
    '3. Never invent a source, a page number or a quotation. If something cannot be found, say so under Open questions.',
    '',
    '## Reply format',
    '',
    'Do not narrate your plan or progress in the reply. When the searching is done, reply in Markdown with exactly these three sections and nothing else, starting with the line `## Sources`:',
    '',
    '## Sources',
    '',
    'One entry per source you actually found, labelled [S1], [S2], …, each with:',
    '- the citation, in the format below, with the URL you opened;',
    '- what it supports: the specific claims, numbers, dates or quotations the note could use, with their location (page, section, chapter, vol.) when visible. Copy quotations exactly; for a classical or non-English text, give the original and where it is;',
    '- how sure: "read" (you opened and read it), "abstract or snippet only", or "not opened" (known only from another source).',
    '',
    '## Key facts',
    '',
    'The facts the note will most likely rest on, each followed by the labels of the sources that support it. Note any disagreement between sources, and attribute each view.',
    '',
    '## Open questions',
    '',
    'What you searched for and could not find or confirm, and claims often made about this topic that you could not source.',
    '',
    '---',
    '',
    "Citation format and rules, from the site's writing guide (written for the note's author; for you, they say what to find and check):",
    '',
    sources,
  ];
  const parts = [lines.join('\n')];
  for (const c of conventions) parts.push(`# ${c.path}\n\n${c.text}`);
  return { instructions: parts.join('\n\n---\n\n'), input: `Research this topic for the note.\n\n${briefText(brief)}` };
}

export function buildDraftPrompt({ ctx, brief, modelLabel, tools, conventions, reference, date, research }) {
  const { section, bar } = sectionOf(ctx, brief);
  const search = tools.some((t) => t.startsWith('web_search'));
  const code = tools.includes('code_interpreter');
  const hasResearch = !!research?.trim();

  const situation = [
    'You are drafting one note for a website of personal notebooks. Its writing guide, WRITING.md, follows in full below. Follow it exactly. Where the guide assumes things you cannot do, the points in this section win.',
    '',
    '## Your situation',
    '',
    "- You cannot run shell commands or open a browser. The guide's steps that need them (`npm run check`, `npm run build`, `npm run similar`, opening the page) are done by people after you. Never claim you did them; leave those self-check boxes unticked.",
    code
      ? '- You have a code interpreter (Python). Run every Python block in the note with it, and paste output only from a real run. R cannot be run: write R code carefully and list its output under Not verified.'
      : '- You cannot run code. If the note shows code output, write it only when you are certain of it, and list every such output under Not verified as "output not from a real run".',
    hasResearch
      ? '- The user message contains research notes from an earlier step: sources labelled [S1], [S2], … with what each supports and how sure the researcher was, key facts, and open questions. They are your sources. Cite only works listed there, with the details given there. Cut any claim they do not support, or list it under Not verified. Every source the notes mark "abstract or snippet only" or "not opened", and every open question the note touches, goes under Not verified.'
      : '',
    search
      ? `- You have a web search tool. ${hasResearch ? 'Use it only to check something the research notes leave open.' : "Use it to check every source before you cite it: find the work's own page, confirm its authors, title, year, venue and DOI or URL, and read its abstract. Cite only works you found this way, with the URL you found."} List anything you could not confirm under Not verified.`
      : hasResearch
        ? '- You have no web access beyond the research notes.'
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
  const input = [`Draft the note.\n\n${briefText(brief)}`, hasResearch ? `\n\n# Research notes\n\n${research.trim()}` : ''].join('');
  return { instructions: parts.join('\n\n---\n\n'), input, bar, section };
}

export function revisePrompt(instruction) {
  return `Revise the note: ${instruction.trim()}\n\nReply in the same two-part format as before: the complete Markdown file, then the line ${PR_MARK} and the updated PR notes.`;
}
