import { describe, expect, it } from 'vitest';
import { MemoryStore, Redactor } from '../src/index.ts';

describe('Redactor', () => {
  it('removes registered secret values everywhere', () => {
    const r = new Redactor();
    r.register('claude_oauth_token', 'canary-7f3a9c1e5b');
    expect(r.redact('token=canary-7f3a9c1e5b and again canary-7f3a9c1e5b')).not.toContain(
      'canary-7f3a9c1e5b',
    );
  });

  it('ignores values too short to be safely matched', () => {
    const r = new Redactor();
    r.register('pin', '1234');
    expect(r.redact('room 1234')).toBe('room 1234');
  });

  it.each([
    ['sk-ant-oat01-abcdefghijklmnop'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['github_pat_11ABCDEFG0123456789_abcdefghij'],
    ['xoxb-1234567890-abcdefghij'],
    ['AKIAABCDEFGHIJKLMNOP'],
    ['123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'],
    [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
  ])('redacts token-shaped value %s', (token) => {
    expect(new Redactor().redact(`value: ${token} end`)).not.toContain(token);
  });

  it('redacts private keys', () => {
    const key =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----';
    expect(new Redactor().redact(`x\n${key}\ny`)).toBe('x\n[REDACTED:private_key]\ny');
  });

  it('keeps the key name but drops assigned secret values', () => {
    expect(new Redactor().redact('DB_PASSWORD=supersecretvalue')).toBe('DB_PASSWORD=[REDACTED]');
    expect(new Redactor().redact('"api_key": "abcdefgh12345"')).toBe('"api_key": "[REDACTED]"');
  });
});

describe('MemoryStore', () => {
  it('rejects names outside the safe charset', () => {
    const s = new MemoryStore();
    expect(() => s.set('../evil', 'x')).toThrow(/invalid secret name/);
  });
});
