import {
  type ChangeRequest,
  type ForgeClient,
  type ForgeId,
  type Issue,
  REPO_PATH,
  type ReviewFacts,
  type TrelloCard,
  type TrelloClient,
} from '@jarvis/connectors';
import { type Classification, defineTool, forbid, N0, N2, type ToolDef } from '@jarvis/policy';
import { z } from 'zod';
import { buildQueue, queueLine } from '../review/queue.ts';

export interface ForgeToolDeps {
  /** Connected forges only (token in the Keychain). */
  forges: Map<ForgeId, ForgeClient>;
  trello: TrelloClient | null;
  maxDiffChars: number;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

const CHECKS = { success: 'CI ✓', failure: 'CI ✗', pending: 'CI …', none: '' } as const;

function changeLine(c: ChangeRequest): string {
  const ref = `${c.forge === 'gitlab' ? `${c.repo}!` : `${c.repo}#`}${c.number}`;
  const bits = [
    c.draft ? 'brouillon' : '',
    c.checks ? CHECKS[c.checks] : '',
    c.approvals ? `${c.approvals} approbation(s)` : '',
    c.changesRequested ? 'changements demandés' : '',
    c.comments ? `${c.comments} commentaire(s)` : '',
  ].filter(Boolean);
  return `- ${ref} « ${c.title} » par ${c.author}, maj ${day(c.updatedAt)}${bits.length ? ` — ${bits.join(', ')}` : ''}\n  ${c.url}`;
}

const issueLine = (i: Issue) =>
  `- ${i.repo}#${i.number} « ${i.title} » par ${i.author}${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}, maj ${day(i.updatedAt)}\n  ${i.url}`;

const cardLine = (c: TrelloCard) =>
  `- [${c.id}] « ${c.name} » — ${c.board} › ${c.list}${c.labels.length ? ` [${c.labels.join(', ')}]` : ''}${
    c.due ? `, échéance ${day(c.due)}${c.dueComplete ? ' ✓' : ''}` : ''
  }`;

const forgeEnum = z.enum(['github', 'gitlab']);
const repoPath = z.string().regex(REPO_PATH, 'owner/repo');
const trelloId = z.string().regex(/^[0-9a-f]{24}$|^[A-Za-z0-9]{8}$/, 'Trello id');

/** Briefing section: what waits on the forges, and Trello cards assigned to Brightky. */
export async function workBriefing(d: Omit<ForgeToolDeps, 'maxDiffChars'>): Promise<string | null> {
  if (d.forges.size === 0 && !d.trello) return null;
  const out: string[] = [];
  for (const [id, f] of d.forges) {
    const box = await f.inbox(8).catch((e: Error) => e);
    const name = id === 'github' ? 'GitHub' : 'GitLab';
    if (box instanceof Error) {
      out.push(`## ${name} : indisponible (${box.message})`);
      continue;
    }
    const failing = box.mine.filter((p) => p.checks === 'failure').length;
    out.push(
      `## ${name} : ${box.toReview.length} à relire, ${box.mine.length} PR à moi${failing ? ` (${failing} en échec CI)` : ''}, ${box.issues.length} issue(s)`,
      ...box.toReview.slice(0, 5).map(changeLine),
      ...box.mine
        .filter((p) => p.checks === 'failure' || p.changesRequested)
        .slice(0, 5)
        .map(changeLine),
    );
  }
  if (d.trello) {
    const cards = await d.trello.cards({ mine: true, max: 8 }).catch((e: Error) => e);
    out.push(
      cards instanceof Error
        ? `## Trello : indisponible (${cards.message})`
        : `## Trello : ${cards.length} carte(s) à moi\n${cards.map(cardLine).join('\n')}`,
    );
  }
  return out.join('\n');
}

export function createForgeTools(d: ForgeToolDeps): ToolDef[] {
  const pick = (forge?: ForgeId): ForgeClient => {
    if (forge) {
      const f = d.forges.get(forge);
      if (!f) throw new Error(`${forge} n'est pas connecté : jarvis ${forge} connect`);
      return f;
    }
    const only = [...d.forges.values()];
    if (only.length === 1 && only[0]) return only[0];
    throw new Error(
      only.length
        ? 'précise forge: github ou gitlab'
        : 'aucune forge connectée : jarvis github connect',
    );
  };
  const trello = (): TrelloClient => {
    if (!d.trello) throw new Error("Trello n'est pas connecté : jarvis trello connect");
    return d.trello;
  };
  const read = (rule: string): Classification => ({ level: N0, rule, reason: 'read-only' });

  const inbox = defineTool({
    name: 'forge_inbox',
    description:
      'What waits for Brightky on GitHub and GitLab: PRs/MRs to review, his own open PRs with CI and review ' +
      'state, issues assigned to him. Use for "qu\'est-ce qui m\'attend sur GitHub ?" and the morning briefing.',
    input: { max: z.number().int().min(1).max(50).optional() },
    classify: () => read('forge.inbox'),
    summarize: () => 'Forge inbox (GitHub/GitLab)',
    ingestsExternal: true,
    run: async (a) => {
      if (d.forges.size === 0)
        return 'Aucune forge connectée (jarvis github connect / jarvis gitlab connect).';
      const parts: string[] = [];
      for (const [id, f] of d.forges) {
        try {
          const box = await f.inbox(a.max ?? 15);
          parts.push(
            `## ${id === 'github' ? 'GitHub' : 'GitLab'}`,
            `À relire (${box.toReview.length}) :`,
            ...(box.toReview.length ? box.toReview.map(changeLine) : ['- rien']),
            `Mes PR ouvertes (${box.mine.length}) :`,
            ...(box.mine.length ? box.mine.map(changeLine) : ['- aucune']),
            `Issues assignées (${box.issues.length}) :`,
            ...(box.issues.length ? box.issues.map(issueLine) : ['- aucune']),
          );
        } catch (e) {
          parts.push(`## ${id} : indisponible (${(e as Error).message})`);
        }
      }
      return parts.join('\n');
    },
  });

  const reviewQueue = defineTool({
    name: 'review_queue',
    description:
      "Brightky's review queue on GitHub and GitLab: PRs/MRs he is asked to review plus those opened by " +
      'Jarvis workers (jarvis/* branches), ranked by waiting time and risk (secrets, auth, migrations, CI, ' +
      'infra, dependencies, size), with CI and review state. Use for "qu\'est-ce que j\'ai à relire ?". ' +
      'Say the top 2–3 in plain words; offer a pre-review (pr_read) of the first one.',
    input: { max: z.number().int().min(1).max(20).optional() },
    classify: () => read('forge.review_queue'),
    summarize: () => 'Review queue (GitHub/GitLab)',
    ingestsExternal: true,
    run: async (a) => {
      if (d.forges.size === 0)
        return 'Aucune forge connectée (jarvis github connect / jarvis gitlab connect).';
      const max = a.max ?? 12;
      const entries: { change: ChangeRequest; worker: boolean; facts?: ReviewFacts }[] = [];
      const down: string[] = [];
      for (const [id, f] of d.forges) {
        try {
          const box = await f.inbox(30);
          const candidates = [
            ...box.toReview.map((change) => ({ change, worker: false })),
            ...box.mine
              .filter((c) => c.source?.startsWith('jarvis/'))
              .map((change) => ({ change, worker: true })),
          ].slice(0, max);
          // Size, paths and CI of each, in parallel; a PR whose details fail still shows.
          for (const e of await Promise.all(
            candidates.map(async (e) => {
              const facts = await f.reviewFacts(e.change.repo, e.change.number).catch(() => null);
              return { ...e, ...(facts && { facts }) };
            }),
          ))
            entries.push(e);
        } catch (e) {
          down.push(
            `${id === 'github' ? 'GitHub' : 'GitLab'} indisponible (${(e as Error).message})`,
          );
        }
      }
      const queue = buildQueue(entries, new Date());
      const workers = queue.filter((i) => i.worker).length;
      return [
        queue.length
          ? `File de revue : ${queue.length} PR${workers ? ` (dont ${workers} de workers)` : ''}, la plus urgente d'abord.`
          : 'Rien à relire.',
        ...queue.map((i, n) => queueLine(i, n + 1)),
        ...down,
      ].join('\n');
    },
  });

  const prList = defineTool({
    name: 'pr_list',
    description: 'List pull/merge requests of a repo, or all those involving Brightky (no repo).',
    input: {
      forge: forgeEnum.optional(),
      repo: repoPath.optional(),
      state: z.enum(['open', 'closed', 'all']).optional(),
      max: z.number().int().min(1).max(100).optional(),
    },
    classify: () => read('forge.pr_list'),
    summarize: (a) => `List PRs${a.repo ? ` of ${a.repo}` : ''}`,
    ingestsExternal: true,
    run: async (a) => {
      const list = await pick(a.forge).listChanges({
        ...(a.repo && { repo: a.repo }),
        state: a.state ?? 'open',
        max: a.max ?? 20,
      });
      return list.length ? list.map(changeLine).join('\n') : 'Aucune PR.';
    },
  });

  const prRead = defineTool({
    name: 'pr_read',
    description:
      'Read one pull/merge request: description, CI, reviews, changed files with their diff (within a budget) ' +
      'and the discussion. Summarise the diff for Brightky in plain words. For a pre-review, report only ' +
      'severe problems (bug, security, data loss, breaking change, risky code without tests): at most 5, ' +
      'each with file:line and why, no style nits; if none, say "rien de bloquant".',
    input: { forge: forgeEnum.optional(), repo: repoPath, number: z.number().int().positive() },
    classify: () => read('forge.pr_read'),
    summarize: (a) => `Read PR ${a.repo}#${a.number}`,
    ingestsExternal: true,
    run: async (a) => {
      const c = await pick(a.forge).getChange(a.repo, a.number, { maxPatchChars: d.maxDiffChars });
      const files = c.files.map(
        (f) =>
          `### ${f.path} (${f.status}, +${f.additions} −${f.deletions})${f.patch ? `\n${f.patch}` : ' — diff non inclus'}`,
      );
      return [
        changeLine(c),
        `Branches : ${c.source ?? '?'} → ${c.target ?? '?'} · +${c.additions} −${c.deletions} · ${c.files.length} fichier(s)`,
        '',
        '## Description',
        c.body.trim() || '(vide)',
        '',
        '## Fichiers',
        ...files,
        '',
        `## Discussion (${c.discussion.length})`,
        ...c.discussion
          .slice(-30)
          .map(
            (m) =>
              `- ${m.author}${m.path ? ` sur ${m.path}` : ''}, ${day(m.at)} : ${m.body.slice(0, 1500)}`,
          ),
      ].join('\n');
    },
  });

  const issueList = defineTool({
    name: 'issue_list',
    description: 'List issues of a repo, or those involving Brightky (no repo).',
    input: {
      forge: forgeEnum.optional(),
      repo: repoPath.optional(),
      state: z.enum(['open', 'closed', 'all']).optional(),
      max: z.number().int().min(1).max(100).optional(),
    },
    classify: () => read('forge.issue_list'),
    summarize: (a) => `List issues${a.repo ? ` of ${a.repo}` : ''}`,
    ingestsExternal: true,
    run: async (a) => {
      const list = await pick(a.forge).listIssues({
        ...(a.repo && { repo: a.repo }),
        state: a.state ?? 'open',
        max: a.max ?? 20,
      });
      return list.length ? list.map(issueLine).join('\n') : 'Aucune issue.';
    },
  });

  const issueRead = defineTool({
    name: 'issue_read',
    description: 'Read one issue with its discussion.',
    input: { forge: forgeEnum.optional(), repo: repoPath, number: z.number().int().positive() },
    classify: () => read('forge.issue_read'),
    summarize: (a) => `Read issue ${a.repo}#${a.number}`,
    ingestsExternal: true,
    run: async (a) => {
      const i = await pick(a.forge).getIssue(a.repo, a.number);
      return [
        issueLine(i),
        '',
        i.body.trim() || '(vide)',
        '',
        `## Discussion (${i.discussion.length})`,
        ...i.discussion
          .slice(-30)
          .map((m) => `- ${m.author}, ${day(m.at)} : ${m.body.slice(0, 1500)}`),
      ].join('\n');
    },
  });

  const comment = defineTool({
    name: 'forge_comment',
    description:
      'Post a comment as Brightky on a PR/MR (kind "change") or an issue. N2: Brightky confirms the exact text ' +
      'unless an auto-approve rule in the policy covers this repo.',
    input: {
      forge: forgeEnum.optional(),
      repo: repoPath,
      number: z.number().int().positive(),
      kind: z.enum(['change', 'issue']),
      body: z.string().min(1).max(20_000),
    },
    classify: (a): Classification => ({
      level: N2,
      rule: 'forge.comment',
      reason: `publishes a comment as Brightky on ${a.repo}`,
      destinations: [a.repo],
    }),
    summarize: (a) =>
      `Comment on ${a.forge ?? 'forge'} ${a.repo}#${a.number}: ${a.body.length > 300 ? `${a.body.slice(0, 300)}…` : a.body}`,
    run: async (a) => {
      const r = await pick(a.forge).comment(a.repo, a.number, a.kind, a.body);
      return `Commentaire publié : ${r.url}`;
    },
  });

  // ── Trello ──

  const boards = defineTool({
    name: 'trello_boards',
    description: "List Brightky's open Trello boards (id, name), most recently active first.",
    input: {},
    classify: () => read('trello.boards'),
    summarize: () => 'List Trello boards',
    ingestsExternal: true,
    run: async () => {
      const b = await trello().boards();
      return b.length
        ? b
            .map(
              (x) =>
                `- [${x.id}] ${x.name}${x.lastActivity ? ` (actif ${day(x.lastActivity)})` : ''}`,
            )
            .join('\n')
        : 'Aucun tableau.';
    },
  });

  const lists = defineTool({
    name: 'trello_lists',
    description: 'List the columns (lists) of a Trello board, with their ids.',
    input: { board: trelloId },
    classify: () => read('trello.lists'),
    summarize: () => 'List Trello columns',
    ingestsExternal: true,
    run: async (a) =>
      (await trello().lists(a.board)).map((l) => `- [${l.id}] ${l.name}`).join('\n') ||
      'Aucune liste.',
  });

  const cards = defineTool({
    name: 'trello_cards',
    description:
      'List Trello cards: of a board or a list, or those assigned to Brightky (default), optionally with a label ' +
      '(e.g. "jarvis").',
    input: {
      board: trelloId.optional(),
      list: trelloId.optional(),
      mine: z.boolean().optional(),
      label: z.string().max(40).optional(),
      max: z.number().int().min(1).max(200).optional(),
    },
    classify: () => read('trello.cards'),
    summarize: (a) => `List Trello cards${a.label ? ` labelled ${a.label}` : ''}`,
    ingestsExternal: true,
    run: async (a) => {
      const c = await trello().cards({
        ...(a.board && { boardId: a.board }),
        ...(a.list && { listId: a.list }),
        ...(a.mine !== undefined && { mine: a.mine }),
        ...(a.label && { label: a.label }),
        max: a.max ?? 30,
      });
      return c.length ? c.map(cardLine).join('\n') : 'Aucune carte.';
    },
  });

  const card = defineTool({
    name: 'trello_card',
    description: 'Read one Trello card: description, checklists and comments.',
    input: { id: trelloId },
    classify: () => read('trello.card'),
    summarize: () => 'Read a Trello card',
    ingestsExternal: true,
    run: async (a) => {
      const c = await trello().card(a.id);
      return [
        cardLine(c),
        c.url,
        '',
        c.desc.trim() || '(pas de description)',
        ...c.checklists.flatMap((l) => [
          `\n## ${l.name}`,
          ...l.items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.name}`),
        ]),
        `\n## Commentaires (${c.comments.length})`,
        ...c.comments.map((m) => `- ${m.author}, ${day(m.at)} : ${m.text.slice(0, 1500)}`),
      ].join('\n');
    },
  });

  const trelloComment = defineTool({
    name: 'trello_comment',
    description:
      'Comment on a Trello card as Brightky (N2: confirmed unless an auto-approve rule covers it).',
    input: { id: trelloId, text: z.string().min(1).max(10_000) },
    classify: (): Classification => ({
      level: N2,
      rule: 'trello.comment',
      reason: 'publishes a comment as Brightky on Trello',
    }),
    summarize: (a) =>
      `Comment on Trello card ${a.id}: ${a.text.length > 300 ? `${a.text.slice(0, 300)}…` : a.text}`,
    run: async (a) => `Commentaire publié : ${(await trello().comment(a.id, a.text)).url}`,
  });

  const trelloMove = defineTool({
    name: 'trello_move',
    description: 'Move a Trello card to another list (column) of its board (N2).',
    input: { id: trelloId, list: trelloId },
    classify: (a): Classification =>
      a.id === a.list
        ? forbid('input.invalid', 'card and list ids are the same')
        : { level: N2, rule: 'trello.move', reason: 'moves a card the team sees' },
    summarize: (a) => `Move Trello card ${a.id} to list ${a.list}`,
    run: async (a) => `Carte déplacée dans « ${(await trello().move(a.id, a.list)).list} ».`,
  });

  return [
    inbox,
    reviewQueue,
    prList,
    prRead,
    issueList,
    issueRead,
    comment,
    boards,
    lists,
    cards,
    card,
    trelloComment,
    trelloMove,
  ] as unknown as ToolDef[];
}
