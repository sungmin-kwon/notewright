// The provider layer. A provider is a module that exports `call(request)`:
//
//   request = {
//     model,          // the provider's model id, from config.json
//     instructions,   // system prompt (only on the first call of a conversation)
//     input,          // the user's message
//     tools,          // built-in tool names the user turned on, e.g. ['web_search']
//     state,          // null on the first call; afterwards whatever the last call returned,
//                     // passed back unchanged so a follow-up continues the same conversation
//     temperature,
//   }
//
// and resolves to
//
//   {
//     text,            // the model's reply as plain text
//     references,      // [{ title, url, tool }] the tools returned (search results), may be []
//     usage: { inputTokens, outputTokens, connectorTokens, toolCalls: { web_search: 2 } },
//     servedModel,     // the model the API says answered, when it says
//     state,           // opaque; for Mistral, the conversation id
//   }
//
// To add OpenRouter or Anthropic: write providers/<name>.mjs with `call`, add it below, and
// list its models in config.json with "provider": "<name>". The same `call` will serve the
// review stage later (a different prompt, the same plumbing).
import * as mistral from './mistral.mjs';
import * as fake from './fake.mjs';

const PROVIDERS = { mistral, fake };

export function provider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`unknown provider "${name}" (known: ${Object.keys(PROVIDERS).join(', ')})`);
  return p;
}

/** Which built-in tools each provider can use, for the form. */
export const TOOLS = Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, p.TOOLS ?? []]));
