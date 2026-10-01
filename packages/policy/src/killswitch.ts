import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class StopError extends Error {
  override name = 'StopError';
}

/**
 * Global STOP. The flag lives on disk so a crash or reboot does not silently resume work;
 * releasing it is a separate, PIN-guarded step done by the caller.
 */
export class KillSwitch {
  readonly #flagPath: string;
  readonly #listeners = new Set<(reason: string) => void>();
  readonly #releaseListeners = new Set<() => void>();
  #controller = new AbortController();
  #reason: string | null = null;

  constructor(flagPath: string) {
    this.#flagPath = flagPath;
    if (existsSync(flagPath)) {
      this.#reason = readFileSync(flagPath, 'utf8').trim() || 'stop flag present at startup';
      this.#controller.abort(new StopError(this.#reason));
    }
  }

  get engaged(): boolean {
    return this.#reason !== null;
  }

  get reason(): string | null {
    return this.#reason;
  }

  /** Aborted the moment STOP engages. Pass it to every long-running operation. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  engage(reason: string): void {
    if (this.#reason !== null) return;
    this.#reason = reason;
    mkdirSync(dirname(this.#flagPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.#flagPath}.tmp`;
    writeFileSync(tmp, reason, { mode: 0o600 });
    renameSync(tmp, this.#flagPath);
    this.#controller.abort(new StopError(reason));
    for (const fn of this.#listeners) {
      try {
        fn(reason);
      } catch {
        // A failing listener must never prevent the others from stopping.
      }
    }
  }

  release(): void {
    rmSync(this.#flagPath, { force: true });
    this.#reason = null;
    this.#controller = new AbortController();
    for (const fn of this.#releaseListeners) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  }

  onRelease(fn: () => void): () => void {
    this.#releaseListeners.add(fn);
    return () => this.#releaseListeners.delete(fn);
  }

  onEngage(fn: (reason: string) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}
