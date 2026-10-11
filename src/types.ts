export interface BackoffOptions {
  type: 'fixed' | 'exponential'
  delay: number
  jitter?: number
}

export interface CircuitOptions {
  threshold: number
  cooldown: number
}

export type TimeoutMode = 'immediate' | 'wait'

export interface ErrorDecision {
  retry: boolean
  countForCircuit: boolean
}

export type ErrorPolicy = (error: unknown) => ErrorDecision

export interface ProtectOptions {
  attempts?: number
  backoff?: BackoffOptions
  timeout?: number
  timeoutMode?: TimeoutMode
  concurrency?: number
  maxPending?: number
  circuit?: CircuitOptions
  errorPolicy?: ErrorPolicy
}

export interface RunContext {
  signal: AbortSignal
}

export interface RunOptions<Result = unknown> {
  signal?: AbortSignal
  errorPolicy?: ErrorPolicy
  fallback?: (error: unknown, context: RunContext) => Result
}

export interface Runner {
  <Result, Fallback = never>(
    operation: (context: RunContext) => Result,
    options?: RunOptions<Fallback>,
  ): Promise<Awaited<Result> | Awaited<Fallback>>
}
