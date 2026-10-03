import type { OpResult, VariableValue } from './catalogue.ts';

/**
 * Figma local variables → W3C Design Tokens (DTCG format 2025.10). One top-level group per
 * collection, `/` in variable names becomes nesting, the default mode is `$value` and the other
 * modes go to `$extensions["com.figma"].modes`. Aliases become `{group.token}` references.
 */

type Raw = OpResult['variables'];
type RawVariable = Raw['variables'][number];
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Group = { [k: string]: Json };

const DIMENSION_SCOPES = new Set([
  'CORNER_RADIUS',
  'WIDTH_HEIGHT',
  'GAP',
  'STROKE_FLOAT',
  'EFFECT_FLOAT',
  'FONT_SIZE',
  'LINE_HEIGHT',
  'LETTER_SPACING',
  'PARAGRAPH_SPACING',
  'PARAGRAPH_INDENT',
]);

/** DTCG names may not contain `.`, `{` or `}` nor start with `$`. */
export function tokenSegment(s: string): string {
  const clean = s
    .trim()
    .replace(/[{}]/g, '')
    .replace(/\./g, '_')
    .replace(/^\$+/, '')
    .replace(/\s+/g, ' ');
  return clean || '_';
}

const pathOf = (collection: string, name: string): string[] => [
  tokenSegment(collection),
  ...name.split('/').map(tokenSegment),
];

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const hex2 = (n: number) =>
  Math.round(Math.min(1, Math.max(0, n)) * 255)
    .toString(16)
    .padStart(2, '0');

function dtcgType(v: RawVariable): string {
  switch (v.type) {
    case 'COLOR':
      return 'color';
    case 'BOOLEAN':
      return 'boolean';
    case 'STRING':
      return v.scopes.length > 0 && v.scopes.every((s) => s === 'FONT_FAMILY')
        ? 'fontFamily'
        : 'string';
    case 'FLOAT':
      if (v.scopes.length > 0 && v.scopes.every((s) => s === 'FONT_WEIGHT')) return 'fontWeight';
      if (v.scopes.length > 0 && v.scopes.every((s) => DIMENSION_SCOPES.has(s))) return 'dimension';
      return 'number';
  }
}

export interface DtcgResult {
  tokens: Group;
  count: number;
  collections: number;
}

export function toDtcg(raw: Raw, onlyCollection?: string): DtcgResult {
  const collections = new Map(raw.collections.map((c) => [c.id, c]));
  const locals = new Map(raw.variables.map((v) => [v.id, v]));
  const remote = new Map(raw.remote.map((r) => [r.id, r]));
  const wanted = onlyCollection?.trim().toLowerCase();

  const reference = (id: string): string => {
    const local = locals.get(id);
    const c = local ? collections.get(local.collectionId) : undefined;
    if (local && c) return `{${pathOf(c.name, local.name).join('.')}}`;
    const r = remote.get(id);
    if (r) return `{${pathOf(r.collection, r.name).join('.')}}`;
    return `{_unresolved.${tokenSegment(id.replace(/[^A-Za-z0-9:_-]/g, ''))}}`;
  };

  const value = (type: string, x: VariableValue): Json => {
    if (typeof x === 'object' && 'alias' in x) return reference(x.alias);
    if (typeof x === 'object') {
      const hex = `#${hex2(x.r)}${hex2(x.g)}${hex2(x.b)}`;
      return {
        colorSpace: 'srgb',
        components: [round(x.r, 4), round(x.g, 4), round(x.b, 4)],
        ...(x.a < 1 && { alpha: round(x.a, 4) }),
        hex,
      };
    }
    if (typeof x === 'number') {
      if (type === 'dimension') return { value: round(x, 3), unit: 'px' };
      return round(x, 4);
    }
    return x;
  };

  const tokens: Group = {};
  let count = 0;
  const used = new Set<string>();
  for (const v of raw.variables) {
    const c = collections.get(v.collectionId);
    if (!c) continue;
    if (wanted && c.name.trim().toLowerCase() !== wanted) continue;
    const type = dtcgType(v);
    const first = v.values[c.defaultModeId] ?? Object.values(v.values)[0];
    if (first === undefined) continue;
    const token: Group = { $type: type, $value: value(type, first) };
    if (v.description?.trim()) token.$description = v.description.trim();
    const figmaExt: Group = {};
    if (c.modes.length > 1) {
      const modes: Group = {};
      for (const m of c.modes) {
        const x = v.values[m.modeId];
        if (x !== undefined) modes[m.name] = value(type, x);
      }
      figmaExt.modes = modes;
    }
    if (v.codeSyntax && Object.keys(v.codeSyntax).length) figmaExt.codeSyntax = v.codeSyntax;
    if (Object.keys(figmaExt).length) token.$extensions = { 'com.figma': figmaExt };

    const path = pathOf(c.name, v.name);
    let group = tokens;
    for (const seg of path.slice(0, -1)) {
      const next = group[seg];
      if (next && typeof next === 'object' && !Array.isArray(next) && !('$value' in next)) {
        group = next;
      } else {
        // A token already sits where a group is needed: it moves to the group's $root.
        const g: Group =
          next && typeof next === 'object' && !Array.isArray(next) ? { $root: next } : {};
        group[seg] = g;
        group = g;
      }
    }
    const leaf = path[path.length - 1] ?? '_';
    const existing = group[leaf];
    const key = `${path.join('.')}`;
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      !('$value' in existing)
    ) {
      existing.$root = token;
    } else if (used.has(key)) {
      group[`${leaf}_${v.id.replace(/[^A-Za-z0-9]/g, '')}`] = token;
    } else {
      group[leaf] = token;
    }
    used.add(key);
    count++;
  }

  const shown = raw.collections.filter((c) => !wanted || c.name.trim().toLowerCase() === wanted);
  for (const c of shown) {
    const g = tokens[tokenSegment(c.name)];
    if (c.modes.length > 1 && g && typeof g === 'object' && !Array.isArray(g)) {
      const def = c.modes.find((m) => m.modeId === c.defaultModeId)?.name ?? null;
      g.$extensions = {
        'com.figma': { modes: c.modes.map((m) => m.name), defaultMode: def },
      };
    }
  }
  return { tokens, count, collections: shown.length };
}
