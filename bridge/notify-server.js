// Localhost-only HTTP endpoint that the runtime's feishu tools call to send
// messages/files into Feishu. The bridge holds the Feishu connection (CLI
// auth + chat identity), so tools stay thin.
import { createServer } from 'node:http';

export async function startNotifyServer({ host = '127.0.0.1', port = 48_680, token, handlers } = {}) {
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        if (token && body.token !== token) {
          return send(401, { ok: false, error: 'invalid token' });
        }
        const handler = handlers[req.url];
        if (!handler) return send(404, { ok: false, error: `no handler for ${req.url}` });
        const result = await handler(body);
        return send(200, { ok: true, ...(result ?? {}) });
      } catch (error) {
        return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, port };
}