import { type Gate, Session } from '@jarvis/policy';
import type { AskHandlers, AskResult, Brain } from '../../apps/jarvisd/src/orchestrator/brain.ts';

/**
 * Stand-in for the model: executes a script of tool calls through the exact Gate path the SDK
 * handlers use. Deterministic, free, and adversarial by construction (it does whatever the
 * test tells it to, like a fully prompt-injected model would).
 *
 *   call <tool> <json>   → gate.invoke
 *   ingest <text>        → the session reads external content (mail, web page…)
 */
export class ScriptedBrain implements Brain {
  readonly #gate: Gate;
  #session = new Session('user');

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
    for (const line of prompt.split('\n')) {
      const call = /^call (\S+) (.*)$/s.exec(line);
      if (call) {
        const [, name = '', json = '{}'] = call;
        h.onTool?.(`mcp__jarvis__${name}`);
        const r = await this.#gate.invoke(name, JSON.parse(json), this.#session, { trigger });
        emit(`${r.ok ? 'OK' : 'KO'} ${r.content}\n`);
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

  async newSession(): Promise<void> {
    this.#session = new Session('user');
  }

  async close(): Promise<void> {}
}
