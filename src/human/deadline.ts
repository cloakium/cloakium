/** One action budget with Playwright's timeout semantics. */

import { errors } from "playwright-core";

import { sleep } from "./config.js";

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

export class Deadline {
  private readonly endsAt: number | null;

  private constructor(readonly timeout: number | undefined) {
    this.endsAt = timeout === 0 ? null : Date.now() + (timeout ?? DEFAULT_ACTION_TIMEOUT_MS);
  }

  /** `undefined` → inherit Playwright's page/context default; `0` → no limit; `n` → n ms. */
  static from(timeout: number | undefined): Deadline {
    if (timeout === undefined) return new Deadline(undefined);
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new errors.TimeoutError(`[cloakium] invalid timeout ${String(timeout)}`);
    }
    return new Deadline(timeout);
  }

  /** Playwright's `timeout` value: ms left, `0` for disabled, `undefined` to inherit. */
  remaining(): number | undefined {
    if (this.timeout === undefined) return undefined;
    if (this.endsAt === null) return 0;
    return Math.max(0, this.endsAt - Date.now());
  }

  expired(): boolean {
    return this.endsAt !== null && Date.now() >= this.endsAt;
  }

  /** As `remaining()`, but a spent budget throws instead of disabling the timeout. */
  forPlaywright(api: string, description: string): number | undefined {
    if (this.expired()) throw this.error(api, description);
    return this.remaining();
  }

  /** `ms`, capped to what is left of the budget. */
  cap(ms: number): number {
    const left = this.remaining();
    return left === undefined ? ms : Math.min(ms, left);
  }

  /** Sleep part of the action; throws when the budget is already spent. */
  async pause(ms: number, api: string, description: string): Promise<void> {
    if (this.expired()) throw this.error(api, description);
    await sleep(this.cap(ms));
  }

  error(api: string, description: string): errors.TimeoutError {
    const total = Math.round(this.timeout ?? DEFAULT_ACTION_TIMEOUT_MS);
    return new errors.TimeoutError(
      `${api}: Timeout ${total}ms exceeded while waiting for ${description}`,
    );
  }
}
