/**
 * Scrubs secrets from any text before it reaches the model or the audit log.
 * Two layers: exact values we know (registered at startup) and token-shaped patterns.
 */
const PATTERNS: ReadonlyArray<readonly [label: string, re: RegExp]> = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic', /sk-ant-[A-Za-z0-9_-]{10,}/g],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['aws', /\bAKIA[0-9A-Z]{16}\b/g],
  ['google_api', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['google_oauth', /\bya29\.[0-9A-Za-z_-]{20,}/g],
  ['telegram', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

// `password = hunter2`, `DB_PASSWORD=…`, `"api_key": "abc..."` — keep the key, drop the value.
// Lookarounds instead of \b so `_` counts as a separator (DB_PASSWORD).
const ASSIGNMENT =
  /(?<![A-Za-z0-9])(api[_-]?key|secret|token|password|passwd|pwd|auth)(?![A-Za-z0-9])(["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;]{8,})/gi;

const MIN_SECRET_LENGTH = 8;

export class Redactor {
  readonly #known = new Map<string, string>();

  /** Registers an exact secret value. Short values are ignored: they would shred ordinary text. */
  register(label: string, value: string | null | undefined): void {
    if (value && value.length >= MIN_SECRET_LENGTH) this.#known.set(value, label);
  }

  redact(text: string): string {
    let out = text;
    for (const [value, label] of this.#known) {
      if (out.includes(value)) out = out.split(value).join(`[REDACTED:${label}]`);
    }
    for (const [label, re] of PATTERNS) {
      out = out.replace(re, `[REDACTED:${label}]`);
    }
    return out.replace(ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  }
}
