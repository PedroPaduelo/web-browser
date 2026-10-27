# Imagem do backend do Serende Remote Browser.
#
# O backend NAO e um app Node comum: ele spawna um Chrome por sessao de
# usuario, dentro de um Xvfb proprio, e conversa com ele por CDP. Por isso a
# imagem traz a stack toda — Xvfb, Chrome, Python+Xlib (input relay) e ffmpeg
# (audio). Sem eles o servidor sobe, mas session_start falha.
#
# Build no painel (services_create com sourceType github, dockerfilePath=Dockerfile).
FROM node:22-bookworm-slim

# ---- stack de video/input -------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11-utils \
      libx11-6 \
      libxext6 \
      libxi6 \
      libxtst6 \
      libxrandr2 \
      libnss3 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libasound2 \
      libpango-1.0-0 \
      libcairo2 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libgtk-3-0 \
      fonts-liberation \
      ffmpeg \
      python3 \
      python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Xlib: o input relay (server/input-handler.js) spawna python3 e fala XTest.
RUN pip3 install --break-system-packages --no-cache-dir python-xlib

# (a instalacao do Chrome estah mais abaixo, junto do symlink — veja o
# comentario de licao la: a camada antiga ficava CACHED sem instalar nada)

# ---- aplicacao ------------------------------------------------------------
WORKDIR /app

# dependencias primeiro (cache de camada): o node_modules do server tem o ws
# fora do package.json, por isso instalamos no server/ e nao na raiz.
COPY server/package.json ./server/
COPY server/mcp/package.json ./server/mcp/
RUN cd server && npm install --omit=dev \
    && cd mcp && npm install --omit=dev

COPY server ./server
COPY frontend ./frontend
COPY scripts ./scripts

# o npm install acima nao trouxe o ws do server (esta em node_modules, nao no
# package.json) — garantimos que ele exista no runtime.
RUN cd server && npm install ws --omit=dev --no-save

# ---- Chrome estavel (o apt do debian traz o chromium, que funciona, mas o
# codigo espera o binario do google-chrome) --------------------------------
# LICAO: a camada de cima (google-chrome) estava CACHED no build do painel
# porque o Dockerfile anterior ja a tinha "construido" — mas ela NUNCA
# instalou o chrome de verdade (o apt do debian tem o chromium, nao o
# google-chrome). O `which google-chrome` voltava vazio, o `ln -sf ""` criava
# um link quebrado e o build quebrava com "chrome: not found".
# Aqui instalamos o repo do Google EXPLICITAMENTE e conferimos que o binario
# existe antes de criar o symlink.
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates \
    && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/* \
    && test -x "$(command -v google-chrome)" \
    && google-chrome --version

# ---- Chrome onde o codigo procura ----------------------------------------
# O session-manager espera o binario em chrome-install/opt/google/chrome/chrome
# (PROJECT_ROOT/chrome-install/...). Esse diretorio NAO vai para o git — sao
# ~200MB de binario, reinstalados por scripts/install-chrome-sandbox.sh. Na
# imagem a gente instala o Chrome via apt e cria o symlink no caminho que o
# codigo exige, senao o preflight de sessao falha com "Chrome ausente".
#
# ATENCAO: NUNCA use `ln -sf "$(which google-chrome)" ...` — se o which
# voltar vazio (chrome nao instalado), o ln cria um link para o caminho
# VAZIO e o build "passa" ate a primeira sessao. O `test -x` acima garante
# que o binario existe; aqui checamos de novo o destino do symlink.
RUN mkdir -p chrome-install/opt/google/chrome \
    && ln -sf "$(command -v google-chrome)" chrome-install/opt/google/chrome/chrome \
    && test -x chrome-install/opt/google/chrome/chrome \
    && chrome-install/opt/google/chrome/chrome --version

# ---- build do frontend (o dist NAO vai para o git) -----------------------
# O backend serve o SPA estatico de frontend/dist na raiz e em /admin. O
# .gitignore ignora dist/, entao o COPY acima nao o trouxe: precisa buildar.
#
# LICAO (deploy quebrado): `npm run build` = `tsc -b && vite build`. No
# container o tsc falhou (tipos nao instalados no cache da camada) e o &&
# MATOU a cadeia: o vite build nunca rodou, e a imagem nasceu SEM dist, com o
# build "verde". O sintoma la fora era 404 em todas as rotas do SPA.
# Aqui buildamos com o vite DIRETO (sem tsc, que so checa tipo) e conferimos
# que o index.html existe — falha explicita no build, nao 404 em producao.
RUN cd frontend \
    && npm install \
    && npx vite build \
    && test -f dist/index.html \
    && ls -la dist/index.html

# AVISO: @roamhq/wrtc e dependencia NATIVA do server/package.json, e o npm
# install abaixo vai compila-la do zero. Isso exige build-essential, que esta
# no slim por padrao, entao o build pode falhar em "python3 make g++ not found".
# O servidor nao importa webrtc-manager no boot, mas o package.json pede a
# dependencia: se o build quebrar, tire @roamhq/wrtc do server/package.json.

# O default do codigo e /tmp/serende.db, que se perde a cada restart do
# container. O painel monta um volume em /data e o DB_PATH aponta para la.
ENV NODE_ENV=production
ENV PORT=4201
ENV MCP_PORT=4202
# Base pública usada para montar os links que o MCP devolve (viewer da sessão e
# o link assinado da captura de tela). Sem isso o MCP cai no default hardcoded
# (serende.ddw1sl.easypanel.host), que não é este deploy — o agente receberia
# URL de outro ambiente. O valor real é injetado por services_create/env_vars;
# aqui fica só o default do build.
ENV SERENDE_PUBLIC_URL=https://web-browser.mp.serendiped.com
ENV DB_PATH=/data/serende.db
VOLUME ["/data"]
EXPOSE 4201 4202

# healthcheck bate em /api/health, que o servidor responde sem auth.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4201)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/watchdog.js", "--backend", "--mcp"]
