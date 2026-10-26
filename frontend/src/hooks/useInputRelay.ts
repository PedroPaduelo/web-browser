import { useEffect, useRef, useCallback } from 'react'
import { createWsClient } from '../lib/ws-client'
import {
  mapClientToRemote,
  mapKeyDown,
  mapKeyUp,
  mapWheel,
  mouseModifiers,
  shouldPreventDefaultKey,
  toRemoteInt,
  Resolution,
} from '../lib/input-mapper'
import { getAuthWsUrl } from '../lib/auth-client'

type CoalescedSource = { getCoalescedEvents?: () => Array<{ clientX: number; clientY: number }> }

export function useInputRelay(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  resolution: Resolution = { width: 1440, height: 900 },
  sessionId: string | null = null
) {
  const pendingMovesRef = useRef<Array<{ x: number; y: number }>>([])
  const rafRef = useRef(0)
  const wsRef = useRef<ReturnType<typeof createWsClient> | null>(null)

  useEffect(() => {
    if (!active || !sessionId) return

    const wsUrl = getAuthWsUrl('/ws/input', sessionId)
    const ws = createWsClient()
    wsRef.current = ws
    ws.connect(wsUrl)

    return () => {
      ws.disconnect()
      wsRef.current = null
    }
  }, [active, sessionId])

  const send = useCallback((event: any) => {
    wsRef.current?.send(event)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    const canvas = canvasRef.current
    if (!el || !canvas || !active) return

    const rw = resolution.width
    const rh = resolution.height

    // Tamanho REAL do frame pintado (canvas.width/height). É a base da
    // escala: o servidor converte fw/fh -> viewport do Chrome (B1).
    const frameSize = () => {
      const c = canvasRef.current
      const fw = c && c.width > 0 ? c.width : rw
      const fh = c && c.height > 0 ? c.height : rh
      return { fw, fh }
    }

    const flushMoves = () => {
      rafRef.current = 0
      const batch = pendingMovesRef.current
      pendingMovesRef.current = []
      if (batch.length === 0) return
      // Só o ÚLTIMO ponto: o coalesce de verdade acontece no servidor
      // (setImmediate, ~2µs). Aqui mandar N mensagens enchia a fila do CDP
      // e atrasava a tecla seguinte em 252ms (medido com 300 mousemove).
      const last = batch[batch.length - 1]
      const { fw, fh } = frameSize()
      send({ type: 'mousemove', x: last.x, y: last.y, fw, fh })
    }

    const scheduleFlush = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flushMoves)
    }

    const pushMove = (clientX: number, clientY: number) => {
      const target = canvasRef.current
      if (!target) return
      // Mapeamento preciso: rect fresco + escala real, float até o envio.
      const p = mapClientToRemote(clientX, clientY, target, { width: rw, height: rh })
      if (!p) return
      pendingMovesRef.current.push({
        x: toRemoteInt(p.x, target.width),
        y: toRemoteInt(p.y, target.height),
      })
      if (pendingMovesRef.current.length > 32) {
        pendingMovesRef.current.splice(0, pendingMovesRef.current.length - 32)
      }
      scheduleFlush()
    }

    function coordsOf(e: MouseEvent, clampOutside = false): { x: number; y: number } | null {
      const target = canvasRef.current
      if (!target) return null
      const p = mapClientToRemote(e.clientX, e.clientY, target, { width: rw, height: rh }, clampOutside)
      if (!p) return null
      return { x: toRemoteInt(p.x, target.width), y: toRemoteInt(p.y, target.height) }
    }

    const handleMouseMove = (e: MouseEvent) => {
      // Eventos coalescidos preservam o trajeto em 120Hz+ sem inundar o WS;
      // o rAF limita o envio a 1 lote por frame.
      const src = e as MouseEvent & CoalescedSource
      const list = typeof src.getCoalescedEvents === 'function' ? src.getCoalescedEvents() : [e]
      const events = list.length > 0 ? list : [e]
      for (const ev of events) pushMove(ev.clientX, ev.clientY)
    }

    const handleMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      // Evita perda de foco: o canvas precisa segurar o foco p/ o teclado.
      el.focus({ preventScroll: true })
      const coords = coordsOf(e)
      if (!coords) return
      const { fw, fh } = frameSize()
      const modifiers = mouseModifiers(e)
      // ORDEM: mousemove ANTES do mousedown. O move atrasado para o próximo
      // rAF chegava DEPOIS do press/release (medido: press -> release -> move),
      // então o :hover não era aplicado no momento do clique.
      send({ type: 'mousemove', x: coords.x, y: coords.y, fw, fh, modifiers })
      send({
        type: 'mousedown',
        ...coords,
        button: e.button,
        modifiers,
        clickCount: e.detail >= 2 ? 2 : 1,
        fw,
        fh,
      })
    }

    const handleMouseUp = (e: MouseEvent) => {
      // Clamp: soltar fora do canvas ainda libera o botão (evita drag preso).
      const coords = coordsOf(e, true)
      if (!coords) return
      const { fw, fh } = frameSize()
      const modifiers = mouseModifiers(e)
      const clickCount = e.detail >= 2 ? 2 : 1
      send({
        type: 'mouseup',
        ...coords,
        button: e.button,
        modifiers,
        clickCount,
        fw,
        fh,
      })
      // dblclick: o Chrome só monta detail=2 quando recebe o par com
      // clickCount 2 — e o frontend não mandava 'dblclick' nenhum.
      if (e.detail === 2) {
        send({ type: 'dblclick', ...coords, button: e.button, modifiers, fw, fh })
      }
    }

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
    }

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const target = canvasRef.current
      if (!target) return
      // DeltaMode normalizado (linha/página -> px) + deltaX junto.
      const mapped = mapWheel(e, target, { width: rw, height: rh })
      if (mapped) send(mapped)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Tab/Enter/Escape/modificadores: não deixa o foco escapar nem o
      // navegador sequestrar o atalho; repeat viaja junto (key repeat).
      if (shouldPreventDefaultKey(e)) e.preventDefault()
      send(mapKeyDown(e))
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      send(mapKeyUp(e))
    }

    const handleBlur = () => {
      // Recupera o foco quando ele cai no vazio (body); respeita quando o
      // usuário foi para um campo de verdade (toolbar input, select...).
      requestAnimationFrame(() => {
        const ae = document.activeElement
        if (ae === document.body || ae === null) el.focus({ preventScroll: true })
      })
    }

    const refocusViewer = () => el.focus({ preventScroll: true })
    window.addEventListener('serende:refocus-viewer', refocusViewer)

    // Garante foco ao ativar (teclado funciona sem o primeiro clique).
    el.focus({ preventScroll: true })

    el.addEventListener('mousemove', handleMouseMove)
    el.addEventListener('mousedown', handleMouseDown)
    el.addEventListener('mouseup', handleMouseUp)
    el.addEventListener('contextmenu', handleContextMenu)
    el.addEventListener('wheel', handleWheel, { passive: false })
    el.addEventListener('keydown', handleKeyDown)
    el.addEventListener('keyup', handleKeyUp)
    el.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('serende:refocus-viewer', refocusViewer)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      pendingMovesRef.current = []
      el.removeEventListener('mousemove', handleMouseMove)
      el.removeEventListener('mousedown', handleMouseDown)
      el.removeEventListener('mouseup', handleMouseUp)
      el.removeEventListener('contextmenu', handleContextMenu)
      el.removeEventListener('wheel', handleWheel)
      el.removeEventListener('keydown', handleKeyDown)
      el.removeEventListener('keyup', handleKeyUp)
      el.removeEventListener('blur', handleBlur)
    }
  }, [containerRef, canvasRef, active, resolution, send])
}
