// Mistral, through the Conversations API (POST /v1/conversations), which is the endpoint that
// runs Mistral's built-in tools (web_search, web_search_premium, code_interpreter) on Mistral's
// side; Chat Completions doesn't support them. A follow-up appends to the same conversation
// (POST /v1/conversations/{id}), so the long system prompt isn't sent again as new text (the
// API still counts the conversation so far as prompt tokens).
//
// The reply is streamed (server-sent events), so searches and text show up as they happen and
// no timeout hits a long run. Event types, from Mistral's API schema:
//   conversation.response.started  { conversation_id }
//   tool.execution.started         { name, arguments }   e.g. web_search with its query
//   tool.execution.done            { name, info }
//   message.output.delta           { content, model }    a string, or chunks
//                                  ({type:"text", text} | {type:"tool_reference", title, url, tool})
//   conversation.response.done     { usage }  prompt_tokens, completion_tokens,
//                                             connector_tokens, connectors { web_search: <calls> }
//   conversation.response.error    { message, code }
import { need } from '../lib/env.mjs';
import { postSSE, HttpError } from '../lib/http.mjs';
import { debugLog } from '../lib/log.mjs';

// MISTRAL_API_BASE is only for tests (a local stand-in server).
const API = () => process.env.MISTRAL_API_BASE || 'https://api.mistral.ai/v1';
export const TOOLS = ['web_search', 'web_search_premium', 'code_interpreter'];

export async function call({ model, instructions, input, tools = [], state, temperature, onEvent = () => {} }) {
  const key = need('MISTRAL_API_KEY');
  const completion_args = temperature == null ? undefined : { temperature };
  const inputs = [{ role: 'user', content: input }];
  const url = state?.conversationId ? `${API()}/conversations/${state.conversationId}` : `${API()}/conversations`;
  const body = state?.conversationId
    ? { inputs, stream: true, store: true, completion_args }
    : { model, instructions, inputs, tools: tools.map((type) => ({ type })), completion_args, stream: true, store: true, name: 'notewright' };

  // What the log keeps about the request: everything but the key and the long texts.
  const request = {
    url,
    model: state?.conversationId ? undefined : model,
    tools: state?.conversationId ? undefined : tools,
    instructionsChars: state?.conversationId ? 0 : instructions?.length ?? 0,
    inputChars: input.length,
    completion_args,
  };

  const acc = newAccumulator();
  let res;
  try {
    res = await postSSE(url, {
      headers: { Authorization: `Bearer ${key}` },
      body,
      onOpen: (status) => onEvent({ type: 'open', status }),
      onEvent: (name, data) => {
        debugLog(name, data);
        onEvent({ type: 'raw', name: data?.type ?? name });
        const ev = acc.add(name, data);
        if (ev) onEvent(ev);
      },
    });
  } catch (e) {
    throw Object.assign(e, { request });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(`Mistral answered ${res.status}: ${res.text.slice(0, 500)}`, { status: res.status, request, response: res.text.slice(0, 2000) });
  }
  if (acc.error) throw new HttpError(`Mistral reported an error mid-stream: ${acc.error}`, { request, code: acc.errorCode });
  if (!acc.done) throw new HttpError('the stream ended before Mistral said it was done', { request, code: 'INCOMPLETE' });
  return { ...acc.result(), request };
}

/** Folds the stream's events into the final reply; returns a simpler event for the page. */
export function newAccumulator() {
  let text = '';
  let servedModel;
  let conversationId;
  let usage = {};
  const refs = [];
  const toolRuns = {};
  const calls = {};
  const a = {
    done: false,
    error: null,
    add(name, d) {
      const type = d?.type ?? name;
      switch (type) {
        case 'conversation.response.started':
          conversationId = d.conversation_id;
          return null;
        case 'tool.execution.started':
        case 'tool.execution.delta': {
          // The arguments (for web_search, the query) may come whole with `started`, or in
          // pieces in `delta` events; keep them per call id.
          const id = d.id ?? `${d.name}-${Object.keys(calls).length}`;
          if (type === 'tool.execution.started') toolRuns[d.name] = (toolRuns[d.name] ?? 0) + 1;
          calls[id] = { tool: d.name, args: (calls[id]?.args ?? '') + (d.arguments ?? '') };
          return { type: 'tool', id, tool: d.name, query: queryOf(calls[id].args) };
        }
        case 'tool.execution.done': {
          const id = d.id ?? Object.keys(calls).at(-1);
          return { type: 'tool-done', id, tool: d.name, query: queryOf(calls[id]?.args ?? '') };
        }
        case 'message.output.delta': {
          servedModel ??= d.model;
          const chunks = typeof d.content === 'string' ? [{ type: 'text', text: d.content }] : Array.isArray(d.content) ? d.content : d.content ? [d.content] : [];
          let delta = '';
          const newRefs = [];
          for (const c of chunks) {
            if (c.type === 'text') delta += c.text;
            else if (c.type === 'tool_reference') {
              const r = { title: c.title, url: c.url ?? null, tool: typeof c.tool === 'string' ? c.tool : String(c.tool) };
              if (!refs.some((x) => (x.url ?? x.title) === (r.url ?? r.title))) {
                refs.push(r);
                newRefs.push(r);
              }
            }
          }
          text += delta;
          return delta || newRefs.length ? { type: 'text', text: delta, refs: newRefs } : null;
        }
        case 'conversation.response.done':
          usage = d.usage ?? {};
          a.done = true;
          return null;
        case 'conversation.response.error':
          a.error = d.message ?? JSON.stringify(d);
          a.errorCode = d.code;
          return null;
        default:
          return null;
      }
    },
    result() {
      const toolCalls = usage.connectors && Object.keys(usage.connectors).length ? usage.connectors : toolRuns;
      return {
        text,
        references: refs,
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          connectorTokens: usage.connector_tokens ?? 0,
          toolCalls,
        },
        servedModel,
        state: { conversationId },
      };
    },
  };
  return a;
}

function queryOf(args) {
  if (!args) return '';
  try {
    const a = JSON.parse(args);
    return typeof a === 'object' && a ? a.query ?? a.q ?? JSON.stringify(a) : String(a);
  } catch {
    return args; // still arriving
  }
}
