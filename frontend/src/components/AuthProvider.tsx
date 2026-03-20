import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { login as authLogin, logout as authLogout, isAuthenticated as checkAuth, getTenantId, getToken, getSavedApiKey } from '../lib/auth-client'

interface AuthContextType {
  isAuthenticated: boolean
  tenantId: string | null
  userId: string | null
  token: string | null
  loading: boolean
  login: (apiKey: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextType>(null!)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [tenantId, setTenantId] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(getToken())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Auto-login via ?token= na URL (gerado pelo admin ao abrir sessão)
    const params = new URLSearchParams(window.location.search)
    const urlToken = params.get('token')
    if (urlToken) {
      localStorage.setItem('serende_token', urlToken)
      // Remover token da URL sem recarregar
      params.delete('token')
      const newSearch = params.toString()
      const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash
      window.history.replaceState({}, '', newUrl)
    }

    if (checkAuth()) {
      const token = getToken()
      if (token) {
        fetch('/api/auth/verify', {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then(res => {
            if (res.ok) return res.json()
            throw new Error('Invalid token')
          })
          .then(data => {
            setAuthenticated(true)
            setTenantId(data.tenantId || data.userId)
            setToken(getToken())
          })
          .catch(() => {
            authLogout()
            setAuthenticated(false)
            setTenantId(null)
          })
          .finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    } else {
      // Token expirado — tenta renovar automaticamente com a apiKey salva
      const savedKey = getSavedApiKey()
      if (savedKey) {
        authLogin(savedKey)
          .then(data => {
            setAuthenticated(true)
            setTenantId(data.tenantId)
            setToken(getToken())
          })
          .catch(() => {
            authLogout()
            setAuthenticated(false)
          })
          .finally(() => setLoading(false))
      } else {
        authLogout()
        setLoading(false)
      }
    }
  }, [])

  const login = useCallback(async (apiKey: string) => {
    const data = await authLogin(apiKey)
    setAuthenticated(true)
    setTenantId(data.tenantId)
    setToken(getToken())
  }, [])

  const logout = useCallback(() => {
    authLogout()
    setAuthenticated(false)
    setTenantId(null)
    setToken(null)
  }, [])

  return (
    <AuthContext.Provider value={{ isAuthenticated: authenticated, tenantId, userId: tenantId, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
