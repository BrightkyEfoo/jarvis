import { basename } from 'node:path';
import { auditIndex, flagValue, isBrowser, shellSegments, shellWords } from './ui.ts';

/**
 * Proof before a pull request: what the worker *really* ran, not what it says it ran. The runner
 * records each check command (tests, lint, typecheck, build, browser checks) with its real outcome
 * from the SDK hooks, and every file edit; the verdict decides whether the PR is ready or a draft
 * marked "non vérifié". Pure, so it is tested without a model.
 */
export interface CheckRun {
  command: string;
  ok: boolean;
  /** Browser checks of a web frontend (ADR-036). */
  ui?: UiCheck;
}

export type UiCheck =
  | { kind: 'capture'; url: string; width: number; height: number; file: string }
  | { kind: 'lighthouse'; url: string; report: string | null }
  | { kind: 'axe'; url: string };

/** Browser audits: they prove the page renders, not that the code is right. */
const AUDIT =
  /^((npx|bunx|pnpm(\s+exec)?|yarn|npm\s+exec)\s+)?(\S*\/)?(lighthouse|axe|pa11y|pa11y-ci)\s/;

/** Tests, lint, typecheck, build: what makes a PR "verified". */
const CORE: RegExp[] = [
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
const CHECKS: RegExp[] = [...CORE, AUDIT];

/** A test, lint, typecheck or build (not a capture or a browser audit). */
export function isCoreCheck(command: string): boolean {
  const c = normalizeCommand(command);
  return CORE.some((re) => re.test(c));
}

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
  return CHECKS.some((re) => re.test(c)) || uiChecks(command).length > 0;
}

/** Absolute paths shortened to their file name: the PR does not show the Mac's folders. */
const short = (a: string) =>
  a.replace(/^(--[\w-]+=)?(\/\S*\/)([^/]+)$/, (_m, flag = '', _dir, file) => `${flag}…/${file}`);

/** A headless Chrome capture or an audit CLI, parsed from one simple command. */
function uiCheck(segment: string): { command: string; ui: UiCheck } | null {
  const argv = shellWords(segment);
  while (argv[0] && /^\w+=/.test(argv[0])) argv.shift();
  const [bin = '', ...args] = argv;
  if (isBrowser(bin)) {
    const file = flagValue(args, '--screenshot');
    if (!file) return null;
    const [width = 800, height = 600] = (flagValue(args, '--window-size') ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    const url = args.find((a) => !a.startsWith('-')) ?? '';
    return {
      command: `chrome --screenshot ${width}x${height} ${url}`,
      ui: { kind: 'capture', url, width, height, file },
    };
  }
  const i = auditIndex(argv);
  if (i < 0) return null;
  const rest = argv.slice(i + 1);
  const url = (rest.find((a) => /^https?:\/\//.test(a)) ?? '').split(',')[0] ?? '';
  const command = normalizeCommand(argv.map(short).join(' '));
  return basename(argv[i] ?? '') === 'lighthouse'
    ? { command, ui: { kind: 'lighthouse', url, report: flagValue(rest, '--output-path') ?? null } }
    : { command, ui: { kind: 'axe', url } };
}

/** Browser checks in a command line, one per chained command (`a && b`). */
export function uiChecks(command: string): { command: string; ui: UiCheck }[] {
  return shellSegments(command).flatMap((s) => uiCheck(s) ?? []);
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class ProofRecorder {
  readonly #events: (
    | { kind: 'check'; command: string; ok: boolean; ui?: UiCheck }
    | { kind: 'edit' }
  )[] = [];

  /**
   * A finished Bash call (backgrounded commands have no outcome yet: not counted). A chain holding
   * browser checks is recorded command by command, each with the chain's outcome.
   */
  bash(command: string, ok: boolean): void {
    const ui = uiChecks(command);
    if (ui.length === 0) {
      if (isCheckCommand(command))
        this.#events.push({ kind: 'check', command: normalizeCommand(command), ok });
      return;
    }
    for (const s of shellSegments(command)) {
      const u = uiCheck(s);
      if (u) this.#events.push({ kind: 'check', command: u.command, ok, ui: u.ui });
      else if (isCheckCommand(s))
        this.#events.push({ kind: 'check', command: normalizeCommand(s), ok });
    }
  }

  tool(name: string): void {
    if (EDIT_TOOLS.has(name)) this.#events.push({ kind: 'edit' });
  }

  /** Last outcome of each check, in first-run order; whether code changed after the last check. */
  result(): { checks: CheckRun[]; editedAfterChecks: boolean } {
    const last = new Map<string, CheckRun>();
    let lastCheck = -1;
    let lastEdit = -1;
    this.#events.forEach((e, i) => {
      if (e.kind === 'check') {
        // Map.set keeps the first-run position of a key: re-running a check updates it in place.
        last.set(e.command, { command: e.command, ok: e.ok, ...(e.ui && { ui: e.ui }) });
        // Only tests, lint, typecheck or build vouch for the code: a later screenshot does not.
        if (!e.ui && isCoreCheck(e.command)) lastCheck = i;
      } else lastEdit = i;
    });
    return {
      checks: [...last.values()],
      editedAfterChecks: lastEdit > lastCheck && last.size > 0,
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
  // Screenshots are listed page by page in "Interface vérifiée": one summary line here.
  const captures = checks.filter((c) => c.ui?.kind === 'capture');
  const lines = checks
    .filter((c) => c.ui?.kind !== 'capture')
    .map((c) => `- ${c.ok ? '✅' : '❌'} \`${c.command.replaceAll('`', "'")}\``);
  if (captures.length) {
    const made = captures.filter((c) => c.ok).length;
    lines.push(
      `- ${made === captures.length ? '✅' : '❌'} captures d’écran : ${made}/${captures.length} produites (détail dans « Interface vérifiée »)`,
    );
  }
  const failing = checks.filter((c) => !c.ok).length;
  const core = checks.filter((c) => !c.ui && isCoreCheck(c.command));
  if (core.length === 0 && failing === 0 && checks.length > 0) {
    return {
      status: 'none',
      markdown: `${lines.join('\n')}\n\n⚠️ **Non vérifié** : des captures ou des audits, mais aucun test, lint ni typecheck. PR ouverte en brouillon.`,
      short: 'non vérifiée (captures seulement, aucun test)',
    };
  }
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
