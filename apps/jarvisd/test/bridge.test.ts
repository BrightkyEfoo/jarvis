import { describe, expect, it } from 'vitest';
import { ActuatorBridge, type ActuatorLink } from '../src/computer/bridge.ts';

type Sent = Parameters<ActuatorLink['send']>[0];

function link(sent: Sent[]): ActuatorLink {
  return { version: '1', capabilities: ['browser'], send: (m) => sent.push(m) };
}

const tabs = { kind: 'browser.tabs', browser: 'Arc' } as const;

describe('ActuatorBridge', () => {
  it('fails at once when no app is attached', async () => {
    const b = new ActuatorBridge();
    expect(b.connected).toBe(false);
    await expect(b.perform(tabs, new AbortController().signal)).rejects.toThrow('not running');
  });

  it('routes a result to its request', async () => {
    const b = new ActuatorBridge();
    const sent: Sent[] = [];
    b.attach(link(sent));
    const p = b.perform(tabs, new AbortController().signal);
    const first = sent[0];
    if (!first || !('action' in first)) throw new Error('no action sent');
    b.settle('someone-else', true, 'nope');
    b.settle(first.reqId, true, { tabs: [] });
    await expect(p).resolves.toEqual({ tabs: [] });
  });

  it('passes the app error through, trimmed', async () => {
    const b = new ActuatorBridge();
    const sent: Sent[] = [];
    b.attach(link(sent));
    const p = b.perform(tabs, new AbortController().signal);
    b.settle(sent[0]?.reqId ?? '', false, undefined, 'x'.repeat(2000));
    await expect(p).rejects.toThrow(/^x{500}$/);
  });

  it('times out and tells the app to cancel', async () => {
    const b = new ActuatorBridge();
    const sent: Sent[] = [];
    b.attach(link(sent));
    await expect(b.perform(tabs, new AbortController().signal, 20)).rejects.toThrow(
      'did not answer',
    );
    expect(sent[1]).toMatchObject({ reqId: sent[0]?.reqId, cancel: true });
  });

  it('abort (STOP) cancels in flight', async () => {
    const b = new ActuatorBridge();
    const sent: Sent[] = [];
    b.attach(link(sent));
    const ac = new AbortController();
    const p = b.perform(tabs, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(sent.some((m) => 'cancel' in m)).toBe(true);
  });

  it('a new app replaces the old one and fails what the old one had in flight', async () => {
    const b = new ActuatorBridge();
    const oldSent: Sent[] = [];
    const detachOld = b.attach(link(oldSent));
    const p = b.perform(tabs, new AbortController().signal);
    const newSent: Sent[] = [];
    b.attach(link(newSent));
    await expect(p).rejects.toThrow('reconnected');
    detachOld(); // late close of the old socket must not detach the new app
    expect(b.connected).toBe(true);
  });

  it('detach fails pending requests', async () => {
    const b = new ActuatorBridge();
    const detach = b.attach(link([]));
    const p = b.perform(tabs, new AbortController().signal);
    detach();
    await expect(p).rejects.toThrow('disconnected');
    expect(b.connected).toBe(false);
  });
});
