import type { BackoffOptions, RunContext } from './types.js'

function wait(duration: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()

    function onAbort(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, duration)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function execute<Result>(
  operation: (context: RunContext) => Result,
  context: RunContext,
  attempts: number,
  backoff: Required<BackoffOptions> | undefined,
): Promise<Awaited<Result>> {
  let attempt = 1

  while (true) {
    context.signal.throwIfAborted()

    try {
      const result = await operation(context)

      context.signal.throwIfAborted()
      return result
    } catch (error) {
      context.signal.throwIfAborted()

      if (attempt >= attempts) {
        throw error
      }

      if (backoff !== undefined) {
        const multiplier = backoff.type === 'exponential' ? 2 ** (attempt - 1) : 1
        const base = backoff.delay === 0 ? 0 : backoff.delay * multiplier
        const delay = Math.floor(base * (1 - backoff.jitter * Math.random()))

        await wait(delay, context.signal)
      }

      attempt += 1
    }
  }
}
