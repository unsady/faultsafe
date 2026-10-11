import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  CircuitOpenError,
  ErrorPolicyError,
  protect,
  QueueFullError,
  TimeoutError,
  type ErrorPolicy,
  type RunContext,
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

it('returns operation results and does not retry by default', async () => {
  const run = protect()
  const error = new Error('failed')
  const fail = vi.fn<() => never>(() => {
    throw error
  })

  await expect(run(() => 42)).resolves.toBe(42)
  await expect(run(async () => 'saved')).resolves.toBe('saved')
  await expect(run(fail)).rejects.toBe(error)
  expect(fail).toHaveBeenCalledTimes(1)
})

it('retries immediately without backoff and returns the successful result', async () => {
  const operation = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('temporary'))
    .mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValue('saved')
  const result = protect({ attempts: 3 })(operation)

  await expect(result).resolves.toBe('saved')
  expect(operation).toHaveBeenCalledTimes(3)
})

it('stops at the attempt limit with exponential backoff', async () => {
  const error = new Error('unavailable')
  const times: number[] = []
  const operation = vi.fn<() => Promise<void>>(() => {
    times.push(Date.now())
    return Promise.reject(error)
  })
  const run = protect({
    attempts: 4,
    backoff: { type: 'exponential', delay: 10 },
  })
  const rejected = run(operation).catch((error: unknown) => error)

  await vi.runAllTimersAsync()
  await expect(rejected).resolves.toBe(error)

  expect(operation).toHaveBeenCalledTimes(4)
  expect(times).toEqual([0, 10, 30, 70])
})

it.each<{ type: 'fixed' | 'exponential'; secondDelay: number }>([
  { type: 'fixed', secondDelay: 900 },
  { type: 'exponential', secondDelay: 1_800 },
])('applies numeric jitter to $type backoff', async ({ type, secondDelay }) => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5)

  const operation = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('temporary'))
    .mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValue('saved')
  const result = protect({
    attempts: 3,
    backoff: { type, delay: 1_000, jitter: 0.2 },
  })(operation)

  await vi.advanceTimersByTimeAsync(899)
  expect(operation).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(1)
  expect(operation).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(secondDelay - 1)
  expect(operation).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toBe('saved')
})

it('rejects excess calls without queuing by default', async () => {
  const policy = vi.fn<ErrorPolicy>(() => ({ retry: true, countForCircuit: true }))
  const run = protect({ concurrency: 1, errorPolicy: policy })
  const blocker = deferred()
  const running = run(() => blocker.promise)
  const overflow = vi.fn<() => string>(() => 'saved')

  await expect(run(overflow)).rejects.toBeInstanceOf(QueueFullError)
  expect(overflow).not.toHaveBeenCalled()

  blocker.resolve()
  await running
  await expect(run(overflow)).resolves.toBe('saved')
  expect(policy).not.toHaveBeenCalled()
})

it('supports an unbounded pending limit', async () => {
  const run = protect({ concurrency: 1, maxPending: Infinity })
  const blocker = deferred()
  const active = run(() => blocker.promise)
  const first = run(() => 'first')
  const second = run(() => 'second')

  blocker.resolve()
  await active
  await expect(first).resolves.toBe('first')
  await expect(second).resolves.toBe('second')
})

it('shares concurrency and pending limits across operations and releases a slot after failure', async () => {
  const run = protect({ concurrency: 2, maxPending: 1 })
  const first = deferred()
  const second = deferred()
  const error = new Error('failed')
  const failed = run(async () => {
    await first.promise
    throw error
  }).catch((error: unknown) => error)
  const running = run(() => second.promise)
  const queued = vi.fn<() => string>(() => 'queued')
  const waiting = run(queued)
  const overflow = vi.fn<() => void>()

  await expect(run(overflow)).rejects.toBeInstanceOf(QueueFullError)
  expect(overflow).not.toHaveBeenCalled()
  expect(queued).not.toHaveBeenCalled()

  first.resolve()
  await expect(failed).resolves.toBe(error)
  await expect(waiting).resolves.toBe('queued')

  second.resolve()
  await running
})

