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

export interface ProtectionOptions {
  attempts?: number
  backoff?: BackoffOptions
  timeout?: number
  timeoutMode?: TimeoutMode
  circuit?: CircuitOptions | false
}

export interface ProtectOptions extends ProtectionOptions {
  concurrency?: number
  maxPending?: number
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

export interface RouterErrorDecision extends ErrorDecision {
  failover: boolean
}

export type RouterErrorPolicy = (error: unknown) => RouterErrorDecision

export interface Provider<Resource, Id extends string = string> {
  id: Id
  resource: Resource
  protection?: ProtectionOptions
}

export type Selection<Id extends string = string> =
  | { type: 'priority'; priorities?: Readonly<Partial<Record<Id, number>>> }
  | { type: 'sticky' }

export interface RouterOptions<Resource, Id extends string = string> {
  providers: readonly Provider<Resource, Id>[]
  protection?: ProtectionOptions
  selection?: Selection<NoInfer<Id>>
  errorPolicy?: RouterErrorPolicy
  concurrency?: number
  maxPending?: number
}

export interface ExecuteOptions {
  signal?: AbortSignal
  errorPolicy?: RouterErrorPolicy
}

export interface Router<Resource> {
  execute<Result>(
    operation: (resource: Resource, context: RunContext) => Result,
    options?: ExecuteOptions,
  ): Promise<Awaited<Result>>
}

export type Visit =
  | { providerId: string; status: 'failed'; cause: unknown }
  | { providerId: string; status: 'skipped'; reason: 'circuit-open' | 'probe-busy' }

export interface Runner {
  <Result, Fallback = never>(
    operation: (context: RunContext) => Result,
    options?: RunOptions<Fallback>,
  ): Promise<Awaited<Result> | Awaited<Fallback>>
}
