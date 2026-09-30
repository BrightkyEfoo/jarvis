import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { accessSync, closeSync, constants, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { parse as strictParse } from 'sh-syntax';
import { type Pipeline, ShellParseError, type ShellPlan } from './parse.ts';

export interface ExecOptions {
  cwd: string;
  signal: AbortSignal;
  maxOutputBytes: number;
  /** Complete environment for children. Built by the caller: no secrets, fixed PATH. */
  env: Record<string, string>;
  /** Lookup directories for bare command names. */
  pathDirs: readonly string[];
  /** Re-checks a redirect target at open time and returns its canonical path, or throws. */
  openTarget: (target: string, mode: 'read' | 'write') => string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  aborted: boolean;
}

/**
 * Second, independent parser (mvdan/sh via WASM, ~1 ms). Too slow for the classification hot
 * path, so it runs once, right before execution: both parsers must accept the command.
 */
export async function assertStrictSyntax(source: string): Promise<void> {
  try {
    await strictParse(source);
  } catch (e) {
    throw new ShellParseError(
      'shell.syntax_error_strict',
      `strict parser rejected the command: ${String((e as Error).message ?? e).slice(0, 120)}`,
    );
  }
}

type Slot = 'pipe' | 'ignore' | number | Readable;

class Capped {
  readonly #chunks: Buffer[] = [];
  readonly max: number;
  #size = 0;
  truncated = false;

  constructor(max: number) {
    this.max = max;
  }

  push(b: Buffer): void {
    if (this.#size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.#size;
    const part = b.length > room ? b.subarray(0, room) : b;
    if (part.length < b.length) this.truncated = true;
    this.#chunks.push(part);
    this.#size += part.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

function which(name: string, cwd: string, dirs: readonly string[]): string {
  const candidates = name.includes('/') ? [resolve(cwd, name)] : dirs.map((d) => join(d, name));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // try next
    }
  }
  throw new Error(`command not found: ${name}`);
}

const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;

/** SIGINT, then SIGTERM, then SIGKILL, to the whole process group. */
function stopGroup(c: ChildProcess): void {
  const pid = c.pid;
  if (pid === undefined) return;
  const send = (sig: NodeJS.Signals) => {
    if (!running(c)) return;
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone
    }
  };
  send('SIGINT');
  setTimeout(() => send('SIGTERM'), 150).unref();
  setTimeout(() => send('SIGKILL'), 400).unref();
}

function exitOf(c: ChildProcess, errBuf: Capped): Promise<number | null> {
  return new Promise((done) => {
    c.once('error', (e) => {
      errBuf.push(Buffer.from(`${e.message}\n`));
      done(127);
    });
    c.once('close', (code, sig) => done(code ?? (sig ? 128 : null)));
  });
}

async function runPipeline(
  p: Pipeline,
  o: ExecOptions,
  out: Capped,
  err: Capped,
): Promise<number | null> {
  const procs: ChildProcess[] = [];
  const exits: Promise<number | null>[] = [];
  const fds: number[] = [];
  const onAbort = () => {
    for (const c of procs) stopGroup(c);
  };
  o.signal.addEventListener('abort', onAbort, { once: true });

  try {
    let upstream: Readable | null = null;
    p.commands.forEach((cmd, i) => {
      const last = i === p.commands.length - 1;
      let stdin: Slot = upstream ?? 'ignore';
      let stdout: Slot = 'pipe';
      let stderr: Slot = 'pipe';
      let mergeErr = false;

      for (const r of cmd.redirects) {
        if (r.op === 'dup') {
          if (!last)
            throw new ShellParseError(
              'shell.unsupported.dup_mid_pipeline',
              '2>&1 is only supported on the last command',
            );
          mergeErr = true;
          continue;
        }
        const path = o.openTarget(r.target, r.op === '<' ? 'read' : 'write');
        const fd = openSync(path, r.op === '<' ? 'r' : r.op === '>>' ? 'a' : 'w', 0o644);
        fds.push(fd);
        if (r.fd === 0) stdin = fd;
        else if (r.fd === 1) stdout = fd;
        else if (r.fd === 2) stderr = fd;
        else throw new ShellParseError('shell.unsupported.fd', `fd ${r.fd}`);
      }

      const [name = '', ...args] = cmd.argv;
      const bin = which(name, o.cwd, o.pathDirs);
      // detached: own process group, so STOP reaches grandchildren too.
      const spawnOpts: SpawnOptions = {
        cwd: o.cwd,
        env: o.env,
        stdio: [stdin, stdout, stderr],
        detached: true,
      };
      const child = spawn(bin, args, spawnOpts);
      procs.push(child);
      exits.push(exitOf(child, err));

      // The kernel pipe now lives in both children; drop our read end so the writer gets
      // SIGPIPE when the reader exits (`yes | head -1` must terminate).
      upstream?.destroy();
      upstream = null;

      child.stderr?.on('data', (b: Buffer) => (mergeErr ? out : err).push(b));
      if (last) child.stdout?.on('data', (b: Buffer) => out.push(b));
      else if (child.stdout) upstream = child.stdout;
    });
    if (o.signal.aborted) onAbort();
    const codes = await Promise.all(exits);
    return codes.at(-1) ?? null;
  } catch (e) {
    onAbort();
    throw e;
  } finally {
    o.signal.removeEventListener('abort', onAbort);
    for (const fd of fds) closeSync(fd);
  }
}

/** Runs a plan with bash list semantics (&&, ||, ;) and no shell at all. */
export async function executePlan(plan: ShellPlan, o: ExecOptions): Promise<ExecResult> {
  const out = new Capped(o.maxOutputBytes);
  const err = new Capped(Math.min(o.maxOutputBytes, 256 * 1024));
  let exitCode: number | null = 0;

  for (let i = 0; i < plan.steps.length; i++) {
    if (o.signal.aborted) break;
    const connector = i > 0 ? plan.steps[i - 1]?.next : null;
    if (connector === '&&' && exitCode !== 0) continue;
    if (connector === '||' && exitCode === 0) continue;
    const step = plan.steps[i];
    if (step) exitCode = await runPipeline(step.pipeline, o, out, err);
  }
  return {
    exitCode,
    stdout: out.text(),
    stderr: err.text(),
    truncated: out.truncated || err.truncated,
    aborted: o.signal.aborted,
  };
}
