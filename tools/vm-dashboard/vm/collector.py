#!/usr/bin/env python3
"""Coletor de métricas da VM do Sinal (roda na VM como serviço systemd).

Só LÊ: arquivos do Linux (/proc, cgroups) e a API do LiveKit em localhost.
Não abre porta nenhuma — quem quiser os dados entra por SSH (ver
tools/vm-dashboard/README.md). Só biblioteca padrão do Python.

Grava:
  /run/sinal-stats/live.json            amostra mais recente (a cada 2s, some no reboot)
  /var/lib/sinal-stats/raw-AAAA-MM-DD.jsonl  média+pico a cada 10s (guardado 3 dias)
  /var/lib/sinal-stats/min-AAAA-MM-DD.jsonl  média+pico a cada 1min (guardado 30 dias)

Uso: collector.py            (modo serviço)
     collector.py --once     (uma amostra de teste no terminal, não grava nada)
"""
import base64, glob, hashlib, hmac, json, os, sys, time, urllib.request
from datetime import datetime, timezone

SAMPLE_EVERY = 2          # segundos entre leituras
RAW_EVERY = 10            # segundos por linha do histórico fino
MIN_EVERY = 60            # segundos por linha do histórico longo
RAW_KEEP_DAYS = 3
MIN_KEEP_DAYS = 30
NET_IFACE = 'ens3'
LIVEKIT_YAML = '/opt/livekit/livekit.yaml'
LIVEKIT_URL = 'http://127.0.0.1:7880'
STATE_DIR = os.environ.get('STATE_DIRECTORY', '/var/lib/sinal-stats')
RUN_DIR = os.environ.get('RUNTIME_DIRECTORY', '/run/sinal-stats')
NCPU = os.cpu_count() or 1


# ---------------- leituras do Linux ----------------

def read_cpu():
    """(total, ocupado, steal) em jiffies, somando todas as vCPUs."""
    with open('/proc/stat') as f:
        parts = f.readline().split()[1:]
    v = [int(x) for x in parts[:8]]  # user nice system idle iowait irq softirq steal
    idle = v[3] + v[4]
    steal = v[7]
    total = sum(v)
    return total, total - idle - steal, steal


def read_mem():
    info = {}
    with open('/proc/meminfo') as f:
        for line in f:
            k, rest = line.split(':', 1)
            info[k] = int(rest.split()[0])  # kB
    mb = lambda k: round(info.get(k, 0) / 1024)
    return {
        'memTotal': mb('MemTotal'),
        'memUsed': mb('MemTotal') - mb('MemAvailable'),
        'swapTotal': mb('SwapTotal'),
        'swapUsed': mb('SwapTotal') - mb('SwapFree'),
    }


def read_net():
    """(bytes_in, pkts_in, bytes_out, pkts_out) da interface pública."""
    with open('/proc/net/dev') as f:
        for line in f:
            if line.strip().startswith(NET_IFACE + ':'):
                v = line.split(':', 1)[1].split()
                return int(v[0]), int(v[1]), int(v[8]), int(v[9])
    return 0, 0, 0, 0


def read_load():
    with open('/proc/loadavg') as f:
        return float(f.read().split()[0])


# Containers: cgroup v2 de cada um (docker-<id>.scope). Nome lido do config
# do próprio Docker, sem chamar o `docker` (que é pesado pra rodar a cada 2s).
_container_names = {}
_container_names_at = 0


def container_scopes():
    global _container_names, _container_names_at
    if time.time() - _container_names_at > 60:
        names = {}
        for scope in glob.glob('/sys/fs/cgroup/system.slice/docker-*.scope'):
            cid = scope.rsplit('docker-', 1)[1][:-len('.scope')]
            name = cid[:12]
            try:
                with open(f'/var/lib/docker/containers/{cid}/config.v2.json') as f:
                    name = json.load(f).get('Name', name).lstrip('/')
            except Exception:
                pass
            # livekit-livekit-1 -> livekit (prefixo do compose e sufixo -1 são ruído)
            short = name.split('-')[1] if name.count('-') >= 2 else name
            names[scope] = short
        _container_names, _container_names_at = names, time.time()
    return _container_names


