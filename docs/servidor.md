# Servidor de mídia (LiveKit na VM)

Histórico: [historico.md](historico.md) §12 (migração para self-host), §31 (swap e painel), §32 (teste de carga), §70 e §76.

## O que é

- **LiveKit self-hosted** numa VM **Oracle Cloud Always Free** (`VM.Standard.E2.1.Micro`: 1/8 de núcleo, ~1 GB de RAM + 1 GB de swap). Tem que continuar Always Free: **nunca** adicionar recurso pago.
- Containers: `livekit`, `redis`, `caddy` (TLS). O TURN é o do próprio LiveKit. O domínio é o da `LIVEKIT_URL` (também no `connect-src` do `vercel.json`).
- Salas criadas pelo `api/get-token.js` com `emptyTimeout`/`departureTimeout` de 60 s.

## Acesso

- SSH com a chave e o host do `.env` local (`SINAL_VM_KEY`, `SINAL_VM_HOST`) — **nunca no código** (repo público).
- **Ler é livre; mudar qualquer coisa na VM só depois de explicar ao dono e ele aprovar.**

## Painel de consumo

- Na VM, o serviço `sinal-stats` (Python, só leitura de `/proc`, cgroups e API do LiveKit; sem porta aberta; teto de 40 MB e 5% de CPU) grava média e pico a cada 10 s (3 dias, `raw-*.jsonl`) e a cada minuto (30 dias, `min-*.jsonl`) em `/var/lib/sinal-stats/`. Contagens do LiveKit são só números (salas, pessoas, telas, câmeras), nunca nomes.
- No PC: `npm run vm` abre o painel em `127.0.0.1:4173` (histórico por `query.py <segundos> <pontos>` via SSH; ao vivo por `live.json`). Detalhes em `tools/vm-dashboard/README.md`.
- **O número que mostra o limite é o `steal`** (tempo que a Oracle segura a CPU da VM). Uso + steal subindo juntos = limite da máquina.

## Capacidade medida (histórico de 30 dias, 2026-09-29 a 2026-10-17)

Média de steal por faixa de tráfego saindo da VM (minutos com alguém transmitindo):

| Saída (Mbps) | Steal médio | Situação |
|---|---|---|
| 0–25 | 1–6% | folgado |
| 25–30 | 10% | começa a pesar |
| 30–35 | 18% | apertando |
| 35–45 | 25–29% | pesado |
| 45–70 | 34–46% (picos de 70%) | no limite |

**Quanto cada pessoa assistindo custa** (é o teto da qualidade, multiplicado por quem assiste aquela transmissão): Jogos ~7,5 Mbps · Fluido ~6 · Nítido ~5,5 · Leve ~2.

Na prática, com o Jogos a 8 Mbps:
- **até ~3 pessoas assistindo transmissões em Jogos** ao mesmo tempo (somando todas) fica folgado (~25 Mbps);
- **4–5** começa a apertar (30–40 Mbps);
- **6 ou mais** fica pesado (45+ Mbps), como na noite de 10/10 (12 pessoas, 6 telas, 50–70 Mbps, steal 40%+).

Sessões reais: Jogos com Marcelo e Jean (13/10) teve média de 15 Mbps e pior minuto de 31 Mbps (steal 31% nesse minuto); 16/10, pior minuto de 16 Mbps.

**Alavanca se ficar pesado**: baixar o teto do Jogos para 6 Mbps (`SHARE_QUALITY_PRESETS.jogos.h264`) dá ~25% de folga; o adaptador do WebRTC já reduz sozinho quando o upload de quem transmite não aguenta, mas não sabe da CPU da VM.
