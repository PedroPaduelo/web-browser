import { useRef, useEffect, useState, useCallback } from 'react'
import { useInputRelay } from '../hooks/useInputRelay'
import { useWebRTC } from '../hooks/useWebRTC'

interface Props {
  setCanvas: (canvas: HTMLCanvasElement | null) => void
  resolution?: { width: number; height: number }
  sessionId: string | null
}

export default function BrowserViewer({ setCanvas, resolution = { width: 1280, height: 720 }, sessionId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState({ x: -100, y: -100, visible: false })

  // WebRTC — stream primário de baixa latência
  const { state: rtcState, videoRef } = useWebRTC(!!sessionId, sessionId)
  const rtcConnected = rtcState === 'connected'
  const rtcFailed = rtcState === 'failed' || rtcState === 'closed'

  // Mostrar canvas MJPEG apenas se WebRTC falhou
  const showCanvas = rtcFailed
  const showVideo = !rtcFailed

  useInputRelay(canvasRef, containerRef, true, resolution, sessionId)

  useEffect(() => {
    // Sempre manter canvas MJPEG conectado como fallback (mas oculto via CSS)
    setCanvas(canvasRef.current)
  }, [setCanvas])

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.focus()
    }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top, visible: true })
  }, [])

  const handleMouseLeave = useCallback(() => {
    setCursor(prev => ({ ...prev, visible: false }))
  }, [])

  const handleMouseEnter = useCallback(() => {
    setCursor(prev => ({ ...prev, visible: true }))
  }, [])

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        cursor: 'none',
        outline: 'none',
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      {/* WebRTC — stream primário via <video> */}
      {showVideo && (
        <video
          ref={videoRef as any}
          autoPlay
          playsInline
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
          }}
        />
      )}

      {/* MJPEG fallback — canvas, aparece apenas se WebRTC falhou */}
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: showCanvas ? 'block' : 'none',
        }}
      />

      {/* Loading overlay — enquanto WebRTC conecta */}
      {rtcState === 'connecting' && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          background: 'rgba(0,0,0,0.7)',
          color: '#9ca3af',
          fontSize: '14px',
          pointerEvents: 'none',
        }}>
          <div style={{
            width: '24px', height: '24px',
            border: '2px solid rgba(255,255,255,0.1)',
            borderTopColor: '#22c55e',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          Conectando via WebRTC...
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Software cursor overlay — resposta visual instantânea */}
      {cursor.visible && (
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          style={{
            position: 'absolute',
            left: cursor.x,
            top: cursor.y,
            pointerEvents: 'none',
            transform: 'translate(-1px, -1px)',
            filter: 'drop-shadow(1px 1px 1px rgba(0,0,0,0.8))',
            zIndex: 10,
          }}
        >
          <path
            d="M2 2 L2 14 L5.5 10.5 L8 16 L10 15 L7.5 9.5 L12 9.5 Z"
            fill="white"
            stroke="black"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  )
}
