// Tiny WebSocket server that brokers prompts between Claude (or anyone with a
// shell) and the iPhone app's "client mode". The phone connects, server holds
// onto the socket, and we feed it inference requests one at a time.
//
// Wire protocol (matches App.tsx PromptEvalScreen):
//   Phone → server: { type: 'hello', model }                       (on connect)
//                   { type: 'response', id, response }              (on success)
//                   { type: 'error',    id, error }                 (on failure)
//   Server → phone: { type: 'inference', id, prompt }
//
// Run with:    node eval_server/server.mjs
// Tunnel with: cloudflared tunnel --url http://localhost:9000
//              (set EVAL_WS_URL in App.tsx to the wss:// URL it prints)
//
// Push prompts via JSON-RPC-ish HTTP:
//   POST /enqueue {"prompts": [{"id":"...", "prompt":"..."}, ...]}  → 200
//   GET  /results?ids=a,b,c  → JSONL of any received results, 204 if none yet
//   GET  /status             → { connected, queued, completed }

import { WebSocketServer } from 'ws';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.EVAL_PORT ?? 9000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'log');
fs.mkdirSync(LOG_DIR, { recursive: true });
const SESSION_LOG = path.join(LOG_DIR, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
function logLine(rec) {
  const line = JSON.stringify({ ts: Date.now(), ...rec }) + '\n';
  fs.appendFileSync(SESSION_LOG, line);
}

let phoneSocket = null;
let phoneInfo = null;
const queue = [];                 // pending inference requests
const inFlight = new Map();       // id -> { prompt, sentAt }
const results = new Map();        // id -> { response?, error?, durationMs, receivedAt }

function flushQueue() {
  if (!phoneSocket || phoneSocket.readyState !== 1) return;
  while (queue.length > 0) {
    const req = queue.shift();
    inFlight.set(req.id, { prompt: req.prompt, sentAt: Date.now() });
    try {
      phoneSocket.send(JSON.stringify({ type: 'inference', id: req.id, prompt: req.prompt }));
      logLine({ ev: 'sent', id: req.id, prompt: req.prompt });
    } catch (err) {
      console.error('[ws] send failed', err);
      queue.unshift(req);
      inFlight.delete(req.id);
      break;
    }
  }
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/status') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      connected: phoneSocket?.readyState === 1,
      phoneInfo,
      queued: queue.length,
      inFlight: inFlight.size,
      completed: results.size,
    }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/results') {
    const idsParam = url.searchParams.get('ids');
    const ids = idsParam ? idsParam.split(',').filter(Boolean) : [...results.keys()];
    const lines = ids
      .map(id => results.get(id) && JSON.stringify({ id, ...results.get(id) }))
      .filter(Boolean)
      .join('\n');
    if (!lines) { res.statusCode = 204; res.end(); return; }
    res.setHeader('content-type', 'application/x-ndjson');
    res.end(lines + '\n');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/enqueue') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('bad json'); return; }
      const items = Array.isArray(payload?.prompts) ? payload.prompts : [];
      let added = 0;
      for (const item of items) {
        const id = String(item.id ?? randomUUID());
        const prompt = String(item.prompt ?? '');
        if (!prompt) continue;
        queue.push({ id, prompt });
        logLine({ ev: 'enqueued', id, prompt });
        added++;
      }
      flushQueue();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ added, queued: queue.length }));
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/clear') {
    queue.length = 0;
    inFlight.clear();
    results.clear();
    res.end('ok');
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws, req) => {
  console.log(`[ws] connection from ${req.socket.remoteAddress}`);
  if (phoneSocket && phoneSocket.readyState === 1) {
    console.log('[ws] closing previous phone socket');
    try { phoneSocket.close(); } catch {}
  }
  phoneSocket = ws;
  phoneInfo = null;

  ws.on('message', buf => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (err) {
      console.error('[ws] bad json from phone', err);
      return;
    }
    if (msg.type === 'hello') {
      phoneInfo = { model: msg.model, helloAt: Date.now() };
      console.log('[ws] hello', phoneInfo);
      logLine({ ev: 'hello', ...phoneInfo });
      flushQueue();
      return;
    }
    if (msg.type === 'response' || msg.type === 'error') {
      const id = msg.id;
      const sent = inFlight.get(id);
      const durationMs = sent ? Date.now() - sent.sentAt : null;
      const rec = msg.type === 'response'
        ? { response: msg.response, durationMs, receivedAt: Date.now() }
        : { error: msg.error, durationMs, receivedAt: Date.now() };
      results.set(id, rec);
      inFlight.delete(id);
      const preview = (msg.response ?? msg.error ?? '').slice(0, 80).replace(/\n/g, '↵');
      console.log(`[ws] ${msg.type} ${id} (${durationMs}ms)  ${preview}`);
      logLine({ ev: msg.type, id, durationMs, ...(msg.response ? { response: msg.response } : { error: msg.error }) });
      flushQueue();
    }
  });

  ws.on('close', () => {
    console.log('[ws] phone disconnected');
    if (phoneSocket === ws) phoneSocket = null;
  });
});

httpServer.listen(PORT, () => {
  console.log(`[eval-server] listening on http://localhost:${PORT}`);
  console.log(`               session log: ${SESSION_LOG}`);
  console.log(`               next: cloudflared tunnel --url http://localhost:${PORT}`);
});
