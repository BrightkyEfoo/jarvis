import { describe, expect, it } from 'vitest';
import {
  commitAllowedInApp,
  commitAllowedOn,
  engagementLevel,
  forbiddenUrl,
  isForbiddenApp,
  isSecretField,
  keyLevel,
  normalizeKey,
  screenRules,
} from '../src/screen.ts';

const rules = screenRules({
  forbidden_apps: ['Orange Money'],
  forbidden_domains: ['impots.gouv.cm', 'example.org/admin'],
  commit_allow_domains: ['trello.com'],
  commit_allow_apps: ['TextEdit'],
});
const o = (allowlisted = false, declaredCommit = false) => ({
  allowlisted,
  declaredCommit,
  where: 'x',
});

describe('forbidden sites (built-in N4 + policy additions)', () => {
  it.each([
    'https://www.paypal.com/myaccount',
    'https://wise.com/send',
    'https://accounts.google.com/signin',
    'https://myaccount.google.com/security',
    'https://appleid.apple.com/account/manage',
    'https://github.com/settings/tokens',
    'https://GitHub.com/Settings/keys',
    'https://www.afrilandfirstbank.com/compte',
    'https://ebanking.ecobank.com',
    'https://www.uba.cm/',
    'https://my.1password.com',
    'https://www.orange.cm/fr/orange-money/transfert',
    'https://impots.gouv.cm/declarer',
    'https://example.org/admin/users',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'chrome://settings/passwords',
    'not a url',
  ])('%s is refused', (url) => {
    expect(forbiddenUrl(url, rules)).not.toBeNull();
  });

  it.each([
    'https://github.com/acme/app/pull/7',
    'https://mail.google.com/mail/u/0/',
    'https://trello.com/b/abc',
    'https://www.orange.cm/fr/forfaits',
    'https://cuba.travel/',
    'https://example.org/blog',
    'http://localhost:3000/',
  ])('%s is allowed', (url) => {
    expect(forbiddenUrl(url, rules)).toBeNull();
  });
});

describe('forbidden apps', () => {
  it.each([
    'Terminal',
    'iTerm2',
    'Ghostty',
    'System Settings',
    'Keychain Access',
    '1Password',
    'Jarvis',
    'Orange Money',
    'terminal.app',
  ])('%s is never driven', (app) => expect(isForbiddenApp(app, rules)).toBe(true));
  it.each(['WhatsApp', 'Notes', 'Microsoft Word', 'Arc', 'Visual Studio Code'])(
    '%s may be driven',
    (app) => expect(isForbiddenApp(app, rules)).toBe(false),
  );
});

describe('engagement level of a click', () => {
  it.each([
    ['Payer 5 000 FCFA', 4, 'computer.deny.payment'],
    ['Buy now', 4, 'computer.deny.payment'],
    ['Passer la commande', 4, 'computer.deny.payment'],
    ['Faire un don', 4, 'computer.deny.payment'],
    ['Supprimer le message', 2, 'computer.commit.destructive'],
    ['Merge pull request', 2, 'computer.commit.destructive'],
    ['Approve', 2, 'computer.commit.destructive'],
    ['Envoyer', 2, 'computer.commit'],
    ['Publier', 2, 'computer.commit'],
    ['Comment', 2, 'computer.commit'],
    ['Répondre', 2, 'computer.commit'],
    ['Tout accepter', 1, 'computer.act'],
    ['Accepter les cookies', 1, 'computer.act'],
    ['Fermer', 1, 'computer.act'],
    ['Rechercher', 1, 'computer.act'],
    ['Commentaires', 1, 'computer.act'],
    ['PayPal', 1, 'computer.act'],
  ])('"%s" → N%i (%s)', (label, level, rule) => {
    expect(engagementLevel(label, o())).toMatchObject({ level, rule });
  });

  it('allowlist lowers sending, never deleting/merging, never paying', () => {
    expect(engagementLevel('Envoyer', o(true)).level).toBe(1);
    expect(engagementLevel('Merge pull request', o(true)).level).toBe(2);
    expect(engagementLevel('Payer', o(true)).level).toBe(4);
  });

  it('a declared commit counts even without a label (icon buttons)', () => {
    expect(engagementLevel('', o(false, true))).toMatchObject({
      level: 2,
      rule: 'computer.commit',
    });
  });

  it('allowlists match host suffixes and app names', () => {
    expect(commitAllowedOn('https://trello.com/b/1', rules)).toBe(true);
    expect(commitAllowedOn('https://api.trello.com/x', rules)).toBe(true);
    expect(commitAllowedOn('https://nottrello.com/', rules)).toBe(false);
    expect(commitAllowedOn(null, rules)).toBe(false);
    expect(commitAllowedInApp('textedit', rules)).toBe(true);
    expect(commitAllowedInApp('WhatsApp', rules)).toBe(false);
  });
});

describe('keys', () => {
  it.each([
    ['Cmd+S', 'cmd+s'],
    ['alt+cmd+escape', 'option+cmd+escape'],
    ['command+shift+z', 'shift+cmd+z'],
    ['enter', 'return'],
    ['F5', 'f5'],
    ['hyper+a', null],
    ['cmd+', null],
    ['cmd+ab', null],
  ])('%s → %s', (spec, norm) => expect(normalizeKey(spec)).toBe(norm));

  it.each([
    ['cmd+space', 4],
    ['cmd+tab', 4],
    ['cmd+option+escape', 4],
    ['shift+cmd+q', 4],
    ['ctrl+right', 4],
    ['cmd+q', 2],
    ['cmd+delete', 2],
    ['cmd+z', 2],
    ['return', 2],
    ['cmd+return', 2],
    ['cmd+s', 1],
    ['tab', 1],
    ['down', 1],
  ])('%s → N%i', (key, level) => expect(keyLevel(key, o()).level).toBe(level));

  it('Return needs no confirmation in an allowlisted app; quitting still does', () => {
    expect(keyLevel('return', o(true)).level).toBe(1);
    expect(keyLevel('cmd+q', o(true)).level).toBe(2);
  });
});

describe('secret fields', () => {
  it.each([
    { type: 'password' },
    { type: 'PASSWORD' },
    { autocomplete: 'section-pay cc-number' },
    { autocomplete: 'one-time-code' },
    { name: 'user_pwd' },
    { name: 'otp' },
    { label: 'Mot de passe' },
    { label: 'Code PIN' },
    { name: 'cvc' },
    { name: 'iban' },
    { secure: true },
  ])('%o is secret', (f) => expect(isSecretField(f)).toBe(true));

  it.each([
    { name: 'email', autocomplete: 'username' },
    { name: 'comment[body]', label: 'Add a comment' },
    { label: 'Pinned' },
  ])('%o is not', (f) => expect(isSecretField(f)).toBe(false));
});
