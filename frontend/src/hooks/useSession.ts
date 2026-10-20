import { useState, useCallback, useEffect } from 'react'
import { authFetch, apiAuthFetch } from '../lib/auth-client'
import { describeError } from '../lib/api-client'
import { useAuth } from '../components/AuthProvider'

export type SessionStatus = 'idle' | 'creating' | 'active' | 'destroying' | 'error'

export interface SessionInfo {
  sessionId: string
  status: string
  resolution: { width: number; height: number }
  timeout?: {
    inactive: number
    remaining: number
    timeoutMs: number
    warningSoon: boolean
  }
}

interface SessionOptions {
  resolution?: string
  startUrl?: string
}

export function useSession() {
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { isAuthenticated } = useAuth()

  // Carrega sessão do URL parameter ?session=ID
  useEffect(() => {
    if (!isAuthenticated) return

    const urlParams = new URLSearchParams(window.location.search)
    const sessionIdFromUrl = urlParams.get('session')

    if (sessionIdFromUrl) {
      // Carrega sessão específica da URL
      authFetch(`/api/session/${sessionIdFromUrl}`)
        .then(res => {
          if (res.ok) return res.json()
          if (res.status === 404) throw new Error('Sessão não encontrada')
          if (res.status === 403) throw new Error('Sessão pertence a outro usuário')
          return null
        })
        .then(data => {
          if (data) {
            setSessionInfo({
              sessionId: data.sessionId,
              status: data.status,
              resolution: data.resolution,
              timeout: data.timeout,
            })
            setStatus('active')
          }
        })
        .catch(err => {
          setError(err.message || 'Erro ao carregar sessão')
          setStatus('error')
        })
      return
    }

    // Se não tem session na URL, carrega primeira sessão ativa
    authFetch('/api/session')
      .then(res => {
        if (res.ok) return res.json()
        return null
      })
      .then(data => {
        if (data?.sessions?.length > 0) {
          const s = data.sessions[0]
          setSessionInfo({ sessionId: s.sessionId, status: s.status, resolution: s.resolution })
          setStatus('active')
        }
      })
      .catch(() => {})
  }, [isAuthenticated])

  const createSession = useCallback(async (options?: SessionOptions) => {
    setStatus('creating')
    setError(null)

    try {
      // `apiAuthFetch` repete com backoff quando o backend está reiniciando
      // (o watchdog o derruba e o levanta em ~1-8s) e distingue "backend fora"
      // de "erro real do servidor" — o 500 vazio do proxy do Vite.
      const res = await apiAuthFetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options || {}),
        onRetry: (attempt, _err, waitMs) => {
          setError(`Servidor de sessões indisponível. Tentando reconectar (tentativa ${attempt} em ${Math.round(waitMs / 1000)}s)...`)
        },
      })

      if (res.status === 401) {
        setError('Sessão expirada. Faça login novamente.')
        setStatus('error')
        return null
      }

      if (res.status === 429) {
        const data = await res.json().catch(() => null)
        setError(data?.error || 'Limite de sessões atingido')
        setStatus('error')
        return null
      }

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error || `Erro do servidor (HTTP ${res.status})`)
        setStatus('error')
        return null
      }
      const data = await res.json()
      setSessionInfo({
        sessionId: data.sessionId,
        status: data.status,
        resolution: data.resolution,
        timeout: data.timeout,
      })
      setStatus('active')
      return data
    } catch (err: any) {
      // BackendUnavailableError => o servidor não está servindo (503 real,
      // timeout, ou proxy sem backend). ApiError => erro real da aplicação.
      setError(describeError(err))
      setStatus('error')
      return null
    }
  }, [])

  const destroySession = useCallback(async (sessionId?: string) => {
    const id = sessionId || sessionInfo?.sessionId
    if (!id) return

    setStatus('destroying')

    try {
      await authFetch(`/api/session/${id}`, { method: 'DELETE' })
    } catch (err: any) {
      setError(err.message)
    }

    setSessionInfo(null)
    setStatus('idle')
  }, [sessionInfo])

  return { status, sessionInfo, error, createSession, destroySession, setStatus }
}
