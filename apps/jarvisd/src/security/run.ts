import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { executePlan, type ShellPlan } from '@jarvis/policy';
import { shellEnv } from '../env.ts';
import type { ScannerId } from './catalogue.ts';

/** Absolute path of an installed scanner, or null. Injected so tests use fake executables. */
export type Locate = (bin: ScannerId) => string | null;

/**
 * Homebrew (Apple Silicon then Intel), ~/.local/bin (pipx/uv), then the absolute entries of the
 * daemon's PATH. Relative PATH entries are ignored: they would depend on the cwd.
 */
export function binaryLocator(o: {
  home: string;
  pathEnv?: string | undefined;
  /** Tests only: replaces the Homebrew directories. */
  fixedDirs?: readonly string[];
}): Locate {
  const dirs = [
    ...new Set(
      [
        ...(o.fixedDirs ?? ['/opt/homebrew/bin', '/usr/local/bin']),
        join(o.home, '.local/bin'),
        ...(o.pathEnv ?? '').split(delimiter),
      ].filter((d) => d && isAbsolute(d)),
    ),
  ];
  return (bin) => {
    for (const d of dirs) {
      const p = join(d, bin);
      try {
        accessSync(p, constants.X_OK);
        if (statSync(p).isFile()) return p;
      } catch {
        // next
      }
    }
    return null;
  };
}

export const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/** A scanner binary living inside the scanned project would be the project's code: refused. */
export function outsideProject(bin: string, root: string): boolean {
  try {
    return !isUnder(realpathSync(bin).toLowerCase(), root.toLowerCase());
  } catch {
    return false;
  }
}

export interface RunResult {
  status: 'ok' | 'timeout' | 'stopped';
  /** Output beyond the cap was dropped (the JSON is then usually unreadable). */
  truncated: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * One argv, no shell: the policy package's executor (spawn, own process group killed on STOP or
 * timeout, capped output), with an environment built from scratch (no secret, fixed PATH).
 */
export async function runArgv(
  bin: string,
  args: readonly string[],
  o: {
    cwd: string;
    home: string;
    env?: Record<string, string>;
    timeoutMs: number;
    signal: AbortSignal;
    maxBytes: number;
  },
): Promise<RunResult> {
  const plan: ShellPlan = {
    source: [bin, ...args].join(' '),
    steps: [{ pipeline: { commands: [{ argv: [bin, ...args], redirects: [] }] }, next: null }],
  };
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const t0 = performance.now();
  const r = await executePlan(plan, {
    cwd: o.cwd,
    signal: AbortSignal.any([o.signal, timeout]),
    maxOutputBytes: o.maxBytes,
    env: { ...shellEnv(o.home), ...o.env },
    pathDirs: [],
    openTarget: () => {
      throw new Error('no redirection in the scanner catalogue');
    },
  });
  const status = o.signal.aborted ? 'stopped' : r.aborted && timeout.aborted ? 'timeout' : 'ok';
  return {
    status,
    truncated: r.truncated,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    ms: performance.now() - t0,
  };
}

/** Semantic version printed by `<tool> --version`, nothing else from its output. */
export function versionOf(text: string): string | null {
  return /\bv?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(text)?.[1] ?? null;
}
