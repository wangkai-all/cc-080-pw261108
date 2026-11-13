import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.woff2': 'font/woff2',
};

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(root, decoded));
  if (!target.startsWith(root + sep) && target !== root) return null;
  return target;
}

const server = createServer(async (req, res) => {
  try {
    let path = safeResolve(req.url === '/' ? '/index.html' : req.url);
    if (!path) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const info = await stat(path).catch(() => null);
    if (!info || info.isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500);
    res.end('Server error: ' + error.message);
  }
});

server.listen(port, host, () => {
  console.log(`楼宇能耗看板已启动：http://${host}:${port}`);
});
