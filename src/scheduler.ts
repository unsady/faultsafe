import { QueueFullError } from './errors.js'

interface PendingOperation {
  start: () => void
  reject: (error: unknown) => void
}

export class Scheduler {
  private active = 0
  private readonly pending = new Set<PendingOperation>()

  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
  ) {}

  rejectPending(error: unknown): void {
    for (const entry of this.pending) {
      entry.reject(error)
    }
  }

  run<Result>(
    operation: (signal: AbortSignal) => Promise<Result>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Result> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }

      function cancelActive(): void {
        reject(signal.reason)
      }

      const rejectPending = (error: unknown): void => {
        this.pending.delete(entry)
        signal.removeEventListener('abort', cancelPending)
        reject(error)
      }

      function cancelPending(): void {
        rejectPending(signal.reason)
      }

      const start = (): void => {
        signal.removeEventListener('abort', cancelPending)

        if (signal.aborted) {
          reject(signal.reason)
          return
        }

        this.active += 1
        signal.addEventListener('abort', cancelActive, { once: true })

        const finish = (): void => {
          signal.removeEventListener('abort', cancelActive)
          this.active -= 1
          this.drain()
        }

        try {
          void operation(signal).then(
            (value) => {
              resolve(value)
              finish()
            },
            (error: unknown) => {
              reject(error)
              finish()
            },
          )
        } catch (error) {
          reject(error)
          finish()
        }
      }

      const entry = { start, reject: rejectPending }

      if (this.active < this.concurrency && this.pending.size === 0) {
        start()
      } else if (this.pending.size >= this.maxPending) {
        reject(new QueueFullError())
      } else {
        this.pending.add(entry)
        signal.addEventListener('abort', cancelPending, { once: true })
      }
    })
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const next = this.pending.values().next().value

      if (next === undefined) {
        return
      }

      this.pending.delete(next)
      next.start()
    }
  }
}
