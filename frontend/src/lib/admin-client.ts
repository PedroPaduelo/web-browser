const ADMIN_SECRET_KEY = 'serende_admin_secret'

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
  return !!getAdminSecret()
}

export async function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const secret = getAdminSecret()
  const headers = new Headers(options.headers || {})
  if (secret) headers.set('X-Admin-Secret', secret)
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(url, { ...options, headers })
}

export interface AdminStats {
  totalKeys: number
  activeKeys: number
  totalActiveSessions: number
  maxSessionsGlobal: number
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
