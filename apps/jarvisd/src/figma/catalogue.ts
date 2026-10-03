import { z } from 'zod';

/**
 * The FIXED catalogue of operations the Figma plugin runs (ADR-034). Nothing else crosses the
 * bridge: no script source, no Plugin API call by name. `apps/figma-plugin/code.js` holds a
 * plain-JS mirror of these rules and refuses anything outside them; tests check both agree.
 */
export const CATALOGUE_VERSION = 1;

/** Fixed: the plugin manifest lists it in networkAccess.devAllowedDomains. */
export const FIGMA_PORT = 47830;

/** The page the plugin creates for Jarvis. Writing there is N1; anywhere else N2. */
export const DRAFTS_PAGE = 'Jarvis drafts';

export const LIMITS = {
  readDepth: 8,
  readNodes: 600,
  /** Characters kept per text node, and across one read. */
  textChars: 2000,
  textBudget: 20_000,
  exportMaxSide: 2048,
  exportMinScale: 0.25,
  exportMaxScale: 4,
  /** Raw PNG bytes (base64 stays under the 5 MB image limit of the model). */
  exportMaxBytes: 3_500_000,
  specDepth: 6,
  specNodes: 120,
  specChildren: 50,
  specText: 2000,
  size: 10_000,
  spacing: 1000,
  fontSize: 400,
  name: 100,
  setText: 10_000,
  variableName: 200,
  variables: 2000,
  collections: 100,
} as const;

export const OP_KINDS = [
  'status',
  'read',
  'variables',
  'export_png',
  'create_frame',
  'set_text',
  'rename',
  'bind_variable',
  'create_component',
] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** Figma node ids: `12:34`, or `I12:34;56:78` inside an instance. */
export const NODE_ID = /^I?\d{1,9}:\d{1,9}(;\d{1,9}:\d{1,9}){0,20}$/;
export const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
/** Font family / style names (plain ASCII: the plugin mirrors it without Unicode classes). */
export const FONT_WORD = /^[A-Za-z0-9 ._-]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
const CONTROL = /[\u0000-\u001f\u007f]/;

export const nodeId = z.string().regex(NODE_ID, 'a Figma node id like 12:34');
const hex = z.string().regex(HEX, '#RRGGBB or #RRGGBBAA');
const layerName = z
  .string()
  .min(1)
  .max(LIMITS.name)
  .refine((s) => !CONTROL.test(s), 'no control characters');
const size = z.number().min(1).max(LIMITS.size);
const spacing = z.number().min(0).max(LIMITS.spacing);

/** Node properties a variable can be bound to (paints: fill / stroke colour). */
export const BINDABLE_FIELDS = [
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'topLeftRadius',
  'topRightRadius',
  'bottomLeftRadius',
  'bottomRightRadius',
  'strokeWeight',
  'opacity',
  'visible',
  'characters',
  'fontFamily',
  'fontStyle',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'paragraphSpacing',
  'fill',
  'stroke',
] as const;
export type BindableField = (typeof BINDABLE_FIELDS)[number];

// ── create_frame: a small layout spec, never code ──

export interface FrameSpec {
  type: 'frame';
  name?: string | undefined;
  direction?: 'horizontal' | 'vertical' | undefined;
  padding?:
    | number
    | {
        top?: number | undefined;
        right?: number | undefined;
        bottom?: number | undefined;
        left?: number | undefined;
      }
    | undefined;
  gap?: number | undefined;
  align?: 'start' | 'center' | 'end' | 'space_between' | undefined;
  cross_align?: 'start' | 'center' | 'end' | undefined;
  width?: number | undefined;
  height?: number | undefined;
  fill?: string | undefined;
  radius?: number | undefined;
  fill_width?: boolean | undefined;
  children?: NodeSpec[] | undefined;
}
export interface TextSpec {
  type: 'text';
  name?: string | undefined;
  text: string;
  size?: number | undefined;
  font?: string | undefined;
  style?: string | undefined;
  color?: string | undefined;
  align?: 'left' | 'center' | 'right' | undefined;
  fill_width?: boolean | undefined;
}
export interface RectangleSpec {
  type: 'rectangle';
  name?: string | undefined;
  width: number;
  height: number;
  fill?: string | undefined;
  radius?: number | undefined;
  fill_width?: boolean | undefined;
}
export type NodeSpec = FrameSpec | TextSpec | RectangleSpec;

const fontWord = z.string().min(1).max(60).regex(FONT_WORD, 'letters, digits, spaces');

