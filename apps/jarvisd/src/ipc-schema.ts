import { z } from 'zod';

const id = z.string().min(1).max(64);

/** Everything the socket accepts. Anything else is rejected before reaching the runtime. */
export const RequestSchema = z.discriminatedUnion('cmd', [
  z.object({ id, cmd: z.literal('ping') }).strict(),
  z.object({ id, cmd: z.literal('status') }).strict(),
  z.object({ id, cmd: z.literal('ask'), text: z.string().min(1).max(20_000) }).strict(),
  z.object({ id, cmd: z.literal('stop'), reason: z.string().max(200).optional() }).strict(),
  z.object({ id, cmd: z.literal('resume'), pin: z.string().max(32) }).strict(),
  z.object({ id, cmd: z.literal('new_session') }).strict(),
  z.object({ id, cmd: z.literal('approvals'), watch: z.boolean().optional() }).strict(),
  z
    .object({
      id,
      cmd: z.literal('approve'),
      approvalId: z.string().max(64),
      pin: z.string().max(32).optional(),
    })
    .strict(),
  z.object({ id, cmd: z.literal('deny'), approvalId: z.string().max(64) }).strict(),
  z
    .object({
      id,
      cmd: z.literal('audit_tail'),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  z.object({ id, cmd: z.literal('audit_verify') }).strict(),
  z
    .object({ id, cmd: z.literal('costs'), period: z.enum(['today', 'week', 'month']).optional() })
    .strict(),
  z
    .object({
      id,
      cmd: z.literal('memory_list'),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  z.object({ id, cmd: z.literal('memory_search'), query: z.string().min(1).max(300) }).strict(),
  z.object({ id, cmd: z.literal('memory_forget'), factId: z.number().int().positive() }).strict(),
]);

export type Request = z.infer<typeof RequestSchema>;
