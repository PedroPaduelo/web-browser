/**
 * Cliente de API do Serende.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * --------------------------
 * O frontend mostrava "Erro do servidor (HTTP 500)" quando o backend morria.
 * O proxy do Vite (frontend/vite.config.ts) encaminha /api para o backend na
 * porta 4201; com o backend fora, o proxy responde 500 com o CORPO VAZIO.
 * Isso é indistinguível, do lado do cliente, de um 500 real da aplicação
 * (que responde JSON { error: "..." }).
 *
 * Aqui a distinção é feita pelo corpo da resposta e pelo tipo de falha:
 *  - falha de rede (fetch rejeita)      => backend fora / reiniciando;
 *  - 5xx com corpo vazio                => backend fora / reiniciando;
 *  - 5xx com corpo JSON { error }       => erro real do servidor;
 *  - 502 / 503 / 504                    => backend fora / reiniciando.
 *
 * E o retry com backoff: o watchdog reinicia o backend em ~1-8s, então
 * repetir algumas vezes durante a janela de reinício evita mostrar erro
 * ao usuário por um problema que se resolve sozinho.
 */

/** Erro de aplicação — o backend respondeu com um erro real (4xx/5xx com JSON). */
export class ApiError extends Error {
  status: number
  payload: any

  constructor(message: string, status: number, payload: any = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

/**
 * Erro de indisponibilidade — o backend não respondeu de forma utilizável.
 * `retryable` marca que uma nova tentativa pode resolver.
 */
export class BackendUnavailableError extends Error {
  status: number
  retryable: boolean

  constructor(message: string, status = 0, retryable = true) {
    super(message)
    this.name = 'BackendUnavailableError'
    this.status = status
    this.retryable = retryable
  }
}

export const BACKEND_UNAVAILABLE_MESSAGE =
  'Servidor de sessões indisponível. Tentando reconectar...'

export const BACKEND_UNAVAILABLE_FINAL_MESSAGE =
  'Servidor de sessões indisponível. Verifique se o backend está rodando e tente novamente.'

/** Status que indicam que o backend não está servindo (e não um erro dele). */
const UNAVAILABLE_STATUSES = new Set([502, 503, 504])

/** Quantas vezes repetir por padrão. */
const DEFAULT_RETRIES = 3
/** Espera base do backoff (ms). */
const DEFAULT_BACKOFF_MS = 500
/** Timeout padrão de uma requisição (ms). */
export const DEFAULT_TIMEOUT_MS = 15000

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Delay do backoff exponencial com jitter.
 * Sem jitter, várias requisições que falharam juntas voltariam no mesmo
 * instante e voltariam a derrubar o backend junto.
 */
export function backoffDelay(attempt: number, baseMs = DEFAULT_BACKOFF_MS): number {
  const exponential = baseMs * Math.pow(2, attempt)
  const jitter = Math.floor(Math.random() * baseMs)
  return exponential + jitter
}

/**
 * Decide se a resposta indica backend indisponível.
 *
 * O proxy do Vite, com o backend fora, devolve 500 e corpo vazio — essa é a
 * assinatura do problema. Um 500 real da aplicação Express vem com JSON.
 */
export function isUnavailableResponse(status: number, bodyText: string): boolean {
  if (UNAVAILABLE_STATUSES.has(status)) return true
  if (status >= 500) {
    // Corpo vazio (ou não-JSON) => o proxy falhou, não a aplicação.
    const trimmed = (bodyText || '').trim()
    if (trimmed === '') return true
    try {
      const parsed = JSON.parse(trimmed)
      // JSON sem campo `error` também não veio do error handler do Express.
      return !parsed || typeof parsed !== 'object' || !('error' in parsed)
    } catch {
      return true
    }
  }
  return false
}

export interface ApiRequestOptions extends RequestInit {
  /** Quantas tentativas extras após a primeira. Padrão: 3. */
  retries?: number
  /** Espera base do backoff em ms. Padrão: 500. */
  backoffMs?: number
  /** Timeout da requisição em ms. Padrão: 15000. */
  timeoutMs?: number
  /** Chamado quando uma tentativa falha e haverá nova tentativa. */
  onRetry?: (attempt: number, error: Error, waitMs: number) => void
  /** Quando true, erros 4xx não são repetidos (padrão: true). */
  retryOnClientError?: boolean
}

/**
 * Fetch com timeout, retry com backoff e detecção de backend indisponível.
 *
 * Lança `BackendUnavailableError` quando o backend não está servindo e
 * `ApiError` quando o backend respondeu com um erro real.
 */
export async function apiFetch(
  url: string,
  options: ApiRequestOptions = {}
): Promise<Response> {
  const {
    retries = DEFAULT_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onRetry,
    retryOnClientError = true,
    ...fetchOptions
  } = options

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(url, { ...fetchOptions, signal: controller.signal })

      if (res.ok) {
        clearTimeout(timer)
        return res
      }

      // Lê o corpo uma vez: precisamos dele para decidir e para a mensagem.
      const bodyText = await res.text().catch(() => '')

      if (isUnavailableResponse(res.status, bodyText)) {
        clearTimeout(timer)
        lastError = new BackendUnavailableError(
          res.status ? `Backend indisponível (HTTP ${res.status})` : 'Backend indisponível',
          res.status
        )
        // 5xx do proxy: repetir faz sentido (o watchdog pode estar subindo).
        if (attempt < retries) {
          const waitMs = backoffDelay(attempt, backoffMs)
          onRetry?.(attempt + 1, lastError, waitMs)
          await sleep(waitMs)
          continue
        }
        throw lastError
      }

      clearTimeout(timer)

      // Erro real do servidor (ou 4xx): parseia o JSON para a mensagem.
      let payload: any = null
      try {
        payload = bodyText ? JSON.parse(bodyText) : null
      } catch {
        payload = null
      }

      const message = payload?.error || `Erro do servidor (HTTP ${res.status})`
      const error = new ApiError(message, res.status, payload)

      // 4xx não é transitório: repetir não muda o resultado.
      const isClientError = res.status >= 400 && res.status < 500
      if (isClientError && !retryOnClientError) throw error
      if (isClientError) throw error

      lastError = error
      if (attempt < retries) {
        const waitMs = backoffDelay(attempt, backoffMs)
        onRetry?.(attempt + 1, error, waitMs)
        await sleep(waitMs)
        continue
      }
      throw error
    } catch (err: any) {
      clearTimeout(timer)

      // Erros que já são nossos (ApiError / BackendUnavailableError) foram
      // tratados acima e não devem ser reembrulhados.
      if (err instanceof ApiError || err instanceof BackendUnavailableError) {
        if (err instanceof BackendUnavailableError && attempt < retries) {
          const waitMs = backoffDelay(attempt, backoffMs)
          onRetry?.(attempt + 1, err, waitMs)
          await sleep(waitMs)
          continue
        }
        throw err
      }

      // Abort (timeout) ou falha de rede (fetch rejeita).
      const isAbort = err?.name === 'AbortError'
      lastError = new BackendUnavailableError(
        isAbort
          ? `Tempo esgotado (${timeoutMs}ms) aguardando o servidor`
          : 'Não foi possível conectar ao servidor',
        0
      )

      if (attempt < retries) {
        const waitMs = backoffDelay(attempt, backoffMs)
        onRetry?.(attempt + 1, lastError, waitMs)
        await sleep(waitMs)
        continue
      }
      throw lastError
    }
  }

  throw lastError || new BackendUnavailableError('Backend indisponível')
}

/**
 * Extrai uma mensagem legível de qualquer erro vindo do `apiFetch`.
 * Usado pelas telas para não repetir a lógica de "isto é indisponível?".
 */
export function describeError(err: unknown): string {
  if (err instanceof BackendUnavailableError) {
    return BACKEND_UNAVAILABLE_FINAL_MESSAGE
  }
  if (err instanceof ApiError) {
    return err.message
  }
  if (err instanceof Error && err.message) {
    if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      return BACKEND_UNAVAILABLE_FINAL_MESSAGE
    }
    return err.message
  }
  return 'Erro inesperado'
}
