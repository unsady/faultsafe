import { CircuitOpenError } from './errors.js'
import type { CircuitOptions } from './types.js'

export class Circuit {
  private state: 'closed' | 'open' | 'half-open' = 'closed'
  private failures = 0
  private generation = 0
  private until = 0
  private probing = false

  constructor(private readonly options: CircuitOptions) {}

  check(): void {
    if (this.state === 'open') {
      if (Date.now() < this.until) {
        throw new CircuitOpenError()
      }

      this.state = 'half-open'
    }

    if (this.state === 'half-open' && this.probing) {
      throw new CircuitOpenError('probe-busy')
    }
  }

  enter(): { generation: number; probe: boolean } {
    this.check()

    const probe = this.state === 'half-open'

    if (probe) {
      this.probing = true
    }

    return { generation: this.generation, probe }
  }

  succeed(generation: number): void {
    if (generation !== this.generation) {
      return
    }

    if (this.state === 'half-open') {
      this.state = 'closed'
      this.probing = false
      this.generation += 1
    }

    this.failures = 0
  }

  fail(generation: number): boolean {
    if (generation !== this.generation) {
      return false
    }

    this.failures += 1

    if (this.state !== 'half-open' && this.failures < this.options.threshold) {
      return false
    }

    this.state = 'open'
    this.until = Date.now() + this.options.cooldown
    this.generation += 1
    this.probing = false
    return true
  }

  cancel(generation: number): void {
    if (generation !== this.generation || this.state !== 'half-open') {
      return
    }

    this.probing = false
    this.generation += 1
  }
}
