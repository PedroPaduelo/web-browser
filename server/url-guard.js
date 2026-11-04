/**
 * url-guard — confine o que entra no Chrome remoto (torneio, idea #SSRF).
 *
 * O browser remoto é um deputado SSRF: startUrl/navigate sem validação deixam
 * um tenant autenticado mirar file://, chrome://, devtools://, data:/javascript:
 * ou a rede privada (169.254.169.254, loopback, RFC1918) tendo screenshot e
 * evaluate como oráculo de exfiltração. Este helper fail-closed barra os
 * vetores determinísticos (scheme allowlist) + DNS com rejeição de IP privado.
 *
 * Limites honestos (documentados, não silenciosos):
 * - DNS tem TOCTOU de rebinding; redirects 302 server-side passam pela
 *   checagem de navigate-time (fix completo exigiria interceptação CDP Fetch).
 * - /api/evaluate permite JS arbitrário por desenho — o guard restringe os
 *   vetores de NAVEGAÇÃO/launch, não o JS da página.
 * - Checagem DNS é fail-closed: DNS fora do ar = navegação negada (custo de
 *   disponibilidade consciente).
 */

const dns = require('dns').promises;
const net = require('net');

// Schemes que o browser remoto pode abrir. Tudo fora disso (file, chrome,
// chrome-extension, devtools, data, javascript, about, blob, content...) é
// negado deterministicamente, sem DNS, sem TOCTOU.
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

function schemeAllowed(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return { ok: false, reason: 'URL inválida' };
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    return { ok: false, reason: `scheme "${u.protocol}" não permitido (só http/https)` };
  }
  return { ok: true, url: u };
}

// net.isLoopback/isPrivate/isLinkLocal só existem no Node 20.17+/22; o
// servidor roda Node 18 — checagens manuais, sem dependência de versão.
function v4Parts(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  const n = p.map((x) => Number(x));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return n;
}

function ipIsBlocked(ip) {
  if (!net.isIP(ip)) return true; // não é IP: trata como suspeito
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;                    // loopback/indefinido
    if (l.startsWith('fe80:') || l.startsWith('fec0:')) return true; // link-local/site-local
    if (l.startsWith('fc') || l.startsWith('fd')) return true;     // unique-local (privado)
    if (l.startsWith('ff')) return true;                          // multicast
    return false;
  }
  const p = v4Parts(ip);
  if (!p) return true;
  const [a, b] = p;
  if (a === 127) return true;                                      // loopback
  if (a === 10) return true;                                       // privado 10/8
  if (a === 172 && b >= 16 && b <= 31) return true;                // privado 172.16/12
  if (a === 192 && b === 168) return true;                         // privado 192.168/16
  if (a === 169 && b === 254) return true;                         // link-local (metadata cloud!)
  if (a === 0) return true;                                        // "este host"
  if (a === 100 && b >= 64 && b <= 127) return true;               // CGNAT compartilhado
  if ((a === 192 && b === 0 && (p[2] === 0 || p[2] === 2))          // docs/reservados
    || (a === 198 && (b === 18 || b === 19 || b === 51 || b === 100))
    || (a === 203 && b === 0 && p[2] === 113)
    || (a === 192 && b === 88 && p[2] === 99)) return true;
  if (a >= 224) return true;                                       // multicast + reservado
  return false;
}

// Validação completa (scheme + DNS). Retorna { ok, reason? }.
// `skipDns` existe SÓ para testes unitários — o caminho de produção sempre
// resolve (fail-closed: erro de DNS = negado).
async function validateUrl(urlString, { skipDns = false } = {}) {
  const s = schemeAllowed(urlString);
  if (!s.ok) return s;
  if (skipDns) return { ok: true };
  let records;
  try {
    records = await dns.lookup(s.url.hostname, { all: true });
  } catch (err) {
    return { ok: false, reason: `DNS falhou para "${s.url.hostname}" (${err.code || err.message}) — negado por segurança` };
  }
  if (!records || records.length === 0) {
    return { ok: false, reason: `sem endereço para "${s.url.hostname}" — negado` };
  }
  for (const r of records) {
    if (ipIsBlocked(r.address)) {
      return { ok: false, reason: `host resolve para IP bloqueado (${r.address})` };
    }
  }
  return { ok: true };
}

// Express middleware factory para corpo { url } (navigate). Falha com 403 +
// código estável `url_blocked` (contrato para o MCP virar isError).
function guardBodyUrl(field = 'url') {
  return async (req, res, next) => {
    const value = (req.body || {})[field];
    if (!value) return next(); // validação de presença é da rota
    try {
      const v = await validateUrl(String(value));
      if (!v.ok) return res.status(403).json({ error: v.reason, code: 'url_blocked', stage: 'url-guard' });
      next();
    } catch (err) {
      return res.status(403).json({ error: `URL rejeitada (${err.message})`, code: 'url_blocked', stage: 'url-guard' });
    }
  };
}

module.exports = { validateUrl, schemeAllowed, ipIsBlocked, guardBodyUrl, ALLOWED_SCHEMES };
