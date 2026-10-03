import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BINDABLE_FIELDS,
  CATALOGUE_VERSION,
  DRAFTS_PAGE,
  FIGMA_PORT,
  LIMITS,
  OP_ARGS,
  OP_KINDS,
  type OpKind,
  RESULTS,
} from '../src/figma/catalogue.ts';

/**
 * The plugin cannot run inside Figma here: code.js runs in a node:vm sandbox against a small fake
 * of the Plugin API. What this proves: the plugin refuses what the daemon's catalogue refuses,
 * writes only where it should, checks fingerprints and fonts, and answers in the shapes the
 * daemon validates. What it cannot prove: that the real Figma API behaves like the fake.
 */

const PLUGIN = resolve(import.meta.dirname, '../../figma-plugin');
const CODE = readFileSync(join(PLUGIN, 'code.js'), 'utf8');
const UI = readFileSync(join(PLUGIN, 'ui.html'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN, 'manifest.json'), 'utf8')) as Record<
  string,
  unknown
>;

const MIXED = Symbol('mixed');

type Props = Record<string, unknown>;
interface FNode extends Props {
  id: string;
  type: string;
  name: string;
  parent: FNode | null;
  removed: boolean;
  children?: FNode[];
}

interface Doc {
  root: FNode;
  current: FNode;
  byId: Map<string, FNode>;
  loaded: Set<string>;
  missingFonts: Set<string>;
  posted: Props[];
  notes: string[];
  storage: Map<string, unknown>;
  variables: Props[];
  collections: Props[];
  remote: Props[];
  pageLimit: boolean;
  failRectangle: boolean;
  undoSteps: number;
  seq: number;
}

const fontKey = (f: { family: string; style: string }) => `${f.family}/${f.style}`;

function detach(n: FNode) {
  const siblings = n.parent?.children;
  if (siblings) siblings.splice(siblings.indexOf(n), 1);
  n.parent = null;
}

