import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentSpecs, DAEMON_LABEL, plist, VOICE_LABEL } from '../src/service.ts';

const paths = {
  agentsDir: '/a',
  logsDir: '/Users/b/Library/Logs/Jarvis',
  cli: '/repo/apps/jarvisd/src/cli.ts',
  voiceBinary: '/repo/voice/Jarvis Voice.app/Contents/MacOS/jarvis-voice',
};

describe('launchd agents', () => {
  it('runs the daemon with the absolute Node, at login, restarted, interactive priority', () => {
    const [daemon] = agentSpecs(paths, { dev: false, voice: false, node: '/n/node' });
    expect(daemon).toMatchObject({
      label: DAEMON_LABEL,
      program: ['/n/node', paths.cli, 'daemon'],
      interactive: true,
    });
    expect(
      agentSpecs(paths, { dev: true, voice: true, node: '/n/node' }).map((s) => [
        s.label,
        s.program.at(-1),
      ]),
    ).toEqual([
      [DAEMON_LABEL, '--dev'],
      [VOICE_LABEL, paths.voiceBinary],
    ]);
  });

  it('writes a valid plist that never inherits the shell environment', () => {
    const [daemon] = agentSpecs(paths, { dev: false, voice: false, node: '/n/node' });
    if (!daemon) throw new Error('no daemon spec');
    const xml = plist(daemon);
    for (const key of [
      'RunAtLoad',
      'KeepAlive',
      'ThrottleInterval',
      'LimitLoadToSessionType',
      'StandardOutPath',
    ])
      expect(xml).toContain(`<key>${key}</key>`);
    expect(xml).toContain('<string>/usr/bin:/bin:/usr/sbin:/sbin</string>');
    expect(xml).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  it.skipIf(process.platform !== 'darwin')('passes plutil -lint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-plist-'));
    const f = join(dir, 'x.plist');
    writeFileSync(f, plist({ label: 'a&b', program: ['/x <y>'], log: '/l', interactive: false }));
    expect(execFileSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' })).toContain('OK');
    rmSync(dir, { recursive: true, force: true });
  });
});
