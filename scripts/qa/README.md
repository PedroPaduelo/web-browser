# Testes de aceite do MCP (`scripts/qa`)

Scripts que mediram as correções de 25/10/2026 contra o MCP rodando. Eles abrem sessões reais de browser: nesta sandbox (5 GB de RAM) rode um por vez.

## Preparação
- `MCP_URL` (opcional): endpoint do MCP. Padrão: `http://127.0.0.1:4202/mcp`.
- Chave: `KEY=<chave>` no ambiente, ou o caminho de um arquivo em `KEY_FILE` (padrão: `/tmp/ef.key`).
- Para criar uma chave de teste: `scripts/qa/qa-key.sh <nome>` (imprime `KEY=` e `TENANT=`). O teste de cookie precisa de um tenant que já tenha perfil mestre (um tenant usado antes).
- Se aparecer `Server not initialized` (o MCP reiniciou), apague `/tmp/qa-sess-*`.

## Scripts
| Script | O que mede | Resultado em 25/10 |
|---|---|---|
| `qa-call.sh` | Chamada JSON-RPC ao MCP. Guarda o `mcp-session-id` de cada tenant em `/tmp/qa-sess-<tenant>`. | (utilitário) |
| `t-sessionid.sh` | Contrato de sessão: `sessionId` em toda tool, `ambiguous_session` com 2+ sessões, eco da sessão na resposta. | 15/15 |
| `t-parallel.js` | 4 clientes em paralelo, mesma chave e mesma conexão MCP: nenhuma operação cai na sessão de outro. | 192 operações, 0 cruzamentos |
| `t-cookie.sh` | Cookie criado 0 s, 5 s e 30 s antes do stop sobrevive na sessão seguinte. | 3/3 |
| `t-frame.js`, `t-frame-fallback.js` | Tamanho do quadro do viewer, no ffmpeg e no screencast CDP de reserva. | Sessão 1440x900: 1440x900 (ffmpeg) e 1280x800 (reserva), sem corte |
| `t-form.sh` | `fill_form` com select, `submit_form`, `type_text` e `click_and_type` sem campo. | **Com defeito:** a injeção do HTML de teste tem erro de aspas, e os casos de `fill_form`/`submit_form` não medem o produto (task 0f6b659c). |

## t-fidelidade.js — cada tool diz a verdade

Um caso por afirmação do QA de 26/10, contra o MCP em execução. Cria uma sessão e fecha no fim. Sai com código 1 se algo falhar.

| Caso | Antes | Depois |
|---|---|---|
| `type_text` sem campo editável responde isError | FALHA: respondia "Typed" sem efeito | PASS |
| `click_and_type` fora de campo responde isError | FALHA: "typed" sem efeito | PASS |
| `click_and_type` em campo real digita o texto | FALHA: o script da página lia `clearFirst`, que não existia lá (ReferenceError) | PASS |
| `type_text` longo (colagem) e curto (teclas) entram no campo | PASS | PASS |
| `clipboard_write` sem clique: resposta em até 1,5 s e sessão segue viva | não medido | PASS |
| `get_network_activity`: uma entrada por requisição, com status e requestId | FALHA: 4 entradas, sem status nem id | PASS |
| `list_sessions` logo após `session_stop` | PASS | PASS |
| `screenshot` traz bloco de imagem JPEG | PASS | PASS |
| INFO: `drag` sobre elemento `draggable` (HTML5) | `mousedown` + 1 `mousemove`, sem `mouseup` (reproduzido) | limitação conhecida, task aberta |

Rodar um por vez (cada sessão usa ~400-600 MB da sandbox).

    KEY_FILE=/tmp/ef.key MCP_URL=http://127.0.0.1:4202/mcp node scripts/qa/t-fidelidade.js

## t-rede-estados.js — rede, clear/stop e prova do screenshot (26/10)

Mede o que a rede e o screenshot afirmam, com uma sessão. Sai com código 1 se algo falhar.

| Caso | Resultado 26/10 (MCP local e host público) |
|---|---|
| `screenshot` traz no texto dimensões, bytes e sha256 | PASS / PASS |
| `screenshot` traz o bloco `image` JPEG (o host público devolve o bloco) | PASS / PASS |
| POST cujo corpo a página não lê fica `receiving`, com `headersMs` e sem `durationMs` | PASS / PASS |
| POST com corpo lido fecha como `finished`, com `durationMs` e `size` | PASS / PASS |
| GET fecha como `finished` | PASS / PASS |
| `clear` diz que a captura continua, e o buffer fica só com o que veio depois | PASS / PASS |
| `stop` desliga: o `get` seguinte responde "not enabled" | PASS / PASS |
| `type_text` sem campo editável responde isError | PASS / PASS |

    KEY_FILE=/tmp/ef.key MCP_URL=http://127.0.0.1:4202/mcp node scripts/qa/t-rede-estados.js
    KEY_FILE=/tmp/ef.key MCP_URL=https://sb-serende-p4202.mp.serendiped.com/mcp node scripts/qa/t-rede-estados.js
