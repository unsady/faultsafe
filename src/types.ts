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

export interface RunOptions {
  signal?: AbortSignal
}

export interface Runner {
  <Result>(
    operation: (context: RunContext) => Result,
    options?: RunOptions,
  ): Promise<Awaited<Result>>
}
