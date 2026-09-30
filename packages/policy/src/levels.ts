/** Access levels. N4 is enforced in code and can never be lowered by policy.yaml. */
export const N0 = 0; // read, no side effect
export const N1 = 1; // local and reversible
export const N2 = 2; // external, speaks for Brightky
export const N3 = 3; // sensitive: confirmation + PIN
export const N4 = 4; // forbidden

export type Level = 0 | 1 | 2 | 3 | 4;

export const levelName = (l: Level): string => `N${l}`;

export const maxLevel = (a: Level, b: Level): Level => (a > b ? a : b);

export interface Classification {
  level: Level;
  /** Stable identifier of the rule that decided, e.g. `shell.deny.rm`. Lands in the audit log. */
  rule: string;
  reason: string;
  /** Addresses, URLs or numbers the action sends data to. Checked against external content. */
  destinations?: string[];
}

export const forbid = (rule: string, reason: string): Classification => ({
  level: N4,
  rule,
  reason,
});
