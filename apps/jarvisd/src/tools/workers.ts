import { type ForgeId, REPO_PATH } from '@jarvis/connectors';
import { defineTool, N0, N1, type Policy, type ToolDef } from '@jarvis/policy';
import { z } from 'zod';
import type { WorkerManager } from '../workers/manager.ts';
import type { Task, TaskStore } from '../workers/store.ts';

const STATUS = {
  queued: 'en file',
  running: 'en cours',
  done: 'terminée',
  failed: 'échec',
  cancelled: 'annulée',
} as const;

export function taskLine(t: Task): string {
  const cost = t.costUsd ? ` · ${t.turns} tours, ${t.costUsd.toFixed(2)} $ équiv.` : '';
  return `- [${t.id}] ${t.repo} — « ${t.title} » : ${STATUS[t.status]}${t.status === 'running' ? ` (${t.step})` : ''}${t.prUrl ? ` → ${t.prUrl}` : ''}${t.error ? ` — ${t.error}` : ''}${cost}`;
}

export function createWorkerTools(d: {
  manager: WorkerManager;
  store: TaskStore;
  policy: Policy;
  forges: () => ForgeId[];
}): ToolDef[] {
  const start = defineTool({
    name: 'worker_start',
    description:
      'Hand a coding task to a Claude Code worker: it works in its own git worktree of the repository, ' +
      "sandboxed, runs the tests, then Jarvis commits in Brightky's name and opens a pull request (never merges). " +
      'Describe the task precisely (what, where, acceptance). complex: true uses the stronger model.',
    input: {
      repo: z.string().regex(REPO_PATH, 'owner/repo'),
      task: z.string().min(10).max(20_000),
      forge: z.enum(['github', 'gitlab']).optional(),
      base: z
        .string()
        .regex(/^[A-Za-z0-9._/-]{1,100}$/)
        .optional(),
      complex: z.boolean().optional(),
    },
    // ADR-023: Jarvis opens PRs without asking. Merging is never automatic; pushing goes only to a
    // jarvis/… branch; the worker is sandboxed and its diff checked before anything leaves the Mac.
    classify: () => ({
      level: N1,
      rule: 'worker.start',
      reason: 'works in an isolated worktree and opens a PR',
    }),
    summarize: (a) => `Start a worker on ${a.repo}: ${a.task.slice(0, 160)}`,
    run: async (a, ctx) => {
      const forges = d.forges();
      const forge = a.forge ?? (forges.length === 1 ? forges[0] : undefined);
      if (!forge)
        throw new Error(
          forges.length
            ? 'précise forge: github ou gitlab'
            : 'aucune forge connectée : jarvis github connect',
        );
      const t = d.manager.enqueue({
        forge,
        repo: a.repo,
        task: a.task,
        ...(a.base && { base: a.base }),
        source: ctx.session.tainted ? 'conversation (après contenu externe)' : 'conversation',
        // Text written after reading issues, cards or pages may carry their instructions.
        external: ctx.session.tainted,
        model: a.complex ? d.policy.models.planning : d.policy.workers.model,
      });
      const ahead = d.store.list(100).filter((x) => x.status === 'queued' && x.id !== t.id).length;
      return `Tâche ${t.id} en file${ahead ? ` (${ahead} avant elle)` : ''}. Je préviens quand la PR est ouverte.`;
    },
  });

  const status = defineTool({
    name: 'worker_status',
    description:
      'State of the coding workers: queued, running (current step), done (PR link), failed (why).',
    input: {
      id: z
        .string()
        .regex(/^[a-f0-9]{8}$/)
        .optional(),
    },
    classify: () => ({ level: N0, rule: 'worker.status', reason: 'read-only' }),
    summarize: () => 'Workers status',
    run: async (a) => {
      if (a.id) {
        const t = d.store.get(a.id);
        return t ? `${taskLine(t)}${t.summary ? `\n\n${t.summary}` : ''}` : `Aucune tâche ${a.id}.`;
      }
      const all = d.store.list(15);
      return all.length ? all.map(taskLine).join('\n') : 'Aucune tâche.';
    },
  });

  const cancel = defineTool({
    name: 'worker_cancel',
    description:
      'Cancel a queued or running worker task (its worktree is removed, nothing is pushed).',
    input: { id: z.string().regex(/^[a-f0-9]{8}$/) },
    classify: () => ({ level: N1, rule: 'worker.cancel', reason: 'stops local work' }),
    summarize: (a) => `Cancel worker task ${a.id}`,
    run: async (a) => {
      const t = d.manager.cancel(a.id);
      return t ? `Tâche ${a.id} : annulation demandée.` : `Aucune tâche ${a.id}.`;
    },
  });

  const log = defineTool({
    name: 'worker_log',
    description: 'Last lines of a worker task log (tool calls, refusals, messages).',
    input: {
      id: z.string().regex(/^[a-f0-9]{8}$/),
      lines: z.number().int().min(5).max(400).optional(),
    },
    classify: () => ({ level: N0, rule: 'worker.log', reason: 'read-only' }),
    summarize: (a) => `Read worker log ${a.id}`,
    ingestsExternal: true,
    run: async (a) => d.manager.log(a.id, a.lines ?? 60) || 'Journal vide.',
  });

  return [start, status, cancel, log] as unknown as ToolDef[];
}
