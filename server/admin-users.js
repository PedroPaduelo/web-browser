const crypto = require('crypto');
const db = require('./db');

const SCRYPT_KEYLEN = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/**
 * Cria a tabela de usuários admin. Idempotente — seguro chamar em todo boot.
 *
 * Formato do hash: `scrypt$N$r$p$salt$hash` (tudo em hex). Guardar os parâmetros
 * junto permite migrar o custo no futuro sem quebrar os hashes já gravados.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT,
    disabled INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

/**
 * Verifica a senha contra o hash gravado.
 * @param {string} password senha em texto puro (a que o usuário digitou)
 * @param {string} stored hash no formato `scrypt$N$r$p$salt$hash`
 * @returns {boolean} true se a senha confere
 */
function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6) return false;
    const [algo, n, r, p, saltHex, hashHex] = parts;
    if (algo !== 'scrypt') return false;

    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = crypto.scryptSync(
      password,
      salt,
      expected.length,
      { N: parseInt(n, 10), r: parseInt(r, 10), p: parseInt(p, 10) }
    );
    // timingSafeEqual exige buffers do mesmo tamanho; o length-check antes
    // evita o throw e não vaza timing (o tamanho do hash é público).
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  // Validação de forma, não de entrega: o mínimo para não aceitar lixo.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function createUser(email, password, name = '') {
  const clean = normalizeEmail(email);
  if (!isValidEmail(clean)) throw new Error('invalid email');
  const passwordHash = hashPassword(password);
  const info = db.prepare(`
    INSERT INTO admin_users (email, password_hash, name)
    VALUES (?, ?, ?)
  `).run(clean, passwordHash, name || '');
  return getUserById(info.lastInsertRowid);
}

function getUserByEmail(email) {
  const r = db.prepare(`
    SELECT id, email, password_hash, name, disabled, created_at
    FROM admin_users WHERE email = ?
  `).get(normalizeEmail(email));
  if (!r) return null;
  return { ...r, disabled: !!r.disabled };
}

function getUserById(id) {
  const r = db.prepare(`
    SELECT id, email, name, disabled, created_at
    FROM admin_users WHERE id = ?
  `).get(id);
  if (!r) return null;
  return { ...r, disabled: !!r.disabled };
}

/**
 * Traz o hash da senha — uso INTERNO (troca de senha, verificação).
 * Nunca devolva isto numa resposta HTTP.
 */
function getCredentialsById(id) {
  const r = db.prepare(`
    SELECT id, email, password_hash, disabled
    FROM admin_users WHERE id = ?
  `).get(id);
  if (!r) return null;
  return { ...r, disabled: !!r.disabled };
}

function listUsers() {
  return db.prepare(`
    SELECT id, email, name, disabled, created_at
    FROM admin_users ORDER BY created_at ASC
  `).all().map(r => ({ ...r, disabled: !!r.disabled }));
}

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
}

/**
 * Atualiza a senha de um usuário.
 * @returns {boolean} false se o usuário não existe
 */
function updatePassword(id, newPassword) {
  const passwordHash = hashPassword(newPassword);
  const info = db.prepare(`
    UPDATE admin_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
  `).run(passwordHash, id);
  return info.changes > 0;
}

function setDisabled(id, disabled) {
  const info = db.prepare(`
    UPDATE admin_users SET disabled = ?, updated_at = datetime('now') WHERE id = ?
  `).run(disabled ? 1 : 0, id);
  return info.changes > 0;
}

function deleteUser(id) {
  const info = db.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
  return info.changes > 0;
}

module.exports = {
  createUser,
  getUserByEmail,
  getUserById,
  getCredentialsById,
  listUsers,
  countUsers,
  updatePassword,
  setDisabled,
  deleteUser,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  isValidEmail,
};
