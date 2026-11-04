// Serves every video in ~/movie-night/movies at /<token>/<slug>, with the Range requests iPhone Safari needs.
// route.txt holds "/<token>/" (a long random string); keep it private, it is the only thing guarding the files.
// Drop a file in the folder and its link works at once; nothing else answers, and there is no listing.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.homedir(), 'movie-night');
const movies = path.join(dir, 'movies');
const route = fs.readFileSync(path.join(dir, 'route.txt'), 'utf8').trim();
const token = route.split('/')[1];

export const slug = (name) => name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + path.extname(name).toLowerCase();

function find(pathname) {
  const [, prefix, wanted, extra] = pathname.split('/');
  if (prefix !== token || !wanted || extra !== undefined) return null;
  const name = fs.readdirSync(movies).find((f) => /\.(mp4|m4v|mov|webm)$/i.test(f) && slug(f) === wanted);
  return name ? path.join(movies, name) : null;
}

http.createServer((req, res) => {
  const file = ['GET', 'HEAD'].includes(req.method) ? find(new URL(req.url, 'http://x').pathname) : null;
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const size = fs.statSync(file).size;
  const type = /\.webm$/i.test(file) ? 'video/webm' : 'video/mp4';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
    return;
  }
  const start = m[1] === '' ? Math.max(size - Number(m[2]), 0) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return;
  }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file, { start, end }).pipe(res);
}).listen(8977, '127.0.0.1');
