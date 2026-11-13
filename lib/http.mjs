// POST a JSON body and read the whole reply, with node:https rather than fetch.
//
// Why not fetch: Node's built-in fetch (undici) gives up when a server takes more than 300 s to
// send its response headers, and reports only "fetch failed". A Mistral draft with web search
// can run longer than that, because the API answers only when the whole reply is ready. Here the
// only limit is `timeoutMs` of silence on the connection (default 20 minutes), and a failure
// says what went wrong (timeout, connection reset, DNS, TLS) and after how long.
import https from 'node:https';
import http from 'node:http';

export class HttpError extends Error {
  constructor(message, details) {
    super(message);
    Object.assign(this, details);
  }
}

export function postJSON(url, { headers = {}, body, timeoutMs = 20 * 60 * 1000 } = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  const data = Buffer.from(JSON.stringify(body));
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': data.length, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => reject(fail(e, 'while reading the reply')));
        res.on('aborted', () => reject(new HttpError(`${u.host} closed the connection in the middle of the reply after ${secs()} s`, { code: 'ABORTED', seconds: secs() })));
      },
    );
    const fail = (e, when) =>
      new HttpError(`request to ${u.host} failed ${when} after ${secs()} s: ${e.code ? `${e.code} ` : ''}${e.message}`, { code: e.code, seconds: secs() });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`no data for ${timeoutMs / 1000} s`), { code: 'TIMEOUT' })));
    req.on('error', (e) => reject(fail(e, 'before a reply')));
    req.end(data);
  });
}

/**
 * POST a JSON body and read a server-sent-event stream, calling `onEvent(name, data)` for each
 * event as it arrives (`data` parsed as JSON when it is JSON). Resolves to { status } when the
 * stream ends, or, for a non-2xx answer, to { status, text } with the body. If `onEvent` returns
 * false, the connection is closed at once and the promise resolves to { status, stopped: true }.
 */
export function postSSE(url, { headers = {}, body, timeoutMs = 20 * 60 * 1000, onEvent, onOpen = () => {} }) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  const data = Buffer.from(JSON.stringify(body));
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  return new Promise((resolve, reject) => {
    const fail = (e, when) =>
      new HttpError(`request to ${u.host} failed ${when} after ${secs()} s: ${e.code ? `${e.code} ` : ''}${e.message}`, { code: e.code, seconds: secs() });
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': data.length, ...headers },
      },
      (res) => {
        onOpen(res.statusCode);
        res.setEncoding('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, text }));
          return;
        }
        let buf = '';
        const flush = (block) => {
          let name = 'message';
          const lines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
          }
          if (!lines.length) return;
          const raw = lines.join('\n');
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {}
          if (onEvent(name, parsed) === false) stopped = true;
        };
        let stopped = false;
        res.on('data', (chunk) => {
          buf += chunk.replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            try {
              flush(block);
            } catch (e) {
              req.destroy(e);
            }
            if (stopped) {
              resolve({ status: res.statusCode, stopped: true });
              res.destroy();
              req.destroy();
              return;
            }
          }
        });
        res.on('end', () => {
          if (buf.trim()) flush(buf);
          resolve({ status: res.statusCode });
        });
        res.on('error', (e) => reject(fail(e, 'while reading the stream')));
        res.on('aborted', () => reject(new HttpError(`${u.host} closed the stream after ${secs()} s`, { code: 'ABORTED', seconds: secs() })));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`no data for ${timeoutMs / 1000} s`), { code: 'TIMEOUT' })));
    req.on('error', (e) => reject(fail(e, 'before or during the reply')));
    req.end(data);
  });
}
