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
import type {
  CalendarEvent,
  CalendarProvider,
  Draft,
  DraftInput,
  ListOptions,
  MailHeader,
  MailMessage,
  MailProvider,
} from '@jarvis/connectors';
import { hashPin, sha256 } from '@jarvis/policy';
import { MemoryStore, SecretName } from '@jarvis/secrets';
import type { ActuatorAction } from '../../apps/jarvisd/src/computer/bridge.ts';
import { createRuntime, type Runtime } from '../../apps/jarvisd/src/daemon/runtime.ts';
import { startServer } from '../../apps/jarvisd/src/daemon/server.ts';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import type { Request } from '../../apps/jarvisd/src/ipc-schema.ts';
import type { MailDigest, Summarizer } from '../../apps/jarvisd/src/orchestrator/quarantine.ts';
import type {
  Researcher,
  ResearchRequest,
  ResearchResult,
} from '../../apps/jarvisd/src/orchestrator/research.ts';
import type { VideoHit, VideoInfo, YouTube } from '../../apps/jarvisd/src/tools/research.ts';

/** Records research requests; answers with a fixed, sourced result. */
export class FakeResearcher implements Researcher {
  readonly requests: ResearchRequest[] = [];
  async research(req: ResearchRequest): Promise<ResearchResult> {
    this.requests.push(req);
    return {
      answer: `Réponse à : ${req.question}`,
      keyPoints: req.documents ? ['[00:30] point de la vidéo'] : ['point 1'],
      sources: [
        { title: 'Source', url: req.documents?.[0]?.source ?? 'https://example.org/article' },
      ],
      confidence: 'medium',
      injectionSuspected: false,
      model: req.depth === 'deep' ? 'claude-opus-5-5' : 'claude-sonnet-5-5',
      ms: 1,
    };
  }
}

export class FakeYouTube implements YouTube {
  async search(): Promise<VideoHit[]> {
    return [
      {
        id: 'arj7oStGLkU',
        title: 'Inside the Mind of a Master Procrastinator',
        channel: 'TED',
        durationS: 844,
      },
    ];
  }
  async fetch(id: string): Promise<VideoInfo> {
    return {
      id,
      title: 'Inside the Mind of a Master Procrastinator',
      channel: 'TED',
      durationS: 844,
      lang: 'en',
      transcript: id === 'noSubtitles' ? '' : '[00:00] So in college…',
    };
  }
}

import { appPaths } from '../../apps/jarvisd/src/paths.ts';
import type { MacOps } from '../../apps/jarvisd/src/tools/macos.ts';

/** In-memory mailbox. `failing` simulates an unreachable server. */
export class FakeMailbox implements MailProvider {
  readonly account: string;
  readonly email: string;
  readonly mails: MailMessage[] = [];
  readonly drafts = new Map<string, Draft>();
  readonly sent: Draft[] = [];
  failing = false;
  #n = 0;

  constructor(account: string, email: string) {
    this.account = account;
    this.email = email;
  }

  add(from: string, subject: string, text: string, unread = true): MailMessage {
    const id = `m${++this.#n}`;
    const m: MailMessage = {
      id,
      account: this.account,
      threadId: `t${id}`,
      from,
      to: this.email,
      subject,
      date: new Date().toISOString(),
      snippet: text.slice(0, 120),
      unread,
      messageId: `<${id}@x>`,
      text,
    };
    this.mails.push(m);
    return m;
  }

