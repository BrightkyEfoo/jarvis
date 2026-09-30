import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { type Classification, forbid, N0, N1, N3 } from './levels.ts';
import { expandHome } from './load.ts';

export type FsMode = 'read' | 'write' | 'delete';

/** Credential stores and Jarvis' own state. Hardcoded: policy.yaml can add, never remove. */
const BUILTIN_DENY_PATHS = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.azure',
  '~/.kube',
  '~/.docker',
  '~/.config/gh',
  '~/.config/gcloud',
  '~/.password-store',
  '~/.claude',
  '~/.claude.json',
  '~/.npmrc',
  '~/.netrc',
  '~/.pypirc',
  '~/.git-credentials',
  '~/Library/Keychains',
  '~/Library/Cookies',
  '~/Library/Messages',
  '~/Library/Mail',
  '~/Library/Application Support/Jarvis',
  '/Library/Application Support/Jarvis',
  '/Library/Keychains',
  '/etc',
  '/private/etc',
  '/System',
];

/** Matched against every path segment, case-insensitively. */
const BUILTIN_DENY_NAMES = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.kdbx',
  '*.keychain',
  '*.keychain-db',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'service-account*.json',
];

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

const DENY_NAME_RES = BUILTIN_DENY_NAMES.map(globToRegExp);

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

export class PathError extends Error {
  override name = 'PathError';
}

export interface FsPolicyOptions {
  home: string;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  extraDeny: readonly string[];
}

export type PathCheck = Classification & { path: string };

/**
 * Resolves a path the way the kernel will see it (symlinks followed, `..` collapsed), then
 * decides. APFS is case-insensitive by default, so every comparison is lowercased.
 */
export class FsPolicy {
  readonly #home: string;
  readonly #readRoots: string[];
  readonly #writeRoots: string[];
  readonly #deny: string[];

  constructor(opts: FsPolicyOptions) {
    this.#home = opts.home;
    const norm = (p: string) => this.#canonical(expandHome(p, opts.home)).toLowerCase();
    this.#writeRoots = opts.writeRoots.map(norm);
    this.#readRoots = [...opts.readRoots.map(norm), ...this.#writeRoots];
    this.#deny = [...BUILTIN_DENY_PATHS, ...opts.extraDeny].map(norm);
  }

  /** Real path of the deepest existing ancestor, plus the not-yet-existing remainder. */
  #canonical(abs: string): string {
    const rest: string[] = [];
    let cur = abs;
    for (;;) {
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (st) {
        let real: string;
        try {
          real = realpathSync.native(cur);
        } catch {
          throw new PathError(`dangling symlink: ${cur}`);
        }
        return rest.length > 0 ? join(real, ...rest) : real;
      }
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }

  resolve(input: string, cwd: string): string {
    if (input.includes('\0')) throw new PathError('NUL byte in path');
    if (/^~[^/]/.test(input)) throw new PathError('~user paths are not supported');
    return this.#canonical(resolve(cwd, expandHome(input, this.#home)));
  }

  check(input: string, mode: FsMode, cwd: string): PathCheck {
    let path: string;
    try {
      path = this.resolve(input, cwd);
    } catch (e) {
      return { ...forbid('fs.invalid_path', (e as Error).message), path: input };
    }
    const lower = path.toLowerCase();
    const segments = lower.split('/').filter(Boolean);

    if (this.#deny.some((d) => isUnder(lower, d))) {
      return { ...forbid('fs.deny.protected', `${path} is a protected location`), path };
    }
    if (segments.some((s) => DENY_NAME_RES.some((re) => re.test(s)))) {
      return { ...forbid('fs.deny.secret_file', `${path} looks like a secret file`), path };
    }
    if (mode !== 'read' && segments.includes('.git')) {
      // Writing .git/hooks or .git/config would turn the next git command into code execution.
      return {
        ...forbid('fs.deny.git_internals', 'git internals are only changed through git'),
        path,
      };
    }

    switch (mode) {
      case 'read':
        return this.#readRoots.some((r) => isUnder(lower, r))
          ? { level: N0, rule: 'fs.read.root', reason: 'inside an allowed root', path }
          : { ...forbid('fs.outside_roots', `${path} is outside the allowed folders`), path };
      case 'write':
        return this.#writeRoots.some((r) => isUnder(lower, r))
          ? { level: N1, rule: 'fs.write.root', reason: 'inside the workspace', path }
          : {
              ...forbid('fs.outside_write_roots', `${path} is outside the writable workspace`),
              path,
            };
      case 'delete':
        if (this.#writeRoots.includes(lower)) {
          return { ...forbid('fs.deny.root', 'refusing to delete a workspace root'), path };
        }
        return this.#writeRoots.some((r) => isUnder(lower, r))
          ? { level: N3, rule: 'fs.trash.root', reason: 'moves to the Trash', path }
          : {
              ...forbid('fs.outside_write_roots', `${path} is outside the writable workspace`),
              path,
            };
    }
  }
}
