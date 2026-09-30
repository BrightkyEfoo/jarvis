import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertStrictSyntax,
  type ExecOptions,
  executePlan,
  parseShell,
  ShellParseError,
} from '../src/index.ts';
import { type Fixture, makeFixture } from './fixture.ts';

let f: Fixture;
beforeAll(() => {
  f = makeFixture();
});
afterAll(() => f.cleanup());

const PATH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function opts(signal = new AbortController().signal, maxOutputBytes = 1_000_000): ExecOptions {
  return {
    cwd: f.work,
    signal,
    maxOutputBytes,
    env: { PATH: PATH_DIRS.join(':'), HOME: f.home, LANG: 'en_US.UTF-8' },
    pathDirs: PATH_DIRS,
    openTarget: (target, mode) => {
      const c = f.fs.check(target, mode, f.work);
      if (c.level >= 4) throw new Error(c.reason);
      return c.path;
    },
  };
}

const run = (cmd: string, o = opts()) => executePlan(parseShell(cmd, f.home), o);

describe('executePlan', () => {
  it('runs a simple command without a shell', async () => {
    const r = await run('echo "a b"');
    expect(r).toMatchObject({ exitCode: 0, stdout: 'a b\n' });
  });

  it('connects pipelines through kernel pipes', async () => {
    const names = (await run('ls -1')).stdout.trim().split('\n');
    const r = await run('ls -1 | wc -l');
    expect(r.exitCode).toBe(0);
    expect(Number(r.stdout.trim())).toBe(names.length);
  });

  it('terminates `yes | head -1` (SIGPIPE reaches the writer)', async () => {
    const t0 = performance.now();
    const r = await run('yes | head -1');
    expect(r.stdout).toBe('y\n');
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('honours && || ; semantics', async () => {
    expect((await run('false && echo no; echo yes')).stdout).toBe('yes\n');
    expect((await run('false || echo fallback')).stdout).toBe('fallback\n');
    expect((await run('true || echo skipped')).stdout).toBe('');
    expect((await run('false && echo a || echo b')).stdout).toBe('b\n');
  });

  it('applies file redirects and 2>&1', async () => {
    await run('echo first > out.txt');
    await run('echo second >> out.txt');
    expect(readFileSync(join(f.work, 'out.txt'), 'utf8')).toBe('first\nsecond\n');
    const r = await run('ls missing-file 2>&1');
    expect(r.stdout).toMatch(/No such file/);
    expect(r.stderr).toBe('');
  });

  it('re-checks redirect targets when opening them', async () => {
    await expect(run('echo x > ../Documents/pwned.txt')).rejects.toThrow(/outside/);
  });

  it('caps captured output', async () => {
    const r = await run('yes | head -100000', opts(undefined, 1000));
    expect(r.stdout).toHaveLength(1000);
    expect(r.truncated).toBe(true);
  });

  it('kills the whole process group on STOP within 500 ms', async () => {
    const ctl = new AbortController();
    const t0 = performance.now();
    const pending = run('sleep 30', opts(ctl.signal));
    setTimeout(() => ctl.abort(), 50);
    const r = await pending;
    expect(r.aborted).toBe(true);
    expect(performance.now() - t0).toBeLessThan(550);
  });

  it('reports unknown commands', async () => {
    await expect(run('definitely-not-a-command')).rejects.toThrow(/command not found/);
  });
});

describe('assertStrictSyntax', () => {
  it('accepts what tree-sitter accepts and rejects broken input', async () => {
    await expect(assertStrictSyntax('git log --oneline | head -5 && ls')).resolves.toBeUndefined();
    await expect(assertStrictSyntax('echo $(')).rejects.toThrow(ShellParseError);
  });
});
