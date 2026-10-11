import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  createRouter,
  ErrorPolicyError,
  QueueFullError,
  RoutingError,
  TimeoutError,
  type RouterErrorPolicy,
  type RouterOptions,
} from './index.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const providers = [
  { id: 'a', resource: 'a' },
  { id: 'b', resource: 'b' },
  { id: 'c', resource: 'c' },
]

it('uses descending priority, exhausts each local budget and stops at the first success', async () => {
  const router = createRouter({
    providers: [
      { id: 'a', resource: 'a' },
      { id: 'b', resource: 'b' },
      { id: 'c', resource: 'c', protection: { attempts: 1 } },
    ],
    protection: { attempts: 2 },
    selection: { type: 'priority', priorities: { a: 30, c: 20, b: 10 } },
  })
  const visits: string[] = []
  const result = router.execute((resource) => {
    visits.push(resource)

    if (resource === 'a') {
      throw new Error('unavailable')
    }

    return resource
  })

  expectTypeOf(result).toEqualTypeOf<Promise<string>>()
  await expect(result).resolves.toBe('c')
  expect(visits).toEqual(['a', 'a', 'c'])
})

it('uses registration order by default and breaks equal priorities with that order', async () => {
  const router = createRouter({ providers })
  const tied = createRouter({
    providers,
    selection: { type: 'priority', priorities: { a: 1, b: 1 } },
  })

  await expect(router.execute((resource) => resource)).resolves.toBe('a')
  await expect(tied.execute((resource) => resource)).resolves.toBe('a')
})

it('inherits protection, replaces nested settings and can disable an inherited circuit', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5)

  const router = createRouter({
    providers: [
      {
        id: 'a',
        resource: 'a',
        protection: { attempts: 2, backoff: { type: 'fixed', delay: 10 }, circuit: false },
      },
      { id: 'b', resource: 'b' },
    ],
    protection: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 100, jitter: 1 },
      circuit: { threshold: 1, cooldown: 100 },
    },
  })
  const visits: [string, number][] = []
  let failures = 0

  function operation(resource: string): string {
    visits.push([resource, Date.now()])

    if (resource === 'a' || failures++ === 0) {
      throw new Error('unavailable')
    }

    return resource
  }

  const first = router.execute(operation)

  await vi.advanceTimersByTimeAsync(60)
  await expect(first).resolves.toBe('b')

  const second = router.execute(operation)

  await vi.advanceTimersByTimeAsync(10)
  await expect(second).resolves.toBe('b')
  expect(visits).toEqual([
    ['a', 0],
    ['a', 10],
    ['b', 10],
    ['b', 60],
    ['a', 60],
    ['a', 70],
    ['b', 70],
  ])
})

it('returns to the preferred provider after cooldown and admits only one recovery probe', async () => {
  const router = createRouter({
    providers,
    protection: { circuit: { threshold: 1, cooldown: 100 } },
  })
  const visits: string[] = []
  const error = new Error('unavailable')

  function operation(resource: string): string {
    visits.push(resource)

    if (resource === 'a') {
      throw error
    }

    return resource
  }

  await expect(router.execute(operation)).resolves.toBe('b')
  await expect(router.execute(operation)).resolves.toBe('b')
  expect(visits).toEqual(['a', 'b', 'b'])
  await vi.advanceTimersByTimeAsync(100)

  const blocker = deferred()
  const probe = router.execute(async (resource) => {
    await blocker.promise
    return resource
  })

  await expect(router.execute((resource) => resource)).resolves.toBe('b')
  blocker.resolve()
  await expect(probe).resolves.toBe('a')
  await expect(router.execute((resource) => resource)).resolves.toBe('a')
})

it('keeps a sticky provider after cooldown and switches when that provider fails', async () => {
  const router = createRouter({
    providers,
    selection: { type: 'sticky' },
    protection: { circuit: { threshold: 1, cooldown: 100 } },
  })
  const available = new Set(['b', 'c'])
  const visits: string[] = []

  function operation(resource: string): string {
    visits.push(resource)

    if (!available.has(resource)) {
      throw new Error('unavailable')
    }

    return resource
  }

  await expect(router.execute(operation)).resolves.toBe('b')
  await vi.advanceTimersByTimeAsync(100)
  available.add('a')
  await expect(router.execute(operation)).resolves.toBe('b')
  available.delete('b')
  await expect(router.execute(operation)).resolves.toBe('a')
  await expect(router.execute(operation)).resolves.toBe('a')
  expect(visits).toEqual(['a', 'b', 'b', 'b', 'a', 'a'])
})

