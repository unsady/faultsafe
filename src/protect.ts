import { QueueFullError } from './errors.js'
import { execute } from './retry.js'
import type { ProtectOptions, RunContext, Runner, RunOptions } from './types.js'

interface PendingOperation {
  start: () => void
}

export function protect(options: ProtectOptions = {}): Runner {
  const { attempts = 1, timeout, timeoutMode = 'immediate', onError } = options
  const backoff =
    options.backoff === undefined
      ? undefined
      : { ...options.backoff, jitter: options.backoff.jitter ?? 0 }
  const concurrency = options.concurrency ?? Infinity
  const maxPending = options.maxPending ?? 0
  const pending = new Set<PendingOperation>()
  let active = 0

  function drain(): void {
    while (active < concurrency) {
      const next = pending.values().next().value

      if (next === undefined) {
        return
      }

      pending.delete(next)
      next.start()
    }
  }

  function run<Result>(
    operation: (context: RunContext) => Result,
    runOptions: RunOptions = {},
  ): Promise<Awaited<Result>> {
    const { signal } = runOptions
    const result = new Promise<Awaited<Result>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }

      function cancelPending(): void {
        pending.delete(entry)
        signal?.removeEventListener('abort', cancelPending)
        reject(signal?.reason)
      }

      function start(): void {
        signal?.removeEventListener('abort', cancelPending)
        active += 1

        const controller = new AbortController()

        function forwardAbort(): void {
          controller.abort(signal?.reason)
        }

        function onAbort(): void {
          reject(controller.signal.reason)
        }

        function finish(): void {
          signal?.removeEventListener('abort', forwardAbort)
          controller.signal.removeEventListener('abort', onAbort)
          active -= 1
          drain()
        }

        controller.signal.addEventListener('abort', onAbort, { once: true })
        signal?.addEventListener('abort', forwardAbort, { once: true })

        if (signal?.aborted) {
          forwardAbort()
        }

        void execute(operation, controller.signal, {
          attempts,
          backoff,
          timeout,
          timeoutMode,
        }).then(
          (value) => {
            resolve(value)
            finish()
          },
          (error: unknown) => {
            reject(error)
            finish()
          },
        )
      }

      const entry: PendingOperation = { start }

      if (active < concurrency && pending.size === 0) {
        start()
      } else if (pending.size >= maxPending) {
        reject(new QueueFullError())
      } else {
        pending.add(entry)
        signal?.addEventListener('abort', cancelPending, { once: true })
      }
    })

    if (onError === undefined) {
      return result
    }

    return result.catch((error: unknown) => {
      onError(error)
      throw error
    })
  }

  return run
}
