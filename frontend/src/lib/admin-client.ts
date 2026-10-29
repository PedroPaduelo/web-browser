const API_URL = import.meta.env.VITE_API_URL || ''
const ADMIN_SECRET_KEY = 'serende_admin_secret'
const ADMIN_TOKEN_KEY = 'serende_admin_jwt'

// --- Login por email + senha (JWT) ----------------------------------------

export interface AdminIdentity {
  id: number
  email: string
  name: string | null
}

export async function adminLogin(email: string, password: string): Promise<AdminIdentity> {
  const res = await fetch(`${API_URL}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Falha no login')
  }
  const data = await res.json()
  setAdminToken(data.token)
  return data.admin
}

export function setAdminToken(token: string) {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token)
}

export function getAdminToken(): string | null {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY)
}

export function clearAdminToken() {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY)
}

/** Confirma se o token guardado ainda vale e devolve o dono. */
export async function loadAdminIdentity(): Promise<AdminIdentity | null> {
  const token = getAdminToken()
  if (!token) return null
  try {
    const res = await adminFetch('/api/admin/auth/me')
    if (!res.ok) {
      clearAdminToken()
      return null
    }
    const data = await res.json()
    return data.admin ?? null
  } catch {
    // Rede oscilando não deve derrubar a sessão: devolve identidade mínima.
    return { id: 0, email: '', name: null }
  }
}

export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const res = await adminFetch('/api/admin/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Falha ao trocar a senha')
  }
}

export async function adminLogout(): Promise<void> {
  try {
    await adminFetch('/api/admin/auth/logout', { method: 'POST' })
  } catch {
    // Stateless: o descarte local é o que importa.
  }
  clearAdminToken()
}

// --- Admin secret legado (mantido enquanto a migração não é total) --------

export function setAdminSecret(secret: string) {
  sessionStorage.setItem(ADMIN_SECRET_KEY, secret)
}

export function getAdminSecret(): string | null {
  return sessionStorage.getItem(ADMIN_SECRET_KEY)
}

export function clearAdminSecret() {
  sessionStorage.removeItem(ADMIN_SECRET_KEY)
}

export function isAdminAuthenticated(): boolean {
  return !!getAdminToken() || !!getAdminSecret()
}

export async function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers || {})
  const token = getAdminToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const secret = getAdminSecret()
  if (secret) headers.set('X-Admin-Secret', secret)
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }
  const fullUrl = url.startsWith('http') ? url : `${API_URL}${url}`
  return fetch(fullUrl, { ...options, headers })
}

export interface AdminStats {
  totalKeys: number
  activeKeys: number
  totalActiveSessions: number
  maxSessionsGlobal: number | null
  uptime: number
}

export interface AdminKey {
  id: string
  keyPrefix: string
  name: string
  enabled: boolean
  maxSessions: number
  maxSessionDuration: number
  maxIdleTimeout: number
  features: Record<string, boolean>
  createdAt: string
  lastUsedAt: string | null
}

export interface CreateKeyResponse extends AdminKey {
  key: string
}

export interface AdminSession {
  sessionId: string
  tenantId: string
  tenantName: string
  status: string
  resolution: { width: number; height: number }
  createdAt: string
  uptime: number
  /** URL que a pessoa esta vendo agora (null se nao deu para ler). */
  url?: string | null
  /** Titulo da pagina (null se nao deu para ler). */
  title?: string | null
  timeout: {
    inactive: number
    remaining: number
    timeoutMs: number
    warningSoon: boolean
  } | null
}

export async function getAdminStats(): Promise<AdminStats> {
  const res = await adminFetch('/api/admin/stats')
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
  return res.json()
}

export async function getAdminKeys(): Promise<AdminKey[]> {
  const res = await adminFetch('/api/admin/keys')
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
  const data = await res.json()
  return data.keys
}

export async function createAdminKey(data: {
  name: string
  maxSessions?: number
  maxSessionDuration?: number
  maxIdleTimeout?: number
  features?: Record<string, boolean>
}): Promise<CreateKeyResponse> {
  const res = await adminFetch('/api/admin/keys', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
  return res.json()
}

export async function updateAdminKey(id: string, data: Partial<{
  name: string
  enabled: boolean
  maxSessions: number
  maxSessionDuration: number
  maxIdleTimeout: number
  features: Record<string, boolean>
}>): Promise<AdminKey> {
  const res = await adminFetch(`/api/admin/keys/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
  return res.json()
}

export async function regenerateAdminKey(id: string): Promise<CreateKeyResponse> {
  const res = await adminFetch(`/api/admin/keys/${id}/regenerate`, { method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
  return res.json()
}

export async function revokeAdminKey(id: string): Promise<void> {
  const res = await adminFetch(`/api/admin/keys/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
}

export async function getAdminSessions(): Promise<AdminSession[]> {
  const res = await adminFetch('/api/admin/sessions')
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
  const data = await res.json()
  return data.sessions
}

export async function deleteAdminSession(sessionId: string): Promise<void> {
  const res = await adminFetch(`/api/admin/sessions/${sessionId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
}

export interface BatchCloseResult {
  message: string
  closed: number
  failed: number
  sessionIds: string[]
}

/**
 * Fecha varias sessoes de uma vez. Sem tenantId, fecha todas.
 * O backend responde quantas foram fechadas, para o painel dizer o numero.
 */
export async function closeAdminSessions(tenantId?: string): Promise<BatchCloseResult> {
  const q = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''
  const res = await adminFetch(`/api/admin/sessions${q}`, { method: 'DELETE' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
  return res.json()
}

export async function getAdminSessionToken(sessionId: string): Promise<string> {
  const res = await adminFetch(`/api/admin/sessions/${sessionId}/token`)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
  const data = await res.json()
  return data.token
}

/**
 * Miniatura (JPEG) da tela da sessao, para o painel mostrar varias telas ao
 * mesmo tempo. O token vai no header, entao o navegador nao consegue usar
 * <img src> direto: a imagem vem como blob.
 */
export async function fetchAdminThumbnail(sessionId: string, width = 320): Promise<Blob | null> {
  const res = await adminFetch(`/api/admin/sessions/${sessionId}/thumbnail?w=${width}`)
  if (!res.ok) return null
  return res.blob()
}
