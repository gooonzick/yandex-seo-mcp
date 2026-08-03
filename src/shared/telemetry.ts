export interface TelemetrySnapshot {
  startedAt: string;
  requests: number;
  successes: number;
  failures: number;
  retries: number;
  cacheHits: number;
  inFlight: number;
  averageDurationMs: number;
  byStatus: Record<string, number>;
  events: Record<string, number>;
}

class Telemetry {
  private readonly startedAt = new Date().toISOString();
  private requests = 0;
  private successes = 0;
  private failures = 0;
  private retries = 0;
  private cacheHits = 0;
  private inFlight = 0;
  private totalDurationMs = 0;
  private readonly byStatus = new Map<string, number>();
  private readonly events = new Map<string, number>();

  public begin(): () => void {
    this.requests += 1;
    this.inFlight += 1;
    const started = performance.now();
    return () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.totalDurationMs += performance.now() - started;
    };
  }

  public success(status: number): void {
    this.successes += 1;
    this.countStatus(status);
  }

  public failure(status: number | string): void {
    this.failures += 1;
    this.countStatus(status);
  }

  public retry(): void {
    this.retries += 1;
  }

  public cacheHit(): void {
    this.cacheHits += 1;
  }

  public event(name: string): void {
    this.events.set(name, (this.events.get(name) ?? 0) + 1);
  }

  public snapshot(): TelemetrySnapshot {
    return {
      startedAt: this.startedAt,
      requests: this.requests,
      successes: this.successes,
      failures: this.failures,
      retries: this.retries,
      cacheHits: this.cacheHits,
      inFlight: this.inFlight,
      averageDurationMs:
        this.requests === 0 ? 0 : Math.round((this.totalDurationMs / this.requests) * 100) / 100,
      byStatus: Object.fromEntries(this.byStatus),
      events: Object.fromEntries(this.events),
    };
  }

  private countStatus(status: number | string): void {
    const key = String(status);
    this.byStatus.set(key, (this.byStatus.get(key) ?? 0) + 1);
  }
}

export const telemetry = new Telemetry();