const FrameShape = z
  .object({
    type: z.literal('frame'),
    name: layerName.optional(),
    direction: z.enum(['horizontal', 'vertical']).optional(),
    padding: z
      .union([
        spacing,
        z
          .object({
            top: spacing.optional(),
            right: spacing.optional(),
            bottom: spacing.optional(),
            left: spacing.optional(),
          })
          .strict(),
      ])
      .optional(),
    gap: spacing.optional(),
    align: z.enum(['start', 'center', 'end', 'space_between']).optional(),
    cross_align: z.enum(['start', 'center', 'end']).optional(),
    width: size.optional(),
    height: size.optional(),
    fill: hex.optional(),
    radius: spacing.optional(),
    fill_width: z.boolean().optional(),
    get children(): z.ZodOptional<z.ZodArray<z.ZodType<NodeSpec>>> {
      return z.array(NodeSpecSchema).max(LIMITS.specChildren).optional();
    },
  })
  .strict();

const TextShape = z
  .object({
    type: z.literal('text'),
    name: layerName.optional(),
    text: z.string().min(1).max(LIMITS.specText),
    size: z.number().min(1).max(LIMITS.fontSize).optional(),
    font: fontWord.optional(),
    style: fontWord.optional(),
    color: hex.optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    fill_width: z.boolean().optional(),
  })
  .strict();

const RectangleShape = z
  .object({
    type: z.literal('rectangle'),
    name: layerName.optional(),
    width: size,
    height: size,
    fill: hex.optional(),
    radius: spacing.optional(),
    fill_width: z.boolean().optional(),
  })
  .strict();

export const NodeSpecSchema: z.ZodType<NodeSpec> = z.lazy(() =>
  z.discriminatedUnion('type', [FrameShape, TextShape, RectangleShape]),
);

/** Depth and node count of a spec tree (the root counts as depth 1). */
export function specStats(spec: NodeSpec): { depth: number; nodes: number } {
  let nodes = 0;
  const walk = (n: NodeSpec, d: number): number => {
    nodes++;
    if (n.type !== 'frame' || !n.children?.length) return d;
    return Math.max(...n.children.map((c) => walk(c, d + 1)));
  };
  const depth = walk(spec, 1);
  return { depth, nodes };
}

/** The root of create_frame is always an auto-layout frame. */
export const RootFrameSchema = FrameShape.superRefine((spec, ctx) => {
  const { depth, nodes } = specStats(spec as FrameSpec);
  if (depth > LIMITS.specDepth)
    ctx.addIssue({ code: 'custom', message: `spec deeper than ${LIMITS.specDepth} levels` });
  if (nodes > LIMITS.specNodes)
    ctx.addIssue({ code: 'custom', message: `spec has more than ${LIMITS.specNodes} layers` });
}) as unknown as z.ZodType<FrameSpec>;

// ── Operation arguments, as sent to the plugin ──

/** What Jarvis read: the plugin refuses the write if the node changed since (fingerprint). */
const Expect = z.object({ fp: z.string().regex(/^[0-9a-f]{8}$/) }).strict();
/** draft: the node must be in the Jarvis drafts page (N1). existing: anywhere (N2, approved). */
const Scope = z.enum(['draft', 'existing']);

export const OP_ARGS = {
  status: z.object({}).strict(),
  read: z
    .object({
      node_id: nodeId.optional(),
      depth: z.number().int().min(1).max(LIMITS.readDepth),
      max_nodes: z.number().int().min(1).max(LIMITS.readNodes),
    })
    .strict(),
  variables: z.object({}).strict(),
  export_png: z
    .object({
      node_id: nodeId.optional(),
      scale: z.number().min(LIMITS.exportMinScale).max(LIMITS.exportMaxScale),
    })
    .strict(),
  create_frame: z.object({ spec: RootFrameSchema }).strict(),
  set_text: z
    .object({
      node_id: nodeId,
      text: z.string().max(LIMITS.setText),
      expect: Expect,
      scope: Scope,
    })
    .strict(),
  rename: z.object({ node_id: nodeId, name: layerName, expect: Expect, scope: Scope }).strict(),
  bind_variable: z
    .object({
      node_id: nodeId,
      field: z.enum(BINDABLE_FIELDS),
      variable: z.string().min(1).max(LIMITS.variableName),
      collection: z.string().min(1).max(LIMITS.name).optional(),
      paint_index: z.number().int().min(0).max(20).optional(),
      expect: Expect,
      scope: Scope,
    })
    .strict(),
  create_component: z
    .object({ node_id: nodeId, name: layerName.optional(), expect: Expect, scope: Scope })
    .strict(),
} satisfies Record<OpKind, z.ZodType>;

