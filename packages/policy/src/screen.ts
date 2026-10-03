import { type Classification, N1, N2, N4 } from './levels.ts';

/**
 * Rules for driving the screen and the browser (Brightky's own logged-in profile).
 * Built-in lists are code (N4 cannot be relaxed); policy.yaml can only add to them, and allowlist
 * where commit actions skip confirmation.
 */

/** Never driven: they would bypass the shell policy, touch credentials or move money. */
const BUILTIN_FORBIDDEN_APPS = [
  'terminal',
  'iterm',
  'iterm2',
  'warp',
  'ghostty',
  'kitty',
  'alacritty',
  'hyper',
  'wezterm',
  'system settings',
  'system preferences',
  'keychain access',
  'passwords',
  'script editor',
  'automator',
  'installer',
  'disk utility',
  'activity monitor',
  'console',
  'migration assistant',
  'boot camp assistant',
  '1password',
  '1password 7',
  'bitwarden',
  'lastpass',
  'dashlane',
  'keepassxc',
  'enpass',
  'jarvis', // its own dashboard: approvals and STOP are Brightky's, never the model's
];

/** host suffix [+ path prefix]. Banking, payments, password managers, account security pages. */
const BUILTIN_FORBIDDEN_SITES = [
  'paypal.com',
  'stripe.com',
  'wise.com',
  'revolut.com',
  'payoneer.com',
  'westernunion.com',
  'moneygram.com',
  'remitly.com',
  'worldremit.com',
  'skrill.com',
  'coinbase.com',
  'binance.com',
  'kraken.com',
  'bybit.com',
  'orange.cm/fr/orange-money',
  'orangemoney.cm',
  'momo.mtn.cm',
  'mtn.cm/momo',
  'cinetpay.com',
  'campay.net',
  'monetbil.com',
  'afrikpay.com',
  'flutterwave.com',
  'paystack.com',
  '1password.com',
  'lastpass.com',
  'bitwarden.com',
  'dashlane.com',
  'accounts.google.com',
  'myaccount.google.com',
  'passwords.google.com',
  'pay.google.com',
  'appleid.apple.com',
  'account.apple.com',
  'icloud.com/settings',
  'github.com/settings',
  'gitlab.com/-/user_settings',
  'gitlab.com/-/profile',
  'console.aws.amazon.com',
  'console.cloud.google.com/iam-admin',
  'dashboard.stripe.com',
  // LinkedIn forbids automating its site (User Agreement §8.2): driving it risks Brightky's account.
  // Jarvis posts through the official API instead (ADR-037).
  'linkedin.com',
];
/** Anywhere in the host name ("afrilandfirstbank.com", "ebanking.ecobank.com"). */
const BANK_HOST =
  /bank|banque|banking|afriland|bicec|boursorama|bnpparibas|societegenerale|creditagricole|caisse-epargne|labanquepostale|mobilemoney/i;
/** Short names only as whole labels (no "cuba", "dubai", "scuba"). */
const BANK_LABEL = /(^|[.-])(sgbc|scb|uba|cca|bgfi|lcl|cic|n26|qonto)([.-]|$)/i;

