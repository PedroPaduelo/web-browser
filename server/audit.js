/**
 * audit — ledger append-only de mutações admin (torneio, idea #audit).
 *
 * Zero rastro hoje: mint de token, leitura/escrita de cookie, evaluate,
 * navigate-as-other-tenant e disable de key não deixavam registro atribuível.
 * Este helper grava (at, actor, action, target, ip, request_id, detail) na
 * tabela audit_log — base para quarantine e compliance (SOC2/LGPD).
 *
 * Nunca quebra a operação: insert em try/catch, tabela criada no db.js.
 * Append-only por convenção (sem trigger — documentado).
 */

function audit(req, action, target, detail) {
  try {
    const db = require('./db');
    const admin = (req && req.admin) || {};
    const actor = admin.email || admin.name || `tenant:${(req && req.tenant && req.tenant.tenantId) || '?'}`;
    const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || null;
    const requestId = (req && req.requestId) || null;
    db.prepare(`
      INSERT INTO audit_log (actor, action, target, ip, request_id, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(actor).slice(0, 160),
      String(action).slice(0, 80),
      target == null ? null : String(target).slice(0, 320),
      ip ? String(ip).slice(0, 64) : null,
      requestId ? String(requestId).slice(0, 32) : null,
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000),
    );
  } catch {}
}

function listAudit({ limit = 100, actor, action } = {}) {
  try {
    const db = require('./db');
    const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
    const conds = [];
    const vals = [];
    if (actor) { conds.push('actor LIKE ?'); vals.push(`%${actor}%`); }
    if (action) { conds.push('action = ?'); vals.push(action); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    vals.push(lim);
    return db.prepare(`
      SELECT id, at, actor, action, target, ip, request_id, detail
      FROM audit_log ${where} ORDER BY id DESC LIMIT ?
    `).all(...vals);
  } catch { return []; }
}

module.exports = { audit, listAudit };
