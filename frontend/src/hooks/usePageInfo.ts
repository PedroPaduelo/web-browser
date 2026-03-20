import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../components/AuthProvider'

interface PageInfo {
  url: string
  title: string
}

export function usePageInfo(sessionId: string | null) {
  const { token } = useAuth()
  const [pageInfo, setPageInfo] = useState<PageInfo>({ url: '', title: '' })
  const [loading, setLoading] = useState(false)

  const fetchPageInfo = useCallback(async () => {
    if (!sessionId || !token) return
    setLoading(true)
    try {
      const res = await fetch(`/api/url/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      setPageInfo({ url: data.url || '', title: '' })
    } catch (e) {
      console.error('Failed to fetch page info:', e)
    } finally {
      setLoading(false)
    }
  }, [sessionId, token])

  useEffect(() => {
    if (!sessionId) {
      setPageInfo({ url: '', title: '' })
      return
    }

    fetchPageInfo()
    const interval = setInterval(fetchPageInfo, 3000)
    return () => clearInterval(interval)
  }, [sessionId, fetchPageInfo])

  return { pageInfo, loading, refetch: fetchPageInfo }
}
