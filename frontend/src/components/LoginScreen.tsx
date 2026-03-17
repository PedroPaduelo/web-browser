import { useState, useEffect } from 'react'
import { useAuth } from './AuthProvider'
import { getSavedApiKey } from '../lib/auth-client'

export default function LoginScreen() {
  const { login } = useAuth()
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    const saved = getSavedApiKey()
    if (saved) setApiKey(saved)
  }, [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiKey.trim()) return

    setLoading(true)
    setError(null)

    try {
      await login(apiKey.trim())
    } catch (err: any) {
      setError(err.message || 'Erro ao fazer login')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      background: '#111',
    }}>
      <form onSubmit={handleSubmit} style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '32px',
        borderRadius: '12px',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.1)',
        width: '360px',
      }}>
        <h2 style={{ color: '#fff', fontSize: '20px', fontWeight: 600, margin: 0, textAlign: 'center' }}>
          Serende — Remote Browser
        </h2>
        <p style={{ color: '#9ca3af', fontSize: '14px', margin: 0, textAlign: 'center' }}>
          Insira sua API Key para acessar
        </p>

        <input
          type="password"
          placeholder="API Key"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          autoFocus
          disabled={loading}
          style={{
            padding: '10px 14px',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.05)',
            color: '#fff',
            fontSize: '14px',
            outline: 'none',
          }}
        />

        <button
          type="submit"
          disabled={loading || !apiKey.trim()}
          style={{
            padding: '10px',
            borderRadius: '8px',
            border: 'none',
            background: loading ? '#4b5563' : '#3b82f6',
            color: '#fff',
            fontSize: '14px',
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'Entrando...' : 'Entrar'}
        </button>

        {error && (
          <p style={{ color: '#ef4444', fontSize: '13px', margin: 0, textAlign: 'center' }}>
            {error}
          </p>
        )}
      </form>
    </div>
  )
}
