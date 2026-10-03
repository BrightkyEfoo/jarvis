// Jarvis × Figma: main thread of the development plugin (ADR-034).
//
// ui.html long-polls jarvisd on 127.0.0.1 and hands each operation to this file. Only the FIXED
// catalogue below runs: this file never evaluates code, never calls a Plugin API method by a name
// it was sent, and re-validates every operation with the same rules as the daemon
// (apps/jarvisd/src/figma/catalogue.ts; tests check both agree). Anything else is refused.
//
// Plain JS without a build step, kept to syntax the plugin sandbox has long supported (no ?. or ??).

const CATALOGUE_VERSION = 1;
const DRAFTS_PAGE = 'Jarvis drafts';
const LIMITS = {
  readDepth: 8,
  readNodes: 600,
  textChars: 2000,
  textBudget: 20000,
  exportMaxSide: 2048,
  exportMinScale: 0.25,
  exportMaxScale: 4,
  exportMaxBytes: 3500000,
  specDepth: 6,
  specNodes: 120,
  specChildren: 50,
  specText: 2000,
  size: 10000,
  spacing: 1000,
  fontSize: 400,
  name: 100,
  setText: 10000,
  variableName: 200,
  variables: 2000,
  collections: 100,
};
const OP_KINDS = [
  'status',
  'read',
  'variables',
  'export_png',
  'create_frame',
  'set_text',
  'rename',
  'bind_variable',
  'create_component',
];
const BINDABLE_FIELDS = [
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
];
const TEXT_FIELDS = [
  'fontFamily',
  'fontStyle',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'paragraphSpacing',
];
const NOT_COMPONENTABLE = [
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'PAGE',
  'DOCUMENT',
  'SECTION',
  'SLICE',
];

const NODE_ID = /^I?\d{1,9}:\d{1,9}(;\d{1,9}:\d{1,9}){0,20}$/;
const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const FONT_WORD = /^[A-Za-z0-9 ._-]+$/;
const FP = /^[0-9a-f]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
const CONTROL = /[\u0000-\u001f\u007f]/;

class OpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Validation: the same rules as the daemon's zod catalogue ──

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const isInt = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
const isStr = (x, min, max) => typeof x === 'string' && x.length >= min && x.length <= max;
const isName = (x) => isStr(x, 1, LIMITS.name) && !CONTROL.test(x);
const isFontWord = (x) => isStr(x, 1, 60) && FONT_WORD.test(x);
const isNodeId = (x) => typeof x === 'string' && NODE_ID.test(x);
const isHex = (x) => typeof x === 'string' && HEX.test(x);
const isSpacing = (x) => isNum(x, 0, LIMITS.spacing);
const isSize = (x) => isNum(x, 1, LIMITS.size);
const oneOf = (x, list) => typeof x === 'string' && list.indexOf(x) >= 0;
const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

/** Unexpected or missing keys; `optional` may be absent, `required` must be present. */
function shape(o, required, optional, where) {
  for (const k of Object.keys(o)) {
    if (required.indexOf(k) < 0 && optional.indexOf(k) < 0)
      return `${where}: unexpected key "${clip(k, 40)}"`;
  }
  for (const k of required) {
    if (!(k in o)) return `${where}: missing ${k}`;
  }
  return null;
}

const SPEC_KEYS = {
  frame: [
    'name',
    'direction',
    'padding',
    'gap',
    'align',
    'cross_align',
    'width',
    'height',
    'fill',
    'radius',
    'fill_width',
    'children',
  ],
  text: ['name', 'size', 'font', 'style', 'color', 'align', 'fill_width'],
  rectangle: ['name', 'fill', 'radius', 'fill_width'],
};

