import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppPaths {
  root: string;
  socket: string;
  auditDb: string;
  auditJsonl: string;
  memoryDb: string;
  stopFlag: string;
  pinState: string;
  outbox: string;
  /** Isolated CLAUDE_CONFIG_DIR: nothing from ~/.claude (hooks, MCP, memory, connectors) leaks in. */
  claudeConfig: string;
  /** Scratch space for the Agent SDK subprocess. */
  scratch: string;
  /** Worker queue (SQLite) and per-task logs. */
  workersDb: string;
  workerLogs: string;
  /** CLAUDE_CONFIG_DIR of the coding workers (separate from the brain's). */
  workerConfig: string;
}

export const DEFAULT_ROOT = join(homedir(), 'Library', 'Application Support', 'Jarvis');

export function appPaths(root = process.env.JARVIS_HOME ?? DEFAULT_ROOT): AppPaths {
  return {
    root,
    socket: join(root, 'run', 'jarvisd.sock'),
    auditDb: join(root, 'data', 'audit.db'),
    auditJsonl: join(root, 'data', 'audit.jsonl'),
    memoryDb: join(root, 'data', 'memory.db'),
    stopFlag: join(root, 'state', 'STOP'),
    pinState: join(root, 'state', 'pin-lock.json'),
    outbox: join(root, 'outbox'),
    claudeConfig: join(root, 'claude-config'),
    scratch: join(root, 'scratch'),
    workersDb: join(root, 'data', 'workers.db'),
    workerLogs: join(root, 'logs', 'workers'),
    workerConfig: join(root, 'worker-config'),
  };
}
