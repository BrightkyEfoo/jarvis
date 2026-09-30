import type { Memory } from '@jarvis/memory';
import { defineTool, N0, N1, N2, type ToolDef } from '@jarvis/policy';
import { z } from 'zod';

const KIND = z.enum(['preference', 'contact', 'project', 'note']);

export function createMemoryTools(memory: Memory): ToolDef[] {
  const search = defineTool({
    name: 'memory_search',
    description:
      'Search what Jarvis remembers (facts about preferences, contacts, projects, notes).',
    input: {
      query: z.string().min(1).max(300),
      limit: z.number().int().min(1).max(30).default(10),
    },
    classify: () => ({ level: N0, rule: 'memory.search', reason: 'read-only' }),
    summarize: (a) => `Search memory for "${a.query}"`,
    run: async (a, ctx) => {
      const facts = memory.search(a.query, a.limit);
      if (facts.length === 0) return 'Nothing remembered about that.';
      const external = facts.filter((f) => f.source === 'external');
      // Facts that came from external content stay data: they taint the session when recalled.
      if (external.length > 0) ctx.session.ingestExternal(external.map((f) => f.text).join('\n'));
      return facts
        .map((f) => {
          const line = `#${f.id} [${f.kind}] ${f.text}`;
          return f.source === 'external'
            ? `<external_data source="memory">${line}</external_data>`
            : line;
        })
        .join('\n');
    },
  });

  const remember = defineTool({
    name: 'memory_remember',
    description:
      'Remember a fact for future conversations (preference, contact, project, note). One short sentence. ' +
      'Only what Brightky asked to remember or clearly useful long-term; never secrets.',
    input: { kind: KIND, text: z.string().min(3).max(500) },
    // After external content, a "fact" may be an injection trying to persist: Brightky confirms.
    classify: (_a, ctx) =>
      ctx.session.tainted
        ? {
            level: N2,
            rule: 'memory.write_after_external',
            reason: 'conversation contains external content',
          }
        : { level: N1, rule: 'memory.write', reason: 'local and reversible' },
    summarize: (a) => `Remember [${a.kind}]: ${a.text}`,
    run: async (a, ctx) => {
      const f = memory.remember(a.kind, a.text, ctx.session.tainted ? 'external' : 'jarvis');
      return `Remembered as #${f.id}${f.source === 'external' ? ' (marked as coming from external content)' : ''}.`;
    },
  });

  const forget = defineTool({
    name: 'memory_forget',
    description: 'Forget a remembered fact by its #id (archived, not destroyed).',
    input: { id: z.number().int().positive() },
    classify: () => ({
      level: N1,
      rule: 'memory.forget',
      reason: 'soft delete, kept in the archive',
    }),
    summarize: (a) => `Forget memory #${a.id}`,
    run: async (a) => (memory.forget(a.id) ? `Forgot #${a.id}.` : `No active memory #${a.id}.`),
  });

  return [search, remember, forget] as unknown as ToolDef[];
}