export type OpArgs = { [K in OpKind]: z.infer<(typeof OP_ARGS)[K]> };

/** One operation on the wire. */
export interface FigmaOp<K extends OpKind = OpKind> {
  id: string;
  v: number;
  kind: K;
  args: OpArgs[K];
}

// ── What the plugin answers. Validated: the plugin is ours, the file it reads is not. ──

const page = z.object({ id: z.string().max(40), name: z.string().max(500) });
const fp = z.string().regex(/^[0-9a-f]{8}$/);
const brief = z.object({
  id: nodeId,
  name: z.string().max(500),
  type: z.string().max(40),
  fp,
});

export interface ReadNode {
  id: string;
  name: string;
  type: string;
  fp: string;
  characters?: string | undefined;
  children?: ReadNode[] | undefined;
  [k: string]: unknown;
}

const ReadNodeSchema: z.ZodType<ReadNode> = z.lazy(() =>
  z.looseObject({
    id: nodeId,
    name: z.string().max(500),
    type: z.string().max(40),
    fp,
    characters: z
      .string()
      .max(LIMITS.textChars + 1)
      .optional(),
    children: z.array(ReadNodeSchema).max(LIMITS.readNodes).optional(),
  }),
);

const color = z.object({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
  a: z.number().min(0).max(1),
});
export const VariableValue = z.union([
  z.number(),
  z.boolean(),
  z.string().max(5000),
  color,
  z.object({ alias: z.string().max(200) }),
]);
export type VariableValue = z.infer<typeof VariableValue>;

export const RESULTS = {
  status: z.object({
    file: z.string().max(500),
    editor: z.string().max(40),
    page: page.extend({ drafts: z.boolean() }),
    selection: z.number().int().nonnegative(),
    nodes: z.array(brief.omit({ fp: true })).max(20),
    drafts: page.nullable(),
  }),
  read: z.object({
    page,
    inDrafts: z.boolean(),
    count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    nodes: z.array(ReadNodeSchema).max(LIMITS.readNodes),
  }),
  variables: z.object({
    collections: z
      .array(
        z.object({
          id: z.string().max(200),
          name: z.string().max(500),
          defaultModeId: z.string().max(200),
          modes: z
            .array(z.object({ modeId: z.string().max(200), name: z.string().max(200) }))
            .max(40),
        }),
      )
      .max(LIMITS.collections),
    variables: z
      .array(
        z.object({
          id: z.string().max(200),
          name: z.string().max(500),
          collectionId: z.string().max(200),
          type: z.enum(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN']),
          description: z.string().max(2000).optional(),
          scopes: z.array(z.string().max(60)).max(40),
          codeSyntax: z.record(z.string().max(20), z.string().max(500)).optional(),
          values: z.record(z.string().max(200), VariableValue),
        }),
      )
      .max(LIMITS.variables),
    remote: z
      .array(
        z.object({
          id: z.string().max(200),
          name: z.string().max(500),
          collection: z.string().max(500),
        }),
      )
      .max(500),
  }),
  export_png: z.object({
    id: nodeId,
    name: z.string().max(500),
    type: z.string().max(40),
    width: z.number().int().positive().max(LIMITS.exportMaxSide),
    height: z.number().int().positive().max(LIMITS.exportMaxSide),
    scale: z.number().positive(),
    png: z
      .string()
      .min(8)
      .max(Math.ceil((LIMITS.exportMaxBytes * 4) / 3) + 4)
      .regex(/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/, 'a base64 PNG'),
  }),
  create_frame: z.object({
    page,
    root: nodeId,
    nodes: z.array(brief).min(1).max(LIMITS.specNodes),
    fontFallbacks: z.number().int().nonnegative(),
  }),
  set_text: brief,
  rename: brief,
  bind_variable: brief,
  create_component: brief,
} satisfies Record<OpKind, z.ZodType>;

export type OpResult = { [K in OpKind]: z.infer<(typeof RESULTS)[K]> };

/** Error codes the plugin may answer with. */
export const PLUGIN_ERRORS = [
  'invalid',
  'version',
  'not_found',
  'stale',
  'not_draft',
  'unsupported',
  'font',
  'too_large',
  'no_selection',
  'page_limit',
  'variable',
  'error',
] as const;
export type PluginErrorCode = (typeof PLUGIN_ERRORS)[number];
