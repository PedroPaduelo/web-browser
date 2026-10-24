#!/bin/bash
# Reinstala Xvfb + Chromium na sandbox (apt é perdido no restart, /workspace sobrevive)
# Uso: bash scripts/install-chrome-sandbox.sh
set -e
apt-get update
apt-get install -y xvfb chromium
mkdir -p /workspace/chrome-install/opt/google/chrome /workspace/chrome-install/usr/lib/x86_64-linux-gnu
ln -sf /usr/lib/chromium/chromium /workspace/chrome-install/opt/google/chrome/chrome
for f in /usr/lib/chromium/*; do ln -sf "$f" /workspace/chrome-install/opt/google/chrome/ 2>/dev/null || true; done
/workspace/chrome-install/opt/google/chrome/chrome --version
echo "OK - crie uma sessao para validar: POST /api/session"