/** Engages Brightky (speaks or acts for him): confirmation unless the site/app is allowlisted. */
const COMMIT =
  /\b(envoyer|envoie|send|publier|publish|poster|post|tweeter|tweet|reposter|repost|soumettre|submit|valider|confirmer|confirm|accepter|accept|partager|share|inviter|invite|cr[ée]er|create|commenter|comment|r[ée]pondre|reply|archiver|archive|d[ée]placer|move|r[ée]server|book|sign|signer|sign in|se connecter|log in|login|s'abonner|subscribe|se d[ée]sabonner|unsubscribe|bloquer|block|signaler|report|enregistrer et envoyer|save and send|order|planifier|schedule)\b/i;

/** Destroys, merges, signs off or gives away: always confirmed, even on an allowlisted site. */
const DESTRUCTIVE =
  /\b(supprimer|supprime|delete|remove|retirer|effacer|erase|vider|empty|merge|fusionner|squash|rebase|approve|approuver|close issue|close pull request|fermer (le|la) (ticket|pull request|demande)|transf[ée]rer|transfer|revoke|r[ée]voquer|leave|quitter (le|la) (groupe|projet|[ée]quipe)|discard|abandonner|reset|r[ée]initialiser|deactivate|d[ée]sactiver)\b/i;

/** Money never moves through Jarvis (out of scope, N4). */
const PAYMENT =
  /\b(payer|pay|pay now|paiement|payment|buy|buy now|acheter|achat|checkout|place order|passer la commande|commander|purchase|virement|wire|recharger|top.?up|retirer de l'argent|withdraw|send money|envoyer de l'argent|faire un don|donate|upgrade|start trial|start free trial|essai gratuit|ajouter une carte|add card|add payment)\b/i;

/** Cookie banners are not engagements. */
const CONSENT_ONLY =
  /cookie|^(tout accepter|accept all|accepter et fermer|ok|j'ai compris|got it)$/i;

/** Fields whose content is a credential or a payment instrument: Jarvis never types there. */
const SECRET_FIELD_NAME =
  /pass(word|wd)?|pwd|mot.?de.?passe|\botp\b|totp|2fa|mfa|\bpin\b|cvv|cvc|\bcsc\b|card.?num|cc.?num|\biban\b|routing|secret|token|api.?key/i;
const SECRET_AUTOCOMPLETE =
  /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-type|transaction-amount)$/i;

export interface ScreenRules {
  forbiddenApps: readonly string[];
  forbiddenSites: readonly string[];
  commitAllowDomains: readonly string[];
  commitAllowApps: readonly string[];
}

export function screenRules(extra: {
  forbidden_apps: string[];
  forbidden_domains: string[];
  commit_allow_domains: string[];
  commit_allow_apps: string[];
}): ScreenRules {
  return {
    forbiddenApps: [...BUILTIN_FORBIDDEN_APPS, ...extra.forbidden_apps.map((a) => a.toLowerCase())],
    forbiddenSites: [
      ...BUILTIN_FORBIDDEN_SITES,
      ...extra.forbidden_domains.map((d) => d.toLowerCase()),
    ],
    commitAllowDomains: extra.commit_allow_domains.map((d) => d.toLowerCase()),
    commitAllowApps: extra.commit_allow_apps.map((a) => a.toLowerCase()),
  };
}

const hostMatches = (host: string, suffix: string) =>
  host === suffix || host.endsWith(`.${suffix}`);

/** `null` when allowed; otherwise the reason. Non-http(s) URLs are refused too. */
export function forbiddenUrl(url: string, rules: ScreenRules): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return `${u.protocol} pages are not driven`;
  const host = u.hostname.toLowerCase();
  if (BANK_HOST.test(host) || BANK_LABEL.test(host)) return 'banking site: money is out of scope';
  for (const site of rules.forbiddenSites) {
    const [h = '', ...rest] = site.split('/');
    const path = rest.length ? `/${rest.join('/')}` : '';
    if (hostMatches(host, h) && (!path || u.pathname.toLowerCase().startsWith(path))) {
      return site === 'linkedin.com'
        ? 'LinkedIn forbids automating its site (account at risk): post with linkedin_post, the official API'
        : `${site} is off-limits (payments, passwords or account security)`;
    }
  }
  return null;
}

export const isForbiddenApp = (app: string, rules: ScreenRules): boolean => {
  const a = app
    .toLowerCase()
    .replace(/\.app$/, '')
    .trim();
  return rules.forbiddenApps.some((f) => a === f);
};

export const isPaymentLabel = (label: string): boolean => PAYMENT.test(label);
export const isDestructiveLabel = (label: string): boolean => DESTRUCTIVE.test(label);
export const isCommitLabel = (label: string): boolean =>
  !CONSENT_ONLY.test(label.trim()) && (COMMIT.test(label) || DESTRUCTIVE.test(label));

export interface FieldInfo {
  type?: string;
  name?: string;
  autocomplete?: string;
  label?: string;
  /** AX subrole AXSecureTextField. */
  secure?: boolean;
}

export function isSecretField(f: FieldInfo): boolean {
  if (f.secure || f.type?.toLowerCase() === 'password') return true;
  if (f.autocomplete?.split(/\s+/).some((t) => SECRET_AUTOCOMPLETE.test(t))) return true;
  return SECRET_FIELD_NAME.test(f.name ?? '') || SECRET_FIELD_NAME.test(f.label ?? '');
}

/**
 * Level of clicking / pressing something labelled `label`. `declaredCommit` is the model saying
 * the action engages Brightky (icon-only buttons have no label to detect it from); the result is
 * the worst of what is declared and what is detected.
 */
