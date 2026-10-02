import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  connectGoogle,
  GitHubClient,
  GitLabClient,
  GoogleAuth,
  type GoogleClient,
  ImapProvider,
  parseClientFile,
  TrelloClient,
} from '@jarvis/connectors';
import { KeychainStore, SecretName } from '@jarvis/secrets';
import { parseDocument } from 'yaml';

export interface SetupIO {
  askHidden: (q: string, o?: { clipboardFallback?: boolean }) => Promise<string>;
  askLine: (q: string) => Promise<string>;
  say: (s: string) => void;
}

const REPO = resolve(import.meta.dirname, '../../..');
const EXAMPLE = join(REPO, 'config', 'policy.example.yaml');
/** Brightky's own policy (accounts, hosts): kept out of git, sealed by the wizard. */
export const PERSONAL_POLICY = join(REPO, 'config', 'policy.yaml');

const open = (url: string) => execFileSync('/usr/bin/open', [url]);
const yes = (a: string) => /^(o|oui|y|yes|)$/i.test(a.trim());

/** GitHub fine-grained token, pre-filled (GitHub template URLs, Aug 2025). */
export function githubTokenUrl(owner?: string): string {
  const q = new URLSearchParams({
    name: owner ? `Jarvis (${owner})` : 'Jarvis',
    description:
      'Jarvis, assistant de Brightky : lecture des PR/issues, commentaires, branches jarvis/ et PR',
    expires_in: '366',
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    checks: 'read',
    statuses: 'read',
    metadata: 'read',
    ...(owner && { target_name: owner }),
  });
  return `https://github.com/settings/personal-access-tokens/new?${q}`;
}

export const gitlabTokenUrl = (base: string) =>
  `${base.replace(/\/+$/, '')}/-/user_settings/personal_access_tokens?name=Jarvis&scopes=api,read_user`;

/** Mail accounts declared in the personal policy (or the example when there is none yet). */
function declaredAccounts(): { id: string; type: string; email: string }[] {
  const file = existsSync(PERSONAL_POLICY) ? PERSONAL_POLICY : EXAMPLE;
  const doc = parseDocument(readFileSync(file, 'utf8'));
  return ((doc.getIn(['mail', 'accounts']) as { toJSON?: () => unknown } | undefined)?.toJSON?.() ??
    []) as {
    id: string;
    type: string;
    email: string;
  }[];
}

