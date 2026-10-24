import { useState, useEffect, useRef, useCallback } from 'react'
import { createWsClient, type ConnectionState } from '../lib/ws-client'
import { getAuthWsUrl } from '../lib/auth-client'

interface StreamState {
  isConnected: boolean
  fps: number
  connectionState: ConnectionState
}

// Teto do DPR: acima de 2x o custo de preencher o backbuffer não compensa
// o ganho de nitidez.
const MAX_DPR = 2

// NOTA: o backoff exponencial com limite de tentativas do transporte WS vive
// em ws-client.ts (read-only aqui). Este hook foca em: descarte de frames
// obsoletos, render on-demand via rAF e FPS de frames realmente renderizados.
export function useStream(active: boolean, sessionId: string | null) {
  const [state, setState] = useState<StreamState>({
    isConnected: false,
    fps: 0,
    connectionState: 'disconnected',
  })

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // rendered = frames desenhados no último segundo (FPS instantâneo)
  const fpsRef = useRef({ rendered: 0 })

  const setCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas
  }, [])

  useEffect(() => {
    if (!active || !sessionId) return

    let cancelled = false
    const wsUrl = getAuthWsUrl('/ws/stream', sessionId)
    const ws = createWsClient()

    ws.onStateChange((s) => {
      if (cancelled) return
      setState(prev => ({
        ...prev,
        connectionState: s,
        isConnected: s === 'connected',
      }))
    })

    let pendingFrame: ImageBitmap | null = null
    // Frame cru na fila de decode (backpressure: 1 decode em voo + 1 na fila)
    let queuedBlob: Blob | null = null
    let decoding = false
    let rafId = 0
    let rafScheduled = false
    let ctx: CanvasRenderingContext2D | null = null
    let currentCanvas: HTMLCanvasElement | null = null
    // Backbuffer já aplicado: trocar canvas.width/height recria o buffer e
    // zera o estado do 2D context — só mexemos quando a resolução muda.
    let appliedW = 0
    let appliedH = 0

    function applyContextState(c: CanvasRenderingContext2D) {
      c.imageSmoothingEnabled = true
      c.imageSmoothingQuality = 'high'
    }

    // Render on-demand: agenda 1 rAF por frame novo em vez de loop contínuo
    function scheduleRender() {
      if (rafScheduled || cancelled) return
      rafScheduled = true
      rafId = requestAnimationFrame(() => {
        rafScheduled = false
        if (cancelled) return
        if (pendingFrame) {
          const canvas = canvasRef.current
          if (canvas) {
            if (canvas !== currentCanvas) {
              currentCanvas = canvas
              ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
              appliedW = 0
              appliedH = 0
            }
            // Resolução efetiva = frame × DPR (teto MAX_DPR). Em tela 2x o
            // bitmap é desenhado na densidade real em vez de ser interpolado
            // pelo browser a cada frame.
            const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1))
            const w = Math.round(pendingFrame.width * dpr)
            const h = Math.round(pendingFrame.height * dpr)
            if (ctx) {
              // Resize do backbuffer só quando a resolução efetiva muda:
              // mexer em canvas.width recria o buffer e reseta o estado do
              // context (por isso reaplicamos as opções de interpolação).
              if (appliedW !== w || appliedH !== h) {
                canvas.width = w
                canvas.height = h
                appliedW = w
                appliedH = h
                applyContextState(ctx)
              }
              ctx.drawImage(pendingFrame, 0, 0, w, h)
            }
            fpsRef.current.rendered++
          }
          pendingFrame.close()
          pendingFrame = null
          // Sobrou frame cru na fila: decodifica agora, o próximo rAF pinta.
          if (queuedBlob) void decodeLoop()
        }
      })
    }

    // Backpressure de decode: 1 decode em voo + 1 frame cru na fila.
    // Frame que chega com outro já pronto é descartado ANTES do decode
    // (3-8ms de main thread por frame de ~150KB) em vez de ser decodificado
    // para ser jogado fora.
    async function decodeLoop() {
      if (decoding || cancelled) return
      decoding = true
      try {
        while (!cancelled && queuedBlob && !pendingFrame) {
          const blob = queuedBlob
          queuedBlob = null
          let bmp: ImageBitmap | null = null
          try {
            bmp = await createImageBitmap(blob)
          } catch {
            bmp = null
          }
          if (!bmp) continue
          if (cancelled) { bmp.close(); break }
          pendingFrame = bmp
          scheduleRender()
        }
      } finally {
        decoding = false
      }
    }

    ws.onBinary((data) => {
      if (cancelled) return
      // ws-client usa binaryType='arraybuffer': data já é ArrayBuffer (zero-copy).
      // Aceita Blob (fallback de navegador) sem cópia extra.
      if (data == null) return
      const isBlob = typeof Blob !== 'undefined' && data instanceof Blob
      if (!isBlob && (data as ArrayBuffer).byteLength === 0) return
      // Já existe frame decodificado esperando o rAF: este é supérfluo.
      if (pendingFrame) return
      const blob: Blob = isBlob
        ? (data as unknown as Blob)
        : new Blob([data as ArrayBuffer], { type: 'image/jpeg' })
      // Só o frame mais recente fica na fila (o anterior morre sem decode).
      queuedBlob = blob
      void decodeLoop()
    })

    ws.connect(wsUrl)

    // FPS real = frames renderizados no segundo anterior (instantâneo).
    // O suavizado acontece em ConnectionStatus — uma EMA só, no display.
    const fpsInterval = setInterval(() => {
      if (cancelled) return
      const inst = fpsRef.current.rendered
      fpsRef.current.rendered = 0
      setState(prevSt => prevSt.fps !== inst ? { ...prevSt, fps: inst } : prevSt)
    }, 1000)

    return () => {
      cancelled = true
      ws.disconnect()
      clearInterval(fpsInterval)
      if (rafScheduled) cancelAnimationFrame(rafId)
      rafScheduled = false
      if (pendingFrame) { pendingFrame.close(); pendingFrame = null }
      queuedBlob = null
      fpsRef.current.rendered = 0
      ctx = null
      currentCanvas = null
    }
  }, [active, sessionId])

  return { ...state, setCanvas }
}
