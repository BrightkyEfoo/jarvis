import { execFile } from 'node:child_process';

/**
 * Minimal XLSX reader for LinkedIn's creator-analytics export: /usr/bin/unzip and a few regexes,
 * no dependency. Returns every sheet as rows of cell strings.
 */
function unzip(file: string, member: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/unzip',
      ['-p', file, member],
      { maxBuffer: 50_000_000, timeout: 20_000 },
      (err, out) => resolve(err ? '' : out),
    );
  });
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const column = (ref: string) =>
  [...(ref.match(/^[A-Z]+/)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of (row[1] ?? '').matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 'inlineStr')
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('');
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        value = type === 's' ? (shared[Number(v)] ?? '') : v;
      }
      cells[ref ? column(ref) : cells.length] = decode(value).trim();
    }
    rows.push(Array.from(cells, (x) => x ?? ''));
  }
  return rows;
}

export function parseShared(xml: string): string[] {
  // `<si/>` (an empty string) still takes an index.
  return [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((si) =>
    [...(si[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1] ?? '')).join(''),
  );
}

/** One attribute of an XML tag, whatever the attribute order. */
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

export async function readXlsx(file: string): Promise<{ name: string; rows: string[][] }[]> {
  const [workbook, rels, sharedXml] = await Promise.all([
    unzip(file, 'xl/workbook.xml'),
    unzip(file, 'xl/_rels/workbook.xml.rels'),
    unzip(file, 'xl/sharedStrings.xml'),
  ]);
  if (!workbook) throw new Error("ce fichier n'est pas un classeur XLSX lisible");
  const shared = parseShared(sharedXml);
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      attr(m[0], 'Id'),
      attr(m[0], 'Target'),
    ]),
  );
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => [
    m[0],
    attr(m[0], 'name'),
    attr(m[0], 'r:id'),
  ]);
  const out: { name: string; rows: string[][] }[] = [];
  for (const [, name, rid] of sheets) {
    const target = targets.get(rid ?? '') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    out.push({ name: decode(name ?? ''), rows: parseSheet(await unzip(file, path), shared) });
  }
  return out;
}

export interface PostStats {
  url: string;
  /** YYYY-MM-DD */
  date: string | null;
  impressions: number | null;
  engagements: number | null;
}

const num = (s: string | undefined) => {
  const n = Number((s ?? '').replace(/[\s ,]/g, ''));
  return Number.isFinite(n) && (s ?? '').trim() !== '' ? n : null;
};

const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * Excel serial day, "10/1/2026", "25/10/2026", "2026-10-01" → YYYY-MM-DD. Slash dates are
 * month/day (LinkedIn's English export) unless `dayFirst` (the file has a first number above 12).
 */
export function isoDay(s: string | undefined, dayFirst = false): string | null {
  const v = (s ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (/^\d{5}(\.\d+)?$/.test(v))
    return new Date(Date.UTC(1899, 11, 30) + Number(v) * 86_400_000).toISOString().slice(0, 10);
  const m = SLASH_DATE.exec(v);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const [month, day] = dayFirst || a > 12 ? [b, a] : [a, b];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Finds every table with a "Post URL" column (the TOP POSTS sheet holds two side by side) and
 * merges their metrics per post.
 */
export function postStats(sheets: { name: string; rows: string[][] }[]): PostStats[] {
  // One file uses one date format: day first as soon as any first number exceeds 12.
  const dayFirst = sheets.some((sh) =>
    sh.rows.some((r) => r.some((c) => Number(SLASH_DATE.exec(c.trim())?.[1] ?? 0) > 12)),
  );
  const byUrl = new Map<string, PostStats>();
  for (const sheet of sheets) {
    sheet.rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (!/^post url$/i.test(cell)) return;
        const header = row.slice(c, c + 4).map((h) => h.toLowerCase());
        const dateCol = header.findIndex((h) => h.includes('date'));
        const imprCol = header.findIndex((h) => h.includes('impression'));
        const engCol = header.findIndex((h) => h.includes('engagement'));
        for (const data of sheet.rows.slice(r + 1)) {
          const url = data[c] ?? '';
          if (!/^https:\/\/(www\.)?linkedin\.com\//.test(url)) continue;
          const s = byUrl.get(url) ?? { url, date: null, impressions: null, engagements: null };
          if (dateCol >= 0) s.date ??= isoDay(data[c + dateCol], dayFirst);
          if (imprCol >= 0) s.impressions ??= num(data[c + imprCol]);
          if (engCol >= 0) s.engagements ??= num(data[c + engCol]);
          byUrl.set(url, s);
        }
      });
    });
  }
  return [...byUrl.values()];
}
