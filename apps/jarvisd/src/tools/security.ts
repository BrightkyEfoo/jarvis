import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Classification,
  defineTool,
  type FsPolicy,
  forbid,
  N0,
  N4,
  Refusal,
  type ToolDef,
} from '@jarvis/policy';
import { z } from 'zod';
import {
  CHECKS,
  type CheckId,
  COMPROMISED,
  DEFAULT_CHECKS,
  IMAGE_REF,
  IMAGE_SCHEMES,
  SCANNER_INFO,
  SCANNERS,
  type ScannerId,
} from '../security/catalogue.ts';
import { isUnder, type Locate, runArgv, versionOf } from '../security/run.ts';
import { executeScan, planScan, scrubber, summarize } from '../security/scan.ts';

export interface SecurityToolDeps {
  fs: FsPolicy;
  home: string;
  locate: Locate;
  /** The daemon's redactor (known secrets + token patterns). */
  redact: (s: string) => string;
  /** Per scanner. Kept under the gate's tool timeout so the summary still comes back. */
  timeoutMs: number;
  maxBytes?: number;
}

/** Credential stores a scan root must not contain (a read root set to ~ would include them). */
const PROTECTED_IN_HOME = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.kube',
  '.docker',
  '.claude',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Application Support/Jarvis',
];

