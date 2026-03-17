import { useState, useEffect, useCallback } from 'react'
import {
  setAdminSecret, getAdminSecret, clearAdminSecret, isAdminAuthenticated,
  getAdminStats, getAdminKeys, createAdminKey, updateAdminKey, revokeAdminKey, regenerateAdminKey,
  getAdminSessions, deleteAdminSession, getAdminSessionToken,
  type AdminStats, type AdminKey, type AdminSession, type CreateKeyResponse,
} from '../lib/admin-client'

const colors = {
  bg: '#111', bgCard: '#1a1a1a', bgInput: '#222', border: '#333',
  text: '#e5e7eb', textMuted: '#9ca3af', textDim: '#6b7280',
  accent: '#3b82f6', accentHover: '#2563eb', danger: '#ef4444',
  success: '#22c55e', warning: '#f59e0b',
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}min`
}

export default function AdminPanel() {
  const [authed, setAuthed] = useState(isAdminAuthenticated())
  const [secretInput, setSecretInput] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  const [stats, setStats] = useState<AdminStats | null>(null)
  const [keys, setKeys] = useState<AdminKey[]>([])
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [sessionTokens, setSessionTokens] = useState<Record<string, string>>({})
  const [openedUrl, setOpenedUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [showCreate, setShowCreate] = useState(false)
  const [createdKey, setCreatedKey] = useState<CreateKeyResponse | null>(null)
  const [copied, setCopied] = useState(false)

  const [editKey, setEditKey] = useState<AdminKey | null>(null)
  const [expandedTenant, setExpandedTenant] = useState<string | null>(null)

  const [createForm, setCreateForm] = useState({ name: '', maxSessions: 100, maxSessionDuration: 3600, maxIdleTimeout: 300 })
  const [editForm, setEditForm] = useState({ name: '', maxSessions: 100, maxSessionDuration: 3600, maxIdleTimeout: 300 })
  const [actionLoading, setActionLoading] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [s, k, sess] = await Promise.all([getAdminStats(), getAdminKeys(), getAdminSessions()])
      setStats(s)
      setKeys(k)
      setSessions(sess)
      // Pré-carrega tokens de todas as sessões em background
      const tokens: Record<string, string> = {}
      await Promise.all(sess.map(async (session) => {
        try {
          tokens[session.sessionId] = await getAdminSessionToken(session.sessionId)
        } catch { /* ignore */ }
      }))
      setSessionTokens(tokens)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authed) loadData()
  }, [authed, loadData])

  const handleLogin = async () => {
    setLoginLoading(true)
    setLoginError('')
    setAdminSecret(secretInput)
    try {
      await getAdminStats()
      setAuthed(true)
    } catch {
      clearAdminSecret()
      setLoginError('Secret invalido')
    } finally {
      setLoginLoading(false)
    }
  }

  const handleLogout = () => {
    clearAdminSecret()
    setAuthed(false)
    setStats(null)
    setKeys([])
    setSessions([])
  }

  const handleCreate = async () => {
    if (!createForm.name.trim()) return
    setActionLoading(true)
    try {
      const result = await createAdminKey(createForm)
      setCreatedKey(result)
      setShowCreate(false)
      setCreateForm({ name: '', maxSessions: 100, maxSessionDuration: 3600, maxIdleTimeout: 300 })
      await loadData()
    } catch {
      // ignore
    } finally {
      setActionLoading(false)
    }
  }

  const handleUpdate = async () => {
    if (!editKey) return
    setActionLoading(true)
    try {
      await updateAdminKey(editKey.id, editForm)
      setEditKey(null)
      await loadData()
    } catch {
      // ignore
    } finally {
      setActionLoading(false)
    }
  }

  const handleToggle = async (key: AdminKey) => {
    setActionLoading(true)
    try {
      await updateAdminKey(key.id, { enabled: !key.enabled })
      await loadData()
    } catch {
      // ignore
    } finally {
      setActionLoading(false)
    }
  }

  const handleRevoke = async (key: AdminKey) => {
    if (!confirm(`Revogar a key "${key.name}" (${key.keyPrefix}...)? Esta acao nao pode ser desfeita.`)) return
    setActionLoading(true)
    try {
      await revokeAdminKey(key.id)
      await loadData()
    } catch {
      // ignore
    } finally {
      setActionLoading(false)
    }
  }

  const handleRegenerate = async (key: AdminKey) => {
    if (!confirm(`Regenerar a key "${key.name}"? A key anterior será invalidada.`)) return
    setActionLoading(true)
    try {
      const result = await regenerateAdminKey(key.id)
      setCreatedKey(result)
      await loadData()
    } catch {
      // ignore
    } finally {
      setActionLoading(false)
    }
  }

  const handleCloseSession = async (sessionId: string) => {
    if (!confirm('Fechar esta sessão? O usuário será desconectado.')) return
    setActionLoading(true)
    try {
      await deleteAdminSession(sessionId)
      await loadData()
    } catch {
      // ignore
    } finally {
      setActionLoading(false)
    }
  }

  const copyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const tenantSessions = (tenantId: string) => sessions.filter(s => s.tenantId === tenantId)

  // --- LOGIN ---
  if (!authed) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100vh', background: colors.bg }}>
        <div style={{ background: colors.bgCard, padding: 32, borderRadius: 12, border: `1px solid ${colors.border}`, width: 360 }}>
          <h1 style={{ color: colors.text, fontSize: 20, marginBottom: 8, fontWeight: 600 }}>Serende Admin</h1>
          <p style={{ color: colors.textMuted, fontSize: 13, marginBottom: 20 }}>Insira o Admin Secret para acessar</p>
          <input
            type="password"
            value={secretInput}
            onChange={e => setSecretInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            placeholder="Admin Secret"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgInput, color: colors.text, fontSize: 14, marginBottom: 12, boxSizing: 'border-box' }}
          />
          {loginError && <p style={{ color: colors.danger, fontSize: 13, marginBottom: 8 }}>{loginError}</p>}
          <button
            onClick={handleLogin}
            disabled={loginLoading || !secretInput}
            style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: colors.accent, color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer', opacity: loginLoading ? 0.6 : 1 }}
          >
            {loginLoading ? 'Verificando...' : 'Entrar'}
          </button>
        </div>
      </div>
    )
  }

  // --- DASHBOARD ---
  return (
    <div style={{ width: '100%', minHeight: '100vh', background: colors.bg, color: colors.text, padding: 24, boxSizing: 'border-box' }}>

      {/* Modal URL da sessão */}
      {openedUrl && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
          onClick={() => setOpenedUrl(null)}>
          <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 24, maxWidth: 560, width: '90%' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 15, marginBottom: 12, color: colors.text }}>Abrir sessão</h3>
            <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>Copie o link abaixo e abra no seu browser:</p>
            <div style={{ background: colors.bgInput, borderRadius: 8, padding: 10, wordBreak: 'break-all', fontSize: 12, color: colors.accent, marginBottom: 16 }}>
              {openedUrl}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { navigator.clipboard.writeText(openedUrl).catch(() => {}); }} style={btnStyle(colors.bgInput, colors.border)}>Copiar Link</button>
              <a href={openedUrl} target="_blank" rel="noopener" style={{ ...btnStyle(colors.accent, 'transparent'), color: '#fff', textDecoration: 'none', padding: '6px 16px', borderRadius: 8, fontSize: 13, display: 'inline-block' }}>Abrir ↗</a>
              <button onClick={() => setOpenedUrl(null)} style={btnStyle(colors.bgInput, colors.border)}>Fechar</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>Serende Admin</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={loadData} disabled={loading} style={btnStyle(colors.bgCard, colors.border)}>
              {loading ? '...' : '↻ Atualizar'}
            </button>
            <button onClick={handleLogout} style={btnStyle(colors.bgCard, colors.border)}>Sair</button>
          </div>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 24 }}>
            <StatCard label="Total Keys" value={stats.totalKeys} />
            <StatCard label="Keys Ativas" value={stats.activeKeys} color={colors.success} />
            <StatCard label="Sessoes Ativas" value={stats.totalActiveSessions} color={colors.accent} />
            <StatCard label="Limite Global" value={stats.maxSessionsGlobal} color={colors.warning} />
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 500 }}>API Keys</h2>
          <button onClick={() => setShowCreate(true)} style={{ ...btnStyle(colors.accent, colors.accent), color: '#fff', fontWeight: 500 }}>+ Criar Key</button>
        </div>

        {/* Keys Table */}
        <div style={{ background: colors.bgCard, borderRadius: 10, border: `1px solid ${colors.border}`, overflow: 'hidden', marginBottom: 24 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Nome', 'Prefix', 'Status', 'Sessoes', 'Max Sessoes', 'Ultimo Uso', 'Criada', 'Acoes'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: colors.textMuted, fontWeight: 500, fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map(k => {
                const activeSessions = tenantSessions(k.id).length
                const expanded = expandedTenant === k.id
                return (
                  <tr key={k.id}>
                    <td style={tdStyle}>{k.name}</td>
                    <td style={tdStyle}><code style={{ fontSize: 12, color: colors.textMuted }}>{k.keyPrefix}...</code></td>
                    <td style={tdStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 500, background: k.enabled ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)', color: k.enabled ? colors.success : colors.danger }}>
                        {k.enabled ? 'Ativo' : 'Revogado'}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span
                        onClick={() => setExpandedTenant(expanded ? null : k.id)}
                        style={{ cursor: 'pointer', textDecoration: 'underline', color: colors.accent }}
                      >
                        {activeSessions}
                      </span>
                    </td>
                    <td style={tdStyle}>{k.maxSessions}</td>
                    <td style={tdStyle}>{formatDate(k.lastUsedAt)}</td>
                    <td style={tdStyle}>{formatDate(k.createdAt)}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => { setEditKey(k); setEditForm({ name: k.name, maxSessions: k.maxSessions, maxSessionDuration: k.maxSessionDuration, maxIdleTimeout: k.maxIdleTimeout }) }} style={smallBtnStyle}>Editar</button>
                        <button onClick={() => handleRegenerate(k)} disabled={actionLoading} style={{ ...smallBtnStyle, color: colors.warning }}>Regenerar Key</button>
                        <button onClick={() => handleToggle(k)} disabled={actionLoading} style={smallBtnStyle}>{k.enabled ? 'Desativar' : 'Ativar'}</button>
                        {k.enabled && <button onClick={() => handleRevoke(k)} disabled={actionLoading} style={{ ...smallBtnStyle, color: colors.danger }}>Revogar</button>}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {keys.length === 0 && (
                <tr><td colSpan={8} style={{ ...tdStyle, textAlign: 'center', color: colors.textDim }}>Nenhuma key cadastrada</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Expanded Sessions */}
        {expandedTenant && (
          <div style={{ background: colors.bgCard, borderRadius: 10, border: `1px solid ${colors.border}`, padding: 16, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 14, color: colors.textMuted }}>
                Sessoes ativas — {keys.find(k => k.id === expandedTenant)?.name || expandedTenant}
              </h3>
              <button onClick={() => setExpandedTenant(null)} style={{ background: 'none', border: 'none', color: colors.textDim, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>
            {tenantSessions(expandedTenant).length === 0 ? (
              <p style={{ color: colors.textDim, fontSize: 13 }}>Nenhuma sessao ativa</p>
            ) : (
              <div style={{ display: 'grid', gap: 8, maxHeight: 400, overflowY: 'auto', paddingRight: 4 }}>
                {tenantSessions(expandedTenant).map(s => {
                  const token = sessionTokens[s.sessionId]
                  const sessionUrl = `${window.location.origin}?session=${s.sessionId}`
                  const openUrl = token
                    ? `${window.location.origin}?session=${s.sessionId}&token=${encodeURIComponent(token)}`
                    : sessionUrl
                  return (
                    <div key={s.sessionId} style={{ background: colors.bgInput, padding: 12, borderRadius: 8, fontSize: 13 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                        <span><code>{s.sessionId.slice(0, 8)}...</code></span>
                        <span style={{ color: colors.textMuted }}>{s.resolution.width}x{s.resolution.height}</span>
                        <span style={{ color: colors.textMuted }}>Uptime: {formatDuration(s.uptime)}</span>
                        {s.timeout && <span style={{ color: s.timeout.warningSoon ? colors.warning : colors.textMuted }}>
                          Idle: {formatDuration(Math.floor(s.timeout.inactive / 1000))}
                        </span>}
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <code style={{ flex: 1, fontSize: 11, color: colors.accent, wordBreak: 'break-all' }}>{sessionUrl}</code>
                        <button
                          onClick={() => navigator.clipboard.writeText(sessionUrl)}
                          style={{ ...smallBtnStyle, padding: '3px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
                        >Copiar</button>
                        <button
                          onClick={() => { navigator.clipboard.writeText(openUrl).catch(() => {}); setOpenedUrl(openUrl) }}
                          style={{ ...smallBtnStyle, padding: '3px 10px', fontSize: 11, color: colors.accent, whiteSpace: 'nowrap' }}
                        >Abrir</button>
                        <button
                          onClick={() => handleCloseSession(s.sessionId)}
                          disabled={actionLoading}
                          style={{ ...smallBtnStyle, padding: '3px 10px', fontSize: 11, color: colors.danger, whiteSpace: 'nowrap' }}
                        >Fechar</button>
                      </div>
                      {(() => {
                        const k = keys.find(k => k.id === expandedTenant)
                        if (!k) return null
                        const pct = Math.min(100, (tenantSessions(expandedTenant).length / k.maxSessions) * 100)
                        return (
                          <div style={{ marginTop: 8, background: '#333', borderRadius: 4, height: 4 }}>
                            <div style={{ width: `${pct}%`, background: pct > 80 ? colors.danger : colors.accent, borderRadius: 4, height: 4 }} />
                          </div>
                        )
                      })()}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Create Modal */}
        {showCreate && (
          <Modal title="Criar API Key" onClose={() => setShowCreate(false)}>
            <FormField label="Nome" value={createForm.name} onChange={v => setCreateForm(f => ({ ...f, name: v }))} />
            <FormField label="Max Sessoes" type="number" value={String(createForm.maxSessions)} onChange={v => setCreateForm(f => ({ ...f, maxSessions: parseInt(v) || 100 }))} />
            <FormField label="Max Duracao (s)" type="number" value={String(createForm.maxSessionDuration)} onChange={v => setCreateForm(f => ({ ...f, maxSessionDuration: parseInt(v) || 3600 }))} />
            <FormField label="Max Idle Timeout (s)" type="number" value={String(createForm.maxIdleTimeout)} onChange={v => setCreateForm(f => ({ ...f, maxIdleTimeout: parseInt(v) || 300 }))} />
            <button onClick={handleCreate} disabled={actionLoading || !createForm.name.trim()} style={{ ...btnStyle(colors.accent, colors.accent), color: '#fff', width: '100%', marginTop: 8, fontWeight: 500 }}>
              {actionLoading ? 'Criando...' : 'Criar Key'}
            </button>
          </Modal>
        )}

        {/* Created Key Dialog */}
        {createdKey && (
          <Modal title="Key Criada!" onClose={() => setCreatedKey(null)}>
            <p style={{ color: colors.warning, fontSize: 13, marginBottom: 12 }}>
              Copie a key abaixo. Ela NAO sera exibida novamente.
            </p>
            <div style={{ background: colors.bgInput, padding: 12, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <code style={{ flex: 1, fontSize: 13, wordBreak: 'break-all', color: colors.text }}>{createdKey.key}</code>
              <button onClick={() => copyKey(createdKey.key)} style={{ ...smallBtnStyle, background: copied ? colors.success : colors.accent, color: '#fff', padding: '4px 12px' }}>
                {copied ? '✓' : 'Copiar'}
              </button>
            </div>
            <p style={{ fontSize: 12, color: colors.textDim }}>Nome: {createdKey.name} | ID: {createdKey.id}</p>
          </Modal>
        )}

        {/* Edit Modal */}
        {editKey && (
          <Modal title={`Editar — ${editKey.name}`} onClose={() => setEditKey(null)}>
            <FormField label="Nome" value={editForm.name} onChange={v => setEditForm(f => ({ ...f, name: v }))} />
            <FormField label="Max Sessoes" type="number" value={String(editForm.maxSessions)} onChange={v => setEditForm(f => ({ ...f, maxSessions: parseInt(v) || 100 }))} />
            <FormField label="Max Duracao (s)" type="number" value={String(editForm.maxSessionDuration)} onChange={v => setEditForm(f => ({ ...f, maxSessionDuration: parseInt(v) || 3600 }))} />
            <FormField label="Max Idle Timeout (s)" type="number" value={String(editForm.maxIdleTimeout)} onChange={v => setEditForm(f => ({ ...f, maxIdleTimeout: parseInt(v) || 300 }))} />
            <button onClick={handleUpdate} disabled={actionLoading} style={{ ...btnStyle(colors.accent, colors.accent), color: '#fff', width: '100%', marginTop: 8, fontWeight: 500 }}>
              {actionLoading ? 'Salvando...' : 'Salvar'}
            </button>
          </Modal>
        )}
      </div>
    </div>
  )
}

// --- Sub-components ---

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: colors.bgCard, padding: 16, borderRadius: 10, border: `1px solid ${colors.border}` }}>
      <p style={{ fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 28, fontWeight: 700, color: color || colors.text }}>{value}</p>
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={onClose}>
      <div style={{ background: colors.bgCard, padding: 24, borderRadius: 12, border: `1px solid ${colors.border}`, width: 400, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function FormField({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgInput, color: colors.text, fontSize: 13, boxSizing: 'border-box' }}
      />
    </div>
  )
}

// --- Styles ---

const tdStyle: React.CSSProperties = { padding: '10px 12px', borderBottom: `1px solid ${colors.border}` }

function btnStyle(bg: string, border: string): React.CSSProperties {
  return { padding: '8px 16px', borderRadius: 8, border: `1px solid ${border}`, background: bg, color: colors.text, fontSize: 13, cursor: 'pointer' }
}

const smallBtnStyle: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 5, border: `1px solid ${colors.border}`,
  background: 'transparent', color: colors.textMuted, fontSize: 11, cursor: 'pointer',
}
