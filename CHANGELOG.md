# Changelog

## [0.1.0] - 2026-10-12

### Added

- `protect()` runner with retries, fixed or exponential backoff, and optional jitter.
- Per-attempt timeouts with immediate and wait modes, plus cooperative cancellation via `AbortSignal`.
- Shared concurrency limits and bounded queues.
- Circuit breakers with cooldown and single recovery probes.
- Error policies controlling retries and circuit failure counting, with per-call overrides.
- Per-call fallback operations.
- `createRouter()` with priority or sticky provider selection, automatic failover, and per-provider protection settings.
- Typed errors and ordered routing failure histories.
- TypeScript declarations and an ESM package entry point.
