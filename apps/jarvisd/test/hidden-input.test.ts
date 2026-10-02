import { describe, expect, it } from 'vitest';
import { HiddenInput } from '../src/hidden-input.ts';

const TOKEN = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghij';

function feedAll(...chunks: string[]) {
  const input = new HiddenInput();
  let last: ReturnType<HiddenInput['feed']> = { state: 'more', echo: '' };
  let echo = '';
  for (const c of chunks) {
    last = input.feed(c);
    echo += last.echo;
    if (last.state !== 'more') break;
  }
  return { value: input.value, state: last.state, echo };
}

describe('hidden input', () => {
  it('typed characters, one by one, then Enter; shows only bullets', () => {
    const r = feedAll(...'abc'.split(''), '\r');
    expect(r).toEqual({ value: 'abc', state: 'done', echo: '•••' });
  });

  it('a bracketed paste (iTerm, Terminal, zsh) keeps the token intact', () => {
    expect(feedAll(`\x1b[200~${TOKEN}\x1b[201~`, '\r')).toMatchObject({
      value: TOKEN,
      state: 'done',
    });
  });

  it('a token copied across two lines is one token; Enter after the paste ends it', () => {
    const [a, b] = [TOKEN.slice(0, 30), TOKEN.slice(30)];
    expect(feedAll(`\x1b[200~${a}\n${b}\x1b[201~`, '\r')).toMatchObject({
      value: TOKEN,
      state: 'done',
    });
    // Terminal without bracketed paste: the newline arrives inside one chunk.
    expect(feedAll(`${a}\n${b}`, '\r')).toMatchObject({ value: TOKEN, state: 'done' });
    // A paste ending with a newline counts as Enter.
    expect(feedAll(`${TOKEN}\n`)).toMatchObject({ value: TOKEN, state: 'done' });
  });

  it('backspace, Ctrl-U, arrow keys, Ctrl-C', () => {
    expect(feedAll('ab', '\u007f', 'c', '\r')).toMatchObject({ value: 'ac' });
    expect(feedAll('abc', '\u0015', 'x', '\r')).toMatchObject({ value: 'x' });
    expect(feedAll('a', '\x1b[D', '\x1b[A', 'b', '\r')).toMatchObject({ value: 'ab' });
    expect(feedAll('abc', '\u0003')).toMatchObject({ state: 'abort' });
  });

  it('Enter alone gives an empty value (the CLI then reads the clipboard)', () => {
    expect(feedAll('\r')).toEqual({ value: '', state: 'done', echo: '' });
  });
});
