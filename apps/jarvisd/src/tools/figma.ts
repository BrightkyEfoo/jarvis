import {
  type Classification,
  defineTool,
  forbid,
  N0,
  N1,
  N2,
  Refusal,
  type RunContext,
  type ToolDef,
} from '@jarvis/policy';
import { z } from 'zod';
import { type FigmaBridge, FigmaError } from '../figma/bridge.ts';
import {
  BINDABLE_FIELDS,
  type BindableField,
  DRAFTS_PAGE,
  type FigmaOp,
  LIMITS,
  nodeId,
  type OpKind,
  type OpResult,
  RESULTS,
  type ReadNode,
  RootFrameSchema,
  specStats,
} from '../figma/catalogue.ts';
import { toDtcg } from '../figma/tokens.ts';

/**
 * Figma through the free local bridge (ADR-034): a dev plugin in Figma desktop runs a fixed
 * catalogue of operations. Reading is N0 and taints the session (designs are other people's
 * content). Writing in the "Jarvis drafts" page is N1; changing an existing layer elsewhere is N2,
 * with the exact before → after. A layer must have been read before Jarvis writes to it, and the
 * plugin refuses the write if it changed since (fingerprint) or is not where the level assumed.
 */

/** What Jarvis knows about a layer it read or created. Reset when the plugin session changes. */
interface Known {
  id: string;
  name: string;
  type: string;
  fp: string;
  page: { id: string; name: string };
  inDrafts: boolean;
  /** The read attributes, children excluded: the "before" of an approval. */
  raw: Record<string, unknown>;
}

const MAX_KNOWN = 3000;
const NOT_COMPONENTABLE = new Set([
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'PAGE',
  'DOCUMENT',
  'SECTION',
  'SLICE',
]);

/** Fixed wording for what the plugin reports: its free text may quote the file. */
const PLUGIN_MESSAGES: Record<string, string> = {
  version:
    'the Figma plugin is out of date: Brightky must reload it (Plugins › Development › Jarvis)',
  not_found: 'layer not found in the open Figma file (deleted, or another file is open)',
  unsupported: 'this layer type does not support that operation',
  font: 'a font used by this text is not available on this Mac',
  too_large: 'the export is too large: lower the scale or pick a smaller layer',
  no_selection: 'nothing is selected in Figma: ask Brightky to select the layers to read',
  page_limit:
    'Figma refused to add the "Jarvis drafts" page (the free Starter plan allows 3 pages per file): ask Brightky to free a page',
  variable: 'variable not found or not compatible with that property',
  error: 'Figma raised an error while applying the operation',
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips
const clean = (s: string, max = 200) => s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').slice(0, max);

/** Layer names and texts in one-line summaries. */
const q = (s: unknown, max = 80): string => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return `"${t.length > max ? `${t.slice(0, max)}…` : t}"`;
};

const WRITES = new Set(['create_frame', 'set_text', 'rename', 'bind_variable', 'create_component']);

function failure(e: unknown): never {
  if (!(e instanceof FigmaError)) throw e;
  if (!e.fromPlugin) throw new Error(e.message);
  switch (e.code) {
    case 'stale':
      throw new Refusal(
        'figma.stale',
        'the layer changed since Jarvis read it: read it again (figma_read_selection) before writing',
      );
    case 'not_draft':
      throw new Refusal(
        'figma.not_draft',
        `the layer is not in the "${DRAFTS_PAGE}" page: read it again before writing`,
      );
    case 'invalid':
      throw new Refusal(
        'figma.plugin_refused',
        `the Jarvis plugin refused the operation (outside its catalogue): ${clean(e.message)}`,
      );
    case 'variable':
      throw new Error(`${PLUGIN_MESSAGES.variable}: ${clean(e.message)}`);
    default:
      throw new Error(PLUGIN_MESSAGES[e.code] ?? PLUGIN_MESSAGES.error);
  }
}

