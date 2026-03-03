interface Props {
  isConnected: boolean
  isMuted: boolean
  onToggleMute: () => void
  onResume: () => void
}

export default function AudioControl({ isConnected, isMuted, onToggleMute, onResume }: Props) {
  return (
    <button
      onClick={() => {
        onResume()
        onToggleMute()
      }}
      title={isMuted ? 'Ativar som' : 'Mutar som'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px 8px',
        borderRadius: '8px',
        border: 'none',
        background: 'rgba(255,255,255,0.08)',
        color: isConnected ? (isMuted ? '#ef4444' : '#22c55e') : '#6b7280',
        cursor: 'pointer',
        fontSize: '12px',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {isMuted ? (
          <>
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </>
        ) : (
          <>
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </>
        )}
      </svg>
      <span>{isMuted ? 'Mudo' : 'Som'}</span>
    </button>
  )
}
