export interface InputEvent {
  type: string
  x?: number
  y?: number
  button?: number
  deltaX?: number
  deltaY?: number
  key?: string
  code?: string
  text?: string
  repeat?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  /** Largura REAL do frame pintado (canvas.width) — o servidor usa para escalar. */
  fw?: number
  /** Altura REAL do frame pintado (canvas.height) — o servidor usa para escalar. */
  fh?: number
  /** Bitmask de modificadores do mouse (CDP): Alt=1, Ctrl=2, Meta=4, Shift=8. */
  modifiers?: number
  /** Número de cliques (1, 2 = dblclick). */
  clickCount?: number
}

export interface Resolution {
  width: number
  height: number
}

export interface RenderedRect {
  x: number
  y: number
  w: number
  h: number
}

type RectLike = { left: number; top: number; width: number; height: number }

const LINE_PX = 16
const PAGE_PX = 800

/**
 * Área do canvas realmente pintada dentro do CSS box (object-fit: contain).
 * Divide o letterboxing (barras) para o clique não derivar para a borda.
 */
export function getRenderedRect(
  canvasWidth: number,
  canvasHeight: number,
  rect: RectLike,
): RenderedRect {
  if (!canvasWidth || !canvasHeight || !rect.width || !rect.height) {
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
  }
  const containerAspect = rect.width / rect.height
  const canvasAspect = canvasWidth / canvasHeight

  let renderW: number
  let renderH: number
  let offsetX: number
  let offsetY: number

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

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/**
 * clientX/clientY (CSS px) -> coordenadas remotas em FLOAT, sem arredondamento.
 * Lê getBoundingClientRect fresco a cada chamada (nada de cache defasado) e
 * desconta o letterbox. Retorna null quando o ponto cai fora da área pintada,
 * a menos que clampOutside=true (uso: mouseup fora do canvas ainda solta o botão).
 *
 * A base é o FRAME REAL (canvas.width/height), não a resolução nominal da
 * sessão: o frame pintado pode ter proporção diferente (ex.: 1279x663 num
 * --app de 1280x720). O servidor reescala de fw/fh para o viewport do Chrome.
 */
export function mapClientToRemote(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  resolution: Resolution,
  clampOutside = false,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect()
  const cw = canvas.width
  const ch = canvas.height
  if (!cw || !ch || !rect.width || !rect.height) return null

  const cr = getRenderedRect(cw, ch, rect)
  if (cr.w <= 0 || cr.h <= 0) return null

  const relX = clientX - cr.x
  const relY = clientY - cr.y

  if (!clampOutside && (relX < 0 || relY < 0 || relX > cr.w || relY > cr.h)) {
    return null
  }

  const fx = (clamp(relX, 0, cr.w) / cr.w) * cw
  const fy = (clamp(relY, 0, cr.h) / cr.h) * ch

  // Sem arredondamento prematuro: quem envia decide (Math.round + clamp final).
  return {
    x: clamp(fx, 0, cw - 1),
    y: clamp(fy, 0, ch - 1),
  }
}

/** Arredonda no envio: inteiro dentro de [0, dim-1]. */
export function toRemoteInt(v: number, dim: number): number {
  return clamp(Math.round(v), 0, Math.max(0, dim - 1))
}

/** Bitmask de modificadores do mouse no CDP: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export const MOD_ALT = 1
export const MOD_CTRL = 2
export const MOD_META = 4
export const MOD_SHIFT = 8

/**
 * Modificadores do mouse como bitmask do CDP.
 * Sem isso, ctrl+click chegava no Chrome sem o ctrl (medido: DOM via
 * ctrlKey:false) — mousedown/mouseup/wheel não mandavam modificador nenhum.
 */
export function mouseModifiers(e: MouseEvent | WheelEvent): number {
  let m = 0
  if (e.altKey) m |= MOD_ALT
  if (e.ctrlKey) m |= MOD_CTRL
  if (e.metaKey) m |= MOD_META
  if (e.shiftKey) m |= MOD_SHIFT
  return m
}

function scaleCoords(e: MouseEvent, rect: DOMRect, resolution: Resolution) {
  const scaleX = resolution.width / rect.width
  const scaleY = resolution.height / rect.height
  return {
    x: toRemoteInt((e.clientX - rect.left) * scaleX, resolution.width),
    y: toRemoteInt((e.clientY - rect.top) * scaleY, resolution.height),
  }
}

export function mapMouseMove(e: MouseEvent, rect: DOMRect, resolution: Resolution): InputEvent {
  const { x, y } = scaleCoords(e, rect, resolution)
  return { type: 'mousemove', x, y }
}

export function mapClick(e: MouseEvent, rect: DOMRect, resolution: Resolution): InputEvent {
  const { x, y } = scaleCoords(e, rect, resolution)
  return { type: 'click', x, y, button: e.button }
}

/** Normaliza deltaMode (pixel/linha/página) para pixels. */
export function normalizeWheel(e: WheelEvent): { deltaX: number; deltaY: number } {
  let { deltaX, deltaY, deltaMode } = e
  if (deltaMode === 1) {
    deltaX *= LINE_PX
    deltaY *= LINE_PX
  } else if (deltaMode === 2) {
    deltaX *= PAGE_PX
    deltaY *= PAGE_PX
  }
  return { deltaX, deltaY }
}

export function mapScroll(e: WheelEvent, rect: DOMRect, resolution: Resolution): InputEvent {
  const { x, y } = scaleCoords(e, rect, resolution)
  const { deltaX, deltaY } = normalizeWheel(e)
  return { type: 'scroll', x, y, deltaX, deltaY }
}

/** Mapeia wheel direto do canvas (desconta letterbox, normaliza deltaMode). */
export function mapWheel(
  e: WheelEvent,
  canvas: HTMLCanvasElement,
  resolution: Resolution,
): InputEvent | null {
  const p = mapClientToRemote(e.clientX, e.clientY, canvas, resolution)
  if (!p) return null
  const { deltaX, deltaY } = normalizeWheel(e)
  return {
    type: 'scroll',
    x: toRemoteInt(p.x, canvas.width),
    y: toRemoteInt(p.y, canvas.height),
    deltaX,
    deltaY,
    // Modificadores no wheel: ctrl+wheel = zoom no Chrome.
    modifiers: mouseModifiers(e),
    fw: canvas.width,
    fh: canvas.height,
  }
}

function keyText(e: KeyboardEvent): string | undefined {
  if (e.key && e.key.length === 1) return e.key
  if (e.key === 'Enter') return '\r'
  if (e.key === 'Tab') return '\t'
  return undefined
}

function withModifiers(e: KeyboardEvent) {
  return {
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  }
}

export function mapKeyDown(e: KeyboardEvent): InputEvent {
  const text = keyText(e)
  return {
    type: 'keydown',
    key: e.key,
    code: e.code,
    ...(text !== undefined ? { text } : {}),
    repeat: e.repeat,
    ...withModifiers(e),
  }
}

export function mapKeyUp(e: KeyboardEvent): InputEvent {
  return {
    type: 'keyup',
    key: e.key,
    code: e.code,
    ...withModifiers(e),
  }
}

/** Teclas que precisam de preventDefault no viewer (foco, Tab, scroll via espaço). */
export function shouldPreventDefaultKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  const k = e.key
  if (
    k === 'Tab' ||
    k === 'Enter' ||
    k === 'Escape' ||
    k === ' ' ||
    k === 'Backspace' ||
    k === 'Delete'
  ) {
    return true
  }
  if (k === 'F5' || k === 'F11' || /^F\d{1,2}$/.test(k) || k.startsWith('Arrow')) return true
  if (k.length === 1) return true
  return false
}
