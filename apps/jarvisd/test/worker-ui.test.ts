import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { workerGuard } from '../src/workers/guard.ts';
import { ProofRecorder } from '../src/workers/proof.ts';
import { workerRules, workerSandbox } from '../src/workers/runner.ts';
import {
  confirmCaptures,
  detectUi,
  keepCaptures,
  lighthouseScores,
  type UiProbe,
  type UiRun,
  uiEnv,
  uiRules,
  uiSection,
} from '../src/workers/ui.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

/** A fake disk: no real Chrome, no real repository needed. */
function probe(files: Record<string, string>, exists: string[] = []): UiProbe {
  return {
    exists: (p) => exists.includes(p) || p in files,
    read: (p) => files[p] ?? null,
    list: (d) =>
      Object.keys(files)
        .filter((f) => f.startsWith(`${d}/`))
        .map((f) => f.slice(d.length + 1).split('/')[0] ?? '')
        .filter((n, i, a) => n && a.indexOf(n) === i),
  };
}
const pkg = (dev: Record<string, string>, deps: Record<string, string> = {}) =>
  JSON.stringify({ dependencies: deps, devDependencies: dev });

let tmp: string;
let ui: UiRun;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'jvui-')));
  const dir = join(tmp, 'ui', 't1');
  mkdirSync(dir, { recursive: true });
  ui = {
    frameworks: ['Vite'],
    chrome: CHROME,
    tools: { playwright: false, lighthouse: true, axe: false },
    notes: ['axe n’est pas une dépendance du projet : accessibilité non auditée automatiquement.'],
    dir,
    ports: [5173, 6006],
    widths: [375, 768, 1280],
  };
});

describe('detection at run time (nothing installed, nothing downloaded)', () => {
  it('finds a Next.js app in a monorepo, the Mac’s Chrome and the declared audit tools', () => {
    const env = detectUi(
      '/w',
      '/Users/b',
      probe(
        {
          '/w/package.json': pkg({ '@playwright/test': '1.63.0' }),
          '/w/apps/web/package.json': pkg(
            { '@axe-core/playwright': '4.13.0' },
            { next: '16', 'react-dom': '19' },
          ),
          '/w/apps/api/package.json': pkg({}, { express: '5' }),
        },
        [CHROME],
      ),
    );
    expect(env).toEqual({
      frameworks: ['Next.js'],
      chrome: CHROME,
      tools: { playwright: true, lighthouse: false, axe: true },
      notes: [
        'Lighthouse n’est pas une dépendance du projet : pas de scores (rien n’est téléchargé).',
      ],
    });
  });

  it('a backend or a React Native app is not a web frontend: no UI checks', () => {
    expect(detectUi('/w', '/h', probe({ '/w/package.json': pkg({}, { express: '5' }) }))).toBe(
      null,
    );
    expect(
      detectUi(
        '/w',
        '/h',
        probe({ '/w/package.json': pkg({}, { react: '19', 'react-native': '0.80' }) }),
      ),
    ).toBe(null);
    expect(detectUi('/w', '/h', probe({}))).toBe(null);
  });

  it('says in French what is missing: no Chrome, no Lighthouse, no axe', () => {
    const env = detectUi('/w', '/h', probe({ '/w/package.json': pkg({ vite: '7' }) }));
    expect(env?.frameworks).toEqual(['Vite']);
    expect(env?.chrome).toBe(null);
    expect(env?.notes).toEqual([
      'Google Chrome est introuvable dans /Applications : aucune capture d’écran.',
      'Lighthouse n’est pas une dépendance du projet : pas de scores (rien n’est téléchargé).',
      'axe n’est pas une dépendance du projet : accessibilité non auditée automatiquement.',
    ]);
  });
});

