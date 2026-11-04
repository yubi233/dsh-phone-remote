import type { RelaySocket, RelaySocketCloseInfo, RelaySocketFactory } from '@dsh-web-remote/protocol'
import type { RawData } from 'ws'

/**
 * Create the Node relay socket adapter backed by `ws`.
 *
 * The returned factory resolves after the WebSocket opens and rejects when the
 * connection errors before opening, so a failed TCP/TLS attempt cannot hang the
 * caller. `ws` is imported lazily to keep this module side-effect free.
 */
export function createNodeSocketFactory(): RelaySocketFactory {
  return async (url: string): Promise<RelaySocket> => {
    const { default: WebSocketCtor } = await import('ws')
    let resolveFactory!: (socket: RelaySocket) => void
    let rejectFactory!: (error: unknown) => void
    const opening = new Promise<RelaySocket>((resolve, reject) => {
      resolveFactory = resolve
      rejectFactory = reject
    })

    const socket = new WebSocketCtor(url)
    const openHandlers = new Set<() => void>()
    const messageHandlers = new Set<(text: string) => void>()
    const closeHandlers = new Set<(info: RelaySocketCloseInfo) => void>()
    let opened = false
    let closed = false
    let closeInfo: RelaySocketCloseInfo | undefined
    let settled = false

    const relaySocket: RelaySocket = {
      send(text: string): void {
        if (socket.readyState !== 1) return
        try {
          socket.send(text)
        } catch {
          // The peer can close between the readyState check and the send; the
          // close handler drives reconnect in that case.
        }
      },

      close(code = 1000, reason = ''): void {
        try {
          socket.close(code, reason)
        } catch {
          // Closing an already closed socket is a no-op for callers.
        }
      },

      onOpen(handler: () => void): () => void {
        openHandlers.add(handler)
        if (opened && !closed) queueMicrotask(handler)
        return (): void => {
          openHandlers.delete(handler)
        }
      },

      onMessage(handler: (text: string) => void): () => void {
        messageHandlers.add(handler)
        return (): void => {
          messageHandlers.delete(handler)
        }
      },

      onClose(handler: (info: RelaySocketCloseInfo) => void): () => void {
        closeHandlers.add(handler)
        if (closed && closeInfo !== undefined) {
          const info = closeInfo
          queueMicrotask(() => handler(info))
        }
        return (): void => {
          closeHandlers.delete(handler)
        }
      },
    }

    socket.on('open', () => {
      opened = true
      if (!settled) {
        settled = true
        resolveFactory(relaySocket)
      }
      for (const handler of [...openHandlers]) handler()
    })

    socket.on('message', (data: RawData) => {
      const text = decodeMessage(data)
      for (const handler of [...messageHandlers]) handler(text)
    })

    socket.on('close', (code: number, reason: Buffer) => {
      closed = true
      const info: RelaySocketCloseInfo = {
        code: normalizeCloseCode(code),
        reason: normalizeCloseReason(reason),
      }
      closeInfo = info
      if (!settled) {
        settled = true
        rejectFactory(new Error(`relay socket closed before open (${info.code})`))
      }
      for (const handler of [...closeHandlers]) handler(info)
      openHandlers.clear()
      messageHandlers.clear()
      closeHandlers.clear()
    })

    socket.on('error', (error: Error) => {
      if (settled) return
      settled = true
      try {
        socket.terminate()
      } catch {
        // Termination only shortens the failure path; the reject below is the
        // observable outcome.
      }
      rejectFactory(error)
    })

    socket.on('unexpected-response', (_request, response) => {
      if (settled) {
        response.resume()
        return
      }
      settled = true
      const statusCode = response.statusCode ?? 0
      response.resume()
      try {
        socket.terminate()
      } catch {
        // Same as above: the rejection carries the outcome.
      }
      // The HTTP status lets the Host distinguish an expired/unknown token
      // (401) from a transport failure and re-register instead of retrying.
      const failure = new Error(`relay rejected the upgrade with HTTP ${String(statusCode)}`)
      rejectFactory(Object.assign(failure, { statusCode }))
    })

    return await opening
  }
}

function decodeMessage(data: RawData | string): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  return data.toString('utf8')
}

function normalizeCloseCode(code: unknown): number {
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : 1006
}

function normalizeCloseReason(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (Buffer.isBuffer(reason)) return reason.toString('utf8')
  if (reason instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(reason))
  if (Array.isArray(reason)) return Buffer.concat(reason as Buffer[]).toString('utf8')
  return ''
}
