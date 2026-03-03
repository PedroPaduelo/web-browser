import { useState, useCallback, useEffect } from 'react'

export type SessionStatus = 'idle' | 'creating' | 'active' | 'destroying' | 'error'

export interface SessionInfo {
  status: string
  resolution: { width: number; height: number }
}

interface SessionOptions {
  resolution?: string
  startUrl?: string
}

export function useSession() {
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/session')
      .then(res => {
        if (res.ok) return res.json()
        return null
      })
      .then(data => {
        if (data && data.status === 'running') {
          setSessionInfo({ status: data.status, resolution: data.resolution })
          setStatus('active')
        }
      })
      .catch(() => {})
  }, [])

  const createSession = useCallback(async (options?: SessionOptions) => {
    setStatus('creating')
    setError(null)

    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options || {}),
      })

      if (res.status === 409) {
        const existing = await fetch('/api/session')
        if (existing.ok) {
          const data = await existing.json()
          setSessionInfo({ status: data.status, resolution: data.resolution })
          setError(null)
          setStatus('active')
          return data
        }
        setError('Sessão já ativa')
        setStatus('error')
        return null
      }

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        const msg = data?.error || `Erro do servidor (HTTP ${res.status})`
        setError(msg)
        setStatus('error')
        return null
      }

      const data: SessionInfo = await res.json()
      setSessionInfo(data)
      setStatus('active')
      return data
    } catch (err: any) {
      const msg = err.message || ''
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('fetch')) {
        setError('Servidor offline. Tente novamente.')
      } else {
        setError(msg || 'Erro de rede')
      }
      setStatus('error')
      return null
    }
  }, [])

  const destroySession = useCallback(async () => {
    setStatus('destroying')

    try {
      await fetch('/api/session', { method: 'DELETE' })
    } catch (err: any) {
      setError(err.message)
    }

    setSessionInfo(null)
    setStatus('idle')
  }, [])

  return { status, sessionInfo, error, createSession, destroySession, setStatus }
}