function makeNode(doc: Doc, type: string, name: string, props: Props = {}): FNode {
  const data = new Map<string, string>();
  const scene = type !== 'PAGE' && type !== 'DOCUMENT';
  const n: FNode = {
    id: `${type === 'PAGE' ? 0 : 1}:${++doc.seq}`,
    type,
    name,
    parent: null,
    removed: false,
    getPluginData: (k: string) => data.get(k) ?? '',
    setPluginData: (k: string, v: string) => data.set(k, v),
    appendChild: (c: FNode) => {
      detach(c);
      c.parent = n;
      n.children ??= [];
      n.children.push(c);
    },
    remove: () => {
      detach(n);
      n.removed = true;
      doc.byId.delete(n.id);
    },
    loadAsync: async () => undefined,
  };
  if (type === 'PAGE' || type === 'FRAME' || type === 'COMPONENT' || type === 'INSTANCE')
    n.children = [];
  if (type === 'PAGE') n.selection = [];
  if (scene) {
    Object.assign(n, {
      visible: true,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
      fills: [],
      strokes: [],
      effects: [],
      boundVariables: {},
      resize: (w: number, h: number) => {
        n.width = w;
        n.height = h;
      },
      setBoundVariable: (field: string, v: { id: string }) => {
        n.boundVariables = {
          ...(n.boundVariables as Props),
          [field]: { type: 'VARIABLE_ALIAS', id: v.id },
        };
      },
      exportAsync: async () => new Uint8Array((n.exportBytes as number[]) ?? PNG),
    });
  }
  if (type === 'FRAME' || type === 'COMPONENT' || type === 'INSTANCE') {
    Object.assign(n, {
      layoutMode: 'NONE',
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      itemSpacing: 0,
      cornerRadius: 0,
      clipsContent: true,
      layoutSizingHorizontal: 'FIXED',
      layoutSizingVertical: 'FIXED',
    });
  }
  if (type === 'RECTANGLE') n.cornerRadius = 0;
  if (type === 'TEXT') {
    let chars = '';
    Object.assign(n, {
      fontName: { family: 'Inter', style: 'Regular' },
      fontSize: 16,
      fontWeight: 400,
      lineHeight: { unit: 'AUTO' },
      letterSpacing: { unit: 'PERCENT', value: 0 },
      textAlignHorizontal: 'LEFT',
      textAutoResize: 'WIDTH_AND_HEIGHT',
      textCase: 'ORIGINAL',
      textDecoration: 'NONE',
      hasMissingFont: false,
      getRangeAllFontNames: () => [n.fontName],
      setRangeBoundVariable: (_s: number, _e: number, field: string, v: { id: string }) => {
        n.boundVariables = { [field]: [{ type: 'VARIABLE_ALIAS', id: v.id }] };
      },
    });
    // Like Figma: text cannot change unless its font was loaded first.
    Object.defineProperty(n, 'characters', {
      enumerable: true,
      get: () => chars,
      set: (v: string) => {
        if (!doc.loaded.has(fontKey(n.fontName as { family: string; style: string })))
          throw new Error('Cannot write to node with unloaded font');
        chars = v;
      },
    });
  }
  Object.assign(n, props);
  doc.byId.set(n.id, n);
  return n;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

function makeDoc(): Doc {
  const doc = {
    byId: new Map(),
    loaded: new Set<string>(),
    missingFonts: new Set<string>(),
    posted: [],
    notes: [],
    storage: new Map<string, unknown>([['jarvis-token', 'tok']]),
    pageLimit: false,
    failRectangle: false,
    undoSteps: 0,
    seq: 0,
  } as unknown as Doc;
  doc.root = makeNode(doc, 'DOCUMENT', 'Maquette équipe', { children: [] });
  const home = makeNode(doc, 'PAGE', 'Home');
  (doc.root.appendChild as (c: FNode) => void)(home);
  doc.current = home;
  doc.collections = [
    {
      id: 'VariableCollectionId:1:0',
      name: 'Tokens',
      defaultModeId: '1:0',
      modes: [{ modeId: '1:0', name: 'Value' }],
    },
  ];
  doc.variables = [
    {
      id: 'VariableID:1:1',
      name: 'color/primary',
      variableCollectionId: 'VariableCollectionId:1:0',
      resolvedType: 'COLOR',
      scopes: ['ALL_SCOPES'],
      description: '',
      codeSyntax: {},
      valuesByMode: { '1:0': { r: 0.2, g: 0.4, b: 1, a: 1 } },
    },
    {
      id: 'VariableID:1:2',
      name: 'space/md',
      variableCollectionId: 'VariableCollectionId:1:0',
      resolvedType: 'FLOAT',
      scopes: ['GAP'],
      description: 'Medium',
      codeSyntax: { WEB: 'var(--space-md)' },
      valuesByMode: { '1:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' } },
    },
  ];
  doc.remote = [
    { id: 'VariableID:9:9', name: 'lib/space', variableCollectionId: 'lib', resolvedType: 'FLOAT' },
  ];
  return doc;
}

