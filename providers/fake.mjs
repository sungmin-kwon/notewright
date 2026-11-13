// An offline stand-in for trying the app without spending credit. It streams its reply in a
// few seconds, with two pretend searches when a search tool is on. Token counts are rough
// (characters / 4) so the cost table has something to show.
export const TOOLS = ['web_search'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RESEARCH = `## Sources

- [S1] Example Author, "An example paper", *Journal* 1, 1–2 (2000). [doi:10.0000/example](https://doi.org/10.0000/example)
  - Supports: the made-up fact that the fake model exists (p. 1).
  - How sure: read.

## Key facts

- The fake model streams text in pieces. [S1]

## Open questions

- Everything real.
`;

export async function call({ instructions = '', input, tools = [], state, onEvent = () => {} }) {
  const searched = tools.includes('web_search');
  if (searched) {
    for (const [i, q] of ['fake query one', 'fake query two'].entries()) {
      onEvent({ type: 'tool', id: `t${i}`, tool: 'web_search', query: q });
      await wait(400);
      onEvent({ type: 'tool-done', id: `t${i}`, tool: 'web_search', query: q });
    }
  }
  const research = instructions.includes('You are the research step');
  const reply = research ? RESEARCH : draft({ instructions, input, state });
  for (let i = 0; i < reply.length; i += 80) {
    onEvent({ type: 'text', text: reply.slice(i, i + 80), refs: i === 0 && searched ? [{ title: 'Example search result', url: 'https://example.org/', tool: 'web_search' }] : [] });
    await wait(15);
  }
  const inputTokens = Math.round(((state ? 0 : instructions.length) + input.length + (state?.chars ?? 0)) / 4);
  return {
    text: reply,
    references: searched ? [{ title: 'Example search result', url: 'https://example.org/', tool: 'web_search' }] : [],
    usage: {
      inputTokens,
      outputTokens: Math.round(reply.length / 4),
      connectorTokens: searched ? 1200 : 0,
      toolCalls: searched ? { web_search: 2 } : {},
    },
    servedModel: 'fake-1',
    state: { turn: (state?.turn ?? 0) + 1, chars: (state?.chars ?? 0) + instructions.length + input.length + reply.length },
    request: { fake: true },
  };
}

function draft({ instructions, input, state }) {
  const turn = (state?.turn ?? 0) + 1;
  const topic = input.match(/Topic: (.+)/)?.[1] ?? 'a test topic';
  const tags = instructions.match(/Tags, in this order: \[(.*)\]/)?.[1] ?? '';
  const date = instructions.match(/`date: ([\d-]+)`/)?.[1] ?? '2026-01-01';
  const model = instructions.match(/`model: \[(.*?)\]`/)?.[1] ?? 'Fake model';
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
  return text;
}