it('does not let a late sticky transition overwrite the first successful transition', async () => {
  const router = createRouter({ providers, selection: { type: 'sticky' } })
  const blocker = deferred()
  const slow = router.execute(async (resource) => {
    if (resource === 'a') {
      throw new Error('unavailable')
    }

    await blocker.promise
    return resource
  })

  await vi.advanceTimersByTimeAsync(0)
  await expect(
    router.execute((resource) => {
      if (resource !== 'c') {
        throw new Error('unavailable')
      }

      return resource
    }),
  ).resolves.toBe('c')

  blocker.resolve()
  await expect(slow).resolves.toBe('b')
  await expect(router.execute((resource) => resource)).resolves.toBe('c')
})

it('reports failed and skipped visits in order, distinguishing open circuits and occupied probes', async () => {
  const router = createRouter({
    providers,
    protection: { circuit: { threshold: 1, cooldown: 100 } },
  })
  const errors = new Map(providers.map(({ resource }) => [resource, new Error(resource)]))

  function fail(resource: string): never {
    throw errors.get(resource)
  }

  const failed = await router.execute(fail).catch((error: unknown) => error)

  expect(failed).toBeInstanceOf(RoutingError)
  expect(failed).toMatchObject({
    errors: [...errors.values()],
    visits: providers.map(({ id }) => ({
      providerId: id,
      status: 'failed',
      cause: errors.get(id),
    })),
  })
  await vi.advanceTimersByTimeAsync(100)

  const blocker = deferred()
  const probe = router.execute(() => blocker.promise)
  const mixed = await router.execute(fail).catch((error: unknown) => error)

  expect(mixed).toMatchObject({
    errors: [errors.get('b'), errors.get('c')],
    visits: [
      { providerId: 'a', status: 'skipped', reason: 'probe-busy' },
      { providerId: 'b', status: 'failed', cause: errors.get('b') },
      { providerId: 'c', status: 'failed', cause: errors.get('c') },
    ],
  })

  const skipped = await router.execute(fail).catch((error: unknown) => error)

  expect(skipped).toMatchObject({
    errors: [],
    visits: [
      { providerId: 'a', status: 'skipped', reason: 'probe-busy' },
      { providerId: 'b', status: 'skipped', reason: 'circuit-open' },
      { providerId: 'c', status: 'skipped', reason: 'circuit-open' },
    ],
  })
  blocker.resolve()
  await probe
})

it('replaces the default error policy per call and stops directly when failover is forbidden', async () => {
  const policy = vi.fn<RouterErrorPolicy>(() => ({
    retry: true,
    failover: true,
    countForCircuit: true,
  }))
  const router = createRouter({ providers, protection: { attempts: 3 }, errorPolicy: policy })
  const temporary = new Error('temporary')
  const terminal = new Error('invalid input')
  const override = vi.fn<RouterErrorPolicy>((error) => ({
    retry: error === temporary,
    failover: error === temporary,
    countForCircuit: error === temporary,
  }))
  const resources: string[] = []
  const operation = vi.fn<(resource: string) => Promise<void>>((resource) => {
    resources.push(resource)
    return Promise.reject(resources.length === 1 ? temporary : terminal)
  })

  await expect(router.execute(operation, { errorPolicy: override })).rejects.toBe(terminal)
  expect(resources).toEqual(['a', 'a'])
  expect(override.mock.calls).toEqual([[temporary], [terminal]])
  expect(policy).not.toHaveBeenCalled()
})

