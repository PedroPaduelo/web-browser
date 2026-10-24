import { useEffect, useRef, useState, useCallback } from 'react'
import { authFetch } from '../lib/auth-client'

type RTCState = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed'

interface UseWebRTCResult {
  state: RTCState
  videoRef: React.RefObject<HTMLVideoElement | null>
  fps: number
  connect: () => void
  disconnect: () => void
}

// Reconexão com backoff exponencial + jitter e limite de tentativas
const MAX_RETRIES = 5
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 15000
const FETCH_TIMEOUT_MS = 8000
const CONNECT_TIMEOUT_MS = 5000
const ICE_GATHER_TIMEOUT_MS = 2000

// fetch de sinalização com timeout (evita hang eterno sem resposta)
async function fetchWithTimeout(url: string, options: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await authFetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function backoffDelay(attempt: number): number {
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
  return exp + Math.floor(Math.random() * 500) // jitter anti-thundering-herd
}

export function useWebRTC(active: boolean, sessionId: string | null): UseWebRTCResult {
  const [state, setState] = useState<RTCState>('idle')
  const [fps, setFps] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const peerIdRef = useRef<string | null>(null)
  const fpsCountRef = useRef(0)
  const fpsSmoothRef = useRef(0)
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null }
  }, [])

  const cleanupPeer = useCallback(async () => {
    if (fpsTimerRef.current) { clearInterval(fpsTimerRef.current); fpsTimerRef.current = null }
    const peerId = peerIdRef.current
    peerIdRef.current = null
    if (peerId && sessionId) {
      // fire-and-forget com timeout para não travar o disconnect
      fetchWithTimeout(`/api/webrtc/${sessionId}/peer/${peerId}`, { method: 'DELETE' }, 5000).catch(() => {})
    }
    if (pcRef.current) {
      try { pcRef.current.close() } catch {}
      pcRef.current = null
    }
  }, [sessionId])

  const disconnect = useCallback(() => {
    abortRef.current = true
    attemptRef.current = 0
    clearTimers()
    void cleanupPeer()

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    setState('closed')
    setFps(0)
    fpsSmoothRef.current = 0
  }, [clearTimers, cleanupPeer])

  const connect = useCallback(async () => {
    if (!sessionId || !active) return
    if (pcRef.current) return // já há tentativa/conexão em voo
    abortRef.current = false
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null }
    const attempt = attemptRef.current
    setState('connecting')

    const scheduleRetry = () => {
      if (abortRef.current) return
      if (attemptRef.current >= MAX_RETRIES) {
        setState('failed')
        return
      }
      attemptRef.current += 1
      const delay = backoffDelay(attemptRef.current)
      console.warn(`[WebRTC] retry ${attemptRef.current}/${MAX_RETRIES} in ${delay}ms`)
      retryTimerRef.current = setTimeout(() => {
        pcRef.current = null
        void connectRef.current()
      }, delay)
    }

    // Timeout de conexão: sem ICE connected/completed, falha p/ MJPEG fallback + retry
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      if (abortRef.current) return
      if (!pcRef.current) return
      const s = pcRef.current.iceConnectionState
      if (s !== 'connected' && s !== 'completed') {
        console.warn('[WebRTC] Connection timeout, falling back to MJPEG')
        void cleanupPeer()
        scheduleRetry()
      }
    }, CONNECT_TIMEOUT_MS)

    try {
      // 1. pedir offer ao servidor (com timeout)
      const offerRes = await fetchWithTimeout(`/api/webrtc/${sessionId}/offer`, { method: 'POST' }, FETCH_TIMEOUT_MS)
      if (!offerRes.ok) throw new Error(`Offer failed: ${offerRes.status}`)
      const { peerId, sdp, type, candidates } = await offerRes.json()

      if (abortRef.current) { if (timeoutRef.current) clearTimeout(timeoutRef.current); return }
      peerIdRef.current = peerId

      // 2. criar PeerConnection local
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      })
      pcRef.current = pc

      // 3. aplicar offer remota (do servidor)
      await pc.setRemoteDescription({ type, sdp })

      // 4. adicionar candidatos ICE do servidor
      if (Array.isArray(candidates)) {
        for (const c of candidates) {
          try { await pc.addIceCandidate(c) } catch {}
        }
      }

      // 5. track de vídeo → <video>
      pc.ontrack = (e) => {
        if (e.track.kind === 'video' && videoRef.current) {
          videoRef.current.srcObject = e.streams[0] || new MediaStream([e.track])
          videoRef.current.play().catch(() => {})

          // contar FPS via requestVideoFrameCallback se disponível
          const video = videoRef.current
          if ('requestVideoFrameCallback' in video) {
            let lastTs = 0
            const countFrame = (ts: number) => {
              if (ts !== lastTs) { fpsCountRef.current++; lastTs = ts }
              if (pcRef.current && !abortRef.current) (video as unknown as { requestVideoFrameCallback: (cb: (ts: number) => void) => void }).requestVideoFrameCallback(countFrame)
            }
            ;(video as unknown as { requestVideoFrameCallback: (cb: (ts: number) => void) => void }).requestVideoFrameCallback(countFrame)
          }
        }
      }

      // 6. criar answer local
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      // aguardar ICE gathering (com timeout e limpeza do listener)
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(); return }
        const check = () => {
          if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve() }
        }
        pc.addEventListener('icegatheringstatechange', check)
        setTimeout(() => { pc.removeEventListener('icegatheringstatechange', check); resolve() }, ICE_GATHER_TIMEOUT_MS)
      })

      if (abortRef.current) { if (timeoutRef.current) clearTimeout(timeoutRef.current); try { pc.close() } catch {}; return }

      // 7. enviar answer ao servidor (com timeout)
      const answerRes = await fetchWithTimeout(`/api/webrtc/${sessionId}/answer`, {
        method: 'POST',
        body: JSON.stringify({ peerId, sdp: pc.localDescription!.sdp }),
      }, FETCH_TIMEOUT_MS)
      if (!answerRes.ok) throw new Error(`Answer failed: ${answerRes.status}`)

      // FPS: média móvel (EMA α=0.3) sobre frames/seg
      if (fpsTimerRef.current) clearInterval(fpsTimerRef.current)
      fpsTimerRef.current = setInterval(() => {
        const inst = fpsCountRef.current
        fpsCountRef.current = 0
        const prev = fpsSmoothRef.current
        const next = prev === 0 ? inst : Math.round(prev * 0.7 + inst * 0.3)
        fpsSmoothRef.current = next
        setFps((cur) => cur !== next ? next : cur)
      }, 1000)

      // Sucesso/fracasso via estado ICE
      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState
        if (s === 'connected' || s === 'completed') {
          if (timeoutRef.current) clearTimeout(timeoutRef.current)
          attemptRef.current = 0 // reseta backoff após sucesso
          setState('connected')
        } else if (s === 'failed' || s === 'closed' || s === 'disconnected') {
          if (!abortRef.current) {
            void cleanupPeer()
            scheduleRetry()
          }
        }
      }

    } catch (err) {
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.warn(`[WebRTC] signaling timeout (attempt ${attempt + 1})`)
      } else {
        console.warn('[WebRTC] connect failed:', err)
      }
      if (!abortRef.current) {
        await cleanupPeer()
        scheduleRetry()
      }
    }
  }, [active, sessionId, cleanupPeer, clearTimers])

  const connectRef = useRef(connect)
  connectRef.current = connect

  useEffect(() => {
    if (!active || !sessionId) return
    attemptRef.current = 0
    void connectRef.current()
    return () => {
      abortRef.current = true
      clearTimers()
      if (fpsTimerRef.current) { clearInterval(fpsTimerRef.current); fpsTimerRef.current = null }
      const peerId = peerIdRef.current
      peerIdRef.current = null
      if (peerId && sessionId) {
        fetchWithTimeout(`/api/webrtc/${sessionId}/peer/${peerId}`, { method: 'DELETE' }, 5000).catch(() => {})
      }
      if (pcRef.current) {
        try { pcRef.current.close() } catch {}
        pcRef.current = null
      }
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [active, sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  return { state, videoRef, fps, connect, disconnect }
}