describe('the worker only changes when UI checks are on', () => {
  const o = {
    home: '/Users/b',
    tmpDir: '/w/tmp',
    cacheDir: '/w/cache',
    network: ['registry.npmjs.org'],
    denyRead: ['/Users/b/.ssh'],
  };

  it('off: exactly the S6 sandbox and rules', () => {
    expect(workerSandbox(o, { worktree: '/w/wt' })).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ['registry.npmjs.org'] },
      filesystem: { allowWrite: ['/w/wt', '/w/tmp', '/w/cache'], denyRead: ['/Users/b/.ssh'] },
    });
    const rules = workerRules();
    expect(rules).toContain('The network only reaches package registries.');
    expect(rules).not.toMatch(/Chrome|127\.0\.0\.1|screenshot/i);
  });

  it('on: loopback binding for the dev server, the task folder writable, browser profiles unreadable', () => {
    const s = workerSandbox(o, { worktree: '/w/wt', ui });
    expect(s.enabled && s.failIfUnavailable && !s.allowUnsandboxedCommands).toBe(true);
    expect(s.network?.allowLocalBinding).toBe(true);
    // Never a domain: loopback is not reachable through the proxy allowlist.
    expect(s.network?.allowedDomains).toEqual(['registry.npmjs.org']);
    expect(s.network?.allowUnixSockets).toBeUndefined();
    expect(s.network?.allowAllUnixSockets).toBeUndefined();
    expect(s.network?.allowMachLookup).toContain('com.google.Chrome.MachPortRendezvousServer.*');
    expect(s.filesystem?.allowWrite).toEqual(['/w/wt', '/w/tmp', '/w/cache', ui.dir]);
    expect(s.filesystem?.denyRead).toEqual(
      expect.arrayContaining([
        '/Users/b/.ssh',
        '/Users/b/Library/Application Support/Google/Chrome',
        '/Users/b/Library/Application Support/Arc',
      ]),
    );
    expect(s.allowAppleEvents).toBeUndefined();
    expect(s.excludedCommands).toBeUndefined();
  });

  it('on: the rules teach the commands the guard accepts, with no download', () => {
    const rules = workerRules(ui);
    expect(rules.startsWith(workerRules())).toBe(true);
    expect(rules).toContain('Vite');
    expect(rules).toContain('5173, 6006');
    expect(rules).toContain('Not in this project: axe. Never install or download them');
    const guard = workerGuard({
      worktree: join(tmp, 'wt'),
      home: tmp,
      extraDeny: [],
      ui: { ports: ui.ports, dir: ui.dir, tools: ui.tools },
    });
    const examples = [...uiRules(ui).matchAll(/^ {2}("\/Applications.*)$|`(pnpm exec .*?)`/gm)]
      .map((m) => m[1] ?? m[2] ?? '')
      .filter((c) => c.includes('--screenshot') || c.includes('lighthouse'));
    expect(examples).toHaveLength(2);
    for (const command of examples)
      expect(guard('Bash', { command }), command).toMatchObject({ allow: true });
    expect(uiEnv(ui)).toEqual({
      PUPPETEER_SKIP_DOWNLOAD: '1',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      CHROME_PATH: CHROME,
      PUPPETEER_EXECUTABLE_PATH: CHROME,
    });
    expect(uiRules({ ...ui, chrome: null })).toContain('This Mac has no Chrome: no screenshots.');
  });
});

describe('after the run: what Chrome really wrote', () => {
  it('a capture is green only if a real PNG sits in the task folder', () => {
    writeFileSync(join(ui.dir, 'home-375.png'), PNG);
    writeFileSync(join(ui.dir, 'home-768.png'), 'not a png');
    writeFileSync(join(tmp, 'secret.png'), PNG);
    symlinkSync(join(tmp, 'secret.png'), join(ui.dir, 'link-1280.png'));
    const cap = (w: number, file: string) => ({
      command: `chrome --screenshot ${w}x800 http://127.0.0.1:5173/`,
      ok: true,
      ui: { kind: 'capture' as const, url: 'http://127.0.0.1:5173/', width: w, height: 800, file },
    });
    const checks = confirmCaptures(
      [
        { command: 'pnpm test', ok: true },
        cap(375, join(ui.dir, 'home-375.png')),
        cap(768, join(ui.dir, 'home-768.png')),
        cap(1280, join(ui.dir, 'link-1280.png')),
        cap(1440, join(tmp, 'secret.png')),
      ],
      ui.dir,
    );
    expect(checks.map((c) => c.ok)).toEqual([true, true, false, false, false]);

    const dest = join(tmp, 'logs', 't1-ui');
    expect(keepCaptures(ui.dir, dest)).toEqual(['home-375.png']);
    expect(keepCaptures(join(tmp, 'nope'), dest)).toEqual([]);
  });

  it('reads Lighthouse scores from a report in the task folder only', () => {
    const report = join(ui.dir, 'lh.json');
    writeFileSync(
      report,
      JSON.stringify({
        categories: {
          performance: { score: 0.92 },
          accessibility: { score: 1 },
          'best-practices': { score: 0.961 },
          seo: { score: null },
        },
      }),
    );
    expect(lighthouseScores(report, ui.dir)).toEqual({
      performance: 92,
      accessibility: 100,
      'best-practices': 96,
    });
    writeFileSync(join(tmp, 'lh.json'), '{"categories":{"seo":{"score":1}}}');
    expect(lighthouseScores(join(tmp, 'lh.json'), ui.dir)).toBe(null);
    expect(lighthouseScores(join(ui.dir, 'missing.json'), ui.dir)).toBe(null);
  });

  it('writes the "Interface vérifiée" section: pages × widths, scores, what was unavailable', () => {
    const p = new ProofRecorder();
    const shot = (w: number, h: number, page = '') =>
      `"${CHROME}" --headless=new --user-data-dir=${ui.dir}/profile --window-size=${w},${h} --screenshot=${ui.dir}/p${page}-${w}.png http://127.0.0.1:5173/${page}`;
    p.bash(`${shot(375, 812)} && ${shot(1280, 800)}`, true);
    p.bash(shot(375, 812, 'login'), false);
    p.bash(
      `pnpm exec lighthouse http://127.0.0.1:5173/ --output-path=${join(ui.dir, 'lh.json')}`,
      true,
    );
    p.bash('pnpm exec playwright test', true);
    const md = uiSection(ui, p.result().checks, ['p-375.png', 'p-1280.png']);
    expect(md).toBe(
      [
        '### Interface vérifiée',
        'Serveur de dev local (Vite), Chrome du Mac sans interface, profil jetable.',
        '',
        '| Page | 375 px | 1280 px |',
        '|---|---|---|',
        '| `127.0.0.1:5173/` | ✅ | ✅ |',
        '| `127.0.0.1:5173/login` | ❌ | — |',
        '',
        '✅ = Chrome a produit la capture ; le rendu reste à regarder.',
        '',
        '- ✅ Lighthouse `127.0.0.1:5173/` : performance 92 · accessibilité 100 · bonnes pratiques 96',
        '- ✅ tests navigateur `pnpm exec playwright test`',
        '',
        'Non disponible :',
        '- axe n’est pas une dépendance du projet : accessibilité non auditée automatiquement.',
        '',
        'Captures hors du dépôt, gardées par Jarvis avec le journal de la tâche : p-375.png, p-1280.png.',
      ].join('\n'),
    );
    expect(uiSection({ ...ui, notes: [] }, [], [])).toBe(
      [
        '### Interface vérifiée',
        'Serveur de dev local (Vite), Chrome du Mac sans interface, profil jetable.',
        '',
        '⚠️ Aucune page n’a été ouverte dans le navigateur : interface non vérifiée.',
      ].join('\n'),
    );
  });
});
