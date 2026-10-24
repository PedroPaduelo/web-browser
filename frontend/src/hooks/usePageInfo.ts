import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '../components/AuthProvider'

interface PageInfo {
  url: string
  title: string
}

export function usePageInfo(sessionId: string | null) {
  const { token } = useAuth()
  const [pageInfo, setPageInfo] = useState<PageInfo>({ url: '', title: '' })
  const [loading, setLoading] = useState(false)
  // Último valor publicado. O poll de 3s quase sempre devolve o MESMO url:
  // sem comparar, cada poll criava um objeto novo e re-renderizava a árvore
  // inteira (App → BrowserViewer).
  const publishedRef = useRef<PageInfo>({ url: '', title: '' })

  const fetchPageInfo = useCallback(async (foreground = false) => {
    if (!sessionId || !token) return
    // Só o fetch explícito mexe em loading: o poll de fundo não pode gerar
    // re-render extra (setLoading(true/false) a cada 3s).
    if (foreground) setLoading(true)
    try {
      const res = await fetch(`/api/url/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      const next: PageInfo = { url: data.url || '', title: '' }
      const prev = publishedRef.current
      if (next.url !== prev.url || next.title !== prev.title) {
        publishedRef.current = next
        setPageInfo(next)
      }
    } catch (e) {
      console.error('Failed to fetch page info:', e)
    } finally {
      if (foreground) setLoading(false)
    }
  }, [sessionId, token])

  useEffect(() => {
    if (!sessionId) {
      const empty: PageInfo = { url: '', title: '' }
      publishedRef.current = empty
      setPageInfo((prev) => (prev.url === '' && prev.title === '' ? prev : empty))
      return
    }

    fetchPageInfo()
    const interval = setInterval(() => { void fetchPageInfo() }, 3000)
    return () => clearInterval(interval)
  }, [sessionId, fetchPageInfo])

  // refetch explícito (navegação): mostra loading.
  const refetch = useCallback(() => fetchPageInfo(true), [fetchPageInfo])

  // Objeto de retorno estável: não vira nova referência a cada render do App.
  return useMemo(() => ({ pageInfo, loading, refetch }), [pageInfo, loading, refetch])
}
