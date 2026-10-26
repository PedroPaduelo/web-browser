import { useRef, useEffect, useCallback, useMemo, memo } from 'react'
import { useInputRelay } from '../hooks/useInputRelay'
import { getRenderedRect } from '../lib/input-mapper'

interface Props {
  setCanvas: (canvas: HTMLCanvasElement | null) => void
  resolution?: { width: number; height: number }
  sessionId: string | null
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    t.isContentEditable
  )
}

// Rects do canvas/container em cache. Mouse move a 120Hz+ não pode pagar
// getBoundingClientRect (layout forçado) duas vezes por evento.
interface RectCache {
  canvasLeft: number
  canvasTop: number
  canvasWidth: number
  canvasHeight: number
  containerLeft: number
  containerTop: number
}

const DEFAULT_RESOLUTION = { width: 1920, height: 1080 }

function BrowserViewer({ setCanvas, resolution = DEFAULT_RESOLUTION, sessionId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Cursor overlay: posicionado por style direto (sem setState por mousemove).
  const cursorRef = useRef<SVGSVGElement>(null)
  const rectsRef = useRef<RectCache | null>(null)
  const rectsDirtyRef = useRef(true)
  // Referência estável de resolution: o App cria um objeto novo a cada
  // render, o que quebraria o memo e reconectaria o WS de input.
  const stableResolution = useMemo(
    () => ({ width: resolution.width, height: resolution.height }),
    [resolution.width, resolution.height],
  )

  useInputRelay(canvasRef, containerRef, true, stableResolution, sessionId)

  useEffect(() => {
    setCanvas(canvasRef.current)
  }, [setCanvas])

  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true })
  }, [sessionId])

  // Cache de layout: só invalidado em resize/scroll, nunca por mousemove.
  const refreshRects = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) {
      rectsRef.current = null
      return
    }
    const c = canvas.getBoundingClientRect()
    const r = container.getBoundingClientRect()
    rectsRef.current = {
      canvasLeft: c.left,
      canvasTop: c.top,
      canvasWidth: c.width,
      canvasHeight: c.height,
      containerLeft: r.left,
      containerTop: r.top,
    }
    rectsDirtyRef.current = false
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const invalidate = () => { rectsDirtyRef.current = true }
    window.addEventListener('resize', invalidate)
    // capture: true pega scroll de qualquer ancestral, não só da janela.
    window.addEventListener('scroll', invalidate, true)
    const ro = new ResizeObserver(invalidate)
    ro.observe(container)
    if (canvasRef.current) ro.observe(canvasRef.current)
    return () => {
      window.removeEventListener('resize', invalidate)
      window.removeEventListener('scroll', invalidate, true)
      ro.disconnect()
    }
  }, [sessionId])

  // Posiciona o cursor sem re-render do React: transform (compositor) em vez
  // de left/top, e visibility em vez de montar/desmontar o SVG.
  const updateCursor = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    const container = containerRef.current
    const cursor = cursorRef.current
    if (!canvas || !container || !cursor) return
    if (rectsDirtyRef.current) refreshRects()
    const rects = rectsRef.current
    if (!rects) return
    // Cursor overlay alinhado à área pintada: fora do canvas renderizado,
    // esconde (evita cursor fantasma sobre as barras de letterbox).
    const cr = getRenderedRect(canvas.width, canvas.height, {
      left: rects.canvasLeft,
      top: rects.canvasTop,
      width: rects.canvasWidth,
      height: rects.canvasHeight,
    })
    const inside =
      clientX >= cr.x && clientX <= cr.x + cr.w &&
      clientY >= cr.y && clientY <= cr.y + cr.h
    if (!inside) {
      if (cursor.style.visibility !== 'hidden') cursor.style.visibility = 'hidden'
      return
    }
    const x = clientX - rects.containerLeft - 1
    const y = clientY - rects.containerTop - 1
    cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`
    if (cursor.style.visibility !== 'visible') cursor.style.visibility = 'visible'
  }, [refreshRects])

  const focusContainer = useCallback(() => {
    containerRef.current?.focus({ preventScroll: true })
  }, [])

  const handleBlur = useCallback((e: React.FocusEvent) => {
    // Perda de foco: volta para o viewer, exceto quando o destino é um
    // campo editável (ex.: barra de URL da toolbar).
    if (isEditableTarget(e.relatedTarget)) return
    requestAnimationFrame(() => {
      const ae = document.activeElement
      if (ae === document.body || ae === null) focusContainer()
    })
  }, [focusContainer])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Clique no viewer retoma o foco sem deixar o navegador roubar (Tab-safe).
    e.preventDefault()
    focusContainer()
  }, [focusContainer])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    updateCursor(e.clientX, e.clientY)
  }, [updateCursor])

  const handleMouseLeave = useCallback(() => {
    const cursor = cursorRef.current
    if (cursor) cursor.style.visibility = 'hidden'
  }, [])

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    updateCursor(e.clientX, e.clientY)
  }, [updateCursor])

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      data-viewer-container="true"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
      onMouseDown={handleMouseDown}
      onBlur={handleBlur}
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

      {/* Software cursor overlay — resposta visual instantânea, sem re-render.
          Posição via transform (compositor) e borda em vez de drop-shadow
          (filtro caro repintado a cada mousemove). */}
      <svg
        ref={cursorRef}
        width="20"
        height="20"
        viewBox="0 0 20 20"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          pointerEvents: 'none',
          willChange: 'transform',
          visibility: 'hidden',
          zIndex: 10,
        }}
      >
        <path
          d="M2 2 L2 14 L5.5 10.5 L8 16 L10 15 L7.5 9.5 L12 9.5 Z"
          fill="white"
          stroke="black"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

// memo: as props do viewer (setCanvas, resolution, sessionId) são estáveis,
// então re-render do App (fps/URL) não precisa repintar o viewer.
// O comparator compara a resolução por VALOR: o App cria um objeto novo
// (`sessionInfo?.resolution || { width, height }`) a cada render, e a
// comparação por referência do memo deixaria o viewer sempre reprocessado.
function arePropsEqual(prev: Props, next: Props): boolean {
  if (prev.setCanvas !== next.setCanvas) return false
  if (prev.sessionId !== next.sessionId) return false
  const a = prev.resolution ?? DEFAULT_RESOLUTION
  const b = next.resolution ?? DEFAULT_RESOLUTION
  return a.width === b.width && a.height === b.height
}

export default memo(BrowserViewer, arePropsEqual)
