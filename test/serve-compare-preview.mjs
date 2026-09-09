// Development-only preview of the production renderer with deterministic data.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';

const web = fileURLToPath(new URL('../internal/server/web/', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/compare-views.html', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp' };
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path === '/' ? fixture : resolve(web, '.' + path);
    if (file !== fixture && !file.startsWith(web.endsWith(sep) ? web : web + sep)) {
      res.writeHead(403).end(); return;
    }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': (types[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(404).end(); }
}).listen(8767, '127.0.0.1', () => console.log('Comparison preview: http://127.0.0.1:8767'));
