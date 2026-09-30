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
  })
  .strict();

export type PolicyFile = z.infer<typeof PolicySchema>;
