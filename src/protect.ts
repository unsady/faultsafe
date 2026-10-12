import { CircuitOpenError, QueueFullError } from './errors.js'
import { recover } from './fallback.js'
import { Protection } from './protection.js'
import { Scheduler } from './scheduler.js'
import type { ErrorPolicy, ProtectOptions, RunContext, Runner, RunOptions } from './types.js'

export function protect(options: ProtectOptions = {}): Runner {
  const scheduler = new Scheduler(options.concurrency ?? Infinity, options.maxPending ?? 0)
  const protection = new Protection(options, {}, () => {
    scheduler.rejectPending(new CircuitOpenError())
  })
  const defaultErrorPolicy = options.errorPolicy

  function run<Result, Fallback = never>(
    operation: (context: RunContext) => Result,
    runOptions: RunOptions<Fallback> = {},
  ): Promise<Awaited<Result> | Awaited<Fallback>> {
    const { signal, fallback } = runOptions
    const errorPolicy = runOptions.errorPolicy ?? defaultErrorPolicy
    let recoverable = true
    let result: Promise<Awaited<Result>>

    const policy: ErrorPolicy = (error) => {
      const decision = errorPolicy?.(error) ?? { retry: true, countForCircuit: true }

      return {
        ...decision,
        countForCircuit:
          decision.countForCircuit &&
          !(error instanceof QueueFullError) &&
          !(error instanceof CircuitOpenError),
      }
    }

    try {
      signal?.throwIfAborted()
      protection.check()
      result = scheduler.run(async (signal): Promise<Awaited<Result>> => {
        const outcome = await protection.execute(operation, signal, policy)

        if ('skipped' in outcome) {
          throw outcome.skipped
        }

        if (!outcome.ok) {
          recoverable = outcome.recoverable
          throw outcome.error
        }

        return outcome.value
      }, signal)
    } catch (error) {
      result = Promise.reject(error)
    }

    if (fallback === undefined) {
      return result
    }

    return result.catch((error: unknown) => {
      if (!recoverable) {
        throw error
      }

      return recover(fallback, error, signal)
    })
  }

  return run
}
