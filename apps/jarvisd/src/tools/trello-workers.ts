import type { ForgeId, TrelloCard, TrelloClient } from '@jarvis/connectors';
import { defineTool, N2, type Policy, type ToolDef } from '@jarvis/policy';
import { z } from 'zod';
import type { WorkerManager } from '../workers/manager.ts';
import type { Task, TaskStore } from '../workers/store.ts';

const REPO_LINE =
  /\brepo(?:sitory|sitoire)?\s*:\s*(?:(github|gitlab):)?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/i;

/** Where a card's work goes: "repo: owner/repo" in its description, else the board mapping. */
export function cardRepo(
  card: { board: string; desc: string },
  boards: Record<string, string>,
): { forge: ForgeId; repo: string } | null {
  const m = REPO_LINE.exec(card.desc);
  const raw = m
    ? `${m[1] ? `${m[1]}:` : ''}${m[2]}`
    : Object.entries(boards).find(([b]) => b.toLowerCase() === card.board.toLowerCase())?.[1];
  if (!raw) return null;
  const [, forge, repo] = /^(?:(github|gitlab):)?(.+)$/.exec(raw.trim()) ?? [];
  if (!repo || /(^|\/)\.\.?(\/|$)/.test(repo)) return null;
  return { forge: (forge as ForgeId | undefined) ?? 'github', repo };
}

const findList = (lists: { id: string; name: string }[], names: readonly string[]) =>
  lists.find((l) => names.some((n) => l.name.trim().toLowerCase() === n.toLowerCase()));

export interface TrelloWorkerDeps {
  trello: TrelloClient | null;
  manager: WorkerManager;
  store: TaskStore;
  policy: Policy;
}

/** After a worker finishes a card: PR link on the card, card moved to the review column. */
export async function trelloFollowUp(
  d: Pick<TrelloWorkerDeps, 'trello' | 'policy'>,
  t: Task,
): Promise<string | null> {
  if (!d.trello || !t.source.startsWith('trello:') || t.status !== 'done' || !t.prUrl) return null;
  const cardId = t.source.slice('trello:'.length);
  const card = await d.trello.card(cardId);
  await d.trello.comment(cardId, `PR : ${t.prUrl}`);
  const review = findList(await d.trello.lists(card.boardId), d.policy.forges.trello_review);
  if (review && review.id !== card.listId) await d.trello.move(cardId, review.id);
  return review?.name ?? null;
}

export function createTrelloWorkerTools(d: TrelloWorkerDeps): ToolDef[] {
  const take = defineTool({
    name: 'trello_take',
    description:
      'Take the Trello cards carrying the Jarvis label (default from the policy, e.g. "jarvis") and give each to a ' +
      'coding worker: the card moves to "En cours", and when its PR is open the card gets the PR link and moves to ' +
      '"À relire". The repository comes from a "repo: owner/repo" line in the card or from the board mapping.',
    input: {
      label: z.string().max(40).optional(),
      board: z
        .string()
        .regex(/^[0-9a-f]{24}$/)
        .optional(),
      max: z.number().int().min(1).max(10).optional(),
    },
    // One confirmation for the batch: it moves cards and comments on them as Brightky.
    classify: () => ({
      level: N2,
      rule: 'trello.take',
      reason: 'moves Trello cards and comments on them as Brightky',
    }),
    summarize: (a) =>
      `Take up to ${a.max ?? 5} Trello cards labelled ${a.label ?? d.policy.forges.trello_label}${a.board ? ' (one board)' : ''}: ` +
      'one worker each, card → En cours, then PR link + card → À relire',
    run: async (a) => {
      const trello = d.trello;
      if (!trello) throw new Error("Trello n'est pas connecté : jarvis trello connect");
      const label = a.label ?? d.policy.forges.trello_label;
      const boards = a.board ? [{ id: a.board }] : await trello.boards();
      const found: TrelloCard[] = [];
      for (const b of boards)
        found.push(...(await trello.cards({ boardId: b.id, label, max: 50 })));
      const taken = new Set(
        d.store
          .list(500)
          .filter(
            (t) =>
              t.source.startsWith('trello:') && t.status !== 'failed' && t.status !== 'cancelled',
          )
          .map((t) => t.source.slice('trello:'.length)),
      );
      const out: string[] = [];
      const skipped: string[] = [];
      for (const c of found.filter((x) => !taken.has(x.id)).slice(0, a.max ?? 5)) {
        const detail = await trello.card(c.id);
        const target = cardRepo(detail, d.policy.forges.trello_boards);
        if (!target) {
          skipped.push(
            `« ${c.name} » (${c.board}) : pas de dépôt — ajoute « repo: owner/repo » à la carte ou forges.trello_boards`,
          );
          continue;
        }
        const checklist = detail.checklists.flatMap((l) => [
          `${l.name} :`,
          ...l.items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.name}`),
        ]);
        const task = d.manager.enqueue({
          forge: target.forge,
          repo: target.repo,
          task: [
            detail.name,
            '',
            detail.desc.replace(REPO_LINE, '').trim(),
            ...(checklist.length ? ['', ...checklist] : []),
            '',
            `Carte : ${detail.url}`,
          ].join('\n'),
          source: `trello:${c.id}`,
          external: true,
          model: d.policy.workers.model,
        });
        const doing = findList(await trello.lists(c.boardId), d.policy.forges.trello_doing);
        if (doing && doing.id !== c.listId) await trello.move(c.id, doing.id);
        out.push(
          `- « ${c.name} » → ${target.repo} (tâche ${task.id})${doing ? `, carte dans « ${doing.name} »` : ''}`,
        );
      }
      if (out.length === 0 && skipped.length === 0)
        return `Aucune nouvelle carte étiquetée « ${label} ».`;
      return [
        out.length ? `${out.length} carte(s) confiée(s) aux workers :` : 'Aucune carte confiée.',
        ...out,
        ...(skipped.length ? ['Ignorées :', ...skipped.map((s) => `- ${s}`)] : []),
      ].join('\n');
    },
  });
  return [take] as unknown as ToolDef[];
}
