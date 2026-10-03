import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { LinkedInClient, LinkedInToken } from '@jarvis/connectors';
import {
  type Classification,
  defineTool,
  type FsPolicy,
  forbid,
  isForbiddenApp,
  N0,
  N1,
  N2,
  type Policy,
  screenRules,
  type ToolDef,
} from '@jarvis/policy';
import { z } from 'zod';
import type { Actuator } from '../computer/bridge.ts';
import { features, lessons, score } from '../linkedin/insights.ts';
import type { LinkedInStore } from '../linkedin/store.ts';
import { postStats, readXlsx } from '../linkedin/xlsx.ts';

export interface LinkedInToolDeps {
  policy: Policy;
  store: LinkedInStore;
  /** Null when Brightky has not connected LinkedIn (jarvis linkedin connect). */
  client: () => LinkedInClient | null;
  token: () => LinkedInToken | null;
  actuator: Actuator;
  fs: FsPolicy;
  assetsDir: string;
  now?: () => Date;
}

const assetId = z.string().regex(/^[a-f0-9]{12}$/);
const DAY = 86_400_000;

const looksLikeExport = (name: string) =>
  /\.xlsx$/i.test(name) && /content|linkedin|analytics|post/i.test(name);

export function createLinkedInTools(d: LinkedInToolDeps): ToolDef[] {
  const now = () => d.now?.() ?? new Date();
  const rules = screenRules(d.policy.computer);
  const newAsset = (
    kind: 'card' | 'screenshot',
    bytes: Buffer,
    ext: 'png' | 'jpg',
    alt: string,
  ) => {
    mkdirSync(d.assetsDir, { recursive: true, mode: 0o700 });
    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const path = join(d.assetsDir, `${id}.${ext}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    d.store.addAsset({ id, kind, path, alt, createdAt: now().toISOString() });
    return { id, path };
  };

  const status = defineTool({
    name: 'linkedin_status',
    description:
      'Is LinkedIn connected (as whom, token expiry), how many posts and imported stats Jarvis knows.',
    input: {},
    classify: () => ({ level: N0, rule: 'linkedin.status', reason: 'read-only' }),
    summarize: () => 'LinkedIn status',
    run: async () => {
      const t = d.token();
      const days = t ? Math.floor((t.expires_at - now().getTime()) / DAY) : 0;
      return [
        t
          ? `Connecté${t.name ? ` en tant que ${t.name}` : ''} ; jeton valable ${days} jour(s)${days < 10 ? ' — reconnecte bientôt : jarvis linkedin connect' : ''}.`
          : 'Non connecté : jarvis linkedin connect (voir docs/SETUP-LINKEDIN.md).',
        `${d.store.posts(1000).length} post(s) publiés par Jarvis, ${d.store.stats().length} post(s) avec statistiques importées.`,
      ].join('\n');
    },
  });

  const card = defineTool({
    name: 'linkedin_card',
    description:
      'Render a "screenshot of text" for a post: a quote or a code snippet set as a 1080×1350 card signed ' +
      "Brightky Efo'o (made locally by Jarvis.app). Returns an asset id for linkedin_post, and the image so " +
      'you can check it. Keep it short: one idea, ~12 lines of code at most.',
    input: {
      style: z.enum(['quote', 'code']),
      text: z.string().min(1).max(1500),
      title: z.string().max(120).optional(),
      alt: z.string().min(3).max(300),
    },
    classify: () => ({ level: N1, rule: 'linkedin.card', reason: 'creates a local image' }),
    summarize: (a) => `Make a ${a.style} card: ${a.title ?? a.text.slice(0, 60)}`,
    run: async (a, ctx) => {
      const r = (await d.actuator.perform(
        {
          kind: 'render.card',
          style: a.style,
          text: a.text,
          ...(a.title && { title: a.title }),
          footer: "Brightky Efo'o",
        },
        ctx.signal,
        20_000,
      )) as { image?: unknown };
      if (typeof r.image !== 'string' || r.image.length > 15_000_000)
        throw new Error('rendu invalide');
      const asset = newAsset('card', Buffer.from(r.image, 'base64'), 'png', a.alt);
      return {
        text: `Carte prête : asset ${asset.id} (${asset.path}).`,
        images: [{ data: r.image, mimeType: 'image/png' as const }],
      };
    },
  });

  const screenshot = defineTool({
    name: 'linkedin_screenshot',
    description:
      "Capture an app's front window (e.g. the editor, a terminal-free demo, a dashboard) as an image asset " +
      'for a post. Check what it shows before proposing to publish it: nothing private.',
    input: { app: z.string().min(1).max(60), alt: z.string().min(3).max(300) },
    classify: (a): Classification =>
      isForbiddenApp(a.app, rules)
        ? forbid('computer.deny.app', `${a.app} is never captured`)
        : { level: N1, rule: 'linkedin.screenshot', reason: 'captures a window into a local file' },
    summarize: (a) => `Capture ${a.app} for a post`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const r = (await d.actuator.perform(
        { kind: 'screen.look', app: a.app },
        ctx.signal,
        20_000,
      )) as {
        app?: unknown;
        image?: unknown;
      };
      if (typeof r.app === 'string' && isForbiddenApp(r.app, rules))
        throw new Error(`${r.app} n'est jamais capturé`);
      if (typeof r.image !== 'string') throw new Error('capture invalide');
      const asset = newAsset('screenshot', Buffer.from(r.image, 'base64'), 'jpg', a.alt);
      return {
        text: `Capture prête : asset ${asset.id} (${asset.path}). Vérifie qu'elle ne montre rien de privé.`,
        images: [{ data: r.image, mimeType: 'image/jpeg' as const }],
      };
    },
  });

  const post = defineTool({
    name: 'linkedin_post',
    description:
      "Publish a post on Brightky's LinkedIn profile NOW, through the official API, after he approves the " +
      'exact text (he sees it in the approval). Images are asset ids from linkedin_card / linkedin_screenshot ' +
      '(up to 20); pdf is a document (carousel) inside his folders. Never schedule: publish only when he says so.',
    input: {
      text: z.string().min(1).max(3000),
      assets: z.array(assetId).max(20).optional(),
      pdf: z.string().max(1024).optional(),
      pdf_title: z.string().max(200).optional(),
    },
    classify: (a, ctx): Classification => {
      if (!d.token())
        return forbid(
          'linkedin.not_connected',
          "LinkedIn n'est pas connecté : jarvis linkedin connect",
        );
      if (a.pdf && a.assets?.length) return forbid('input.invalid', 'images or a PDF, not both');
      if (a.pdf) {
        const c = d.fs.check(a.pdf, 'read', ctx.cwd);
        if (c.level >= 4) return c;
        if (extname(c.path).toLowerCase() !== '.pdf')
          return forbid('linkedin.pdf_only', 'documents must be PDF');
      }
      for (const id of a.assets ?? [])
        if (!d.store.asset(id)) return forbid('linkedin.unknown_asset', `asset ${id} inconnu`);
      return { level: N2, rule: 'linkedin.post', reason: 'publishes publicly in Brightky’s name' };
    },
    summarize: (a) => {
      const media = a.pdf
        ? ` + PDF ${basename(a.pdf)}`
        : a.assets?.length
          ? ` + ${a.assets.length} image(s) : ${a.assets.map((id) => d.store.asset(id)?.path ?? id).join(', ')}`
          : '';
      return `Post on LinkedIn (${a.text.length} chars${media}): "${a.text.slice(0, 700)}${a.text.length > 700 ? '…' : ''}"`;
    },
    run: async (a, ctx) => {
      const client = d.client();
      const token = d.token();
      if (!client || !token)
        throw new Error("LinkedIn n'est pas connecté : jarvis linkedin connect");
      if (token.expires_at < now().getTime())
        throw new Error('jeton LinkedIn expiré : jarvis linkedin connect');
      const images = (a.assets ?? []).map((id) => {
        const asset = d.store.asset(id);
        if (!asset) throw new Error(`asset ${id} inconnu`);
        return {
          bytes: readFileSync(asset.path),
          mime: asset.path.endsWith('.png') ? ('image/png' as const) : ('image/jpeg' as const),
          alt: asset.alt,
        };
      });
      const pdf = a.pdf ? d.fs.check(a.pdf, 'read', ctx.cwd).path : undefined;
      const result = await client.post(token.person, {
        text: a.text,
        ...(images.length && { images }),
        ...(pdf && {
          document: { bytes: readFileSync(pdf), title: a.pdf_title ?? basename(pdf, '.pdf') },
        }),
      });
      const at = now();
      d.store.addPost({
        id: randomUUID(),
        urn: result.urn,
        url: result.url,
        text: a.text,
        createdAt: at.toISOString(),
        features: features(a.text, at, { images: images.length, document: Boolean(pdf) }),
      });
      return `Publié : ${result.url}`;
    },
  });

  const statsImport = defineTool({
    name: 'linkedin_stats_import',
    description:
      'Import the creator-analytics export Brightky downloaded from LinkedIn (Analytics › Export, .xlsx). ' +
      'Without a path: the newest such file in ~/Downloads. Jarvis never reads linkedin.com itself.',
    input: { path: z.string().max(1024).optional() },
    classify: (a, ctx): Classification => {
      if (!a.path)
        return { level: N0, rule: 'linkedin.import', reason: 'reads an export in Downloads' };
      const c = d.fs.check(a.path, 'read', ctx.cwd);
      if (c.level < 4) return c;
      const p = resolve(a.path.replace(/^~(?=\/)/, homedir()));
      return p.startsWith(`${join(homedir(), 'Downloads')}/`) && /\.xlsx$/i.test(p)
        ? { level: N0, rule: 'linkedin.import', reason: 'reads an export in Downloads' }
        : c;
    },
    summarize: (a) => `Import LinkedIn stats${a.path ? ` from ${a.path}` : ''}`,
    ingestsExternal: true,
    run: async (a) => {
      let file = a.path ? resolve(a.path.replace(/^~(?=\/)/, homedir())) : '';
      if (!file) {
        const dir = join(homedir(), 'Downloads');
        const candidates = existsSync(dir)
          ? readdirSync(dir)
              .filter(looksLikeExport)
              .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
              .sort((x, y) => y.t - x.t)
          : [];
        if (!candidates[0])
          return 'Aucun export trouvé dans Téléchargements. Sur LinkedIn : Analytics › Contenu › Exporter (.xlsx), puis redemande.';
        file = join(dir, candidates[0].n);
      }
      const rows = postStats(await readXlsx(file));
      if (rows.length === 0)
        return `${basename(file)} : aucun post reconnu (colonne « Post URL » absente).`;
      d.store.upsertStats(rows);
      const dates = rows
        .map((r) => r.date)
        .filter(Boolean)
        .sort();
      return `${rows.length} post(s) importés depuis ${basename(file)}${dates.length ? ` (du ${dates[0]} au ${dates.at(-1)})` : ''}.`;
    },
  });

  const insights = defineTool({
    name: 'linkedin_insights',
    description:
      "What works on Brightky's LinkedIn, from his imported stats: tops and flops versus his own recent " +
      'median, and hypotheses (format, hook, links, timing…). Call it before drafting a post, and after an ' +
      'import, to learn from flops.',
    input: {},
    classify: () => ({ level: N0, rule: 'linkedin.insights', reason: 'read-only, local' }),
    summarize: () => 'LinkedIn insights',
    run: async () => {
      const stats = d.store.stats().filter((s) => s.impressions !== null && s.date);
      if (stats.length < 4)
        return `Pas assez de données (${stats.length} post(s) avec impressions) : importe un export LinkedIn plus long (linkedin_stats_import).`;
      const posts = d.store.posts(1000);
      const byDay = new Map<string, typeof posts>();
      for (const p of posts) {
        const day = p.createdAt.slice(0, 10);
        byDay.set(day, [...(byDay.get(day) ?? []), p]);
      }
      const scored = score(
        stats.map((s) => {
          const same = byDay.get(s.date ?? '') ?? [];
          return {
            id: s.url,
            date: s.date ?? '',
            impressions: s.impressions ?? 0,
            engagements: s.engagements,
            // A stat matches a post Jarvis published when it is the only one that day.
            features: same.length === 1 ? (same[0]?.features ?? null) : null,
          };
        }),
      );
      const fmt = (p: (typeof scored)[number]) =>
        `- ${p.date} : ${p.impressions} impressions${p.ratio !== null ? ` (×${p.ratio.toFixed(1).replace('.', ',')} ta médiane récente)` : ''} — ${p.id}`;
      const tops = scored.filter((p) => p.label === 'top');
      const flops = scored.filter((p) => p.label === 'flop');
      const learned = lessons(scored);
      return [
        `${scored.length} posts analysés.`,
        `Au-dessus de ta médiane (×1,5 et plus) : ${tops.length}`,
        ...tops.slice(-5).map(fmt),
        `En dessous (×0,6 et moins) : ${flops.length}`,
        ...flops.slice(-5).map(fmt),
        learned.length
          ? 'Ce qui semble jouer :'
          : 'Pas encore assez de posts publiés par Jarvis pour comparer les formats.',
        ...learned,
      ].join('\n');
    },
  });

  return [status, card, screenshot, post, statsImport, insights] as unknown as ToolDef[];
}
