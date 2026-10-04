# Política de segurança

O Sinal é um projeto feito para um grupo de amigos, mas leva segurança a sério.

## Como avisar sobre uma falha

**Não abra uma issue pública** para uma vulnerabilidade. Use a denúncia privada do GitHub:
aba **Security → Report a vulnerability** deste repositório. Só o dono do projeto enxerga o relato.

Ajuda muito se vier com:

- o que acontece e o impacto (o que alguém conseguiria fazer);
- os passos para reproduzir;
- a versão do site (rodapé da página) ou do app (rodapé do app).

Respondo assim que possível. Não há recompensa financeira.

## O que está no escopo

- O site e as rotas `/api` do projeto;
- o app desktop (pasta `electron/`);
- a configuração de segurança do repositório.

Fora do escopo: ataques de negação de serviço por volume, engenharia social e falhas em
serviços de terceiros (Discord, LiveKit Cloud, GitHub, Vercel, Oracle Cloud).

## Versões com suporte

Apenas a versão mais recente do site e do app desktop recebe correções de segurança.
