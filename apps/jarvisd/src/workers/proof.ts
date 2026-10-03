/**
 * Proof before a pull request: what the worker *really* ran, not what it says it ran. The runner
 * records each check command (tests, lint, typecheck, build) with its real outcome from the SDK
 * hooks, and every file edit; the verdict decides whether the PR is ready or a draft marked
 * "non vérifié". Pure, so it is tested without a model.
 */
export interface CheckRun {
  command: string;
  ok: boolean;
}

const CHECKS: RegExp[] = [
  /^(pnpm|npm|yarn|bun)\s+(run\s+)?(test|tests|lint|typecheck|type-check|check|build|verify|e2e|test:\S+|lint:\S+)\b/,
  /^((npx|bunx|pnpm\s+(exec|dlx))\s+)?(vitest|jest|mocha|ava|tsc|tsgo|eslint|biome|stylelint|playwright\s+test|cypress\s+run)\b/,
  /^(python3?\s+-m\s+)?(pytest|unittest|ruff|mypy|pyright|flake8|black\s+--check)\b/,
  /^go\s+(test|vet|build)\b/,
  /^cargo\s+(test|clippy|check|build)\b/,
  /^swift\s+(test|build)\b/,
  /^xcodebuild\b.*\btest\b/,
  /^make\s+(test|check|lint|build)\b/,
  /^(\.\/)?gradlew?\s+(test|check|build)\b/,
  /^mvn\s+(test|verify)\b/,
  /^(bundle\s+exec\s+)?(rspec|rubocop|rake\s+test)\b/,
  /^(vendor\/bin\/)?(phpunit|phpstan|pest)\b/,
  /^deno\s+(test|lint|check)\b/,
  /^dotnet\s+(test|build)\b/,
  /^flutter\s+(test|analyze)\b/,
];

/** "CI=1  pnpm   test" → "pnpm test" (environment prefixes and spacing do not matter). */
export function normalizeCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(\w+=\S*\s+)+/, '')
    .slice(0, 160);
}

export function isCheckCommand(command: string): boolean {
  const c = normalizeCommand(command);
  return CHECKS.some((re) => re.test(c));
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class ProofRecorder {
  readonly #events: ({ kind: 'check'; command: string; ok: boolean } | { kind: 'edit' })[] = [];

  /** A finished Bash call (backgrounded commands have no outcome yet: not counted). */
  bash(command: string, ok: boolean): void {
    if (isCheckCommand(command))
      this.#events.push({ kind: 'check', command: normalizeCommand(command), ok });
  }

  tool(name: string): void {
    if (EDIT_TOOLS.has(name)) this.#events.push({ kind: 'edit' });
  }

  /** Last outcome of each check, in first-run order; whether code changed after the last check. */
  result(): { checks: CheckRun[]; editedAfterChecks: boolean } {
    const last = new Map<string, boolean>();
    let lastCheck = -1;
    let lastEdit = -1;
    this.#events.forEach((e, i) => {
      if (e.kind === 'check') {
        last.set(e.command, e.ok);
        lastCheck = i;
      } else lastEdit = i;
    });
    return {
      checks: [...last].map(([command, ok]) => ({ command, ok })),
      editedAfterChecks: lastCheck >= 0 && lastEdit > lastCheck,
    };
  }
}

export type ProofStatus = 'verified' | 'failing' | 'stale' | 'none';

export interface Proof {
  status: ProofStatus;
  /** For the PR body. */
  markdown: string;
  /** For the task step, the dashboard, the island and the voice. */
  short: string;
}

export function proofOf(checks: readonly CheckRun[] = [], editedAfterChecks = false): Proof {
  const lines = checks.map((c) => `- ${c.ok ? '✅' : '❌'} \`${c.command.replaceAll('`', "'")}\``);
  const failing = checks.filter((c) => !c.ok).length;
  if (checks.length === 0) {
    return {
      status: 'none',
      markdown:
        '⚠️ **Non vérifié** : le worker n’a lancé aucun test, lint ni typecheck. PR ouverte en brouillon.',
      short: 'non vérifiée (aucun test lancé)',
    };
  }
  if (failing > 0) {
    return {
      status: 'failing',
      markdown: `${lines.join('\n')}\n\n⚠️ **${failing} vérification(s) en échec** à la fin du travail. PR ouverte en brouillon.`,
      short: `${failing} vérification(s) en échec`,
    };
  }
  if (editedAfterChecks) {
    return {
      status: 'stale',
      markdown: `${lines.join('\n')}\n\n⚠️ **Du code a été modifié après la dernière vérification.** PR ouverte en brouillon.`,
      short: 'modifiée après les tests',
    };
  }
  return {
    status: 'verified',
    markdown: lines.join('\n'),
    short: `vérifiée (${checks.length} commande${checks.length > 1 ? 's' : ''} au vert)`,
  };
}