it('skips already aborted operations and frees a pending slot on cancellation', async () => {
  const policy = vi.fn<ErrorPolicy>(() => ({ retry: true, countForCircuit: true }))
  const run = protect({ concurrency: 1, maxPending: 1, errorPolicy: policy })
  const controller = new AbortController()
  const reason = new Error('cancelled')
  const skipped = vi.fn<() => void>()

  await expect(run(skipped, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)

  const blocker = deferred()
  const running = run(() => blocker.promise)
  const cancelled = run(skipped, { signal: controller.signal }).catch((error: unknown) => error)

  controller.abort(reason)
  await expect(cancelled).resolves.toBe(reason)

  const replacement = run(() => 'replacement')

  blocker.resolve()
  await running
  await expect(replacement).resolves.toBe('replacement')
  expect(skipped).not.toHaveBeenCalled()
  expect(policy).not.toHaveBeenCalled()
})

it('forwards cancellation without releasing the slot until the operation settles or retrying it', async () => {
  const policy = vi.fn<ErrorPolicy>(() => ({ retry: true, countForCircuit: true }))
  const run = protect({ concurrency: 1, maxPending: 1, attempts: 3, errorPolicy: policy })
  const controller = new AbortController()
  const blocker = deferred()
  const reason = new Error('cancelled')
  let received: AbortSignal | undefined
  const operation = vi.fn<(context: RunContext) => Promise<void>>(({ signal }) => {
    received = signal
    return blocker.promise
  })
  const cancelled = run(operation, { signal: controller.signal }).catch((error: unknown) => error)
  const next = vi.fn<() => string>(() => 'next')
  const waiting = run(next)

  controller.abort(reason)
  await expect(cancelled).resolves.toBe(reason)

  expect(received?.reason).toBe(reason)
  expect(next).not.toHaveBeenCalled()

  blocker.resolve()
  await expect(waiting).resolves.toBe('next')
  expect(operation).toHaveBeenCalledTimes(1)
  expect(policy).not.toHaveBeenCalled()
})

it('gives each attempt its own timeout, excluding backoff and queue wait', async () => {
  const run = protect({
    concurrency: 1,
    maxPending: 1,
    timeout: 100,
    attempts: 2,
    backoff: { type: 'fixed', delay: 200 },
  })
  const blocker = deferred()
  const signals: AbortSignal[] = []
  const operation = vi.fn<(context: RunContext) => Promise<string>>(async ({ signal }) => {
    signals.push(signal)

    if (signals.length === 1) {
      await blocker.promise
      return 'late'
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    return 'saved'
  })
  const result = run(operation).catch((error: unknown) => error)
  const next = vi.fn<() => string>(() => 'next')
  const waiting = run(next)

  await vi.advanceTimersByTimeAsync(200)
  expect(signals[0]?.reason).toBeInstanceOf(TimeoutError)
  expect(operation).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(99)
  expect(operation).toHaveBeenCalledTimes(1)
  expect(next).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(1)
  expect(operation).toHaveBeenCalledTimes(2)
  expect(signals[1]?.aborted).toBe(false)

  await vi.advanceTimersByTimeAsync(80)
  await expect(result).resolves.toBe('saved')
  await expect(waiting).resolves.toBe('next')

  blocker.resolve()
  await vi.advanceTimersByTimeAsync(0)
})

it('releases the slot on the final timeout and ignores a late callback rejection', async () => {
  const run = protect({
    concurrency: 1,
    maxPending: 1,
    timeout: 100,
    timeoutMode: 'immediate',
  })
  const blocker = deferred()
  const timedOut = run(async () => {
    await blocker.promise
    throw new Error('late')
  }).catch((error: unknown) => error)
  const waiting = run(() => 'next')

  await vi.advanceTimersByTimeAsync(100)
  await expect(timedOut).resolves.toBeInstanceOf(TimeoutError)
  await expect(waiting).resolves.toBe('next')

  blocker.resolve()
  await vi.advanceTimersByTimeAsync(0)
})

it('waits for timed-out callbacks before retrying or releasing the slot in wait mode', async () => {
  const run = protect({
    concurrency: 1,
    maxPending: 1,
    attempts: 2,
    timeout: 100,
    timeoutMode: 'wait',
  })
  const first = deferred()
  const second = deferred()
  const signals: AbortSignal[] = []
  const operation = vi.fn<(context: RunContext) => Promise<void>>(({ signal }) => {
    signals.push(signal)
    return signals.length === 1 ? first.promise : second.promise
  })
  const timedOut = run(operation).catch((error: unknown) => error)
  const next = vi.fn<() => string>(() => 'next')
  const waiting = run(next)

  await vi.advanceTimersByTimeAsync(200)
  expect(signals[0]?.reason).toBeInstanceOf(TimeoutError)
  expect(operation).toHaveBeenCalledTimes(1)

  first.resolve()
  await vi.advanceTimersByTimeAsync(100)
  expect(signals[1]?.reason).toBeInstanceOf(TimeoutError)
  expect(operation).toHaveBeenCalledTimes(2)
  expect(next).not.toHaveBeenCalled()

  second.resolve()
  await expect(timedOut).resolves.toBeInstanceOf(TimeoutError)
  await expect(waiting).resolves.toBe('next')
})

describe('error policy', () => {
  it('replaces the runner policy per call and classifies the final error independently', async () => {
    const error = new Error('provider failed')
    const excluded = new Error('invalid input')
    const policy = vi.fn<ErrorPolicy>(() => ({ retry: false, countForCircuit: true }))
    const override = vi.fn<ErrorPolicy>((failure) => ({
      retry: failure === error,
      countForCircuit: failure === error,
    }))
    const run = protect({
      attempts: 3,
      circuit: { threshold: 1, cooldown: 100 },
      errorPolicy: policy,
    })
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockRejectedValue(excluded)

    await expect(run(operation, { errorPolicy: override })).rejects.toBe(excluded)
    expect(operation).toHaveBeenCalledTimes(2)
    expect(override.mock.calls).toEqual([[error], [excluded]])
    expect(policy).not.toHaveBeenCalled()

    await expect(run(operation)).rejects.toBe(excluded)
    expect(operation).toHaveBeenCalledTimes(3)
    expect(policy.mock.calls).toEqual([[excluded]])
    await expect(run(operation)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(policy).toHaveBeenCalledTimes(1)
  })

  it('preserves counted failures across neutral errors and permits an immediate replacement probe', async () => {
    const error = new Error('provider failed')
    const excluded = new Error('invalid input')
    const run = protect({
      circuit: { threshold: 2, cooldown: 100 },
      errorPolicy: (failure) => ({ retry: false, countForCircuit: failure === error }),
    })

    function fail(): never {
      throw error
    }

    function neutral(): never {
      throw excluded
    }

    await expect(run(fail)).rejects.toBe(error)
    await expect(run(neutral)).rejects.toBe(excluded)
    await expect(run(fail)).rejects.toBe(error)
    await expect(run(() => 'skipped')).rejects.toBeInstanceOf(CircuitOpenError)
    await vi.advanceTimersByTimeAsync(100)
    await expect(run(neutral)).rejects.toBe(excluded)

    const blocker = deferred()
    const probe = run(() => blocker.promise)

    await expect(run(() => 'skipped')).rejects.toBeInstanceOf(CircuitOpenError)
    blocker.resolve()
    await probe
    await expect(run(() => 'saved')).resolves.toBe('saved')
  })

  it('preserves both errors when the policy throws, skips fallback and releases the probe and slot', async () => {
    const error = new Error('provider failed')
    const policyError = new Error('policy failed')
    const run = protect({
      concurrency: 1,
      attempts: 3,
      circuit: { threshold: 1, cooldown: 100 },
    })
    const operation = vi.fn<() => never>(() => {
      throw error
    })

    await expect(run(operation)).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(100)
    operation.mockClear()

    const policy = vi.fn<ErrorPolicy>(() => {
      throw policyError
    })
    const fallback = vi.fn<() => string>(() => 'backup')
    const failure = await run(operation, { errorPolicy: policy, fallback }).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ErrorPolicyError)
    expect(failure).toMatchObject({ errors: [error, policyError], cause: error })
    expect(operation).toHaveBeenCalledTimes(1)
    expect(policy).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()

    const blocker = deferred()
    const probe = run(() => blocker.promise)

    await expect(run(() => 'skipped')).rejects.toBeInstanceOf(CircuitOpenError)
    blocker.resolve()
    await probe
    await expect(run(() => 'saved')).resolves.toBe('saved')
  })

  it('allows fallback even when retries are disabled', async () => {
    const error = new Error('invalid input')
    const run = protect({
      attempts: 3,
      errorPolicy: () => ({ retry: false, countForCircuit: false }),
    })
    const operation = vi.fn<() => never>(() => {
      throw error
    })
    const fallback = vi.fn<() => string>(() => 'cached')

    await expect(run(operation, { fallback })).resolves.toBe('cached')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('fallback', () => {
  it('runs only after final failure and returns an awaited, correctly typed result', async () => {
    const run = protect({ attempts: 3 })
    const error = new Error('primary failed')
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(error)
    const fallback = vi.fn<(error: unknown) => Promise<number>>(async () => 42)

    await expect(run(() => 'primary', { fallback })).resolves.toBe('primary')
    expect(fallback).not.toHaveBeenCalled()

    const result = run(operation, { fallback })

    expectTypeOf(result).toEqualTypeOf<Promise<string | number>>()
    await expect(result).resolves.toBe(42)
    expect(operation).toHaveBeenCalledTimes(3)
    expect(fallback.mock.calls[0]?.[0]).toBe(error)
    expectTypeOf(run(() => 'primary')).toEqualTypeOf<Promise<string>>()
  })

  it.each(['throw', 'reject'] as const)(
    'reports a fallback %s without retrying it',
    async (mode) => {
      const run = protect({ attempts: 3 })
      const error = new Error('backup failed')
      const fallback = vi.fn<(error: unknown) => Promise<never>>(() => {
        if (mode === 'throw') {
          throw error
        }

        return Promise.reject(error)
      })

      await expect(
        run(
          () => {
            throw new Error('primary failed')
          },
          { fallback },
        ),
      ).rejects.toBe(error)
      expect(fallback).toHaveBeenCalledTimes(1)
    },
  )

  it('can use a backup runner without closing the primary circuit', async () => {
    const run = protect({ circuit: { threshold: 1, cooldown: 100 } })
    const backup = protect({ attempts: 2, circuit: { threshold: 1, cooldown: 100 } })
    const error = new Error('primary failed')
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('primary')
    const fallback = vi.fn<(error: unknown) => Promise<string>>(() => backup(() => 'backup'))

    await expect(run(operation, { fallback })).resolves.toBe('backup')
    await expect(run(operation, { fallback })).resolves.toBe('backup')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(fallback.mock.calls[0]?.[0]).toBe(error)
    expect(fallback.mock.calls[1]?.[0]).toBeInstanceOf(CircuitOpenError)

    await vi.advanceTimersByTimeAsync(100)
    await expect(run(operation, { fallback })).resolves.toBe('primary')
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it('handles final timeout outside the primary concurrency slot and timeout budget', async () => {
    const policy = vi.fn<ErrorPolicy>(() => ({ retry: false, countForCircuit: false }))
    const run = protect({
      concurrency: 1,
      attempts: 3,
      timeout: 100,
      circuit: { threshold: 1, cooldown: 100 },
      errorPolicy: policy,
    })
    const primary = deferred()
    const backup = deferred()
    let received: AbortSignal | undefined
    const fallback = vi.fn<(error: unknown, context: RunContext) => Promise<number>>(
      async (_error, { signal }) => {
        received = signal
        await backup.promise
        return 42
      },
    )
    const result = run(
      async () => {
        await primary.promise
        throw new Error('late')
      },
      { fallback },
    )

    await vi.advanceTimersByTimeAsync(100)
    expect(fallback.mock.calls[0]?.[0]).toBeInstanceOf(TimeoutError)
    expect(policy.mock.calls[0]?.[0]).toBeInstanceOf(TimeoutError)
    expect(policy).toHaveBeenCalledTimes(1)
    expect(received).toBeInstanceOf(AbortSignal)
    expect(received?.aborted).toBe(false)
    await expect(run(() => 'primary')).resolves.toBe('primary')
    await vi.advanceTimersByTimeAsync(1_000)

    backup.resolve()
    await expect(result).resolves.toBe(42)
    expect(fallback).toHaveBeenCalledTimes(1)

    primary.resolve()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('handles queue overflow without invoking the primary callback', async () => {
    const run = protect({ concurrency: 1 })
    const blocker = deferred()
    const running = run(() => blocker.promise)
    const skipped = vi.fn<() => string>(() => 'primary')
    const fallback = vi.fn<(error: unknown) => string>(() => 'backup')
    const result = run(skipped, { fallback })

    expectTypeOf(result).toEqualTypeOf<Promise<string>>()
    await expect(result).resolves.toBe('backup')
    expect(fallback.mock.calls[0]?.[0]).toBeInstanceOf(QueueFullError)
    expect(skipped).not.toHaveBeenCalled()

    blocker.resolve()
    await running
  })

  it('does not recover already aborted, queued or active cancellations', async () => {
    const run = protect({ concurrency: 1, maxPending: 1 })
    const reason = new Error('cancelled')
    const skipped = vi.fn<() => void>()
    const fallback = vi.fn<(error: unknown) => string>(() => 'backup')

    await expect(run(skipped, { signal: AbortSignal.abort(reason), fallback })).rejects.toBe(reason)

    const blocker = deferred()
    const active = new AbortController()
    const queued = new AbortController()
    const running = run(() => blocker.promise, { signal: active.signal, fallback }).catch(
      (error: unknown) => error,
    )
    const waiting = run(skipped, { signal: queued.signal, fallback }).catch(
      (error: unknown) => error,
    )

    queued.abort(reason)
    active.abort(reason)
    await expect(waiting).resolves.toBe(reason)
    await expect(running).resolves.toBe(reason)
    expect(fallback).not.toHaveBeenCalled()
    expect(skipped).not.toHaveBeenCalled()

    blocker.resolve()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('cancels an active fallback and ignores its late rejection', async () => {
    const run = protect()
    const controller = new AbortController()
    const blocker = deferred()
    const reason = new Error('cancelled')
    let received: AbortSignal | undefined
    const fallback = vi.fn<(error: unknown, context: RunContext) => Promise<never>>(
      async (_error, { signal }) => {
        received = signal
        await blocker.promise
        throw new Error('late')
      },
    )
    const cancelled = run(
      () => {
        throw new Error('primary failed')
      },
      { signal: controller.signal, fallback },
    ).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(0)
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(received).toBe(controller.signal)
    controller.abort(reason)
    await expect(cancelled).resolves.toBe(reason)
    expect(received?.reason).toBe(reason)

    blocker.resolve()
    await vi.advanceTimersByTimeAsync(0)
  })
})

describe('circuit', () => {
  it('counts final failures after retries and resets the count on success', async () => {
    const run = protect({ attempts: 2, circuit: { threshold: 2, cooldown: 100 } })
    const error = new Error('unavailable')
    const fail = vi.fn<() => Promise<void>>().mockRejectedValue(error)
    const recover = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('saved')
    const skipped = vi.fn<() => void>()

    await expect(run(fail)).rejects.toBe(error)
    await expect(run(recover)).resolves.toBe('saved')
    await expect(run(fail)).rejects.toBe(error)
    await expect(run(fail)).rejects.toBe(error)
    await expect(run(skipped)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(fail).toHaveBeenCalledTimes(6)
    expect(skipped).not.toHaveBeenCalled()

    await expect(
      protect({ circuit: { threshold: 2, cooldown: 100 } })(() => 'saved'),
    ).resolves.toBe('saved')
  })

  it('rejects queued calls when opening without cancelling active calls', async () => {
    const run = protect({
      concurrency: 2,
      maxPending: 1,
      circuit: { threshold: 1, cooldown: 100 },
    })
    const active = deferred()
    const failure = deferred()
    const error = new Error('unavailable')
    let received: AbortSignal | undefined
    const running = run(({ signal }) => {
      received = signal
      return active.promise
    })
    const failed = run(async () => {
      await failure.promise
      throw error
    }).catch((error: unknown) => error)
    const skipped = vi.fn<() => void>()
    const waiting = run(skipped).catch((error: unknown) => error)

    failure.resolve()
    await expect(failed).resolves.toBe(error)
    await expect(waiting).resolves.toBeInstanceOf(CircuitOpenError)
    expect(received?.aborted).toBe(false)

    active.resolve()
    await running
    await expect(run(skipped)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(skipped).not.toHaveBeenCalled()
  })

  it('admits one probe after cooldown, reopens on failure and closes on success', async () => {
    const run = protect({ circuit: { threshold: 1, cooldown: 100 } })
    const error = new Error('unavailable')

    function fail(): never {
      throw error
    }

    const skipped = vi.fn<() => void>()

    await expect(run(fail)).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(99)
    await expect(run(skipped)).rejects.toBeInstanceOf(CircuitOpenError)
    await vi.advanceTimersByTimeAsync(1)

    const blocker = deferred()
    const probe = run(async () => {
      await blocker.promise
      throw error
    }).catch((error: unknown) => error)

    await expect(run(skipped)).rejects.toBeInstanceOf(CircuitOpenError)
    blocker.resolve()
    await expect(probe).resolves.toBe(error)

    await vi.advanceTimersByTimeAsync(99)
    await expect(run(skipped)).rejects.toBeInstanceOf(CircuitOpenError)
    await vi.advanceTimersByTimeAsync(1)
    await expect(run(() => 'recovered')).resolves.toBe('recovered')
    await expect(run(() => 'saved')).resolves.toBe('saved')
    expect(skipped).not.toHaveBeenCalled()
  })

  it('does not count cancellation or queue overflow, or reset failures because of them', async () => {
    const run = protect({ concurrency: 1, circuit: { threshold: 2, cooldown: 100 } })
    const error = new Error('unavailable')

    function fail(): never {
      throw error
    }

    await expect(run(fail)).rejects.toBe(error)

    const blocker = deferred()
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const cancelled = run(() => blocker.promise, { signal: controller.signal }).catch(
      (error: unknown) => error,
    )
    const skipped = vi.fn<() => void>()

    await expect(run(skipped)).rejects.toBeInstanceOf(QueueFullError)
    controller.abort(reason)
    await expect(cancelled).resolves.toBe(reason)

    blocker.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await expect(run(fail)).rejects.toBe(error)
    await expect(run(skipped)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(skipped).not.toHaveBeenCalled()
  })

  it('keeps operation-thrown admission errors neutral without resetting prior failures', async () => {
    const run = protect({ circuit: { threshold: 2, cooldown: 100 } })
    const error = new Error('unavailable')

    function fail(): never {
      throw error
    }

    await expect(run(fail)).rejects.toBe(error)

    for (const admissionError of [new QueueFullError(), new CircuitOpenError()]) {
      await expect(
        run(() => {
          throw admissionError
        }),
      ).rejects.toBe(admissionError)
    }

    await expect(run(fail)).rejects.toBe(error)
    await expect(run(() => 'skipped')).rejects.toBeInstanceOf(CircuitOpenError)
  })

  it('counts only the final timeout and ignores detached callbacks', async () => {
    const run = protect({
      attempts: 2,
      timeout: 100,
      circuit: { threshold: 1, cooldown: 100 },
    })
    const blocker = deferred()
    const timedOut = run(() => blocker.promise).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(100)
    await expect(run(() => 'available')).resolves.toBe('available')
    await vi.advanceTimersByTimeAsync(100)
    await expect(timedOut).resolves.toBeInstanceOf(TimeoutError)

    blocker.resolve()
    await vi.advanceTimersByTimeAsync(0)
    const skipped = vi.fn<() => void>()

    await expect(run(skipped)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(skipped).not.toHaveBeenCalled()
  })

  it('ignores old failures and cancelled probe results across recovery', async () => {
    const run = protect({ circuit: { threshold: 1, cooldown: 100 } })
    const error = new Error('unavailable')
    const old = deferred()
    const failed = run(async () => {
      await old.promise
      throw error
    }).catch((error: unknown) => error)

    await expect(
      run(() => {
        throw error
      }),
    ).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(100)

    const controller = new AbortController()
    const reason = new Error('cancelled')
    const abandoned = deferred()
    const cancelled = run(() => abandoned.promise, { signal: controller.signal }).catch(
      (error: unknown) => error,
    )

    controller.abort(reason)
    await expect(cancelled).resolves.toBe(reason)

    const replacement = deferred()
    const probe = run(() => replacement.promise)

    abandoned.resolve()
    await vi.advanceTimersByTimeAsync(0)
    const skipped = vi.fn<() => void>()

    await expect(run(skipped)).rejects.toBeInstanceOf(CircuitOpenError)
    replacement.resolve()
    await probe

    old.resolve()
    await expect(failed).resolves.toBe(error)
    await expect(run(() => 'saved')).resolves.toBe('saved')
    expect(skipped).not.toHaveBeenCalled()
  })

  it('reserves the probe only when starting and rejects other queued candidates', async () => {
    const run = protect({
      concurrency: 1,
      maxPending: 2,
      circuit: { threshold: 1, cooldown: 100 },
    })
    const error = new Error('unavailable')

    await expect(
      run(() => {
        throw error
      }),
    ).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(100)

    const controller = new AbortController()
    const reason = new Error('cancelled')
    const abandoned = deferred()
    const cancelled = run(() => abandoned.promise, { signal: controller.signal }).catch(
      (error: unknown) => error,
    )

    controller.abort(reason)
    await expect(cancelled).resolves.toBe(reason)

    const replacement = deferred()
    const probe = run(() => replacement.promise)
    const skipped = vi.fn<() => void>()
    const waiting = run(skipped).catch((error: unknown) => error)

    abandoned.resolve()
    await expect(waiting).resolves.toBeInstanceOf(CircuitOpenError)
    expect(skipped).not.toHaveBeenCalled()

    replacement.resolve()
    await probe
    await expect(run(() => 'saved')).resolves.toBe('saved')
  })
})

it('cancels backoff with the external signal and frees the slot without retrying', async () => {
  const run = protect({
    concurrency: 1,
    maxPending: 1,
    attempts: 3,
    backoff: { type: 'fixed', delay: 1_000 },
  })
  const controller = new AbortController()
  const reason = new Error('cancelled')
  const operation = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('unavailable'))
  const cancelled = run(operation, { signal: controller.signal }).catch((error: unknown) => error)
  const waiting = run(() => 'next')

  await vi.advanceTimersByTimeAsync(0)
  controller.abort(reason)

  await expect(cancelled).resolves.toBe(reason)
  await expect(waiting).resolves.toBe('next')
  await vi.runAllTimersAsync()
  expect(operation).toHaveBeenCalledTimes(1)
})
