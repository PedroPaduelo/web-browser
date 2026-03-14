import { useState, useEffect } from 'react'
import type { SessionStatus, SessionInfo } from '../hooks/useSession'
import { getProfileInfo, clearProfile } from '../lib/auth-client'

interface Props {
  status: SessionStatus
  onStart: (resolution: string, startUrl: string) => void
  onStop: () => void
  error: string | null
  sessionId: string | null
  sessionInfo?: SessionInfo | null
  onTimeoutUpdate?: () => void
}

const RESOLUTIONS = [
  { label: '480p', value: '854x480' },
  { label: '720p', value: '1280x720' },
  { label: '1080p', value: '1920x1080' },
]

export default function SessionControls({ status, onStart, onStop, error, sessionId, sessionInfo, onTimeoutUpdate }: Props) {
  const [resolution, setResolution] = useState('1280x720')
  const [startUrl, setStartUrl] = useState('https://www.google.com')
  const [hasProfile, setHasProfile] = useState(false)
  const [timeoutRemaining, setTimeoutRemaining] = useState<number>(0)

  const isLoading = status === 'creating' || status === 'destroying'

  // Buscar info de profile
  useEffect(() => {
    getProfileInfo()
      .then(info => setHasProfile(info.exists))
      .catch(() => {})
  }, [])

  // Polling do timer a cada segundo
  useEffect(() => {
    if (!sessionInfo?.timeout) return

    // Inicializar com o valor atual
    setTimeoutRemaining(sessionInfo.timeout.remaining)

    const interval = setInterval(() => {
      setTimeoutRemaining(prev => {
        const newRemaining = Math.max(0, prev - 1000)
        // Notificar parent se houver callback
        if (newRemaining === 0 && onTimeoutUpdate) {
          onTimeoutUpdate()
        }
        return newRemaining
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [sessionInfo?.timeout, onTimeoutUpdate])

  const handleClearProfile = async () => {
    if (!confirm('Tem certeza que deseja limpar o profile? Todos os dados (logins, cookies, etc) serão perdidos.')) {
      return
    }
    try {
      await clearProfile()
      setHasProfile(false)
      alert('Profile limpo com sucesso!')
    } catch (err: any) {
      alert('Erro ao limpar profile: ' + err.message)
    }
  }

  // Formatar tempo restante de timeout
  const formatTimeout = (ms: number) => {
    const mins = Math.floor(ms / 60000)
    const secs = Math.floor((ms % 60000) / 1000)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '10px 16px',
      background: 'rgba(20, 20, 20, 0.95)',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
      flexWrap: 'wrap',
    }}>
      {status === 'idle' || status === 'error' ? (
        <>
          <input
            type="text"
            placeholder="URL inicial"
            value={startUrl}
            onChange={e => setStartUrl(e.target.value)}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.05)',
              color: '#fff',
              fontSize: '14px',
              outline: 'none',
              width: '280px',
            }}
          />
          <select
            value={resolution}
            onChange={e => setResolution(e.target.value)}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.05)',
              color: '#fff',
              fontSize: '14px',
            }}
          >
            {RESOLUTIONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button
            onClick={() => onStart(resolution, startUrl)}
            disabled={isLoading}
            style={{
              padding: '6px 20px',
              borderRadius: '6px',
              border: 'none',
              background: '#22c55e',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 600,
              cursor: !isLoading ? 'pointer' : 'not-allowed',
              opacity: !isLoading ? 1 : 0.5,
            }}
          >
            Iniciar Sessão
          </button>
          {hasProfile && (
            <button
              onClick={handleClearProfile}
              disabled={isLoading}
              style={{
                padding: '6px 16px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: '#9ca3af',
                fontSize: '13px',
                cursor: !isLoading ? 'pointer' : 'not-allowed',
              }}
              title="Limpar profile (cookies, logins, etc)"
            >
              Limpar Profile
            </button>
          )}
        </>
      ) : null}

      {status === 'creating' && (
        <span style={{ color: '#fbbf24', fontSize: '14px' }}>Criando sessão...</span>
      )}

      {status === 'active' && (
        <>
          <button
            onClick={onStop}
            disabled={isLoading}
            style={{
              padding: '6px 20px',
              borderRadius: '6px',
              border: 'none',
              background: '#ef4444',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Encerrar Sessão
          </button>
          {sessionId && (
            <span style={{ color: '#6b7280', fontSize: '11px', fontFamily: 'monospace' }}>
              {sessionId.slice(0, 8)}
            </span>
          )}
          {hasProfile && (
            <span style={{ color: '#22c55e', fontSize: '11px' }}>● Profile salvo</span>
          )}
          {sessionInfo?.timeout && (
            <span
              style={{
                color: timeoutRemaining < 120000 ? '#f59e0b' : '#6b7280',
                fontSize: '12px',
              }}
              title="Tempo restante até timeout"
            >
              ⏱ {formatTimeout(timeoutRemaining)}
            </span>
          )}
        </>
      )}

      {status === 'destroying' && (
        <span style={{ color: '#fbbf24', fontSize: '14px' }}>Encerrando...</span>
      )}

      {error && status !== 'active' && (
        <span style={{ color: '#ef4444', fontSize: '13px' }}>{error}</span>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: status === 'active' ? '#22c55e' : status === 'creating' || status === 'destroying' ? '#fbbf24' : '#6b7280',
        }} />
        <span style={{ color: '#9ca3af', fontSize: '12px', textTransform: 'uppercase' }}>
          {status}
        </span>
      </div>
    </div>
  )
}
