// Servidor de teste que, como a Vercel, manda revalidar sempre (sem cache).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const dir = process.argv[2], port = Number(process.argv[3]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(dir, path === '/' ? 'index.html' : path);
  try{
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }catch{ res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); }
}).listen(port, '127.0.0.1');
