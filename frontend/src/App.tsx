import { useCallback, useState } from 'react'
import { useAuth } from './components/AuthProvider'
import { useSession } from './hooks/useSession'
import { useStream } from './hooks/useStream'
import { usePageInfo } from './hooks/usePageInfo'
import BrowserViewer from './components/BrowserViewer'
import BrowserToolbar from './components/BrowserToolbar'
import SessionControls from './components/SessionControls'
import ConnectionStatus from './components/ConnectionStatus'
import LoginScreen from './components/LoginScreen'

export default function App() {
  const { isAuthenticated, loading: authLoading, logout, token } = useAuth()
  const { status, sessionInfo, error, createSession, destroySession } = useSession()

  const isActive = status === 'active'
  const sessionId = sessionInfo?.sessionId || null
  const { isConnected, fps, connectionState, setCanvas } = useStream(isActive, sessionId)
  const { pageInfo, refetch: refetchPageInfo } = usePageInfo(sessionId)

  const resolution = sessionInfo?.resolution || { width: 1920, height: 1080 }

  const handleNavigate = useCallback(async (url: string) => {
    if (!sessionId || !token) return
    try {
      await fetch(`/api/navigate/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      })
      // Refresh URL after navigation
      setTimeout(refetchPageInfo, 2000)
    } catch (e) {
      console.error('Navigation failed:', e)
    }
  }, [sessionId, token, refetchPageInfo])

  const handleStart = useCallback(async (res: string, startUrl: string) => {
    await createSession({ resolution: res, startUrl })
  }, [createSession])

  const handleStop = useCallback(async () => {
    await destroySession()
  }, [destroySession])

  if (authLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: '#111', color: '#9ca3af' }}>
        Carregando...
      </div>
    )
  }

  if (!isAuthenticated) {
    return <LoginScreen />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <SessionControls
          status={status}
          onStart={handleStart}
          onStop={handleStop}
          error={error}
          sessionId={sessionId}
          sessionInfo={sessionInfo}
        />
        {isActive && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '0 16px',
            background: 'rgba(20, 20, 20, 0.95)',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            height: '100%',
          }}>
            <ConnectionStatus state={connectionState} fps={fps} />
          </div>
        )}
        <div style={{
          marginLeft: 'auto',
          padding: '0 16px',
          background: 'rgba(20, 20, 20, 0.95)',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
        }}>
          <button
            onClick={logout}
            style={{
              padding: '4px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'transparent',
              color: '#9ca3af',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Sair
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {isActive && (
          <BrowserToolbar
            sessionId={sessionId}
            pageUrl={pageInfo.url}
            onNavigate={handleNavigate}
          />
        )}
        {isActive ? (
          <BrowserViewer
            setCanvas={setCanvas}
            resolution={resolution}
            sessionId={sessionId}
          />
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px',
            color: '#6b7280',
          }}>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
              <line x1="8" x2="16" y1="21" y2="21"/>
              <line x1="12" x2="12" y1="17" y2="21"/>
            </svg>
            <h2 style={{ fontSize: '20px', fontWeight: 500, color: '#9ca3af' }}>
              Serende — Remote Browser
            </h2>
            <p style={{ fontSize: '14px', maxWidth: '400px', textAlign: 'center', lineHeight: 1.6 }}>
              Escolha a resolução e clique em "Iniciar Sessão" para abrir um Chrome remoto.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
