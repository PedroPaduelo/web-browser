const jwt = require('jsonwebtoken');
const adminUsers = require('./admin-users');

/**
 * JWT do painel admin. Separação deliberada do auth.js:
 * `auth.js` emite tokens com `{ tenantId }` para os usuários finais (sessões de
 * browser), e esse payload é o que o WebSocket de stream confia por igualdade
 * de tenantId. Misturar os dois no mesmo emissor daria a um token de admin um
 * sessionId alheio. Aqui o payload carrega `sub` (id do usuário) e `role`.
 */
const JWT_ISSUER = 'serende-admin';
const JWT_AUDIENCE = 'serende-admin-panel';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not configured — admin login unavailable');
  }
  return secret;
}

function getExpiry() {
  return process.env.ADMIN_JWT_EXPIRY || process.env.JWT_EXPIRY || '24h';
}

/**
 * @param {{id:number, email:string}} user
 * @returns {{token:string, user:object}} token JWT e o usuário (sem hash)
 */
function login(email, password) {
  const user = adminUsers.getUserByEmail(email);
  // Mensagem única para "não existe" e "senha errada": não vaza qual email
  // está cadastrado. O custo do scrypt roda nas duas ramificações.
  const fails = { ok: false, error: 'invalid_credentials' };
  if (!user || user.disabled) return fails;
  if (!adminUsers.verifyPassword(password, user.password_hash)) return fails;

  const token = jwt.sign(
    { role: 'admin', sub: String(user.id), email: user.email },
    getSecret(),
    { expiresIn: getExpiry(), issuer: JWT_ISSUER, audience: JWT_AUDIENCE }
  );

  return { ok: true, token, user: { id: user.id, email: user.email, name: user.name } };
}

/**
 * Verifica um token de admin.
 * @returns {{id:number, email:string, name:string}|null} null se inválido/expirado
 *   ou se o usuário foi desabilitado/excluído depois de emitido.
 */
function verify(token) {
  let payload;
  try {
    payload = jwt.verify(token, getSecret(), { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
  } catch {
    return null;
  }
  if (payload.role !== 'admin' || !payload.sub) return null;

  // Conferência no banco: desabilitar/excluir o usuário precisa valer mesmo
  // com um token ainda dentro do prazo.
  const user = adminUsers.getUserById(Number(payload.sub));
  if (!user || user.disabled) return null;
  return { id: user.id, email: user.email, name: user.name };
}

/**
 * Lê o token de admin do header Authorization ou do header X-Admin-Token.
 */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const alt = req.headers['x-admin-token'];
  return typeof alt === 'string' && alt ? alt : null;
}

/**
 * Middleware: 401 sem token válido. Popula req.admin com o usuário.
 */
function adminJwtAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Admin token required' });
  }
  const admin = verify(token);
  if (!admin) {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
  req.admin = admin;
  next();
}

/**
 * Aceita os DOIS métodos de autenticação admin:
 *   1. JWT de login (Authorization: Bearer <token> ou X-Admin-Token) — o novo;
 *   2. X-Admin-Secret — o legado, mantido para o painel antigo e para scripts.
 *
 * `legacySecretVerifier` é opcional: passado pelo index.js para comparar com o
 * ADMIN_SECRET do ambiente. Sem ele, só o JWT autentica — usado em ambientes
 * onde o secret legado não existe mais.
 */
function adminAnyAuth(legacySecretVerifier) {
  return function (req, res, next) {
    const token = extractToken(req);
    if (token) {
      const admin = verify(token);
      if (admin) {
        req.admin = admin;
        return next();
      }
    }
    const legacy = req.headers['x-admin-secret'];
    if (legacy && typeof legacySecretVerifier === 'function' && legacySecretVerifier(legacy)) {
      req.admin = { id: 0, email: '(legacy secret)', name: 'legacy' };
      return next();
    }
    return res.status(401).json({ error: 'Admin authentication required' });
  };
}

module.exports = { login, verify, extractToken, adminJwtAuth, adminAnyAuth };
