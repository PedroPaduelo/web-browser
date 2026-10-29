import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  adminLogin, adminLogout, loadAdminIdentity, changeAdminPassword, clearAdminToken,
  getAdminStats, getAdminKeys, createAdminKey, updateAdminKey, revokeAdminKey, regenerateAdminKey,
  getAdminSessions, deleteAdminSession, closeAdminSessions, getAdminSessionToken, fetchAdminThumbnail,
  type AdminStats, type AdminKey, type AdminSession, type CreateKeyResponse, type AdminIdentity,
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

type Tab = 'sessions' | 'live' | 'keys'

/** Pedido de confirmacao: substitui o window.confirm (feio e bloqueante). */
interface ConfirmRequest {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}

export default function AdminPanel() {
  // `authed` só vira true depois que o token guardado é confirmado no
  // servidor (loadAdminIdentity). Começar em true mostraria o dashboard com
  // dados vazios antes do 401 chegar.
  const [authed, setAuthed] = useState(false)
  const [booting, setBooting] = useState(true)
  const [identity, setIdentity] = useState<AdminIdentity | null>(null)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  const [stats, setStats] = useState<AdminStats | null>(null)
  const [keys, setKeys] = useState<AdminKey[]>([])
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [sessionTokens, setSessionTokens] = useState<Record<string, string>>({})
  const [openedUrl, setOpenedUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Aba padrao: Sessoes. E o que se gerencia no dia a dia.
  const [tab, setTab] = useState<Tab>('sessions')
  const [search, setSearch] = useState('')
  const [filterKey, setFilterKey] = useState<string>('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  // Miniatura ao vivo de cada sessao, para a aba "Ao vivo".
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  const [showCreate, setShowCreate] = useState(false)
  const [createdKey, setCreatedKey] = useState<CreateKeyResponse | null>(null)
  const [copied, setCopied] = useState(false)

  const [editKey, setEditKey] = useState<AdminKey | null>(null)

  const [showPassword, setShowPassword] = useState(false)
  const [pwdForm, setPwdForm] = useState({ current: '', next: '', confirm: '' })
  const [pwdError, setPwdError] = useState('')
  const [pwdOk, setPwdOk] = useState('')

  const [createForm, setCreateForm] = useState({ name: '', maxSessions: 100, maxSessionDuration: 3600, maxIdleTimeout: 300 })
  const [editForm, setEditForm] = useState({ name: '', maxSessions: 100, maxSessionDuration: 3600, maxIdleTimeout: 300 })
  const [actionLoading, setActionLoading] = useState(false)
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'erro' } | null>(null)

  const loadData = useCallback(async (opts?: { silencioso?: boolean }) => {
    if (!opts?.silencioso) setLoading(true)
    try {
      const [s, k, sess] = await Promise.all([getAdminStats(), getAdminKeys(), getAdminSessions()])
      setStats(s)
      setKeys(k)
      setSessions(sess)
      // Token de sessao: só quando a pessoa vai ABRIR a sessao. Antes era
      // pré-carregado para todas, o que fazia N chamadas ao carregar o painel.
      setSessionTokens((prev) => {
        const next = { ...prev }
        for (const id of Object.keys(next)) {
          if (!sess.some((x) => x.sessionId === id)) delete next[id]
        }
        return next
      })
    } catch {
      // ignore
    } finally {
      if (!opts?.silencioso) setLoading(false)
    }
  }, [])

  const showToast = useCallback((text: string, kind: 'ok' | 'erro' = 'ok') => {
    setToast({ text, kind })
    setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 4000)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const who = await loadAdminIdentity()
      if (cancelled) return
      if (who) {
        setIdentity(who)
        setAuthed(true)
      }
      setBooting(false)
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (authed) loadData()
  }, [authed, loadData])

  // Auto-refresh: a tela do watcher e ao vivo, e o painel tambem tem que ser.
  // Silencioso: nao pisca o botao "Atualizar" a cada 5 s.
  useEffect(() => {
    if (!authed || !autoRefresh) return
    const t = setInterval(() => loadData({ silencioso: true }), 5000)
    return () => clearInterval(t)
  }, [authed, autoRefresh, loadData])

  // Miniaturas ao vivo, so na aba "Ao vivo". Cada sessao vira um quadrado
  // com a tela dela. As imagens vao como blob (o token do admin vai no
  // header, entao <img src> direto nao serviria).
  useEffect(() => {
    if (!authed || tab !== 'live' || sessions.length === 0) return
    let cancelled = false
    const urls: string[] = []

    const tick = async () => {
      const current = sessions
      for (const s of current) {
        try {
          const blob = await fetchAdminThumbnail(s.sessionId, 320)
          if (cancelled) return
          if (!blob) continue
          const url = URL.createObjectURL(blob)
          urls.push(url)
          setThumbs((prev) => ({ ...prev, [s.sessionId]: url }))
        } catch {
          // Sessao sem CDP vivo: o quadrado fica com o placeholder.
        }
      }
    }
    void tick()
    const t = setInterval(tick, 3000)
    return () => {
      cancelled = true
      clearInterval(t)
      // Libera as URLs do blob: sem isso, cada ciclo vaza uma imagem.
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [authed, tab, sessions])

  const handleLogin = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!email.trim() || !password) return
    setLoginLoading(true)
    setLoginError('')
    try {
      const who = await adminLogin(email.trim(), password)
      setIdentity(who)
      setPassword('')
      setAuthed(true)
    } catch (err: any) {
      setLoginError(err?.message || 'Falha no login')
    } finally {
      setLoginLoading(false)
    }
  }

  const handleLogout = async () => {
    await adminLogout()
    clearAdminToken()
    setAuthed(false)
    setIdentity(null)
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
    } catch (err: any) {
      showToast(err?.message || 'Falha ao criar a key', 'erro')
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
      showToast('Key atualizada')
    } catch (err: any) {
      showToast(err?.message || 'Falha ao atualizar', 'erro')
    } finally {
      setActionLoading(false)
    }
  }

  const handleToggle = async (key: AdminKey) => {
    setActionLoading(true)
    try {
      await updateAdminKey(key.id, { enabled: !key.enabled })
      await loadData()
      showToast(key.enabled ? 'Key desativada' : 'Key ativada')
    } catch (err: any) {
      showToast(err?.message || 'Falha', 'erro')
    } finally {
      setActionLoading(false)
    }
  }

  const handleRevoke = (key: AdminKey) => {
    setConfirmReq({
      title: 'Revogar a key?',
      body: `A key "${key.name}" (${key.keyPrefix}...) sera invalidada na hora. Quem usa essa chave para de funcionar imediatamente. Nao da para desfazer.`,
      confirmLabel: 'Revogar',
      danger: true,
      onConfirm: async () => {
        setActionLoading(true)
        try {
          await revokeAdminKey(key.id)
          await loadData()
          showToast('Key revogada')
        } catch (err: any) {
          showToast(err?.message || 'Falha ao revogar', 'erro')
        } finally {
          setActionLoading(false)
        }
      },
    })
  }

  const handleRegenerate = (key: AdminKey) => {
    setConfirmReq({
      title: 'Regenerar a key?',
      body: `A key "${key.name}" sera trocada por uma nova. Quem usa a antiga perde o acesso na hora.`,
      confirmLabel: 'Regenerar',
      danger: true,
      onConfirm: async () => {
        setActionLoading(true)
        try {
          const result = await regenerateAdminKey(key.id)
          setCreatedKey(result)
          await loadData()
        } catch (err: any) {
          showToast(err?.message || 'Falha ao regenerar', 'erro')
        } finally {
          setActionLoading(false)
        }
      },
    })
  }

  const handleChangePassword = async () => {
    setPwdError('')
    setPwdOk('')
    if (!pwdForm.current || !pwdForm.next) {
      setPwdError('Preencha a senha atual e a nova')
      return
    }
    if (pwdForm.next.length < 8) {
      setPwdError('A nova senha precisa de pelo menos 8 caracteres')
      return
    }
    if (pwdForm.next !== pwdForm.confirm) {
      setPwdError('As senhas não coincidem')
      return
    }
    setActionLoading(true)
    try {
      await changeAdminPassword(pwdForm.current, pwdForm.next)
      setPwdOk('Senha alterada com sucesso')
      setPwdForm({ current: '', next: '', confirm: '' })
      setShowPassword(false)
    } catch (err: any) {
      setPwdError(err?.message || 'Falha ao trocar a senha')
    } finally {
      setActionLoading(false)
    }
  }

  const handleCloseSession = (session: AdminSession) => {
    setConfirmReq({
      title: 'Fechar a sessão?',
      body: `A sessao ${session.sessionId.slice(0, 8)} (${session.tenantName}) sera encerrada. Quem esta usando ela perde a conexao.`,
      confirmLabel: 'Fechar sessão',
      danger: true,
      onConfirm: async () => {
        setActionLoading(true)
        try {
          await deleteAdminSession(session.sessionId)
          await loadData()
          showToast('Sessão fechada')
        } catch (err: any) {
          showToast(err?.message || 'Falha ao fechar a sessão', 'erro')
        } finally {
          setActionLoading(false)
        }
      },
    })
  }

  // Fecha todas as sessoes de uma key (ou todas). O backend responde quantas
  // foram, e o painel mostra o numero.
  const handleCloseBatch = (tenantId?: string, label?: string) => {
    setConfirmReq({
      title: tenantId ? `Fechar todas as sessões de "${label}"?` : 'Fechar todas as sessões?',
      body: tenantId
        ? 'Todas as sessões abertas dessa key serão encerradas. Quem está usando qualquer delas perde a conexão.'
        : `Todas as ${sessions.length} sessões abertas serão encerradas.`,
      confirmLabel: 'Fechar todas',
      danger: true,
      onConfirm: async () => {
        setActionLoading(true)
        try {
          const r = await closeAdminSessions(tenantId)
          await loadData()
          showToast(`${r.closed} sessão(ões) fechada(s)`)
        } catch (err: any) {
          showToast(err?.message || 'Falha ao fechar as sessões', 'erro')
        } finally {
          setActionLoading(false)
        }
      },
    })
  }

  // "Abrir" precisa do token da sessao: ele e buscado na hora e a URL so e
  // montada depois. Sem isso, o link aberto nao autentica.
  const handleOpenSession = async (session: AdminSession) => {
    const base = `${window.location.origin}?session=${session.sessionId}`
    try {
      let token = sessionTokens[session.sessionId]
      if (!token) {
        token = await getAdminSessionToken(session.sessionId)
        setSessionTokens((prev) => ({ ...prev, [session.sessionId]: token! }))
      }
      setOpenedUrl(`${base}&token=${encodeURIComponent(token)}`)
    } catch (err: any) {
      showToast(err?.message || 'Não foi possível obter o acesso à sessão', 'erro')
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

  // Sessoes visiveis: busca (id, key, url, titulo) + filtro por key.
  const visibleSessions = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sessions.filter((s) => {
      if (filterKey && s.tenantId !== filterKey) return false
      if (!q) return true
      return (
        s.sessionId.toLowerCase().includes(q) ||
        s.tenantName.toLowerCase().includes(q) ||
        (s.url || '').toLowerCase().includes(q) ||
        (s.title || '').toLowerCase().includes(q)
      )
    })
  }, [sessions, search, filterKey])

  // --- LOGIN ---
  if (!authed) {
    if (booting) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: colors.bg, color: colors.textMuted, fontSize: 14 }}>
          Carregando...
        </div>
      )
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: colors.bg }}>
        <form onSubmit={handleLogin} style={{ background: colors.bgCard, padding: 32, borderRadius: 12, border: `1px solid ${colors.border}`, width: 360 }}>
          <h1 style={{ color: colors.text, fontSize: 20, marginBottom: 8, fontWeight: 600 }}>Serende Admin</h1>
          <p style={{ color: colors.textMuted, fontSize: 13, marginBottom: 20 }}>Entre com seu email e senha</p>

          <label style={{ display: 'block', fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>Email</label>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="admin@serende.local"
            autoFocus
            disabled={loginLoading}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgInput, color: colors.text, fontSize: 14, marginBottom: 14, boxSizing: 'border-box' }}
          />

          <label style={{ display: 'block', fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>Senha</label>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={loginLoading}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgInput, color: colors.text, fontSize: 14, marginBottom: 12, boxSizing: 'border-box' }}
          />

          {loginError && <p style={{ color: colors.danger, fontSize: 13, marginBottom: 8 }}>{loginError}</p>}

          <button
            type="submit"
            disabled={loginLoading || !email.trim() || !password}
            style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: colors.accent, color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer', opacity: loginLoading ? 0.6 : 1 }}
          >
            {loginLoading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      </div>
    )
  }

  // --- DASHBOARD ---
  return (
    // O painel rola por DENTRO (a pagina nunca rola): com a base de altura
    // trocada para 100%, a rolagem da pagina inteira tiraria o cabecalho.
    <div style={{ width: '100%', height: '100%', background: colors.bg, color: colors.text, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Modal URL da sessão */}
      {openedUrl && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
          onClick={() => setOpenedUrl(null)}>
          <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 24, maxWidth: 560, width: '90%' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 15, marginBottom: 12, color: colors.text }}>Abrir sessão</h3>
            <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
              O link abaixo leva direto para a tela dessa sessao, com acesso liberado.
            </p>
            <div style={{ background: colors.bgInput, borderRadius: 8, padding: 10, wordBreak: 'break-all', fontSize: 12, color: colors.accent, marginBottom: 16 }}>
              {openedUrl}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { navigator.clipboard.writeText(openedUrl).catch(() => {}); showToast('Link copiado'); }} style={btnStyle(colors.bgInput, colors.border)}>Copiar Link</button>
              <a href={openedUrl} target="_blank" rel="noopener" style={{ ...btnStyle(colors.accent, 'transparent'), color: '#fff', textDecoration: 'none', padding: '6px 16px', borderRadius: 8, fontSize: 13, display: 'inline-block' }}>Abrir ↗</a>
              <button onClick={() => setOpenedUrl(null)} style={btnStyle(colors.bgInput, colors.border)}>Fechar</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmacao propria (no lugar do window.confirm) */}
      {confirmReq && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}
          onClick={() => setConfirmReq(null)}>
          <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 24, maxWidth: 460, width: '90%' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 15, marginBottom: 10, color: colors.text }}>{confirmReq.title}</h3>
            <p style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.6, marginBottom: 20 }}>{confirmReq.body}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmReq(null)} style={btnStyle(colors.bgInput, colors.border)}>Cancelar</button>
              <button
                onClick={async () => { const c = confirmReq; setConfirmReq(null); await c.onConfirm() }}
                disabled={actionLoading}
                style={{ ...btnStyle(confirmReq.danger ? colors.danger : colors.accent, 'transparent'), color: '#fff', opacity: actionLoading ? 0.6 : 1 }}
              >
                {actionLoading ? 'Fechando...' : confirmReq.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 10001, background: toast.kind === 'ok' ? 'rgba(34,197,94,0.95)' : 'rgba(239,68,68,0.95)', color: '#fff', padding: '10px 18px', borderRadius: 8, fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}>
          {toast.text}
        </div>
      )}

      {/* Cabecalho fixo */}
      <div style={{ flexShrink: 0, background: colors.bgCard, borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ maxWidth: 1280, margin: '0 auto', padding: '14px 24px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 600 }}>Serende Admin</h1>
              {identity?.email && (
                <p style={{ fontSize: 12, color: colors.textDim, marginTop: 2 }}>{identity.email}</p>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.textMuted, cursor: 'pointer' }}>
                <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
                Atualizar sozinho
              </label>
              <button onClick={() => setShowPassword(true)} style={btnStyle(colors.bgCard, colors.border)}>Trocar senha</button>
              <button onClick={() => loadData()} disabled={loading} style={btnStyle(colors.bgCard, colors.border)}>
                {loading ? '...' : '↻ Atualizar'}
              </button>
              <button onClick={handleLogout} style={btnStyle(colors.bgCard, colors.border)}>Sair</button>
            </div>
          </div>

          {/* Abas */}
          <div style={{ display: 'flex', gap: 4, marginTop: 14 }}>
            <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>
              Sessões ({sessions.length})
            </TabButton>
            <TabButton active={tab === 'live'} onClick={() => setTab('live')}>
              Ao vivo
            </TabButton>
            <TabButton active={tab === 'keys'} onClick={() => setTab('keys')}>
              API Keys ({keys.length})
            </TabButton>
          </div>
        </div>
      </div>

      {/* Conteudo: rola aqui dentro */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto', padding: 20, boxSizing: 'border-box' }}>

          {tab === 'sessions' ? (
            <>
              {/* Cards de resumo */}
              {stats && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
                  <StatCard label="Sessões ativas" value={stats.totalActiveSessions} color={colors.accent} />
                  <StatCard label="Chaves ativas" value={stats.activeKeys} color={colors.success} />
                  <StatCard label="Limite global" value={stats.maxSessionsGlobal ?? 'por chave'} color={colors.warning} />
                  <StatCard label="Uptime" value={`${Math.floor(stats.uptime / 60)}min`} />
                </div>
              )}

              {/* Barra de acoes */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
                <input
                  type="search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar por sessão, key, URL ou título…"
                  style={{ flex: '1 1 260px', minWidth: 200, padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgInput, color: colors.text, fontSize: 13 }}
                />
                <select
                  value={filterKey}
                  onChange={e => setFilterKey(e.target.value)}
                  style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgInput, color: colors.text, fontSize: 13 }}
                >
                  <option value="">Todas as chaves</option>
                  {keys.map(k => (
                    <option key={k.id} value={k.id}>{k.name} ({tenantSessions(k.id).length})</option>
                  ))}
                </select>
                {sessions.length > 0 && (
                  <button onClick={() => handleCloseBatch(undefined)} disabled={actionLoading} style={{ ...btnStyle(colors.bgInput, colors.danger), color: colors.danger }}>
                    Fechar todas
                  </button>
                )}
              </div>

              {/* Tabela de sessoes */}
              <div style={{ background: colors.bgCard, borderRadius: 10, border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                      {['Sessão', 'Chave', 'O que está vendo', 'Resolução', 'Uptime', 'Idle', 'Ações'].map(h => (
                        <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: colors.textMuted, fontWeight: 500, fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSessions.map(s => (
                      <tr key={s.sessionId} style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <td style={tdStyle}>
                          <code style={{ fontSize: 12 }}>{s.sessionId.slice(0, 8)}</code>
                          <div style={{ fontSize: 11, color: colors.textDim }}>{formatDate(s.createdAt)}</div>
                        </td>
                        <td style={tdStyle}>
                          <div style={{ color: colors.text }}>{s.tenantName}</div>
                          <div style={{ fontSize: 11, color: colors.textDim }}>{s.tenantId.slice(0, 8)}</div>
                        </td>
                        <td style={{ ...tdStyle, maxWidth: 320 }}>
                          {s.url ? (
                            <>
                              <div style={{ color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.url}>{s.url}</div>
                              {s.title && <div style={{ fontSize: 11, color: colors.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.title}>{s.title}</div>}
                            </>
                          ) : (
                            <span style={{ color: colors.textDim, fontSize: 12 }}>—</span>
                          )}
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{s.resolution.width}x{s.resolution.height}</td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{formatDuration(s.uptime)}</td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: s.timeout?.warningSoon ? colors.warning : colors.textMuted }}>
                          {s.timeout ? formatDuration(Math.floor(s.timeout.inactive / 1000)) : '—'}
                        </td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            <button onClick={() => handleOpenSession(s)} disabled={actionLoading} style={{ ...smallBtnStyle, color: colors.accent }}>Abrir</button>
                            <button
                              onClick={() => { navigator.clipboard.writeText(`${window.location.origin}?session=${s.sessionId}`).catch(() => {}); showToast('Link copiado') }}
                              style={smallBtnStyle}
                            >
                              Copiar
                            </button>
                            <button onClick={() => handleCloseSession(s)} disabled={actionLoading} style={{ ...smallBtnStyle, color: colors.danger }}>Fechar</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {visibleSessions.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ ...tdStyle, textAlign: 'center', color: colors.textDim, padding: 28 }}>
                          {sessions.length === 0
                            ? 'Nenhuma sessão ativa agora'
                            : 'Nenhuma sessão corresponde ao filtro'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {visibleSessions.length > 0 && (
                <p style={{ fontSize: 12, color: colors.textDim, marginTop: 10 }}>
                  {visibleSessions.length} de {sessions.length} sessão(ões)
                  {filterKey && ` da key ${keys.find(k => k.id === filterKey)?.name || ''}`}
                </p>
              )}
            </>
          ) : tab === 'live' ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <h2 style={{ fontSize: 15, fontWeight: 500, color: colors.textMuted }}>Sessões ativas</h2>
                <span style={{ fontSize: 12, color: colors.textDim }}>
                  {sessions.length === 0 ? 'nenhuma sessão aberta' : `${sessions.length} sessão(ões) · atualiza a cada 3s`}
                </span>
              </div>
              <p style={{ fontSize: 12, color: colors.textDim, marginBottom: 16 }}>
                Só para olhar. Para agir numa sessão, use a aba Sessões.
              </p>

              {sessions.length === 0 ? (
                <div style={{ background: colors.bgCard, borderRadius: 10, border: `1px solid ${colors.border}`, padding: 40, textAlign: 'center', color: colors.textDim, fontSize: 13 }}>
                  Nenhuma sessão ativa agora
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
                  {sessions.map(s => (
                    <LiveTile key={s.sessionId} session={s} thumb={thumbs[s.sessionId]} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <h2 style={{ fontSize: 15, fontWeight: 500, color: colors.textMuted }}>API Keys</h2>
                <button onClick={() => setShowCreate(true)} style={{ ...btnStyle(colors.accent, colors.accent), color: '#fff', fontWeight: 500 }}>+ Criar Key</button>
              </div>

              <div style={{ background: colors.bgCard, borderRadius: 10, border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                      {['Nome', 'Prefixo', 'Status', 'Sessões', 'Max Sessões', 'Último Uso', 'Criada', 'Ações'].map(h => (
                        <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: colors.textMuted, fontWeight: 500, fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map(k => {
                      const activeSessions = tenantSessions(k.id).length
                      const limit = k.maxSessions || 1
                      const pct = Math.min(100, (activeSessions / limit) * 100)
                      return (
                        <tr key={k.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                          <td style={tdStyle}>{k.name}</td>
                          <td style={tdStyle}><code style={{ fontSize: 12, color: colors.textMuted }}>{k.keyPrefix}...</code></td>
                          <td style={tdStyle}>
                            <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 500, background: k.enabled ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)', color: k.enabled ? colors.success : colors.danger }}>
                              {k.enabled ? 'Ativo' : 'Revogado'}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span
                                onClick={() => { setFilterKey(k.id); setTab('sessions') }}
                                style={{ cursor: 'pointer', color: colors.accent, textDecoration: 'underline' }}
                                title="Ver as sessões desta key"
                              >
                                {activeSessions}
                              </span>
                              {activeSessions > 0 && (
                                <span style={{ flex: 1, minWidth: 40, maxWidth: 90, background: '#333', borderRadius: 4, height: 4, overflow: 'hidden' }}>
                                  <span style={{ display: 'block', width: `${pct}%`, background: pct > 80 ? colors.danger : colors.accent, height: 4 }} />
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={tdStyle}>{k.maxSessions}</td>
                          <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{formatDate(k.lastUsedAt)}</td>
                          <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{formatDate(k.createdAt)}</td>
                          <td style={tdStyle}>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              <button onClick={() => { setEditKey(k); setEditForm({ name: k.name, maxSessions: k.maxSessions, maxSessionDuration: k.maxSessionDuration, maxIdleTimeout: k.maxIdleTimeout }) }} style={smallBtnStyle}>Editar</button>
                              <button onClick={() => handleRegenerate(k)} disabled={actionLoading} style={{ ...smallBtnStyle, color: colors.warning }}>Regenerar</button>
                              <button onClick={() => handleToggle(k)} disabled={actionLoading} style={smallBtnStyle}>{k.enabled ? 'Desativar' : 'Ativar'}</button>
                              {k.enabled && <button onClick={() => handleRevoke(k)} disabled={actionLoading} style={{ ...smallBtnStyle, color: colors.danger }}>Revogar</button>}
                              {activeSessions > 0 && (
                                <button onClick={() => handleCloseBatch(k.id, k.name)} disabled={actionLoading} style={{ ...smallBtnStyle, color: colors.danger }}>Fechar sessões</button>
                              )}
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
            </>
          )}
        </div>
      </div>

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

      {/* Password Modal */}
      {showPassword && (
        <Modal title="Trocar senha" onClose={() => { setShowPassword(false); setPwdError('') }}>
          <FormField label="Senha atual" type="password" value={pwdForm.current} onChange={v => setPwdForm(f => ({ ...f, current: v }))} />
          <FormField label="Nova senha" type="password" value={pwdForm.next} onChange={v => setPwdForm(f => ({ ...f, next: v }))} />
          <FormField label="Confirmar nova senha" type="password" value={pwdForm.confirm} onChange={v => setPwdForm(f => ({ ...f, confirm: v }))} />
          {pwdError && <p style={{ color: colors.danger, fontSize: 13, marginBottom: 8 }}>{pwdError}</p>}
          <button
            onClick={handleChangePassword}
            disabled={actionLoading || !pwdForm.current || !pwdForm.next}
            style={{ ...btnStyle(colors.accent, colors.accent), color: '#fff', width: '100%', marginTop: 8, fontWeight: 500 }}
          >
            {actionLoading ? 'Salvando...' : 'Salvar'}
          </button>
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
  )
}

// --- Sub-components ---

/**
 * Um quadrado por sessao, na aba "Ao vivo": a tela da sessao, a key, a URL
 * e o tempo de vida. SEM acoes — e a tela de olhar, nao de mexer. Quem quer
 * agir usa a aba Sessões.
 */
function LiveTile({ session, thumb }: { session: AdminSession; thumb?: string }) {
  return (
    <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ aspectRatio: '16 / 10', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {thumb ? (
          <img
            src={thumb}
            alt={`Tela da sessão ${session.sessionId.slice(0, 8)}`}
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <span style={{ color: colors.textDim, fontSize: 12 }}>sem imagem</span>
        )}
      </div>
      <div style={{ padding: '8px 10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 12, color: colors.text, fontWeight: 500 }}>{session.tenantName}</span>
          <span style={{ fontSize: 11, color: colors.textDim }}>{formatDuration(session.uptime)}</span>
        </div>
        <div style={{ fontSize: 11, color: colors.textDim, marginTop: 2 }}>
          {session.resolution.width}x{session.resolution.height} · {session.sessionId.slice(0, 8)}
        </div>
        {session.url && (
          <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={session.url}>
            {session.url}
          </div>
        )}
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '9px 16px',
        borderRadius: '8px 8px 0 0',
        border: 'none',
        borderBottom: `2px solid ${active ? colors.accent : 'transparent'}`,
        background: active ? colors.bg : 'transparent',
        color: active ? colors.text : colors.textMuted,
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function StatCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
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
