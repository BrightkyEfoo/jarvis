import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defineTool, N0, type ToolDef } from '@jarvis/policy';
import { z } from 'zod';
import { formatResearch, type Researcher } from '../orchestrator/research.ts';

const run = promisify(execFile);

export interface VideoHit {
  id: string;
  title: string;
  channel: string;
  durationS: number | null;
}

export interface VideoInfo extends VideoHit {
  lang: string | null;
  transcript: string;
}

/** YouTube access, injected so tests never touch the network. */
export interface YouTube {
  search(query: string, max: number, signal: AbortSignal): Promise<VideoHit[]>;
  fetch(id: string, signal: AbortSignal): Promise<VideoInfo>;
}

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

/** Accepts a YouTube URL or a bare id; returns the 11-char id or null. Jarvis rebuilds the URL itself. */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (ID.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!HOSTS.has(u.hostname)) return null;
  const candidate =
    u.hostname === 'youtu.be'
      ? u.pathname.slice(1)
      : (u.searchParams.get('v') ??
        /^\/(shorts|live|embed)\/([^/?#]+)/.exec(u.pathname)?.[2] ??
        '');
  return ID.test(candidate) ? candidate : null;
}

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** YouTube json3 captions → "[mm:ss] text" paragraphs of ~30 s, compact enough for the model. */
export function json3ToTranscript(raw: string, bucketMs = 30_000): string {
  const doc = JSON.parse(raw) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
  const out: string[] = [];
  let start = -1;
  let words: string[] = [];
  const flush = () => {
    const text = words.join(' ').replace(/\s+/g, ' ').trim();
    if (text) out.push(`[${mmss(start)}] ${text}`);
    words = [];
  };
  for (const e of doc.events ?? []) {
    if (!e.segs) continue;
    const t = e.tStartMs ?? 0;
    if (start < 0) start = t;
    if (t - start >= bucketMs) {
      flush();
      start = t;
    }
    words.push(e.segs.map((s) => s.utf8 ?? '').join(''));
  }
  flush();
  return out.join('\n');
}

const MAX_TRANSCRIPT = 120_000;

/** yt-dlp, subtitles only: never downloads the video itself (metered connection). */
export class YtDlp implements YouTube {
  readonly #bin: string;
  readonly #scratch: string;
  readonly #env: Record<string, string>;

  constructor(opts: { binary: string; scratch: string }) {
    this.#bin = opts.binary;
    this.#scratch = opts.scratch;
    // Node 24 solves YouTube's JS challenges (no Deno download needed).
    this.#env = {
      PATH: `${join(process.execPath, '..')}:/usr/bin:/bin`,
      HOME: homedir(),
      LANG: 'en_US.UTF-8',
    };
  }

  static locate(): string | null {
    return (
      [
        join(homedir(), '.local/bin/yt-dlp'),
        '/opt/homebrew/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
      ].find((p) => existsSync(p)) ?? null
    );
  }

  async search(q: string, max: number, signal: AbortSignal): Promise<VideoHit[]> {
    const { stdout } = await run(
      this.#bin,
      [
        '--js-runtimes',
        'node',
        '--flat-playlist',
        '--dump-single-json',
        '--no-warnings',
        '--',
        `ytsearch${max}:${q}`,
      ],
      { env: this.#env, signal, timeout: 60_000, maxBuffer: 20_000_000 },
    );
    const doc = JSON.parse(stdout) as {
      entries?: {
        id: string;
        title?: string;
        channel?: string;
        uploader?: string;
        duration?: number;
      }[];
    };
    return (doc.entries ?? [])
      .filter((e) => ID.test(e.id))
      .map((e) => ({
        id: e.id,
        title: e.title ?? '',
        channel: e.channel ?? e.uploader ?? '',
        durationS: e.duration ?? null,
      }));
  }

  async fetch(id: string, signal: AbortSignal): Promise<VideoInfo> {
    if (!ID.test(id)) throw new Error('invalid video id');
    const dir = mkdtempSync(join(this.#scratch, 'yt-'));
    try {
      const { stdout } = await run(
        this.#bin,
        [
          '--js-runtimes',
          'node',
          '--no-simulate',
          '--skip-download',
          '--write-subs',
          '--write-auto-subs',
          '--sub-langs',
          'fr,en',
          '--sub-format',
          'json3',
          '--no-warnings',
          '--no-progress',
          '-o',
          '%(id)s.%(ext)s',
          '--print',
          '%(.{id,title,channel,duration})j',
          '--',
          `https://www.youtube.com/watch?v=${id}`,
        ],
        { cwd: dir, env: this.#env, signal, timeout: 120_000, maxBuffer: 20_000_000 },
      );
      const meta = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
        id?: string;
        title?: string;
        channel?: string;
        duration?: number;
      };
      const files = readdirSync(dir);
      const pick = ['fr', 'en']
        .map((l) => [l, files.find((f) => f.endsWith(`.${l}.json3`))] as const)
        .find(([, f]) => f);
      const transcript = pick?.[1]
        ? json3ToTranscript(readFileSync(join(dir, pick[1]), 'utf8'))
        : '';
      return {
        id,
        title: meta.title ?? '',
        channel: meta.channel ?? '',
        durationS: meta.duration ?? null,
        lang: pick?.[0] ?? null,
        transcript: transcript.slice(0, MAX_TRANSCRIPT),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const duration = (s: number | null) =>
  s === null ? '?' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export interface ResearchToolDeps {
  researcher: Researcher | null;
  youtube: YouTube | null;
}

export function createResearchTools(d: ResearchToolDeps): ToolDef[] {
  const researcher = () => {
    if (!d.researcher)
      throw new Error('research needs the subscription token (jarvis auth set-token)');
    return d.researcher;
  };
  const youtube = () => {
    if (!d.youtube) throw new Error('yt-dlp is missing: uv tool install --with yt-dlp-ejs yt-dlp');
    return d.youtube;
  };

  const webResearch = defineTool({
    name: 'web_research',
    description:
      'Research the web and get a sourced synthesis (isolated agent: web search + a few page reads). ' +
      'depth "quick" (Sonnet, ~10–30 s) for facts and comparisons; "deep" (Opus, longer) for real studies. ' +
      'Announce it in one short sentence first: it takes a moment.',
    input: {
      question: z.string().min(3).max(1000),
      depth: z.enum(['quick', 'deep']).default('quick'),
    },
    classify: () => ({ level: N0, rule: 'research.web', reason: 'reads public web pages' }),
    summarize: (a) => `Web research (${a.depth}): ${a.question}`,
    ingestsExternal: true,
    run: async (a, ctx) =>
      formatResearch(
        await researcher().research({ question: a.question, depth: a.depth }, ctx.signal),
      ),
  });

  const youtubeSearch = defineTool({
    name: 'youtube_search',
    description: 'Find YouTube videos (title, channel, length, link). Metadata only.',
    input: { query: z.string().min(2).max(200), max: z.number().int().min(1).max(10).default(5) },
    classify: () => ({
      level: N0,
      rule: 'research.youtube_search',
      reason: 'reads public metadata',
    }),
    summarize: (a) => `YouTube search: ${a.query}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const hits = await youtube().search(a.query, a.max, ctx.signal);
      if (hits.length === 0) return 'Aucune vidéo trouvée.';
      return hits
        .map(
          (h, i) =>
            `${i + 1}. ${h.title} — ${h.channel} (${duration(h.durationS)}) https://youtu.be/${h.id}`,
        )
        .join('\n');
    },
  });

  const youtubeWatch = defineTool({
    name: 'youtube_watch',
    description:
      '"Watch" a YouTube video for Brightky: reads its subtitles (never downloads the video) and answers a ' +
      'question about it, or summarises it with timestamps. Accepts a URL or a video id.',
    input: { video: z.string().min(11).max(300), question: z.string().max(1000).optional() },
    classify: () => ({
      level: N0,
      rule: 'research.youtube_watch',
      reason: 'reads public subtitles',
    }),
    summarize: (a) => `Watch video ${a.video}${a.question ? `: ${a.question}` : ''}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const id = youtubeId(a.video);
      if (!id) throw new Error('not a YouTube video link');
      const info = await youtube().fetch(id, ctx.signal);
      const header = `« ${info.title} » — ${info.channel} (${duration(info.durationS)}) https://youtu.be/${id}`;
      if (!info.transcript)
        return `${header}\nPas de sous-titres pour cette vidéo : impossible de la résumer sans télécharger l'audio.`;
      const r = await researcher().research(
        {
          question:
            a.question ??
            'Résume cette vidéo : idées principales et conseils concrets, avec horodatages.',
          depth: 'quick',
          documents: [
            { title: info.title, source: `https://youtu.be/${id}`, text: info.transcript },
          ],
        },
        ctx.signal,
      );
      return `${header} · sous-titres ${info.lang}\n\n${formatResearch(r)}`;
    },
  });

  return [webResearch, youtubeSearch, youtubeWatch] as unknown as ToolDef[];
}
