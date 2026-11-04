// Codec lab: serves ~/movie-night/lab under /<token>/lab/ on 127.0.0.1:8981 and appends POST /report bodies to reports.jsonl.
// Run it only while testing (route it in tunnel.yml above the movie-files rule), then stop it and remove the rule.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const dir = path.join(os.homedir(), 'movie-night', 'lab');
const token = fs.readFileSync(path.join(os.homedir(), 'movie-night', 'route.txt'), 'utf8').trim().split('/')[1];
const types = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4' };
http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const prefix = `/${token}/lab/`;
  if (!p.startsWith(prefix)) return res.writeHead(404).end();
  const rest = p.slice(prefix.length) || 'index.html';
  if (req.method === 'POST' && rest === 'report') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { fs.appendFileSync(path.join(dir, 'reports.jsonl'), body.replace(/\n/g, ' ') + '\n'); res.writeHead(204).end(); });
    return;
  }
  if (!/^[a-z0-9_.-]+$/i.test(rest)) return res.writeHead(404).end();
  const file = path.join(dir, rest);
  const ext = path.extname(file);
  if (!types[ext] || !fs.existsSync(file)) return res.writeHead(404).end();
  const size = fs.statSync(file).size;
  const h = { 'Content-Type': types[ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(200, { ...h, 'Content-Length': size }); return fs.createReadStream(file).pipe(res); }
  const start = m[1] === '' ? Math.max(size - Number(m[2]), 0) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
  res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  fs.createReadStream(file, { start, end }).pipe(res);
}).listen(8981, '127.0.0.1');
