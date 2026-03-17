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

export function useWebRTC(active: boolean, sessionId: string | null): UseWebRTCResult {
  const [state, setState] = useState<RTCState>('idle')
  const [fps, setFps] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const peerIdRef = useRef<string | null>(null)
  const fpsCountRef = useRef(0)
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef(false)

  const disconnect = useCallback(() => {
    abortRef.current = true
    if (fpsTimerRef.current) clearInterval(fpsTimerRef.current)

    if (peerIdRef.current && sessionId) {
      authFetch(`/api/webrtc/${sessionId}/peer/${peerIdRef.current}`, {
        method: 'DELETE',
      }).catch(() => {})
      peerIdRef.current = null
    }

    if (pcRef.current) {
      try { pcRef.current.close() } catch {}
      pcRef.current = null
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    setState('closed')
    setFps(0)
  }, [sessionId])

  const connect = useCallback(async () => {
    if (!sessionId || !active) return
    abortRef.current = false
    setState('connecting')

    try {
      // 1. pedir offer ao servidor
      const offerRes = await authFetch(`/api/webrtc/${sessionId}/offer`, { method: 'POST' })
      if (!offerRes.ok) throw new Error(`Offer failed: ${offerRes.status}`)
      const { peerId, sdp, type, candidates } = await offerRes.json()

      if (abortRef.current) return
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
              if (pcRef.current) (video as any).requestVideoFrameCallback(countFrame)
            }
            ;(video as any).requestVideoFrameCallback(countFrame)
          }
        }
      }

      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState
        if (s === 'connected' || s === 'completed') {
          setState('connected')
        } else if (s === 'failed' || s === 'closed' || s === 'disconnected') {
          setState('failed')
        }
      }

      // 6. criar answer local
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      // aguardar ICE gathering
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(); return }
        const check = () => {
          if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve() }
        }
        pc.addEventListener('icegatheringstatechange', check)
        setTimeout(resolve, 2000) // timeout 2s
      })

      if (abortRef.current) { try { pc.close() } catch {}; return }

      // 7. enviar answer ao servidor
      const answerRes = await authFetch(`/api/webrtc/${sessionId}/answer`, {
        method: 'POST',
        body: JSON.stringify({ peerId, sdp: pc.localDescription!.sdp }),
      })
      if (!answerRes.ok) throw new Error(`Answer failed: ${answerRes.status}`)

      // FPS counter
      fpsTimerRef.current = setInterval(() => {
        setFps(fpsCountRef.current)
        fpsCountRef.current = 0
      }, 1000)

    } catch (err) {
      console.warn('[WebRTC] connect failed:', err)
      if (!abortRef.current) setState('failed')
    }
  }, [active, sessionId])

  useEffect(() => {
    if (!active || !sessionId) return
    connect()
    return () => disconnect()
  }, [active, sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  return { state, videoRef, fps, connect, disconnect }
}
