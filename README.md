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
  timeoutMode: 'immediate',
  concurrency: 8,
  maxPending: 100,
  circuit: {
    threshold: 5,
    cooldown: 30_000,
  },
})

const url = 'https://api.example.com/users/1'
const response = await run(() => fetch(url))
```

`protect()` creates a runner. Pass a callback to run an operation when a concurrency slot is available. Each call returns a promise with the operation's result or error.

Reuse a runner to share concurrency and queue limits across operations. Each runner has independent limits. Without options, operations run once with no timeout or limits.

## Retry

`attempts: 3` allows up to three attempts, including the initial call. By default, `attempts` is `1`: no retries.

Without `backoff`, retries start immediately. To add a delay, provide `backoff.type` and `backoff.delay` in milliseconds. With `'exponential'`, the first retry uses the configured base delay and each subsequent retry doubles it. With `'fixed'`, the base delay stays constant.

`backoff.jitter` is an optional fraction from `0` to `1` that randomly reduces the base delay. With a 1,000 millisecond base delay, `jitter: 0.2` produces delays between 800 and 1,000 milliseconds. It defaults to `0`: no jitter. Use `1` for full jitter between zero and the base delay.

By default, thrown errors and rejected promises trigger retries. `fetch()` resolves for HTTP error responses; throw in your callback to retry them. Only retry operations that are safe to repeat.

## Error policy

Use `errorPolicy` to decide whether an operation error permits another attempt and whether its final failure counts toward the circuit:

```ts
const run = protect({
  attempts: 3,
  errorPolicy: (error) => ({
    retry: isTransient(error),
    countForCircuit: isServiceFailure(error),
  }),
})

await run(writeOperation, {
  errorPolicy: (error) => ({
    retry: false,
    countForCircuit: isServiceFailure(error),
  }),
})
```

The predicates are application-defined. A synchronous policy runs after each failed attempt, including timeout, before retrying. `retry` permits another attempt within the configured limit; `countForCircuit` applies only to the final error. Without a policy, both are `true`.

A policy in the run options replaces the runner's policy for that call. Errors excluded from the circuit are neutral: they neither increase nor reset its failure count. External cancellation and queue or circuit admission errors bypass the policy.

If the policy throws, the call rejects with `ErrorPolicyError`, an `AggregateError` whose `errors` contains the operation error followed by the policy error, and whose `cause` is the operation error. No retry or fallback runs. This is a neutral circuit outcome and releases a probe reservation.

Handle final call errors with `try`/`catch` or `.catch()`.

## Timeout

`timeout` limits each attempt in milliseconds, excluding queue wait and backoff. When it expires, the attempt's signal is aborted with `TimeoutError`. There is no timeout by default.

`timeoutMode` controls when a timed-out attempt ends:

- `'immediate'` (default): without waiting for the callback. The next attempt starts after backoff, or the call rejects and releases its slot if no attempts remain. A callback that ignores its signal can keep running and overlap with later attempts or calls.
- `'wait'`: after the callback settles. Retries do not overlap, but a callback that never settles can block the call indefinitely.

To limit the entire call, including queue wait and backoff, pass an external signal such as `AbortSignal.timeout(15_000)` in the run options.

## Concurrency and queue

`concurrency` defaults to `Infinity`: no limit. A slot stays occupied for the entire operation, including retries and backoff. The limit counts active calls, not callbacks left running after an immediate timeout.

`maxPending` defaults to `0`: no queue. When all concurrency slots are occupied, new calls reject with `QueueFullError` without invoking their callbacks. Set `maxPending > 0` to enable a queue; the limit counts only waiting calls, excluding active ones.

## Circuit breaker

`circuit: { threshold: 5, cooldown: 30_000 }` opens the circuit after five consecutive counted failures, evaluated when each call ends. Success resets the count. Both settings are required; `cooldown` is in milliseconds. Without `circuit`, the breaker is disabled.

While open, new and queued calls reject with `CircuitOpenError` without invoking their callbacks. Already active calls are not cancelled, but their later results do not affect the current circuit state.

After cooldown, one probe call is allowed, using the runner's normal retry and timeout settings. Other calls reject until the probe finishes. Success closes the circuit; failure opens it for another full cooldown. A neutral probe outcome, including cancellation or an error excluded by the policy, allows another probe immediately without closing the circuit or starting another cooldown.

External cancellation, `QueueFullError` and `CircuitOpenError` neither count as failures nor reset the count. Final timeouts count as failures unless excluded by the error policy. With `timeoutMode: 'wait'`, a callback that never settles can also block the probe indefinitely.

Circuit state is shared by all calls on a runner and independent between runners. Use a separate runner for each protected resource.

## Fallback

Pass `fallback` in the run options to use a backup operation after the primary call fails:

```ts
const backupUrl = 'https://backup.example.com/users/1'

const response = await run(() => fetch(url), {
  fallback: () => fetch(backupUrl),
})
```

`fallback(error, { signal })` runs once after the operation's final error, including when retries are disabled by the policy, or immediately when the circuit or queue rejects the call. It can return a value or promise; the returned value becomes the result of `run`. It is not invoked when the primary succeeds, the external signal is aborted or the error policy throws. Disabling retry does not disable fallback; its callback must decide whether recovery is safe.

Fallback does not use the primary runner's retries, timeout or concurrency slot. Use a separate runner to protect the backup operation. A successful fallback does not close the primary circuit or reset its failure count.

If fallback throws or rejects, its error becomes the call's rejection.

Fallback receives the external signal, or a non-aborted signal when none was supplied. This is the call's signal, not an attempt signal aborted by timeout. External cancellation also rejects a call while fallback is running. Forward the fallback context's signal to its operation or backup runner for cooperative cancellation.

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

External cancellation rejects the returned promise. The operation itself must handle the signal to stop running. If the current attempt ignores external cancellation, its slot stays occupied until it settles.

## License

[Apache-2.0](./LICENSE).