export function engagementLevel(
  label: string,
  o: { declaredCommit: boolean; allowlisted: boolean; where: string },
): Classification {
  if (isPaymentLabel(label)) {
    return {
      level: N4,
      rule: 'computer.deny.payment',
      reason: `"${label}" moves money: out of scope`,
    };
  }
  if (isDestructiveLabel(label)) {
    return {
      level: N2,
      rule: 'computer.commit.destructive',
      reason: `"${label}" deletes, merges or signs off on ${o.where}`,
    };
  }
  if (o.declaredCommit || isCommitLabel(label)) {
    return o.allowlisted
      ? {
          level: N1,
          rule: 'computer.commit.allowlisted',
          reason: `${o.where} is allowlisted for commits`,
        }
      : {
          level: N2,
          rule: 'computer.commit',
          reason: `${label ? `"${label}"` : 'this action'} sends, publishes or engages Brightky on ${o.where}`,
        };
  }
  return { level: N1, rule: 'computer.act', reason: `acts in ${o.where}` };
}

const KEY_NAMES = new Set([
  'return',
  'enter',
  'tab',
  'escape',
  'esc',
  'space',
  'delete',
  'backspace',
  'forwarddelete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
]);
const MODIFIERS = new Set(['cmd', 'shift', 'option', 'alt', 'ctrl']);
/** Switch app, open Spotlight, log out, force quit: they would take Jarvis out of the app it was allowed in. */
const SYSTEM_KEYS = new Set([
  'cmd+space',
  'ctrl+space',
  'cmd+tab',
  'cmd+shift+tab',
  'cmd+`',
  'cmd+option+escape',
  'cmd+option+esc',
  'cmd+shift+q',
  'cmd+option+shift+q',
  'ctrl+cmd+q',
  'cmd+ctrl+q',
  'ctrl+up',
  'ctrl+down',
  'ctrl+left',
  'ctrl+right',
  'cmd+option+d',
  'cmd+h',
  'cmd+option+h',
  'cmd+m',
]);
const DESTRUCTIVE_KEYS = new Set([
  'cmd+q',
  'cmd+w',
  'cmd+delete',
  'cmd+backspace',
  'cmd+shift+delete',
  'cmd+shift+backspace',
  'cmd+option+delete',
  'cmd+option+backspace',
  'cmd+option+shift+delete',
  'cmd+z',
]);

/** Normalised `mod+mod+key`, or null when not a key Jarvis may press. */
export function normalizeKey(spec: string): string | null {
  const parts = spec.toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const mods = [
    ...new Set(
      parts.map((m) =>
        m === 'alt' ? 'option' : m === 'command' ? 'cmd' : m === 'control' ? 'ctrl' : m,
      ),
    ),
  ];
  if (mods.some((m) => !MODIFIERS.has(m))) return null;
  if (!KEY_NAMES.has(key) && !/^[a-z0-9,.;'/\\[\]`=-]$/.test(key) && !/^f([1-9]|1[0-2])$/.test(key))
    return null;
  const order = ['ctrl', 'option', 'shift', 'cmd'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, key === 'esc' ? 'escape' : key === 'enter' ? 'return' : key].join('+');
}

export function keyLevel(
  spec: string,
  o: { declaredCommit: boolean; allowlisted: boolean; where: string },
): Classification {
  const k = normalizeKey(spec);
  if (!k)
    return {
      level: N4,
      rule: 'computer.deny.key',
      reason: `"${spec}" is not a key Jarvis may press`,
    };
  const sorted = (x: string) => x.split('+').sort().join('+');
  const any = (set: Set<string>) => [...set].some((s) => sorted(s) === sorted(k));
  if (any(SYSTEM_KEYS)) {
    return {
      level: N4,
      rule: 'computer.deny.system_key',
      reason: `${k} would leave the app or the session`,
    };
  }
  if (any(DESTRUCTIVE_KEYS)) {
    return {
      level: N2,
      rule: 'computer.commit.destructive',
      reason: `${k} closes, quits, deletes or undoes in ${o.where}`,
    };
  }
  // Return sends in chats, mail and most forms.
  if (k.endsWith('return')) return engagementLevel('', { ...o, declaredCommit: true });
  return engagementLevel('', o);
}

export function commitAllowedOn(url: string | null, rules: ScreenRules): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return rules.commitAllowDomains.some((d) => hostMatches(host, d));
  } catch {
    return false;
  }
}

export const commitAllowedInApp = (app: string, rules: ScreenRules): boolean =>
  rules.commitAllowApps.includes(
    app
      .toLowerCase()
      .replace(/\.app$/, '')
      .trim(),
  );
