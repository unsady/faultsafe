import { TimeoutError } from './errors.js'
import type { BackoffOptions, RunContext, TimeoutMode } from './types.js'

interface ExecutionOptions {
  attempts: number
  backoff: Required<BackoffOptions> | undefined
  timeout: number | undefined
  timeoutMode: TimeoutMode
}

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

async function runAttempt<Result>(
  operation: (context: RunContext) => Result,
  signal: AbortSignal,
  timeout: number | undefined,
  timeoutMode: TimeoutMode,
): Promise<Awaited<Result>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  function forwardAbort(): void {
    clearTimeout(timer)
    controller.abort(signal.reason)
  }

  signal.addEventListener('abort', forwardAbort, { once: true })

  try {
    signal.throwIfAborted()

    if (timeout === 0) {
      controller.abort(new TimeoutError(timeout))
    }

    controller.signal.throwIfAborted()

    const expired = new Promise<never>((_, reject) => {
      if (timeout !== undefined) {
        timer = setTimeout(() => {
          const error = new TimeoutError(timeout)

          controller.abort(error)

          if (timeoutMode === 'immediate') {
            reject(error)
          }
        }, timeout)
      }
    })
    const result = await Promise.race([operation({ signal: controller.signal }), expired])

    controller.signal.throwIfAborted()
    return result
  } catch (error) {
    controller.signal.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', forwardAbort)
  }
}

export async function execute<Result>(
  operation: (context: RunContext) => Result,
  signal: AbortSignal,
  { attempts, backoff, timeout, timeoutMode }: ExecutionOptions,
): Promise<Awaited<Result>> {
  let attempt = 1

  while (true) {
    signal.throwIfAborted()

    try {
      return await runAttempt(operation, signal, timeout, timeoutMode)
    } catch (error) {
      signal.throwIfAborted()

      if (attempt >= attempts) {
        throw error
      }

      if (backoff !== undefined) {
        const multiplier = backoff.type === 'exponential' ? 2 ** (attempt - 1) : 1
        const base = backoff.delay === 0 ? 0 : backoff.delay * multiplier
        const delay = Math.floor(base * (1 - backoff.jitter * Math.random()))

        await wait(delay, signal)
      }

      attempt += 1
    }
  }
}