def read_containers():
    """{nome: (cpu_usec_acumulado, mem_MB)}"""
    out = {}
    for scope, name in container_scopes().items():
        try:
            with open(scope + '/cpu.stat') as f:
                usec = int(f.readline().split()[1])  # usage_usec
            with open(scope + '/memory.current') as f:
                mem_bytes = int(f.read())
            # Igual o `docker stats`: desconta o cache de arquivo inativo, que
            # o kernel devolve na hora se precisar (não é memória "presa").
            with open(scope + '/memory.stat') as f:
                for line in f:
                    if line.startswith('inactive_file '):
                        mem_bytes -= int(line.split()[1])
                        break
            mem = round(mem_bytes / 1048576)
            out[name] = (usec, mem)
        except Exception:
            pass
    return out


# ---------------- LiveKit (só números, nunca nomes) ----------------

def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def load_livekit_key():
    """Primeira chave do bloco `keys:` do livekit.yaml."""
    in_keys = False
    with open(LIVEKIT_YAML) as f:
        for line in f:
            if line.startswith('keys:'):
                in_keys = True
                continue
            if in_keys:
                if line.strip() and not line.startswith((' ', '\t')):
                    break
                if ':' in line:
                    k, s = line.strip().split(':', 1)
                    return k.strip(), s.strip().strip('"\'')
    return None, None


def livekit_token(key, secret, room=None):
    now = int(time.time())
    video = {'roomList': True}
    if room is not None:
        video = {'roomAdmin': True, 'room': room}
    payload = {'iss': key, 'nbf': now - 10, 'exp': now + 60, 'video': video}
    head = _b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    body = _b64(json.dumps(payload).encode())
    sig = _b64(hmac.new(secret.encode(), f'{head}.{body}'.encode(), hashlib.sha256).digest())
    return f'{head}.{body}.{sig}'


def twirp(method, body, token):
    req = urllib.request.Request(
        f'{LIVEKIT_URL}/twirp/livekit.RoomService/{method}',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
    )
    with urllib.request.urlopen(req, timeout=3) as r:
        return json.load(r)


def read_livekit(key, secret):
    rooms = twirp('ListRooms', {}, livekit_token(key, secret)).get('rooms', [])
    stats = {'rooms': len(rooms), 'active': 0, 'people': 0, 'screens': 0, 'cams': 0}
    for room in rooms:
        if int(room.get('num_participants', 0) or 0) == 0:
            continue  # sala vazia que o LiveKit ainda não limpou (ver HANDOFF §12)
        stats['active'] += 1
        parts = twirp('ListParticipants', {'room': room['name']},
                      livekit_token(key, secret, room['name'])).get('participants', [])
        stats['people'] += len(parts)
        for p in parts:
            for t in p.get('tracks', []):
                src = t.get('source')
                if src == 'SCREEN_SHARE':
                    stats['screens'] += 1
                elif src == 'CAMERA':
                    stats['cams'] += 1
    return stats


# ---------------- amostragem ----------------

class Sampler:
    def __init__(self):
        self.prev = None
        self.key, self.secret = None, None
        try:
            self.key, self.secret = load_livekit_key()
        except Exception as e:
            print('[sinal-stats] sem chave do LiveKit:', e, file=sys.stderr)
        self.lk = None
        self.lk_at = 0

    def sample(self):
        now = time.time()
        cpu = read_cpu()
        net = read_net()
        cts = read_containers()
        cur = (now, cpu, net, cts)
        if self.prev is None:
            self.prev = cur
            return None
        p_now, p_cpu, p_net, p_cts = self.prev
        self.prev = cur
        dt = now - p_now
        dtot = (cpu[0] - p_cpu[0]) or 1
        s = {
            't': round(now),
            'cpu': round(100 * (cpu[1] - p_cpu[1]) / dtot, 1),
            'steal': round(100 * (cpu[2] - p_cpu[2]) / dtot, 1),
            'load': read_load(),
            'rx': round((net[0] - p_net[0]) * 8 / dt / 1e6, 2),   # Mbps
            'tx': round((net[2] - p_net[2]) * 8 / dt / 1e6, 2),
            'ppsIn': round((net[1] - p_net[1]) / dt),
            'ppsOut': round((net[3] - p_net[3]) / dt),
            'ct': {},
        }
        s.update(read_mem())
        for name, (usec, mem) in cts.items():
            if name in p_cts:
                # % da VM inteira (todas as vCPUs), comparável com `cpu`
                pct = 100 * (usec - p_cts[name][0]) / (dt * 1e6 * NCPU)
                s['ct'][name] = {'cpu': round(pct, 1), 'mem': mem}
        if self.key and now - self.lk_at >= RAW_EVERY:
            self.lk_at = now
            try:
                self.lk = read_livekit(self.key, self.secret)
            except Exception as e:
                self.lk = None
                print('[sinal-stats] LiveKit não respondeu:', e, file=sys.stderr)
        s['lk'] = self.lk
        return s


