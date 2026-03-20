import { useState, useCallback } from 'react'
import { useAuth } from './AuthProvider'

interface Props {
  sessionId: string | null
  pageUrl: string
  onNavigate: (url: string) => void
}

export default function BrowserToolbar({ sessionId, pageUrl, onNavigate }: Props) {
  const { token } = useAuth()
  const [url, setUrl] = useState('')
  const [navigating, setNavigating] = useState(false)

  // Sync URL when page changes
  useState(() => {
    if (pageUrl) setUrl(pageUrl)
  })

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim() || !sessionId) return

    setNavigating(true)
    try {
      let finalUrl = url.trim()
      if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
        finalUrl = 'https://' + finalUrl
      }
      onNavigate(finalUrl)
      setTimeout(() => setUrl(finalUrl), 500)
    } finally {
      setNavigating(false)
    }
  }, [url, sessionId, onNavigate])

  const handleBack = useCallback(async () => {
    if (!sessionId || !token) return
    try {
      await fetch(`/api/input/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'keydown', key: 'Backspace' })
      })
    } catch (e) {
      console.error('Back failed:', e)
    }
  }, [sessionId, token])

  const handleForward = useCallback(async () => {
    if (!sessionId || !token) return
    try {
      await fetch(`/api/input/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'keydown', key: 'Forward' })
      })
    } catch (e) {
      console.error('Forward failed:', e)
    }
  }, [sessionId, token])

  const handleRefresh = useCallback(async () => {
    if (!sessionId || !token) return
    try {
      await fetch(`/api/input/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'keydown', key: 'F5' })
      })
    } catch (e) {
      console.error('Refresh failed:', e)
    }
  }, [sessionId, token])

  // Sync URL display
  if (pageUrl && url !== pageUrl) {
    setUrl(pageUrl)
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 12px',
      background: '#1e1e1e',
      borderBottom: '1px solid #333',
    }}>
      {/* Navigation buttons */}
      <button onClick={handleBack} disabled={!sessionId} title="Voltar" style={btnStyle}>
        ←
      </button>
      <button onClick={handleForward} disabled={!sessionId} title="Avançar" style={btnStyle}>
        →
      </button>
      <button onClick={handleRefresh} disabled={!sessionId} title="Atualizar" style={btnStyle}>
        ↻
      </button>

      {/* URL bar */}
      <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex' }}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={sessionId ? 'Digite uma URL...' : 'Inicie uma sessão primeiro'}
          disabled={!sessionId || navigating}
          style={{
            width: '100%',
            padding: '8px 12px',
            background: '#2a2a2a',
            border: '1px solid #444',
            borderRadius: '6px',
            color: '#fff',
            fontSize: '13px',
            fontFamily: 'monospace',
          }}
        />
      </form>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: '#333',
  border: 'none',
  borderRadius: '4px',
  color: '#fff',
  fontSize: '16px',
  cursor: 'pointer',
}