/** Returns a problem, or null. `stats` counts layers and depth across the whole tree. */
function checkSpec(s, depth, stats) {
  if (!isObj(s)) return 'spec: a layer must be an object';
  stats.nodes++;
  stats.depth = Math.max(stats.depth, depth);
  const has = (k) => k in s;
  if (has('name') && !isName(s.name)) return 'spec: bad name';
  if (has('fill_width') && typeof s.fill_width !== 'boolean') return 'spec: bad fill_width';
  if (s.type === 'frame') {
    const bad = shape(s, ['type'], SPEC_KEYS.frame, 'frame');
    if (bad) return bad;
    if (has('direction') && !oneOf(s.direction, ['horizontal', 'vertical']))
      return 'frame: bad direction';
    if (has('padding')) {
      const p = s.padding;
      if (isObj(p)) {
        const badPad = shape(p, [], ['top', 'right', 'bottom', 'left'], 'padding');
        if (badPad) return badPad;
        for (const k of Object.keys(p)) if (!isSpacing(p[k])) return 'frame: bad padding';
      } else if (!isSpacing(p)) return 'frame: bad padding';
    }
    if (has('gap') && !isSpacing(s.gap)) return 'frame: bad gap';
    if (has('align') && !oneOf(s.align, ['start', 'center', 'end', 'space_between']))
      return 'frame: bad align';
    if (has('cross_align') && !oneOf(s.cross_align, ['start', 'center', 'end']))
      return 'frame: bad cross_align';
    if (has('width') && !isSize(s.width)) return 'frame: bad width';
    if (has('height') && !isSize(s.height)) return 'frame: bad height';
    if (has('fill') && !isHex(s.fill)) return 'frame: bad fill';
    if (has('radius') && !isSpacing(s.radius)) return 'frame: bad radius';
    if (has('children')) {
      if (!Array.isArray(s.children) || s.children.length > LIMITS.specChildren)
        return 'frame: bad children';
      for (const c of s.children) {
        const bad2 = checkSpec(c, depth + 1, stats);
        if (bad2) return bad2;
      }
    }
    return null;
  }
  if (s.type === 'text') {
    const bad = shape(s, ['type', 'text'], SPEC_KEYS.text, 'text');
    if (bad) return bad;
    if (!isStr(s.text, 1, LIMITS.specText)) return 'text: bad text';
    if (has('size') && !isNum(s.size, 1, LIMITS.fontSize)) return 'text: bad size';
    if (has('font') && !isFontWord(s.font)) return 'text: bad font';
    if (has('style') && !isFontWord(s.style)) return 'text: bad style';
    if (has('color') && !isHex(s.color)) return 'text: bad color';
    if (has('align') && !oneOf(s.align, ['left', 'center', 'right'])) return 'text: bad align';
    return null;
  }
  if (s.type === 'rectangle') {
    const bad = shape(s, ['type', 'width', 'height'], SPEC_KEYS.rectangle, 'rectangle');
    if (bad) return bad;
    if (!isSize(s.width) || !isSize(s.height)) return 'rectangle: bad size';
    if (has('fill') && !isHex(s.fill)) return 'rectangle: bad fill';
    if (has('radius') && !isSpacing(s.radius)) return 'rectangle: bad radius';
    return null;
  }
  return 'spec: unknown layer type';
}

function checkWriteArgs(a) {
  if (!isNodeId(a.node_id)) return 'bad node_id';
  const e = a.expect;
  if (!isObj(e) || shape(e, ['fp'], [], 'expect') || typeof e.fp !== 'string' || !FP.test(e.fp))
    return 'bad expect';
  if (!oneOf(a.scope, ['draft', 'existing'])) return 'bad scope';
  return null;
}

/** Returns { code, message } when the operation is outside the catalogue, else null. */
function validateOp(op) {
  if (!isObj(op)) return { code: 'invalid', message: 'not an operation' };
  const bad = shape(op, ['id', 'v', 'kind', 'args'], [], 'operation');
  if (bad) return { code: 'invalid', message: bad };
  if (typeof op.id !== 'string' || !UUID.test(op.id))
    return { code: 'invalid', message: 'bad operation id' };
  if (op.v !== CATALOGUE_VERSION) return { code: 'version', message: 'catalogue version mismatch' };
  if (!oneOf(op.kind, OP_KINDS)) return { code: 'invalid', message: 'unknown operation' };
  const a = op.args;
  if (!isObj(a)) return { code: 'invalid', message: 'bad arguments' };
  const problem = checkArgs(op.kind, a);
  return problem ? { code: 'invalid', message: `${op.kind}: ${problem}` } : null;
}

