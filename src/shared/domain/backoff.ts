export interface BackoffPolicy {
  /** Espera antes da tentativa número `attempt` (começa em 1: o primeiro retry é a tentativa 1). */
  delayMs(attempt: number): number;
}

/**
 * `min(maxMs, baseMs * 2^(attempt-1))`, opcionalmente com "equal jitter"
 * (metade fixa, metade aleatória) para os retries de várias instâncias não se alinharem.
 */
export class ExponentialBackoff implements BackoffPolicy {
  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly jitter: boolean = true,
    private readonly random: () => number = Math.random,
  ) {}

  delayMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(exponent, 30));
    if (!this.jitter) return raw;
    const half = raw / 2;
    return Math.round(half + this.random() * half);
  }
}
