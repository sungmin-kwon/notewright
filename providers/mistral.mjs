// Mistral, through the Conversations API (POST /v1/conversations), which is the endpoint that
// runs Mistral's built-in tools (web_search, web_search_premium, code_interpreter) on Mistral's
// side; Chat Completions doesn't support them. A follow-up appends to the same conversation
// (POST /v1/conversations/{id}), so the guide isn't sent, or billed, again as new input text
// (the API still counts the conversation so far as prompt tokens).
//
// Response fields used (from Mistral's API schema): outputs[] of entries; "message.output"
// entries hold `content`, a string or a list of chunks ({type:"text", text} or
// {type:"tool_reference", title, url, tool}); `usage` has prompt_tokens, completion_tokens,
// connector_tokens and connectors ({ web_search: <calls> }).
import { need } from '../lib/env.mjs';

const API = 'https://api.mistral.ai/v1';
export const TOOLS = ['web_search', 'web_search_premium', 'code_interpreter'];

export async function call({ model, instructions, input, tools = [], state, temperature }) {
  const key = need('MISTRAL_API_KEY');
  const completion_args = temperature == null ? undefined : { temperature };
  const inputs = [{ role: 'user', content: input }];
  const [url, body] = state?.conversationId
    ? [`${API}/conversations/${state.conversationId}`, { inputs, stream: false, store: true, completion_args }]
    : [
        `${API}/conversations`,
        {
          model,
          instructions,
          inputs,
          tools: tools.map((type) => ({ type })),
          completion_args,
          stream: false,
          store: true,
          name: 'notewright draft',
        },
      ];
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Mistral ${res.status}: ${raw.slice(0, 500)}`);
  return parse(JSON.parse(raw));
}

export function parse(data) {
  let text = '';
  let servedModel;
  const references = [];
  const toolRuns = {};
  for (const out of data.outputs ?? []) {
    if (out.type === 'tool.execution') toolRuns[out.name] = (toolRuns[out.name] ?? 0) + 1;
    if (out.type !== 'message.output') continue;
    servedModel ??= out.model;
    const chunks = typeof out.content === 'string' ? [{ type: 'text', text: out.content }] : out.content ?? [];
    for (const c of chunks) {
      if (c.type === 'text') text += c.text;
      else if (c.type === 'tool_reference') {
        references.push({ title: c.title, url: c.url ?? null, tool: typeof c.tool === 'string' ? c.tool : String(c.tool) });
      }
    }
  }
  const u = data.usage ?? {};
  // `connectors` counts calls per tool; fall back to counting tool.execution entries.
  const toolCalls = u.connectors && Object.keys(u.connectors).length ? u.connectors : toolRuns;
  return {
    text,
    references: dedupe(references),
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      connectorTokens: u.connector_tokens ?? 0,
      toolCalls,
    },
    servedModel,
    state: { conversationId: data.conversation_id },
  };
}

function dedupe(refs) {
  const seen = new Set();
  return refs.filter((r) => {
    const k = r.url ?? r.title;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
