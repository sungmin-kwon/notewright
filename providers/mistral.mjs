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

export async function call({ model, instructions, input, tools = [], state, temperature, maxToolCalls, onEvent = () => {} }) {
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
    maxToolCalls,
  };

  const first = await streamOnce({ key, url, body, request, onEvent, maxToolCalls });
  if (!first.stopped) return { ...first.acc.result(), request };

  // The tool budget is spent. Mistral's built-in tools can't be capped from outside, so the app
  // closed the stream when the model started one call too many. Now it asks, in the same
  // conversation, for the reply from what the model has, with tools switched off.
  const so = first.acc.result();
  if (!so.state.conversationId) throw new HttpError('stopped at the tool limit before Mistral gave a conversation id', { request, code: 'STOPPED' });
  onEvent({ type: 'limit', max: maxToolCalls });
  const wrapUp = {
    inputs: [{ role: 'user', content: `Stop: the limit of ${maxToolCalls} searches and page opens is reached, and no more tool calls are allowed. Write your reply now from what you have already found, in the format asked for. Put anything you did not get to check under Open questions.` }],
    stream: true,
    store: true,
    completion_args: { ...completion_args, tool_choice: 'none' },
  };
  const wrap = (b) =>
    streamOnce({
      key,
      url: `${API()}/conversations/${so.state.conversationId}`,
      body: b,
      request: { ...request, wrapUp: true },
      onEvent,
      maxToolCalls: 0, // any further tool call ends the stream; take whatever text there is
    });
  let second;
  try {
    second = await wrap(wrapUp);
  } catch (e) {
    // If the API refuses tool_choice on a follow-up, ask again without it.
    if (!(e.status >= 400 && e.status < 500)) throw e;
    await new Promise((r) => setTimeout(r, 3000)); // in case the cut-off run was still finishing
    second = await wrap({ ...wrapUp, completion_args });
  }
  const r = second.acc.result();
  return {
    ...r,
    references: [...so.references, ...r.references.filter((x) => !so.references.some((y) => (y.url ?? y.title) === (x.url ?? x.title)))],
    usage: {
      ...r.usage,
      // The cut-off part of the run never reported its usage; its tool calls are counted here,
      // its tokens are not (they are billed, so the estimate is low).
      toolCalls: mergeCounts(so.usage.toolCalls, r.usage.toolCalls),
      incomplete: true,
    },
    servedModel: r.servedModel ?? so.servedModel,
    request: { ...request, stoppedAtToolLimit: true },
  };
}

async function streamOnce({ key, url, body, request, onEvent, maxToolCalls }) {
  const acc = newAccumulator();
  let started = 0;
  let res;
  try {
    res = await postSSE(url, {
      headers: { Authorization: `Bearer ${key}` },
      body,
      onOpen: (status) => onEvent({ type: 'open', status }),
      onEvent: (name, data) => {
        debugLog(name, data);
        const type = data?.type ?? name;
        onEvent({ type: 'raw', name: type });
        if (type === 'tool.execution.started' && maxToolCalls != null && ++started > maxToolCalls) return false;
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
  if (res.stopped) return { acc, stopped: true };
  if (!acc.done) throw new HttpError('the stream ended before Mistral said it was done', { request, code: 'INCOMPLETE' });
  return { acc, stopped: false };
}

function mergeCounts(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
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
    if (a && typeof a === 'object' && a.url && !a.query) return `open ${a.url}`;
    return typeof a === 'object' && a ? a.query ?? a.q ?? JSON.stringify(a) : String(a);
  } catch {
    return args; // still arriving
  }
}
