export class CircuitOpenError extends Error {
  constructor() {
    super('The circuit is open')
    this.name = 'CircuitOpenError'
  }
}

export class QueueFullError extends Error {
  constructor() {
    super('The pending operation limit has been reached')
    this.name = 'QueueFullError'
  }
}

export class TimeoutError extends Error {
  constructor(readonly timeout: number) {
    super(`The attempt exceeded its ${timeout} millisecond timeout`)
    this.name = 'TimeoutError'
  }
}
