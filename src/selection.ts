export class StickySelection<Provider> {
  private readonly providers: readonly Provider[]
  private current: Provider
  private generation = 0

  constructor(first: Provider, others: readonly Provider[]) {
    this.providers = [first, ...others]
    this.current = first
  }

  begin(): { generation: number; candidates: readonly Provider[] } {
    return {
      generation: this.generation,
      candidates: [this.current, ...this.providers.filter((provider) => provider !== this.current)],
    }
  }

  succeed(generation: number, provider: Provider): void {
    if (generation !== this.generation || provider === this.current) {
      return
    }

    this.current = provider
    this.generation += 1
  }
}