function makeFigma(doc: Doc) {
  const inCurrent = (n: FNode) => {
    (doc.current.appendChild as (c: FNode) => void)(n);
    return n;
  };
  return {
    mixed: MIXED,
    editorType: 'figma',
    root: doc.root,
    get currentPage() {
      return doc.current;
    },
    showUI: () => undefined,
    commitUndo: () => {
      doc.undoSteps++;
    },
    ui: {
      postMessage: (m: Props) => doc.posted.push(m),
      onmessage: null as null | ((m: unknown) => void),
    },
    notify: (t: string) => doc.notes.push(t),
    clientStorage: {
      getAsync: async (k: string) => doc.storage.get(k),
      setAsync: async (k: string, v: unknown) => {
        doc.storage.set(k, v);
      },
    },
    getNodeByIdAsync: async (id: string) => doc.byId.get(id) ?? null,
    getStyleByIdAsync: async () => null,
    createPage: () => {
      if (doc.pageLimit) throw new Error('Starter plan: 3 pages');
      const p = makeNode(doc, 'PAGE', 'Page');
      (doc.root.appendChild as (c: FNode) => void)(p);
      return p;
    },
    // Like Figma, new layers appear in the current page until moved.
    createFrame: () =>
      inCurrent(
        makeNode(doc, 'FRAME', 'Frame', {
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
        }),
      ),
    createText: () => inCurrent(makeNode(doc, 'TEXT', 'Text')),
    createRectangle: () => {
      if (doc.failRectangle) throw new Error('boom');
      return inCurrent(makeNode(doc, 'RECTANGLE', 'Rectangle'));
    },
    loadFontAsync: async (f: { family: string; style: string }) => {
      if (doc.missingFonts.has(f.family)) throw new Error(`no font ${f.family}`);
      doc.loaded.add(fontKey(f));
    },
    createComponentFromNode: (node: FNode) => {
      const c = makeNode(doc, 'COMPONENT', node.name);
      const parent = node.parent;
      (node.remove as () => void)();
      if (parent) (parent.appendChild as (c: FNode) => void)(c);
      return c;
    },
    base64Encode: (b: Uint8Array) => Buffer.from(b).toString('base64'),
    variables: {
      getLocalVariablesAsync: async () => doc.variables,
      getLocalVariableCollectionsAsync: async () => doc.collections,
      getVariableByIdAsync: async (id: string) =>
        [...doc.variables, ...doc.remote].find((v) => v.id === id) ?? null,
      getVariableCollectionByIdAsync: async (id: string) =>
        doc.collections.find((c) => c.id === id) ?? null,
      setBoundVariableForPaint: (paint: Props, field: string, v: { id: string }) => ({
        ...paint,
        boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: v.id } },
      }),
    },
  };
}

interface PluginApi {
  validateOp(op: unknown): { code: string; message: string } | null;
  run(op: unknown): Promise<Props>;
  fingerprint(node: FNode): string;
  LIMITS: unknown;
  OP_KINDS: unknown;
  BINDABLE_FIELDS: unknown;
  CATALOGUE_VERSION: number;
  DRAFTS_PAGE: string;
}

function loadPlugin(doc: Doc) {
  const figma = makeFigma(doc);
  const context = vm.createContext({ figma, __html__: '<p>ui</p>' });
  vm.runInContext(
    `${CODE}\n;globalThis.__jarvis = { validateOp, run, fingerprint, LIMITS, OP_KINDS, BINDABLE_FIELDS, CATALOGUE_VERSION, DRAFTS_PAGE };`,
    context,
    { filename: 'code.js' },
  );
  return { figma, api: (context as { __jarvis: PluginApi }).__jarvis };
}

const op = (kind: string, args: unknown, v = CATALOGUE_VERSION) => ({
  id: randomUUID(),
  v,
  kind,
  args,
});
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

let doc: Doc;
let api: PluginApi;
let figma: ReturnType<typeof makeFigma>;
let card: FNode;
let title: FNode;

beforeEach(() => {
  doc = makeDoc();
  ({ api, figma } = loadPlugin(doc));
  card = makeNode(doc, 'FRAME', 'Card', {
    layoutMode: 'VERTICAL',
    paddingTop: 16,
    paddingRight: 16,
    paddingBottom: 16,
    paddingLeft: 16,
    itemSpacing: 8,
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'MIN',
    primaryAxisSizingMode: 'AUTO',
    counterAxisSizingMode: 'FIXED',
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }] },
    width: 320,
    height: 120,
  });
  (doc.current.appendChild as (c: FNode) => void)(card);
  doc.loaded.add('Inter/Regular');
  title = makeNode(doc, 'TEXT', 'Title');
  title.characters = 'Bienvenue';
  doc.loaded.clear();
  (card.appendChild as (c: FNode) => void)(title);
  doc.current.selection = [card];
});

