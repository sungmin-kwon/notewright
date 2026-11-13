# notewright

A small local web app that drafts a note for
[sungmin-kwon.github.io](https://github.com/sungmin-kwon/sungmin-kwon.github.io) with an LLM API,
shows the tokens and estimated cost of every call, and opens the draft as a pull request.
It runs on your own computer: no login, nothing hosted.

```
topic + notebook/tags ──► system prompt: WRITING.md + chosen conventions/*.md + one reference note
                          (fetched from the site repo's main branch)
                      ──► model drafts the note (Mistral, with its web_search tool)
                      ──► preview, quick checks, cost; ask for changes as often as needed
                      ──► Open PR: new branch notewright/<name> with src/content/notes/<name>.md
```

Review stays outside the app for now (a Claude review on the PR, following `REVIEWING.md`).

## Setup

Needs Node 20.12 or later.

```sh
git clone https://github.com/sungmin-kwon/notewright
cd notewright
npm install           # only the preview's Markdown and math renderers
cp .env.example .env  # then fill it in
npm start             # → http://localhost:4318
```

`.env` holds two secrets and is never committed (it's in `.gitignore`):

- `MISTRAL_API_KEY`: from console.mistral.ai → API keys.
- `GITHUB_TOKEN`: a fine-grained token (GitHub → Settings → Developer settings → Fine-grained
  tokens) with access to **only** `sungmin-kwon.github.io`, and the permissions
  **Contents: read and write** and **Pull requests: read and write**. The app reads the guides
  with it and pushes the draft branch. It never pushes to `main` and never merges.

The server listens on `127.0.0.1` only, so other machines on the network can't reach it.

## Using it

1. **Brief.** Topic, any notes or sources you want used, notebook and tags (the first ticked is
   the main tag), which bar, conventions files to include (e.g. `east-asian.md` for a note
   citing Chinese, Korean or Japanese sources), the reference note (defaults to the guide's
   pick for the notebook; "none" saves tokens), model and tools.
2. **Draft.** With web search on, expect one to a few minutes. The model is told it can't run
   commands or open the page, so it leaves those self-check boxes unticked; with search on, it's
   told to look up every source before citing it.
3. **Read it.** Preview (marked + KaTeX, close to but not the site's renderer: a red KaTeX error
   here will also break on the site), the Markdown (editable), the PR notes (self-check and **Not
   verified**, editable), and the search results the model was given. The app sets `date`,
   `tags` and `model` in the frontmatter itself and says when it changed them. Quick checks run
   a few `npm run check` rules locally; the real `npm run check` runs in CI on the PR.
4. **Ask for changes.** Continues the same Mistral conversation, so the guide isn't resent. Each
   revision is another row in the cost table.
5. **Open PR.** The PR description has the model's PR notes, the search results, a note on which
   commands nobody ran, and the cost table.

## Cost

Each call shows input tokens, output tokens, search-result tokens (Mistral's
`connector_tokens`) and tool calls (Mistral's `connectors`, e.g. `2 web_search`), with an
estimate in dollars and a total per note. Prices live in `config.json`:

- Token prices per million, per model. As of 2026-11-13, Mistral's pricing docs list Mistral
  Large 4 at $0.70 in / $2.10 out and Small 4 at $0.15 / $0.60. Which model the
  `-latest` alias served is shown next to each call (the API reports it), so check that it
  matches the price you set.
- **Web search price per call: not set**, because Mistral's pricing page says tool calls are
  priced per call but doesn't give the figure. Until `tools.web_search.pricePerCall` is filled
  in, the dollar figure counts tokens only and the app says so. After a few runs, compare with
  the usage page in the Mistral console and set it.
- `"connectorTokens": "input"` prices search-result tokens at the input rate. That's an
  assumption to check against the bill too; set it to anything else to leave them out.

## Logs

Every call is a line in `runs/calls.jsonl` (time, stage, model asked for and model served,
tools, token counts, tool calls, estimated cost, seconds, topic, tags, and the request without
the key or the long texts), and every
opened PR is a line with its URL and the note's total. Each reply is saved in `runs/drafts/`,
and the full prompt of each draft in `runs/drafts/<session>-prompt.md`. The **Runs** tab
summarises them by model: notes, calls, average tokens, tool calls, time and cost per note.
A failed call is logged too, with `"ok": false`, the error (with its code, such as
`ECONNRESET` or `TIMEOUT`, and the HTTP status and reply body when the API answered with an
error), how long it ran, and the path of its prompt. The terminal running `npm start` prints the
same error. `runs/` is not committed.

A draft with web search can take several minutes, because Mistral answers only when the whole
reply is ready. The app waits up to 20 minutes of silence on the connection before giving up.

## Models and providers

Models are listed in `config.json` (`id`, `provider`, `label`, `price`); `label` is what goes into
the note's `model` frontmatter, so name the model as WRITING.md asks (`Mistral Large 4`).
`fake` is an offline stand-in for trying the app without spending credit.

A provider is a module in `providers/` that exports `call()`; the contract is at the top of
`providers/index.mjs`. Mistral uses the Conversations API, the endpoint that runs its built-in
`web_search`, `web_search_premium` and `code_interpreter` tools (Chat Completions doesn't).
Adding OpenRouter or Anthropic means one new file plus models in `config.json`.

## Later: review through the API

The pieces are already general: a provider call takes any system prompt and returns usage, and
each logged call has a `stage` (`draft`, `revise`). A review stage would build its prompt from
`REVIEWING.md` plus the draft, call a (usually stronger) model, log as `review`, and post the
result on the PR.

## Tests

`npm test` checks the reply parsing, frontmatter pinning, quick checks, cost arithmetic, prompt
assembly and the GitHub PR calls (against a stubbed `fetch`, nothing is pushed).

## Licence

MIT.
