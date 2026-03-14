export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

type StateListener = (state: ConnectionState) => void

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

  get state(): ConnectionState {
    return this._state
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

  send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data))
    }
  }

  disconnect() {
    this.setState('disconnected')
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
