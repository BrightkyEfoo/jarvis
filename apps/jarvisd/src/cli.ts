import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { k, type TurnView, turnFooter } from './format.ts';
import { type ApprovalView, onLines, type Reply, type Request, writeLine } from './ipc.ts';
import { appPaths } from './paths.ts';

// Hot path (ask/stop/status) only loads node:net: heavy modules are imported per command.

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);

type Handler = (r: Reply) => void | Promise<void>;
type Outgoing = Request extends infer R
  ? R extends { id: string }
    ? Omit<R, 'id'>
    : never
  : never;

interface Client {
  request(req: Outgoing, onEvent?: Handler): Promise<Reply>;
  close(): void;
}

function openClient(): Promise<Client> {
  const socketPath = appPaths().socket;
  return new Promise((resolve) => {
    const socket: Socket = connect(socketPath);
    const handlers = new Map<string, { done: (r: Reply) => void; onEvent: Handler | undefined }>();
    socket.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        console.error(red('jarvisd is not running. Start it with: jarvis daemon'));
        process.exit(2);
      }
      console.error(red(e.message));
      process.exit(2);
    });
    onLines(socket, (line) => {
      const r = JSON.parse(line) as Reply;
      const h = handlers.get(r.id);
      if (!h) return;
      if (r.type === 'done' || r.type === 'error') {
        handlers.delete(r.id);
        h.done(r);
      } else {
        void h.onEvent?.(r);
      }
    });
    socket.once('connect', () =>
      resolve({
        request: (req, onEvent) =>
          new Promise((done) => {
            const id = randomUUID().slice(0, 8);
            handlers.set(id, { done, onEvent });
            writeLine(socket, { ...req, id });
          }),
        close: () => socket.end(),
      }),
    );
  });
}

async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    const line = await rl.question('');
    rl.close();
    return line.trim();
  }
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

function describeApproval(a: ApprovalView): string {
  const lines = [
    '',
    yellow(`⚠ Validation requise — N${a.level} ${a.needsPin ? '(PIN)' : ''}`),
    `  ${bold(a.summary)}`,
    dim(
      `  outil ${a.tool} · règle ${a.rule} · expire à ${new Date(a.expiresAt).toLocaleTimeString('fr-FR')}`,
    ),
  ];
  if (a.tainted)
    lines.push(yellow('  ⚠ la conversation contient du contenu externe (mail, fichier, web…)'));
  if (a.externalDestinations.length > 0) {
    lines.push(
      red(`  ⚠ destination trouvée dans un contenu externe : ${a.externalDestinations.join(', ')}`),
    );
  }
  return lines.join('\n');
}

/** Interactive approval. Without a terminal, leaves it pending for `jarvis approve <id>`. */
async function handleApproval(c: Client, a: ApprovalView): Promise<void> {
  console.log(describeApproval(a));
  if (!process.stdin.isTTY) {
    console.log(dim(`  → jarvis approve ${a.id}   ou   jarvis deny ${a.id}`));
    return;
  }
  const yes = /^(o|oui|y|yes)$/i.test(await askLine('  Approuver ? [o/N] '));
  if (!yes) {
    await c.request({ cmd: 'deny', approvalId: a.id });
    console.log(dim('  refusé'));
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const pin = a.needsPin ? await askHidden('  Code PIN : ') : undefined;
    const r = await c.request({ cmd: 'approve', approvalId: a.id, ...(pin ? { pin } : {}) });
    if (r.type === 'done') {
      console.log(dim('  approuvé'));
      return;
    }
    console.log(red(`  ${r.type === 'error' ? r.error : 'error'}`));
    if (!a.needsPin || /locked|no pending/.test(r.type === 'error' ? r.error : '')) return;
  }
}

async function ask(text: string): Promise<void> {
  const c = await openClient();
  let approvals = Promise.resolve();
  const r = await c.request({ cmd: 'ask', text }, (e) => {
    if (e.type === 'text') process.stdout.write(e.text);
    else if (e.type === 'tool')
      process.stdout.write(dim(`\n⚙ ${e.name.replace('mcp__jarvis__', '')}\n`));
    else if (e.type === 'approval') approvals = approvals.then(() => handleApproval(c, e.request));
  });
  process.stdout.write('\n');
  if (r.type === 'error') console.error(red(r.error));
  else if (r.type === 'done') {
    const d = r.data as TurnView | undefined;
    if (d && !d.ok) console.error(red(`✖ ${d.error ?? 'failed'}`));
    if (d) {
      const footer = turnFooter(d);
      if (footer) console.log(dim(footer));
    }
  }
  c.close();
}

