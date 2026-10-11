# Provider routing

Status: design draft. The API sketches are not implemented contracts.

## Purpose

Execute an operation through interchangeable providers, such as proxy services. Every provider receives full protection: retries, backoff, attempt timeouts and an independent circuit. A router chooses providers, switches after failures and manages the logical request.

Provider selection can follow fixed order, explicit priorities, a retained current provider, rotation or observed reliability. These are alternative selection policies over the same protection and execution lifecycle.

`protect()` remains an independent API. Routing configuration uses provider objects, not manually constructed `protect()` runners. Internal protection mechanisms can be reused without exposing that composition to users.

## API direction

```ts
const router = createRouter({
  providers: [
    { id: 'a', resource: clientA },
    { id: 'b', resource: clientB },
    {
      id: 'c',
      resource: clientC,
      protection: { attempts: 2 },
    },
  ],
  protection: {
    attempts: 3,
    timeout: 5_000,
    circuit: { threshold: 5, cooldown: 30_000 },
  },
  selection: {
    type: 'priority',
    priorities: { a: 30, c: 20, b: 10 },
  },
  errorPolicy: decideError,
  concurrency: 8,
  maxPending: 100,
})

const response = await router.execute((client, { signal }) => client.fetch(url, { signal }), {
  signal: controller.signal,
})
```

The router is an object with an `execute` method. Each call supplies an operation, which receives the selected provider's resource and a context containing an `AbortSignal`. Its result type is inferred separately for each call; there is no router-specific request type.

`clientA`, `clientB` and `clientC` are application-owned clients. The callback's `client` is whichever resource the router selects. Resources need a compatible interface; adapters can normalize different SDKs.

Different operations share provider circuits, selection state and the queue. Use the same router only when those operations should share a provider health assessment.

Router-level `protection` supplies shared settings, while a provider's `protection` overrides them. Shared settings do not imply shared circuit state. Each provider has its own retry budget; there is no combined attempt budget in this contract.

Stable, unique IDs identify providers in circuit state, statistics, priorities and error reports. Array order supplies a default order; it is not the only way to express preference. In the example, explicit priorities prefer A, then C, then B, independently of their array positions.

`selection` groups each policy with its settings. Its type should distinguish policy variants so priority settings cannot be supplied to sticky or round-robin selection:

```ts
selection: {
  type: 'ordered'
}
selection: {
  type: 'sticky'
}
selection: {
  type: 'round-robin'
}
```

Adaptive selection's settings depend on the observation and scoring rules described below.

## Responsibilities

### Provider protection

Own attempt execution, retries, backoff, attempt timeouts and circuit transitions. Track each provider independently. One provider's success must not reset another provider's failure history.

### Selection policy

Choose or rank candidates, decide whether to retain a successful provider and determine when to revisit a preferred or less-observed provider. Selection uses protection outcomes and statistics, but does not implement circuit transitions.

### Router

Own request admission, traversal, shared concurrency and queueing, external cancellation, result delivery and error reporting. Coordinate candidate selection with atomic circuit admission.

## Error policy

Retrying the operation, switching providers and counting a circuit failure are independent decisions. The `errorPolicy` callback determines how to handle operation errors:

```ts
function decideError(error: unknown) {
  if (isTemporaryConflict(error)) {
    return {
      retry: true,
      failover: false,
      countForCircuit: false,
    }
  }

  const providerFailure = isProviderFailure(error)

  return {
    retry: providerFailure,
    failover: providerFailure,
    countForCircuit: providerFailure,
  }
}
```

The predicates are application rules, not router exports. In this example, temporary conflicts can be retried on the same provider without damaging its circuit. Provider errors permit retries and failover and count toward the circuit after the visit fails. Other errors stop the request without affecting provider health.

- `retry` permits another attempt within the selected provider's remaining budget.
- `failover` permits switching when no further local retry will be made, either because retries are disabled for the error or the budget is exhausted.
- `countForCircuit` determines whether the visit's final error counts as a provider failure. Intermediate retry errors are not counted separately.

An individual call can override the router's default `errorPolicy`:

```ts
await router.execute(operation, {
  signal,
  errorPolicy: decideWriteError,
})
```

The override replaces the policy for that call, including all provider visits; it is not merged with the default policy's decisions. This lets different operations share provider protection state while controlling whether they can safely be repeated. A read may permit retries after a lost connection, while a write with an unknown result may forbid both retry and failover.

External cancellation, router admission errors and circuit rejection bypass operation error classification. Circuit rejection skips the candidate; cancellation and admission errors reject directly.

If `errorPolicy` throws, stop the request without retries or failover. Treat the provider health outcome as neutral, release any logical probe reservation and complete the internal execution lifecycle under the normal callback and slot-release rules. Report both the original operation error and the policy error; the exact error shape remains open.

## Selection policies

### Ordered traversal

Try providers in list order for every request. Apply the selected provider's retries and error policy before moving to the next candidate. Return the first success.

There is no retained current provider. The next request starts from the beginning again, skipping candidates rejected by their circuits.

### Explicit priority

Prefer the highest-priority candidate, with list order as a deterministic tie-breaker. Explicit priorities allow a provider's preference to change without changing its identity or protection state.

After a preferred provider's cooldown, a real request can act as its half-open probe. While that probe is occupied, other requests continue through lower-priority providers. A successful probe restores normal preference; a classified provider failure opens the circuit again.

For example, traffic moves from A to B while A's circuit is open. After cooldown, one request checks A. Success returns preference to A; a classified provider failure keeps traffic on another provider.

Whether priority updates affect an already-running traversal or only subsequent selections must be defined before exposing runtime updates.

### Sticky selection

Retain the provider that succeeds and begin subsequent requests there. Switch when the current provider's visit fails with failover permitted or its circuit rejects admission.

For example, A fails and B succeeds. B remains current even when A's cooldown expires. A becomes eligible for another visit, but cooldown alone does not cause a return to A.

Concurrent recovery needs a deterministic rule for which successful switch becomes current. A late result must not overwrite a newer selection blindly.

### Round-robin

Rotate the starting candidate between requests, skipping circuit-rejected candidates and trying alternatives after final failure when classification permits failover. Rotation must not allow revisiting a provider within the same request.

Define how concurrent admissions advance rotation and how failed or cancelled requests affect it.

### Adaptive selection

Use observed reliability and latency to prefer a suitable provider rather than relying only on fixed order or a retained choice.

The design must account for:

- Sample size and confidence before trusting a provider's score.
- Aging observations and recovery from past failures.
- Exploration of less-used providers so their statistics do not remain stale.
- Stability, so small or temporary differences do not cause constant switching.
- The relative cost of errors, latency and retries.

No scoring formula is selected yet.

Exploration can use eligible real requests. Background probing would need a separate, explicitly safe health-check operation. Do not duplicate arbitrary user requests merely to gather statistics.

## Traversal and protection contract

- Visit each provider at most once per logical request. A visit includes that provider's retries and backoff; individual retry attempts are not separate visits.
- On a visit's final error, select an unvisited candidate only if classification permits failover; otherwise reject with that error. Circuit rejection skips to an unvisited candidate. Return the first successful result. Do not cycle through already-visited providers.
- Count a visit's final error toward its circuit only when classification marks it as a provider failure. Do not count each failed attempt separately. Intermediate attempt errors remain available in statistics even when the visit's final outcome is neutral.
- External cancellation, router admission errors and circuit rejection do not count as provider failures. Final attempt timeouts are classified like other operation errors.
- A final failure need not open a circuit immediately: the configured failure threshold still applies. Selection policy can switch before that threshold is reached.
- Apply circuit changes before reporting the outcome to selection or user hooks. Ignore results from obsolete circuit generations.

Circuit admission is atomic when a visit starts. An open circuit or an occupied half-open probe skips that candidate without executing its handler. A separate availability check must not be required for correctness.

Status reads can inform selection and observability, but are advisory. Another request may reserve a probe after a status read. The router must handle admission rejection by selecting another candidate.

