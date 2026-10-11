import type { Visit } from './types.js'

export class CircuitOpenError extends Error {
  constructor(readonly reason: 'circuit-open' | 'probe-busy' = 'circuit-open') {
    super('The circuit is open')
    this.name = 'CircuitOpenError'
  }
}

export class ErrorPolicyError extends AggregateError {
  constructor(error: unknown, policyError: unknown) {
    super([error, policyError], 'The error policy threw', { cause: error })
    this.name = 'ErrorPolicyError'
  }
}

export class QueueFullError extends Error {
  constructor() {
    super('The pending operation limit has been reached')
    this.name = 'QueueFullError'
  }
}

export class RoutingError extends AggregateError {
  readonly visits: readonly Visit[]

  constructor(visits: readonly Visit[]) {
    super(
      visits.flatMap((visit) => (visit.status === 'failed' ? [visit.cause] : [])),
      'No provider succeeded',
    )
    this.name = 'RoutingError'
    this.visits = visits.map((visit) => ({ ...visit }))
  }
}

export class TimeoutError extends Error {
  constructor(readonly timeout: number) {
    super(`The attempt exceeded its ${timeout} millisecond timeout`)
    this.name = 'TimeoutError'
  }
}
