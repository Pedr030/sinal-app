#!/usr/bin/env python3
"""Devolve o histórico do coletor já reduzido pra poucos pontos (roda na VM,
chamado pelo painel local via SSH). Só lê arquivos, não precisa de sudo.

Uso: query.py <segundos_pra_trás> <pontos>
  ex: query.py 86400 720   -> últimas 24h em ~720 pontos
Até 24h lê o histórico fino (10s); acima disso, o de 1 minuto.
Cada ponto: média das médias e o MAIOR dos picos do intervalo — pico nunca
some na redução.
"""
import glob, json, os, sys, time

STATE_DIR = '/var/lib/sinal-stats'
PEAK_FIELDS = ('cpu', 'steal', 'rx', 'tx', 'ppsIn', 'ppsOut', 'memUsed', 'swapUsed')


def main():
    span = int(sys.argv[1]) if len(sys.argv) > 1 else 3600
    points = max(10, int(sys.argv[2]) if len(sys.argv) > 2 else 600)
    since = time.time() - span
    prefix = 'raw' if span <= 86400 else 'min'
    days_needed = span // 86400 + 2
    files = sorted(glob.glob(os.path.join(STATE_DIR, f'{prefix}-*.jsonl')))[-days_needed:]

    bucket = max(1, span / points)
    buckets = {}
    for path in files:
        with open(path) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue  # linha cortada (ex: VM desligou no meio da escrita)
                if r['t'] < since:
                    continue
                buckets.setdefault(int((r['t'] - since) // bucket), []).append(r)

    out = []
    for idx in sorted(buckets):
        recs = buckets[idx]
        last = recs[-1]
        p = {'t': last['t']}
        for k in PEAK_FIELDS:
            p[k] = round(sum(r[k] for r in recs) / len(recs), 2)
            p[k + 'Max'] = max(r[k + 'Max'] for r in recs)
        p['memTotal'] = last['memTotal']
        p['swapTotal'] = last['swapTotal']
        ct = {}
        for name in last.get('ct', {}):
            vals = [r['ct'][name] for r in recs if name in r.get('ct', {})]
            ct[name] = {'cpu': round(sum(v['cpu'] for v in vals) / len(vals), 2),
                        'cpuMax': max(v['cpuMax'] for v in vals), 'mem': last['ct'][name]['mem']}
        p['ct'] = ct
        lks = [r['lk'] for r in recs if r.get('lk')]
        p['lk'] = {k: max(l[k] for l in lks) for k in lks[-1]} if lks else None
        out.append(p)
    json.dump({'span': span, 'source': prefix, 'points': out}, sys.stdout, separators=(',', ':'))


if __name__ == '__main__':
    main()
