// Painel local da VM do Sinal — roda só no seu PC (127.0.0.1), puxa os dados
// da VM por SSH. Nada aqui vai pra Vercel (ela só publica `public/`).
//
//   npm run vm              abre o painel no navegador
//   npm run vm -- --no-open só sobe o servidor
//
// Configuração no `.env` da raiz (fora do git) ou em variável de ambiente:
//   SINAL_VM_KEY=<caminho da chave SSH privada>   (obrigatório)
//   SINAL_VM_HOST=<usuario@host da VM>            (obrigatório)
//   SINAL_VM_PORT=4173                            (opcional)
// O caminho da chave fica fora do código de propósito — o repo é público.
import { createServer } from 'node:http';
import { spawn, exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadDotEnv(){
  try{
    const text = readFileSync(join(HERE, '..', '..', '.env'), 'utf8');
    for(const line of text.split(/\r?\n/)){
      const m = line.match(/^\s*(SINAL_VM_[A-Z]+)\s*=\s*(.*?)\s*$/);
      if(m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }catch{ /* sem .env — só vale o que tiver no ambiente */ }
}
loadDotEnv();

const HOST = process.env.SINAL_VM_HOST;
const KEY = process.env.SINAL_VM_KEY;
const PORT = Number(process.env.SINAL_VM_PORT) || 4173;
if(!HOST || !KEY){
  console.error('Faltou configurar SINAL_VM_KEY e SINAL_VM_HOST no .env (ver tools/vm-dashboard/README.md).');
  process.exit(1);
}

function sshArgs(command){
  return ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', HOST, command];
}

function runSsh(command){
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs(command));
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err.trim() || `ssh saiu com código ${code}`)));
  });
}

// ---- ao vivo: UMA conexão SSH compartilhada, só enquanto tiver aba aberta ----
const liveClients = new Set();
let liveChild = null;
let liveStopTimer = null;
let lastLive = null;

function broadcast(event, data){
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  liveClients.forEach((res) => res.write(msg));
}

function startLive(){
  if(liveChild) return;
  const child = spawn('ssh', sshArgs('while :; do cat /run/sinal-stats/live.json; echo; sleep 2; done'));
  liveChild = child;
  let buf = '', err = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while((nl = buf.indexOf('\n')) !== -1){
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if(!line) continue;
      try{
        const sample = JSON.parse(line);
        if(lastLive && sample.t === lastLive.t) continue; // arquivo ainda não mudou
        lastLive = sample;
        broadcast('sample', sample);
      }catch{ /* linha cortada no meio da escrita — a próxima vem em 2s */ }
    }
  });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', () => {
    if(liveChild !== child) return;
    liveChild = null;
    if(liveClients.size){
      broadcast('status', { ok: false, message: err.trim() || 'conexão SSH caiu, tentando de novo...' });
      setTimeout(startLive, 5000);
    }
  });
}

function stopLiveSoon(){
  clearTimeout(liveStopTimer);
  liveStopTimer = setTimeout(() => {
    if(liveClients.size || !liveChild) return;
    const child = liveChild;
    liveChild = null;
    child.kill();
  }, 5000);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try{
    if(url.pathname === '/'){
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await readFile(join(HERE, 'index.html')));
      return;
    }
    if(url.pathname === '/api/history'){
      // Só inteiros vão pro comando remoto — nada do usuário entra cru no shell.
      const span = Math.min(Math.max(parseInt(url.searchParams.get('span'), 10) || 3600, 60), 31 * 86400);
      const points = Math.min(Math.max(parseInt(url.searchParams.get('points'), 10) || 600, 10), 3000);
      const out = await runSsh(`python3 /opt/sinal-stats/query.py ${span} ${points}`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(out);
      return;
    }
    if(url.pathname === '/api/live'){
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      liveClients.add(res);
      clearTimeout(liveStopTimer);
      startLive();
      if(lastLive) res.write(`event: sample\ndata: ${JSON.stringify(lastLive)}\n\n`);
      req.on('close', () => { liveClients.delete(res); if(!liveClients.size) stopLiveSoon(); });
      return;
    }
    res.writeHead(404).end();
  }catch(e){
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = `http://localhost:${PORT}`;
  console.log(`Painel da VM em ${addr} (Ctrl+C pra fechar)`);
  if(!process.argv.includes('--no-open')){
    const opener = process.platform === 'win32' ? `start "" "${addr}"` : process.platform === 'darwin' ? `open ${addr}` : `xdg-open ${addr}`;
    exec(opener);
  }
});
