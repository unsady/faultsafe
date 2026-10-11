export function recover<Result>(
  fallback: (error: unknown) => Result,
  error: unknown,
  signal: AbortSignal | undefined,
): Promise<Awaited<Result>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    function finish(): void {
      signal?.removeEventListener('abort', onAbort)
    }

    function onAbort(): void {
      finish()
      reject(signal?.reason)
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      void Promise.resolve(fallback(error)).then(
        (value) => {
          finish()
          resolve(value)
        },
        (error: unknown) => {
          finish()
          reject(error)
        },
      )
    } catch (error) {
      finish()
      reject(error)
    }
  })
}
