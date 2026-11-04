/** Failure returned by a Host RPC implementation for one request. */
export interface HostRpcFailure {
  /** Stable machine-readable failure code. */
  code: string
  /** Human-readable failure description. */
  message: string
  /** Optional structured failure information. */
  details?: object
}

/** Result of a unary Host RPC. */
export type HostRpcResult = { ok: true; value: unknown } | { ok: false; error: HostRpcFailure }

/**
 * The DSH RPC surface the relay bridge calls into.
 *
 * Implementations are responsible for resolving endpoints against the running
 * DSH Host. The bridge owns relay framing, replay, and stream identity.
 */
export interface HostBridge {
  /**
   * Run one unary RPC.
   *
   * @param endpoint DSH RPC endpoint name.
   * @param payload Request payload supplied by the device.
   * @param signal Optional cancellation for the call.
   * @returns The RPC result; thrown errors are mapped to `host/internal`.
   */
  call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<HostRpcResult>

  /**
   * Open one streaming RPC.
   *
   * @param endpoint DSH RPC endpoint name.
   * @param payload Request payload supplied by the device.
   * @param uplink Values the device sends back into the stream.
   * @param signal Aborted when the device closes the stream or the Host stops.
   * @returns Values to deliver to the device as relay frames.
   */
  open(
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    signal: AbortSignal,
  ): AsyncIterable<unknown>
}

interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void
}

/**
 * Unbounded FIFO queue exposed as an {@link AsyncIterable}.
 *
 * Producers never block: values buffered while no consumer is waiting are
 * retained in order. `iterate()` is intended for a single consumer.
 */
export class AsyncQueue<T> {
  readonly #items: T[] = []
  readonly #waiters: Waiter<T>[] = []
  #ended = false

  /**
   * Append one value.
   *
   * @returns `false` when the queue has already ended and the value was dropped.
   */
  push(value: T): boolean {
    if (this.#ended) return false
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false })
      return true
    }
    this.#items.push(value)
    return true
  }

  /** Stop accepting values; already buffered values are still yielded. */
  end(): void {
    if (this.#ended) return
    this.#ended = true
    for (const waiter of this.#waiters.splice(0, this.#waiters.length)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  /** Consume values in insertion order until {@link end} is called. */
  async *iterate(): AsyncGenerator<T, void, undefined> {
    for (;;) {
      const result = await this.#next()
      if (result.done === true) return
      yield result.value
    }
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      const value = this.#items.shift() as T
      return Promise.resolve({ value, done: false })
    }
    if (this.#ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise<IteratorResult<T>>((resolve) => {
      this.#waiters.push({ resolve })
    })
  }
}
