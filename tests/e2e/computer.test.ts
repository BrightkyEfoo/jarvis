import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActuatorAction } from '../../apps/jarvisd/src/computer/bridge.ts';
import type { Reply } from '../../apps/jarvisd/src/ipc.ts';
import { connectFakeApp, type FakeApp, type Harness, startHarness } from './harness.ts';

const PAGE = {
  tab: 'T1',
  url: 'https://github.com/acme/app/pull/7',
  title: 'Fix login #7',
  text: 'Fix login\n[1] button "Comment"\n…',
  elements: [
    { id: 1, tag: 'button', label: 'Comment', fingerprint: 'f1' },
    { id: 2, tag: 'a', label: 'Wiki', href: '/acme/app/wiki', fingerprint: 'f2' },
    { id: 3, tag: 'input', type: 'password', name: 'pw', label: 'Password', fingerprint: 'f3' },
    { id: 4, tag: 'button', label: 'Merge pull request', fingerprint: 'f4' },
    { id: 5, tag: 'button', label: 'Payer 5 000 FCFA', fingerprint: 'f5' },
    { id: 6, tag: 'textarea', name: 'comment[body]', label: 'Add a comment', fingerprint: 'f6' },
    { id: 7, tag: 'a', label: 'Sponsor', href: 'https://www.paypal.com/donate', fingerprint: 'f7' },
    { id: 8, tag: 'button', label: '', fingerprint: 'f8' },
  ],
};

const LOOK = {
  app: 'WhatsApp',
  window: 'Discussions',
  width: 1200,
  height: 800,
  // Bigger than the 64 KiB line limit of ordinary clients.
  image: 'A'.repeat(1_500_000),
  elements: [
    { id: 1, role: 'AXButton', label: 'Envoyer', secure: false, x: 1100, y: 760 },
    { id: 2, role: 'AXTextField', label: 'Message', secure: false, x: 600, y: 760 },
    { id: 3, role: 'AXTextField', label: 'Code', secure: true, x: 10, y: 10 },
  ],
};

let page = PAGE as { url: string } & typeof PAGE;
let hang = false;

function answer(a: ActuatorAction): unknown {
  switch (a.kind) {
    case 'browser.tabs':
      return {
        tabs: [
          { id: 'T1', window: 1, title: PAGE.title, url: PAGE.url, active: true },
          {
            id: 'T2',
            window: 1,
            title: 'Mon compte — solde 1 234 567',
            url: 'https://www.afrilandfirstbank.com/compte',
            active: false,
          },
        ],
      };
    case 'browser.read':
      return hang ? new Promise(() => undefined) : page;
    case 'browser.open':
    case 'browser.click':
    case 'browser.fill':
      return { url: PAGE.url };
    case 'screen.look':
      if (a.display !== undefined) {
        return {
          display: a.display,
          displays: 2,
          width: 1512,
          height: 982,
          image: 'B'.repeat(200_000),
          windows: [{ app: 'Safari', title: 'GitHub', x: 0, y: 30, width: 1200, height: 900 }],
        };
      }
      return { ...LOOK, app: a.app ?? 'WhatsApp' };
    case 'screen.probe': {
      const target = a.app.toLowerCase() === 'textedit' ? 'TextEdit' : 'WhatsApp';
      const label = a.element === 2 ? 'Message' : a.element === 3 ? 'Code' : 'Envoyer';
      return { app: target, target, role: 'AXButton', label, secure: a.element === 3 };
    }
    case 'screen.act':
      return {};
    case 'apps.windows':
      return {
        displays: [
          { index: 1, width: 1512, height: 982 },
          { index: 2, width: 1920, height: 1080 },
        ],
        windows: [
          {
            app: 'Safari',
            display: 1,
            protected: false,
            title: 'GitHub   —  PR',
            x: 0,
            y: 30,
            width: 1200,
            height: 900,
          },
          { app: 'Terminal', display: 1, protected: true, x: 10, y: 40, width: 800, height: 500 },
          {
            app: 'Slack',
            display: 2,
            protected: false,
            title: 'général',
            x: 0,
            y: 0,
            width: 1920,
            height: 1050,
          },
        ],
        apps: [
          { app: 'Safari', active: true, hidden: false, windows: 1, protected: false },
          { app: 'Terminal', active: false, hidden: false, windows: 1, protected: true },
          { app: 'Slack', active: false, hidden: false, windows: 1, protected: false },
          { app: 'Mail', active: false, hidden: true, windows: 0, protected: false },
        ],
      };
    case 'apps.quit':
      return {
        quit: a.apps.filter((n) => n !== 'TextEdit'),
        still_running: a.apps.filter((n) => n === 'TextEdit'),
        refused: [],
        not_running: [],
      };
    case 'window.manage':
      return { app: a.app };
    default:
      throw new Error(`unexpected ${a.kind}`);
  }
}

