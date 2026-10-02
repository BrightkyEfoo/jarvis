import {
  type Classification,
  commitAllowedInApp,
  commitAllowedOn,
  defineTool,
  engagementLevel,
  forbid,
  forbiddenUrl,
  isForbiddenApp,
  isSecretField,
  keyLevel,
  N0,
  N1,
  N2,
  type Policy,
  Refusal,
  type ScreenRules,
  screenRules,
  type ToolDef,
} from '@jarvis/policy';
import { z } from 'zod';
import {
  type Actuator,
  type ActuatorAction,
  type BrowserApp,
  WINDOW_ACTIONS,
  type WindowAction,
} from '../computer/bridge.ts';

// ── What Jarvis.app answers. Validated: the app is trusted, the pages it reads are not. ──

const label = z
  .string()
  .max(2000)
  .transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, 120));

/** Window titles come from other people's content (mail subjects, chats, pages). */
const title = z
  .string()
  .max(2000)
  .transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, 200));
const px = z.number().int();
const names = z.array(z.string().max(100)).max(50);

const PageElement = z.object({
  id: z.number().int().nonnegative(),
  tag: z.string().max(40),
  role: z.string().max(60).optional(),
  type: z.string().max(40).optional(),
  name: z.string().max(200).optional(),
  autocomplete: z.string().max(200).optional(),
  label,
  href: z.string().max(4096).optional(),
  submitsPost: z.boolean().optional(),
  fingerprint: z.string().min(1).max(200),
});
type PageElement = z.infer<typeof PageElement>;

const Results = {
  tabs: z.object({
    tabs: z
      .array(
        z.object({
          id: z.string().max(100),
          window: z.number().int(),
          title: z.string().max(2000),
          url: z.string().max(8192),
          active: z.boolean(),
        }),
      )
      .max(1000),
  }),
  page: z.object({
    tab: z.string().max(100),
    url: z.string().max(8192),
    title: z.string().max(2000),
    text: z.string().max(2_000_000),
    elements: z.array(PageElement).max(2000).default([]),
  }),
  acted: z.object({ url: z.string().max(8192).optional() }).passthrough(),
  notes: z.object({
    notes: z
      .array(
        z.object({
          id: z.string().max(300),
          name: z.string().max(500),
          folder: z.string().max(200),
          modified: z.string().max(40),
          locked: z.boolean(),
        }),
      )
      .max(500),
  }),
  note: z.object({
    id: z.string().max(300),
    name: z.string().max(500),
    folder: z.string().max(200),
    text: z.string().max(1_000_000),
    locked: z.boolean(),
  }),
  created: z.object({ id: z.string().max(300) }),
  reminders: z.object({
    reminders: z
      .array(
        z.object({
          id: z.string().max(300),
          name: z.string().max(1000),
          list: z.string().max(200),
          due: z.string().max(40).nullable().optional(),
          completed: z.boolean(),
          notes: z.string().max(5000).nullable().optional(),
        }),
      )
      .max(2000),
  }),
  look: z.object({
    app: z.string().max(100),
    window: z.string().max(500),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    image: z.string().min(1).max(12_000_000),
    elements: z
      .array(
        z.object({
          id: z.number().int().nonnegative(),
          role: z.string().max(60),
          label,
          secure: z.boolean(),
          x: z.number().int(),
          y: z.number().int(),
        }),
      )
      .max(400)
      .default([]),
  }),
  display: z.object({
    display: z.number().int().positive(),
    displays: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    image: z.string().min(1).max(12_000_000),
    windows: z
      .array(z.object({ app: z.string().max(100), title, x: px, y: px, width: px, height: px }))
      .max(100)
      .default([]),
  }),
  windows: z.object({
    displays: z
      .array(z.object({ index: z.number().int().positive(), width: px, height: px }))
      .max(16),
    windows: z
      .array(
        z.object({
          app: z.string().max(100),
          display: z.number().int().nonnegative(),
          protected: z.boolean(),
          title: title.optional(),
          x: px,
          y: px,
          width: px,
          height: px,
        }),
      )
      .max(300),
    apps: z
      .array(
        z.object({
          app: z.string().max(100),
          active: z.boolean(),
          hidden: z.boolean(),
          windows: z.number().int().nonnegative(),
          protected: z.boolean(),
        }),
      )
      .max(200),
  }),
  quit: z.object({
    quit: names,
    still_running: names,
    refused: names,
    not_running: names,
  }),
  managed: z.object({ app: z.string().max(100) }),
  probe: z.object({
    /** App owning the element under the point (or focused), and the app that was asked for. */
    app: z.string().max(100),
    target: z.string().max(100),
    role: z.string().max(60),
    subrole: z.string().max(60).optional(),
    label,
    secure: z.boolean(),
  }),
};