it('preserves failures across neutral outcomes and immediately releases a neutral half-open probe', async () => {
  const error = new Error('provider failed')
  const neutral = new Error('invalid input')
  const router = createRouter({
    providers: [{ id: 'a', resource: 'a' }],
    protection: { circuit: { threshold: 2, cooldown: 100 } },
    errorPolicy: (failure) => ({
      retry: false,
      failover: false,
      countForCircuit: failure === error,
    }),
  })

  function fail(): never {
    throw error
  }

  function excluded(): never {
    throw neutral
  }

  await expect(router.execute(fail)).rejects.toBe(error)
  await expect(router.execute(excluded)).rejects.toBe(neutral)
  await expect(router.execute(fail)).rejects.toBe(error)
  await expect(router.execute(() => 'skipped')).rejects.toBeInstanceOf(RoutingError)
  await vi.advanceTimersByTimeAsync(100)
  await expect(router.execute(excluded)).rejects.toBe(neutral)

  const blocker = deferred()
  const probe = router.execute(() => blocker.promise)

  await expect(router.execute(() => 'skipped')).rejects.toMatchObject({
    visits: [{ providerId: 'a', status: 'skipped', reason: 'probe-busy' }],
  })
  blocker.resolve()
  await probe
  await expect(router.execute(() => 'saved')).resolves.toBe('saved')
})

it('preserves policy exceptions, does not fail over and releases the probe and concurrency slot', async () => {
  const router = createRouter({
    providers,
    concurrency: 2,
    protection: { attempts: 3, circuit: { threshold: 1, cooldown: 100 } },
  })
  const error = new Error('provider failed')
  const policyError = new Error('policy failed')

  await expect(
    router.execute(() => {
      throw error
    }),
  ).rejects.toBeInstanceOf(RoutingError)
  await vi.advanceTimersByTimeAsync(100)

  const operation = vi.fn<() => never>(() => {
    throw error
  })
  const failure = await router
    .execute(operation, {
      errorPolicy: () => {
        throw policyError
      },
    })
    .catch((error: unknown) => error)

  expect(failure).toBeInstanceOf(ErrorPolicyError)
  expect(failure).toMatchObject({ errors: [error, policyError], cause: error })
  expect(operation).toHaveBeenCalledTimes(1)

  const blocker = deferred()
  const probe = router.execute(() => blocker.promise)
  const peer = await router
    .execute(() => {
      throw error
    })
    .catch((error: unknown) => error)

  expect(peer).toMatchObject({
    visits: [
      { providerId: 'a', status: 'skipped', reason: 'probe-busy' },
      { providerId: 'b', status: 'failed', cause: error },
      { providerId: 'c', status: 'failed', cause: error },
    ],
  })
  blocker.resolve()
  await probe
  await expect(router.execute((resource) => resource)).resolves.toBe('a')
})