function printCosts(data: unknown): void {
  const s = data as {
    since: string;
    turns: number;
    costUsd: number;
    avgTtftMs: number | null;
    byModel: Record<
      string,
      {
        turns: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        costUsd: number;
      }
    >;
    quota: Record<string, number | string>;
  };
  console.log(
    bold(`Depuis le ${new Date(s.since).toLocaleDateString('fr-FR')} : ${s.turns} requête(s)`),
  );
  for (const [model, m] of Object.entries(s.byModel)) {
    console.log(
      `  ${model.padEnd(20)} ${String(m.turns).padStart(4)} req · ${k(m.inputTokens + m.cacheReadTokens).padStart(7)} in (${k(m.cacheReadTokens)} cache) · ${k(m.outputTokens).padStart(6)} out · ≈ $${m.costUsd.toFixed(3)}`,
    );
  }
  console.log(
    `  total ≈ $${s.costUsd.toFixed(3)} équivalent API — ${bold('0 € réellement facturé')} (abonnement)`,
  );
  if (s.avgTtftMs !== null) console.log(dim(`  TTFT moyen ${s.avgTtftMs} ms`));
  const q = Object.entries(s.quota);
  if (q.length > 0)
    console.log(
      dim(
        `  quota : ${q.map(([w, v]) => `${w} ${typeof v === 'number' ? `${v} %` : v}`).join(' · ')}`,
      ),
    );
}

/**
 * The voice app is launched through LaunchServices (`open`) so macOS attributes the Microphone
 * and Speech permissions to "Jarvis Voice" itself; its output is routed back to this terminal.
 */
