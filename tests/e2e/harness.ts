import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashPin, sha256 } from '@jarvis/policy';
import { MemoryStore, SecretName } from '@jarvis/secrets';
import { createRuntime, type Runtime } from '../../apps/jarvisd/src/daemon/runtime.ts';
import { startServer } from '../../apps/jarvisd/src/daemon/server.ts';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import type { Request } from '../../apps/jarvisd/src/ipc-schema.ts';
import { appPaths } from '../../apps/jarvisd/src/paths.ts';
import { ScriptedBrain } from './scripted-brain.ts';

export const EXAMPLE_POLICY = resolve(import.meta.dirname, '../../config/policy.example.yaml');
export const PIN = '482915';
export const CANARY_TOKEN = 'sk-ant-oat01-CANARYcanaryCANARY0123456789';

export interface Harness {
  home: string;
  work: string;
  rt: Runtime;
  server: Server;
  socket: string;
  rpc: () => Promise<Rpc>;
  close: () => Promise<void>;
}

/** A request without its id, keeping each variant of the union distinct. */
type Outgoing = Request extends infer R
  ? R extends { id: string }
    ? Omit<R, 'id'>
    : never
  : never;

export interface Rpc {
  /** Sends a request; resolves with the final reply and every event received before it. */
  call(req: Outgoing, onEvent?: (r: Reply) => void): Promise<{ final: Reply; events: Reply[] }>;
  raw(line: string): Promise<Reply>;
  close(): void;
}

export async function startHarness(opts: { devMode?: boolean } = {}): Promise<Harness> {
  // Short root: macOS caps Unix socket paths at 104 bytes.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'jv-')));
  const home = join(base, 'h');
  const work = join(home, 'jarvis-work');
  mkdirSync(work, { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY');
  writeFileSync(join(work, 'notes.md'), `# notes\ntoken: ${CANARY_TOKEN}\n`);
  writeFileSync(join(work, 'draft.txt'), 'draft');
  symlinkSync(join(home, '.ssh'), join(work, 'shortcut'));

  const secrets = new MemoryStore();
  secrets.set(SecretName.pinHash, hashPin(PIN));
  secrets.set(SecretName.claudeOauthToken, CANARY_TOKEN);
  secrets.set(SecretName.policySha256, sha256(readFileSync(EXAMPLE_POLICY)));

  const paths = appPaths(join(base, 'j'));
  const rt = createRuntime({
    paths,
    home,
    policyPath: EXAMPLE_POLICY,
    secrets,
    devMode: opts.devMode ?? false,
    requireSealed: false,
    brainFactory: (ctx) => new ScriptedBrain(ctx.gate),
  });
  const server = await startServer(rt, paths.socket);

  const rpc = async (): Promise<Rpc> => {
    const s = connect(paths.socket);
    await new Promise<void>((r, j) => {
      s.once('connect', () => r());
      s.once('error', j);
    });
    const waiting = new Map<
      string,
      {
        events: Reply[];
        onEvent?: ((r: Reply) => void) | undefined;
        done: (x: { final: Reply; events: Reply[] }) => void;
      }
    >();
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const r = JSON.parse(buf.slice(0, nl)) as Reply;
        buf = buf.slice(nl + 1);
        const w = waiting.get(r.id);
        if (!w) continue;
        if (r.type === 'done' || r.type === 'error') {
          waiting.delete(r.id);
          w.done({ final: r, events: w.events });
        } else {
          w.events.push(r);
          w.onEvent?.(r);
        }
      }
    });
    return {
      call: (req, onEvent) =>
        new Promise((done) => {
          const id = randomUUID().slice(0, 8);
          waiting.set(id, { events: [], onEvent, done });
          s.write(`${JSON.stringify({ ...req, id })}\n`);
        }),
      raw: (line) =>
        new Promise((done) => {
          waiting.set('unknown', { events: [], done: (x) => done(x.final) });
          s.write(`${line}\n`);
        }),
      close: () => s.end(),
    };
  };

  return {
    home,
    work,
    rt,
    server,
    socket: paths.socket,
    rpc,
    close: async () => {
      server.close();
      await rt.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
