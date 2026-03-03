import { useEffect, useRef, useCallback } from 'react'
import { createWsClient } from '../lib/ws-client'
import { mapScroll, mapKeyDown, mapKeyUp, Resolution } from '../lib/input-mapper'

const THROTTLE_MS = 8

let cachedCanvasRect: { x: number; y: number; w: number; h: number; ts: number } | null = null

function getCanvasRect(canvas: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const now = performance.now()
  if (cachedCanvasRect && now - cachedCanvasRect.ts < 500) {
    return cachedCanvasRect
  }

  const rect = canvas.getBoundingClientRect()
  const cw = canvas.width
  const ch = canvas.height
  if (!cw || !ch) return null

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

  cachedCanvasRect = {
    x: rect.left + offsetX,
    y: rect.top + offsetY,
    w: renderW,
    h: renderH,
    ts: now,
  }

  return cachedCanvasRect
}

export function useInputRelay(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  resolution: Resolution = { width: 1280, height: 720 }
) {
  const lastMoveRef = useRef(0)
  const wsRef = useRef<ReturnType<typeof createWsClient> | null>(null)

  useEffect(() => {
    if (!active) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/input`

    const ws = createWsClient()
    wsRef.current = ws
    ws.connect(wsUrl)

    return () => {
      ws.disconnect()
      wsRef.current = null
    }
  }, [active])

  const send = useCallback((event: any) => {
    wsRef.current?.send(event)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    const canvas = canvasRef.current
    if (!el || !canvas || !active) return

    cachedCanvasRect = null

    const rw = resolution.width
    const rh = resolution.height

    function scaleCoords(e: MouseEvent): { x: number; y: number } | null {
      const cr = getCanvasRect(canvas!)
      if (!cr) return null

      const relX = e.clientX - cr.x
      const relY = e.clientY - cr.y

      if (relX < 0 || relY < 0 || relX > cr.w || relY > cr.h) return null

      return {
        x: (relX / cr.w * rw + 0.5) | 0,
        y: (relY / cr.h * rh + 0.5) | 0,
      }
    }

    const handleMouseMove = (e: MouseEvent) => {
      const now = performance.now()
      if (now - lastMoveRef.current < THROTTLE_MS) return
      lastMoveRef.current = now
      const coords = scaleCoords(e)
      if (coords) send({ type: 'mousemove', ...coords })
    }

    const handleMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      el.focus()
      const coords = scaleCoords(e)
      if (coords) send({ type: 'mousedown', ...coords, button: e.button })
    }

    const handleMouseUp = (e: MouseEvent) => {
      const coords = scaleCoords(e)
      if (coords) send({ type: 'mouseup', ...coords, button: e.button })
    }

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
    }

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const coords = scaleCoords(e)
      if (coords) send({ type: 'scroll', ...coords, deltaY: e.deltaY })
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      send(mapKeyDown(e))
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      send(mapKeyUp(e))
    }

    const onResize = () => { cachedCanvasRect = null }
    window.addEventListener('resize', onResize)

    el.addEventListener('mousemove', handleMouseMove)
    el.addEventListener('mousedown', handleMouseDown)
    el.addEventListener('mouseup', handleMouseUp)
    el.addEventListener('contextmenu', handleContextMenu)
    el.addEventListener('wheel', handleWheel, { passive: false })
    el.addEventListener('keydown', handleKeyDown)
    el.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('resize', onResize)
      el.removeEventListener('mousemove', handleMouseMove)
      el.removeEventListener('mousedown', handleMouseDown)
      el.removeEventListener('mouseup', handleMouseUp)
      el.removeEventListener('contextmenu', handleContextMenu)
      el.removeEventListener('wheel', handleWheel)
      el.removeEventListener('keydown', handleKeyDown)
      el.removeEventListener('keyup', handleKeyUp)
    }
  }, [containerRef, canvasRef, active, resolution, send])
}
