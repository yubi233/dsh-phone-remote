/** Close facts delivered to both relay-facing transports. */
export interface RelaySocketCloseInfo {
  code: number
  reason: string
}

/**
 * Minimal WebSocket surface shared by the Node Host and the browser carrier.
 *
 * Adapters wrap `ws` or the browser WebSocket in this interface, so relay
 * transport code never branches on environment. Subscriptions return their
 * own disposer.
 */
export interface RelaySocket {
  send(text: string): void
  close(code?: number, reason?: string): void
  onOpen(handler: () => void): () => void
  onMessage(handler: (text: string) => void): () => void
  onClose(handler: (info: RelaySocketCloseInfo) => void): () => void
}

/** Opens a relay WebSocket; resolves once the socket is constructed, not open. */
export type RelaySocketFactory = (url: string) => Promise<RelaySocket>
