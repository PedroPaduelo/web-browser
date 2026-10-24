import { useState, useEffect, useRef, useCallback } from 'react'
import { createWsClient } from '../lib/ws-client'

const SAMPLE_RATE = 24000
// Backlog máximo antes de descartar áudio obsoleto (evita latência crescente)
const MAX_BACKLOG_SEC = 0.5
// Chunk absurdo (>5s) é descartado para evitar OOM no AudioBuffer
const MAX_CHUNK_SAMPLES = SAMPLE_RATE * 5

interface AudioState {
  isConnected: boolean
  isMuted: boolean
}

export function useAudio(active: boolean) {
  const [state, setState] = useState<AudioState>({
    isConnected: false,
    isMuted: false,
  })

  const wsRef = useRef<ReturnType<typeof createWsClient> | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const nextPlayTimeRef = useRef(0)

  const playPcmChunk = useCallback((data: ArrayBuffer) => {
    const ctx = audioCtxRef.current
    if (!ctx || ctx.state === 'closed') return

    if (ctx.state === 'suspended') {
      void ctx.resume()
    }

    // View zero-copy sobre o ArrayBuffer (binaryType='arraybuffer', sem cópias)
    if (data.byteLength === 0 || data.byteLength % 2 !== 0) return
    const int16 = new Int16Array(data)
    const numSamples = int16.length
    if (numSamples === 0 || numSamples > MAX_CHUNK_SAMPLES) return

    const audioBuffer = ctx.createBuffer(1, numSamples, SAMPLE_RATE)
    const channelData = audioBuffer.getChannelData(0)
    for (let i = 0; i < numSamples; i++) {
      channelData[i] = int16[i] / 32768
    }

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer

    if (gainRef.current) {
      source.connect(gainRef.current)
    } else {
      source.connect(ctx.destination)
    }

    // Descarta backlog obsoleto: se atrasou ou acumulou demais, reancora no agora
    const now = ctx.currentTime
    if (nextPlayTimeRef.current < now || nextPlayTimeRef.current - now > MAX_BACKLOG_SEC) {
      nextPlayTimeRef.current = now + 0.02
    }
    source.start(nextPlayTimeRef.current)
    nextPlayTimeRef.current += audioBuffer.duration
  }, [])

  useEffect(() => {
    if (!active) return

    let cancelled = false
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/audio`

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    audioCtxRef.current = ctx
    nextPlayTimeRef.current = 0

    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    gainRef.current = gain

    const ws = createWsClient()
    wsRef.current = ws

    ws.onStateChange((s) => {
      if (cancelled) return
      setState(prev => ({ ...prev, isConnected: s === 'connected' }))
    })

    ws.onBinary((data) => {
      if (cancelled) return
      playPcmChunk(data)
    })

    ws.connect(wsUrl)

    return () => {
      cancelled = true
      ws.disconnect()
      wsRef.current = null
      nextPlayTimeRef.current = 0
      try { void ctx.close() } catch {}
      audioCtxRef.current = null
      gainRef.current = null
    }
  }, [active, playPcmChunk])

  const toggleMute = useCallback(() => {
    setState(prev => {
      const newMuted = !prev.isMuted
      const ctx = audioCtxRef.current
      if (gainRef.current && ctx) {
        // Transição suave evita cliques no áudio
        gainRef.current.gain.setTargetAtTime(newMuted ? 0 : 1, ctx.currentTime, 0.02)
      } else if (gainRef.current) {
        gainRef.current.gain.value = newMuted ? 0 : 1
      }
      return { ...prev, isMuted: newMuted }
    })
  }, [])

  const resumeAudio = useCallback(() => {
    const ctx = audioCtxRef.current
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume()
    }
  }, [])

  return { ...state, toggleMute, resumeAudio }
}
