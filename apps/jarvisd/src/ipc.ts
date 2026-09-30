import type { Socket } from 'node:net';

export type { Request } from './ipc-schema.ts';

export type Reply =
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'tool'; name: string }
  | { id: string; type: 'approval'; request: ApprovalView }
  | {
      id: string;
      type: 'approval_resolved';
      approvalId: string;
      approved: boolean;
      channel: string;
    }
  | { id: string; type: 'done'; data?: unknown }
  | { id: string; type: 'error'; error: string };

export interface ApprovalView {
  id: string;
  tool: string;
  level: number;
  rule: string;
  summary: string;
  reason: string;
  needsPin: boolean;
  tainted: boolean;
  externalDestinations: string[];
  expiresAt: number;
}

export const MAX_LINE = 64 * 1024;

/** Newline-delimited JSON over a stream socket. Oversized lines kill the connection. */
export function onLines(socket: Socket, handle: (line: string) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes('\n')) {
      socket.destroy();
      return;
    }
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) handle(line);
      nl = buf.indexOf('\n');
    }
  });
}

export const writeLine = (socket: Socket, msg: unknown): void => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
};
