/**
 * What makes Brightky's posts work, from his own numbers. Each post is compared with the median of
 * the ten before it (audiences grow; absolute numbers mislead), then features are compared between
 * posts that have them and posts that do not. Results are hypotheses to test, never rules.
 */
export interface PostFeatures {
  chars: number;
  lines: number;
  hookChars: number;
  hookQuestion: boolean;
  images: number;
  document: boolean;
  link: boolean;
  hashtags: number;
  code: boolean;
  weekday: number;
  hour: number;
}

export function features(
  text: string,
  at: Date,
  media: { images: number; document: boolean },
): PostFeatures {
  const lines = text.split('\n');
  const hook = lines.find((l) => l.trim()) ?? '';
  return {
    chars: text.length,
    lines: lines.length,
    hookChars: hook.length,
    hookQuestion: hook.trim().endsWith('?'),
    images: media.images,
    document: media.document,
    link: /https?:\/\//.test(text),
    hashtags: (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length,
    code: /```|`[^`]+`|=>|\bfunction\b|\bconst\b|<\/?\w+>/.test(text),
    weekday: at.getDay(),
    hour: at.getHours(),
  };
}

export interface ScoredPost {
  id: string;
  date: string;
  impressions: number;
  engagements: number | null;
  features: PostFeatures | null;
  /** Impressions relative to the median of the 10 previous posts (1 = usual). */
  ratio: number | null;
  label: 'top' | 'flop' | 'normal' | 'new';
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

export function score(
  posts: {
    id: string;
    date: string;
    impressions: number;
    engagements: number | null;
    features: PostFeatures | null;
  }[],
): ScoredPost[] {
  const sorted = [...posts].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((p, i) => {
    const before = sorted.slice(Math.max(0, i - 10), i).map((x) => x.impressions);
    if (before.length < 3) return { ...p, ratio: null, label: 'new' as const };
    const base = median(before);
    const ratio = base > 0 ? p.impressions / base : null;
    const label =
      ratio === null ? 'normal' : ratio >= 1.5 ? 'top' : ratio <= 0.6 ? 'flop' : 'normal';
    return { ...p, ratio, label };
  });
}

const TESTS: [string, (f: PostFeatures) => boolean][] = [
  ['un document PDF (carrousel)', (f) => f.document],
  ['au moins une image', (f) => f.images > 0],
  ['un lien dans le texte', (f) => f.link],
  ['une accroche en question', (f) => f.hookQuestion],
  ['une accroche courte (≤ 80 caractères)', (f) => f.hookChars <= 80],
  ['du code', (f) => f.code],
  ['3 hashtags ou plus', (f) => f.hashtags >= 3],
  ['un texte long (> 1 300 caractères)', (f) => f.chars > 1300],
  ['une publication le matin (avant 12 h)', (f) => f.hour < 12],
  ['une publication le week-end', (f) => f.weekday === 0 || f.weekday === 6],
];

/** "With X: ×1.8 (4 posts) vs ×0.9 without (9)". Needs 3 posts on each side. */
export function lessons(scored: ScoredPost[]): string[] {
  const usable = scored.filter((p) => p.ratio !== null && p.features);
  const out: { gap: number; line: string }[] = [];
  for (const [name, test] of TESTS) {
    const yes = usable
      .filter((p) => test(p.features as PostFeatures))
      .map((p) => p.ratio as number);
    const no = usable
      .filter((p) => !test(p.features as PostFeatures))
      .map((p) => p.ratio as number);
    if (yes.length < 3 || no.length < 3) continue;
    const a = median(yes);
    const b = median(no);
    const gap = a / (b || 1);
    if (gap > 0.8 && gap < 1.25) continue;
    const fmt = (x: number) => `×${x.toFixed(1).replace('.', ',')}`;
    out.push({
      gap,
      line: `${gap > 1 ? '↑' : '↓'} Avec ${name} : ${fmt(a)} (${yes.length} posts) contre ${fmt(b)} sans (${no.length}). Hypothèse à confirmer.`,
    });
  }
  return out
    .sort((x, y) => Math.abs(Math.log(y.gap)) - Math.abs(Math.log(x.gap)))
    .map((x) => x.line);
}
