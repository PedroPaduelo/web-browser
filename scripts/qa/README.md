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
