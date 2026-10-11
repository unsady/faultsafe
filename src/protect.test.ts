import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { protect, QueueFullError, TimeoutError, type RunContext } from './index.js'

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

it('stops at the attempt limit and reports the final error once', async () => {
  const error = new Error('unavailable')
  const times: number[] = []
  const operation = vi.fn<() => Promise<void>>(() => {
    times.push(Date.now())
    return Promise.reject(error)
  })
  const onError = vi.fn<(error: unknown) => void>()
  const run = protect({
    attempts: 4,
    backoff: { type: 'exponential', delay: 10 },
    onError,
  })
  const rejected = run(operation).catch((error: unknown) => error)

  await vi.runAllTimersAsync()
  await expect(rejected).resolves.toBe(error)

  expect(operation).toHaveBeenCalledTimes(4)
  expect(times).toEqual([0, 10, 30, 70])
  expect(onError.mock.calls).toEqual([[error]])
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
  const run = protect({ concurrency: 1 })
  const blocker = deferred()
  const running = run(() => blocker.promise)
  const overflow = vi.fn<() => string>(() => 'saved')

  await expect(run(overflow)).rejects.toBeInstanceOf(QueueFullError)
  expect(overflow).not.toHaveBeenCalled()

  blocker.resolve()
  await running
  await expect(run(overflow)).resolves.toBe('saved')
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
  const run = protect({ concurrency: 1, maxPending: 1 })
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
})

it('forwards cancellation without releasing the slot until the operation settles or retrying it', async () => {
  const run = protect({ concurrency: 1, maxPending: 1, attempts: 3 })
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
  const onError = vi.fn<(error: unknown) => void>()
  const run = protect({
    concurrency: 1,
    maxPending: 1,
    timeout: 100,
    timeoutMode: 'immediate',
    onError,
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
  expect(onError).toHaveBeenCalledTimes(1)
})

it('waits for timed-out callbacks before retrying or releasing the slot in wait mode', async () => {
  const onError = vi.fn<(error: unknown) => void>()
  const run = protect({
    concurrency: 1,
    maxPending: 1,
    attempts: 2,
    timeout: 100,
    timeoutMode: 'wait',
    onError,
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
  expect(onError).not.toHaveBeenCalled()
  expect(next).not.toHaveBeenCalled()

  second.resolve()
  await expect(timedOut).resolves.toBeInstanceOf(TimeoutError)
  await expect(waiting).resolves.toBe('next')
  expect(onError).toHaveBeenCalledTimes(1)
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