describe('the plugin catalogue mirrors the daemon', () => {
  it('same constants', () => {
    expect(plain(api.LIMITS)).toEqual({ ...LIMITS });
    expect(plain(api.OP_KINDS)).toEqual([...OP_KINDS]);
    expect(plain(api.BINDABLE_FIELDS)).toEqual([...BINDABLE_FIELDS]);
    expect(api.CATALOGUE_VERSION).toBe(CATALOGUE_VERSION);
    expect(api.DRAFTS_PAGE).toBe(DRAFTS_PAGE);
  });

  const fp = { fp: '0123abcd' };
  const deep = (levels: number) => {
    let s: Props = { type: 'frame' };
    for (let i = 1; i < levels; i++) s = { type: 'frame', children: [s] };
    return s;
  };
  /** A root frame, 3 child frames and texts spread among them: `total` layers in all. */
  const wide = (total: number) => {
    const texts = total - 4;
    const group = (n: number) => ({
      type: 'frame',
      children: Array.from({ length: n }, () => ({ type: 'text', text: 'x' })),
    });
    const a = Math.ceil(texts / 3);
    return { type: 'frame', children: [group(a), group(a), group(texts - 2 * a)] };
  };
  const full = {
    type: 'frame',
    name: 'Login',
    direction: 'vertical',
    padding: { top: 24, right: 24, bottom: 24, left: 24 },
    gap: 12,
    align: 'center',
    cross_align: 'center',
    width: 360,
    fill: '#FFFFFFFF',
    radius: 12,
    children: [
      { type: 'text', text: 'Connexion', size: 24, font: 'Inter', style: 'Bold', color: '#111111' },
      { type: 'rectangle', width: 312, height: 44, fill: '#3366ff', radius: 8, fill_width: true },
      { type: 'frame', direction: 'horizontal', padding: 8, gap: 4, children: [] },
    ],
  };
  const write = { node_id: '1:2', expect: fp };
  const VECTORS: [OpKind | 'eval', unknown][] = [
    ['status', {}],
    ['status', { x: 1 }],
    ['eval', {}],
    ['read', { depth: 6, max_nodes: 300 }],
    ['read', { node_id: '12:34', depth: 1, max_nodes: 1 }],
    ['read', { node_id: 'I12:34;5:6', depth: 8, max_nodes: 600 }],
    ['read', { depth: 0, max_nodes: 300 }],
    ['read', { depth: 6, max_nodes: 601 }],
    ['read', { depth: 6.5, max_nodes: 3 }],
    ['read', { node_id: '12:34; drop', depth: 6, max_nodes: 300 }],
    ['read', { depth: 6 }],
    ['variables', {}],
    ['variables', { collection: 'x' }],
    ['export_png', { scale: 2 }],
    ['export_png', { scale: 0.1 }],
    ['export_png', { scale: 5 }],
    ['export_png', { scale: '2' }],
    ['export_png', { node_id: 'I1:2;3:4', scale: 1 }],
    ['create_frame', { spec: { type: 'frame' } }],
    ['create_frame', { spec: full }],
    ['create_frame', { spec: { type: 'text', text: 'x' } }],
    ['create_frame', { spec: { type: 'frame', script: 'figma.root.remove()' } }],
    ['create_frame', { spec: { type: 'frame', fill: 'red' } }],
    ['create_frame', { spec: { type: 'frame', fill: '#12345' } }],
    ['create_frame', { spec: { type: 'frame', padding: { top: 4, middle: 2 } } }],
    ['create_frame', { spec: { type: 'frame', padding: -1 } }],
    ['create_frame', { spec: { type: 'frame', padding: {} } }],
    ['create_frame', { spec: { type: 'frame', name: 'a\nb' } }],
    ['create_frame', { spec: { type: 'frame', direction: 'diagonal' } }],
    ['create_frame', { spec: { type: 'frame', width: 0 } }],
    ['create_frame', { spec: { type: 'frame', children: [{ type: 'image', url: 'x' }] } }],
    ['create_frame', { spec: { type: 'frame', children: [{ type: 'text', text: '' }] } }],
    [
      'create_frame',
      { spec: { type: 'frame', children: [{ type: 'text', text: 'x', font: 'In<t>' }] } },
    ],
    [
      'create_frame',
      { spec: { type: 'frame', children: [{ type: 'text', text: 'x', size: 401 }] } },
    ],
    ['create_frame', { spec: { type: 'frame', children: [{ type: 'rectangle', width: 10 }] } }],
    ['create_frame', { spec: { type: 'frame', children: 'none' } }],
    ['create_frame', { spec: deep(6) }],
    ['create_frame', { spec: deep(7) }],
    ['create_frame', { spec: wide(120) }],
    ['create_frame', { spec: wide(121) }],
    ['create_frame', { spec: { type: 'frame' }, parent: '0:1' }],
    ['set_text', { ...write, text: 'hi', scope: 'draft' }],
    ['set_text', { ...write, text: '', scope: 'existing' }],
    ['set_text', { ...write, text: 'hi', scope: 'everywhere' }],
    ['set_text', { ...write, text: 'hi', expect: { fp: 12345678 }, scope: 'draft' }],
    ['set_text', { ...write, text: 'hi', expect: { fp: '0123abcd', x: 1 }, scope: 'draft' }],
    ['set_text', { node_id: '1:2', text: 'hi', scope: 'draft' }],
    ['set_text', { ...write, text: 'x'.repeat(10_001), scope: 'draft' }],
    ['rename', { ...write, name: 'Card', scope: 'existing' }],
    ['rename', { ...write, name: '', scope: 'existing' }],
    ['rename', { ...write, name: 'x'.repeat(101), scope: 'existing' }],
    ['rename', { ...write, name: 'tab\there', scope: 'existing' }],
    ['bind_variable', { ...write, field: 'fill', variable: 'color/primary', scope: 'existing' }],
    [
      'bind_variable',
      { ...write, field: 'fill', variable: 'c', collection: 'T', paint_index: 2, scope: 'draft' },
    ],
    ['bind_variable', { ...write, field: 'onclick', variable: 'c', scope: 'draft' }],
    ['bind_variable', { ...write, field: 'fill', variable: 'c', paint_index: 21, scope: 'draft' }],
    ['bind_variable', { ...write, field: 'fill', variable: '', scope: 'draft' }],
    ['bind_variable', { ...write, field: 'fill', variable: 'c', collection: '', scope: 'draft' }],
    ['create_component', { ...write, scope: 'draft' }],
    ['create_component', { ...write, name: 'Button', scope: 'draft' }],
    ['create_component', { ...write, name: 3, scope: 'draft' }],
  ];

  it('accepts and refuses exactly what the daemon accepts and refuses', () => {
    let accepted = 0;
    for (const [kind, args] of VECTORS) {
      const daemon =
        kind !== 'eval' && OP_ARGS[kind].safeParse(JSON.parse(JSON.stringify(args))).success;
      const plugin = api.validateOp(op(kind, JSON.parse(JSON.stringify(args)))) === null;
      expect({ kind, args, plugin }).toEqual({ kind, args, plugin: daemon });
      if (daemon) accepted++;
    }
    expect(accepted).toBeGreaterThan(10);
    expect(VECTORS.length - accepted).toBeGreaterThan(30);
  });

  it('refuses malformed envelopes, other versions and prototype tricks', async () => {
    expect(api.validateOp(null)?.code).toBe('invalid');
    expect(api.validateOp({ ...op('status', {}), extra: 1 })?.code).toBe('invalid');
    expect(api.validateOp({ ...op('status', {}), id: 'not-a-uuid' })?.code).toBe('invalid');
    expect(api.validateOp(op('status', {}, 2))?.code).toBe('version');
    const proto = JSON.parse(
      `{"id":"${randomUUID()}","v":1,"kind":"status","args":{"__proto__":{"x":1}}}`,
    );
    expect(api.validateOp(proto)?.code).toBe('invalid');
    for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(api.validateOp(op(kind, {}))?.code).toBe('invalid');
    }
    const r = await api.run(op('eval', { code: 'figma.root.remove()' }));
    expect(plain(r)).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('the plugin against a fake Figma', () => {
  it('shows its UI and hands the stored token and file name to it', async () => {
    figma.ui.onmessage?.({ type: 'load-token' });
    await new Promise((r) => setTimeout(r, 0));
    expect(plain(doc.posted)).toContainEqual({
      type: 'init',
      token: 'tok',
      file: 'Maquette équipe',
    });
    figma.ui.onmessage?.({ type: 'save-token', token: 'new' });
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.storage.get('jarvis-token')).toBe('new');
  });

  it('status: file, page, selection, no drafts page yet', async () => {
    const r = plain(await api.run(op('status', {})));
    expect(r.ok).toBe(true);
    expect(RESULTS.status.parse(r.result)).toEqual({
      file: 'Maquette équipe',
      editor: 'figma',
      page: { id: doc.current.id, name: 'Home', drafts: false },
      selection: 1,
      nodes: [{ id: card.id, name: 'Card', type: 'FRAME' }],
      drafts: null,
    });
  });

  it('reads the selection: layout, colours as hex, variables, text, fingerprints', async () => {
    const r = plain(await api.run(op('read', { depth: 6, max_nodes: 300 })));
    const read = RESULTS.read.parse(r.result);
    expect(read).toMatchObject({ inDrafts: false, count: 2, truncated: false });
    const [c] = read.nodes;
    expect(c).toMatchObject({
      id: card.id,
      name: 'Card',
      type: 'FRAME',
      width: 320,
      layout: { mode: 'VERTICAL', padding: [16, 16, 16, 16], gap: 8 },
      fills: [{ type: 'SOLID', hex: '#FFFFFF' }],
      bound: { fills: ['color/primary'] },
      fp: api.fingerprint(card),
    });
    expect(c?.children?.[0]).toMatchObject({
      type: 'TEXT',
      characters: 'Bienvenue',
      text: { size: 16, font: { family: 'Inter', style: 'Regular' }, lineHeight: 'auto' },
      fp: api.fingerprint(title),
    });
    const shallow = RESULTS.read.parse(
      plain(await api.run(op('read', { depth: 1, max_nodes: 300 }))).result,
    );
    expect(shallow).toMatchObject({ truncated: true, nodes: [{ childCount: 1 }] });
    doc.current.selection = [];
    expect(plain(await api.run(op('read', { depth: 6, max_nodes: 300 })))).toMatchObject({
      ok: false,
      code: 'no_selection',
    });
  });

  it('create_frame builds in the "Jarvis drafts" page only, created once', async () => {
    const spec = {
      type: 'frame',
      name: 'Login',
      padding: 24,
      gap: 12,
      fill: '#FFFFFF',
      children: [
        { type: 'text', text: 'Connexion', size: 24, style: 'Bold' },
        { type: 'rectangle', width: 312, height: 44, fill: '#3366FF', fill_width: true },
      ],
    };
    const before = doc.current.children?.length;
    const r = plain(await api.run(op('create_frame', { spec })));
    expect(r.ok).toBe(true);
    const created = RESULTS.create_frame.parse(r.result);
    expect(created.nodes.map((n) => n.type)).toEqual(['FRAME', 'TEXT', 'RECTANGLE']);
    const drafts = doc.root.children?.find((p) => p.name === DRAFTS_PAGE);
    if (!drafts) throw new Error('no drafts page');
    expect((drafts.getPluginData as (k: string) => string)('jarvis')).toBe('drafts');
    expect(created.page.id).toBe(drafts?.id);
    // Nothing stays in Brightky's current page.
    expect(doc.current.children?.length).toBe(before);
    const root = doc.byId.get(created.root);
    expect(root).toMatchObject({
      parent: drafts,
      layoutMode: 'VERTICAL',
      paddingLeft: 24,
      itemSpacing: 12,
      primaryAxisSizingMode: 'AUTO',
    });
    expect(root?.children?.[1]).toMatchObject({ width: 312, layoutSizingHorizontal: 'FILL' });
    expect(created.fontFallbacks).toBe(0);
    // A second frame goes next to the first, in the same page.
    const again = RESULTS.create_frame.parse(
      plain(await api.run(op('create_frame', { spec: { type: 'frame' } }))).result,
    );
    expect(again.page.id).toBe(drafts?.id);
    expect(doc.byId.get(again.root)?.x).toBeGreaterThan(0);
    expect(doc.root.children?.filter((p) => p.name === DRAFTS_PAGE)).toHaveLength(1);
  });

  it('a missing font falls back to Inter; a failed build leaves nothing behind', async () => {
    doc.missingFonts.add('Comic');
    const ok = plain(
      await api.run(
        op('create_frame', {
          spec: { type: 'frame', children: [{ type: 'text', text: 'x', font: 'Comic' }] },
        }),
      ),
    );
    expect(RESULTS.create_frame.parse(ok.result).fontFallbacks).toBe(1);
    doc.failRectangle = true;
    const count = doc.byId.size;
    const r = plain(
      await api.run(
        op('create_frame', {
          spec: {
            type: 'frame',
            children: [
              { type: 'text', text: 'x' },
              { type: 'rectangle', width: 1, height: 1 },
            ],
          },
        }),
      ),
    );
    expect(r).toMatchObject({ ok: false, code: 'error' });
    expect(doc.byId.size).toBe(count);
  });

  it('the Starter page limit is reported as such', async () => {
    doc.pageLimit = true;
    expect(plain(await api.run(op('create_frame', { spec: { type: 'frame' } })))).toMatchObject({
      ok: false,
      code: 'page_limit',
    });
  });

  it('writes: refused outside the drafts page when the daemon decided N1', async () => {
    const fp = api.fingerprint(title);
    const r = plain(
      await api.run(
        op('set_text', { node_id: title.id, text: 'Welcome', expect: { fp }, scope: 'draft' }),
      ),
    );
    expect(r).toMatchObject({ ok: false, code: 'not_draft' });
    expect(title.characters).toBe('Bienvenue');
  });

  it('writes: refused when the layer changed since it was read', async () => {
    const fp = api.fingerprint(title);
    doc.loaded.add('Inter/Regular');
    title.characters = 'Bienvenue à tous';
    doc.loaded.clear();
    const r = plain(
      await api.run(
        op('set_text', { node_id: title.id, text: 'Welcome', expect: { fp }, scope: 'existing' }),
      ),
    );
    expect(r).toMatchObject({ ok: false, code: 'stale' });
  });

  it('set_text loads the fonts, then writes; rename', async () => {
    const r = plain(
      await api.run(
        op('set_text', {
          node_id: title.id,
          text: 'Welcome',
          expect: { fp: api.fingerprint(title) },
          scope: 'existing',
        }),
      ),
    );
    expect(r.ok).toBe(true);
    expect(title.characters).toBe('Welcome');
    expect(RESULTS.set_text.parse(r.result).fp).toBe(api.fingerprint(title));
    const n = plain(
      await api.run(
        op('rename', {
          node_id: card.id,
          name: 'Card/Default',
          expect: { fp: api.fingerprint(card) },
          scope: 'existing',
        }),
      ),
    );
    expect(n.ok).toBe(true);
    expect(card.name).toBe('Card/Default');
    expect(doc.notes.join(' ')).toContain('Jarvis');
    // Each write is its own undo step in Figma.
    expect(doc.undoSteps).toBe(2);
  });

  it('bind_variable: checks the variable type, binds a fill colour', async () => {
    const base = { expect: { fp: api.fingerprint(title) }, scope: 'existing' };
    expect(
      plain(
        await api.run(
          op('bind_variable', {
            ...base,
            node_id: title.id,
            field: 'fontSize',
            variable: 'color/primary',
          }),
        ),
      ),
    ).toMatchObject({ ok: false, code: 'variable' });
    expect(
      plain(
        await api.run(
          op('bind_variable', { ...base, node_id: title.id, field: 'fill', variable: 'nope' }),
        ),
      ),
    ).toMatchObject({ ok: false, code: 'variable' });
    const r = plain(
      await api.run(
        op('bind_variable', {
          node_id: card.id,
          field: 'fill',
          variable: 'color/primary',
          collection: 'Tokens',
          expect: { fp: api.fingerprint(card) },
          scope: 'existing',
        }),
      ),
    );
    expect(r.ok).toBe(true);
    expect((card.fills as Props[])[0]).toMatchObject({
      boundVariables: { color: { id: 'VariableID:1:1' } },
    });
    const gap = plain(
      await api.run(
        op('bind_variable', {
          node_id: card.id,
          field: 'itemSpacing',
          variable: 'space/md',
          expect: { fp: api.fingerprint(card) },
          scope: 'existing',
        }),
      ),
    );
    expect(gap.ok).toBe(true);
    expect(card.boundVariables).toMatchObject({ itemSpacing: { id: 'VariableID:1:2' } });
  });

  it('create_component converts a frame; instances are refused', async () => {
    const r = plain(
      await api.run(
        op('create_component', {
          node_id: card.id,
          name: 'Card',
          expect: { fp: api.fingerprint(card) },
          scope: 'existing',
        }),
      ),
    );
    expect(RESULTS.create_component.parse(r.result)).toMatchObject({
      type: 'COMPONENT',
      name: 'Card',
    });
    const inst = makeNode(doc, 'INSTANCE', 'Button');
    (doc.current.appendChild as (c: FNode) => void)(inst);
    const refused = plain(
      await api.run(
        op('create_component', {
          node_id: inst.id,
          expect: { fp: api.fingerprint(inst) },
          scope: 'existing',
        }),
      ),
    );
    expect(refused).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('export: PNG within the size cap; too large is refused', async () => {
    card.width = 10_000;
    const r = plain(await api.run(op('export_png', { scale: 2 })));
    const png = RESULTS.export_png.parse(r.result);
    expect(png.width).toBeLessThanOrEqual(LIMITS.exportMaxSide);
    expect(png.scale).toBeLessThan(0.25);
    card.exportBytes = [...PNG, ...new Array(LIMITS.exportMaxBytes).fill(0)];
    expect(plain(await api.run(op('export_png', { scale: 1 })))).toMatchObject({
      ok: false,
      code: 'too_large',
    });
  });

  it('variables: raw values, aliases, library names', async () => {
    const r = RESULTS.variables.parse(plain(await api.run(op('variables', {}))).result);
    expect(r.variables[1]).toMatchObject({
      name: 'space/md',
      values: { '1:0': { alias: 'VariableID:9:9' } },
      codeSyntax: { WEB: 'var(--space-md)' },
    });
    expect(r.remote).toEqual([{ id: 'VariableID:9:9', name: 'lib/space', collection: 'library' }]);
  });
});

describe('plugin files', () => {
  it('no dynamic code anywhere in the plugin', () => {
    for (const src of [CODE, UI]) {
      expect(src).not.toMatch(
        /\beval\s*\(|new\s+Function\b|\bFunction\s*\(|\bimport\s*\(|innerHTML|document\.write/,
      );
      expect(src).not.toMatch(/setTimeout\s*\(\s*['"`]/);
    }
  });

  it('manifest: dev network access to the bridge port on localhost only', () => {
    expect(MANIFEST).toMatchObject({
      main: 'code.js',
      ui: 'ui.html',
      editorType: ['figma'],
      documentAccess: 'dynamic-page',
      networkAccess: {
        allowedDomains: ['none'],
        devAllowedDomains: [`http://localhost:${FIGMA_PORT}`],
      },
    });
    expect(UI).toContain(`const BASE = 'http://localhost:${FIGMA_PORT}';`);
    expect(UI).toContain(`const CATALOGUE_VERSION = ${CATALOGUE_VERSION};`);
  });
});
