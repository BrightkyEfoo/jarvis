import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { type PolicyFile, PolicySchema } from './schema.ts';

/** Production location: a root-owned directory the jarvis user cannot write to. */
export const SEALED_POLICY_PATH = '/Library/Application Support/Jarvis/policy.yaml';

export class PolicyIntegrityError extends Error {
  override name = 'PolicyIntegrityError';
}

export interface Policy extends PolicyFile {
  readonly sha256: string;
  readonly path: string;
  readonly sealed: boolean;
}

export interface LoadPolicyOptions {
  path: string;
  /** SHA-256 recorded at seal time (read from the Keychain). Null = not sealed. */
  expectedSha256: string | null;
  /** Production: file and parent dir must be root-owned and not group/world writable. */
  requireSealed: boolean;
  home?: string;
}

export const sha256 = (buf: Buffer | string): string =>
  createHash('sha256').update(buf).digest('hex');

function assertRootOwned(path: string): void {
  for (const p of [path, dirname(path)]) {
    const st = statSync(p);
    if (st.uid !== 0) throw new PolicyIntegrityError(`${p} must be owned by root (seal it first)`);
    if (st.mode & 0o022) throw new PolicyIntegrityError(`${p} must not be group/world writable`);
  }
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return resolve(home, p.slice(2));
  return p;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export function loadPolicy(opts: LoadPolicyOptions): Policy {
  const home = opts.home ?? homedir();
  if (opts.requireSealed) assertRootOwned(opts.path);

  const raw = readFileSync(opts.path);
  const digest = sha256(raw);
  if (opts.requireSealed && !opts.expectedSha256) {
    throw new PolicyIntegrityError(
      'no sealed hash in the Keychain: run ops/scripts/seal-policy.sh',
    );
  }
  if (opts.expectedSha256 && digest !== opts.expectedSha256) {
    throw new PolicyIntegrityError(
      `policy.yaml hash ${digest.slice(0, 12)}… does not match the sealed hash ${opts.expectedSha256.slice(0, 12)}…`,
    );
  }

  const doc = parse(raw.toString('utf8'), { uniqueKeys: true, maxAliasCount: 0 });
  const parsed = PolicySchema.parse(doc);
  const fs = parsed.filesystem;
  const policy: Policy = {
    ...parsed,
    filesystem: {
      read_roots: fs.read_roots.map((p) => expandHome(p, home)),
      write_roots: fs.write_roots.map((p) => expandHome(p, home)),
      deny: fs.deny.map((p) => expandHome(p, home)),
    },
    sha256: digest,
    path: opts.path,
    sealed: opts.requireSealed,
  };
  return deepFreeze(policy);
}