// ── Live state the classifiers rely on: the last page / screen Jarvis looked at. ──

interface PageSnapshot {
  tab: string;
  url: string;
  host: string;
  elements: Map<number, PageElement>;
}

interface ScreenElement {
  role: string;
  label: string;
  secure: boolean;
}

interface ScreenSnapshot {
  app: string;
  elements: Map<number, ScreenElement>;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '?';
  }
};

const elementLabel = (e: PageElement) =>
  e.label || e.name || (e.href ? hostOf(e.href) : '') || e.tag;

function describeElement(e: PageElement): string {
  const kind = e.type
    ? `${e.tag}[${e.type}]`
    : e.role && e.role !== e.tag
      ? `${e.tag}/${e.role}`
      : e.tag;
  return `${kind} "${elementLabel(e)}"`;
}

/** The app name Jarvis.app is asked to act in; matched case-insensitively there. */
const APP_NAME = /^[\p{L}\p{N} ._+&()'-]{1,60}$/u;

const WINDOW_SUMMARY: Record<WindowAction, string> = {
  front: 'Bring {app} to the front',
  hide: 'Hide {app}',
  show: 'Show {app}',
  minimize: 'Minimize {app}',
  restore: 'Restore {app}',
  fullscreen: 'Toggle full screen for {app}',
  maximize: 'Maximize {app}',
  left: 'Snap {app} to the left half',
  right: 'Snap {app} to the right half',
  top: 'Snap {app} to the top half',
  bottom: 'Snap {app} to the bottom half',
  center: 'Center {app}',
  close: 'Close the front window of {app}',
};

export interface ComputerToolDeps {
  policy: Policy;
  actuator: Actuator;
}

export function createComputerTools(d: ComputerToolDeps): ToolDef[] {
  const rules: ScreenRules = screenRules(d.policy.computer);
  const browser: BrowserApp = d.policy.computer.browser;
  let page: PageSnapshot | null = null;
  const screens = new Map<string, ScreenSnapshot>();

  const perform = async <T>(
    schema: z.ZodType<T>,
    action: ActuatorAction,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> => schema.parse(await d.actuator.perform(action, signal, timeoutMs));

  const checkSite = (url: string, rule: string) => {
    const why = forbiddenUrl(url, rules);
    if (why) throw new Refusal(rule, why);
  };

  const appGuard = (app: string): Classification | null => {
    if (!APP_NAME.test(app))
      return forbid('computer.invalid_app', 'unexpected characters in app name');
    if (isForbiddenApp(app, rules)) {
      return forbid(
        'computer.deny.app',
        `${app} is never driven (shell, system settings, credentials or Jarvis itself)`,
      );
    }
    return null;
  };

  // ── Browser (Brightky's own profile, through Apple Events) ──

  const browserTabs = defineTool({
    name: 'browser_tabs',
    description: `List the tabs open in ${browser} (id, title, URL). Off-limits sites are masked.`,
    input: {},
    classify: () => ({ level: N0, rule: 'computer.browser.tabs', reason: 'read-only' }),
    summarize: () => `List ${browser} tabs`,
    ingestsExternal: true,
    run: async (_a, ctx) => {
      const { tabs } = await perform(Results.tabs, { kind: 'browser.tabs', browser }, ctx.signal);
      if (tabs.length === 0) return `No ${browser} window open.`;
      return tabs
        .map((t) => {
          const masked = forbiddenUrl(t.url, rules) !== null;
          const title = masked ? '[off-limits site]' : t.title.slice(0, 120);
          const url = masked ? hostOf(t.url) : t.url.slice(0, 300);
          return `${t.active ? '*' : ' '} tab ${t.id} (window ${t.window})\t${title}\t${url}`;
        })
        .join('\n');
    },
  });

  const browserOpen = defineTool({
    name: 'browser_open',
    description:
      `Open a URL in ${browser} (Brightky's logged-in profile), in a new tab by default. ` +
      'Banking, payment, password and account-security sites are refused.',
    input: { url: z.string().max(4096), new_tab: z.boolean().optional() },
    classify: (a, ctx): Classification => {
      const why = forbiddenUrl(a.url, rules);
      if (why) return forbid('computer.deny.site', why);
      if (ctx.session.isExternalDestination(a.url)) {
        return {
          level: N2,
          rule: 'computer.browser.open_external',
          reason: 'URL comes from external content',
          destinations: [a.url],
        };
      }
      return {
        level: N1,
        rule: 'computer.browser.open',
        reason: 'opens a page',
        destinations: [a.url],
      };
    },
    summarize: (a) => `Open ${a.url} in ${browser}`,
    run: async (a, ctx) => {
      const url = new URL(a.url).href;
      await perform(
        Results.acted,
        { kind: 'browser.open', browser, url, newTab: a.new_tab ?? true },
        ctx.signal,
      );
      page = null;
      return `Opened ${url}. Read it with browser_read before acting on it.`;
    },
  });

  const browserRead = defineTool({
    name: 'browser_read',
    description:
      `Read the active ${browser} tab. mode "interactive" (default) lists the clickable/fillable elements ` +
      'as [n] markers inside the text, to use with browser_click / browser_fill; "text" returns the readable text only.',
    input: {
      mode: z.enum(['interactive', 'text']).optional(),
      max_chars: z.number().int().min(1000).max(200_000).optional(),
    },
    classify: () => ({ level: N0, rule: 'computer.browser.read', reason: 'reads the page' }),
    summarize: (a) => `Read the active ${browser} tab (${a.mode ?? 'interactive'})`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const mode = a.mode ?? 'interactive';
      const r = await perform(
        Results.page,
        { kind: 'browser.read', browser, mode, maxChars: a.max_chars ?? 40_000 },
        ctx.signal,
        45_000,
      );
      checkSite(r.url, 'computer.deny.site_read');
      page = {
        tab: r.tab,
        url: r.url,
        host: hostOf(r.url),
        elements: new Map(r.elements.map((e) => [e.id, e])),
      };
      return `URL: ${r.url}\nTitle: ${r.title}\n\n${r.text}`;
    },
  });

  const pageElement = (id: number): PageElement | Classification => {
    if (!page) return forbid('computer.browser.no_page', 'read the page first (browser_read)');
    const e = page.elements.get(id);
    return (
      e ??
      forbid(
        'computer.browser.unknown_element',
        `no element [${id}] in the last read: read the page again`,
      )
    );
  };

  const clickLevel = (e: PageElement, declared: boolean): Classification => {
    if (e.href) {
      const why = forbiddenUrl(new URL(e.href, page?.url).href, rules);
      if (why) return forbid('computer.deny.site', why);
    }
    const where = page?.host ?? '?';
    return engagementLevel(elementLabel(e), {
      declaredCommit: declared || e.submitsPost === true,
      allowlisted: commitAllowedOn(page?.url ?? null, rules),
      where,
    });
  };

  const browserClick = defineTool({
    name: 'browser_click',
    description:
      'Click element [n] from the last browser_read. Set commit: true when the click sends, publishes, ' +
      'deletes, books or validates something: Brightky confirms those (except on allowlisted sites). ' +
      'Payment buttons are always refused.',
    input: { element: z.number().int().nonnegative(), commit: z.boolean().optional() },
    classify: (a): Classification => {
      const e = pageElement(a.element);
      return 'level' in e ? e : clickLevel(e, a.commit ?? false);
    },
    summarize: (a) => {
      const e = page?.elements.get(a.element);
      return e ? `Click ${describeElement(e)} on ${page?.host}` : `Click element [${a.element}]`;
    },
    run: async (a, ctx) => {
      const e = pageElement(a.element);
      if ('level' in e || !page)
        throw new Refusal('computer.browser.no_page', 'read the page first');
      const r = await perform(
        Results.acted,
        {
          kind: 'browser.click',
          browser,
          tab: page.tab,
          element: a.element,
          fingerprint: e.fingerprint,
        },
        ctx.signal,
      );
      page = null; // the page may have changed: the next action needs a fresh read
      if (r.url) checkSite(r.url, 'computer.deny.site');
      return `Clicked ${describeElement(e)}.${r.url ? ` Now on ${r.url}.` : ''} Read the page again before the next action.`;
    },
  });

  const browserFill = defineTool({
    name: 'browser_fill',
    description:
      'Type text into field [n] from the last browser_read (replaces its content; does not submit). ' +
      'Password, one-time-code and card fields are always refused.',
    input: { element: z.number().int().nonnegative(), text: z.string().max(20_000) },
    classify: (a): Classification => {
      const e = pageElement(a.element);
      if ('level' in e) return e;
      if (
        isSecretField({ type: e.type, name: e.name, autocomplete: e.autocomplete, label: e.label })
      ) {
        return forbid(
          'computer.deny.secret_field',
          'Jarvis never types into password, code or card fields',
        );
      }
      return { level: N1, rule: 'computer.browser.fill', reason: `fills a field on ${page?.host}` };
    },
    summarize: (a) => {
      const e = page?.elements.get(a.element);
      const preview = a.text.length > 80 ? `${a.text.slice(0, 80)}…` : a.text;
      return `Type "${preview}" into ${e ? describeElement(e) : `[${a.element}]`} on ${page?.host ?? '?'}`;
    },
    run: async (a, ctx) => {
      const e = pageElement(a.element);
      if ('level' in e || !page)
        throw new Refusal('computer.browser.no_page', 'read the page first');
      await perform(
        Results.acted,
        {
          kind: 'browser.fill',
          browser,
          tab: page.tab,
          element: a.element,
          fingerprint: e.fingerprint,
          text: a.text,
        },
        ctx.signal,
      );
      return `Filled ${describeElement(e)}.`;
    },
  });

  const browserBack = defineTool({
    name: 'browser_back',
    description: `Go back one page in the active ${browser} tab.`,
    input: {},
    classify: () => ({ level: N1, rule: 'computer.browser.back', reason: 'navigation' }),
    summarize: () => `Back in ${browser}`,
    run: async (_a, ctx) => {
      await perform(Results.acted, { kind: 'browser.back', browser }, ctx.signal);
      page = null;
      return 'Went back. Read the page again before acting.';
    },
  });

  // ── Notes and Reminders (Apple Events, no screen) ──

  const notesList = defineTool({
    name: 'notes_list',
    description:
      'List Apple Notes (most recent first), optionally filtered by a word in the title.',
    input: {
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    classify: () => ({ level: N0, rule: 'computer.notes.list', reason: 'read-only' }),
    summarize: (a) => `List notes${a.query ? ` matching "${a.query}"` : ''}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const { notes } = await perform(
        Results.notes,
        { kind: 'notes.list', limit: a.limit ?? 30, ...(a.query && { query: a.query }) },
        ctx.signal,
      );
      if (notes.length === 0) return 'No matching note.';
      return notes
        .map(
          (n) =>
            `${n.id}\t${n.modified.slice(0, 10)}\t${n.folder}\t${n.locked ? '🔒 ' : ''}${n.name}`,
        )
        .join('\n');
    },
  });

  const notesRead = defineTool({
    name: 'notes_read',
    description:
      'Read one Apple Note (plain text) by id from notes_list. Locked notes stay locked.',
    input: { id: z.string().min(1).max(300) },
    classify: () => ({ level: N0, rule: 'computer.notes.read', reason: 'read-only' }),
    summarize: () => 'Read a note',
    ingestsExternal: true,
    run: async (a, ctx) => {
      const n = await perform(Results.note, { kind: 'notes.read', id: a.id }, ctx.signal);
      if (n.locked) return `"${n.name}" is locked: Jarvis does not open locked notes.`;
      return `# ${n.name} (${n.folder})\n\n${n.text}`;
    },
  });

  const notesCreate = defineTool({
    name: 'notes_create',
    description: 'Create a new Apple Note (plain text body; line breaks kept).',
    input: {
      title: z.string().min(1).max(300),
      body: z.string().max(200_000),
      folder: z.string().max(200).optional(),
    },
    classify: () => ({ level: N1, rule: 'computer.notes.create', reason: 'creates a local note' }),
    summarize: (a) => `Create note "${a.title}"${a.folder ? ` in ${a.folder}` : ''}`,
    run: async (a, ctx) => {
      const { id } = await perform(
        Results.created,
        {
          kind: 'notes.create',
          title: a.title,
          body: a.body,
          ...(a.folder && { folder: a.folder }),
        },
        ctx.signal,
      );
      return `Note "${a.title}" created (${id}).`;
    },
  });

  const notesAppend = defineTool({
    name: 'notes_append',
    description: 'Append text at the end of an existing Apple Note (never rewrites or deletes).',
    input: { id: z.string().min(1).max(300), text: z.string().min(1).max(100_000) },
    classify: () => ({
      level: N1,
      rule: 'computer.notes.append',
      reason: 'appends to a local note',
    }),
    summarize: (a) => `Append ${a.text.length} chars to a note`,
    run: async (a, ctx) => {
      await perform(Results.created, { kind: 'notes.append', id: a.id, text: a.text }, ctx.signal);
      return 'Appended.';
    },
  });

  const remindersList = defineTool({
    name: 'reminders_list',
    description: 'List Reminders (open ones by default), optionally from one list.',
    input: { list: z.string().max(200).optional(), include_completed: z.boolean().optional() },
    classify: () => ({ level: N0, rule: 'computer.reminders.list', reason: 'read-only' }),
    summarize: (a) => `List reminders${a.list ? ` in ${a.list}` : ''}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      const { reminders } = await perform(
        Results.reminders,
        {
          kind: 'reminders.list',
          includeCompleted: a.include_completed ?? false,
          ...(a.list && { list: a.list }),
        },
        ctx.signal,
      );
      if (reminders.length === 0) return 'No reminder.';
      return reminders
        .map(
          (r) =>
            `${r.id}\t${r.completed ? '✓' : '○'}\t${r.list}\t${r.due ? `${r.due.slice(0, 16)}\t` : ''}${r.name}`,
        )
        .join('\n');
    },
  });

  const remindersAdd = defineTool({
    name: 'reminders_add',
    description: 'Add a reminder (optional list, ISO due date-time, notes).',
    input: {
      title: z.string().min(1).max(500),
      list: z.string().max(200).optional(),
      due: z.iso.datetime({ offset: true, local: true }).optional(),
      notes: z.string().max(5000).optional(),
    },
    classify: () => ({
      level: N1,
      rule: 'computer.reminders.add',
      reason: 'adds a local reminder',
    }),
    summarize: (a) => `Add reminder "${a.title}"${a.due ? ` for ${a.due}` : ''}`,
    run: async (a, ctx) => {
      const { id } = await perform(
        Results.created,
        {
          kind: 'reminders.add',
          title: a.title,
          ...(a.list && { list: a.list }),
          ...(a.due && { due: a.due }),
          ...(a.notes && { notes: a.notes }),
        },
        ctx.signal,
      );
      return `Reminder added (${id}).`;
    },
  });

  const remindersComplete = defineTool({
    name: 'reminders_complete',
    description: 'Mark a reminder as done (id from reminders_list).',
    input: { id: z.string().min(1).max(300) },
    classify: () => ({ level: N1, rule: 'computer.reminders.complete', reason: 'reversible' }),
    summarize: () => 'Complete a reminder',
    run: async (a, ctx) => {
      await perform(Results.acted, { kind: 'reminders.complete', id: a.id }, ctx.signal);
      return 'Done.';
    },
  });

  // ── Any app, visually: screenshot + accessibility tree, then clicks and keystrokes ──

  const screenLook = defineTool({
    name: 'screen_look',
    description:
      'Screenshot the front window of an app (default: the frontmost app) with its labelled controls as ' +
      '[n] (x, y). Coordinates are image pixels, for screen_act. With display (1 = the screen with the ' +
      'menu bar) instead of app: the whole screen and where each window is — to see what Brightky sees; ' +
      'look at the app itself before acting in it. Terminal, settings, password managers and Jarvis are ' +
      'never captured (on a whole screen they are left out of the picture).',
    input: {
      app: z.string().max(60).optional(),
      display: z.number().int().min(1).max(8).optional(),
    },
    classify: (a): Classification => {
      if (a.app && a.display !== undefined)
        return forbid('input.invalid', 'look at an app or a display, not both');
      if (a.display !== undefined)
        return { level: N0, rule: 'computer.screen.look_display', reason: 'looks at a screen' };
      return (
        (a.app && appGuard(a.app)) || {
          level: N0,
          rule: 'computer.screen.look',
          reason: 'looks at a window',
        }
      );
    },
    summarize: (a) =>
      a.display !== undefined
        ? `Look at display ${a.display}`
        : `Look at ${a.app ?? 'the frontmost app'}`,
    ingestsExternal: true,
    run: async (a, ctx) => {
      if (a.display !== undefined) {
        const r = await perform(
          Results.display,
          { kind: 'screen.look', display: a.display },
          ctx.signal,
          20_000,
        );
        const list = r.windows
          .map(
            (w) =>
              `- ${w.app}${w.title ? ` — "${w.title}"` : ''} @ (${w.x}, ${w.y}) ${w.width}×${w.height}`,
          )
          .join('\n');
        return {
          text:
            `Display ${r.display} of ${r.displays} — image ${r.width}×${r.height} px. Windows, front to back:\n` +
            `${list || '(none)'}\nProtected apps are not in the picture. Before acting in an app: screen_look {app}.`,
          images: [{ data: r.image, mimeType: 'image/jpeg' as const }],
        };
      }
      const r = await perform(
        Results.look,
        { kind: 'screen.look', ...(a.app && { app: a.app }) },
        ctx.signal,
        20_000,
      );
      const guard = appGuard(r.app);
      if (guard) throw new Refusal(guard.rule, guard.reason);
      const snap: ScreenSnapshot = {
        app: r.app,
        elements: new Map(
          r.elements.map((e) => [e.id, { role: e.role, label: e.label, secure: e.secure }]),
        ),
      };
      screens.set(r.app.toLowerCase(), snap);
      if (a.app) screens.set(a.app.toLowerCase(), snap);
      const list = r.elements
        .map(
          (e) =>
            `[${e.id}] ${e.role.replace(/^AX/, '')} "${e.label}"${e.secure ? ' (secure)' : ''} @ (${e.x}, ${e.y})`,
        )
        .join('\n');
      return {
        text: `App: ${r.app} — window "${r.window}" — image ${r.width}×${r.height} px.\n${list || '(no labelled controls exposed)'}`,
        images: [{ data: r.image, mimeType: 'image/jpeg' as const }],
      };
    },
  });

  const screenAct = defineTool({
    name: 'screen_act',
    description:
      'Act in an app after screen_look: click / double_click an element [n] or a point (image pixels), ' +
      'type text into the focused field, press a key ("return", "cmd+s", "tab"…) or scroll (dy lines). ' +
      'Set commit: true when it sends, publishes or deletes something (Return in a chat counts). ' +
      'Never types into password fields; never switches app, opens Spotlight or quits the session.',
    input: {
      app: z.string().min(1).max(60),
      action: z.enum(['click', 'double_click', 'type', 'key', 'scroll']),
      element: z.number().int().nonnegative().optional(),
      x: z.number().int().min(0).max(20_000).optional(),
      y: z.number().int().min(0).max(20_000).optional(),
      text: z.string().max(20_000).optional(),
      key: z.string().max(40).optional(),
      dy: z.number().int().min(-100).max(100).optional(),
      commit: z.boolean().optional(),
    },
    classify: (a): Classification => {
      const guard = appGuard(a.app);
      if (guard) return guard;
      const snap = screens.get(a.app.toLowerCase());
      const o = {
        declaredCommit: a.commit ?? false,
        allowlisted: commitAllowedInApp(a.app, rules),
        where: a.app,
      };
      switch (a.action) {
        case 'click':
        case 'double_click': {
          if (a.element === undefined && (a.x === undefined || a.y === undefined)) {
            return forbid('input.invalid', 'click needs an element or x and y');
          }
          if (!snap)
            return forbid('computer.screen.no_look', `look at ${a.app} first (screen_look)`);
          const e = a.element === undefined ? undefined : snap.elements.get(a.element);
          if (a.element !== undefined && !e) {
            return forbid(
              'computer.screen.unknown_element',
              `no element [${a.element}] in the last look`,
            );
          }
          return engagementLevel(e?.label ?? '', o);
        }
        case 'type': {
          if (!a.text) return forbid('input.invalid', 'type needs text');
          const e = a.element === undefined ? undefined : snap?.elements.get(a.element);
          if (e?.secure)
            return forbid('computer.deny.secret_field', 'Jarvis never types into password fields');
          // A newline is a Return: it sends in chats and mail.
          return engagementLevel('', {
            ...o,
            declaredCommit: o.declaredCommit || /[\r\n]/.test(a.text),
          });
        }
        case 'key':
          return a.key ? keyLevel(a.key, o) : forbid('input.invalid', 'key needs a key');
        case 'scroll':
          return { level: N1, rule: 'computer.screen.scroll', reason: `scrolls in ${a.app}` };
      }
    },
    summarize: (a) => {
      const e =
        a.element === undefined
          ? undefined
          : screens.get(a.app.toLowerCase())?.elements.get(a.element);
      const target = e
        ? `${e.role.replace(/^AX/, '')} "${e.label}"`
        : a.x !== undefined
          ? `(${a.x}, ${a.y})`
          : '';
      switch (a.action) {
        case 'type':
          return `Type "${(a.text ?? '').slice(0, 80)}" in ${a.app}${target ? ` into ${target}` : ''}`;
        case 'key':
          return `Press ${a.key} in ${a.app}`;
        case 'scroll':
          return `Scroll ${a.dy ?? 0} in ${a.app}`;
        default:
          return `${a.action === 'click' ? 'Click' : 'Double-click'} ${target} in ${a.app}`;
      }
    },
    run: async (a, ctx) => {
      const where =
        a.element !== undefined || a.x !== undefined ? { element: a.element, x: a.x, y: a.y } : {};
      // What is really under the pointer / focused now decides, not what the model believes.
      if (a.action !== 'scroll') {
        const live = await perform(
          Results.probe,
          { kind: 'screen.probe', app: a.app, ...where },
          ctx.signal,
        );
        const guard = appGuard(live.app);
        if (guard) throw new Refusal(guard.rule, guard.reason);
        if (live.app !== live.target) {
          throw new Refusal(
            'computer.screen.wrong_app',
            `the target belongs to ${live.app}, not ${live.target}`,
          );
        }
        if (
          a.action === 'type' &&
          (live.secure || isSecretField({ label: live.label, secure: live.secure }))
        ) {
          throw new Refusal(
            'computer.deny.secret_field',
            'Jarvis never types into password fields',
          );
        }
        if (a.action === 'click' || a.action === 'double_click') {
          const o = {
            declaredCommit: a.commit ?? false,
            allowlisted: commitAllowedInApp(a.app, rules),
            where: a.app,
          };
          const now = engagementLevel(live.label, o);
          if (now.level > ctx.classification.level) {
            throw new Refusal(
              now.level >= 4 ? now.rule : 'computer.screen.undeclared_commit',
              now.level >= 4
                ? now.reason
                : `the control under the pointer is ${live.role.replace(/^AX/, '')} "${live.label}" (${now.reason}): ask again with commit: true`,
            );
          }
        }
      }
      await perform(
        Results.acted,
        {
          kind: 'screen.act',
          app: a.app,
          action: a.action,
          ...where,
          ...(a.text !== undefined && { text: a.text }),
          ...(a.key !== undefined && { key: a.key }),
          ...(a.dy !== undefined && { dy: a.dy }),
        },
        ctx.signal,
      );
      if (a.action !== 'scroll') {
        const snap = screens.get(a.app.toLowerCase());
        for (const [k, v] of screens) if (v === snap) screens.delete(k);
      }
      return `Done in ${a.app}. Look again (screen_look) before the next click.`;
    },
  });

  // ── The desk: windows, displays, quitting and arranging apps ──

  const windowsList = defineTool({
    name: 'windows_list',
    description:
      'What is open on the Mac: the displays (1 = the one with the menu bar), every visible window ' +
      'front to back with its app and title, and the apps with no visible window (hidden or ' +
      'minimized). Use it before closing or arranging apps "on the first screen". Protected apps ' +
      '(shells, settings, credentials, Jarvis) show without titles and are never touched.',
    input: {},
    classify: () => ({ level: N0, rule: 'computer.windows.list', reason: 'read-only' }),
    summarize: () => 'List open windows',
    ingestsExternal: true,
    run: async (_a, ctx) => {
      const r = await perform(Results.windows, { kind: 'apps.windows' }, ctx.signal);
      const lines = [
        `Displays: ${r.displays.map((d) => `${d.index} (${d.width}×${d.height}${d.index === 1 ? ', menu bar' : ''})`).join(', ') || 'none'}`,
      ];
      for (const d of r.displays) {
        const here = r.windows.filter((w) => w.display === d.index);
        lines.push(`Display ${d.index}, front to back:`);
        for (const w of here) {
          lines.push(
            w.protected
              ? `- ${w.app} [protected]`
              : `- ${w.app}${w.title ? ` — "${w.title}"` : ''} @ (${w.x}, ${w.y}) ${w.width}×${w.height}`,
          );
        }
        if (here.length === 0) lines.push('- (no window)');
      }
      const front = r.apps.find((a) => a.active);
      if (front) lines.push(`Frontmost app: ${front.app}`);
      const idle = r.apps.filter((a) => a.windows === 0);
      if (idle.length) {
        lines.push(
          `Open without a visible window: ${idle
            .map(
              (a) => `${a.app}${a.hidden ? ' (hidden)' : ''}${a.protected ? ' [protected]' : ''}`,
            )
            .join(', ')}`,
        );
      }
      return lines.join('\n');
    },
  });

  const appQuit = defineTool({
    name: 'app_quit',
    description:
      'Quit apps the way ⌘Q does (never forced): an app with unsaved work asks Brightky to save and ' +
      'stays open. Put every app in ONE call so Brightky confirms once (e.g. "close everything on ' +
      'the first screen": windows_list, then app_quit with those apps). Protected apps and Finder ' +
      'are never quit: leave them out.',
    input: { apps: z.array(z.string().min(1).max(60)).min(1).max(30) },
    classify: (a): Classification => {
      for (const app of a.apps) {
        const guard = appGuard(app);
        if (guard) return guard;
      }
      return {
        level: N2,
        rule: 'computer.app.quit',
        reason: 'closes apps (unsaved work is not lost: the app asks to save)',
      };
    },
    summarize: (a) => `Quit ${[...new Set(a.apps)].join(', ')}`,
    run: async (a, ctx) => {
      const r = await perform(
        Results.quit,
        { kind: 'apps.quit', apps: [...new Set(a.apps)] },
        ctx.signal,
        20_000,
      );
      for (const app of r.quit) screens.delete(app.toLowerCase());
      const parts = [];
      if (r.quit.length) parts.push(`Quit: ${r.quit.join(', ')}.`);
      if (r.still_running.length)
        parts.push(
          `Still open (probably asking whether to save — Brightky answers that himself): ${r.still_running.join(', ')}.`,
        );
      if (r.not_running.length) parts.push(`Not running: ${r.not_running.join(', ')}.`);
      if (r.refused.length) parts.push(`Never quit: ${r.refused.join(', ')}.`);
      return parts.join(' ') || 'Nothing to quit.';
    },
  });

  const windowManage = defineTool({
    name: 'window_manage',
    description:
      'Arrange an app or its front window: front (bring it forward), hide / show the app, minimize / ' +
      'restore, fullscreen (toggle), maximize, left / right / top / bottom half, center, or close ' +
      "(the window's red button: unsaved work asks to save). display (windows_list numbers them) " +
      'moves the window there with maximize, the halves and center.',
    input: {
      app: z.string().min(1).max(60),
      action: z.enum(WINDOW_ACTIONS),
      display: z.number().int().min(1).max(8).optional(),
    },
    classify: (a): Classification =>
      appGuard(a.app) ??
      (a.action === 'close'
        ? { level: N2, rule: 'computer.window.close', reason: 'closes a window' }
        : { level: N1, rule: 'computer.window', reason: 'moves, shows or hides a window' }),
    summarize: (a) =>
      `${WINDOW_SUMMARY[a.action].replace('{app}', a.app)}${a.display ? ` on display ${a.display}` : ''}`,
    run: async (a, ctx) => {
      const r = await perform(
        Results.managed,
        {
          kind: 'window.manage',
          app: a.app,
          action: a.action,
          ...(a.display !== undefined && { display: a.display }),
        },
        ctx.signal,
      );
      // The window moved: coordinates from the last look are stale.
      screens.delete(a.app.toLowerCase());
      screens.delete(r.app.toLowerCase());
      return `Done: ${WINDOW_SUMMARY[a.action].replace('{app}', r.app).toLowerCase()}.`;
    },
  });

  return [
    browserTabs,
    browserOpen,
    browserRead,
    browserClick,
    browserFill,
    browserBack,
    notesList,
    notesRead,
    notesCreate,
    notesAppend,
    remindersList,
    remindersAdd,
    remindersComplete,
    screenLook,
    screenAct,
    windowsList,
    appQuit,
    windowManage,
  ] as unknown as ToolDef[];
}
