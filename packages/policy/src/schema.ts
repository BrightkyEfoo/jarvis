import { z } from 'zod';

const ShellAllowRule = z
  .object({
    cmd: z.string().regex(/^[A-Za-z0-9._+-]+$/, 'bare command name, no path'),
    /** Allowed first positional arguments (subcommands). Omit to allow any. */
    sub: z.array(z.string()).optional(),
    /** Policy can grant up to N3. N4 lives in code and cannot be allowlisted. */
    level: z.number().int().min(0).max(3),
    reason: z.string().optional(),
  })
  .strict();

const ShellDenyRule = z
  .object({
    cmd: z.string(),
    sub: z.array(z.string()).optional(),
    reason: z.string(),
  })
  .strict();

const AutoApproveRule = z
  .object({
    tool: z.string(),
    /** Every listed input field must hold only allowed values. */
    when: z.record(z.string(), z.array(z.string())).prefault({}),
  })
  .strict();

const AccountId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'lowercase id, e.g. perso or scriptify');
const MailServer = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
  })
  .strict();

const MailAccount = z.discriminatedUnion('type', [
  z.object({ id: AccountId, type: z.literal('gmail'), email: z.email() }).strict(),
  z
    .object({
      id: AccountId,
      type: z.literal('imap'),
      email: z.email(),
      user: z.string().optional(),
      imap: MailServer,
      smtp: MailServer,
      /** PEM of a self-signed server certificate to trust (verification stays on). */
      ca_pem: z.string().optional(),
    })
    .strict(),
]);

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase id: letters, digits, dashes');
/** One argv word run on a server: printable, no NUL or newline. */
const RemoteArg = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[^\0\n\r]+$/);

const OpsApp = z
  .object({
    id: Slug,
    /** owner/repo (or group/project) of the app, for deploy keys and repository secrets. */
    repo: z.string().max(200).optional(),
    forge: z.enum(['github', 'gitlab']).prefault('github'),
    /** argv run on the server to deploy (Brightky wrote it: may use sudo, a script, compose…). */
    deploy: z.array(RemoteArg).min(1).max(40).optional(),
    /** argv that prints the app's recent logs (read-only). */
    logs: z.array(RemoteArg).min(1).max(40).optional(),
    /** Coolify instead of SSH: the deploy webhook of this application. */
    coolify: z
      .object({
        url: z.url({ protocol: /^https$/ }),
        uuid: z.string().regex(/^[A-Za-z0-9-]{4,64}$/),
        /** Vault entry holding the Coolify API token (jarvis vault set). */
        token_vault: z.string().regex(/^[a-z0-9_.-]{1,40}$/),
      })
      .strict()
      .optional(),
  })
  .strict();

const OpsServer = z
  .object({
    id: Slug,
    /** Host name or an alias of ~/.ssh/config: ssh resolves it with Brightky's keys or agent. */
    host: z.string().regex(/^[A-Za-z0-9._-]{1,253}$/),
    user: z
      .string()
      .regex(/^[a-z_][a-z0-9_-]{0,31}$/)
      .optional(),
    port: z.number().int().min(1).max(65535).optional(),
    /** prod: anything that changes the server needs the PIN (N3); staging/dev: a confirmation (N2). */
    env: z.enum(['prod', 'staging', 'dev']).prefault('prod'),
    apps: z.array(OpsApp).prefault([]),
  })
  .strict();