/** Where each bindable field shows in a read node, for the "before" of an approval. */
function fieldBefore(raw: Record<string, unknown>, field: BindableField): string {
  const figmaKey = field === 'fill' ? 'fills' : field === 'stroke' ? 'strokes' : field;
  const bound = (raw.bound as Record<string, unknown> | undefined)?.[figmaKey];
  if (bound !== undefined) return `variable ${JSON.stringify(bound).slice(0, 80)}`;
  const layout = raw.layout as Record<string, unknown> | undefined;
  const text = raw.text as Record<string, unknown> | undefined;
  const padding = layout?.padding as number[] | undefined;
  const paint = (k: string) => (raw[k] as { hex?: string; type?: string }[] | undefined)?.[0];
  const v: unknown = (() => {
    switch (field) {
      case 'fill':
        return paint('fills')?.hex ?? paint('fills')?.type;
      case 'stroke':
        return paint('strokes')?.hex ?? paint('strokes')?.type;
      case 'itemSpacing':
        return layout?.gap;
      case 'counterAxisSpacing':
        return layout?.counterGap;
      case 'paddingTop':
        return padding?.[0];
      case 'paddingRight':
        return padding?.[1];
      case 'paddingBottom':
        return padding?.[2];
      case 'paddingLeft':
        return padding?.[3];
      case 'topLeftRadius':
      case 'topRightRadius':
      case 'bottomRightRadius':
      case 'bottomLeftRadius':
        return raw.radius;
      case 'opacity':
        return raw.opacity ?? 1;
      case 'visible':
        return raw.visible ?? true;
      case 'characters':
        return raw.characters;
      case 'fontFamily':
      case 'fontStyle':
        return text?.font;
      case 'fontSize':
        return text?.size;
      case 'fontWeight':
        return text?.weight;
      case 'lineHeight':
        return text?.lineHeight;
      case 'letterSpacing':
        return text?.letterSpacing;
      default:
        return raw[field];
    }
  })();
  return v === undefined ? 'not set' : JSON.stringify(v).slice(0, 80);
}

export interface FigmaToolDeps {
  bridge: Pick<FigmaBridge, 'perform' | 'session'>;
}

