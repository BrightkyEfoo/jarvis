import { type Gate, Session } from '@jarvis/policy';
import type { AskHandlers, AskResult, Brain } from '../../apps/jarvisd/src/orchestrator/brain.ts';

/**
 * Stand-in for the model: executes a script of tool calls through the exact Gate path the SDK
 * handlers use. Deterministic, free, and adversarial by construction (it does whatever the
 * test tells it to, like a fully prompt-injected model would).
 *
 *   call <tool> <json>   → gate.invoke
 *   ingest <text>        → the session reads external content (mail, web page…)
 *   say <text>           → streams text as the model would
 *   wait <ms>            → thinks for a while (interruptible, for barge-in tests)
 */
export class ScriptedBrain implements Brain {
  readonly #gate: Gate;
  #session = new Session('user');
  #interrupted = false;

  constructor(gate: Gate) {
    this.#gate = gate;
  }

  get session(): Session {
    return this.#session;
  }

  async warm(): Promise<void> {}

  async ask(prompt: string, h: AskHandlers, trigger: string): Promise<AskResult> {
    let text = '';
    const emit = (s: string) => {
      text += s;
      h.onText(s);
    };
    this.#interrupted = false;
    for (const line of prompt.split('\n')) {
      if (this.#interrupted) return { ok: false, text, error: 'interrupted' };
      const wait = /^wait (\d+)$/.exec(line);
      if (wait) {
        const until = Date.now() + Number(wait[1]);
        while (Date.now() < until && !this.#interrupted) await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      if (line.startsWith('say ')) {
        emit(`${line.slice(4)}\n`);
        continue;
      }
      const call = /^call (\S+) (.*)$/s.exec(line);
      if (call) {
        const [, name = '', json = '{}'] = call;
        h.onTool?.(`mcp__jarvis__${name}`);
        const r = await this.#gate.invoke(name, JSON.parse(json), this.#session, { trigger });
        const imgs = r.images?.length ? ` [images:${r.images.length}]` : '';
        emit(`${r.ok ? 'OK' : 'KO'} ${r.content}${imgs}\n`);
      } else if (line.startsWith('ingest ')) {
        this.#session.ingestExternal(line.slice('ingest '.length));
        emit('ingested\n');
      } else {
        emit(`echo: ${line}\n`);
      }
    }
    return { ok: true, text };
  }

  async stop(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.#interrupted = true;
  }

  async newSession(): Promise<void> {
    this.#session = new Session('user');
  }

  async close(): Promise<void> {}
}