it('cancels queued and active requests without releasing an active slot before its callback settles', async () => {
  const policy = vi.fn<RouterErrorPolicy>(() => ({
    retry: true,
    failover: true,
    countForCircuit: true,
  }))
  const router = createRouter({ providers, concurrency: 1, maxPending: 1, errorPolicy: policy })
  const active = new AbortController()
  const queued = new AbortController()
  const reason = new Error('cancelled')
  const blocker = deferred()
  let received: AbortSignal | undefined
  const skipped = vi.fn<() => string>(() => 'skipped')

  await expect(router.execute(skipped, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)

  const running = router
    .execute(
      (_resource, { signal }) => {
        received = signal
        return blocker.promise
      },
      { signal: active.signal },
    )
    .catch((error: unknown) => error)
  const waiting = router
    .execute(skipped, { signal: queued.signal })
    .catch((error: unknown) => error)

  await expect(router.execute(skipped)).rejects.toBeInstanceOf(QueueFullError)
  queued.abort(reason)
  await expect(waiting).resolves.toBe(reason)

  const replacement = vi.fn<(resource: string) => string>((resource) => resource)
  const next = router.execute(replacement)

  active.abort(reason)
  await expect(running).resolves.toBe(reason)
  expect(received?.reason).toBe(reason)
  expect(replacement).not.toHaveBeenCalled()

  blocker.resolve()
  await expect(next).resolves.toBe('a')
  expect(skipped).not.toHaveBeenCalled()
  expect(policy).not.toHaveBeenCalled()
})

it('cancels backoff and prevents further retries or visits', async () => {
  const router = createRouter({
    providers,
    concurrency: 1,
    maxPending: 1,
    protection: { attempts: 3, backoff: { type: 'fixed', delay: 1_000 } },
  })
  const controller = new AbortController()
  const reason = new Error('cancelled')
  const operation = vi.fn<() => never>(() => {
    throw new Error('unavailable')
  })
  const cancelled = router
    .execute(operation, { signal: controller.signal })
    .catch((error: unknown) => error)
  const next = router.execute((resource) => resource)

  await vi.advanceTimersByTimeAsync(0)
  controller.abort(reason)
  await expect(cancelled).resolves.toBe(reason)
  await expect(next).resolves.toBe('a')
  await vi.runAllTimersAsync()
  expect(operation).toHaveBeenCalledTimes(1)
})

it('holds one slot across timeout, backoff and failover, ignoring detached callback outcomes', async () => {
  const router = createRouter({
    providers: [
      { id: 'a', resource: 'a' },
      { id: 'b', resource: 'b', protection: { attempts: 1, timeout: 50 } },
    ],
    concurrency: 1,
    maxPending: 1,
    protection: {
      attempts: 2,
      timeout: 100,
      backoff: { type: 'fixed', delay: 200 },
      circuit: { threshold: 1, cooldown: 100 },
    },
  })
  const blocker = deferred()
  const visits: string[] = []
  let received: AbortSignal | undefined
  const running = router.execute(async (resource, { signal }) => {
    visits.push(resource)

    if (resource === 'a') {
      if (visits.length === 1) {
        received = signal
        await blocker.promise
      }

      throw new Error('late or unavailable')
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 40))
    return resource
  })
  const next = vi.fn<(resource: string) => string>((resource) => resource)
  const waiting = router.execute(next)

  await vi.advanceTimersByTimeAsync(299)
  expect(visits).toEqual(['a'])
  expect(received?.reason).toBeInstanceOf(TimeoutError)
  expect(next).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(visits).toEqual(['a', 'a', 'b'])
  expect(next).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(40)
  await expect(running).resolves.toBe('b')
  await expect(waiting).resolves.toBe('b')

  blocker.resolve()
  await vi.advanceTimersByTimeAsync(59)
  await expect(router.execute((resource) => resource)).resolves.toBe('b')
  await vi.advanceTimersByTimeAsync(1)
  await expect(router.execute((resource) => resource)).resolves.toBe('a')
})

it('waits for a timed-out callback before failing over and releasing its slot', async () => {
  const router = createRouter({
    providers,
    concurrency: 1,
    maxPending: 1,
    protection: { timeout: 100, timeoutMode: 'wait', circuit: { threshold: 1, cooldown: 100 } },
  })
  const blocker = deferred()
  const visits: string[] = []
  let received: AbortSignal | undefined
  const running = router.execute((resource, { signal }) => {
    visits.push(resource)

    if (resource === 'a') {
      received = signal
      return blocker.promise.then(() => resource)
    }

    return resource
  })
  const next = vi.fn<(resource: string) => string>((resource) => resource)
  const waiting = router.execute(next)

  await vi.advanceTimersByTimeAsync(100)
  expect(received?.reason).toBeInstanceOf(TimeoutError)
  expect(visits).toEqual(['a'])
  expect(next).not.toHaveBeenCalled()

  blocker.resolve()
  await expect(running).resolves.toBe('b')
  await expect(waiting).resolves.toBe('b')
  expect(visits).toEqual(['a', 'b'])
})

describe('configuration', () => {
  it.each<{ name: string; options: Partial<RouterOptions<string>> }>([
    { name: 'empty providers', options: { providers: [] } },
    {
      name: 'duplicate IDs',
      options: {
        providers: [
          { id: 'a', resource: 'a' },
          { id: 'a', resource: 'b' },
        ],
      },
    },
    { name: 'empty IDs', options: { providers: [{ id: '', resource: 'a' }] } },
    {
      name: 'unknown priority IDs',
      options: { selection: { type: 'priority', priorities: { unknown: 1 } } },
    },
    {
      name: 'non-finite priorities',
      options: { selection: { type: 'priority', priorities: { a: Infinity } } },
    },
    { name: 'zero concurrency', options: { concurrency: 0 } },
    { name: 'negative queue limits', options: { maxPending: -1 } },
  ])('rejects $name', ({ options }) => {
    expect(() => createRouter({ providers, ...options })).toThrow(
      /provider|priorities|concurrency|maxPending/i,
    )
  })
})
