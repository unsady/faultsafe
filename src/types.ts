export interface BackoffOptions {
  type: 'fixed' | 'exponential'
  delay: number
  jitter?: number
}

export interface ProtectOptions {
  attempts?: number
  backoff?: BackoffOptions
  timeout?: number
  concurrency?: number
  maxPending?: number
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
