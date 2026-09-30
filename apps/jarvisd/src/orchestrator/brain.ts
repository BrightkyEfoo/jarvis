import type { Session } from '@jarvis/policy';

export interface AskHandlers {
  /** Streamed text as the model produces it (feeds the CLI now, TTS later). */
  onText: (chunk: string) => void;
  onTool?: (name: string) => void;
}

export interface AskResult {
  ok: boolean;
  text: string;
  error?: string;
  ttftMs?: number;
  /** This turn only; client-side estimate at API prices — the subscription is what is used. */
  costUsd?: number;
  turns?: number;
  model?: string;
  route?: { tier: string; reason: string };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

/** The conversational core. Production: ClaudeBrain. Tests: a scripted brain driving the Gate. */
export interface Brain {
  readonly session: Session;
  /** Pre-starts whatever is slow, so the first question is answered fast. */
  warm(): Promise<void>;
  ask(prompt: string, handlers: AskHandlers, trigger: string): Promise<AskResult>;
  /** Interrupts the current turn and tears the model process down (STOP). */
  stop(reason: string): Promise<void>;
  /** Fresh context: drops the conversation, and with it any taint from external content. */
  newSession(): Promise<void>;
  close(): Promise<void>;
}