let h: Harness;
let app: FakeApp;
beforeEach(async () => {
  page = PAGE;
  hang = false;
  h = await startHarness();
  app = await connectFakeApp(h.socket, answer);
});
afterEach(async () => {
  app.close();
  await h.close();
});

const text = (events: Reply[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
async function ask(script: string) {
  const c = await h.rpc();
  const r = await c.call({ cmd: 'ask', text: script });
  c.close();
  return text(r.events);
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sent = (kind: ActuatorAction['kind']) => app.actions.filter((a) => a.kind === kind);

describe('browser', () => {
  it('lists tabs with off-limits sites masked, and taints the session', async () => {
    const out = await ask('call browser_tabs {}');
    expect(out).toContain('* tab T1 (window 1)\tFix login #7\thttps://github.com/acme/app/pull/7');
    expect(out).toContain('[off-limits site]\twww.afrilandfirstbank.com');
    expect(out).not.toContain('solde');
    expect(h.rt.brain?.session.tainted).toBe(true);
  });

  it('never opens banking / payment / account-security sites', async () => {
    for (const url of [
      'https://www.paypal.com/myaccount',
      'https://myaccount.google.com/security',
      'https://github.com/settings/tokens',
      'https://ebanking.ecobank.com',
      'file:///etc/passwd',
    ]) {
      expect(await ask(`call browser_open {"url":"${url}"}`)).toMatch(/^KO Action refused \(N4/);
    }
    expect(sent('browser.open')).toHaveLength(0);
    expect(await ask('call browser_open {"url":"https://github.com/acme/app"}')).toContain(
      'OK Opened',
    );
    expect(sent('browser.open')[0]).toMatchObject({
      browser: 'Arc',
      url: 'https://github.com/acme/app',
      newTab: true,
    });
  });

  it('reads a page as external data; refuses to return a forbidden page', async () => {
    const out = await ask('call browser_read {}');
    expect(out).toContain('<external_data source="browser_read">');
    expect(out).toContain('URL: https://github.com/acme/app/pull/7');
    page = { ...PAGE, url: 'https://www.paypal.com/activity', text: 'balance 9 999 €' };
    const refused = await ask('call browser_read {}');
    expect(refused).toContain('rule computer.deny.site_read');
    expect(refused).not.toContain('9 999');
  });

  it('clicks plain links without asking; commits wait for Brightky', async () => {
    expect(await ask('call browser_click {"element":2}')).toContain('read the page first');
    expect(await ask('call browser_read {}\ncall browser_click {"element":2}')).toContain(
      'OK Clicked a "Wiki"',
    );
    expect(sent('browser.click')[0]).toMatchObject({ tab: 'T1', element: 2, fingerprint: 'f2' });

    // "Comment" engages Brightky: detected from the label even without commit: true.
    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: 'call browser_read {}\ncall browser_click {"element":1}',
    });
    const req = await waitFor(() => h.rt.approvals.pending()[0]);
    expect(req).toMatchObject({ level: 2, rule: 'computer.commit', tool: 'browser_click' });
    expect(req.summary).toBe('Click button "Comment" on github.com');
    expect(sent('browser.click')).toHaveLength(1);
    const approver = await h.rpc();
    await approver.call({ cmd: 'approve', approvalId: req.id });
    expect(text((await pending).events)).toContain('OK Clicked button "Comment"');
    expect(sent('browser.click')[1]).toMatchObject({ element: 1, fingerprint: 'f1' });
    c.close();
    approver.close();
  });

  it('an icon-only button declared as commit is confirmed too', async () => {
    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: 'call browser_read {}\ncall browser_click {"element":8,"commit":true}',
    });
    const req = await waitFor(() => h.rt.approvals.pending()[0]);
    expect(req.rule).toBe('computer.commit');
    await (await h.rpc()).call({ cmd: 'deny', approvalId: req.id });
    expect(text((await pending).events)).toContain('KO Action refused');
    expect(sent('browser.click')).toHaveLength(0);
  });

  it('refuses payments, payment links and password fields; merge is always confirmed', async () => {
    const out = await ask(
      [
        'call browser_read {}',
        'call browser_click {"element":5}',
        'call browser_click {"element":7}',
        'call browser_fill {"element":3,"text":"hunter2"}',
      ].join('\n'),
    );
    expect(out).toContain('rule computer.deny.payment');
    expect(out).toContain('rule computer.deny.site');
    expect(out).toContain('rule computer.deny.secret_field');
    expect(sent('browser.click')).toHaveLength(0);
    expect(sent('browser.fill')).toHaveLength(0);

    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: 'call browser_read {}\ncall browser_click {"element":4}',
    });
    const req = await waitFor(() => h.rt.approvals.pending()[0]);
    expect(req.rule).toBe('computer.commit.destructive');
    await (await h.rpc()).call({ cmd: 'deny', approvalId: req.id });
    await pending;
  });

  it('fills ordinary fields without asking (it does not submit)', async () => {
    const out = await ask(
      'call browser_read {}\ncall browser_fill {"element":6,"text":"LGTM, merci"}',
    );
    expect(out).toContain('OK Filled textarea "Add a comment"');
    expect(sent('browser.fill')[0]).toMatchObject({
      element: 6,
      fingerprint: 'f6',
      text: 'LGTM, merci',
    });
  });

  it('STOP cancels an action in flight inside Jarvis.app', async () => {
    hang = true;
    const c = await h.rpc();
    const pending = c.call({ cmd: 'ask', text: 'call browser_read {}' });
    await waitFor(() => sent('browser.read')[0]);
    h.rt.stop('test');
    expect(text((await pending).events)).toContain('KO Tool error: aborted');
    await waitFor(() => app.cancelled[0]);
    c.close();
  });
});

