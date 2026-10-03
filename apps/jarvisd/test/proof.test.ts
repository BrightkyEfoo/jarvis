import { describe, expect, it } from 'vitest';
import { isCheckCommand, ProofRecorder, proofOf } from '../src/workers/proof.ts';

describe('proof before PR', () => {
  it('recognises check commands, not reads of test files', () => {
    for (const c of [
      'pnpm test',
      'npm run lint',
      'CI=1 pnpm   typecheck',
      'npx vitest run src',
      'pnpm exec tsc -p .',
      'python -m pytest -q',
      'go test ./...',
      'cargo clippy',
      'swift test',
      'make check',
      './gradlew test',
      'bundle exec rspec',
    ])
      expect(isCheckCommand(c), c).toBe(true);
    for (const c of [
      'ls tests/',
      'cat src/test.ts',
      'git status',
      'grep -r test .',
      'echo pnpm test',
    ])
      expect(isCheckCommand(c), c).toBe(false);
  });

  it('keeps the last outcome of each check, and notices edits after the last check', () => {
    const p = new ProofRecorder();
    p.tool('Edit');
    p.bash('pnpm test', false);
    p.tool('Write');
    p.bash('pnpm test', true);
    p.bash('ls', true);
    p.bash('pnpm lint', true);
    expect(p.result()).toEqual({
      checks: [
        { command: 'pnpm test', ok: true },
        { command: 'pnpm lint', ok: true },
      ],
      editedAfterChecks: false,
    });
    p.tool('Edit');
    expect(p.result().editedAfterChecks).toBe(true);
    p.tool('Read');
    expect(new ProofRecorder().result()).toEqual({ checks: [], editedAfterChecks: false });
  });

  it('only a green, up-to-date run is "verified"', () => {
    expect(proofOf([{ command: 'pnpm test', ok: true }]).status).toBe('verified');
    expect(proofOf([]).status).toBe('none');
    expect(proofOf(undefined).short).toBe('non vérifiée (aucun test lancé)');
    expect(proofOf([{ command: 'pnpm test', ok: false }]).status).toBe('failing');
    expect(proofOf([{ command: 'pnpm test', ok: true }], true).status).toBe('stale');
    expect(proofOf([{ command: 'echo `x`', ok: true }]).markdown).toBe("- ✅ `echo 'x'`");
  });
});
