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

export interface ProtectOptions {
  attempts?: number
  backoff?: BackoffOptions
  timeout?: number
  timeoutMode?: TimeoutMode
  concurrency?: number
  maxPending?: number
  circuit?: CircuitOptions
  onError?: (error: unknown) => void
}

export interface RunContext {
  signal: AbortSignal
}

export interface RunOptions<Result = unknown> {
  signal?: AbortSignal
  fallback?: (error: unknown) => Result
}

export interface Runner {
  <Result, Fallback = never>(
    operation: (context: RunContext) => Result,
    options?: RunOptions<Fallback>,
  ): Promise<Awaited<Result> | Awaited<Fallback>>
}