describe('screen (any app)', () => {
  it('returns the screenshot to the model but only its hash to the audit log', async () => {
    const out = await ask('call screen_look {"app":"WhatsApp"}');
    expect(out).toContain('[1] Button "Envoyer" @ (1100, 760)');
    expect(out).toContain('[3] TextField "Code" (secure)');
    expect(out).toContain('[images:1]');
    const row = h.rt.audit.query({ limit: 5, tool: 'screen_look', event: 'result' })[0];
    const data = row?.data as { images: { sha256: string; bytes: number }[] };
    expect(data.images[0]?.bytes).toBe(1_125_000);
    expect(JSON.stringify(h.rt.audit.query({ limit: 20 }))).not.toContain('AAAAAAAA');
  });

  it('never looks at or drives Terminal, settings, password managers or Jarvis', async () => {
    for (const a of ['Terminal', 'System Settings', '1Password', 'Jarvis', 'Keychain Access']) {
      expect(await ask(`call screen_look {"app":"${a}"}`)).toContain('rule computer.deny.app');
    }
    expect(await ask('call screen_act {"app":"iTerm2","action":"key","key":"return"}')).toContain(
      'rule computer.deny.app',
    );
    expect(sent('screen.look')).toHaveLength(0);
  });

  it('refuses keys that leave the app; Return and "Envoyer" are commits', async () => {
    const out = await ask(
      [
        'call screen_look {"app":"WhatsApp"}',
        'call screen_act {"app":"WhatsApp","action":"key","key":"cmd+space"}',
        'call screen_act {"app":"WhatsApp","action":"key","key":"cmd+tab"}',
        'call screen_act {"app":"WhatsApp","action":"type","element":3,"text":"123456"}',
      ].join('\n'),
    );
    expect(out.match(/rule computer\.deny\.system_key/g)).toHaveLength(2);
    expect(out).toContain('rule computer.deny.secret_field');

    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: 'call screen_look {"app":"WhatsApp"}\ncall screen_act {"app":"WhatsApp","action":"click","element":1}',
    });
    const req = await waitFor(() => h.rt.approvals.pending()[0]);
    expect(req).toMatchObject({
      rule: 'computer.commit',
      summary: 'Click Button "Envoyer" in WhatsApp',
    });
    await (await h.rpc()).call({ cmd: 'approve', approvalId: req.id });
    expect(text((await pending).events)).toContain('OK Done in WhatsApp');
    expect(sent('screen.act')).toHaveLength(1);
  });

  it('what is really under the pointer decides: an undeclared "Envoyer" is refused', async () => {
    const out = await ask(
      'call screen_look {"app":"WhatsApp"}\ncall screen_act {"app":"WhatsApp","action":"click","x":50,"y":50}',
    );
    expect(out).toContain('rule computer.screen.undeclared_commit');
    expect(out).toContain('ask again with commit: true');
    expect(sent('screen.probe')).toHaveLength(1);
    expect(sent('screen.act')).toHaveLength(0);
  });

  it('types and presses Return without asking in allowlisted apps', async () => {
    const out = await ask(
      [
        'call screen_look {"app":"TextEdit"}',
        'call screen_act {"app":"TextEdit","action":"type","text":"ligne 1\\nligne 2"}',
      ].join('\n'),
    );
    expect(out).toContain('OK Done in TextEdit');
    expect(h.rt.approvals.pending()).toHaveLength(0);
  });
});

