import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARGV,
  CHECK_FR,
  type CheckId,
  EMPTY_CODES,
  IAC_FRAMEWORKS,
  OK_CODES,
  SAST_RULESETS,
  SCANNER_INFO,
  type ScannerId,
} from './catalogue.ts';
import {
  type Finding,
  oneLine,
  type Parser,
  parseCheckov,
  parseGitleaks,
  parseGrype,
  parseJson,
  parseOsv,
  parseSemgrep,
  parseTrivy,
  parseZizmor,
  type Severity,
  type Signal,
} from './parse.ts';
import { isUnder, type Locate, outsideProject, runArgv } from './run.ts';

export interface Invocation {
  tool: ScannerId;
  check: CheckId;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  /** What leaves the Mac, in French; null when the run is fully local. */
  network: string | null;
  parse: Parser;
}

export interface Skip {
  check: CheckId;
  reason: string;
  /** Any one of these would enable the check. */
  missing: ScannerId[];
}

export interface ScanRequest {
  /** Canonical directory, already checked against the filesystem policy. */
  root: string;
  checks: readonly CheckId[];
  image: string | null;
  offline: boolean;
}

const lstat = (p: string) => lstatSync(p, { throwIfNoEntry: false });

/** GitHub Actions workflows or a composite action at the root (symlinks not followed). */
function hasGithubActions(root: string): boolean {
  const wf = join(root, '.github', 'workflows');
  if (lstat(wf)?.isDirectory()) {
    try {
      if (readdirSync(wf).some((f) => /\.ya?ml$/i.test(f))) return true;
    } catch {
      // unreadable: treated as absent
    }
  }
  return ['action.yml', 'action.yaml'].some((f) => lstat(join(root, f))?.isFile());
}

const hasGitlabCi = (root: string) => lstat(join(root, '.gitlab-ci.yml'))?.isFile() === true;

/** A local ruleset inside the project; a symlink pointing outside is ignored. */
export function findRuleset(root: string): string | null {
  for (const name of SAST_RULESETS) {
    const p = join(root, name);
    if (!lstat(p)) continue;
    try {
      const real = realpathSync(p);
      if (isUnder(real.toLowerCase(), root.toLowerCase())) return real;
    } catch {
      // dangling link
    }
  }
  return null;
}

