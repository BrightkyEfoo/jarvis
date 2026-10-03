import { Entry } from '@napi-rs/keyring';

/** Names of every secret Jarvis knows about. Values never leave the handlers that need them. */
export const SecretName = {
  claudeOauthToken: 'claude_oauth_token',
  policySha256: 'policy_sha256',
  pinHash: 'pin_scrypt',
  /** Google "Desktop app" OAuth client (id + secret), JSON. */
  googleClient: 'google.client',
  googleRefreshToken: (account: string) => `google.${account}.refresh_token`,
  mailPassword: (account: string) => `mail.${account}.password`,
  /** Fine-grained personal access token (no admin rights). */
  githubToken: 'github.token',
  /** Fine-grained tokens cover one owner: one per organisation, plus the list of those owners. */
  githubOwnerToken: (owner: string) => `github.token.${owner.toLowerCase()}`,
  githubOwners: 'github.owners',
  gitlabToken: 'gitlab.token',
  trelloKey: 'trello.key',
  trelloToken: 'trello.token',
  /** LinkedIn developer app (client id + secret, JSON) and the member token (JSON, 60 days). */
  linkedinApp: 'linkedin.app',
  linkedinToken: 'linkedin.token',
  /** Values Brightky puts in Jarvis's vault (jarvis vault set): deploy tokens, CI secrets… */
  vault: (name: string) => `vault.${name}`,
  /** Names in the vault (the Keychain cannot list them). */
  vaultIndex: 'vault.index',
} as const;

export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): boolean;
}

const NAME_RE = /^[a-z0-9_.-]{1,64}$/;

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid secret name: ${JSON.stringify(name)}`);
}

/** macOS Keychain, one generic-password item per secret, service `jarvis.<name>`. */
export class KeychainStore implements SecretStore {
  readonly #account: string;

  constructor(account = 'jarvis') {
    this.#account = account;
  }

  #entry(name: string): Entry {
    assertName(name);
    return new Entry(`jarvis.${name}`, this.#account);
  }

  get(name: string): string | null {
    return this.#entry(name).getPassword() ?? null;
  }

  set(name: string, value: string): void {
    this.#entry(name).setPassword(value);
  }

  delete(name: string): boolean {
    return this.#entry(name).deletePassword();
  }
}

/** In-memory store for tests and dev mode. */
export class MemoryStore implements SecretStore {
  readonly #values = new Map<string, string>();

  get(name: string): string | null {
    assertName(name);
    return this.#values.get(name) ?? null;
  }

  set(name: string, value: string): void {
    assertName(name);
    this.#values.set(name, value);
  }

  delete(name: string): boolean {
    assertName(name);
    return this.#values.delete(name);
  }
}
