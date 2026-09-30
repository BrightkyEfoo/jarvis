import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FsPolicy, loadPolicy, type Policy, ShellClassifier } from '../src/index.ts';

export const EXAMPLE_POLICY = resolve(import.meta.dirname, '../../../config/policy.example.yaml');

export interface Fixture {
  home: string;
  work: string;
  outside: string;
  policy: Policy;
  fs: FsPolicy;
  shell: ShellClassifier;
  cleanup: () => void;
}

/** A throwaway $HOME with a workspace, secrets to protect, and a symlink escape. */
export function makeFixture(): Fixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-home-')));
  const work = join(home, 'jarvis-work');
  const outside = join(home, 'Documents');
  for (const d of [
    work,
    join(work, 'src'),
    join(work, '.git', 'hooks'),
    outside,
    join(home, '.ssh'),
    join(home, '.aws'),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(work, 'README.md'), '# demo\n');
  writeFileSync(join(work, '.env'), 'API_KEY=supersecretvalue\n');
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE');
  writeFileSync(join(outside, 'private.txt'), 'nope');
  symlinkSync(join(home, '.ssh'), join(work, 'innocent-link'));
  symlinkSync(outside, join(work, 'docs-link'));

  const policy = loadPolicy({
    path: EXAMPLE_POLICY,
    expectedSha256: null,
    requireSealed: false,
    home,
  });
  const fs = new FsPolicy({
    home,
    readRoots: policy.filesystem.read_roots,
    writeRoots: policy.filesystem.write_roots,
    extraDeny: policy.filesystem.deny,
  });
  const shell = new ShellClassifier(policy.shell, fs);
  return {
    home,
    work,
    outside,
    policy,
    fs,
    shell,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
