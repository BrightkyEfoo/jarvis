import { isAbsolute, relative } from 'node:path';
import type { CheckId, ScannerId } from './catalogue.ts';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'unknown';

/** Context that changes the priority of a finding, when the scanner knows it. */
export type Signal = 'exploited' | 'reachable' | 'exposed' | 'unreachable' | 'dev_only';

export interface Finding {
  tool: ScannerId;
  check: CheckId;
  severity: Severity;
  /** Rule, check or advisory id (CVE/GHSA…). */
  rule: string;
  /** Relative to the scanned folder when possible. */
  file: string | null;
  line: number | null;
  message: string;
  /** Fixed version, resolution or documentation link. */
  fix: string | null;
  signals: Signal[];
}

export interface ParseCtx {
  root: string;
  check: CheckId;
  /** Registers a raw secret value seen in a report so it is scrubbed from every output. */
  secret: (value: string) => void;
}

export type Parser = (doc: unknown, ctx: ParseCtx) => Finding[];

/** Per tool, so one pathological report cannot flood memory or the summary. */
export const MAX_FINDINGS_PER_TOOL = 5000;

type J = Record<string, unknown>;
const obj = (v: unknown): J =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// Control and format characters (bidi overrides, zero-width) never reach the summary.
const INVISIBLE = /[\p{Cc}\p{Cf}]+/gu;