  async list(o: ListOptions): Promise<MailHeader[]> {
    if (this.failing) throw new Error('mail server unreachable (ETIMEDOUT)');
    return this.mails.filter((m) => !o.unreadOnly || m.unread).slice(-o.max);
  }
  async get(id: string): Promise<MailMessage> {
    const m = this.mails.find((x) => x.id === id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  }
  async createDraft(d: DraftInput): Promise<Draft> {
    const draft = {
      id: `d${++this.#n}`,
      account: this.account,
      to: d.to,
      subject: d.subject,
      body: d.body,
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }
  async getDraft(id: string): Promise<Draft> {
    const d = this.drafts.get(id);
    if (!d) throw new Error(`no draft ${id}`);
    return d;
  }
  async sendDraft(id: string): Promise<{ id: string }> {
    const d = await this.getDraft(id);
    this.sent.push(d);
    this.drafts.delete(id);
    return { id };
  }
}

export class FakeCalendar implements CalendarProvider {
  readonly items: CalendarEvent[] = [];
  async events(): Promise<CalendarEvent[]> {
    return this.items;
  }
}

/** Deterministic stand-in for the quarantine reader. */
export class FakeSummarizer implements Summarizer {
  async digest(mails: (MailHeader | MailMessage)[]): Promise<MailDigest[]> {
    return mails.map((m) => {
      const text = 'text' in m ? m.text : m.snippet;
      const injection = /jarvis|assistant|ignore|forward/i.test(text);
      const urgent = /urgent|aujourd'hui|today/i.test(`${m.subject} ${text}`);
      return {
        id: m.id,
        account: m.account,
        from: m.from,
        subject: m.subject,
        date: m.date,
        unread: m.unread,
        category: injection ? 'suspicious' : 'action',
        urgency: urgent ? 'high' : 'normal',
        summary: `résumé de « ${m.subject} »`,
        asks: [],
        deadline: null,
        injectionSuspected: injection,
      };
    });
  }
}

import { ScriptedBrain } from './scripted-brain.ts';

export const EXAMPLE_POLICY = resolve(import.meta.dirname, '../../config/policy.example.yaml');
export const PIN = '482915';
export const CANARY_TOKEN = 'sk-ant-oat01-CANARYcanaryCANARY0123456789';

/** Records macOS side effects instead of launching apps. */
export class FakeMac implements MacOps {
  readonly opened: string[][] = [];
  readonly shortcutRuns: { name: string; input: string | null }[] = [];

  async open(args: string[]): Promise<void> {
    this.opened.push(args);
  }
  async runningApps(): Promise<string[]> {
    return ['Finder', 'Code'];
  }
  async shortcuts(): Promise<string[]> {
    return ['Convert video to GIF', 'Orange Money 🔒'];
  }
  async runShortcut(name: string, inputPath: string | null): Promise<string> {
    this.shortcutRuns.push({ name, input: inputPath ? readFileSync(inputPath, 'utf8') : null });
    return 'done';
  }
  async status(): Promise<string> {
    return 'Now drawing from AC Power\nuptime: 5 h';
  }
}

export interface Harness {
  home: string;
  work: string;
  mac: FakeMac;
  researcher: FakeResearcher;
  gmail: FakeMailbox;
  pro: FakeMailbox;
  calendar: FakeCalendar;
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
  const mac = new FakeMac();
  const gmail = new FakeMailbox('perso', 'brightkyefoo@gmail.com');
  const pro = new FakeMailbox('scriptify', 'brightky@scriptify.cm');
  const calendar = new FakeCalendar();
  const researcher = new FakeResearcher();
  const rt = createRuntime({
    paths,
    home,
    policyPath: EXAMPLE_POLICY,
    secrets,
    devMode: opts.devMode ?? false,
    requireSealed: false,
    brainFactory: (ctx) => new ScriptedBrain(ctx.gate),
    mac,
    connectors: {
      providers: new Map<string, MailProvider>([
        ['perso', gmail],
        ['scriptify', pro],
      ]),
      calendar,
      summarizer: new FakeSummarizer(),
    },
    research: { researcher, youtube: new FakeYouTube() },
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
    mac,
    researcher,
    gmail,
    pro,
    calendar,
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

export interface FakeApp {
  /** Every action the daemon sent, in order. */
  readonly actions: ActuatorAction[];
  readonly reqIds: string[];
  readonly cancelled: string[];
  /** Raw line sender, to test what the daemon accepts from this connection. */
  send(msg: unknown): void;
  close(): void;
}

/**
 * Stands in for Jarvis.app: registers as the actuator over the real socket and answers each
 * action with `answer` (throw to fail it; return a never-settling promise to hang).
 */
export async function connectFakeApp(
  socketPath: string,
  answer: (a: ActuatorAction) => unknown | Promise<unknown>,
): Promise<FakeApp> {
  const s = connect(socketPath);
  await new Promise<void>((r, j) => {
    s.once('connect', () => r());
    s.once('error', j);
  });
  const actions: ActuatorAction[] = [];
  const reqIds: string[] = [];
  const cancelled: string[] = [];
  const send = (msg: unknown) => s.write(`${JSON.stringify(msg)}\n`);
  let registered: () => void = () => undefined;
  const ready = new Promise<void>((r) => {
    registered = r;
  });
  let buf = '';
  s.setEncoding('utf8');
  s.on('data', (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const r = JSON.parse(buf.slice(0, nl)) as Reply;
      buf = buf.slice(nl + 1);
      if (r.type === 'event') registered();
      if (r.type === 'actuate_cancel') cancelled.push(r.reqId);
      if (r.type !== 'actuate') continue;
      actions.push(r.action);
      reqIds.push(r.reqId);
      Promise.resolve()
        .then(() => answer(r.action))
        .then(
          (result) => send({ id: 'res', cmd: 'actuator_result', reqId: r.reqId, ok: true, result }),
          (e: Error) =>
            send({
              id: 'res',
              cmd: 'actuator_result',
              reqId: r.reqId,
              ok: false,
              error: e.message,
            }),
        );
    }
  });
  send({
    id: 'reg',
    cmd: 'actuator_register',
    version: 'test',
    capabilities: ['browser', 'notes', 'reminders', 'screen'],
  });
  await ready;
  return { actions, reqIds, cancelled, send, close: () => s.end() };
}
