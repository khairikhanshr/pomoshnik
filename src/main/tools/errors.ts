/** Failure with a message for the model and an optional Russian summary for the UI. */
export class ToolError extends Error {
  readonly summary?: string

  constructor(message: string, summary?: string) {
    super(message)
    this.name = 'ToolError'
    this.summary = summary
  }
}

export class ToolAbortError extends Error {
  constructor() {
    super('Cancelled by the user')
    this.name = 'AbortError'
  }
}

export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR'
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ToolAbortError()
}

/** setTimeout as a promise that rejects with ToolAbortError when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolAbortError())
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ToolAbortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
