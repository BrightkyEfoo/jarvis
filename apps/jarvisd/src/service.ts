import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * launchd LaunchAgents (user session, not root): jarvisd and the voice app start at login and
 * come back if they die. LaunchAgent rather than LaunchDaemon on purpose: Jarvis needs Brightky's
 * Keychain and GUI session (open, osascript, microphone) and must never run as root.
 */

export const DAEMON_LABEL = 'cm.brightkyefoo.jarvisd';
export const VOICE_LABEL = 'cm.brightkyefoo.jarvis.voice';

export interface AgentSpec {
  label: string;
  program: string[];
  log: string;
  /** Interactive = scheduled for low latency (it answers a human). */
  interactive: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist(spec: AgentSpec): string {
  const args = spec.program.map((a) => `\t\t<string>${esc(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${esc(spec.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>15</integer>
\t<key>LimitLoadToSessionType</key>
\t<string>Aqua</string>
\t<key>ProcessType</key>
\t<string>${spec.interactive ? 'Interactive' : 'Background'}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/usr/bin:/bin:/usr/sbin:/sbin</string>
\t\t<key>LANG</key>
\t\t<string>fr_FR.UTF-8</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${esc(spec.log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${esc(spec.log)}</string>
</dict>
</plist>
`;
}

export interface ServicePaths {
  agentsDir: string;
  logsDir: string;
  cli: string;
  voiceBinary: string;
}

export function servicePaths(): ServicePaths {
  return {
    agentsDir: join(homedir(), 'Library', 'LaunchAgents'),
    logsDir: join(homedir(), 'Library', 'Logs', 'Jarvis'),
    cli: resolve(import.meta.dirname, 'cli.ts'),
    voiceBinary: resolve(
      import.meta.dirname,
      '../../voice/build/Jarvis Voice.app/Contents/MacOS/jarvis-voice',
    ),
  };
}

/** The agents to install. `node` is the absolute Node 24 running this CLI, never a PATH lookup. */
export function agentSpecs(
  p: ServicePaths,
  opts: { dev: boolean; voice: boolean; node: string },
): AgentSpec[] {
  const specs: AgentSpec[] = [
    {
      label: DAEMON_LABEL,
      program: [opts.node, p.cli, 'daemon', ...(opts.dev ? ['--dev'] : [])],
      log: join(p.logsDir, 'jarvisd.log'),
      interactive: true,
    },
  ];
  if (opts.voice)
    specs.push({
      label: VOICE_LABEL,
      program: [p.voiceBinary],
      log: join(p.logsDir, 'voice.log'),
      interactive: true,
    });
  return specs;
}

const domain = () => `gui/${userInfo().uid}`;

function launchctl(args: string[], tolerate = false): string {
  try {
    return execFileSync('/bin/launchctl', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (tolerate) return '';
    throw e;
  }
}

export function install(specs: AgentSpec[], p: ServicePaths): string[] {
  mkdirSync(p.agentsDir, { recursive: true });
  mkdirSync(p.logsDir, { recursive: true, mode: 0o700 });
  const done: string[] = [];
  for (const s of specs) {
    const file = join(p.agentsDir, `${s.label}.plist`);
    writeFileSync(file, plist(s), { mode: 0o644 });
    execFileSync('/usr/bin/plutil', ['-lint', file], { stdio: 'ignore' });
    launchctl(['bootout', `${domain()}/${s.label}`], true); // replace a previous version
    launchctl(['bootstrap', domain(), file]);
    launchctl(['enable', `${domain()}/${s.label}`], true);
    done.push(file);
  }
  return done;
}

export function uninstall(p: ServicePaths): string[] {
  const removed: string[] = [];
  for (const label of [VOICE_LABEL, DAEMON_LABEL]) {
    const file = join(p.agentsDir, `${label}.plist`);
    launchctl(['bootout', `${domain()}/${label}`], true);
    if (existsSync(file)) {
      rmSync(file);
      removed.push(file);
    }
  }
  return removed;
}

export function status(): {
  label: string;
  state: string;
  pid: string | null;
  lastExit: string | null;
}[] {
  return [DAEMON_LABEL, VOICE_LABEL].map((label) => {
    const out = launchctl(['print', `${domain()}/${label}`], true);
    if (!out) return { label, state: 'not installed', pid: null, lastExit: null };
    return {
      label,
      state: /state = (\S+)/.exec(out)?.[1] ?? 'unknown',
      pid: /pid = (\d+)/.exec(out)?.[1] ?? null,
      lastExit: /last exit code = (.+)/.exec(out)?.[1]?.trim() ?? null,
    };
  });
}
