# Serende — remote browser

## Serende vs Cloudflare Browser Run

- **Serende**: sessões stateful de ~30min, profiles persistentes por tenant, viewer próprio MJPEG/WebRTC, HITL via handoff (`POST /api/session/:id/handoff`) e Quick Action stateless (`POST /api/screenshot`). Custo fixo de VM, ideal em volume baixo e constante.
- **Browser Run (Cloudflare)**: escala elástica serverless, stateless Quick Actions, accessibility-tree e zero operação de browser. Ideal em picos e para não operar infra.
- Regra prática: volume constante e baixo → Serende; picos imprevisíveis ou sem VM → Browser Run.

Docs completas em `docs/index.html`.