export function createFigmaTools(d: FigmaToolDeps): ToolDef[] {
  const known = new Map<string, Known>();
  let knownSession: string | null = null;
  // Node ids are per file: what was read through another plugin session means nothing now.
  const memory = () => {
    if (d.bridge.session !== knownSession) {
      known.clear();
      knownSession = d.bridge.session;
    }
    return known;
  };
  const remember = (k: Known) => {
    const m = memory();
    m.delete(k.id);
    m.set(k.id, k);
    if (m.size > MAX_KNOWN) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined) m.delete(oldest);
    }
  };

  const call = async <K extends OpKind>(
    kind: K,
    args: FigmaOp<K>['args'],
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<OpResult[K]> => {
    let raw: unknown;
    try {
      raw = await d.bridge.perform(kind, args, signal, timeoutMs);
    } catch (e) {
      // A write that timed out may still land in Figma afterwards: no blind retry.
      if (e instanceof FigmaError && e.code === 'timeout' && WRITES.has(kind))
        throw new Error(
          `${e.message}. It may still have been applied: read the "${DRAFTS_PAGE}" page (figma_read_selection) before retrying.`,
        );
      failure(e);
    }
    const parsed = (RESULTS[kind] as z.ZodType).safeParse(raw);
    if (!parsed.success) throw new Error(`unexpected answer from the Figma plugin (${kind})`);
    return parsed.data as OpResult[K];
  };

  const where = (k: Known) => `${k.id}, page ${q(k.page.name, 40)}`;

  /** N1 inside the drafts page, N2 elsewhere; unknown layers must be read first. */
  const writeLevel = (id: string): Classification | Known => {
    const k = memory().get(id);
    if (!k) {
      return forbid(
        'figma.unknown_node',
        `read layer ${id} first (figma_read_selection): Jarvis only writes to layers it has seen`,
      );
    }
    return k;
  };
  const levelOf = (op: string, k: Known): Classification =>
    k.inDrafts
      ? {
          level: N1,
          rule: `figma.${op}.draft`,
          reason: `changes a layer of the "${DRAFTS_PAGE}" page`,
        }
      : {
          level: N2,
          rule: `figma.${op}.existing`,
          reason: `changes an existing layer of the file (page ${q(k.page.name, 40)})`,
        };

  /** Sends a write with the fingerprint read earlier; the level decides the scope the plugin enforces. */
  const write = async <K extends 'set_text' | 'rename' | 'bind_variable' | 'create_component'>(
    kind: K,
    id: string,
    args: Omit<FigmaOp<K>['args'], 'expect' | 'scope' | 'node_id'>,
    ctx: RunContext,
  ): Promise<{ before: Known; after: OpResult[K] }> => {
    const k = memory().get(id);
    if (!k)
      throw new Refusal('figma.unknown_node', `read layer ${id} first (figma_read_selection)`);
    const scope = ctx.classification.level <= N1 ? 'draft' : 'existing';
    const after = await call(
      kind,
      { ...args, node_id: id, expect: { fp: k.fp }, scope } as FigmaOp<K>['args'],
      ctx.signal,
    );
    return { before: { ...k }, after };
  };

  const status = defineTool({
    name: 'figma_status',
    description:
      'Figma desktop through the free local Jarvis plugin (no quota): whether it is connected, the ' +
      'open file, current page, selected layers (ids, names, types) and whether the "Jarvis drafts" ' +
      'page exists. Fails with instructions for Brightky when the plugin is not running.',
    input: {},
    classify: () => ({ level: N0, rule: 'figma.status', reason: 'read-only' }),
    summarize: () => 'Figma: status',
    ingestsExternal: true,
    run: async (_a, ctx) => {
      const r = await call('status', {}, ctx.signal);
      const sel = r.nodes.map((n) => `- ${n.id} ${n.type} ${q(n.name)}`).join('\n');
      return [
        `File ${q(r.file)} (${r.editor}) — page ${q(r.page.name)}${r.page.drafts ? ` (the ${DRAFTS_PAGE} page)` : ''}.`,
        `Selection: ${r.selection} layer(s)${r.selection > r.nodes.length ? `, first ${r.nodes.length}` : ''}.`,
        sel,
        r.drafts ? `"${DRAFTS_PAGE}" page: ${r.drafts.id}.` : `No "${DRAFTS_PAGE}" page yet.`,
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  const read = defineTool({
    name: 'figma_read_selection',
    description:
      'Read the layers selected in Figma (or node_id) as a JSON tree: id, name, type, size, auto ' +
      'layout (padding [top,right,bottom,left], gap, alignment, sizing), text and typography, fills ' +
      'and strokes as hex, effects, radius, bound variables, styles, component properties. Bounded ' +
      `(depth default 6 max ${LIMITS.readDepth}, max_nodes default 300 max ${LIMITS.readNodes}). ` +
      'Read a layer before changing it.',
    input: {
      node_id: nodeId.optional(),
      depth: z.number().int().min(1).max(LIMITS.readDepth).optional(),
      max_nodes: z.number().int().min(1).max(LIMITS.readNodes).optional(),
    },
    classify: () => ({ level: N0, rule: 'figma.read', reason: 'reads the design' }),
    summarize: (a) => `Figma: read ${a.node_id ? `layer ${a.node_id}` : 'the selection'}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const r = await call(
        'read',
        {
          ...(a.node_id && { node_id: a.node_id }),
          depth: a.depth ?? 6,
          max_nodes: a.max_nodes ?? 300,
        },
        ctx.signal,
        30_000,
      );
      const walk = (n: ReadNode) => {
        const { children, ...raw } = n;
        remember({
          id: n.id,
          name: n.name,
          type: n.type,
          fp: n.fp,
          page: r.page,
          inDrafts: r.inDrafts,
          raw,
        });
        for (const c of children ?? []) walk(c);
      };
      for (const n of r.nodes) walk(n);
      const json = JSON.stringify(r.nodes, (k, v) => (k === 'fp' ? undefined : v));
      const notes = [
        r.inDrafts ? `the ${DRAFTS_PAGE} page: changes here need no confirmation` : '',
        r.truncated ? 'truncated: read a child node_id or lower the depth' : '',
        json.length > 90_000 ? 'large: read a child node_id for details' : '',
      ].filter(Boolean);
      return `Page ${q(r.page.name)} — ${r.count} layer(s)${notes.length ? ` (${notes.join('; ')})` : ''}.\n${json}`;
    },
  });

  const variables = defineTool({
    name: 'figma_variables',
    description:
      "The file's local variables as W3C design tokens JSON (DTCG 2025.10): one group per " +
      'collection, "/" in names becomes nesting, aliases as {group.token}, colours as sRGB with hex, ' +
      'sizes as px dimensions, other modes and code syntax under $extensions["com.figma"]. ' +
      'STRING / BOOLEAN variables use the non-standard types "string" / "boolean". ' +
      'collection: only that collection (by name).',
    input: { collection: z.string().min(1).max(LIMITS.name).optional() },
    classify: () => ({ level: N0, rule: 'figma.variables', reason: 'reads the design tokens' }),
    summarize: (a) => `Figma: variables${a.collection ? ` of ${q(a.collection)}` : ''}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const raw = await call('variables', {}, ctx.signal, 30_000);
      const list = raw.collections
        .map((c) => `${q(c.name)} (${raw.variables.filter((v) => v.collectionId === c.id).length})`)
        .join(', ');
      const { tokens, count, collections } = toDtcg(raw, a.collection);
      if (count === 0) {
        return `No local variable${a.collection ? ` in collection ${q(a.collection)}` : ''}. Collections: ${list || 'none'}.`;
      }
      const json = JSON.stringify(tokens, null, 2);
      if (json.length > 90_000 && !a.collection) {
        return `${count} variables, too many for one answer: ask again with collection. Collections: ${list}.`;
      }
      return `W3C design tokens (DTCG 2025.10): ${count} variable(s) in ${collections} collection(s).\n${json}`;
    },
  });

  const exportPng = defineTool({
    name: 'figma_export',
    description:
      'Export a layer (node_id, default: the first selected) as a PNG image to look at it, like ' +
      `screen_look. scale ${LIMITS.exportMinScale}–${LIMITS.exportMaxScale} (default 2); the image ` +
      `is capped at ${LIMITS.exportMaxSide} px on its longest side.`,
    input: {
      node_id: nodeId.optional(),
      scale: z.number().min(LIMITS.exportMinScale).max(LIMITS.exportMaxScale).optional(),
    },
    classify: () => ({ level: N0, rule: 'figma.export', reason: 'renders a layer' }),
    summarize: (a) => `Figma: export ${a.node_id ? `layer ${a.node_id}` : 'the selection'} as PNG`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const r = await call(
        'export_png',
        { ...(a.node_id && { node_id: a.node_id }), scale: a.scale ?? 2 },
        ctx.signal,
        45_000,
      );
      return {
        text: `PNG of ${r.type} ${q(r.name)} (${r.id}) — ${r.width}×${r.height} px at scale ${r.scale}.`,
        images: [{ data: r.png, mimeType: 'image/png' as const }],
      };
    },
  });

  const createFrame = defineTool({
    name: 'figma_create_frame',
    description:
      `Create an auto-layout frame in the "${DRAFTS_PAGE}" page (created if missing; never elsewhere) ` +
      'from a small JSON spec. Nodes: {type:"frame", name, direction:"vertical"|"horizontal", ' +
      'padding: n | {top,right,bottom,left}, gap, align:"start"|"center"|"end"|"space_between", ' +
      'cross_align, width, height, fill:"#RRGGBB[AA]", radius, fill_width, children:[…]}, ' +
      '{type:"text", text, size, font (default Inter), style ("Regular", "Bold"…), color, align, ' +
      `fill_width}, {type:"rectangle", width, height, fill, radius, fill_width}. At most ` +
      `${LIMITS.specNodes} layers, ${LIMITS.specDepth} levels. Returns the new layer ids.`,
    input: { spec: RootFrameSchema },
    classify: (a) => ({
      level: N1,
      rule: 'figma.create_frame.draft',
      reason: `creates ${specStats(a.spec).nodes} layer(s) in the "${DRAFTS_PAGE}" page`,
    }),
    summarize: (a) =>
      `Figma: create frame ${q(a.spec.name ?? 'Frame')} (${specStats(a.spec).nodes} layers) in page "${DRAFTS_PAGE}"`,
    run: async (a, ctx) => {
      const r = await call('create_frame', { spec: a.spec }, ctx.signal, 30_000);
      for (const n of r.nodes) {
        remember({ ...n, page: r.page, inDrafts: true, raw: { name: n.name, type: n.type } });
      }
      const lines = r.nodes.slice(0, 60).map((n) => `- ${n.id} ${n.type} ${q(n.name, 40)}`);
      return [
        `Created in page "${DRAFTS_PAGE}" (${r.page.id}): root ${r.root}, ${r.nodes.length} layer(s).`,
        ...lines,
        r.nodes.length > 60 ? `… ${r.nodes.length - 60} more` : '',
        r.fontFallbacks
          ? `${r.fontFallbacks} text layer(s) use Inter: the requested font is not on this Mac.`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  const setText = defineTool({
    name: 'figma_set_text',
    description:
      'Replace the text of a TEXT layer (read it first). In the "Jarvis drafts" page: no ' +
      'confirmation; elsewhere Brightky confirms the exact before → after.',
    input: { node_id: nodeId, text: z.string().max(LIMITS.setText) },
    classify: (a) => {
      const k = writeLevel(a.node_id);
      if ('level' in k) return k;
      if (k.type !== 'TEXT')
        return forbid('figma.not_text', `layer ${a.node_id} is a ${k.type}, not a TEXT layer`);
      return levelOf('set_text', k);
    },
    summarize: (a) => {
      const k = memory().get(a.node_id);
      return k
        ? `Figma: set text of ${q(k.name, 40)} (${where(k)}): ${q(k.raw.characters, 160)} → ${q(a.text, 400)}`
        : `Figma: set text of ${a.node_id} → ${q(a.text, 400)}`;
    },
    run: async (a, ctx) => {
      const { before, after } = await write('set_text', a.node_id, { text: a.text }, ctx);
      remember({
        ...before,
        fp: after.fp,
        name: after.name,
        raw: { ...before.raw, characters: a.text.slice(0, LIMITS.textChars) },
      });
      return `Text of ${a.node_id} replaced (${a.text.length} characters).`;
    },
  });

  const rename = defineTool({
    name: 'figma_rename',
    description:
      'Rename a layer (read it first). In the "Jarvis drafts" page: no confirmation; elsewhere ' +
      'Brightky confirms the exact old → new name.',
    input: { node_id: nodeId, name: z.string().min(1).max(LIMITS.name) },
    classify: (a) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: layer names stay on one line
      if (/[\u0000-\u001f\u007f]/.test(a.name))
        return forbid('input.invalid', 'no control characters');
      const k = writeLevel(a.node_id);
      return 'level' in k ? k : levelOf('rename', k);
    },
    summarize: (a) => {
      const k = memory().get(a.node_id);
      return k
        ? `Figma: rename ${k.type} ${q(k.name)} (${where(k)}) → ${q(a.name)}`
        : `Figma: rename ${a.node_id} → ${q(a.name)}`;
    },
    run: async (a, ctx) => {
      const { before, after } = await write('rename', a.node_id, { name: a.name }, ctx);
      remember({
        ...before,
        fp: after.fp,
        name: after.name,
        raw: { ...before.raw, name: after.name },
      });
      return `Layer ${a.node_id} renamed ${q(a.name)}.`;
    },
  });

  const bindVariable = defineTool({
    name: 'figma_bind_variable',
    description:
      'Bind a local variable (by name as in figma_variables, e.g. "color/primary/500"; collection ' +
      'when the name exists in several) to a property of a layer read before: fill / stroke colour ' +
      '(paint_index, default 0), width, height, padding*, itemSpacing, radii, strokeWeight, opacity, ' +
      'visible, characters, font*. Drafts page: no confirmation; elsewhere Brightky confirms.',
    input: {
      node_id: nodeId,
      field: z.enum(BINDABLE_FIELDS),
      variable: z.string().min(1).max(LIMITS.variableName),
      collection: z.string().min(1).max(LIMITS.name).optional(),
      paint_index: z.number().int().min(0).max(20).optional(),
    },
    classify: (a) => {
      const k = writeLevel(a.node_id);
      return 'level' in k ? k : levelOf('bind_variable', k);
    },
    summarize: (a) => {
      const k = memory().get(a.node_id);
      const v = `variable ${q(a.variable)}${a.collection ? ` (collection ${q(a.collection)})` : ''}`;
      return k
        ? `Figma: bind ${a.field} of ${k.type} ${q(k.name, 40)} (${where(k)}) to ${v} (was ${fieldBefore(k.raw, a.field)})`
        : `Figma: bind ${a.field} of ${a.node_id} to ${v}`;
    },
    run: async (a, ctx) => {
      const { before, after } = await write(
        'bind_variable',
        a.node_id,
        {
          field: a.field,
          variable: a.variable,
          ...(a.collection && { collection: a.collection }),
          ...(a.paint_index !== undefined && { paint_index: a.paint_index }),
        },
        ctx,
      );
      remember({ ...before, fp: after.fp, name: after.name });
      return `${a.field} of ${a.node_id} bound to ${q(a.variable)}.`;
    },
  });

  const createComponent = defineTool({
    name: 'figma_create_component',
    description:
      'Turn a layer read before (a frame or group, typically the selection) into a main component, ' +
      'optionally renamed. Drafts page: no confirmation; elsewhere Brightky confirms.',
    input: { node_id: nodeId, name: z.string().min(1).max(LIMITS.name).optional() },
    classify: (a) => {
      const k = writeLevel(a.node_id);
      if ('level' in k) return k;
      if (NOT_COMPONENTABLE.has(k.type) || a.node_id.startsWith('I'))
        return forbid('figma.unsupported', `a ${k.type} layer cannot become a component`);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: layer names stay on one line
      if (a.name && /[\u0000-\u001f\u007f]/.test(a.name))
        return forbid('input.invalid', 'no control characters');
      return levelOf('create_component', k);
    },
    summarize: (a) => {
      const k = memory().get(a.node_id);
      const named = a.name ? ` named ${q(a.name)}` : '';
      return k
        ? `Figma: turn ${k.type} ${q(k.name)} (${where(k)}) into a component${named}`
        : `Figma: turn ${a.node_id} into a component${named}`;
    },
    run: async (a, ctx) => {
      const { before, after } = await write(
        'create_component',
        a.node_id,
        { ...(a.name && { name: a.name }) },
        ctx,
      );
      memory().delete(a.node_id);
      remember({
        ...before,
        id: after.id,
        name: after.name,
        type: after.type,
        fp: after.fp,
        raw: { ...before.raw, name: after.name, type: after.type },
      });
      return `Component ${q(after.name)} created: ${after.id} (was ${a.node_id}).`;
    },
  });

  return [
    status,
    read,
    variables,
    exportPng,
    createFrame,
    setText,
    rename,
    bindVariable,
    createComponent,
  ] as unknown as ToolDef[];
}
