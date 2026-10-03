import { randomBytes } from 'node:crypto';
import { type Redactor, SecretName, type SecretStore } from '@jarvis/secrets';

export const VAULT_NAME = /^[a-z0-9_.-]{1,40}$/;

/**
 * Brightky's vault: values he types once (`jarvis vault set`), kept in the Keychain. The model only
 * ever sees names; a value is read inside a handler, registered with the redactor, and sent where
 * it belongs (a repository secret, a deploy webhook).
 */
export class Vault {
  readonly #store: SecretStore;
  readonly #redactor: Redactor;

  constructor(store: SecretStore, redactor: Redactor) {
    this.#store = store;
    this.#redactor = redactor;
  }

  names(): string[] {
    try {
      const raw = this.#store.get(SecretName.vaultIndex);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list)
        ? list.filter((n): n is string => typeof n === 'string').sort()
        : [];
    } catch {
      return [];
    }
  }

  set(name: string, value: string): void {
    if (!VAULT_NAME.test(name))
      throw new Error('nom invalide : minuscules, chiffres, . _ - (40 max)');
    if (!value) throw new Error('valeur vide');
    this.#store.set(SecretName.vault(name), value);
    const names = new Set(this.names());
    names.add(name);
    this.#store.set(SecretName.vaultIndex, JSON.stringify([...names]));
  }

  delete(name: string): boolean {
    if (!VAULT_NAME.test(name)) return false;
    const gone = this.#store.delete(SecretName.vault(name));
    this.#store.set(SecretName.vaultIndex, JSON.stringify(this.names().filter((n) => n !== name)));
    return gone;
  }

  /** The value, registered with the redactor first so it can never show up in output or audit. */
  read(name: string): string {
    if (!VAULT_NAME.test(name)) throw new Error('nom de coffre invalide');
    const v = this.#store.get(SecretName.vault(name));
    if (!v) throw new Error(`« ${name} » n'est pas dans le coffre : jarvis vault set ${name}`);
    this.#redactor.register(`vault:${name}`, v);
    return v;
  }
}

/** A random secret (URL-safe), registered with the redactor too. */
export function generatedSecret(redactor: Redactor, bytes = 32): string {
  const v = randomBytes(bytes).toString('base64url');
  redactor.register('generated', v);
  return v;
}
