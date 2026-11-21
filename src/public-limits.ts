// Limits for the public live run, enforced on the server. One live run at a time, a daily total and a per-IP daily count (UTC days).
// A run is counted from the moment it commits to buying (after the balance check); a refusal before that costs nothing and counts for nothing.
export interface LimitOptions {
  dailyMax?: number;
  perIpMax?: number;
  now?: () => Date;
}

export type Refusal = "busy" | "daily" | "ip";

export interface Ticket {
  /** The run will spend: count it against the day and this IP. */
  commit(): void;
  /** Free the slot. Safe to call twice. A committed run stays counted. */
  release(): void;
}

export class LiveLimiter {
  readonly dailyMax: number;
  readonly perIpMax: number;
  private now: () => Date;
  private day = "";
  private total = 0;
  private perIp = new Map<string, number>();
  private running = false;

  constructor(options: LimitOptions = {}) {
    this.dailyMax = options.dailyMax ?? 20;
    this.perIpMax = options.perIpMax ?? 3;
    this.now = options.now ?? (() => new Date());
  }

  private roll(): void {
    const day = this.now().toISOString().slice(0, 10);
    if (day !== this.day) [this.day, this.total, this.perIp] = [day, 0, new Map()];
  }

  get busy(): boolean {
    return this.running;
  }

  status(ip: string): { day: string; dailyMax: number; usedToday: number; remainingToday: number; perIpMax: number; remainingForYou: number; busy: boolean } {
    this.roll();
    return {
      day: this.day,
      dailyMax: this.dailyMax,
      usedToday: this.total,
      remainingToday: Math.max(0, this.dailyMax - this.total),
      perIpMax: this.perIpMax,
      remainingForYou: Math.max(0, Math.min(this.perIpMax - (this.perIp.get(ip) ?? 0), this.dailyMax - this.total)),
      busy: this.running,
    };
  }

  /** Takes the single run slot if the limits allow. Synchronous, so two requests can never both get it. */
  reserve(ip: string): { ticket: Ticket } | { refused: Refusal } {
    this.roll();
    if (this.running) return { refused: "busy" };
    if (this.total >= this.dailyMax) return { refused: "daily" };
    if ((this.perIp.get(ip) ?? 0) >= this.perIpMax) return { refused: "ip" };
    this.running = true;
    let held = true;
    let committed = false;
    return {
      ticket: {
        commit: () => {
          if (committed) return;
          committed = true;
          this.roll();
          this.total++;
          this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
        },
        release: () => {
          if (held) this.running = held = false;
        },
      },
    };
  }
}

/** Small sliding window for the free demo route, so it cannot be used to burn the server's CPU. */
export class WindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
}
