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
import { postJSON, HttpError } from '../lib/http.mjs';

// MISTRAL_API_BASE is only for tests (a local stand-in server).
const API = process.env.MISTRAL_API_BASE || 'https://api.mistral.ai/v1';
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
  // What the log keeps about the request: everything but the key and the long texts.
  const summary = {
    url,
    model: state?.conversationId ? undefined : model,
    tools,
    instructionsChars: state?.conversationId ? 0 : instructions?.length ?? 0,
    inputChars: input.length,
    completion_args,
  };
  let res;
  try {
    res = await postJSON(url, { headers: { Authorization: `Bearer ${key}` }, body });
  } catch (e) {
    throw Object.assign(e, { request: summary });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(`Mistral answered ${res.status}: ${res.text.slice(0, 500)}`, { status: res.status, request: summary, response: res.text.slice(0, 2000) });
  }
  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new HttpError(`Mistral's reply was not JSON: ${res.text.slice(0, 300)}`, { status: res.status, request: summary, response: res.text.slice(0, 2000) });
  }
  return { ...parse(data), request: summary };
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
