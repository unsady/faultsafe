import { CircuitOpenError, RoutingError } from './errors.js'
import { configureProtection } from './protection.js'
import { execute } from './retry.js'
import { Scheduler } from './scheduler.js'
import type { ExecuteOptions, Router, RouterOptions, RunContext, Visit } from './types.js'

export function createRouter<Resource, const Id extends string = string>(
  options: RouterOptions<Resource, Id>,
): Router<Resource> {
  const selection = options.selection ?? { type: 'priority' }
  const ids = new Set<string>()
  const providers = options.providers.map((provider) => {
    if (provider.id.length === 0 || ids.has(provider.id)) {
      throw new TypeError('Provider IDs must be non-empty and unique')
    }

    ids.add(provider.id)

    return {
      id: provider.id,
      resource: provider.resource,
      ...configureProtection(provider.protection, options.protection),
      priority: selection.type === 'priority' ? (selection.priorities?.[provider.id] ?? 0) : 0,
    }
  })
  const first = providers[0]

  if (first === undefined) {
    throw new TypeError('At least one provider is required')
  }

  if (selection.type === 'priority') {
    for (const [id, priority] of Object.entries(selection.priorities ?? {})) {
      if (!ids.has(id) || !Number.isFinite(priority)) {
        throw new TypeError('Priorities must reference registered providers and be finite')
      }
    }

    providers.sort((left, right) => right.priority - left.priority)
  } else if (selection.type !== 'sticky') {
    throw new TypeError('Unknown selection policy')
  }

  const sticky = selection.type === 'sticky'
  const defaultErrorPolicy = options.errorPolicy
  const scheduler = new Scheduler(options.concurrency ?? Infinity, options.maxPending ?? 0)
  let current = first
  let generation = 0

  function run<Result>(
    operation: (resource: Resource, context: RunContext) => Result,
    executeOptions: ExecuteOptions = {},
  ): Promise<Awaited<Result>> {
    const errorPolicy = executeOptions.errorPolicy ?? defaultErrorPolicy

    return scheduler.run(async (signal): Promise<Awaited<Result>> => {
      const started = generation
      const candidates = sticky
        ? [current, ...providers.filter((provider) => provider !== current)]
        : providers
      const visits: Visit[] = []

      for (const provider of candidates) {
        signal.throwIfAborted()

        let admission: { generation: number; probe: boolean } | undefined

        try {
          admission = provider.circuit?.enter()
        } catch (error) {
          if (!(error instanceof CircuitOpenError)) {
            throw error
          }

          visits.push({ providerId: provider.id, status: 'skipped', reason: error.reason })
          continue
        }

        function cancel(): void {
          if (admission !== undefined) {
            provider.circuit?.cancel(admission.generation)
          }
        }

        signal.addEventListener('abort', cancel, { once: true })

        try {
          const outcome = await execute(
            (context) => operation(provider.resource, context),
            signal,
            {
              ...provider.execution,
              errorPolicy,
            },
          )

          signal.throwIfAborted()

          if (outcome.ok) {
            if (admission !== undefined) {
              provider.circuit?.succeed(admission.generation)
            }

            if (sticky && started === generation && current !== provider) {
              current = provider
              generation += 1
            }

            return outcome.value
          }

          if (admission !== undefined) {
            if (outcome.countForCircuit) {
              provider.circuit?.fail(admission.generation)
            } else {
              cancel()
            }
          }

          if (!outcome.recoverable || !outcome.failover) {
            throw outcome.error
          }

          visits.push({ providerId: provider.id, status: 'failed', cause: outcome.error })
        } catch (error) {
          cancel()
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      }

      throw new RoutingError(visits)
    }, executeOptions.signal)
  }

  return { execute: run }
}