Circuit health has three outcomes: success, failure and neutral. A final error with `countForCircuit: false` is neutral: it neither increments nor resets the failure count. Thus `failure → neutral → failure` represents two consecutive counted failures. Cancellation and policy exceptions are also neutral.

A half-open probe uses the provider's ordinary retry and timeout settings and the call's effective error policy. Success closes the circuit; a classified provider failure starts another cooldown. A neutral outcome releases the logical probe reservation without closing the circuit or starting another cooldown. The circuit remains half-open and another request may probe immediately. An uncooperative, cancelled callback may still be running.

## Exhaustion errors

When all candidates have failed or been skipped, reject with a structured routing error containing the ordered visit history. Each entry identifies the provider and distinguishes:

- `failed`: the visit ended with an operation error; preserve that cause.
- `skipped`: circuit admission rejected the visit; distinguish an open circuit from an occupied half-open probe.

This must distinguish all providers failing, a mix of failures and skipped candidates, and no provider being admitted. The exact error class and field names remain open.

External cancellation, queue overflow and an operation error with `failover: false` reject directly rather than being wrapped as candidate exhaustion. A policy exception reports the operation and policy errors separately from exhaustion.

## Shared queue and concurrency

One router queue and concurrency limit govern entire logical requests. Hold one slot across provider visits, retries, backoff and switches. A switch must not enqueue the same request again or reacquire its router slot.

Provider-specific capacity limits may be useful in addition to the shared limit. Their interaction with candidate selection and waiting remains an open design question; they must not replace the shared request lifecycle.

## Cancellation and timeout lifecycle

External cancellation covers queue wait, attempts, backoff and switching. It rejects the public promise promptly and prevents starting another retry or provider. Queued cancellation removes the request without invoking a handler.

The public promise and the internal execution lifecycle are distinct. Cancellation of an active request must not release its router slot merely because the public promise rejected; the current callback can still be running.

Preserve the provider's timeout mode:

- **Immediate:** abort the attempt's signal and end the logical attempt without waiting for the callback. Retries or other providers can start while a detached callback is still running. Release the slot when the logical traversal finishes.
- **Wait:** abort the attempt's signal and wait for the callback to settle before retrying or switching. An uncooperative callback can stall the request or probe indefinitely.

Callbacks detached by an immediate timeout are not awaited again at the end of traversal. Concurrency limits logical requests, not every physical callback left running after timeout. Only route operations that are safe to repeat.

An external deadline can bound the entire request across providers; an attempt timeout applies only to its provider attempt.

## Statistics and observability

Keep observations associated with provider IDs, independently of array order. Distinguish provider health from router-level outcomes: a successful request through B does not turn A's failed visit into a success.

Useful observations include final visit successes and failures, timeouts, attempt counts, latency and circuit transitions. Cancellation, circuit rejection and errors excluded from provider health must be distinguishable from resource failures.

Define whether latency includes retries and backoff, which observations adaptive selection consumes and how samples age. Queue wait should not be mistaken for provider execution latency.

Expose sufficient state and outcomes for inspection without exposing a mutable circuit or treating a status snapshot as permission to execute.

## Implementation boundary

Reuse internal protection mechanisms rather than nesting public `protect()` runners. A nested runner's public promise can reject on cancellation before its callback settles, causing an outer runner to release a concurrency slot prematurely.

Share the lifecycle model between selection policies. Ordered traversal, sticky, priority, round-robin and adaptive selection must not each reimplement retries, circuit admission or cancellation.

The existing per-call fallback API is independent.

## Open decisions

- Exact resource and operation context types.
- Whether custom policies need a public extension contract.
- Default error policy and the error shape preserving both operation and policy exceptions.
- Deterministic sticky and round-robin behavior under concurrent requests.
- Exact routing error shape for ordered failed and skipped visits.
- Provider-specific capacity limits and their interaction with selection.
- Statistics windows, exploration, confidence and stability rules for adaptive selection.
- Runtime priority changes, provider replacement and preservation or reset of protection state.
- Inheritance rules for nested protection settings and explicitly disabling an inherited circuit.
