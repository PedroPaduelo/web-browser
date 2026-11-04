const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET não definida. Defina no .env');
  process.exit(1);
}
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';

function generateToken(tenantId, options = {}) {
  const payload = { tenantId };
  if (options.maxSessions) payload.maxSessions = options.maxSessions;
  // Key-version binding (torneio): `kv` amarra o JWT à versão da API key.
  // revoke/regenerate/toggle de enabled dá bump na versão → JWTs antigos
  // morrem no próximo request em vez de viverem até 24h. Tokens sem `kv`
  // (pré-migração) continuam válidos — política fail-open documentada.
  if (options.keyVersion != null) payload.kv = options.keyVersion;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function deriveTenantId(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

const deriveUserId = deriveTenantId;

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token required' });
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Token de admin (iss/aud do painel) não é token de sessão: sem tenantId
  // ele viraria um "tenant undefined", que casa com nenhuma sessão real mas
  // transformaria 401 em 200 vazio. Recusa explícita é mais honesto.
  if (payload.iss === 'serende-admin' || payload.aud === 'serende-admin-panel') {
    return res.status(403).json({ error: 'Admin token cannot be used as a session token' });
  }

  const tenantId = payload.tenantId || payload.userId;
  if (!tenantId) {
    return res.status(401).json({ error: 'Token has no tenant' });
  }
  // Revogação real: se o token carrega `kv`, ele precisa casar com a versão
  // atual da key. Mismatch = key foi revogada/regenerada/toggleada depois da
  // emissão → 401 imediato (não espera o expiry de 24h). Sem `kv`
  // (pré-migração): aceita (fail-open documentado — expira sozinho em 24h).
  if (payload.kv != null) {
    try {
      const keyStore = require('./key-store');
      const current = keyStore.getKeyVersion(tenantId);
      if (Number(payload.kv) !== Number(current)) {
        return res.status(401).json({ error: 'Token revoked (key version mismatch)', code: 'token_revoked' });
      }
    } catch {
      // DB indisponível: não derruba auth por causa de telemetria de versão.
    }
  }
  req.tenant = { tenantId, maxSessions: payload.maxSessions };
  req.user = { userId: tenantId };
  next();
}

module.exports = { generateToken, verifyToken, deriveTenantId, deriveUserId, authMiddleware };
