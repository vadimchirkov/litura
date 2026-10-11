import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Per-key atomic files keep desktop state independent of the HTTP port.
export function desktopStorage(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    read() {
      const entries = [];
      for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const item = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        if (typeof item.key !== 'string' || typeof item.value !== 'string') throw new Error('Invalid desktop backup');
        entries.push([item.key, item.value]);
      }
      return entries;
    },
    write(key, value) {
      if (typeof key !== 'string' || key.length > 1024 || !/^(wa-|litura:)/.test(key)
          || (value !== null && typeof value !== 'string')) {
        throw Object.assign(new Error('Invalid storage entry'), { status: 400 });
      }
      const file = path.join(directory, createHash('sha256').update(key).digest('hex') + '.json');
      if (value === null) { fs.rmSync(file, { force: true }); return; }
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ key, value })); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temp, file);
      } finally { fs.rmSync(temp, { force: true }); }
    },
  };
}

export function desktopBridge(directory, readBody, sendJson) {
  const storage = desktopStorage(directory), clients = new Set();
  let pending = null;
  const broadcast = value => { for (const client of clients) client.write(`data: ${JSON.stringify(value)}\n\n`); };
  function finish(ok, error = '') {
    if (!pending) return;
    const { res, timer } = pending;
    pending = null;
    clearTimeout(timer);
    if (!ok) broadcast({ type: 'resume' });
    if (!res.destroyed) sendJson(res, ok ? 200 : 409, { saved: ok, error });
  }
  return async (req, res, url) => {
    if (url.pathname === '/api/desktop/storage') {
      if (req.method === 'GET') return sendJson(res, 200, { entries: storage.read() });
      if (req.method === 'PUT') {
        const { key, value } = await readBody(req);
        storage.write(key, value);
        return sendJson(res, 200, { saved: true });
      }
    }
    if (url.pathname === '/api/desktop/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': connected\n\n');
      clients.add(res);
      res.on('close', () => {
        clients.delete(res);
        finish(false, 'The editor disconnected before saving.');
      });
      return;
    }
    if (url.pathname === '/api/desktop/flush' && req.method === 'POST') {
      if (pending || clients.size !== 1) return sendJson(res, 409, { error: 'One connected editor is required before closing.' });
      const id = randomUUID();
      pending = { id, res, timer: setTimeout(() => finish(false, 'The editor did not confirm its save.'), 20_000) };
      res.on('close', () => { if (pending?.id === id) finish(false, 'Save request cancelled.'); });
      broadcast({ type: 'flush', id });
      return;
    }
    if (url.pathname === '/api/desktop/flushed' && req.method === 'POST') {
      const body = await readBody(req);
      if (!pending || pending.id !== body.id) return sendJson(res, 409, { error: 'Save request expired.' });
      finish(body.ok === true, typeof body.error === 'string' ? body.error : 'The editor could not save.');
      return sendJson(res, 200, { received: true });
    }
    if (url.pathname === '/api/desktop/resume' && req.method === 'POST') {
      broadcast({ type: 'resume' });
      return sendJson(res, 200, { resumed: true });
    }
    sendJson(res, 404, { error: 'Not found' });
  };
}
