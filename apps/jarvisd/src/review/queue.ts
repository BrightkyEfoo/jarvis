import type { ChangeRequest, ChecksState, ReviewFacts } from '@jarvis/connectors';

/**
 * The review queue: every PR/MR waiting for Brightky (asked as reviewer, or opened by a worker on a
 * `jarvis/*` branch), ranked without reading the diff. Deterministic: paths, size, age and CI decide,
 * the model only explains. Pure, so it is tested without a forge.
 */
export type RiskArea = 'secrets' | 'auth' | 'migrations' | 'ci' | 'infra' | 'deps' | 'large';

const AREAS: [RiskArea, RegExp][] = [
  ['secrets', /(^|\/)\.env(\.|$)|(^|\/)[^/]*(secret|credential)[^/]*$|\.(pem|key|p12|pfx)$/i],
  [
    'auth',
    /(^|\/)[^/]*(auth|login|logout|session|oauth|jwt|password|passwd|permission|rbac|acl|crypto|csrf|cors)[^/]*(\/|$)/i,
  ],
  [
    'migrations',
    /(^|\/)(migrations?|migrate|alembic)\/|(^|\/)schema\.(prisma|rb|sql|graphql)$|\.sql$/i,
  ],
  [
    'ci',
    /^\.github\/workflows\/|^\.gitlab-ci\.ya?ml$|^\.gitlab\/ci\/|^\.circleci\/|(^|\/)Jenkinsfile$|^\.buildkite\//,
  ],
  [
    'infra',
    /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$|(^|\/)(terraform|k8s|kubernetes|helm|charts|deploy|infra)\/|\.tf$/i,
  ],
  [
    'deps',
    /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|go\.(mod|sum)|requirements[^/]*\.txt|poetry\.lock|pyproject\.toml|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pubspec\.(yaml|lock)|Podfile(\.lock)?)$/,
  ],
];

const WEIGHT: Record<RiskArea, number> = {
  secrets: 5,
  auth: 4,
  migrations: 4,
  ci: 3,
  infra: 3,
  deps: 2,
  large: 1,
};

export const AREA_FR: Record<RiskArea, string> = {
  secrets: 'secrets',
  auth: 'auth',
  migrations: 'migrations',
  ci: 'CI',
  infra: 'infra',
  deps: 'dépendances',
  large: 'grosse PR',
};

export function riskAreas(
  paths: readonly string[],
  additions: number,
  deletions: number,
): RiskArea[] {
  const found = new Set<RiskArea>();
  for (const p of paths) for (const [area, re] of AREAS) if (re.test(p)) found.add(area);
  if (additions + deletions > 600 || paths.length > 40) found.add('large');
  return (Object.keys(WEIGHT) as RiskArea[]).filter((a) => found.has(a));
}

export interface QueueItem {
  change: ChangeRequest;
  /** Opened by a Jarvis worker: Brightky is the only reviewer. */
  worker: boolean;
  facts?: ReviewFacts;
  areas: RiskArea[];
  ageDays: number;
  checks?: ChecksState;
  score: number;
}

/**
 * Higher first. Waiting time counts most (a PR left alone blocks a colleague), then risk; a running
 * CI pushes it down a little, a red CI or requested changes a lot (review once fixed), drafts go last.
 */
export function score(i: Omit<QueueItem, 'score'>): number {
  let s = Math.min(i.ageDays, 14) * 2 + i.areas.reduce((n, a) => n + WEIGHT[a], 0);
  // The author has to act first: red CI, changes requested, draft.
  if (i.checks === 'failure') s -= 20;
  if (i.checks === 'pending') s -= 2;
  if (i.facts?.changesRequested) s -= 15;
  if (i.change.draft) s -= 100;
  if (i.worker) s += 1;
  return s;
}

export function buildQueue(
  entries: { change: ChangeRequest; worker: boolean; facts?: ReviewFacts }[],
  now: Date,
): QueueItem[] {
  const seen = new Set<string>();
  const items: QueueItem[] = [];
  for (const e of entries) {
    const key = `${e.change.forge}:${e.change.repo}#${e.change.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const since = e.facts?.createdAt ?? e.change.updatedAt;
    const ageDays = Math.max(0, (now.getTime() - Date.parse(since)) / 86_400_000);
    const areas = e.facts ? riskAreas(e.facts.paths, e.facts.additions, e.facts.deletions) : [];
    const checks = e.facts?.checks ?? e.change.checks;
    const base = { ...e, areas, ageDays, ...(checks && { checks }) };
    items.push({ ...base, score: score(base) });
  }
  return items.sort((a, b) => b.score - a.score);
}

const CHECKS_FR: Record<ChecksState, string> = {
  success: 'CI verte',
  failure: 'CI rouge : attendre le correctif',
  pending: 'CI en cours',
  none: 'pas de CI',
};

function age(days: number): string {
  if (days < 1 / 24) return "à l'instant";
  if (days < 1) return `${Math.round(days * 24)} h`;
  return `${Math.round(days)} j`;
}

export function queueLine(i: QueueItem, n: number): string {
  const c = i.change;
  const parts = [
    `attend depuis ${age(i.ageDays)}`,
    i.facts
      ? `+${i.facts.additions} −${i.facts.deletions}, ${i.facts.paths.length} fichier(s)`
      : '',
    i.checks ? CHECKS_FR[i.checks] : '',
    i.facts?.approvals ? `${i.facts.approvals} approbation(s)` : '',
    i.facts?.changesRequested ? 'changements demandés' : '',
    i.areas.length ? `zones : ${i.areas.map((a) => AREA_FR[a]).join(', ')}` : '',
  ].filter(Boolean);
  return `${n}. ${i.worker ? '[worker] ' : ''}${c.draft ? '[brouillon] ' : ''}${c.repo}#${c.number} « ${c.title} » de ${c.author} — ${parts.join(' · ')}\n   ${c.url}`;
}
