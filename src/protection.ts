import { Circuit } from './circuit.js'
import { CircuitOpenError } from './errors.js'
import { execute as executeAttempts, type ExecutionOptions, type ExecutionResult } from './retry.js'
import type { ProtectionOptions, RunContext } from './types.js'

function configureExecution(
  options: ProtectionOptions,
  defaults: ProtectionOptions,
): ExecutionOptions {
  const backoff = options.backoff ?? defaults.backoff

  return {
    attempts: options.attempts ?? defaults.attempts ?? 1,
    backoff: backoff === undefined ? undefined : { ...backoff, jitter: backoff.jitter ?? 0 },
    timeout: options.timeout ?? defaults.timeout,
    timeoutMode: options.timeoutMode ?? defaults.timeoutMode ?? 'immediate',
    errorPolicy: undefined,
  }
}

type ProtectedResult<Result> = ExecutionResult<Result> | { skipped: CircuitOpenError }

export class Protection {
  private readonly circuit: Circuit | undefined
  private readonly execution: ExecutionOptions

  constructor(
    options: ProtectionOptions = {},
    defaults: ProtectionOptions = {},
    private readonly onUnavailable?: () => void,
  ) {
    const circuit = options.circuit ?? defaults.circuit

    this.circuit = circuit ? new Circuit({ ...circuit }) : undefined
    this.execution = configureExecution(options, defaults)
  }

  check(): void {
    this.circuit?.check()
  }

  async execute<Result>(
    operation: (context: RunContext) => Result,
    signal: AbortSignal,
    errorPolicy: ExecutionOptions['errorPolicy'],
  ): Promise<ProtectedResult<Result>> {
    signal.throwIfAborted()

    let admission: ReturnType<Circuit['enter']> | undefined

    try {
      admission = this.circuit?.enter()
    } catch (error) {
      if (!(error instanceof CircuitOpenError)) {
        throw error
      }

      return { skipped: error }
    }

    const cancel = (): void => {
      if (admission !== undefined) {
        this.circuit?.cancel(admission.generation)
      }
    }

    signal.addEventListener('abort', cancel, { once: true })

    try {
      if (admission?.probe) {
        this.onUnavailable?.()
      }

      const outcome = await executeAttempts(operation, signal, { ...this.execution, errorPolicy })

      signal.throwIfAborted()

      if (admission !== undefined) {
        if (outcome.ok) {
          this.circuit?.succeed(admission.generation)
        } else if (!outcome.countForCircuit) {
          cancel()
        } else if (this.circuit?.fail(admission.generation)) {
          this.onUnavailable?.()
        }
      }

      return outcome
    } catch (error) {
      cancel()
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
}