const SEMGREP_ENV = { SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0' };
const IMAGE_NETWORK =
  'l’image est lue depuis Docker en local, sinon téléchargée depuis son registre';

/** Turns the requested checks into argv from the fixed catalogue. Pure but for a few stats. */
export function planScan(
  req: ScanRequest,
  locate: Locate,
): { invocations: Invocation[]; skipped: Skip[] } {
  const { root, offline } = req;
  const find = (id: ScannerId) => {
    const p = locate(id);
    return p && outsideProject(p, root) ? p : null;
  };
  const invocations: Invocation[] = [];
  const skipped: Skip[] = [];
  const add = (i: Invocation) => invocations.push(i);
  const missing = (check: CheckId, ids: ScannerId[]) =>
    skipped.push({ check, reason: `${ids.join(' ou ')} non installé`, missing: ids });

  for (const check of new Set(req.checks)) {
    switch (check) {
      case 'secrets': {
        const bin = find('gitleaks');
        if (!bin) missing(check, ['gitleaks']);
        else
          add({
            tool: 'gitleaks',
            check,
            bin,
            args: ARGV.gitleaks(root),
            network: null,
            parse: parseGitleaks,
          });
        break;
      }
      case 'dependencies': {
        const bin = find('osv-scanner');
        if (!bin) missing(check, ['osv-scanner']);
        else
          add({
            tool: 'osv-scanner',
            check,
            bin,
            args: ARGV.osvScanner(root, offline),
            network: offline
              ? null
              : 'noms et versions des paquets envoyés à api.osv.dev (jamais le code) ; offline: true pour la base locale',
            parse: parseOsv,
          });
        break;
      }
      case 'ci': {
        const gh = hasGithubActions(root);
        const gl = hasGitlabCi(root);
        if (!gh && !gl) {
          skipped.push({
            check,
            reason: 'aucune CI trouvée (.github/workflows, .gitlab-ci.yml)',
            missing: [],
          });
          break;
        }
        const zizmor = gh ? find('zizmor') : null;
        const checkov = find('checkov');
        const frameworks: string[] = [];
        if (gh && zizmor)
          add({
            tool: 'zizmor',
            check,
            bin: zizmor,
            args: ARGV.zizmor(root),
            network: null,
            parse: parseZizmor,
          });
        else if (gh && checkov) frameworks.push('github_actions');
        else if (gh) missing(check, ['zizmor']);
        if (gl && checkov) frameworks.push('gitlab_ci');
        else if (gl) missing(check, ['checkov']);
        if (checkov && frameworks.length)
          add({
            tool: 'checkov',
            check,
            bin: checkov,
            args: ARGV.checkov(root, frameworks),
            network: null,
            parse: parseCheckov,
          });
        break;
      }
      case 'iac': {
        const checkov = find('checkov');
        const trivy = checkov ? null : find('trivy');
        if (checkov)
          add({
            tool: 'checkov',
            check,
            bin: checkov,
            args: ARGV.checkov(root, IAC_FRAMEWORKS),
            network: null,
            parse: parseCheckov,
          });
        else if (trivy)
          add({
            tool: 'trivy',
            check,
            bin: trivy,
            args: ARGV.trivyConfig(root, offline),
            network: offline ? null : 'trivy peut mettre à jour ses règles IaC (quelques Mo)',
            parse: parseTrivy,
          });
        else missing(check, ['checkov', 'trivy']);
        break;
      }
      case 'image': {
        if (!req.image) {
          skipped.push({ check, reason: 'aucune image donnée (paramètre image)', missing: [] });
          break;
        }
        const trivy = find('trivy');
        const grype = trivy ? null : find('grype');
        if (trivy)
          add({
            tool: 'trivy',
            check,
            bin: trivy,
            args: ARGV.trivyImage(req.image, offline),
            network: offline
              ? `base locale seulement ; ${IMAGE_NETWORK}`
              : `base de vulnérabilités téléchargée au premier scan (~70 Mo, plus la base Java si l’image contient des .jar) ; ${IMAGE_NETWORK}`,
            parse: parseTrivy,
          });
        else if (grype)
          add({
            tool: 'grype',
            check,
            bin: grype,
            args: ARGV.grypeImage(req.image),
            env: {
              GRYPE_CHECK_FOR_APP_UPDATE: 'false',
              ...(offline && { GRYPE_DB_AUTO_UPDATE: 'false' }),
            },
            network: offline
              ? `base locale seulement ; ${IMAGE_NETWORK}`
              : `base de vulnérabilités mise à jour si besoin (~60 Mo) ; ${IMAGE_NETWORK}`,
            parse: parseGrype,
          });
        else missing(check, ['trivy', 'grype']);
        break;
      }
      case 'sast': {
        const rules = findRuleset(root);
        if (!rules) {
          skipped.push({
            check,
            reason:
              'aucun jeu de règles local (.semgrep.yml, .semgrep/ ou .opengrep.yml) : la SAST ne télécharge jamais de règles',
            missing: [],
          });
          break;
        }
        const opengrep = find('opengrep');
        const semgrep = opengrep ? null : find('semgrep');
        const tool = opengrep ? 'opengrep' : semgrep ? 'semgrep' : null;
        const bin = opengrep ?? semgrep;
        if (!tool || !bin) {
          missing(check, ['opengrep', 'semgrep']);
          break;
        }
        add({
          tool,
          check,
          bin,
          args: tool === 'opengrep' ? ARGV.opengrep(rules, root) : ARGV.semgrep(rules, root),
          env: SEMGREP_ENV,
          network: null,
          parse: parseSemgrep(tool),
        });
        break;
      }
    }
  }
  return { invocations, skipped };
}

export interface ToolRun {
  tool: ScannerId;
  check: CheckId;
  status: 'ok' | 'empty' | 'error' | 'timeout' | 'stopped';
  ms: number;
  count: number;
  detail: string | null;
  network: string | null;
}

export interface ScanOutcome {
  runs: ToolRun[];
  /** Already scrubbed (known raw values, then the redactor), before any truncation. */
  findings: Finding[];
  /** Raw secret values a scanner leaked despite --redact: scrubbed from every output. */
  secrets: Set<string>;
}

// Untruncated here: details are scrubbed first, cut afterwards (a cut could split a secret).
const tail = (s: string) =>
  s
    .split('\n')
    .filter((l) => l.trim())
    .slice(-2)
    .join(' | ');

/** Runs every invocation in parallel, each bounded in time and output. */
export async function executeScan(
  invocations: readonly Invocation[],
  o: {
    root: string;
    home: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxBytes: number;
    redact: (s: string) => string;
  },
): Promise<ScanOutcome> {
  const secrets = new Set<string>();
  const raw: Finding[] = [];
  const runs = await Promise.all(
    invocations.map(async (inv): Promise<ToolRun> => {
      const base = { tool: inv.tool, check: inv.check, network: inv.network, count: 0 };
      const t0 = performance.now();
      try {
        const r = await runArgv(inv.bin, inv.args, {
          cwd: o.root,
          home: o.home,
          ...(inv.env && { env: inv.env }),
          timeoutMs: o.timeoutMs,
          signal: o.signal,
          maxBytes: o.maxBytes,
        });
        const done = (status: ToolRun['status'], detail: string | null, count = 0): ToolRun => ({
          ...base,
          status,
          detail,
          count,
          ms: r.ms,
        });
        if (r.status === 'timeout')
          return done('timeout', `délai dépassé (${Math.round(o.timeoutMs / 1000)} s)`);
        if (r.status === 'stopped') return done('stopped', 'arrêté (STOP)');
        if (r.exitCode !== null && EMPTY_CODES[inv.tool]?.includes(r.exitCode))
          return done('empty', 'rien à analyser');
        if (r.exitCode === null || !OK_CODES[inv.tool].includes(r.exitCode))
          return done('error', `code ${r.exitCode}${r.stderr ? ` : ${tail(r.stderr)}` : ''}`);
        let doc: unknown;
        try {
          doc = parseJson(r.stdout);
        } catch (e) {
          return done(
            'error',
            r.truncated
              ? `sortie au-delà de ${Math.round(o.maxBytes / 1e6)} Mo, tronquée : scanne un sous-dossier`
              : `${(e as Error).message}${r.stderr ? ` : ${tail(r.stderr)}` : ''}`,
          );
        }
        const found = inv.parse(doc, {
          root: o.root,
          check: inv.check,
          secret: (v) => secrets.add(v),
        });
        raw.push(...found);
        return done('ok', null, found.length);
      } catch (e) {
        return {
          ...base,
          status: 'error',
          detail: (e as Error).message,
          ms: performance.now() - t0,
        };
      }
    }),
  );
  // Every scanner has answered: every leaked value is known. Scrub, then bound.
  const scrub = scrubber(secrets, o.redact);
  const findings = raw.map((f) => ({
    ...f,
    rule: scrub(f.rule),
    file: f.file === null ? null : scrub(f.file),
    message: scrub(f.message),
    fix: f.fix === null ? null : scrub(f.fix),
  }));
  for (const r of runs) if (r.detail) r.detail = oneLine(scrub(r.detail), 240);
  return { runs, findings, secrets };
}

const SEV_FR: Record<Severity, string> = {
  critical: 'critique',
  high: 'élevé',
  medium: 'moyen',
  low: 'faible',
  info: 'info',
  unknown: 'gravité inconnue',
};
const SEV_RANK: Record<Severity, number> = {
  critical: 50,
  high: 40,
  medium: 30,
  unknown: 25,
  low: 20,
  info: 10,
};
/** A signal moves a finding by about one severity level; KEV a bit more. */
const SIGNAL_SCORE: Record<Signal, number> = {
  exploited: 15,
  reachable: 10,
  exposed: 10,
  unreachable: -10,
  dev_only: -5,
};
/** For the "Signaux" count line. */
const SIGNAL_COUNT_FR: Record<Signal, string> = {
  exploited: 'exploitée(s) activement (CISA KEV)',
  reachable: 'atteignable(s)',
  exposed: 'exposée(s)',
  unreachable: 'non appelée(s) par le code',
  dev_only: 'en dépendance de dev',
};
const SIGNAL_FR: Record<Signal, string> = {
  exploited: 'exploitée activement (CISA KEV)',
  reachable: 'atteignable (code appelé)',
  exposed: 'exposée',
  unreachable: 'non appelée par le code',
  dev_only: 'dépendance de dev',
};

export const priority = (f: Finding): number =>
  SEV_RANK[f.severity] + f.signals.reduce((s, x) => s + SIGNAL_SCORE[x], 0);

/** Deduplicated, most urgent first: severity adjusted by reachability and exposure. */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const k = JSON.stringify([f.tool, f.rule, f.file, f.line, f.message]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.sort(
    (a, b) =>
      priority(b) - priority(a) ||
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      a.tool.localeCompare(b.tool) ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

const plural = (n: number, word: string) =>
  `${n} ${word}${n > 1 && !word.endsWith('s') ? 's' : ''}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;

function counts(findings: readonly Finding[]): string {
  const order: Severity[] = ['critical', 'high', 'medium', 'unknown', 'low', 'info'];
  return order
    .map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => (s === 'unknown' ? `${n} de gravité inconnue` : plural(n, SEV_FR[s])))
    .join(', ');
}

export function findingLine(f: Finding, i: number): string {
  const tags = [SEV_FR[f.severity], ...f.signals.map((s) => SIGNAL_FR[s])].join(' · ');
  const where = f.file ? ` — ${oneLine(f.file, 160)}${f.line ? `:${f.line}` : ''}` : '';
  const fix = f.fix ? ` — ${oneLine(f.fix, 160)}` : '';
  // An em dash after the rule: "api-key : word" would read as an assignment to the redactor.
  return `${i}. [${tags}] ${oneLine(f.rule, 90)} — ${oneLine(f.message, 200)}${where}${fix} (${f.tool})`;
}

export interface SummaryInput {
  /** Folder shown to Brightky (home abbreviated). */
  target: string;
  checks: readonly CheckId[];
  runs: readonly ToolRun[];
  skipped: readonly Skip[];
  findings: readonly Finding[];
  maxFindings?: number;
  maxChars?: number;
}

/** Compact French report, most urgent first, bounded in lines and characters. */
export function summarize(s: SummaryInput): string {
  const maxFindings = s.maxFindings ?? 40;
  const maxChars = s.maxChars ?? 8000;
  const ranked = rankFindings(s.findings);
  const out: string[] = [
    `Scan sécurité de ${s.target} (${[...new Set(s.checks)].map((c) => CHECK_FR[c]).join(', ')}).`,
  ];
  const ran = s.runs.filter((r) => r.status === 'ok' || r.status === 'empty');
  if (ranked.length) out.push(`${plural(ranked.length, 'problème')} : ${counts(ranked)}.`);
  else if (ran.length) out.push('Aucun problème trouvé par les scanners qui ont tourné.');
  else out.push('Aucun scanner n’a pu tourner : rien n’a été vérifié.');

  const signals = (['exploited', 'reachable', 'exposed', 'unreachable', 'dev_only'] as const)
    .map((sig) => [sig, ranked.filter((f) => f.signals.includes(sig)).length] as const)
    .filter(([, n]) => n > 0);
  if (signals.length)
    out.push(`Signaux : ${signals.map(([sig, n]) => `${n} ${SIGNAL_COUNT_FR[sig]}`).join(', ')}.`);

  if (s.runs.length)
    out.push(
      `Scanners : ${s.runs
        .map((r) =>
          r.status === 'ok'
            ? `${r.tool} ✓ ${r.count} (${secs(r.ms)})`
            : r.status === 'empty'
              ? `${r.tool} ✓ ${r.detail}`
              : `${r.tool} ✗ ${r.detail ?? r.status}`,
        )
        .join(' · ')}`,
    );
  const net = s.runs.filter((r) => r.network && r.status !== 'stopped');
  out.push(
    net.length
      ? `Réseau : ${net.map((r) => `${r.tool} — ${r.network}`).join(' ; ')}.`
      : 'Réseau : aucun appel (scan entièrement local).',
  );
  const notRun = s.skipped.filter((k) => k.missing.length === 0);
  if (notRun.length)
    out.push(`Non lancé : ${notRun.map((k) => `${CHECK_FR[k.check]} — ${k.reason}`).join(' ; ')}.`);
  const toInstall = s.skipped.filter((k) => k.missing.length > 0);
  if (toInstall.length)
    out.push(
      `Manquant : ${toInstall
        .map(
          (k) =>
            `${CHECK_FR[k.check]} → ${k.missing
              .map((id) => `${SCANNER_INFO[id].install} (${SCANNER_INFO[id].size})`)
              .join(' ou ')}`,
        )
        .join(' ; ')}. Jarvis n’installe rien lui-même.`,
    );

  if (ranked.length) {
    out.push('', 'Par gravité, puis atteignabilité et exposition :');
    let size = out.join('\n').length;
    let shown = 0;
    for (const f of ranked) {
      const line = findingLine(f, shown + 1);
      if (shown >= maxFindings || size + line.length + 1 > maxChars) break;
      out.push(line);
      size += line.length + 1;
      shown++;
    }
    const rest = ranked.slice(shown);
    if (rest.length) out.push(`… et ${rest.length} autre(s) non listé(s) : ${counts(rest)}.`);
  }
  return out.join('\n');
}

/**
 * Second redaction layer, independent of the scanners' own flags: values a scanner reported raw
 * are cut out first, then the shared redactor (known secrets, token patterns) runs.
 */
export function scrubber(
  secrets: ReadonlySet<string>,
  redact: (s: string) => string,
): (s: string) => string {
  // The raw value and its one-line form (the summary collapses whitespace).
  const values = [...new Set([...secrets].flatMap((v) => [v, v.replace(/\s+/g, ' ').trim()]))]
    .filter((v) => v.length >= 6)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const v of values) if (out.includes(v)) out = out.split(v).join('[secret masqué]');
    return redact(out);
  };
}