export const PolicySchema = z
  .object({
    version: z.literal(1),
    filesystem: z
      .object({
        read_roots: z.array(z.string()).prefault([]),
        write_roots: z.array(z.string()).prefault([]),
        /** Extra denies, added to the built-in list. Cannot remove built-ins. */
        deny: z.array(z.string()).prefault([]),
      })
      .strict()
      .prefault({}),
    shell: z
      .object({
        allow: z.array(ShellAllowRule).prefault([]),
        deny: z.array(ShellDenyRule).prefault([]),
        timeout_sec: z.number().int().positive().max(3600).prefault(120),
        max_output_bytes: z.number().int().positive().max(10_000_000).prefault(1_000_000),
      })
      .strict()
      .prefault({}),
    auto_approve: z.array(AutoApproveRule).prefault([]),
    approvals: z
      .object({ timeout_sec: z.number().int().min(5).max(3600).prefault(120) })
      .strict()
      .prefault({}),
    pin: z
      .object({
        max_attempts: z.number().int().min(1).max(10).prefault(3),
        lockout_min: z.number().int().min(1).max(1440).prefault(15),
      })
      .strict()
      .prefault({}),
    quota: z
      .object({
        reserve_interactive_pct: z.number().min(0).max(100).prefault(30),
        night_max_utilization: z.number().min(0).max(100).prefault(70),
      })
      .strict()
      .prefault({}),
    models: z
      .object({
        conversation: z.string().prefault('claude-sonnet-5-5'),
        planning: z.string().prefault('claude-opus-5-5'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).prefault('medium'),
      })
      .strict()
      .prefault({}),
    limits: z
      .object({
        max_turns: z.number().int().min(1).max(200).prefault(25),
        /** Runaway-loop guard, not billing: auth is the subscription. */
        max_budget_usd_per_query: z.number().positive().max(50).prefault(3),
      })
      .strict()
      .prefault({}),
    macos: z
      .object({
        /** Apps Jarvis may open at N1. Others need a confirmation (N2). */
        apps: z.array(z.string()).prefault([]),
        /** Shortcuts with an explicit level. Unlisted shortcuts are N3. */
        shortcuts: z
          .array(z.object({ name: z.string(), level: z.number().int().min(0).max(3) }).strict())
          .prefault([]),
        /** Shortcuts that must never run (N4), on top of the built-in payment filter. */
        shortcuts_deny: z.array(z.string()).prefault([]),
      })
      .strict()
      .prefault({}),
    projects: z
      .object({
        /** Folders whose sub-folders are projects. Must be inside filesystem.read_roots. */
        roots: z.array(z.string()).prefault([]),
        /** Individual project folders. Must be inside filesystem.read_roots. */
        paths: z.array(z.string()).prefault([]),
      })
      .strict()
      .prefault({}),
    mail: z
      .object({
        /** Which mailboxes Jarvis may read. Sealed: adding one is Brightky's decision. */
        accounts: z.array(MailAccount).prefault([]),
        /** Max messages summarised per triage. */
        triage_max: z.number().int().min(1).max(100).prefault(25),
      })
      .strict()
      .prefault({}),
    calendar: z
      .object({
        /** Gmail account whose Google Calendar is read (default: the first Gmail account). */
        google_account: z.string().optional(),
      })
      .strict()
      .prefault({}),
    forges: z
      .object({
        /** Self-hosted GitLab root (https only); gitlab.com by default. */
        gitlab_url: z.url({ protocol: /^https$/ }).prefault('https://gitlab.com'),
        /** Character budget for diffs handed to the model (the rest is summarised as a file list). */
        max_diff_chars: z.number().int().min(2_000).max(200_000).prefault(60_000),
        /** Trello label that marks cards Jarvis may take (S7). */
        trello_label: z.string().max(40).prefault('jarvis'),
        /** Board name → repository its cards are about (a card can override with "repo: owner/repo"). */
        trello_boards: z.record(z.string().max(200), z.string().max(200)).prefault({}),
        /** Column names (case-insensitive) where taken cards go, then where finished ones go. */
        trello_doing: z
          .array(z.string().max(100))
          .prefault(['En cours', 'Doing', 'In progress', 'WIP']),
        trello_review: z
          .array(z.string().max(100))
          .prefault(['À relire', 'A relire', 'Review', 'Code review', 'En revue', 'QA']),
      })
      .strict()
      .prefault({}),
    workers: z
      .object({
        /** Claude Code workers running at once (Max 5x: 1 to 2 is comfortable, 3 at most). */
        max_parallel: z.number().int().min(1).max(3).prefault(1),
        /** Model for ordinary tasks; "complex" tasks use models.planning. */
        model: z.string().prefault('claude-sonnet-5-5'),
        max_turns: z.number().int().min(10).max(500).prefault(150),
        /** Anti-runaway cap per task, in API-equivalent dollars (the subscription is what is used). */
        max_budget_usd: z.number().positive().max(100).prefault(15),
        /** Open pull requests as drafts. */
        draft_pr: z.boolean().prefault(false),
        /** Where Jarvis keeps its own clones, worktrees and package caches. */
        dir: z.string().prefault('~/jarvis-work/.jarvis-workers'),
        /** Hosts the sandboxed shell may reach: package registries only. */
        network: z
          .array(z.string().regex(/^[a-z0-9.*-]+$/))
          .prefault([
            'registry.npmjs.org',
            'registry.yarnpkg.com',
            'pypi.org',
            'files.pythonhosted.org',
            'crates.io',
            'index.crates.io',
            'static.crates.io',
            'proxy.golang.org',
            'sum.golang.org',
            'repo.maven.apache.org',
            'plugins.gradle.org',
            'services.gradle.org',
            'jsr.io',
          ]),
      })
      .strict()
      .prefault({}),
    computer: z
      .object({
        /** Browser Jarvis drives (Brightky's own profile, through AppleScript). */
        browser: z.enum(['Arc', 'Google Chrome']).prefault('Arc'),
        /** Sites where Envoyer/Publier/Supprimer… need no confirmation. */
        commit_allow_domains: z.array(z.string()).prefault([]),
        /** Apps where commit clicks need no confirmation (visual control). */
        commit_allow_apps: z.array(z.string()).prefault([]),
        /** Extra off-limits sites / apps, on top of the built-in lists. */
        forbidden_domains: z.array(z.string()).prefault([]),
        forbidden_apps: z.array(z.string()).prefault([]),
      })
      .strict()
      .prefault({}),
    /** Servers Jarvis may reach over SSH and the apps it may deploy (sealed: Jarvis cannot add one). */
    ops: z
      .object({
        servers: z.array(OpsServer).prefault([]),
        /** Seconds a deploy may run. */
        deploy_timeout_sec: z.number().int().min(30).max(3600).prefault(900),
      })
      .strict()
      .prefault({}),
    memory: z
      .object({
        /** Markdown notes written by Brightky; Jarvis reads them, never writes them. */
        notes_dir: z.string().prefault('~/Jarvis/memory'),
        /** Budget for the memory snapshot put in the system prompt. */
        prompt_max_chars: z.number().int().min(0).max(50_000).prefault(8000),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type PolicyFile = z.infer<typeof PolicySchema>;
