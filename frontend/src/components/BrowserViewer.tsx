import { useRef, useEffect } from 'react'
import { useInputRelay } from '../hooks/useInputRelay'

interface Props {
  setCanvas: (canvas: HTMLCanvasElement | null) => void
  resolution?: { width: number; height: number }
  sessionId: string | null
}

export default function BrowserViewer({ setCanvas, resolution = { width: 1280, height: 720 }, sessionId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useInputRelay(canvasRef, containerRef, true, resolution, sessionId)

  useEffect(() => {
    setCanvas(canvasRef.current)
    return () => setCanvas(null)
  }, [setCanvas])

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.focus()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        cursor: 'default',
        outline: 'none',
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
        }}
      />
    </div>
  )
}
