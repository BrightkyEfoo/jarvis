import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';

// tree-sitter ships CommonJS native bindings.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as typeof Parser;
const Bash = require('tree-sitter-bash') as Parser.Language;

const parser = new TreeSitter();
parser.setLanguage(Bash);

type Node = Parser.SyntaxNode;

export interface Redirect {
  fd: number;
  op: '>' | '>>' | '<' | 'dup';
  /** File path for > >> <; empty for dup. */
  target: string;
  /** For `2>&1`: the fd being duplicated. */
  dupFd?: number;
}

export interface SimpleCommand {
  argv: string[];
  redirects: Redirect[];
}

export interface Pipeline {
  commands: SimpleCommand[];
}

export type Connector = '&&' | '||' | ';';

export interface Step {
  pipeline: Pipeline;
  /** How the next step is chained to this one; null for the last step. */
  next: Connector | null;
}

export interface ShellPlan {
  source: string;
  steps: Step[];
}

export class ShellParseError extends Error {
  override name = 'ShellParseError';
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.rule = rule;
  }
}

const MAX_SOURCE = 4096;
const MAX_STEPS = 16;

const unsupported = (what: string, detail = ''): ShellParseError =>
  new ShellParseError(
    `shell.unsupported.${what}`,
    `unsupported shell construct: ${what}${detail ? ` (${detail})` : ''}`,
  );

// Anything that would make the shell (which we never run) expand or execute something.
const FORBIDDEN_IN_BARE_WORD = /[\\$`*?[\]{}]/;

function bareWord(text: string, home: string, allowTilde: boolean): string {
  if (FORBIDDEN_IN_BARE_WORD.test(text)) {
    throw unsupported('expansion_or_glob', text);
  }
  if (allowTilde && text.startsWith('~')) {
    if (text === '~') return home;
    if (text.startsWith('~/')) return home + text.slice(1);
    throw unsupported('tilde_user', text);
  }
  return text;
}

function wordValue(node: Node, home: string, first = true): string {
  switch (node.type) {
    case 'word':
    case 'number':
      return bareWord(node.text, home, first);
    case 'raw_string':
      return node.text.slice(1, -1);
    case 'string': {
      let out = '';
      for (const c of node.namedChildren) {
        if (c.type !== 'string_content') throw unsupported(c.type, 'inside double quotes');
        if (/[\\$`]/.test(c.text)) throw unsupported('escape_in_string', c.text);
        out += c.text;
      }
      return out;
    }
    case 'concatenation':
      return node.namedChildren.map((c, i) => wordValue(c, home, first && i === 0)).join('');
    default:
      throw unsupported(node.type);
  }
}

function parseRedirect(node: Node, home: string): Redirect {
  if (node.type !== 'file_redirect') throw unsupported(node.type);
  let fd: number | null = null;
  let op: string | null = null;
  let dest: Node | null = null;
  for (const c of node.children) {
    if (c.type === 'file_descriptor') fd = Number(c.text);
    else if (!c.isNamed) op = c.type;
    else dest = c;
  }
  if (!dest || !op) throw unsupported('redirect', node.text);

  if (op === '>&') {
    // Only 2>&1 is supported: merging stderr into stdout.
    if ((fd ?? 1) === 2 && dest.text === '1') return { fd: 2, op: 'dup', target: '', dupFd: 1 };
    throw unsupported('fd_duplication', node.text);
  }
  if (op !== '>' && op !== '>>' && op !== '<') throw unsupported('redirect_operator', op);
  const target = wordValue(dest, home);
  return { fd: fd ?? (op === '<' ? 0 : 1), op, target };
}

function parseCommand(node: Node, redirects: Redirect[], home: string): SimpleCommand {
  const argv: string[] = [];
  for (const c of node.namedChildren) {
    if (c.type === 'command_name') {
      const inner = c.namedChildren;
      if (inner.length !== 1 || !inner[0]) throw unsupported('command_name', c.text);
      argv.push(wordValue(inner[0], home));
    } else if (c.type === 'file_redirect') {
      redirects.push(parseRedirect(c, home));
    } else if (c.type === 'variable_assignment') {
      throw unsupported('env_assignment', c.text);
    } else {
      argv.push(wordValue(c, home));
    }
  }
  if (argv.length === 0) throw unsupported('empty_command');
  return { argv, redirects };
}

function parseStatement(node: Node, home: string): SimpleCommand {
  if (node.type === 'command') return parseCommand(node, [], home);
  if (node.type === 'redirected_statement') {
    const body = node.childForFieldName('body');
    // tree-sitter attaches a trailing redirect to a whole list/pipeline, unlike bash.
    // Refuse rather than guess which command it applies to.
    if (body?.type !== 'command') throw unsupported('redirect_on_compound', node.text);
    const redirects = node.childrenForFieldName('redirect').map((r) => parseRedirect(r, home));
    return parseCommand(body, redirects, home);
  }
  throw unsupported(node.type);
}

function parsePipeline(node: Node, home: string): Pipeline {
  if (node.type !== 'pipeline') return { commands: [parseStatement(node, home)] };
  const commands: SimpleCommand[] = [];
  for (const c of node.children) {
    if (c.isNamed) commands.push(parseStatement(c, home));
    else if (c.type !== '|') throw unsupported('pipe_operator', c.type);
  }
  return { commands };
}

function flatten(node: Node, steps: Step[], home: string): void {
  if (node.type !== 'list') {
    steps.push({ pipeline: parsePipeline(node, home), next: null });
    return;
  }
  for (const c of node.children) {
    if (c.isNamed) {
      flatten(c, steps, home);
    } else if (c.type === '&&' || c.type === '||') {
      const last = steps.at(-1);
      if (!last) throw unsupported('list');
      last.next = c.type;
    } else {
      throw unsupported('list_operator', c.type);
    }
  }
}

/**
 * Turns a command line into an explicit execution plan, or throws. Only a small, fully
 * understood subset of bash is accepted: simple commands, pipes, && || ;, file redirects,
 * quotes. Everything that would require a real shell to interpret is refused.
 */
export function parseShell(source: string, home: string): ShellPlan {
  if (source.length > MAX_SOURCE) throw unsupported('too_long', `${source.length} chars`);
  if (source.includes('\0')) throw unsupported('nul_byte');

  const tree = parser.parse(source);
  const root = tree.rootNode;
  if (root.hasError)
    throw new ShellParseError('shell.syntax_error', 'command does not parse cleanly');

  const steps: Step[] = [];
  for (const c of root.children) {
    if (c.isNamed) {
      if (c.type === 'comment') throw unsupported('comment');
      flatten(c, steps, home);
    } else if (c.type === ';' || c.type === '\n') {
      const last = steps.at(-1);
      if (last) last.next = ';';
    } else if (c.type === '&') {
      throw unsupported('background_job');
    } else {
      throw unsupported('program_token', c.type);
    }
  }
  const last = steps.at(-1);
  if (!last) throw unsupported('empty');
  last.next = null;
  if (steps.length > MAX_STEPS) throw unsupported('too_many_steps', String(steps.length));
  return { source, steps };
}
