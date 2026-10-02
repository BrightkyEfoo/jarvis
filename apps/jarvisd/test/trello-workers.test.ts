import { describe, expect, it } from 'vitest';
import { cardRepo } from '../src/tools/trello-workers.ts';

describe('cardRepo', () => {
  const boards = { CodeVault: 'BrightkyEfoo/codevault', Scriptify: 'gitlab:scriptify/site' };
  it('reads "repo: …" from the card first, then the board mapping', () => {
    expect(cardRepo({ board: 'X', desc: 'Faire ça\nrepo: acme/app' }, boards)).toEqual({
      forge: 'github',
      repo: 'acme/app',
    });
    expect(cardRepo({ board: 'X', desc: 'Repository: gitlab:group/sub/proj' }, boards)).toEqual({
      forge: 'gitlab',
      repo: 'group/sub/proj',
    });
    expect(cardRepo({ board: 'codevault', desc: 'rien' }, boards)).toEqual({
      forge: 'github',
      repo: 'BrightkyEfoo/codevault',
    });
    expect(cardRepo({ board: 'Scriptify', desc: '' }, boards)).toEqual({
      forge: 'gitlab',
      repo: 'scriptify/site',
    });
  });
  it('nothing when unknown, and never a traversal', () => {
    expect(cardRepo({ board: 'Autre', desc: 'rien' }, boards)).toBeNull();
    expect(cardRepo({ board: 'X', desc: 'repo: acme/..' }, boards)).toBeNull();
  });
});
