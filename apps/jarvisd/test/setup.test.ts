import { describe, expect, it } from 'vitest';
import { accountIdFor, githubTokenUrl, gitlabTokenUrl } from '../src/setup.ts';

describe('setup links', () => {
  it('GitHub fine-grained token template: least privilege, one owner per token', () => {
    const u = new URL(githubTokenUrl('scriptify-cm'));
    expect(u.origin + u.pathname).toBe('https://github.com/settings/personal-access-tokens/new');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      target_name: 'scriptify-cm',
      expires_in: '366',
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      checks: 'read',
      metadata: 'read',
    });
    expect(u.searchParams.has('administration')).toBe(false);
    expect(u.searchParams.has('secrets')).toBe(false);
    expect(new URL(githubTokenUrl()).searchParams.has('target_name')).toBe(false);
  });
  it('GitLab token page with name and scopes', () => {
    expect(gitlabTokenUrl('https://gitlab.example.cm/')).toBe(
      'https://gitlab.example.cm/-/user_settings/personal_access_tokens?name=Jarvis&scopes=api,read_user',
    );
  });
});

describe('several Gmail accounts', () => {
  it('derives a stable, unique account id from the address', () => {
    expect(accountIdFor('BrightEfoo@gmail.com', ['perso'])).toBe('brightefoo');
    expect(accountIdFor('brightefoo@gmail.com', ['perso', 'brightefoo'])).toBe('brightefoo-2');
    expect(accountIdFor('jean.paul+pro@gmail.com', [])).toBe('jean-paul-pro');
  });
});
