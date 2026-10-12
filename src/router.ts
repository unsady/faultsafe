import { RoutingError } from './errors.js'
import { Protection } from './protection.js'
import { Scheduler } from './scheduler.js'
import { StickySelection } from './selection.js'
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
      protection: new Protection(provider.protection, options.protection),
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

  const concurrency = options.concurrency ?? Infinity
  const maxPending = options.maxPending ?? 0

  if (concurrency !== Infinity && (!Number.isInteger(concurrency) || concurrency < 1)) {
    throw new RangeError('concurrency must be a positive integer or Infinity')
  }

  if (!Number.isInteger(maxPending) || maxPending < 0) {
    throw new RangeError('maxPending must be a non-negative integer')
  }

  const sticky =
    selection.type === 'sticky' ? new StickySelection(first, providers.slice(1)) : undefined
  const defaultErrorPolicy = options.errorPolicy
  const scheduler = new Scheduler(concurrency, maxPending)

  function run<Result>(
    operation: (resource: Resource, context: RunContext) => Result,
    executeOptions: ExecuteOptions = {},
  ): Promise<Awaited<Result>> {
    const errorPolicy = executeOptions.errorPolicy ?? defaultErrorPolicy

    return scheduler.run(async (signal): Promise<Awaited<Result>> => {
      const choice = sticky?.begin()
      const candidates = choice?.candidates ?? providers
      const visits: Visit[] = []

      for (const provider of candidates) {
        signal.throwIfAborted()

        const outcome = await provider.protection.execute(
          (context) => operation(provider.resource, context),
          signal,
          errorPolicy,
        )

        signal.throwIfAborted()

        if ('skipped' in outcome) {
          visits.push({
            providerId: provider.id,
            status: 'skipped',
            reason: outcome.skipped.reason,
          })
          continue
        }

        if (outcome.ok) {
          if (choice !== undefined) {
            sticky?.succeed(choice.generation, provider)
          }

          return outcome.value
        }

        if (!outcome.recoverable || !outcome.failover) {
          throw outcome.error
        }

        visits.push({ providerId: provider.id, status: 'failed', cause: outcome.error })
      }

      throw new RoutingError(visits)
    }, executeOptions.signal)
  }

  return { execute: run }
}
