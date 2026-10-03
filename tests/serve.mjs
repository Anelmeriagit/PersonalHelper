// Статический сервер для проверки интерфейса без деплоя.
// Отдаёт корень репозитория с заголовками из vercel.json (CSP берётся из первого правила, где она есть)
// и подставляет мок-API из fixtures.mjs вместо /api/*.
// Запуск вручную: node tests/serve.mjs [корень] [порт]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

// Заголовки безопасности из vercel.json: все заголовки первого правила, где есть Content-Security-Policy.
export function readHeaders(root) {
  const file = path.join(root, 'vercel.json');
  if (!fs.existsSync(file)) return { headers: {}, csp: null };
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const rule of cfg.headers || []) {
    const list = rule.headers || [];
    if (list.some((h) => /^content-security-policy$/i.test(h.key))) {
      const headers = {};
      for (const h of list) headers[h.key] = h.value;
      const key = Object.keys(headers).find((k) => /^content-security-policy$/i.test(k));
      return { headers, csp: headers[key] };
    }
  }
  return { headers: {}, csp: null };
}

export function start({ root = DEFAULT_ROOT, port = 0 } = {}) {
  const { headers: extra, csp } = readHeaders(root);
  const unmocked = [];
  const apiCalls = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);

    if (url.pathname.startsWith('/api/')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const key = `${req.method} ${url.pathname}`;
        apiCalls.push(key);
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* не JSON */ }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        const handler = routes[key];
        if (!handler) {
          unmocked.push(key);
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: 'mock: нет заглушки для ' + key }));
        }
        res.end(JSON.stringify(handler(body)));
      });
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep) && file !== root) { res.statusCode = 403; return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      res.end(data);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, csp, unmocked, apiCalls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || DEFAULT_ROOT);
  const s = await start({ root, port: Number(process.argv[3]) || 3000 });
  console.log('Стенд: ' + s.url + '  (корень: ' + root + ')');
  console.log('CSP: ' + (s.csp || 'НЕ НАЙДЕНА в vercel.json, проверка CSP невозможна'));
}
