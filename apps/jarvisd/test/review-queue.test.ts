import type { ChangeRequest } from '@jarvis/connectors';
import { describe, expect, it } from 'vitest';
import { buildQueue, queueLine, riskAreas } from '../src/review/queue.ts';

const pr = (n: number, o: Partial<ChangeRequest> = {}): ChangeRequest => ({
  forge: 'github',
  repo: 'acme/app',
  number: n,
  title: `PR ${n}`,
  author: 'paul',
  url: `https://github.com/acme/app/pull/${n}`,
  draft: false,
  state: 'open',
  updatedAt: '2026-10-02T10:00:00Z',
  ...o,
});
const facts = (paths: string[], o: object = {}) => ({ additions: 10, deletions: 2, paths, ...o });
const now = new Date('2026-10-03T10:00:00Z');

describe('review queue', () => {
  it('finds risk zones from paths, not from the diff', () => {
    expect(riskAreas(['src/auth/session.ts', 'README.md'], 5, 1)).toEqual(['auth']);
    expect(riskAreas(['db/migrations/0042.sql', 'prisma/schema.prisma'], 5, 1)).toEqual([
      'migrations',
    ]);
    expect(riskAreas(['.github/workflows/ci.yml'], 1, 1)).toEqual(['ci']);
    expect(riskAreas(['deploy/app.yaml', 'Dockerfile'], 1, 1)).toEqual(['infra']);
    expect(riskAreas(['package.json', 'pnpm-lock.yaml'], 1, 1)).toEqual(['deps']);
    expect(riskAreas(['.env.production', 'config/credentials.yml'], 1, 1)).toEqual(['secrets']);
    expect(riskAreas(['src/a.ts'], 500, 200)).toEqual(['large']);
    expect(riskAreas(['src/components/Button.tsx', 'docs/guide.md'], 5, 1)).toEqual([]);
  });

  it('ranks: old and risky first, red CI and drafts last, duplicates once', () => {
    const q = buildQueue(
      [
        {
          change: pr(1),
          worker: false,
          facts: facts(['src/ui.tsx'], { createdAt: '2026-10-03T08:00:00Z' }),
        },
        {
          change: pr(2),
          worker: false,
          facts: facts(['src/auth/jwt.ts'], { createdAt: '2026-09-29T10:00:00Z' }),
        },
        {
          change: pr(3),
          worker: false,
          facts: facts(['src/auth/jwt.ts'], {
            createdAt: '2026-09-29T10:00:00Z',
            checks: 'failure',
          }),
        },
        {
          change: pr(4, { draft: true }),
          worker: false,
          facts: facts(['db/migrations/1.sql'], { createdAt: '2026-09-20T10:00:00Z' }),
        },
        { change: pr(2), worker: false },
      ],
      now,
    );
    expect(q.map((i) => i.change.number)).toEqual([2, 1, 3, 4]);
    expect(Math.round(q[0]?.ageDays ?? 0)).toBe(4);
  });

  it('says it in French, with what matters for triage', () => {
    const [item] = buildQueue(
      [
        {
          change: pr(7),
          worker: true,
          facts: facts(['src/auth/a.ts'], {
            createdAt: '2026-10-03T07:00:00Z',
            checks: 'pending',
            approvals: 1,
          }),
        },
      ],
      now,
    );
    if (!item) throw new Error('empty queue');
    expect(queueLine(item, 1)).toBe(
      '1. [worker] acme/app#7 « PR 7 » de paul — attend depuis 3 h · +10 −2, 1 fichier(s) · CI en cours · 1 approbation(s) · zones : auth\n   https://github.com/acme/app/pull/7',
    );
  });
});