# Campos que ganham média + pico no histórico; o resto guarda o último valor.
PEAK_FIELDS = ('cpu', 'steal', 'rx', 'tx', 'ppsIn', 'ppsOut', 'memUsed', 'swapUsed')


def aggregate(samples):
    last = samples[-1]
    out = {'t': last['t'], 'n': len(samples)}
    for k in PEAK_FIELDS:
        vals = [s[k] for s in samples]
        out[k] = round(sum(vals) / len(vals), 2)
        out[k + 'Max'] = max(vals)
    out['load'] = last['load']
    out['memTotal'] = last['memTotal']
    out['swapTotal'] = last['swapTotal']
    ct = {}
    for name in last['ct']:
        vals = [s['ct'][name] for s in samples if name in s['ct']]
        ct[name] = {'cpu': round(sum(v['cpu'] for v in vals) / len(vals), 2),
                    'cpuMax': max(v['cpu'] for v in vals), 'mem': last['ct'][name]['mem']}
    out['ct'] = ct
    lks = [s['lk'] for s in samples if s.get('lk')]
    if lks:
        out['lk'] = {k: max(l[k] for l in lks) for k in lks[-1]}  # pico do intervalo
    else:
        out['lk'] = None
    return out


def append_line(prefix, rec):
    day = datetime.fromtimestamp(rec['t'], timezone.utc).strftime('%Y-%m-%d')
    with open(os.path.join(STATE_DIR, f'{prefix}-{day}.jsonl'), 'a') as f:
        f.write(json.dumps(rec, separators=(',', ':')) + '\n')


def write_live(rec):
    tmp = os.path.join(RUN_DIR, 'live.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(rec, f, separators=(',', ':'))
    os.replace(tmp, os.path.join(RUN_DIR, 'live.json'))


def cleanup():
    now = time.time()
    for prefix, keep in (('raw', RAW_KEEP_DAYS), ('min', MIN_KEEP_DAYS)):
        for path in glob.glob(os.path.join(STATE_DIR, f'{prefix}-*.jsonl')):
            if now - os.path.getmtime(path) > (keep + 1) * 86400:
                os.remove(path)


def main():
    os.umask(0o022)  # arquivos legíveis pelo usuário ubuntu (sem sudo) — não tem segredo neles
    sampler = Sampler()
    if '--once' in sys.argv:
        sampler.sample()
        time.sleep(SAMPLE_EVERY)
        sampler.lk_at = 0
        print(json.dumps(sampler.sample(), indent=2))
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    os.makedirs(RUN_DIR, exist_ok=True)
    raw_buf, min_buf = [], []
    last_cleanup = 0
    next_tick = time.monotonic()
    while True:
        try:
            s = sampler.sample()
            if s:
                write_live(s)
                raw_buf.append(s)
                if len(raw_buf) * SAMPLE_EVERY >= RAW_EVERY:
                    rec = aggregate(raw_buf)
                    append_line('raw', rec)
                    raw_buf = []
                min_buf.append(s)
                if len(min_buf) * SAMPLE_EVERY >= MIN_EVERY:
                    append_line('min', aggregate(min_buf))
                    min_buf = []
            if time.time() - last_cleanup > 3600:
                cleanup()
                last_cleanup = time.time()
        except Exception as e:
            print('[sinal-stats] erro na amostra:', e, file=sys.stderr)
        next_tick += SAMPLE_EVERY
        time.sleep(max(0.1, next_tick - time.monotonic()))


if __name__ == '__main__':
    main()
