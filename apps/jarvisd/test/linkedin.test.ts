import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeLittleText, LinkedInClient } from '@jarvis/connectors';
import { describe, expect, it } from 'vitest';
import { features, lessons, score } from '../src/linkedin/insights.ts';
import { isoDay, postStats, readXlsx } from '../src/linkedin/xlsx.ts';
import { makeExport } from './fixtures/linkedin-export.ts';

describe('LinkedIn', () => {
  it('escapes the little-text characters that would cut or garble a post', () => {
    expect(escapeLittleText('Use (a) [b] @me #tag *x* _y_ ~z~ <T> {c} | \\')).toBe(
      'Use \\(a\\) \\[b\\] \\@me \\#tag \\*x\\* \\_y\\_ \\~z\\~ \\<T\\> \\{c\\} \\| \\\\',
    );
  });

  it('posts through the official API: versioned headers, upload to LinkedIn only, URN back', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
      [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' && { body: init.body }),
      });
      if (url.includes('action=initializeUpload'))
        return Response.json({
          value: {
            uploadUrl: 'https://www.linkedin.com/dms-uploads/abc',
            image: 'urn:li:image:42',
          },
        });
      if (url.startsWith('https://www.linkedin.com/dms-uploads/'))
        return new Response(null, { status: 201 });
      if (url.endsWith('/rest/posts'))
        return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:777' } });
      return new Response('nope', { status: 404 });
    }) as typeof globalThis.fetch;
    const client = new LinkedInClient({ token: () => 'TOKEN', fetch });
    const r = await client.post('urn:li:person:me', {
      text: 'Mon hook (court)',
      images: [{ bytes: new Uint8Array([1, 2]), mime: 'image/png', alt: 'carte' }],
    });
    expect(r).toEqual({
      urn: 'urn:li:share:777',
      url: 'https://www.linkedin.com/feed/update/urn:li:share:777/',
    });
    const post = calls.find((c) => c.url.endsWith('/rest/posts'));
    expect(post?.headers['linkedin-version']).toBe('202609');
    expect(post?.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({
      author: 'urn:li:person:me',
      commentary: 'Mon hook \\(court\\)',
      visibility: 'PUBLIC',
      content: { media: { id: 'urn:li:image:42', altText: 'carte' } },
      lifecycleState: 'PUBLISHED',
    });

    const evil = (async (input: string | URL | Request) =>
      String(input).includes('initializeUpload')
        ? Response.json({
            value: { uploadUrl: 'https://evil.example/upload', image: 'urn:li:image:1' },
          })
        : new Response(null, { status: 201 })) as typeof globalThis.fetch;
    await expect(
      new LinkedInClient({ token: () => 'TOKEN', fetch: evil }).post('urn:li:person:me', {
        text: 'x',
        images: [{ bytes: new Uint8Array([1]), mime: 'image/png', alt: 'a' }],
      }),
    ).rejects.toThrow(/adresse de dépôt inattendue/);
  });

  it('reads the creator-analytics export (two tables side by side, dates in any form)', async () => {
    const file = makeExport(mkdtempSync(join(tmpdir(), 'li-')));
    const rows = postStats(await readXlsx(file));
    expect(rows).toHaveLength(5);
    expect(rows[3]).toEqual({
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:4',
      date: '2026-10-04',
      impressions: 3000,
      engagements: 13,
    });
    expect(isoDay('46296')).toBe('2026-10-01');
    expect(isoDay('2026-10-03T08:00')).toBe('2026-10-03');
  });

  it('labels tops and flops against the recent median, and finds what differs', () => {
    const base = new Date('2026-09-01T09:00:00');
    const posts = Array.from({ length: 14 }, (_, i) => {
      const doc = i % 2 === 0;
      return {
        id: `p${i}`,
        date: `2026-09-${String(i + 1).padStart(2, '0')}`,
        impressions: doc ? 3000 : 800,
        engagements: null,
        features: features(
          doc ? 'Hook court\nsuite' : 'Un long hook qui dit tout et rien\nsuite https://x.y',
          base,
          {
            images: 0,
            document: doc,
          },
        ),
      };
    });
    const scored = score(posts);
    expect(scored[0]?.label).toBe('new');
    expect(scored.filter((p) => p.label === 'top').length).toBeGreaterThan(0);
    expect(scored.filter((p) => p.label === 'flop').length).toBeGreaterThan(0);
    const learned = lessons(scored);
    expect(learned[0]).toMatch(/^↑ Avec un document PDF \(carrousel\)/);
    expect(learned.some((l) => l.startsWith('↓ Avec un lien dans le texte'))).toBe(true);
  });
});