/** Account id from an address: brightefoo@gmail.com → brightefoo. */
export function accountIdFor(email: string, taken: string[]): string {
  const base =
    (email.split('@')[0] ?? 'gmail')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'gmail';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Connects one Gmail account (any number of them): Google lets Brightky pick the account, Jarvis
 * reads which address was authorised, stores its token and declares it in the policy if needed.
 */
export async function connectGmail(io: SetupIO, clientFile?: string): Promise<string | null> {
  const store = new KeychainStore();
  let client: GoogleClient;
  if (clientFile) client = parseClientFile(readFileSync(clientFile, 'utf8'));
  else {
    const saved = store.get(SecretName.googleClient);
    if (!saved) {
      io.say(
        '✖ aucun client Google enregistré : passe le fichier client_secret_….json la première fois.',
      );
      return null;
    }
    client = JSON.parse(saved) as GoogleClient;
  }
  io.say('Le navigateur s’ouvre : choisis le compte Gmail à connecter, puis autorise les 3 accès.');
  const r = await connectGoogle({ client, openUrl: async (url) => void open(url) });
  const auth = new GoogleAuth({ client, refreshToken: r.refreshToken });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${await auth.accessToken()}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Gmail a refusé la lecture du profil (${res.status})`);
  const email = ((await res.json()) as { emailAddress: string }).emailAddress.toLowerCase();
  const accounts = declaredAccounts();
  const existing = accounts.find((a) => a.type === 'gmail' && a.email.toLowerCase() === email);
  const id =
    existing?.id ??
    accountIdFor(
      email,
      accounts.map((a) => a.id),
    );
  store.set(SecretName.googleClient, JSON.stringify(client));
  store.set(SecretName.googleRefreshToken(id), r.refreshToken);
  io.say(`✔ ${email} connecté (compte « ${id} »).`);
  if (!existing) {
    io.say(`Ajout de ${email} à ta politique…`);
    const sealed = editPolicy(io, (d) => {
      const list = declaredAccounts().filter((a) => a.id !== id);
      d.setIn(['mail', 'accounts'], [...list, { id, type: 'gmail', email }]);
    });
    if (!sealed) io.say('✖ scellement annulé : relance « jarvis google connect » pour finir.');
  }
  return email;
}

/** Reads, edits and re-seals the personal policy (sudo is asked by the seal script). */
function editPolicy(io: SetupIO, change: (doc: ReturnType<typeof parseDocument>) => void): boolean {
  if (!existsSync(PERSONAL_POLICY)) copyFileSync(EXAMPLE, PERSONAL_POLICY);
  const doc = parseDocument(readFileSync(PERSONAL_POLICY, 'utf8'));
  change(doc);
  writeFileSync(PERSONAL_POLICY, String(doc), { mode: 0o644 });
  io.say('Scellement de la politique (ton mot de passe Mac va être demandé)…');
  const r = spawnSync(join(REPO, 'ops', 'scripts', 'seal-policy.sh'), [PERSONAL_POLICY], {
    stdio: 'inherit',
  });
  return r.status === 0;
}

async function step(io: SetupIO, title: string, done: boolean): Promise<boolean> {
  io.say(`\n━━ ${title} ${done ? '(déjà connecté)' : ''}`);
  const a = await io.askLine(done ? 'Reconnecter ? [o/N] ' : 'Connecter maintenant ? [O/n] ');
  return done ? /^(o|oui|y|yes)$/i.test(a.trim()) : yes(a);
}

export async function runSetup(io: SetupIO): Promise<void> {
  const store = new KeychainStore();
  const has = (n: string) => store.get(n) !== null;
  let changed = false;
  io.say(
    'Jarvis — connexion de tes comptes. Entrée = oui, n = passer. Les tokens vont dans le Trousseau.',
  );

  // ── GitHub: personal, then one token per organisation ──
  if (await step(io, 'GitHub (tes dépôts perso)', has(SecretName.githubToken))) {
    io.say(
      'Le navigateur s’ouvre sur un token pré-rempli. Choisis « All repositories », puis « Generate token » et copie-le.',
    );
    open(githubTokenUrl());
    const token = (await io.askHidden('Token GitHub : ', { clipboardFallback: true })).replace(
      /\s+/g,
      '',
    );
    try {
      const login = await new GitHubClient({ token: () => token }).whoami();
      store.set(SecretName.githubToken, token);
      io.say(`✔ GitHub : ${login}`);
      changed = true;
    } catch (e) {
      io.say(`✖ token refusé par GitHub (${(e as Error).message})`);
    }
  }
  if (has(SecretName.githubToken)) {
    const owners = new Set<string>(
      JSON.parse(store.get(SecretName.githubOwners) ?? '[]') as string[],
    );
    let orgs: string[] = [];
    try {
      orgs = execFileSync('gh', ['api', 'user/orgs', '--jq', '.[].login'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      orgs = ['scriptify-cm', 'javascriptcm'];
    }
    for (const org of orgs) {
      if (!(await step(io, `GitHub — organisation ${org}`, owners.has(org.toLowerCase()))))
        continue;
      io.say(`Token pré-rempli pour ${org} : « All repositories », « Generate token », copie.`);
      open(githubTokenUrl(org));
      const token = (
        await io.askHidden(`Token GitHub ${org} : `, { clipboardFallback: true })
      ).replace(/\s+/g, '');
      try {
        await new GitHubClient({ token: () => token }).whoami();
        store.set(SecretName.githubOwnerToken(org), token);
        owners.add(org.toLowerCase());
        store.set(SecretName.githubOwners, JSON.stringify([...owners]));
        io.say(`✔ ${org} connecté`);
        changed = true;
      } catch (e) {
        io.say(`✖ token refusé (${(e as Error).message})`);
      }
    }
  }

  // ── GitLab ──
  if (await step(io, 'GitLab', has(SecretName.gitlabToken))) {
    const base =
      (await io.askLine('Adresse GitLab [https://gitlab.com] : ')).trim() || 'https://gitlab.com';
    io.say('Le navigateur s’ouvre (nom et droits pré-remplis) : « Create token », puis copie-le.');
    open(gitlabTokenUrl(base));
    const token = (await io.askHidden('Token GitLab : ', { clipboardFallback: true })).replace(
      /\s+/g,
      '',
    );
    try {
      const login = await new GitLabClient({ token: () => token, base }).whoami();
      store.set(SecretName.gitlabToken, token);
      io.say(`✔ GitLab : ${login}`);
      changed = true;
      if (base !== 'https://gitlab.com')
        editPolicy(io, (d) => d.setIn(['forges', 'gitlab_url'], base));
    } catch (e) {
      io.say(`✖ token refusé par GitLab (${(e as Error).message})`);
    }
  }

  // ── Trello ──
  if (await step(io, 'Trello', has(SecretName.trelloToken))) {
    io.say(
      '1) Sur la page qui s’ouvre : « Nouveau » Power-Up (nom : Jarvis), puis « Clé API » → copie la clé.',
    );
    open('https://trello.com/power-ups/admin');
    const key = (await io.askHidden('Clé API Trello : ', { clipboardFallback: true })).replace(
      /\s+/g,
      '',
    );
    if (key) {
      io.say('2) Autorise Jarvis sur la page suivante, puis copie le token affiché.');
      open(
        `https://trello.com/1/authorize?expiration=never&name=Jarvis&scope=read,write&response_type=token&key=${encodeURIComponent(key)}`,
      );
      const token = (await io.askHidden('Token Trello : ', { clipboardFallback: true })).replace(
        /\s+/g,
        '',
      );
      try {
        const me = await new TrelloClient({ key: () => key, token: () => token }).whoami();
        store.set(SecretName.trelloKey, key);
        store.set(SecretName.trelloToken, token);
        io.say(`✔ Trello : ${me.username}`);
        changed = true;
      } catch (e) {
        io.say(`✖ refusé par Trello (${(e as Error).message})`);
      }
    }
  }

  // ── Gmail + Agenda ──
  if (
    await step(
      io,
      'Gmail et Google Agenda (brightkyefoo@gmail.com)',
      has(SecretName.googleRefreshToken('perso')),
    )
  ) {
    io.say(
      [
        'Google demande un « client OAuth » à toi (gratuit, une fois). Les pages vont s’ouvrir une à une :',
        '  1. Créer le projet « Jarvis »',
        '  2. Activer Gmail API puis Google Calendar API',
        '  3. Écran de consentement : External, nom « Jarvis », ton adresse en contact',
        '  4. Audience : « Publish app » (sinon Google refuse avec « Erreur 403 : access_denied »)',
        '  5. Clients → Create client → Desktop app → télécharger le JSON',
      ].join('\n'),
    );
    for (const [label, url] of [
      ['projet', 'https://console.cloud.google.com/projectcreate'],
      ['Gmail API', 'https://console.cloud.google.com/apis/library/gmail.googleapis.com'],
      [
        'Calendar API',
        'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
      ],
      ['consentement', 'https://console.cloud.google.com/auth/overview'],
      ['audience → Publish app', 'https://console.cloud.google.com/auth/audience'],
      ['client Desktop', 'https://console.cloud.google.com/auth/clients/create'],
    ] as const) {
      await io.askLine(`Entrée pour ouvrir : ${label}… `);
      open(url);
    }
    await io.askLine('Entrée quand le fichier client_secret_….json est téléchargé… ');
    const dl = join(homedir(), 'Downloads');
    const newest = readdirSync(dl)
      .filter((f) => /^client_secret.*\.json$/.test(f))
      .map((f) => join(dl, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!newest)
      io.say(
        '✖ aucun client_secret_….json dans Téléchargements : relance « jarvis setup » plus tard.',
      );
    else {
      io.say(`Fichier trouvé : ${newest}.`);
      try {
        if (await connectGmail(io, newest)) changed = true;
      } catch (e) {
        io.say(`✖ ${(e as Error).message}`);
      }
    }
  }
  // Several personal Gmail accounts: one more connection per account, same Google client.
  while (has(SecretName.googleClient)) {
    const more = await io.askLine('\nConnecter un autre compte Gmail ? [o/N] ');
    if (!/^(o|oui|y|yes)$/i.test(more.trim())) break;
    try {
      if (await connectGmail(io)) changed = true;
    } catch (e) {
      io.say(`✖ ${(e as Error).message}`);
    }
  }

  // ── Mail pro (IMAP, LWS) ──
  if (await step(io, 'Mail pro (IMAP)', has(SecretName.mailPassword('pro')))) {
    const email = (await io.askLine('Adresse pro (ex. brightky@scriptify.cm) : ')).trim();
    const host =
      (await io.askLine('Serveur [web58.lws-hosting.com] : ')).trim() || 'web58.lws-hosting.com';
    const password = await io.askHidden('Mot de passe de la boîte (saisie masquée) : ');
    if (email && password) {
      const cfg = {
        account: 'pro',
        email,
        imap: { host, port: 993, secure: true },
        smtp: { host, port: 465, secure: true },
      };
      try {
        io.say('Test de connexion IMAP + SMTP…');
        await new ImapProvider(cfg, password).test();
        store.set(SecretName.mailPassword('pro'), password);
        io.say('✔ connexion réussie');
        const sealed = editPolicy(io, (d) => {
          const accounts =
            (d.getIn(['mail', 'accounts']) as { items?: unknown[] } | undefined)?.items ?? [];
          const others = accounts
            .map((n) => (n as { toJSON?: () => unknown }).toJSON?.() ?? n)
            .filter((a) => (a as { id?: string }).id !== 'pro');
          d.setIn(
            ['mail', 'accounts'],
            [...others, { id: 'pro', type: 'imap', email, imap: cfg.imap, smtp: cfg.smtp }],
          );
        });
        io.say(
          sealed
            ? '✔ compte pro ajouté à la politique scellée'
            : '✖ scellement annulé : relance « jarvis setup »',
        );
        changed = true;
      } catch (e) {
        io.say(
          `✖ connexion refusée (${(e as Error).message}). Vérifie l’adresse et le mot de passe.`,
        );
      }
    }
  }

  // ── Teams: no API needed, Jarvis drives the app ──
  io.say(
    [
      '\n━━ Microsoft Teams',
      'Rien à connecter : Jarvis ouvre Teams, lit l’écran et écrit pour toi (« Jarvis, écris à Paul sur Teams… »).',
      'Chaque message envoyé te demande confirmation, sauf si tu autorises Teams à envoyer sans demander.',
    ].join('\n'),
  );
  const teams = await io.askLine('Laisser Jarvis envoyer sur Teams sans confirmation ? [o/N] ');
  if (/^(o|oui|y|yes)$/i.test(teams.trim())) {
    editPolicy(io, (d) => {
      const list = (
        (
          d.getIn(['computer', 'commit_allow_apps']) as { toJSON?: () => string[] } | undefined
        )?.toJSON?.() ?? []
      ).filter((x) => x !== 'Microsoft Teams');
      d.setIn(['computer', 'commit_allow_apps'], [...list, 'Microsoft Teams']);
    });
    changed = true;
  }

  if (changed) {
    io.say('\nRedémarrage de Jarvis pour prendre en compte les comptes…');
    spawnSync(
      '/bin/launchctl',
      ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/cm.brightkyefoo.jarvisd`],
      { stdio: 'ignore' },
    );
  }
  io.say(
    '\nTerminé. Vérifie avec : jarvis status · jarvis mail test · « Jarvis, qu’est-ce qui m’attend sur GitHub ? »',
  );
}
