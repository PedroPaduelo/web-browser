import { useRef, useEffect, useState, useCallback } from 'react'
import { useInputRelay } from '../hooks/useInputRelay'

interface Props {
  setCanvas: (canvas: HTMLCanvasElement | null) => void
  resolution?: { width: number; height: number }
  sessionId: string | null
}

function getRenderedCanvasRect(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  const cw = canvas.width
  const ch = canvas.height
  if (!cw || !ch) return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }

  const containerAspect = rect.width / rect.height
  const canvasAspect = cw / ch

  let renderW: number, renderH: number, offsetX: number, offsetY: number

  if (canvasAspect > containerAspect) {
    renderW = rect.width
    renderH = rect.width / canvasAspect
    offsetX = 0
    offsetY = (rect.height - renderH) / 2
  } else {
    renderH = rect.height
    renderW = rect.height * canvasAspect
    offsetX = (rect.width - renderW) / 2
    offsetY = 0
  }

  return { x: rect.left + offsetX, y: rect.top + offsetY, w: renderW, h: renderH }
}

export default function BrowserViewer({ setCanvas, resolution = { width: 1280, height: 720 }, sessionId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState({ x: -100, y: -100, visible: false })

  useInputRelay(canvasRef, containerRef, true, resolution, sessionId)

  useEffect(() => {
    setCanvas(canvasRef.current)
  }, [setCanvas])

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.focus()
    }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cr = getRenderedCanvasRect(canvas)
    const containerRect = containerRef.current?.getBoundingClientRect()
    if (!containerRect) return
    // Posiciona cursor relativo ao container, mas limitado à área do canvas
    const relX = e.clientX - containerRect.left
    const relY = e.clientY - containerRect.top
    setCursor({ x: relX, y: relY, visible: true })
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
      {/* MJPEG canvas */}
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: 'block',
        }}
      />

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
