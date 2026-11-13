// An offline stand-in that answers instantly, for trying the app without spending credit.
// Token counts are rough (characters / 4) so the cost table has something to show.
export const TOOLS = ['web_search'];

export async function call({ instructions = '', input, tools = [], state }) {
  const turn = (state?.turn ?? 0) + 1;
  const topic = input.match(/topic: (.+)/)?.[1] ?? 'a test topic';
  const tags = instructions.match(/Tags, in this order: \[(.*)\]/)?.[1] ?? '';
  const date = instructions.match(/`date: ([\d-]+)`/)?.[1] ?? '2026-01-01';
  const model = instructions.match(/`model: \[(.*?)\]`/)?.[1] ?? 'Fake model';
  const searched = tools.includes('web_search');
  const text = `---
title: ${topic.replace(/[:]/g, ' -')}
date: ${date}
tags: [${tags}]
summary: A placeholder note from the offline fake model (turn ${turn}).
distillate: Nothing here is real. This draft only exercises the app.
model: [${model}]
---

The fake model wrote this so the preview, checks and cost table can be tried.

## An equation

The score has mean zero:

$$
\\mathbb{E}_\\theta\\left[\\frac{\\partial}{\\partial\\theta}\\log f(X;\\theta)\\right] = 0
$$

Inline math like $I(\\theta) = 1/\\theta^2$ renders too, and I left a first-person word here
on purpose so the checks catch it.

\`\`\`python
print("hello from a code block")
\`\`\`

## Sources

- Example Author, "An example paper", *Journal* 1, 1–2 (2000). [doi:10.0000/example](https://doi.org/10.0000/example)

=== PR NOTES ===

**File:** fake-note-${turn}.md

**Bar:** quantitative. Test 1 and 2: not met, this is a fake.

**Not verified**

- Everything.
`;
  const inputTokens = Math.round(((state ? 0 : instructions.length) + input.length + (state?.chars ?? 0)) / 4);
  return {
    text,
    references: searched ? [{ title: 'Example search result', url: 'https://example.org/', tool: 'web_search' }] : [],
    usage: {
      inputTokens,
      outputTokens: Math.round(text.length / 4),
      connectorTokens: searched ? 1200 : 0,
      toolCalls: searched ? { web_search: 2 } : {},
    },
    servedModel: 'fake-1',
    state: { turn, chars: (state?.chars ?? 0) + instructions.length + input.length + text.length },
  };
}
