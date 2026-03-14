import { useState, useEffect, useRef, useCallback } from 'react'
import { createWsClient, type ConnectionState } from '../lib/ws-client'
import { getAuthWsUrl } from '../lib/auth-client'

interface StreamState {
  isConnected: boolean
  fps: number
  connectionState: ConnectionState
}

export function useStream(active: boolean, sessionId: string | null) {
  const [state, setState] = useState<StreamState>({
    isConnected: false,
    fps: 0,
    connectionState: 'disconnected',
  })

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fpsRef = useRef({ count: 0, last: 0 })

  const setCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas
  }, [])

  useEffect(() => {
    if (!active || !sessionId) return

    const wsUrl = getAuthWsUrl('/ws/stream', sessionId)
    const ws = createWsClient()

    ws.onStateChange((s) => {
      setState(prev => ({
        ...prev,
        connectionState: s,
        isConnected: s === 'connected',
      }))
    })

    let pendingFrame: ImageBitmap | null = null
    let rafId = 0
    let ctx: CanvasRenderingContext2D | null = null
    let currentCanvas: HTMLCanvasElement | null = null

    function renderFrame() {
      if (pendingFrame) {
        const canvas = canvasRef.current
        if (canvas) {
          if (canvas !== currentCanvas) {
            currentCanvas = canvas
            ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
          }
          const w = pendingFrame.width
          const h = pendingFrame.height
          if (canvas.width !== w) canvas.width = w
          if (canvas.height !== h) canvas.height = h
          if (ctx) ctx.drawImage(pendingFrame, 0, 0)
        }
        pendingFrame.close()
        pendingFrame = null
      }
      rafId = requestAnimationFrame(renderFrame)
    }
    rafId = requestAnimationFrame(renderFrame)

    ws.onBinary((data) => {
      fpsRef.current.count++
      createImageBitmap(new Blob([data], { type: 'image/jpeg' })).then((bmp) => {
        if (pendingFrame) pendingFrame.close()
        pendingFrame = bmp
      }).catch(() => {})
    })

    ws.connect(wsUrl)

    const fpsInterval = setInterval(() => {
      const fps = fpsRef.current.count
      fpsRef.current.count = 0
      setState(prev => prev.fps !== fps ? { ...prev, fps } : prev)
    }, 1000)

    return () => {
      ws.disconnect()
      clearInterval(fpsInterval)
      cancelAnimationFrame(rafId)
      if (pendingFrame) { pendingFrame.close(); pendingFrame = null }
      fpsRef.current.count = 0
      ctx = null
      currentCanvas = null
    }
  }, [active, sessionId])

  return { ...state, setCanvas }
}
