export interface InputEvent {
  type: string
  x?: number
  y?: number
  button?: number
  deltaY?: number
  key?: string
  code?: string
  text?: string
}

export interface Resolution {
  width: number
  height: number
}

function scaleCoords(e: MouseEvent, rect: DOMRect, resolution: Resolution) {
  const scaleX = resolution.width / rect.width
  const scaleY = resolution.height / rect.height
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY),
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

export function mapScroll(e: WheelEvent, rect: DOMRect, resolution: Resolution): InputEvent {
  const { x, y } = scaleCoords(e, rect, resolution)
  return { type: 'scroll', x, y, deltaY: e.deltaY }
}

export function mapKeyDown(e: KeyboardEvent): InputEvent {
  return { type: 'keydown', key: e.key, code: e.code }
}

export function mapKeyUp(e: KeyboardEvent): InputEvent {
  return { type: 'keyup', key: e.key, code: e.code }
}
