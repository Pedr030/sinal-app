# Painel da VM (local)

Painel de consumo da VM do LiveKit (Oracle, `VM.Standard.E2.1.Micro`) que roda **só no seu PC**. Nada daqui vai pra Vercel, que só publica `public/`.

```
npm run vm
```

Esse comando abre `http://localhost:4173` com:
- CPU (uso e *steal*), RAM e swap, rede e pacotes por segundo;
- CPU e RAM de cada container (livekit, caddy, redis);
- contagem de salas, pessoas, telas e câmeras, **só números, nunca nomes**.

O histórico pode ser visto em 1h, 24h, 7 dias ou 30 dias, e a página atualiza ao vivo a cada 2s enquanto estiver aberta.

## Como funciona

```
seu PC                                   VM (sem nenhuma porta nova aberta)
server.mjs ──ssh──> python3 /opt/sinal-stats/query.py   (histórico, já reduzido)
           ──ssh──> cat /run/sinal-stats/live.json       (ao vivo, a cada 2s)
                         ↑
             sinal-stats.service (collector.py) lê /proc, cgroups e a API do LiveKit em localhost
```

O acesso é **só por SSH com a sua chave**. Configure no `.env` da raiz, que fica fora do git. O repositório é público, por isso o caminho da chave não vai no código:

```
SINAL_VM_KEY=<caminho da chave SSH privada>
SINAL_VM_HOST=<usuario>@<host da VM>
SINAL_VM_PORT=4173   # opcional
```

## Na VM (`vm/`, cópia versionada do que está instalado)

- `/opt/sinal-stats/collector.py` roda como serviço `sinal-stats` e grava:
  - `/run/sinal-stats/live.json`: a leitura mais recente, fica só na memória;
  - `/var/lib/sinal-stats/raw-AAAA-MM-DD.jsonl`: média e pico a cada 10s, guardado por 3 dias;
  - `/var/lib/sinal-stats/min-AAAA-MM-DD.jsonl`: média e pico a cada 1min, guardado por 30 dias.
- `/opt/sinal-stats/query.py` junta os pontos pra consulta, e o pico nunca se perde nessa redução.
- Tetos rígidos no systemd: `MemoryMax=40M` e `CPUQuota=5%`, com todo o resto do sistema só-leitura (`ProtectSystem=strict`).
- Custo medido: ~14MB de RAM, ~0,16% de um núcleo e ~33MB de disco com o histórico cheio.

### Atualizar depois de mexer em `vm/`

```
scp -i <chave> tools/vm-dashboard/vm/* <host>:/tmp/
ssh -i <chave> <host> 'sudo install -m 755 /tmp/collector.py /tmp/query.py /opt/sinal-stats/ && sudo install -m 644 /tmp/sinal-stats.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart sinal-stats && rm /tmp/collector.py /tmp/query.py /tmp/sinal-stats.service'
```

### Remover tudo da VM

```
sudo systemctl disable --now sinal-stats && sudo rm -rf /opt/sinal-stats /var/lib/sinal-stats /etc/systemd/system/sinal-stats.service
```
