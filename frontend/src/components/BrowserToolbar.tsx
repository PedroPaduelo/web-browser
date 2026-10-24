import { useState, useCallback, useEffect } from 'react'
import { useAuth } from './AuthProvider'

interface Props {
  sessionId: string | null
  pageUrl: string
  onNavigate: (url: string) => void
}

async function postKey(sessionId: string, token: string, body: Record<string, unknown>) {
  await fetch(`/api/input/${sessionId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Par down+up: sem o keyup a tecla fica "presa" no remoto. */
async function tapKey(sessionId: string, token: string, key: string, code: string, extra: Record<string, unknown> = {}) {
  await postKey(sessionId, token, { type: 'keydown', key, code, ...extra })
  await postKey(sessionId, token, { type: 'keyup', key, code, ...extra })
}

export default function BrowserToolbar({ sessionId, pageUrl, onNavigate }: Props) {
  const { token } = useAuth()
  const [url, setUrl] = useState('')
  const [navigating, setNavigating] = useState(false)

  // Sync URL quando a página remota muda (efeito, não setState no render).
  useEffect(() => {
    if (pageUrl) setUrl(pageUrl)
  }, [pageUrl])

  const refocusViewer = useCallback(() => {
    // Devolve o foco ao viewer para o teclado voltar a funcionar de imediato.
    const viewer = document.querySelector<HTMLElement>('[data-viewer-container="true"]')
    if (viewer) viewer.focus({ preventScroll: true })
    else window.dispatchEvent(new Event('serende:refocus-viewer'))
  }, [])

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
      setUrl(finalUrl)
      // Solta o input para o viewer retomar o teclado.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      refocusViewer()
    } finally {
      setNavigating(false)
    }
  }, [url, sessionId, onNavigate, refocusViewer])

  const handleBack = useCallback(async () => {
    if (!sessionId || !token) return
    try {
      await tapKey(sessionId, token, 'Backspace', 'Backspace', { altKey: true })
    } catch (e) {
      console.error('Back failed:', e)
    }
  }, [sessionId, token])

  const handleForward = useCallback(async () => {
    if (!sessionId || !token) return
    try {
      await tapKey(sessionId, token, 'Forward', 'BrowserForward')
    } catch (e) {
      console.error('Forward failed:', e)
    }
  }, [sessionId, token])

  const handleRefresh = useCallback(async () => {
    if (!sessionId || !token) return
    try {
      await tapKey(sessionId, token, 'F5', 'F5')
    } catch (e) {
      console.error('Refresh failed:', e)
    }
  }, [sessionId, token])

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Escape na barra: cancela a edição e devolve o foco ao viewer.
    if (e.key === 'Escape') {
      e.currentTarget.blur()
      refocusViewer()
    }
  }, [refocusViewer])

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
      <button type="button" onClick={handleBack} disabled={!sessionId} title="Voltar" style={btnStyle}>
        ←
      </button>
      <button type="button" onClick={handleForward} disabled={!sessionId} title="Avançar" style={btnStyle}>
        →
      </button>
      <button type="button" onClick={handleRefresh} disabled={!sessionId} title="Atualizar" style={btnStyle}>
        ↻
      </button>

      {/* URL bar */}
      <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex' }}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleUrlKeyDown}
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
