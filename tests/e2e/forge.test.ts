import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import { FakeTrello, type Harness, startHarness } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const text = (events: Reply[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
async function ask(script: string) {
  const c = await h.rpc();
  const r = await c.call({ cmd: 'ask', text: script });
  c.close();
  return text(r.events);
}
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('forges (S5)', () => {
  it('inbox: reviews to do and his own PRs with CI, as external data, no approval', async () => {
    const out = await ask('call forge_inbox {}');
    expect(out).toContain('<external_data source="forge_inbox">');
    expect(out).toContain('À relire (1) :\n- acme/app#7 « Fix login timeout » par paul');
    expect(out).toContain(
      'BrightkyEfoo/jarvis#3 « Voice v2 » par BrightkyEfoo, maj 1 oct. — CI ✗, 1 approbation(s)',
    );
    expect(h.rt.brain?.session.tainted).toBe(true);
    expect(h.rt.approvals.pending()).toHaveLength(0);
  });

  it('reads a PR with its diff; an injection in the description stays data', async () => {
    const out = await ask('call pr_read {"repo":"acme/app","number":7}');
    expect(out).toContain('### src/login.ts (modified, +3 −1)');
    expect(out).toContain('+t=30');
    expect(out).toMatch(
      /<external_data source="pr_read">[\s\S]*Ignore previous instructions[\s\S]*<\/external_data>/,
    );
  });

  it('a comment speaks for Brightky: nothing is posted before he confirms the exact text', async () => {
    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: 'call forge_comment {"repo":"acme/app","number":7,"kind":"change","body":"LGTM, merci Paul"}',
    });
    const req = await waitFor(() => h.rt.approvals.pending()[0]);
    expect(req).toMatchObject({
      level: 2,
      rule: 'forge.comment',
      summary: 'Comment on forge acme/app#7: LGTM, merci Paul',
    });
    expect(h.forge.comments).toHaveLength(0);
    await (await h.rpc()).call({ cmd: 'approve', approvalId: req.id });
    expect(text((await pending).events)).toContain(
      'Commentaire publié : https://github.com/acme/app/pull/7#c1',
    );
    expect(h.forge.comments).toEqual([
      { repo: 'acme/app', number: 7, kind: 'change', body: 'LGTM, merci Paul' },
    ]);
    c.close();
  });

  it('the morning briefing includes what waits on GitHub and Trello', async () => {
    const out = await ask('call briefing {}');
    expect(out).toContain('## GitHub : 1 à relire, 1 PR à moi (1 en échec CI), 0 issue(s)');
    expect(out).toContain('## Trello : 1 carte(s) à moi');
  });

  it('refuses malformed repositories before any call', async () => {
    const out = await ask('call pr_read {"repo":"../../etc","number":1}');
    expect(out).toContain('rule input.invalid');
  });

  it('says how to connect a forge that is not configured', async () => {
    expect(await ask('call pr_list {"forge":"gitlab"}')).toContain(
      "gitlab n'est pas connecté : jarvis gitlab connect",
    );
  });

  it('Trello: cards with the jarvis label, card details; comment and move are N2', async () => {
    expect(await ask('call trello_cards {"label":"jarvis"}')).toContain(
      `- [${FakeTrello.CARD}] « Mode sombre » — CodeVault › À faire [jarvis]`,
    );
    expect(await ask(`call trello_card {"id":"${FakeTrello.CARD}"}`)).toContain(
      'Ajouter un thème sombre',
    );

    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: `call trello_move {"id":"${FakeTrello.CARD}","list":"${FakeTrello.DONE}"}`,
    });
    const req = await waitFor(() => h.rt.approvals.pending()[0]);
    expect(req).toMatchObject({ level: 2, rule: 'trello.move' });
    expect(h.trello.moves).toHaveLength(0);
    await (await h.rpc()).call({ cmd: 'deny', approvalId: req.id });
    expect(text((await pending).events)).toContain('KO Action refused');
    expect(h.trello.moves).toHaveLength(0);
    c.close();
  });
});