function checkArgs(kind, a) {
  const W = ['node_id', 'expect', 'scope'];
  switch (kind) {
    case 'status':
    case 'variables':
      return shape(a, [], [], kind);
    case 'read':
      return (
        shape(a, ['depth', 'max_nodes'], ['node_id'], kind) ||
        ('node_id' in a && !isNodeId(a.node_id) ? 'bad node_id' : null) ||
        (isInt(a.depth, 1, LIMITS.readDepth) ? null : 'bad depth') ||
        (isInt(a.max_nodes, 1, LIMITS.readNodes) ? null : 'bad max_nodes')
      );
    case 'export_png':
      return (
        shape(a, ['scale'], ['node_id'], kind) ||
        ('node_id' in a && !isNodeId(a.node_id) ? 'bad node_id' : null) ||
        (isNum(a.scale, LIMITS.exportMinScale, LIMITS.exportMaxScale) ? null : 'bad scale')
      );
    case 'create_frame': {
      const bad = shape(a, ['spec'], [], kind);
      if (bad) return bad;
      if (!isObj(a.spec) || a.spec.type !== 'frame') return 'the root must be a frame';
      const stats = { nodes: 0, depth: 0 };
      const problem = checkSpec(a.spec, 1, stats);
      if (problem) return problem;
      if (stats.depth > LIMITS.specDepth) return `spec deeper than ${LIMITS.specDepth} levels`;
      if (stats.nodes > LIMITS.specNodes) return `spec has more than ${LIMITS.specNodes} layers`;
      return null;
    }
    case 'set_text':
      return (
        shape(a, W.concat(['text']), [], kind) ||
        checkWriteArgs(a) ||
        (isStr(a.text, 0, LIMITS.setText) ? null : 'bad text')
      );
    case 'rename':
      return (
        shape(a, W.concat(['name']), [], kind) ||
        checkWriteArgs(a) ||
        (isName(a.name) ? null : 'bad name')
      );
    case 'bind_variable':
      return (
        shape(a, W.concat(['field', 'variable']), ['collection', 'paint_index'], kind) ||
        checkWriteArgs(a) ||
        (oneOf(a.field, BINDABLE_FIELDS) ? null : 'bad field') ||
        (isStr(a.variable, 1, LIMITS.variableName) ? null : 'bad variable') ||
        ('collection' in a && !isStr(a.collection, 1, LIMITS.name) ? 'bad collection' : null) ||
        ('paint_index' in a && !isInt(a.paint_index, 0, 20) ? 'bad paint_index' : null)
      );
    case 'create_component':
      return (
        shape(a, W, ['name'], kind) ||
        checkWriteArgs(a) ||
        ('name' in a && !isName(a.name) ? 'bad name' : null)
      );
    default:
      return 'unknown operation';
  }
}

// ── Helpers on the document ──

