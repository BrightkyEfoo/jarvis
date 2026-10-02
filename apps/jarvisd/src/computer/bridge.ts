import { randomUUID } from 'node:crypto';

export type BrowserApp = 'Arc' | 'Google Chrome';

export const WINDOW_ACTIONS = [
  'front',
  'hide',
  'show',
  'minimize',
  'restore',
  'fullscreen',
  'maximize',
  'left',
  'right',
  'top',
  'bottom',
  'center',
  'close',
] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];

/**
 * What Jarvis.app can be asked to do. The app holds the macOS permissions (Automation,
 * Accessibility, Screen Recording) and runs a fixed catalogue of actions: it never receives
 * script source. Policy decisions are made here, before an action is sent.
 */
export type ActuatorAction =
  | { kind: 'browser.tabs'; browser: BrowserApp }
  | { kind: 'browser.open'; browser: BrowserApp; url: string; newTab: boolean }
  | { kind: 'browser.read'; browser: BrowserApp; mode: 'text' | 'interactive'; maxChars: number }
  | {
      kind: 'browser.click';
      browser: BrowserApp;
      tab: string;
      element: number;
      fingerprint: string;
    }
  | {
      kind: 'browser.fill';
      browser: BrowserApp;
      tab: string;
      element: number;
      fingerprint: string;
      text: string;
    }
  | { kind: 'browser.back'; browser: BrowserApp }
  | { kind: 'notes.list'; query?: string; limit: number }
  | { kind: 'notes.read'; id: string }
  | { kind: 'notes.create'; title: string; body: string; folder?: string }
  | { kind: 'notes.append'; id: string; text: string }
  | { kind: 'reminders.list'; list?: string; includeCompleted: boolean }
  | { kind: 'reminders.add'; title: string; list?: string; due?: string; notes?: string }
  | { kind: 'reminders.complete'; id: string }
  | { kind: 'screen.look'; app?: string; display?: number }
  | { kind: 'apps.windows' }
  | { kind: 'apps.quit'; apps: string[] }
  | { kind: 'window.manage'; app: string; action: WindowAction; display?: number }
  | { kind: 'screen.probe'; app: string; element?: number; x?: number; y?: number }
  | {
      kind: 'screen.act';
      app: string;
      action: 'click' | 'double_click' | 'type' | 'key' | 'scroll';
      element?: number;
      fingerprint?: string;
      x?: number;
      y?: number;
      text?: string;
      key?: string;
      dy?: number;
    };

export type ActionKind = ActuatorAction['kind'];

export interface Actuator {
  readonly connected: boolean;
  readonly info: { version: string; capabilities: string[] } | null;
  /** Resolves with the app's result payload; rejects with its error message. */
  perform(action: ActuatorAction, signal: AbortSignal, timeoutMs?: number): Promise<unknown>;
}

export interface ActuatorLink {
  version: string;
  capabilities: string[];
  send(msg: { reqId: string; action: ActuatorAction } | { reqId: string; cancel: true }): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Jarvis.app connects to the daemon socket and registers as the actuator; requests go down that
 * stream and results come back as `actuator_result`. One actuator at a time: a new registration
 * replaces the old one and fails whatever it had in flight.
 */
export class ActuatorBridge implements Actuator {
  #link: ActuatorLink | null = null;
  readonly #pending = new Map<string, Pending>();

  get connected(): boolean {
    return this.#link !== null;
  }

  get info(): { version: string; capabilities: string[] } | null {
    return this.#link
      ? { version: this.#link.version, capabilities: this.#link.capabilities }
      : null;
  }

  /** Returns the detach function to call when the app's socket closes. */
  attach(link: ActuatorLink): () => void {
    this.#failAll('Jarvis.app reconnected');
    this.#link = link;
    return () => {
      if (this.#link !== link) return;
      this.#link = null;
      this.#failAll('Jarvis.app disconnected');
    };
  }

  /** Called with the app's answer. Unknown ids (late answers after a timeout) are ignored. */
  settle(reqId: string, ok: boolean, result: unknown, error?: string): void {
    const p = this.#pending.get(reqId);
    if (!p) return;
    p.cleanup();
    if (ok) p.resolve(result);
    else p.reject(new Error(error?.slice(0, 500) || 'Jarvis.app failed'));
  }

  /** STOP: tell the app to abandon everything and fail the callers. */
  cancelAll(reason: string): void {
    for (const reqId of this.#pending.keys()) this.#link?.send({ reqId, cancel: true });
    this.#failAll(reason);
  }

  perform(
    action: ActuatorAction,
    signal: AbortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    const link = this.#link;
    if (!link) {
      return Promise.reject(
        new Error(
          'Jarvis.app is not running or not connected: computer control needs it (jarvis app)',
        ),
      );
    }
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    const reqId = randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        link.send({ reqId, cancel: true });
        p.cleanup();
        reject(new Error('aborted'));
      };
      const timer = setTimeout(() => {
        link.send({ reqId, cancel: true });
        p.cleanup();
        reject(new Error(`Jarvis.app did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      const p: Pending = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          this.#pending.delete(reqId);
        },
      };
      this.#pending.set(reqId, p);
      signal.addEventListener('abort', onAbort, { once: true });
      link.send({ reqId, action });
    });
  }

  #failAll(reason: string): void {
    for (const p of [...this.#pending.values()]) {
      p.cleanup();
      p.reject(new Error(reason));
    }
  }
}
