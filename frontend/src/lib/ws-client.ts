export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

type StateListener = (state: ConnectionState) => void

interface QueuedMsg {
  payload: string
  coalescable: boolean
}

const MAX_QUEUE = 300
const MAX_BUFFERED = 256 * 1024

function isCoalescable(data: any): boolean {
  const t = typeof data === 'object' && data !== null ? (data as any).type : undefined
  return t === 'mousemove' || t === 'scroll'
}

class WsClient {
  private ws: WebSocket | null = null
  private _state: ConnectionState = 'disconnected'
  private stateListeners: Set<StateListener> = new Set()
  private messageListeners: Set<(data: any) => void> = new Set()
  private binaryListeners: Set<(data: ArrayBuffer) => void> = new Set()
  private authFailListeners: Set<() => void> = new Set()
  private url = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private queue: QueuedMsg[] = []

  get state(): ConnectionState {
    return this._state
  }

  /** Mensagens aguardando envio (fila de backpressure). */
  get pendingCount(): number {
    return this.queue.length
  }

  private setState(state: ConnectionState) {
    this._state = state
    this.stateListeners.forEach(fn => fn(state))
  }

  onStateChange(fn: StateListener) {
    this.stateListeners.add(fn)
    return () => { this.stateListeners.delete(fn) }
  }

  onMessage(fn: (data: any) => void) {
    this.messageListeners.add(fn)
    return () => { this.messageListeners.delete(fn) }
  }

  onBinary(fn: (data: ArrayBuffer) => void) {
    this.binaryListeners.add(fn)
    return () => { this.binaryListeners.delete(fn) }
  }

  onAuthFail(fn: () => void) {
    this.authFailListeners.add(fn)
    return () => { this.authFailListeners.delete(fn) }
  }

  connect(url: string) {
    this.url = url
    this.reconnectAttempts = 0
    this._connect()
  }

  private _connect() {
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }

    this.setState('connecting')

    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      this.reconnectAttempts = 0
      this.setState('connected')
      this.flushQueue()
    }

    ws.onclose = (event) => {
      this.ws = null
      if (event.code === 4001) {
        this.setState('disconnected')
        this.authFailListeners.forEach(fn => fn())
        return
      }
      if (this._state !== 'disconnected') {
        this.tryReconnect()
      }
    }

    ws.onerror = () => {
      // onclose will fire after this
    }

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.binaryListeners.forEach(fn => fn(event.data))
      } else {
        try {
          const parsed = JSON.parse(event.data)
          this.messageListeners.forEach(fn => fn(parsed))
        } catch {}
      }
    }

    this.ws = ws
  }

  private tryReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setState('disconnected')
      return
    }
    this.setState('reconnecting')
    this.reconnectAttempts++
    const delay = Math.min(1000 * this.reconnectAttempts, 5000)
    this.reconnectTimer = setTimeout(() => this._connect(), delay)
  }

  private canSendDirect(): boolean {
    return (
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN &&
      this.queue.length === 0 &&
      this.ws.bufferedAmount < MAX_BUFFERED
    )
  }

  private enqueue(payload: string, coalescable: boolean) {
    if (this.queue.length >= MAX_QUEUE) {
      if (coalescable) {
        // Abre espaço descartando o coalescível mais antigo; se só há
        // eventos críticos, descarta o próprio entrante (nunca um key/click).
        const idx = this.queue.findIndex(m => m.coalescable)
        if (idx === -1) return false
        this.queue.splice(idx, 1)
      } else {
        // Evento crítico com fila cheia: evita perder tecla/clique,
        // sacrifica o coalescível mais antigo; sem nenhum, descarta o mais antigo.
        const idx = this.queue.findIndex(m => m.coalescable)
        this.queue.splice(idx === -1 ? 0 : idx, 1)
      }
    }
    this.queue.push({ payload, coalescable })
    return true
  }

  private flushQueue() {
    while (this.queue.length > 0) {
      const sock = this.ws
      if (!sock || sock.readyState !== WebSocket.OPEN) return
      if (sock.bufferedAmount >= MAX_BUFFERED) return
      const next = this.queue[0]
      try {
        sock.send(next.payload)
      } catch {
        return
      }
      this.queue.shift()
    }
  }

  send(data: any) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    const coalescable = isCoalescable(data)
    if (this.canSendDirect()) {
      try {
        this.ws!.send(payload)
        return true
      } catch {
        // cai para a fila
      }
    }
    const ok = this.enqueue(payload, coalescable)
    // Tenta drenar de imediato caso o socket tenha aberto entre as checagens.
    if (this.ws?.readyState === WebSocket.OPEN) this.flushQueue()
    return ok
  }

  disconnect() {
    this.setState('disconnected')
    this.queue = []
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
    this.messageListeners.clear()
    this.binaryListeners.clear()
    this.authFailListeners.clear()
  }
}

export function createWsClient() {
  return new WsClient()
}
