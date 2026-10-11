# Faultsafe

## Installation

```sh
npm install faultsafe
```

## Usage

```ts
import { protect } from 'faultsafe'

const run = protect({
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1_000,
    jitter: 0.2,
  },
  timeout: 5_000,
  concurrency: 8,
  maxPending: 100,
  onError: (error) => {
    console.error('Operation failed', error)
  },
})

const url = 'https://api.example.com/users/1'
const response = await run(({ signal }) => fetch(url, { signal }))
```

`protect()` creates a runner. Pass a callback to run an operation when a concurrency slot is available. Each call returns a promise with the operation's result or error.

Reuse a runner to share concurrency and queue limits across operations. Each runner has independent limits. Without options, operations run once with no timeout or limits.

## Retry

`attempts: 3` allows up to three attempts, including the initial call. By default, `attempts` is `1`: no retries.

Without `backoff`, retries start immediately. To add a delay, provide `backoff.type` and `backoff.delay` in milliseconds. With `'exponential'`, the first retry uses the configured base delay and each subsequent retry doubles it. With `'fixed'`, the base delay stays constant.

`backoff.jitter` is an optional fraction from `0` to `1` that randomly reduces the base delay. With a 1,000 millisecond base delay, `jitter: 0.2` produces delays between 800 and 1,000 milliseconds. It defaults to `0`: no jitter. Use `1` for full jitter between zero and the base delay.

Thrown errors and rejected promises trigger retries. `fetch()` resolves for HTTP error responses; throw in your callback to retry them. Only retry operations that are safe to repeat.

`onError(error)` is called once when a call rejects, including cancellation, timeout and queue overflow. If the hook throws, its error replaces the original rejection.

## Timeout

`timeout` is in milliseconds and covers all attempts and retry delays, excluding time in the queue. When it expires, the callback's signal is aborted and the call rejects with `TimeoutError`. There is no timeout by default.

## Concurrency and queue

`concurrency` limits active calls per runner, including calls waiting between retry attempts. `maxPending` limits queued calls, excluding active ones. Both default to `Infinity`.

When the queue is full, new calls reject with `QueueFullError` without invoking their callbacks.

## Cancellation

```ts
const controller = new AbortController()

const result = run(({ signal }) => fetch(url, { signal }), {
  signal: controller.signal,
})

controller.abort()

try {
  await result
} catch (error) {
  console.error(error)
}
```

The callback always receives an `AbortSignal` that is aborted by external cancellation or timeout. Forward it to the operation.

Aborting a queued call removes it from the queue and frees its pending slot. An already aborted signal rejects without invoking the callback. External cancellation rejects with the supplied signal's reason and prevents further attempts.

Cancellation and timeout reject the returned promise. The operation itself must handle the signal to stop running; its concurrency slot stays occupied until it settles.

## License

[Apache-2.0](./LICENSE).
