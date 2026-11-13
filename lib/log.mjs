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

// With NOTEWRIGHT_DEBUG=1, every streamed event goes to runs/stream.log with its time, so a run
// that seems stuck can be checked against what the API actually sent.
const STREAM = new URL('stream.log', DIR);
export function debugLog(name, data) {
  if (!process.env.NOTEWRIGHT_DEBUG) return;
  mkdirSync(DIR, { recursive: true });
  appendFileSync(STREAM, `${new Date().toISOString()} ${name} ${JSON.stringify(data).slice(0, 1000)}\n`);
}