const round = (n) => Math.round(n * 100) / 100;
const num = (v) => {
  if (v === figma.mixed) return 'mixed';
  return typeof v === 'number' ? round(v) : null;
};
const hex2 = (v) => {
  const h = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
  return h.length === 1 ? `0${h}` : h;
};
function toHex(c, alpha) {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return (alpha !== undefined && alpha < 1 ? base + hex2(alpha) : base).toUpperCase();
}
function solid(hex) {
  const n = (i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
  return {
    type: 'SOLID',
    color: { r: n(1), g: n(3), b: n(5) },
    opacity: hex.length === 9 ? n(7) : 1,
  };
}

/** FNV-1a of type, name and text: the daemon sends it back so a changed layer is not written. */
function fingerprint(node) {
  const s = `${node.type}\u0000${node.name}\u0000${node.type === 'TEXT' ? node.characters : ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `0000000${h.toString(16)}`.slice(-8);
}
const brief = (node) => ({
  id: node.id,
  name: clip(node.name, 500),
  type: node.type,
  fp: fingerprint(node),
});

const isDraft = (page) => page.getPluginData('jarvis') === 'drafts';
function pageOf(node) {
  let n = node;
  while (n && n.type !== 'PAGE') n = n.parent;
  return n || null;
}
async function draftsPage(create) {
  for (const p of figma.root.children) if (isDraft(p)) return p;
  if (!create) return null;
  let page;
  try {
    page = figma.createPage();
  } catch (_e) {
    throw new OpError('page_limit', 'cannot add a page to this file');
  }
  page.name = DRAFTS_PAGE;
  page.setPluginData('jarvis', 'drafts');
  return page;
}
async function getNode(id) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.removed) throw new OpError('not_found', 'no such layer');
  return node;
}
/** The layer of a write: in the drafts page when the daemon decided N1, unchanged since read. */
async function writable(a) {
  const node = await getNode(a.node_id);
  if (node.type === 'PAGE' || node.type === 'DOCUMENT')
    throw new OpError('unsupported', 'not a layer');
  const page = pageOf(node);
  if (a.scope === 'draft' && !(page && isDraft(page)))
    throw new OpError('not_draft', 'the layer is not in the Jarvis drafts page');
  if (fingerprint(node) !== a.expect.fp)
    throw new OpError('stale', 'the layer changed since it was read');
  return node;
}
async function loadFonts(node) {
  if (node.hasMissingFont) throw new OpError('font', 'missing font');
  const fonts = node.characters.length
    ? node.getRangeAllFontNames(0, node.characters.length)
    : [node.fontName];
  for (const f of fonts) {
    if (f === figma.mixed) continue;
    try {
      await figma.loadFontAsync(f);
    } catch (_e) {
      throw new OpError('font', 'font not available');
    }
  }
}

// ── Read ──

function paints(list) {
  if (list === figma.mixed) return 'mixed';
  const out = [];
  for (let i = 0; i < list.length && i < 10; i++) {
    const p = list[i];
    const o = { type: p.type };
    if (p.visible === false) o.visible = false;
    if (p.type === 'SOLID') {
      o.hex = toHex(p.color);
      if (typeof p.opacity === 'number' && p.opacity < 1) o.opacity = round(p.opacity);
    } else if (p.type.indexOf('GRADIENT_') === 0) {
      o.stops = p.gradientStops
        .slice(0, 10)
        .map((s) => ({ hex: toHex(s.color, s.color.a), at: round(s.position) }));
    } else if (p.type === 'IMAGE') {
      o.scaleMode = p.scaleMode;
    }
    out.push(o);
  }
  return out;
}

function effects(list) {
  const out = [];
  for (let i = 0; i < list.length && i < 10; i++) {
    const e = list[i];
    const o = { type: e.type };
    if (e.visible === false) o.visible = false;
    if ('radius' in e) o.radius = round(e.radius);
    if ('color' in e) o.hex = toHex(e.color, e.color.a);
    if ('offset' in e) o.offset = [round(e.offset.x), round(e.offset.y)];
    if ('spread' in e && e.spread) o.spread = round(e.spread);
    out.push(o);
  }
  return out;
}

const metric = (v) => {
  if (v === figma.mixed) return 'mixed';
  if (v.unit === 'AUTO') return 'auto';
  return `${round(v.value)}${v.unit === 'PERCENT' ? '%' : 'px'}`;
};

function layoutOf(node, o) {
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    const l = {
      mode: node.layoutMode,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(num),
      gap: num(node.itemSpacing),
      align: node.primaryAxisAlignItems,
      crossAlign: node.counterAxisAlignItems,
      sizing: [node.primaryAxisSizingMode, node.counterAxisSizingMode],
    };
    if (node.layoutWrap === 'WRAP') {
      l.wrap = true;
      l.counterGap = num(node.counterAxisSpacing);
    }
    o.layout = l;
  }
  const parent = node.parent;
  if (
    'layoutSizingHorizontal' in node &&
    parent &&
    'layoutMode' in parent &&
    parent.layoutMode !== 'NONE'
  ) {
    o.sizing = { h: node.layoutSizingHorizontal, v: node.layoutSizingVertical };
    if (node.layoutPositioning === 'ABSOLUTE') o.absolute = true;
    if (node.layoutGrow) o.grow = node.layoutGrow;
  }
  if ('cornerRadius' in node) {
    if (node.cornerRadius === figma.mixed) {
      o.radius = [
        node.topLeftRadius,
        node.topRightRadius,
        node.bottomRightRadius,
        node.bottomLeftRadius,
      ].map(num);
    } else if (node.cornerRadius) {
      o.radius = round(node.cornerRadius);
    }
  }
  if ('clipsContent' in node && node.clipsContent) o.clips = true;
}

function textOf(node, o, ctx) {
  const chars = node.characters;
  const keep = Math.max(0, Math.min(LIMITS.textChars, ctx.text));
  o.characters = chars.length > keep ? `${chars.slice(0, keep)}…` : chars;
  ctx.text -= Math.min(chars.length, keep);
  const font = node.fontName;
  const t = {
    size: num(node.fontSize),
    font: font === figma.mixed ? 'mixed' : { family: font.family, style: font.style },
    weight: num(node.fontWeight),
    lineHeight: metric(node.lineHeight),
    letterSpacing: metric(node.letterSpacing),
    align: node.textAlignHorizontal,
    autoResize: node.textAutoResize,
  };
  if (node.textCase !== 'ORIGINAL')
    t.case = node.textCase === figma.mixed ? 'mixed' : node.textCase;
  if (node.textDecoration !== 'NONE')
    t.decoration = node.textDecoration === figma.mixed ? 'mixed' : node.textDecoration;
  o.text = t;
}

async function variableName(id, ctx) {
  if (ctx.vars.has(id)) return ctx.vars.get(id);
  const v = await figma.variables.getVariableByIdAsync(id);
  const name = v ? clip(v.name, 200) : 'unknown';
  ctx.vars.set(id, name);
  return name;
}

async function boundOf(node, o, ctx) {
  const b = node.boundVariables;
  if (!isObj(b)) return;
  const out = {};
  let n = 0;
  for (const field of Object.keys(b)) {
    if (n >= 30) break;
    const v = b[field];
    if (Array.isArray(v)) {
      const names = [];
      for (const alias of v.slice(0, 10)) {
        if (isObj(alias) && typeof alias.id === 'string')
          names.push(await variableName(alias.id, ctx));
      }
      if (names.length) out[field] = names;
    } else if (isObj(v) && typeof v.id === 'string') {
      out[field] = await variableName(v.id, ctx);
    } else {
      continue;
    }
    n++;
  }
  if (n) o.bound = out;
}

async function stylesOf(node, o, ctx) {
  const keys = {
    fill: 'fillStyleId',
    stroke: 'strokeStyleId',
    effect: 'effectStyleId',
    text: 'textStyleId',
  };
  const out = {};
  let n = 0;
  for (const k of Object.keys(keys)) {
    if (!(keys[k] in node)) continue;
    const id = node[keys[k]];
    if (id === figma.mixed) {
      out[k] = 'mixed';
      n++;
      continue;
    }
    if (typeof id !== 'string' || !id) continue;
    if (!ctx.styles.has(id)) {
      const style = await figma.getStyleByIdAsync(id);
      ctx.styles.set(id, style ? clip(style.name, 200) : 'unknown');
    }
    out[k] = ctx.styles.get(id);
    n++;
  }
  if (n) o.styles = out;
}

const parentType = (node) => (node.parent ? node.parent.type : null);

async function componentOf(node, o) {
  if (node.type === 'INSTANCE') {
    const c = {};
    const main = await node.getMainComponentAsync();
    if (main) {
      c.main = clip(main.name, 200);
      if (parentType(main) === 'COMPONENT_SET') c.set = clip(main.parent.name, 200);
    }
    const props = node.componentProperties;
    if (isObj(props)) {
      const p = {};
      for (const k of Object.keys(props).slice(0, 40)) {
        const v = props[k].value;
        p[clip(k, 100)] = typeof v === 'string' ? clip(v, 200) : v;
      }
      c.properties = p;
    }
    o.component = c;
  }
  if (
    node.type === 'COMPONENT_SET' ||
    (node.type === 'COMPONENT' && parentType(node) !== 'COMPONENT_SET')
  ) {
    try {
      const defs = node.componentPropertyDefinitions;
      const p = {};
      for (const k of Object.keys(defs).slice(0, 40)) {
        const d = defs[k];
        const e = { type: d.type, default: d.defaultValue };
        if (d.variantOptions) e.options = d.variantOptions.slice(0, 30);
        p[clip(k, 100)] = e;
      }
      o.properties = p;
    } catch (_e) {
      // Not readable on this kind of component: the rest of the layer still is.
    }
  }
}

async function serialize(node, depth, ctx) {
  if (ctx.count >= ctx.max) {
    ctx.truncated = true;
    return null;
  }
  ctx.count++;
  const o = brief(node);
  if (node.visible === false) o.visible = false;
  if ('x' in node) {
    o.x = round(node.x);
    o.y = round(node.y);
  }
  if ('width' in node) {
    o.width = round(node.width);
    o.height = round(node.height);
  }
  if (node.rotation) o.rotation = round(node.rotation);
  if ('opacity' in node && node.opacity !== 1) o.opacity = round(node.opacity);
  layoutOf(node, o);
  if ('fills' in node) {
    const f = paints(node.fills);
    if (f.length) o.fills = f;
  }
  if ('strokes' in node) {
    const s = paints(node.strokes);
    if (s.length) {
      o.strokes = s;
      o.strokeWeight = num(node.strokeWeight);
    }
  }
  if ('effects' in node) {
    const e = effects(node.effects);
    if (e.length) o.effects = e;
  }
  if (node.type === 'TEXT') textOf(node, o, ctx);
  await boundOf(node, o, ctx);
  await stylesOf(node, o, ctx);
  await componentOf(node, o);
  if ('children' in node && node.children.length) {
    if (depth >= ctx.depth) {
      o.childCount = node.children.length;
      ctx.truncated = true;
    } else {
      const kids = [];
      for (const c of node.children) {
        const s = await serialize(c, depth + 1, ctx);
        if (!s) break;
        kids.push(s);
      }
      if (kids.length) o.children = kids;
      if (kids.length < node.children.length) o.childCount = node.children.length;
    }
  }
  return o;
}

// ── The catalogue ──

/** After a write: one undo step per Jarvis action (⌘Z undoes exactly it), and a visible note. */
function done(what) {
  figma.commitUndo();
  figma.notify(`Jarvis : ${what}`);
}

async function opStatus() {
  const page = figma.currentPage;
  const sel = page.selection;
  const drafts = await draftsPage(false);
  return {
    file: clip(figma.root.name, 500),
    editor: String(figma.editorType),
    page: { id: page.id, name: clip(page.name, 500), drafts: isDraft(page) },
    selection: sel.length,
    nodes: sel.slice(0, 20).map((n) => ({ id: n.id, name: clip(n.name, 500), type: n.type })),
    drafts: drafts ? { id: drafts.id, name: clip(drafts.name, 500) } : null,
  };
}

async function opRead(a) {
  let page;
  let roots;
  if (a.node_id) {
    const node = await getNode(a.node_id);
    if (node.type === 'PAGE' || node.type === 'DOCUMENT')
      throw new OpError('unsupported', 'not a layer');
    page = pageOf(node);
    roots = [node];
  } else {
    page = figma.currentPage;
    roots = page.selection.slice();
    if (!roots.length) throw new OpError('no_selection', 'nothing selected');
  }
  if (!page) throw new OpError('unsupported', 'layer outside a page');
  const ctx = {
    count: 0,
    max: a.max_nodes,
    depth: a.depth,
    truncated: false,
    text: LIMITS.textBudget,
    vars: new Map(),
    styles: new Map(),
  };
  const nodes = [];
  for (const r of roots) {
    const s = await serialize(r, 1, ctx);
    if (!s) break;
    nodes.push(s);
  }
  return {
    page: { id: page.id, name: clip(page.name, 500) },
    inDrafts: isDraft(page),
    count: ctx.count,
    truncated: ctx.truncated,
    nodes,
  };
}

async function opVariables() {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const vars = await figma.variables.getLocalVariablesAsync();
  if (cols.length > LIMITS.collections || vars.length > LIMITS.variables)
    throw new OpError('too_large', 'too many variables');
  const local = new Set(vars.map((v) => v.id));
  const remoteIds = [];
  const value = (x) => {
    if (isObj(x) && x.type === 'VARIABLE_ALIAS') {
      if (!local.has(x.id) && remoteIds.indexOf(x.id) < 0 && remoteIds.length < 200)
        remoteIds.push(x.id);
      return { alias: x.id };
    }
    if (isObj(x)) return { r: x.r, g: x.g, b: x.b, a: typeof x.a === 'number' ? x.a : 1 };
    return typeof x === 'string' ? clip(x, 5000) : x;
  };
  const variables = vars.map((v) => {
    const values = {};
    for (const m of Object.keys(v.valuesByMode)) values[m] = value(v.valuesByMode[m]);
    const o = {
      id: v.id,
      name: clip(v.name, 500),
      collectionId: v.variableCollectionId,
      type: v.resolvedType,
      scopes: v.scopes.slice(0, 40),
      values,
    };
    if (v.description) o.description = clip(v.description, 2000);
    const syntax = v.codeSyntax;
    if (isObj(syntax) && Object.keys(syntax).length) {
      o.codeSyntax = {};
      for (const k of Object.keys(syntax)) o.codeSyntax[clip(k, 20)] = clip(String(syntax[k]), 500);
    }
    return o;
  });
  const remote = [];
  for (const id of remoteIds) {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (!v) continue;
    const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    remote.push({ id, name: clip(v.name, 500), collection: c ? clip(c.name, 500) : 'library' });
  }
  return {
    collections: cols.map((c) => ({
      id: c.id,
      name: clip(c.name, 500),
      defaultModeId: c.defaultModeId,
      modes: c.modes.slice(0, 40).map((m) => ({ modeId: m.modeId, name: clip(m.name, 200) })),
    })),
    variables,
    remote,
  };
}

async function opExport(a) {
  let node;
  if (a.node_id) {
    node = await getNode(a.node_id);
  } else {
    const sel = figma.currentPage.selection;
    if (!sel.length) throw new OpError('no_selection', 'nothing selected');
    node = sel[0];
  }
  if (node.type === 'PAGE' || node.type === 'DOCUMENT' || typeof node.exportAsync !== 'function')
    throw new OpError('unsupported', 'cannot export this layer');
  const side = Math.max(node.width, node.height);
  if (!(side > 0)) throw new OpError('unsupported', 'empty layer');
  const scale = Math.max(
    0.01,
    Math.floor(Math.min(a.scale, LIMITS.exportMaxSide / side) * 1000) / 1000,
  );
  const bytes = await node.exportAsync({
    format: 'PNG',
    constraint: { type: 'SCALE', value: scale },
  });
  if (bytes.length > LIMITS.exportMaxBytes) throw new OpError('too_large', 'export too large');
  return {
    id: node.id,
    name: clip(node.name, 500),
    type: node.type,
    width: Math.max(1, Math.min(LIMITS.exportMaxSide, Math.round(node.width * scale))),
    height: Math.max(1, Math.min(LIMITS.exportMaxSide, Math.round(node.height * scale))),
    scale,
    png: figma.base64Encode(bytes),
  };
}

const ALIGN = { start: 'MIN', center: 'CENTER', end: 'MAX', space_between: 'SPACE_BETWEEN' };
const CROSS = { start: 'MIN', center: 'CENTER', end: 'MAX' };
const TEXT_ALIGN = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' };

async function loadFont(family, style, state) {
  const wanted = { family, style };
  try {
    await figma.loadFontAsync(wanted);
    return wanted;
  } catch (_e) {
    state.fallbacks++;
    const inter = { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(inter);
    return inter;
  }
}

/** Builds one spec layer inside `parent` (the drafts page for the root): never anywhere else. */
async function build(s, parent, state) {
  let node;
  if (s.type === 'frame') {
    node = figma.createFrame();
    state.created.push(node);
    parent.appendChild(node);
    node.name = s.name || 'Frame';
    node.layoutMode = s.direction === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL';
    const p = s.padding;
    const pad = isObj(p) ? p : { top: p, right: p, bottom: p, left: p };
    node.paddingTop = pad.top || 0;
    node.paddingRight = pad.right || 0;
    node.paddingBottom = pad.bottom || 0;
    node.paddingLeft = pad.left || 0;
    node.itemSpacing = s.gap || 0;
    node.primaryAxisAlignItems = ALIGN[s.align || 'start'];
    node.counterAxisAlignItems = CROSS[s.cross_align || 'start'];
    const horizontal = node.layoutMode === 'HORIZONTAL';
    if (s.width !== undefined || s.height !== undefined)
      node.resize(s.width || node.width, s.height || node.height);
    node.primaryAxisSizingMode = (horizontal ? s.width : s.height) !== undefined ? 'FIXED' : 'AUTO';
    node.counterAxisSizingMode = (horizontal ? s.height : s.width) !== undefined ? 'FIXED' : 'AUTO';
    node.fills = s.fill ? [solid(s.fill)] : [];
    if (s.radius) node.cornerRadius = s.radius;
    for (const c of s.children || []) await build(c, node, state);
  } else if (s.type === 'text') {
    const font = await loadFont(s.font || 'Inter', s.style || 'Regular', state);
    node = figma.createText();
    state.created.push(node);
    parent.appendChild(node);
    node.fontName = font;
    node.characters = s.text;
    if (s.name) node.name = s.name;
    if (s.size) node.fontSize = s.size;
    if (s.color) node.fills = [solid(s.color)];
    if (s.align) node.textAlignHorizontal = TEXT_ALIGN[s.align];
  } else {
    node = figma.createRectangle();
    state.created.push(node);
    parent.appendChild(node);
    node.name = s.name || 'Rectangle';
    node.resize(s.width, s.height);
    if (s.fill) node.fills = [solid(s.fill)];
    if (s.radius) node.cornerRadius = s.radius;
  }
  if (s.fill_width && 'layoutMode' in parent && parent.layoutMode !== 'NONE') {
    node.layoutSizingHorizontal = 'FILL';
    if (s.type === 'text') node.textAutoResize = 'HEIGHT';
  }
  return node;
}

async function opCreateFrame(a) {
  const page = await draftsPage(true);
  await page.loadAsync();
  // New text layers start in Inter Regular: it must be loaded before any text is set.
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  let right = null;
  for (const c of page.children)
    right = Math.max(right === null ? c.x + c.width : right, c.x + c.width);
  const state = { created: [], fallbacks: 0 };
  let root;
  try {
    root = await build(a.spec, page, state);
  } catch (e) {
    // Never leave half a frame behind (a failed layer may still sit in the current page).
    for (const n of state.created) if (!n.removed) n.remove();
    throw e;
  }
  root.x = right === null ? 0 : right + 80;
  root.y = 0;
  done(`« ${clip(root.name, 40)} » créé dans la page ${DRAFTS_PAGE}`);
  return {
    page: { id: page.id, name: clip(page.name, 500) },
    root: root.id,
    nodes: state.created.map(brief),
    fontFallbacks: state.fallbacks,
  };
}

async function opSetText(a) {
  const node = await writable(a);
  if (node.type !== 'TEXT') throw new OpError('unsupported', 'not a text layer');
  await loadFonts(node);
  node.characters = a.text;
  done(`texte de « ${clip(node.name, 40)} » modifié`);
  return brief(node);
}

async function opRename(a) {
  const node = await writable(a);
  node.name = a.name;
  done(`calque renommé « ${clip(a.name, 40)} »`);
  return brief(node);
}

function fieldType(field) {
  if (field === 'fill' || field === 'stroke') return 'COLOR';
  if (field === 'visible') return 'BOOLEAN';
  if (field === 'characters' || field === 'fontFamily' || field === 'fontStyle') return 'STRING';
  return 'FLOAT';
}

async function findVariable(name, collection) {
  const vars = await figma.variables.getLocalVariablesAsync();
  let matches = vars.filter((v) => v.name === name);
  if (collection) {
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    const ids = cols.filter((c) => c.name === collection).map((c) => c.id);
    matches = matches.filter((v) => ids.indexOf(v.variableCollectionId) >= 0);
  }
  const where = collection ? ` in collection "${clip(collection, 60)}"` : '';
  if (!matches.length)
    throw new OpError('variable', `no local variable "${clip(name, 80)}"${where}`);
  if (matches.length > 1)
    throw new OpError('variable', `several variables "${clip(name, 80)}": give the collection`);
  return matches[0];
}

async function opBind(a) {
  const node = await writable(a);
  const variable = await findVariable(a.variable, a.collection);
  const need = fieldType(a.field);
  if (variable.resolvedType !== need)
    throw new OpError(
      'variable',
      `"${clip(a.variable, 80)}" is ${variable.resolvedType}, ${a.field} needs ${need}`,
    );
  if (a.field === 'fill' || a.field === 'stroke') {
    const key = a.field === 'fill' ? 'fills' : 'strokes';
    if (!(key in node) || node[key] === figma.mixed)
      throw new OpError('unsupported', 'no paint to bind');
    const list = node[key].slice();
    const i = a.paint_index || 0;
    if (i >= list.length || list[i].type !== 'SOLID')
      throw new OpError('unsupported', 'that paint is not a solid colour');
    list[i] = figma.variables.setBoundVariableForPaint(list[i], 'color', variable);
    node[key] = list;
  } else if (TEXT_FIELDS.indexOf(a.field) >= 0) {
    if (node.type !== 'TEXT' || !node.characters.length)
      throw new OpError('unsupported', 'not a text layer');
    await loadFonts(node);
    node.setRangeBoundVariable(0, node.characters.length, a.field, variable);
  } else {
    if (typeof node.setBoundVariable !== 'function')
      throw new OpError('unsupported', 'this layer has no bindable properties');
    if (a.field === 'characters') {
      if (node.type !== 'TEXT') throw new OpError('unsupported', 'not a text layer');
      await loadFonts(node);
    }
    node.setBoundVariable(a.field, variable);
  }
  done(`variable « ${clip(a.variable, 40)} » liée`);
  return brief(node);
}

async function opComponent(a) {
  const node = await writable(a);
  if (NOT_COMPONENTABLE.indexOf(node.type) >= 0 || node.id.charAt(0) === 'I')
    throw new OpError('unsupported', 'cannot become a component');
  const component = figma.createComponentFromNode(node);
  if (a.name) component.name = a.name;
  done(`composant « ${clip(component.name, 40)} » créé`);
  return brief(component);
}

function dispatch(kind, a) {
  switch (kind) {
    case 'status':
      return opStatus();
    case 'read':
      return opRead(a);
    case 'variables':
      return opVariables();
    case 'export_png':
      return opExport(a);
    case 'create_frame':
      return opCreateFrame(a);
    case 'set_text':
      return opSetText(a);
    case 'rename':
      return opRename(a);
    case 'bind_variable':
      return opBind(a);
    case 'create_component':
      return opComponent(a);
    default:
      throw new OpError('invalid', 'unknown operation');
  }
}

/** One operation from ui.html → one result for jarvisd. */
async function run(op) {
  // Echo any string id so ui.html is never left waiting; validateOp still requires a UUID.
  const id = isObj(op) && typeof op.id === 'string' ? clip(op.id, 100) : null;
  if (id === null) return { type: 'result', id, ok: false, code: 'invalid', error: 'malformed' };
  const problem = validateOp(op);
  if (problem) return { type: 'result', id, ok: false, code: problem.code, error: problem.message };
  try {
    const result = await dispatch(op.kind, op.args);
    return { type: 'result', id, ok: true, result };
  } catch (e) {
    if (e instanceof OpError)
      return { type: 'result', id, ok: false, code: e.code, error: e.message };
    const message = e instanceof Error ? e.message : String(e);
    return { type: 'result', id, ok: false, code: 'error', error: clip(message, 300) };
  }
}

figma.showUI(__html__, { width: 300, height: 300, themeColors: true });

figma.ui.onmessage = (msg) => {
  if (!isObj(msg)) return;
  if (msg.type === 'load-token') {
    figma.clientStorage.getAsync('jarvis-token').then((token) => {
      figma.ui.postMessage({
        type: 'init',
        token: typeof token === 'string' ? token : '',
        file: clip(figma.root.name, 200),
      });
    });
  } else if (msg.type === 'save-token') {
    if (typeof msg.token === 'string' && msg.token.length <= 200)
      figma.clientStorage.setAsync('jarvis-token', msg.token);
  } else if (msg.type === 'op') {
    run(msg.op).then((r) => figma.ui.postMessage(r));
  }
};
