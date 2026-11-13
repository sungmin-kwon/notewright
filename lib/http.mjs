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