async function voiceCommand(args: string[]): Promise<void> {
  const { execFileSync, spawn } = await import('node:child_process');
  const { existsSync, mkdirSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { homedir, tmpdir } = await import('node:os');
  const dir = resolve(import.meta.dirname, '../../voice');
  const app = join(dir, 'build', 'Jarvis Voice.app');
  const [sub] = args;

  if (sub === 'test') return void execFileSync(join(dir, 'test.sh'), { stdio: 'inherit' });
  if (sub === 'build' || !existsSync(app))
    execFileSync(join(dir, 'build.sh'), { stdio: 'inherit' });
  if (sub === 'build') return;

  let out = join(homedir(), 'Library', 'Logs', 'Jarvis', 'voice.log');
  try {
    out = execFileSync('/usr/bin/tty', { stdio: ['inherit', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    mkdirSync(join(homedir(), 'Library', 'Logs', 'Jarvis'), { recursive: true });
    console.log(dim(`logs → ${out}`));
  }
  const openArgs = ['-W', '-n', '--stdout', out, '--stderr', out];
  if (process.env.JARVIS_HOME) openArgs.push('--env', `JARVIS_HOME=${process.env.JARVIS_HOME}`);
  openArgs.push(app);

  if (sub === 'selftest') {
    // Two spoken samples made with the system voices: tests recognition without the microphone.
    const fr = join(tmpdir(), 'jarvis-selftest-fr.aiff');
    const en = join(tmpdir(), 'jarvis-selftest-en.aiff');
    execFileSync('/usr/bin/say', [
      '-v',
      'Thomas',
      '-o',
      fr,
      'Ouvre VS Code sur le projet CodeVault.',
    ]);
    execFileSync('/usr/bin/say', ['-v', 'Samantha', '-o', en, 'What is on my calendar today?']);
    openArgs.push('--args', '--selftest', fr, en);
  }
  const child = spawn('/usr/bin/open', openArgs, { stdio: 'inherit' });
  process.on('SIGINT', () => {
    spawn('/usr/bin/pkill', ['-x', 'jarvis-voice']);
  });
  await new Promise((r) => child.on('exit', r));
}

async function memoryCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  type FactView = { id: number; kind: string; text: string; source: string };
  const print = (data: unknown) => {
    const facts = data as FactView[];
    if (facts.length === 0) console.log(dim('(rien)'));
    for (const f of facts)
      console.log(
        `#${String(f.id).padEnd(4)} ${f.kind.padEnd(10)} ${f.source === 'external' ? yellow('[externe] ') : ''}${f.text}`,
      );
  };
  if (sub === 'search') return simple({ cmd: 'memory_search', query: rest.join(' ') }, print);
  if (sub === 'forget')
    return simple({ cmd: 'memory_forget', factId: Number(rest[0]) }, () =>
      console.log('✔ oublié (archivé)'),
    );
  if (sub === 'notes') {
    return simple({ cmd: 'status' }, async (d) => {
      const dir = (d as { memoryNotes: string }).memoryNotes;
      console.log(`Notes de mémoire : ${dir}`);
      const { execFile } = await import('node:child_process');
      execFile('/usr/bin/open', [dir]);
    });
  }
  return simple({ cmd: 'memory_list', limit: Number(rest[0] ?? 50) }, print);
}

async function simple(req: Outgoing, print: (data: unknown) => void): Promise<void> {
  const c = await openClient();
  const r = await c.request(req);
  c.close();
  if (r.type === 'error') {
    console.error(red(`✖ ${r.error}`));
    process.exitCode = 1;
  } else if (r.type === 'done') {
    print(r.data);
  }
}

async function watchApprovals(): Promise<void> {
  const c = await openClient();
  console.log(dim('En attente de demandes de validation… (Ctrl+C pour quitter)'));
  let queue = Promise.resolve();
  await c.request({ cmd: 'approvals', watch: true }, (e) => {
    if (e.type === 'approval') queue = queue.then(() => handleApproval(c, e.request));
    if (e.type === 'approval_resolved' && e.channel !== 'cli')
      console.log(dim(`  ${e.approvalId}: ${e.approved ? 'approuvé' : 'refusé'} (${e.channel})`));
  });
}

const HELP = `jarvis — assistant de Brightky

  jarvis "question"            parler à Jarvis
  jarvis stop [raison]         STOP : tout s'arrête, workers compris
  jarvis resume                reprendre après un STOP (PIN)
  jarvis status                état du daemon
  jarvis new                   nouvelle conversation (efface le contexte)
  jarvis approvals [--watch]   demandes de validation en attente
  jarvis approve|deny <id>     valider / refuser
  jarvis costs [today|week|month]  consommation (équivalent API) et quota de l'abonnement
  jarvis memory [list|search <q>|forget <id>|notes]  ce que Jarvis retient
  jarvis voice [build|test|selftest]  voix push-to-talk (maintiens ⌥Espace), 100 % locale
  jarvis audit tail [n]        dernières entrées du journal
  jarvis audit verify          vérifier la chaîne de hash du journal
  jarvis daemon [--dev]        lancer le daemon (--dev : policy non scellée, N3 désactivé)
  jarvis auth set-token        enregistrer le token d'abonnement (claude setup-token)
  jarvis pin set               définir / changer le PIN N3
  jarvis policy check <file>   valider un fichier de policy (schéma, YAML)
  jarvis policy verify         vérifier le sceau de la policy
  jarvis policy record-hash    enregistrer le hash de la policy scellée (utilisé par seal-policy.sh)

fait avec ❤️ par Brightky Efo'o — https://brightkyefoo.cm`;

async function secretsCommand(
  kind: 'auth' | 'pin' | 'policy',
  sub: string | undefined,
  arg?: string,
): Promise<void> {
  const { KeychainStore, SecretName } = await import('@jarvis/secrets');
  const store = new KeychainStore();

  if (kind === 'auth' && sub === 'set-token') {
    const token = await askHidden('Token (sortie de `claude setup-token`) : ');
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(token)) {
      console.error(red('✖ format inattendu : attendu sk-ant-…'));
      process.exitCode = 1;
      return;
    }
    store.set(SecretName.claudeOauthToken, token);
    console.log('✔ token enregistré dans le Trousseau. Redémarre le daemon.');
    return;
  }

  if (kind === 'pin' && sub === 'set') {
    const { PinGuard } = await import('@jarvis/policy');
    const guard = new PinGuard({
      store,
      secretName: SecretName.pinHash,
      statePath: appPaths().pinState,
      maxAttempts: 3,
      lockoutMin: 15,
    });
    if (guard.isSet()) {
      const r = guard.verify(await askHidden('PIN actuel : '));
      if (!r.ok) {
        console.error(red(`✖ ${r.reason === 'locked' ? 'PIN verrouillé' : 'PIN incorrect'}`));
        process.exitCode = 1;
        return;
      }
    }
    const a = await askHidden('Nouveau PIN (6 à 12 chiffres) : ');
    const b = await askHidden('Confirmer : ');
    if (a !== b) {
      console.error(red('✖ les deux saisies diffèrent'));
      process.exitCode = 1;
      return;
    }
    guard.set(a);
    console.log('✔ PIN enregistré (hash scrypt dans le Trousseau).');
    return;
  }

  if (kind === 'policy') {
    const { loadPolicy, SEALED_POLICY_PATH, sha256 } = await import('@jarvis/policy');
    if (sub === 'check') {
      const file = arg ?? SEALED_POLICY_PATH;
      const p = loadPolicy({ path: file, expectedSha256: null, requireSealed: false });
      console.log(
        `✔ ${file} valide — ${p.shell.allow.length} règles shell, ${p.filesystem.write_roots.length} dossier(s) en écriture, ${p.auto_approve.length} auto-approbation(s)`,
      );
      return;
    }
    if (sub === 'record-hash') {
      const { readFileSync } = await import('node:fs');
      const digest = sha256(readFileSync(SEALED_POLICY_PATH));
      store.set(SecretName.policySha256, digest);
      console.log(`✔ hash scellé enregistré : ${digest}`);
      return;
    }
    const p = loadPolicy({
      path: SEALED_POLICY_PATH,
      expectedSha256: store.get(SecretName.policySha256),
      requireSealed: true,
    });
    console.log(`✔ policy scellée intacte (${p.sha256.slice(0, 12)}…)`);
    return;
  }
  console.log(HELP);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'daemon': {
      const { runDaemon } = await import('./daemon/main.ts');
      return runDaemon({ dev: rest.includes('--dev') });
    }
    case 'stop':
      return simple({ cmd: 'stop', ...(rest.length ? { reason: rest.join(' ') } : {}) }, () =>
        console.log('⏹ STOP engagé. Tout est suspendu. `jarvis resume` pour reprendre.'),
      );
    case 'resume':
      return simple({ cmd: 'resume', pin: await askHidden('PIN : ') }, (d) =>
        console.log(
          (d as { resumed: boolean }).resumed ? '▶ Jarvis reprend.' : 'Jarvis n’était pas arrêté.',
        ),
      );
    case 'status':
      return simple({ cmd: 'status' }, (d) => console.log(JSON.stringify(d, null, 2)));
    case 'new':
      return simple({ cmd: 'new_session' }, () => console.log('Nouvelle conversation.'));
    case 'approvals':
      if (rest.includes('--watch')) return watchApprovals();
      {
        const c = await openClient();
        await c.request({ cmd: 'approvals' }, (e) => {
          if (e.type === 'approval')
            console.log(`${describeApproval(e.request)}\n  id: ${e.request.id}`);
        });
        c.close();
      }
      return;
    case 'approve': {
      const approvalId = rest[0] ?? '';
      const c = await openClient();
      let r = await c.request({ cmd: 'approve', approvalId });
      if (r.type === 'error' && /PIN required/.test(r.error)) {
        r = await c.request({ cmd: 'approve', approvalId, pin: await askHidden('PIN : ') });
      }
      c.close();
      if (r.type === 'error') {
        console.error(red(`✖ ${r.error}`));
        process.exitCode = 1;
      } else console.log('✔ approuvé');
      return;
    }
    case 'deny':
      return simple({ cmd: 'deny', approvalId: rest[0] ?? '' }, () => console.log('✔ refusé'));
    case 'audit':
      if (rest[0] === 'verify') {
        return simple({ cmd: 'audit_verify' }, (d) => {
          const v = d as { ok: boolean; count: number; brokenAt?: number; reason?: string };
          if (v.ok) console.log(`✔ journal intact (${v.count} entrées)`);
          else {
            console.error(red(`✖ journal altéré à l'entrée ${v.brokenAt} : ${v.reason}`));
            process.exitCode = 1;
          }
        });
      }
      return simple({ cmd: 'audit_tail', limit: Number(rest[1] ?? 20) }, (d) => {
        for (const e of d as {
          seq: number;
          ts: string;
          event: string;
          tool?: string;
          level?: number;
          verdict?: string;
          outcome?: string;
          rule?: string;
        }[]) {
          const lvl = e.level !== undefined ? `N${e.level}` : '  ';
          console.log(
            `${dim(`#${e.seq} ${new Date(e.ts).toLocaleTimeString('fr-FR')}`)} ${e.event.padEnd(8)} ${lvl} ${(e.tool ?? '').padEnd(12)} ${e.verdict ?? e.outcome ?? ''} ${dim(e.rule ?? '')}`,
          );
        }
      });
    case 'costs':
      return simple(
        { cmd: 'costs', period: (rest[0] as 'today' | 'week' | 'month' | undefined) ?? 'today' },
        printCosts,
      );
    case 'memory':
      return memoryCommand(rest);
    case 'voice':
      return voiceCommand(rest);
    case 'auth':
    case 'pin':
    case 'policy':
      return secretsCommand(cmd, rest[0], rest[1]);
    default:
      return ask(argv.join(' '));
  }
}

await main(process.argv.slice(2));
