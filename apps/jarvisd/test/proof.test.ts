import { describe, expect, it } from 'vitest';
import { isCheckCommand, ProofRecorder, proofOf, uiChecks } from '../src/workers/proof.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UI = '/Users/b/jarvis-work/.jarvis-workers/ui/t1';
const shot = (w: number, h: number, url = 'http://127.0.0.1:5173/') =>
  `"${CHROME}" --headless=new --disable-gpu --user-data-dir=${UI}/profile --window-size=${w},${h} --screenshot=${UI}/home-${w}.png ${url}`;

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

describe('proof before PR: browser checks (ADR-036)', () => {
  it('counts headless captures, Lighthouse, axe and Playwright as checks, not installs or reads', () => {
    for (const c of [
      shot(375, 812),
      `pnpm exec lighthouse http://127.0.0.1:5173/ --output=json --output-path=${UI}/lh.json`,
      'npx axe http://localhost:3000/',
      'pnpm exec playwright test',
      'npx playwright test e2e/home.spec.ts',
    ])
      expect(isCheckCommand(c), c).toBe(true);
    for (const c of [
      `"${CHROME}" --headless=new --dump-dom http://127.0.0.1:5173/`,
      'pnpm add -D lighthouse',
      'npm install @axe-core/cli',
      'grep -r lighthouse docs',
      'cat lighthouse.json',
    ])
      expect(isCheckCommand(c), c).toBe(false);
  });

  it('parses each capture of a chain: page, size, file; Mac paths stay out of the label', () => {
    expect(
      uiChecks(`${shot(375, 812)} && ${shot(1280, 800, 'http://127.0.0.1:5173/login')}`),
    ).toEqual([
      {
        command: 'chrome --screenshot 375x812 http://127.0.0.1:5173/',
        ui: {
          kind: 'capture',
          url: 'http://127.0.0.1:5173/',
          width: 375,
          height: 812,
          file: `${UI}/home-375.png`,
        },
      },
      {
        command: 'chrome --screenshot 1280x800 http://127.0.0.1:5173/login',
        ui: {
          kind: 'capture',
          url: 'http://127.0.0.1:5173/login',
          width: 1280,
          height: 800,
          file: `${UI}/home-1280.png`,
        },
      },
    ]);
    const [lh] = uiChecks(
      `pnpm exec lighthouse http://127.0.0.1:5173/ --quiet --output-path=${UI}/lh.json`,
    );
    expect(lh).toEqual({
      command: 'pnpm exec lighthouse http://127.0.0.1:5173/ --quiet --output-path=…/lh.json',
      ui: { kind: 'lighthouse', url: 'http://127.0.0.1:5173/', report: `${UI}/lh.json` },
    });
    expect(lh?.command).not.toContain('/Users/');
  });

  it('records chained captures one by one; the PR list sums them up', () => {
    const p = new ProofRecorder();
    p.tool('Edit');
    p.bash('pnpm test', true);
    p.bash(`${shot(375, 812)} && ${shot(768, 1024)}`, true);
    p.bash(shot(375, 812), false);
    const { checks, editedAfterChecks } = p.result();
    expect(editedAfterChecks).toBe(false);
    expect(checks.map((c) => [c.command, c.ok, c.ui?.kind])).toEqual([
      ['pnpm test', true, undefined],
      ['chrome --screenshot 375x812 http://127.0.0.1:5173/', false, 'capture'],
      ['chrome --screenshot 768x1024 http://127.0.0.1:5173/', true, 'capture'],
    ]);
    const proof = proofOf(checks);
    expect(proof.status).toBe('failing');
    expect(proof.markdown).toContain('- ✅ `pnpm test`');
    expect(proof.markdown).toContain('- ❌ captures d’écran : 1/2 produites');
    expect(proof.markdown).not.toContain('Google Chrome');
    expect(proofOf(checks.map((c) => ({ ...c, ok: true }))).short).toBe(
      'vérifiée (3 commandes au vert)',
    );
  });
});
