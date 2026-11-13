// Every call is one line in runs/calls.jsonl, so models can be compared later. Each draft's text
// is also kept in runs/drafts/, so nothing is lost if the page is closed.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const DIR = new URL('../runs/', import.meta.url);
const CALLS = new URL('calls.jsonl', DIR);
const DRAFTS = new URL('drafts/', DIR);

export function logCall(entry) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(CALLS, `${JSON.stringify(entry)}\n`);
}

export function saveDraft(name, text) {
  mkdirSync(DRAFTS, { recursive: true });
  writeFileSync(new URL(name, DRAFTS), text);
}

export function readCalls() {
  if (!existsSync(CALLS)) return [];
  return readFileSync(CALLS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
