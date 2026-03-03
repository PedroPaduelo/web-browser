import type { ConnectionState } from '../lib/ws-client'

interface Props {
  state: ConnectionState
  fps?: number
}

export default function ConnectionStatus({ state, fps }: Props) {
  const colors: Record<ConnectionState, string> = {
    connected: '#22c55e',
    connecting: '#fbbf24',
    reconnecting: '#f97316',
    disconnected: '#ef4444',
  }

  const labels: Record<ConnectionState, string> = {
    connected: 'Conectado',
    connecting: 'Conectando...',
    reconnecting: 'Reconectando...',
    disconnected: 'Desconectado',
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '4px 10px',
      borderRadius: '12px',
      background: 'rgba(0,0,0,0.3)',
      fontSize: '12px',
    }}>
      <div style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: colors[state],
        animation: state === 'reconnecting' || state === 'connecting' ? 'pulse 1.5s infinite' : 'none',
      }} />
      <span style={{ color: colors[state] }}>
        {labels[state]}
      </span>
      {fps !== undefined && state === 'connected' && (
        <span style={{ color: '#9ca3af', marginLeft: '4px' }}>
          {fps} fps
        </span>
      )}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  )
}
