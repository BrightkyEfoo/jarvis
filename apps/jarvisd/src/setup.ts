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
import { GitHubClient, GitLabClient, ImapProvider, TrelloClient } from '@jarvis/connectors';
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
      io.say(
        `Fichier trouvé : ${newest}. Autorise Jarvis dans le navigateur (lecture, brouillons, agenda).`,
      );
      const r = spawnSync(
        process.execPath,
        [join(REPO, 'apps', 'jarvisd', 'src', 'cli.ts'), 'google', 'connect', newest, 'perso'],
        { stdio: 'inherit' },
      );
      if (r.status === 0) changed = true;
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
