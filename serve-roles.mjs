#!/usr/bin/env node
/**
 * serve-roles.mjs — local companion server for ai-security-roles.html.
 *
 * Zero new dependencies (Node's built-in http only), bound to 127.0.0.1 only.
 * Serves the generated page and exposes the write endpoints the page's
 * Actions column calls. Every write is delegated to roles-actions.mjs, which
 * in turn shells out to set-status.mjs / tracker.mjs — the same locked,
 * validated, atomic write paths the CLI and the experimental web/ UI use.
 * This process never edits applications.md directly.
 *
 * Usage:
 *   node serve-roles.mjs             # http://127.0.0.1:7777
 *   node serve-roles.mjs --port 8080
 */
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildRoleModel } from './roles-model.mjs';
import * as actions from './roles-actions.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.resolve(ROOT, '../ai-security-roles.html');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 7777;

// Single-flight guard: one write at a time, mirroring web/src/app/api/status/route.ts.
let writing = false;

function renderFresh() {
  execFileSync('node', [path.join(ROOT, 'render-roles-html.mjs')], { cwd: ROOT });
  return readFileSync(HTML_PATH, 'utf-8');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function withWriteLock(res, fn) {
  if (writing) return sendJson(res, 409, { error: 'Another action is already in progress — try again in a moment.' });
  writing = true;
  try {
    const result = await fn();
    sendJson(res, 200, result ?? { ok: true });
  } catch (err) {
    const status = err.code === 'LOCK_TIMEOUT' || /lock timeout/i.test(err.message || '') ? 503 : 400;
    sendJson(res, status, { error: err.message || String(err) });
  } finally {
    writing = false;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = renderFresh();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/data') {
      const model = buildRoleModel({ root: ROOT });
      return sendJson(res, 200, model);
    }

    if (req.method === 'POST' && url.pathname === '/api/move') {
      const body = await readBody(req);
      if (!body.id || !body.to) return sendJson(res, 400, { error: 'id and to are required' });
      return withWriteLock(res, () => actions.move(body.id, body.to));
    }

    if (req.method === 'POST' && url.pathname === '/api/delete') {
      const body = await readBody(req);
      if (!body.id || !['temporary', 'permanent'].includes(body.mode)) {
        return sendJson(res, 400, { error: 'id and mode ("temporary"|"permanent") are required' });
      }
      return withWriteLock(res, () => (
        body.mode === 'permanent' ? actions.permanentDelete(body.id) : actions.temporaryDelete(body.id)
      ));
    }

    if (req.method === 'POST' && url.pathname === '/api/blacklist') {
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: 'id is required' });
      return withWriteLock(res, () => actions.blacklistCompany(body.id, body.reason));
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serve-roles: http://127.0.0.1:${PORT}  (Ctrl+C to stop)`);
  console.log(`  reads/writes: ${ROOT}`);
});