/** One line, no control characters, bounded. */
export function oneLine(s: string, max: number): string {
  const t = s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Tolerates a banner printed before the JSON document. */
export function parseJson(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) throw new Error('sortie vide');
  try {
    return JSON.parse(t);
  } catch {
    const i = t.search(/[[{]/);
    if (i > 0) {
      try {
        return JSON.parse(t.slice(i));
      } catch {
        // fall through
      }
    }
  }
  throw new Error('sortie JSON illisible');
}

export function wordSeverity(v: unknown): Severity {
  switch (str(v).trim().toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
    case 'error':
      return 'high';
    case 'medium':
    case 'moderate':
    case 'warning':
      return 'medium';
    case 'low':
    case 'negligible':
    case 'note':
      return 'low';
    case 'info':
    case 'informational':
    case 'none':
      return 'info';
    default:
      return 'unknown';
  }
}

/** CVSS base score → qualitative rating (CVSS v3/v4 table). */
export function cvssSeverity(score: number | null): Severity {
  if (score === null) return 'unknown';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'info';
}

function relPath(p: string, root: string): string {
  if (!p) return p;
  if (isAbsolute(p)) {
    const r = relative(root, p);
    return r && !r.startsWith('..') ? r : p;
  }
  return p.replace(/^\.\//, '');
}

const cap = (findings: Finding[]) => findings.slice(0, MAX_FINDINGS_PER_TOOL);

/**
 * gitleaks report (array). Only RuleID, Description, File and StartLine are read: Secret, Match
 * and Line are never copied. If the binary ignored --redact, the raw values are registered so
 * the summary scrubs them wherever they would appear (a hostile description, a file name).
 */
export const parseGitleaks: Parser = (doc, ctx) => {
  const out: Finding[] = [];
  for (const raw of arr(doc)) {
    const f = obj(raw);
    for (const k of ['Secret', 'Match']) {
      const v = str(f[k]);
      if (v && !v.includes('REDACTED')) ctx.secret(v);
    }
    out.push({
      tool: 'gitleaks',
      check: ctx.check,
      severity: 'high',
      rule: str(f.RuleID) || 'secret',
      file: relPath(str(f.File), ctx.root) || null,
      line: num(f.StartLine),
      message: `${str(f.Description) || 'Secret détecté'} (valeur masquée)`,
      fix: 'révoquer et remplacer le secret, puis le retirer de l’historique git',
      signals: [],
    });
  }
  return cap(out);
};

function osvFixed(vuln: J, pkg: J): string[] {
  const name = str(pkg.name).toLowerCase();
  const out = new Set<string>();
  for (const a of arr(vuln.affected)) {
    const ap = obj(obj(a).package);
    if (name && str(ap.name).toLowerCase() !== name) continue;
    for (const r of arr(obj(a).ranges))
      for (const e of arr(obj(r).events)) {
        const fixed = str(obj(e).fixed);
        if (fixed) out.add(fixed);
      }
  }
  return [...out];
}

/** Numeric version comparison, good enough for semver-like strings (1.2.10 > 1.2.9). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+:~-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.+:~-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x - y;
  }
  return 0;
}

/** The fixes that apply to the installed version: the lowest above it, else all known. */
export function pickFix(installed: string, fixed: readonly string[]): string[] {
  const above = fixed.filter((f) => compareVersions(f, installed) > 0).sort(compareVersions);
  return above.length ? above.slice(0, 1) : [...fixed].sort(compareVersions).slice(-2);
}

/**
 * osv-scanner `--format json`: results[].packages[] with vulnerabilities and alias groups.
 * One finding per group (aliases of the same advisory), max_severity is a CVSS score.
 * Reachability comes from call analysis (experimentalAnalysis.called) when it ran.
 */
export const parseOsv: Parser = (doc, ctx) => {
  const out: Finding[] = [];
  for (const res of arr(obj(doc).results)) {
    const source = relPath(str(obj(obj(res).source).path), ctx.root) || null;
    for (const p of arr(obj(res).packages)) {
      const pv = obj(p);
      const pkg = obj(pv.package);
      const vulns = arr(pv.vulnerabilities).map(obj);
      const groupsIn = arr(pv.groups).map(obj);
      const groups = groupsIn.length
        ? groupsIn
        : vulns.map((v) => ({ ids: [v.id], max_severity: '' }) as J);
      const depGroups = arr(pv.dependency_groups).map(str);
      for (const g of groups) {
        const ids = arr(g.ids).map(str).filter(Boolean);
        const members = vulns.filter((v) => ids.includes(str(v.id)));
        const main = members[0] ?? {};
        let severity = cvssSeverity(num(g.max_severity));
        if (severity === 'unknown') severity = wordSeverity(obj(main.database_specific).severity);
        const fixed = pickFix(str(pkg.version), [
          ...new Set(members.flatMap((v) => osvFixed(v, pkg))),
        ]);
        const analysis = obj(g.experimentalAnalysis ?? g.experimental_analysis);
        const called = ids.map((id) => obj(analysis[id]).called).filter((c) => c !== undefined);
        const signals: Signal[] = [];
        if (called.some((c) => c === true)) signals.push('reachable');
        else if (called.length > 0 && called.every((c) => c === false)) signals.push('unreachable');
        if (depGroups.length > 0 && depGroups.every((d) => d === 'dev')) signals.push('dev_only');
        const names = [
          ...new Set([
            ...ids,
            ...arr(g.aliases).map(str),
            ...members.flatMap((v) => arr(v.aliases).map(str)),
          ]),
        ].filter(Boolean);
        const pretty = names.sort((a, b) => idWeight(a) - idWeight(b)).slice(0, 2);
        out.push({
          tool: 'osv-scanner',
          check: ctx.check,
          severity,
          rule: pretty.join(' / ') || 'vulnérabilité',
          file: source,
          line: null,
          message: `${str(pkg.name)} ${str(pkg.version)}${pkg.ecosystem ? ` (${str(pkg.ecosystem)})` : ''} : ${
            str(main.summary) || str(main.details).split('\n')[0] || 'vulnérabilité connue'
          }`,
          fix: fixed.length
            ? `corrigé en ${fixed.slice(0, 2).join(' ou ')}`
            : 'pas de version corrigée connue',
          signals,
        });
      }
    }
  }
  return cap(out);
};

// CVE then GHSA first: the ids people search for.
const idWeight = (id: string) => (id.startsWith('CVE-') ? 0 : id.startsWith('GHSA-') ? 1 : 2);

/** zizmor audits whose finding is reachable by an outside attacker (fork PR, issue title…). */
const ZIZMOR_EXPOSED = new Set([
  'template-injection',
  'dangerous-triggers',
  'github-env',
  'cache-poisoning',
]);

/** zizmor `--format json` (v1): ident, desc, determinations, locations (0-based rows). */
export const parseZizmor: Parser = (doc, ctx) => {
  const out: Finding[] = [];
  for (const raw of arr(doc)) {
    const f = obj(raw);
    if (f.ignored === true) continue;
    const locs = arr(f.locations).map(obj);
    const primary =
      locs.find((l) => /primary/i.test(str(obj(l.symbolic).kind)) || obj(l.symbolic).primary) ??
      locs[0] ??
      {};
    const sym = obj(primary.symbolic);
    const key = obj(sym.key);
    const local = obj(key.Local ?? key.local);
    const file = str(local.given_path) || str(local.path) || str(sym.path);
    const row = num(obj(obj(obj(primary.concrete).location).start_point).row);
    const ident = str(f.ident) || 'zizmor';
    const det = obj(f.determinations);
    const annotation = str(sym.annotation);
    out.push({
      tool: 'zizmor',
      check: ctx.check,
      severity: wordSeverity(det.severity),
      rule: ident,
      file: relPath(file, ctx.root) || null,
      line: row === null ? null : row + 1,
      message: `${str(f.desc) || ident}${annotation ? ` : ${annotation}` : ''}${
        str(det.confidence).toLowerCase() === 'low' ? ' (confiance faible)' : ''
      }`,
      fix: str(f.url) || null,
      signals: ZIZMOR_EXPOSED.has(ident) ? ['exposed'] : [],
    });
  }
  return cap(out);
};

const PUBLIC = /public|0\.0\.0\.0|internet|anonymous|world|unrestricted/i;

/**
 * checkov `-o json`: one report object, an array of reports (several frameworks), or a bare
 * summary when nothing was found. Open-source checkov leaves severity null: kept unknown.
 */
export const parseCheckov: Parser = (doc, ctx) => {
  const reports = Array.isArray(doc) ? doc : [doc];
  const out: Finding[] = [];
  for (const r of reports) {
    for (const c of arr(obj(obj(r).results).failed_checks)) {
      const f = obj(c);
      const name = str(f.check_name);
      const file = str(f.repo_file_path) || str(f.file_path) || str(f.file_abs_path);
      const range = arr(f.file_line_range);
      const resource = str(f.resource);
      out.push({
        tool: 'checkov',
        check: ctx.check,
        severity: wordSeverity(f.severity),
        rule: str(f.check_id) || 'checkov',
        file: file ? relPath(file, ctx.root).replace(/^\//, '') : null,
        line: num(range[0]),
        message: `${name || 'contrôle en échec'}${resource ? ` (${resource})` : ''}`,
        fix: str(f.guideline) || null,
        signals: PUBLIC.test(name) ? ['exposed'] : [],
      });
    }
  }
  return cap(out);
};

/** trivy `--format json`: Results[].Vulnerabilities and Results[].Misconfigurations. Secrets
 * are never requested (`--scanners vuln`) and never read. */
export const parseTrivy: Parser = (doc, ctx) => {
  const out: Finding[] = [];
  for (const raw of arr(obj(doc).Results)) {
    const r = obj(raw);
    const target = relPath(str(r.Target), ctx.root) || null;
    for (const v of arr(r.Vulnerabilities).map(obj)) {
      out.push({
        tool: 'trivy',
        check: ctx.check,
        severity: wordSeverity(v.Severity),
        rule: str(v.VulnerabilityID) || 'vulnérabilité',
        file: target,
        line: null,
        message: `${str(v.PkgName)} ${str(v.InstalledVersion)}${v.Title ? ` : ${str(v.Title)}` : ''}`,
        fix: v.FixedVersion
          ? `corrigé en ${str(v.FixedVersion)}`
          : 'pas de version corrigée connue',
        signals: [],
      });
    }
    for (const m of arr(r.Misconfigurations).map(obj)) {
      if (str(m.Status) && str(m.Status) !== 'FAIL') continue;
      const title = str(m.Title);
      out.push({
        tool: 'trivy',
        check: ctx.check,
        severity: wordSeverity(m.Severity),
        rule: str(m.AVDID) || str(m.ID) || 'trivy',
        file: target,
        line: num(obj(m.CauseMetadata).StartLine),
        message: `${title}${m.Message ? ` : ${str(m.Message)}` : ''}`,
        fix: str(m.Resolution) || str(m.PrimaryURL) || null,
        signals: PUBLIC.test(title) ? ['exposed'] : [],
      });
    }
  }
  return cap(out);
};

/** grype `-o json`: matches[]. CISA KEV entries (knownExploited) are actively exploited. */
export const parseGrype: Parser = (doc, ctx) => {
  const out: Finding[] = [];
  for (const raw of arr(obj(doc).matches)) {
    const m = obj(raw);
    const v = obj(m.vulnerability);
    const a = obj(m.artifact);
    const fixes = arr(obj(v.fix).versions).map(str).filter(Boolean);
    const loc = str(obj(arr(a.locations)[0]).path);
    out.push({
      tool: 'grype',
      check: ctx.check,
      severity: wordSeverity(v.severity),
      rule: str(v.id) || 'vulnérabilité',
      file: loc || null,
      line: null,
      message: `${str(a.name)} ${str(a.version)}${a.type ? ` (${str(a.type)})` : ''}`,
      fix: fixes.length
        ? `corrigé en ${fixes.slice(0, 2).join(' ou ')}`
        : 'pas de version corrigée connue',
      signals: arr(v.knownExploited).length > 0 ? ['exploited'] : [],
    });
  }
  return cap(out);
};

/** semgrep / opengrep `--json`: results[]. `extra.lines` (the matched code) is never read. */
export const parseSemgrep =
  (tool: 'opengrep' | 'semgrep'): Parser =>
  (doc, ctx) => {
    const out: Finding[] = [];
    for (const raw of arr(obj(doc).results)) {
      const r = obj(raw);
      const extra = obj(r.extra);
      const id = str(r.check_id);
      out.push({
        tool,
        check: ctx.check,
        severity: wordSeverity(extra.severity),
        rule: id.split('.').slice(-2).join('.') || 'règle',
        file: relPath(str(r.path), ctx.root) || null,
        line: num(obj(r.start).line),
        message: str(extra.message) || id,
        fix: extra.fix ? 'correctif automatique proposé par la règle' : null,
        signals: [],
      });
    }
    return cap(out);
  };
