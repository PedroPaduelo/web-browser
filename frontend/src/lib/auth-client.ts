import { apiFetch, type ApiRequestOptions } from './api-client'

const API_URL = import.meta.env.VITE_API_URL || ''
const WS_URL = import.meta.env.VITE_WS_URL || ''

const TOKEN_KEY = 'serende_token'
const TENANT_KEY = 'serende_tenantId'
const API_KEY_KEY = 'serende_apikey'

export async function login(apiKey: string): Promise<{ token: string; tenantId: string }> {
  // `apiFetch` repete com backoff quando o backend está reiniciando e
  // distingue "backend fora" (500 vazio do proxy) de "erro real" (JSON).
  // Sem isso, o login quebrava com "Login failed (HTTP 500)" sempre que o
  // backend estava fora.
  const res = await apiFetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error || `Login failed (HTTP ${res.status})`)
  }

  const data = await res.json()
  localStorage.setItem(TOKEN_KEY, data.token)
  localStorage.setItem(TENANT_KEY, data.tenantId || data.userId)
  localStorage.setItem(API_KEY_KEY, apiKey)
  return { token: data.token, tenantId: data.tenantId || data.userId }
}

export function getSavedApiKey(): string | null {
  return localStorage.getItem(API_KEY_KEY)
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(TENANT_KEY)
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function getTenantId(): string | null {
  return localStorage.getItem(TENANT_KEY)
}

export function getUserId(): string | null {
  return getTenantId()
}

export function isAuthenticated(): boolean {
  const token = getToken()
  if (!token) return false

  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return payload.exp * 1000 > Date.now()
  } catch {
    return false
  }
}

export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken()
  const headers = new Headers(options.headers || {})
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }
  const fullUrl = url.startsWith('http') ? url : `${API_URL}${url}`
  return fetch(fullUrl, { ...options, headers })
}

/**
 * Fetch autenticado com retry e detecção de backend indisponível.
 *
 * Use ESTE no lugar de `authFetch` nas telas. `authFetch` continua existindo
 * para quem precisa do Response cru (o `apiFetch` consome o corpo no erro,
 * então quem precisa reler o corpo deve usar o wrapper e tratar o payload).
 */
export async function apiAuthFetch(
  url: string,
  options: ApiRequestOptions = {}
): Promise<Response> {
  const token = getToken()
  const headers = new Headers(options.headers || {})
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }
  const fullUrl = url.startsWith('http') ? url : `${API_URL}${url}`
  return apiFetch(fullUrl, { ...options, headers })
}

export function getAuthWsUrl(path: string, sessionId: string): string {
  const token = getToken()
  const base = WS_URL || (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host
  return `${base}${path}?token=${token}&sessionId=${sessionId}`
}

// --- Profile Management ---

export async function getProfileInfo(): Promise<{ exists: boolean; metadata: any }> {
  const res = await authFetch('/api/profile')
  if (!res.ok) throw new Error('Failed to get profile info')
  return res.json()
}

export async function clearProfile(): Promise<void> {
  const res = await authFetch('/api/profile', { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to clear profile')
}
