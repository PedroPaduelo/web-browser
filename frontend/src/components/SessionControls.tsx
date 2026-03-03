import { useState } from 'react'
import type { SessionStatus } from '../hooks/useSession'

interface Props {
  status: SessionStatus
  onStart: (resolution: string, startUrl: string) => void
  onStop: () => void
  error: string | null
}

const RESOLUTIONS = [
  { label: '480p', value: '854x480' },
  { label: '720p', value: '1280x720' },
  { label: '1080p', value: '1920x1080' },
]

export default function SessionControls({ status, onStart, onStop, error }: Props) {
  const [resolution, setResolution] = useState('1280x720')
  const [startUrl, setStartUrl] = useState('https://www.google.com')

  const isLoading = status === 'creating' || status === 'destroying'

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
        </>
      ) : null}

      {status === 'creating' && (
        <span style={{ color: '#fbbf24', fontSize: '14px' }}>Criando sessão...</span>
      )}

      {status === 'active' && (
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
