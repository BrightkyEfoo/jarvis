import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LinkedInClient, LinkedInPost } from '@jarvis/connectors';
import { afterEach, describe, expect, it } from 'vitest';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import { makeExport } from '../../apps/jarvisd/test/fixtures/linkedin-export.ts';
import { type Harness, startHarness } from './harness.ts';

let h: Harness;
const published: { author: string; post: LinkedInPost }[] = [];
const fakeClient = {
  async post(author: string, post: LinkedInPost) {
    published.push({ author, post });
    return { urn: 'urn:li:share:9', url: 'https://www.linkedin.com/feed/update/urn:li:share:9/' };
  },
} as unknown as LinkedInClient;

async function setup(connected = true) {
  published.length = 0;
  h = await startHarness({
    linkedin: {
      client: () => (connected ? fakeClient : null),
      token: () =>
        connected
          ? {
              access_token: 'li-token-CANARY-1234567',
              expires_at: Date.now() + 30 * 86_400_000,
              person: 'urn:li:person:bk',
              name: 'Brightky',
            }
          : null,
    },
  });
}
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

describe('LinkedIn (ADR-037)', () => {
  it('publishes only after Brightky approves the exact text (N2), then remembers the post', async () => {
    await setup();
    expect(await ask('call linkedin_status {}')).toMatch(
      /Connecté en tant que Brightky ; jeton valable (29|30) jour\(s\)\./,
    );
    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: 'call linkedin_post {"text":"J\'ai réduit notre build de 40 % en 3 lignes.\\n\\nVoici comment."}',
    });
    for (let i = 0; i < 200 && h.rt.approvals.pending().length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    const req = h.rt.approvals.pending()[0];
    expect(req).toMatchObject({ level: 2, rule: 'linkedin.post' });
    expect(req?.summary).toContain("J'ai réduit notre build de 40 % en 3 lignes.");
    expect(published).toHaveLength(0);
    await (await h.rpc()).call({ cmd: 'approve', approvalId: req?.id ?? '' });
    expect(text((await pending).events)).toContain(
      'Publié : https://www.linkedin.com/feed/update/urn:li:share:9/',
    );
    expect(published[0]).toMatchObject({
      author: 'urn:li:person:bk',
      post: { text: expect.stringContaining('40 %') },
    });
    expect(await ask('call linkedin_status {}')).toContain('1 post(s) publiés par Jarvis');
    expect(JSON.stringify(h.rt.audit.query({ limit: 100 }))).not.toContain('li-token-CANARY');
    c.close();
  });

  it('only Jarvis-made assets can be attached; unknown ids and non-PDF documents are refused', async () => {
    await setup();
    expect(await ask('call linkedin_post {"text":"x","assets":["0123456789ab"]}')).toContain(
      'rule linkedin.unknown_asset',
    );
    writeFileSync(join(h.work, 'notes.txt'), 'x');
    expect(
      await ask(`call linkedin_post {"text":"x","pdf":"${join(h.work, 'notes.txt')}"}`),
    ).toContain('rule linkedin.pdf_only');
    expect(published).toHaveLength(0);
  });

  it('imports the analytics export and learns what works', async () => {
    await setup();
    const file = makeExport(mkdtempSync(join(h.work, 'dl-')));
    expect(await ask(`call linkedin_stats_import {"path":"${file}"}`)).toContain(
      '5 post(s) importés depuis Content_2026-10-01_2026-10-05_BrightkyEfoo.xlsx (du 2026-10-01 au 2026-10-05)',
    );
    const out = await ask('call linkedin_insights {}');
    expect(out).toContain('5 posts analysés.');
    expect(out).toMatch(
      /Au-dessus de ta médiane \(×1,5 et plus\) : 1\n- 2026-10-04 : 3000 impressions \(×3,0/,
    );
    expect(out).toMatch(/En dessous \(×0,6 et moins\) : 1\n- 2026-10-05 : 300 impressions/);
  });

  it('never drives linkedin.com in the browser (LinkedIn forbids automation)', async () => {
    await setup(false);
    expect(await ask('call browser_open {"url":"https://www.linkedin.com/feed/"}')).toMatch(
      /^KO Action refused \(N4/,
    );
    expect(await ask('call linkedin_post {"text":"x"}')).toContain('rule linkedin.not_connected');
  });
});
