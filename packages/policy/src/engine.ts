import { type Classification, type Level, N2, N3, N4 } from './levels.ts';
import type { Policy } from './load.ts';
import type { Session } from './provenance.ts';

export type Verdict = 'allow' | 'confirm' | 'confirm_pin' | 'deny';

export interface Decision {
  verdict: Verdict;
  level: Level;
  rule: string;
  reason: string;
  autoApproved: boolean;
  /** Destinations that came from external content; shown in the approval prompt. */
  externalDestinations: string[];
}

export interface EvaluateOptions {
  /** Dev mode runs on an unsealed policy: N3 is refused outright. */
  devMode?: boolean;
}

type AutoApproveRules = Policy['auto_approve'];

function matchesAutoApprove(
  rules: AutoApproveRules,
  tool: string,
  input: Record<string, unknown>,
): boolean {
  return rules.some(
    (r) =>
      r.tool === tool &&
      Object.entries(r.when).every(([field, allowed]) => {
        const v = input[field];
        const values = Array.isArray(v) ? v : [v];
        return (
          values.length > 0 && values.every((x) => typeof x === 'string' && allowed.includes(x))
        );
      }),
  );
}

/** Pure decision function: no I/O, so it is cheap and exhaustively testable. */
export class PolicyEngine {
  readonly #autoApprove: AutoApproveRules;

  constructor(autoApprove: AutoApproveRules) {
    this.#autoApprove = autoApprove;
  }

  evaluate(
    tool: string,
    input: Record<string, unknown>,
    cls: Classification,
    session: Session,
    opts: EvaluateOptions = {},
  ): Decision {
    const externalDestinations = (cls.destinations ?? []).filter((d) =>
      session.isExternalDestination(d),
    );
    const base = {
      level: cls.level,
      rule: cls.rule,
      reason: cls.reason,
      autoApproved: false,
      externalDestinations,
    };

    if (cls.level >= N4) return { ...base, verdict: 'deny' };

    if (cls.level === N3) {
      if (session.tainted) {
        return {
          ...base,
          verdict: 'deny',
          rule: 'provenance.n3_after_external',
          reason: 'N3 actions are never allowed once external content is in the conversation',
        };
      }
      if (opts.devMode) {
        return {
          ...base,
          verdict: 'deny',
          rule: 'dev.n3_disabled',
          reason: 'N3 is disabled on an unsealed policy',
        };
      }
      return { ...base, verdict: 'confirm_pin' };
    }

    if (cls.level === N2) {
      // Auto-approval only for clean sessions: external content can steer the model.
      const clean = !session.tainted && externalDestinations.length === 0;
      if (clean && matchesAutoApprove(this.#autoApprove, tool, input)) {
        return { ...base, verdict: 'allow', autoApproved: true };
      }
      return { ...base, verdict: 'confirm' };
    }

    return { ...base, verdict: 'allow' };
  }
}