const canonical = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export function createSecurityTools(d: SecurityToolDeps): ToolDef[] {
  const home = canonical(d.home);
  const protectedDirs = PROTECTED_IN_HOME.map((p) => join(home, p).toLowerCase());
  const show = (p: string) => (isUnder(p, home) ? `~${p.slice(home.length)}` : p);

  /** fs policy first (realpath, protected paths, .env*, allowed roots), then the scan rules. */
  const target = (path: string, cwd: string): Classification & { path: string } => {
    const c = d.fs.check(path, 'read', cwd);
    if (c.level >= N4) return c;
    const lower = c.path.toLowerCase();
    const inside = protectedDirs.find((p) => isUnder(p, lower));
    if (inside)
      return {
        ...forbid(
          'security.scan.contains_protected',
          `${c.path} contains a credential store (${inside}); scan a project folder instead`,
        ),
        path: c.path,
      };
    return {
      level: N0,
      rule: 'security.scan',
      reason: 'local read-only scanners on an allowed folder',
      path: c.path,
    };
  };

  /**
   * Homebrew's Cellar path gives the version without executing anything (a compromised release
   * must not run just to be identified); otherwise `<tool> --version`, parsed to a semver.
   */
  const version = async (id: ScannerId, bin: string, signal: AbortSignal) => {
    const cellar = /\/Cellar\/[^/]+\/([^/]+)\//.exec(canonical(bin))?.[1];
    if (cellar) return cellar.replace(/_\d+$/, '');
    const r = await runArgv(bin, SCANNER_INFO[id].versionArgs, {
      cwd: home,
      home,
      timeoutMs: 5000,
      signal,
      maxBytes: 64 * 1024,
    }).catch(() => null);
    return r ? versionOf(`${r.stdout}\n${r.stderr}`) : null;
  };

  const securityTools = defineTool({
    name: 'security_tools',
    description:
      'List the local security scanners Jarvis can run (gitleaks, osv-scanner, zizmor, checkov, trivy, ' +
      'grype, syft, opengrep, semgrep): installed path and version, or the Homebrew command and approximate ' +
      'download size to install the missing ones. Flags known-compromised releases. Read-only (N0): it only ' +
      'runs `<tool> --version`; Jarvis never installs anything.',
    input: {},
    classify: () => ({ level: N0, rule: 'security.tools', reason: 'lists local binaries' }),
    summarize: () => 'List the installed security scanners',
    run: async (_a, ctx) => {
      const found = await Promise.all(
        SCANNERS.map(async (id) => {
          const bin = d.locate(id);
          return { id, bin, version: bin ? await version(id, bin, ctx.signal) : null };
        }),
      );
      const has = (id: ScannerId) => found.some((f) => f.id === id && f.bin);
      const out = ['Scanners de sécurité (catalogue fixe, lancés sans shell, en lecture seule) :'];
      for (const f of found) {
        const info = SCANNER_INFO[f.id];
        out.push(
          f.bin
            ? `✓ ${f.id} ${f.version ?? '(version inconnue)'} — ${info.role} — ${f.bin}`
            : `✗ ${f.id} — ${info.role} — ${info.install} (${info.size})`,
        );
      }
      for (const f of found) {
        if (f.version && COMPROMISED[f.id]?.includes(f.version))
          out.push(
            `⚠ ${f.id} ${f.version} est une version compromise (attaque de la chaîne d’approvisionnement, mars 2026) : ` +
              'désinstalle-la, reprends une version saine et vérifie son empreinte. Jarvis ne la lance pas.',
          );
      }
      const core = (['gitleaks', 'osv-scanner', 'zizmor', 'checkov'] as const).filter(
        (id) => !has(id),
      );
      const light = core.filter((id) => SCANNER_INFO[id].sizeMb < 100);
      const heavy = core.filter((id) => SCANNER_INFO[id].sizeMb >= 100);
      const mb = (ids: readonly ScannerId[]) =>
        ids.reduce((s, id) => s + SCANNER_INFO[id].sizeMb, 0);
      if (light.length)
        out.push(`Pour compléter : brew install ${light.join(' ')} (~${mb(light)} Mo).`);
      if (heavy.length) out.push(`Sur Wi-Fi : brew install ${heavy.join(' ')} (~${mb(heavy)} Mo).`);
      if (!has('trivy') && !has('grype'))
        out.push(
          `Images (au choix) : ${SCANNER_INFO.grype.install} (${SCANNER_INFO.grype.size}) ou ${SCANNER_INFO.trivy.install} (${SCANNER_INFO.trivy.size}).`,
        );
      if (!has('opengrep') && !has('semgrep'))
        out.push(
          `SAST avec règles locales (au choix) : opengrep, ${SCANNER_INFO.opengrep.install} (${SCANNER_INFO.opengrep.size}), ou ${SCANNER_INFO.semgrep.install} (${SCANNER_INFO.semgrep.size}).`,
        );
      out.push(
        'Réseau : osv-scanner envoie les noms et versions des paquets à api.osv.dev (sauf offline) ; trivy et grype ' +
          'téléchargent une base de vulnérabilités au premier scan ; gitleaks, zizmor, checkov et opengrep restent locaux.',
        'Non proposé : la vérification en ligne des secrets (trufflehog --verify), qui enverrait chaque secret trouvé à son fournisseur.',
      );
      return out.join('\n');
    },
  });

  const securityScan = defineTool({
    name: 'security_scan',
    description:
      'Scan a local project folder with the installed open-source scanners (fixed catalogue, no shell, read-only). ' +
      'checks: secrets (gitleaks, values always redacted), dependencies (osv-scanner: SENDS package names and ' +
      'versions to api.osv.dev unless offline: true, which needs its local DB), ci (zizmor for GitHub Actions, ' +
      'checkov for GitLab CI), iac (checkov), image (needs `image`: trivy or grype, which DOWNLOAD a vulnerability ' +
      'DB of ~60-80 MB on first use and may pull the image), sast (opengrep/semgrep, only with a local ' +
      '.semgrep.yml or .semgrep/ ruleset, never registry rules). Default: secrets, dependencies, ci, iac, sast. ' +
      'Returns a French summary sorted by severity, then reachability/exposure signals. Output is external data. ' +
      'The folder must be inside the allowed roots.',
    input: {
      path: z.string().min(1).max(1024),
      checks: z.array(z.enum(CHECKS)).min(1).max(CHECKS.length).optional(),
      image: z
        .string()
        .max(255)
        .regex(IMAGE_REF, 'image reference: name[:tag][@sha256:digest]')
        .optional(),
      offline: z.boolean().default(false),
    },
    classify: (a, ctx) => {
      const t = target(a.path, ctx.cwd);
      if (t.level >= N4) return t;
      if (a.image && IMAGE_SCHEMES.test(a.image))
        return forbid(
          'security.image_scheme',
          'an image reference with a local scheme (dir:, file:, sbom:…) would read arbitrary paths',
        );
      return t;
    },
    summarize: (a) =>
      `Security scan of ${a.path} (${(a.checks ?? DEFAULT_CHECKS).join(', ')}${a.image ? `, image ${a.image}` : ''})${
        a.offline ? ' offline' : ''
      }`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      // Checked again at run time: the folder may have changed since classification.
      const t = target(a.path, ctx.cwd);
      if (t.level >= N4) throw new Refusal(t.rule, t.reason);
      if (!statSync(t.path, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`${a.path} n'est pas un dossier existant : donne le dossier du projet`);
      const checks: CheckId[] = a.checks ?? [
        ...DEFAULT_CHECKS,
        ...(a.image ? ['image' as const] : []),
      ];
      const req = { root: t.path, checks, image: a.image ?? null, offline: a.offline };
      let { invocations, skipped } = planScan(req, d.locate);
      // A release known to be malicious is never run: checked only for the tools this plan uses,
      // then planned again without them (a fallback scanner may take over).
      const blocked = new Map<ScannerId, string>();
      for (const inv of invocations) {
        const bad = COMPROMISED[inv.tool];
        const v = bad ? await version(inv.tool, inv.bin, ctx.signal) : null;
        if (v && bad?.includes(v)) blocked.set(inv.tool, v);
      }
      if (blocked.size)
        ({ invocations, skipped } = planScan(req, (id) => (blocked.has(id) ? null : d.locate(id))));
      const outcome = await executeScan(invocations, {
        root: t.path,
        home,
        signal: ctx.signal,
        timeoutMs: d.timeoutMs,
        maxBytes: d.maxBytes ?? 24_000_000,
        redact: d.redact,
      });
      const scrub = scrubber(outcome.secrets, d.redact);
      const warn = [...blocked].map(
        ([id, v]) => `⚠ ${id} ${v} : version compromise, non lancée (voir security_tools).`,
      );
      return scrub(
        [
          summarize({
            target: show(t.path),
            checks,
            runs: outcome.runs,
            skipped,
            findings: outcome.findings,
          }),
          ...warn,
        ].join('\n'),
      );
    },
  });

  return [securityTools, securityScan] as unknown as ToolDef[];
}