describe('the desk (windows, displays, quitting)', () => {
  it('lists windows per display; protected apps without titles; taints the session', async () => {
    const out = await ask('call windows_list {}');
    expect(out).toContain('Displays: 1 (1512×982, menu bar), 2 (1920×1080)');
    expect(out).toContain('- Safari — "GitHub — PR" @ (0, 30) 1200×900');
    expect(out).toContain('- Terminal [protected]');
    expect(out).toContain('Open without a visible window: Mail (hidden)');
    expect(h.rt.brain?.session.tainted).toBe(true);
  });

  it('quits apps in one confirmation, like ⌘Q; an app asking to save stays open', async () => {
    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: 'call app_quit {"apps":["Safari","Slack","TextEdit","Safari"]}',
    });
    const req = await waitFor(() => h.rt.approvals.pending()[0]);
    expect(req).toMatchObject({
      level: 2,
      rule: 'computer.app.quit',
      summary: 'Quit Safari, Slack, TextEdit',
    });
    expect(sent('apps.quit')).toHaveLength(0);
    await (await h.rpc()).call({ cmd: 'approve', approvalId: req.id });
    const out = text((await pending).events);
    expect(out).toContain('Quit: Safari, Slack.');
    expect(out).toContain('Still open (probably asking whether to save');
    expect(sent('apps.quit')[0]).toMatchObject({ apps: ['Safari', 'Slack', 'TextEdit'] });
    c.close();
  });

  it('never quits or arranges protected apps', async () => {
    expect(await ask('call app_quit {"apps":["Slack","Terminal"]}')).toContain(
      'rule computer.deny.app',
    );
    expect(await ask('call window_manage {"app":"1Password","action":"hide"}')).toContain(
      'rule computer.deny.app',
    );
    expect(sent('apps.quit')).toHaveLength(0);
    expect(sent('window.manage')).toHaveLength(0);
  });

  it('arranges windows without asking; closing a window asks', async () => {
    expect(await ask('call window_manage {"app":"Safari","action":"left","display":2}')).toContain(
      'OK Done: snap safari to the left half.',
    );
    expect(sent('window.manage')[0]).toMatchObject({ app: 'Safari', action: 'left', display: 2 });

    const c = await h.rpc();
    const pending = c.call({
      cmd: 'ask',
      text: 'call window_manage {"app":"Safari","action":"close"}',
    });
    const req = await waitFor(() => h.rt.approvals.pending()[0]);
    expect(req).toMatchObject({
      rule: 'computer.window.close',
      summary: 'Close the front window of Safari',
    });
    await (await h.rpc()).call({ cmd: 'deny', approvalId: req.id });
    await pending;
    expect(sent('window.manage')).toHaveLength(1);
    c.close();
  });

  it('looks at a whole display: image to the model, only its hash to the audit', async () => {
    const out = await ask('call screen_look {"display":1}');
    expect(out).toContain('Display 1 of 2 — image 1512×982 px');
    expect(out).toContain('- Safari — "GitHub" @ (0, 30) 1200×900');
    expect(out).toContain('[images:1]');
    expect(sent('screen.look')[0]).toEqual({ kind: 'screen.look', display: 1 });
    expect(JSON.stringify(h.rt.audit.query({ limit: 20 }))).not.toContain('BBBBBBBB');
    expect(await ask('call screen_look {"app":"Safari","display":1}')).toContain(
      'rule input.invalid',
    );
  });
});

describe('actuator link', () => {
  it('fails cleanly when Jarvis.app is not connected', async () => {
    app.close();
    await waitFor(() => (h.rt.bridge.connected ? undefined : true));
    expect(await ask('call notes_list {}')).toContain('Jarvis.app is not running');
  });

  it('only the registered connection can answer actions', async () => {
    hang = true;
    const intruder = await h.rpc();
    const c = await h.rpc();
    const pending = c.call({ cmd: 'ask', text: 'call browser_read {"max_chars":1000}\nsay after' });
    await waitFor(() => sent('browser.read')[0]);
    // Another client answering with the right request id is ignored: the read is still in flight.
    void intruder.raw(
      JSON.stringify({
        id: 'x',
        cmd: 'actuator_result',
        reqId: app.reqIds[0],
        ok: true,
        result: PAGE,
      }),
    );
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 150)),
    ]);
    expect(settled).toBe(false);
    h.rt.stop('end');
    expect(text((await pending).events)).toContain('KO Tool error: aborted');
    intruder.close();
    c.close();
  });

  it('shows up in status and in the audit log', async () => {
    const c = await h.rpc();
    const r = await c.call({ cmd: 'status' });
    expect(r.final).toMatchObject({ data: { actuator: { connected: true, version: 'test' } } });
    c.close();
    expect(
      h.rt.audit
        .query({ limit: 20 })
        .some((e) => e.event === 'system' && e.outcome === 'actuator_connected'),
    ).toBe(true);
  });
});
