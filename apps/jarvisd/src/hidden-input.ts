/**
 * Keystrokes / pasted text → value, for secrets typed in raw mode. Pure, so it is tested
 * without a terminal. Handles what real terminals send:
 * - bracketed paste (ESC[200~ … ESC[201~), which zsh, iTerm and Terminal can leave enabled;
 * - a token copied across two lines (newline inside a paste is not "Enter");
 * - arrow keys and other escape sequences (ignored), backspace, Ctrl-U, Ctrl-C.
 */
const ESC = '\x1b';
/** CSI / SS3 / two-byte escape sequences (arrows, function keys…), anchored at the start. */
const ESCAPE_SEQ = new RegExp(`^${ESC}(\\[[0-9;?]*[ -/]*[@-~]|O.|.)?`);
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

export class HiddenInput {
  value = '';
  #pasting = false;

  /** Returns what happened; `echo` is what to print (a mask, never the secret). */
  feed(chunk: string): { state: 'more' | 'done' | 'abort'; echo: string } {
    let echo = '';
    let rest = chunk;
    // A multi-character chunk without paste markers is a paste too (terminals without 2004).
    const looksPasted = chunk.length > 1 && !chunk.startsWith(ESC);
    while (rest.length > 0) {
      if (rest.startsWith(PASTE_START)) {
        this.#pasting = true;
        rest = rest.slice(6);
        continue;
      }
      if (rest.startsWith(PASTE_END)) {
        this.#pasting = false;
        rest = rest.slice(6);
        continue;
      }
      const esc = ESCAPE_SEQ.exec(rest);
      if (esc) {
        rest = rest.slice(esc[0].length);
        continue;
      }
      const c = rest[0] as string;
      rest = rest.slice(1);
      if (c === '\u0003') return { state: 'abort', echo };
      if (c === '\r' || c === '\n') {
        // Enter ends the input only when typed, or as the very last character of a paste.
        if (
          this.#pasting ||
          (looksPasted &&
            rest
              .split(PASTE_END)
              .join('')
              .replace(/[\r\n]/g, '').length > 0)
        )
          continue;
        return { state: 'done', echo };
      }
      if (c === '\u007f' || c === '\b') {
        if (this.value.length > 0) {
          this.value = this.value.slice(0, -1);
          echo += '\b \b';
        }
        continue;
      }
      if (c === '\u0015') {
        echo += '\b \b'.repeat(this.value.length);
        this.value = '';
        continue;
      }
      if (c < ' ') continue;
      this.value += c;
      echo += '•';
    }
    return { state: 'more', echo };
  }
}
