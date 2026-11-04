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

  // Pending por botão (torneio): nav por keystroke sintético é fire-and-forget —
  // sem feedback o usuário clica 3x. Com pending + refocus, 1 clique basta.
  const [pendingBtn, setPendingBtn] = useState<string | null>(null)

  const runNavAction = useCallback(async (name: string, fn: () => Promise<void>) => {
    if (!sessionId || !token || pendingBtn) return
    setPendingBtn(name)
    try {
      await fn()
    } catch (e) {
      console.error(`${name} failed:`, e)
    } finally {
      setPendingBtn(null)
      refocusViewer()
    }
  }, [sessionId, token, pendingBtn, refocusViewer])

  const handleBack = useCallback(() => {
    void runNavAction('back', () => tapKey(sessionId!, token!, 'Backspace', 'Backspace', { altKey: true }))
  }, [sessionId, token, runNavAction])

  const handleForward = useCallback(() => {
    void runNavAction('forward', () => tapKey(sessionId!, token!, 'Forward', 'BrowserForward'))
  }, [sessionId, token, runNavAction])

  const handleRefresh = useCallback(() => {
    void runNavAction('refresh', () => tapKey(sessionId!, token!, 'F5', 'F5'))
  }, [sessionId, token, runNavAction])

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Escape na barra: cancela a edição e devolve o foco ao viewer.
    if (e.key === 'Escape') {
      e.currentTarget.blur()
      refocusViewer()
    }
  }, [refocusViewer])

  return (
    // Embutido na barra unica do topo: nao tem fundo nem borda propria, o
    // espaco vertical e o mais precious da tela do browser.
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      flex: 1,
      minWidth: 0,
      padding: '6px 8px',
    }}>
      {/* Navigation buttons. Opacidade 0.5 + disabled durante pending: sem isso
          o usuário clicava 3x no keystroke sintético sem feedback. */}
      <button type="button" onClick={handleBack} disabled={!sessionId || pendingBtn !== null} title="Voltar" style={{ ...btnStyle, opacity: pendingBtn === 'back' ? 0.5 : 1 }}>
        {pendingBtn === 'back' ? '…' : '←'}
      </button>
      <button type="button" onClick={handleForward} disabled={!sessionId || pendingBtn !== null} title="Avançar" style={{ ...btnStyle, opacity: pendingBtn === 'forward' ? 0.5 : 1 }}>
        {pendingBtn === 'forward' ? '…' : '→'}
      </button>
      <button type="button" onClick={handleRefresh} disabled={!sessionId || pendingBtn !== null} title="Atualizar" style={{ ...btnStyle, opacity: pendingBtn === 'refresh' ? 0.5 : 1 }}>
        {pendingBtn === 'refresh' ? '…' : '↻'}
      </button>

      {/* URL bar */}
      <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex', minWidth: 0 }}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleUrlKeyDown}
          placeholder={sessionId ? 'Digite uma URL...' : 'Inicie uma sessão primeiro'}
          disabled={!sessionId || navigating}
          style={{
            width: '100%',
            padding: '6px 12px',
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
