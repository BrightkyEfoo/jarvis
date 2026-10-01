import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import { type Harness, startHarness } from './harness.ts';

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

describe('research', () => {
  it('returns a sourced synthesis as external data, without asking (N0)', async () => {
    const out = await ask(
      'call web_research {"question":"Compare Tauri et Electron pour notre HUD","depth":"deep"}',
    );
    expect(out).toContain('<external_data source="web_research">');
    expect(out).toContain('Sources :\n- Source — https://example.org/article');
    expect(h.researcher.requests[0]).toMatchObject({
      depth: 'deep',
      question: 'Compare Tauri et Electron pour notre HUD',
    });
    expect(h.rt.brain?.session.tainted).toBe(true);
    expect(h.rt.approvals.pending()).toHaveLength(0);
  });

  it('"watches" a video through its subtitles, with timestamps', async () => {
    const out = await ask(
      'call youtube_watch {"video":"https://youtu.be/arj7oStGLkU","question":"Quels conseils concrets ?"}',
    );
    expect(out).toContain(
      '« Inside the Mind of a Master Procrastinator » — TED (14:04) https://youtu.be/arj7oStGLkU · sous-titres en',
    );
    expect(out).toContain('[00:30] point de la vidéo');
    expect(h.researcher.requests[0]?.documents?.[0]).toMatchObject({
      source: 'https://youtu.be/arj7oStGLkU',
      text: '[00:00] So in college…',
    });
  });

  it('refuses links that are not YouTube videos and says when there are no subtitles', async () => {
    expect(
      await ask('call youtube_watch {"video":"https://evil.test/watch?v=arj7oStGLkU"}'),
    ).toContain('not a YouTube video link');
    expect(await ask('call youtube_watch {"video":"noSubtitles"}')).toContain('Pas de sous-titres');
  });

  it('searches YouTube', async () => {
    expect(await ask('call youtube_search {"query":"procrastination"}')).toContain(
      '1. Inside the Mind of a Master Procrastinator — TED (14:04) https://youtu.be/arj7oStGLkU',
    );
  });
});
