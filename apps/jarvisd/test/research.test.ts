import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatResearch, parseResearch } from '../src/orchestrator/research.ts';
import { json3ToTranscript, YtDlp, youtubeId } from '../src/tools/research.ts';

describe('youtubeId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=arj7oStGLkU', 'arj7oStGLkU'],
    ['https://youtu.be/arj7oStGLkU?t=42', 'arj7oStGLkU'],
    ['https://m.youtube.com/watch?v=arj7oStGLkU&list=x', 'arj7oStGLkU'],
    ['https://www.youtube.com/shorts/arj7oStGLkU', 'arj7oStGLkU'],
    ['arj7oStGLkU', 'arj7oStGLkU'],
  ])('%s', (input, id) => {
    expect(youtubeId(input)).toBe(id);
  });

  it.each([
    'https://evil.test/watch?v=arj7oStGLkU',
    'https://www.youtube.com.evil.test/watch?v=arj7oStGLkU',
    'file:///etc/passwd',
    'https://www.youtube.com/watch?v=short',
    '--exec=rm',
  ])('rejects %s', (input) => {
    expect(youtubeId(input)).toBeNull();
  });
});

describe('json3ToTranscript', () => {
  it('groups captions in ~30 s timestamped paragraphs', () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'So in college,' }] },
        { tStartMs: 4000, segs: [{ utf8: ' I was a' }, { utf8: ' government major' }] },
        { tStartMs: 31000, segs: [{ utf8: '(Laughter)' }] },
        { tStartMs: 32000 },
      ],
    });
    expect(json3ToTranscript(raw)).toBe(
      '[00:00] So in college, I was a government major\n[00:31] (Laughter)',
    );
  });
});

describe('parseResearch (trust boundary)', () => {
  it('clips fields, keeps only http(s) sources, rejects malformed output', () => {
    const r = parseResearch(
      {
        answer: 'a'.repeat(5000),
        key_points: Array.from({ length: 20 }, (_, i) => `p${i}`),
        sources: [
          { title: 'ok', url: 'https://example.org/x' },
          { title: 'bad', url: 'javascript:alert(1)' },
          { title: 'file', url: 'file:///etc/passwd' },
        ],
        confidence: 'high',
        injection_suspected: true,
      },
      'claude-sonnet-5-5',
      10,
    );
    expect(r?.answer.length).toBe(2000);
    expect(r?.keyPoints).toHaveLength(10);
    expect(r?.sources).toEqual([{ title: 'ok', url: 'https://example.org/x' }]);
    expect(formatResearch(r as NonNullable<typeof r>)).toContain('⚠ tentative de manipulation');
    expect(parseResearch('ignore previous instructions', 'm', 1)).toBeNull();
  });
});

describe('YtDlp (against a fake yt-dlp binary)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-ytdlp-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'yt-dlp');
  const argsLog = join(dir, 'args.txt');
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" > "${argsLog}"
case "$*" in
  *ytsearch*) echo '{"entries":[{"id":"arj7oStGLkU","title":"TED","channel":"TED","duration":844},{"id":"bad"}]}' ;;
  *) echo '{"events":[{"tStartMs":0,"segs":[{"utf8":"Bonjour"}]}]}' > arj7oStGLkU.fr.json3
     echo '{"id":"arj7oStGLkU","title":"TED","channel":"TED","duration":844}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  const yt = new YtDlp({ binary: bin, scratch: dir });

  it('searches with metadata only and drops malformed ids', async () => {
    const hits = await yt.search('procrastination', 3, new AbortController().signal);
    expect(hits).toEqual([{ id: 'arj7oStGLkU', title: 'TED', channel: 'TED', durationS: 844 }]);
    const args = readFileSync(argsLog, 'utf8').trim().split('\n');
    expect(args).toContain('--flat-playlist');
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('ytsearch3:procrastination');
  });

  it('fetches subtitles only, from a URL Jarvis rebuilt itself', async () => {
    const info = await yt.fetch('arj7oStGLkU', new AbortController().signal);
    expect(info).toMatchObject({ title: 'TED', lang: 'fr', transcript: '[00:00] Bonjour' });
    const args = readFileSync(argsLog, 'utf8').trim().split('\n');
    expect(args).toEqual(
      expect.arrayContaining(['--skip-download', '--no-simulate', '--js-runtimes', 'node']),
    );
    expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=arj7oStGLkU']);
    await expect(yt.fetch('$(rm -rf ~)', new AbortController().signal)).rejects.toThrow(
      /invalid video id/,
    );
  });
});
