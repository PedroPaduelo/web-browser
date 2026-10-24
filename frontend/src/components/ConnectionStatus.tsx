import { useEffect, useRef, useState } from 'react'
import type { ConnectionState } from '../lib/ws-client'

interface Props {
  state: ConnectionState
  fps?: number
}

// Suavização ÚNICA do FPS (o useStream entrega FPS instantâneo, sem EMA).
// EMA assimétrico: cai rápido (α=0.5) e sobe devagar (α=0.25) —
//
//   queda 30 → 5 fps: 30*0.5 + 5*0.5 = 17 (reage no mesmo tick)
//   subida  5 → 30 fps: 5*0.75 + 30*0.25 = 11 (suaviza picos)
//
// Assim o número não atrasa a reação a quedas reais de FPS.
const ALPHA_DOWN = 0.5
const ALPHA_UP = 0.25
const TICK_MS = 250

/**
 * EMA do FPS com ticker próprio.
 *
 * O React só re-renderiza quando a PROP `fps` muda, então uma EMA calculada
 * dentro de um useEffect[fps] congela quando o valor instantâneo para de
 * mudar (ex.: 54 fps -> queda para 0: o número fica preso no meio e nunca
 * chega a mostrar a queda). O ticker aqui roda a 250ms, independente da prop,
 * e consome a última amostra conhecida — assim a queda sempre aparece.
 */
function useSmoothFps(fps: number | undefined, state: ConnectionState): number {
  const emaRef = useRef<number | null>(null)
  const latestRef = useRef(fps)
  const [smooth, setSmooth] = useState(0)

  latestRef.current = fps

  // Desconectar/resetar zera a EMA (o próximo amostra entra direto).
  useEffect(() => {
    emaRef.current = null
    setSmooth(0)
  }, [state])

  useEffect(() => {
    if (state !== 'connected' || fps === undefined) return
    const id = setInterval(() => {
      const sample = latestRef.current
      if (sample === undefined) return
      const prev = emaRef.current
      const next = prev === null
        ? sample
        : Math.round(sample < prev ? prev * (1 - ALPHA_DOWN) + sample * ALPHA_DOWN
                                  : prev * (1 - ALPHA_UP) + sample * ALPHA_UP)
      emaRef.current = next
      setSmooth((cur) => (cur !== next ? next : cur))
    }, TICK_MS)
    return () => clearInterval(id)
  }, [state, fps === undefined])

  return smooth
}

export default function ConnectionStatus({ state, fps }: Props) {
  const smoothFps = useSmoothFps(fps, state)

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
          {smoothFps} fps
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
