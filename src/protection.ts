import { Circuit } from './circuit.js'
import type { ExecutionOptions } from './retry.js'
import type { ProtectionOptions } from './types.js'

export function configureProtection(
  options: ProtectionOptions = {},
  defaults: ProtectionOptions = {},
): {
  circuit: Circuit | undefined
  execution: ExecutionOptions
} {
  const circuit = options.circuit ?? defaults.circuit
  const backoff = options.backoff ?? defaults.backoff

  return {
    circuit: circuit ? new Circuit({ ...circuit }) : undefined,
    execution: {
      attempts: options.attempts ?? defaults.attempts ?? 1,
      backoff: backoff === undefined ? undefined : { ...backoff, jitter: backoff.jitter ?? 0 },
      timeout: options.timeout ?? defaults.timeout,
      timeoutMode: options.timeoutMode ?? defaults.timeoutMode ?? 'immediate',
      errorPolicy: undefined,
    },
  }
}
