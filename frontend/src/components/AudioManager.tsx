interface Props {
  micEnabled: boolean
  onToggleMic: () => void
  disabled?: boolean
}

export default function AudioManager({ micEnabled, onToggleMic, disabled }: Props) {
  return (
    <button
      onClick={onToggleMic}
      disabled={disabled}
      title={micEnabled ? 'Desativar microfone' : 'Ativar microfone'}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '36px',
        height: '36px',
        borderRadius: '50%',
        border: 'none',
        background: micEnabled ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
        color: micEnabled ? '#22c55e' : '#ef4444',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: '16px',
      }}
    >
      {micEnabled ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" x2="12" y1="19" y2="22"/>
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="2" x2="22" y1="2" y2="22"/>
          <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/>
          <path d="M5 10v2a7 7 0 0 0 12 5.29"/>
          <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/>
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>
          <line x1="12" x2="12" y1="19" y2="22"/>
        </svg>
      )}
    </button>
  )
}
