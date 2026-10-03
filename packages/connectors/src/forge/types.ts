/** Forge-neutral shapes (GitHub pull requests, GitLab merge requests…). All text is external. */

export type ForgeId = 'github' | 'gitlab';
export type ChecksState = 'success' | 'failure' | 'pending' | 'none';

export interface ChangeRequest {
  forge: ForgeId;
  /** owner/repo (GitHub) or group/…/project (GitLab). */
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
  updatedAt: string;
  comments?: number;
  checks?: ChecksState;
  approvals?: number;
  changesRequested?: boolean;
  source?: string;
  target?: string;
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff, truncated by the caller's budget. */
  patch?: string;
}

export interface Comment {
  author: string;
  body: string;
  at: string;
  /** File for inline review comments. */
  path?: string;
}

export interface ChangeDetail extends ChangeRequest {
  body: string;
  additions: number;
  deletions: number;
  files: ChangedFile[];
  discussion: Comment[];
}

export interface Issue {
  forge: ForgeId;
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  state: 'open' | 'closed';
  labels: string[];
  updatedAt: string;
  comments?: number;
}

export interface IssueDetail extends Issue {
  body: string;
  discussion: Comment[];
}

/** What a reviewer needs to triage a PR without reading it: size, touched paths, CI, reviews. */
export interface ReviewFacts {
  createdAt?: string;
  additions: number;
  deletions: number;
  /** Changed file paths (at most 300). */
  paths: string[];
  checks?: ChecksState;
  approvals?: number;
  changesRequested?: boolean;
  source?: string;
}

/** A failed CI job, reduced to what explains it: annotations and the end of its log. */
export interface CiFailure {
  name: string;
  url?: string;
  /** The check's own summary (GitHub check output), if any. */
  summary?: string;
  annotations: { path: string; line?: number; message: string }[];
  /** End of the job log, ANSI codes and timestamps removed. */
  logTail?: string;
}

export interface ForgeInbox {
  /** Waiting for Brightky's review. */
  toReview: ChangeRequest[];
  /** His own open PRs/MRs, with CI and review state. */
  mine: ChangeRequest[];
  /** Open issues assigned to him. */
  issues: Issue[];
}

export interface RepoInfo {
  defaultBranch: string;
  private: boolean;
  /** https clone URL (the token is given to git separately, never in the URL). */
  cloneUrl: string;
}

export interface NewChange {
  repo: string;
  /** Branch pushed by Jarvis (always jarvis/…). */
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface ForgeClient {
  readonly forge: ForgeId;
  whoami(): Promise<string>;
  inbox(max: number): Promise<ForgeInbox>;
  listChanges(o: {
    repo?: string;
    state: 'open' | 'closed' | 'all';
    max: number;
  }): Promise<ChangeRequest[]>;
  getChange(repo: string, number: number, o: { maxPatchChars: number }): Promise<ChangeDetail>;
  /** Failed CI jobs of a PR/MR (number) or of a branch's last commit (ref). */
  ciFailures(
    repo: string,
    target: { number?: number; ref?: string },
    tailChars: number,
  ): Promise<CiFailure[]>;
  /** Size, paths, CI and reviews of one PR/MR, without the diff (review queue). */
  reviewFacts(repo: string, number: number): Promise<ReviewFacts>;
  listIssues(o: { repo?: string; state: 'open' | 'closed' | 'all'; max: number }): Promise<Issue[]>;
  getIssue(repo: string, number: number): Promise<IssueDetail>;
  comment(
    repo: string,
    number: number,
    kind: 'change' | 'issue',
    body: string,
  ): Promise<{ url: string }>;
  repoInfo(repo: string): Promise<RepoInfo>;
  /** Opens a PR/MR. Never merges. */
  openChange(c: NewChange): Promise<{ number: number; url: string }>;
  /** Username git presents over https with the token (x-access-token, oauth2). */
  readonly gitUser: string;
  /** The token for this repository (git credential helper only), read at use time. */
  gitToken(repo: string): string;
}

/** owner/repo, or group/subgroup/project for GitLab. No "." / ".." segment (path traversal). */
export const REPO_PATH =
  /^(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]{1,100}(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]{1,100}){1,8}$/;

/** Spreads per-file patch text over a character budget, smallest files first. */
export function budgetPatches(files: ChangedFile[], maxChars: number): ChangedFile[] {
  let left = maxChars;
  const order = [...files].sort((a, b) => (a.patch?.length ?? 0) - (b.patch?.length ?? 0));
  const kept = new Map<ChangedFile, string | undefined>();
  for (const f of order) {
    const p = f.patch ?? '';
    if (p.length <= left) {
      kept.set(f, p || undefined);
      left -= p.length;
    } else {
      kept.set(f, left > 400 ? `${p.slice(0, left)}\n[… diff tronqué]` : undefined);
      left = Math.max(0, left - Math.min(p.length, left));
    }
  }
  return files.map((f) => {
    const { patch: _full, ...rest } = f;
    const patch = kept.get(f);
    return patch === undefined ? rest : { ...rest, patch };
  });
}

/** CI logs carry colours and per-line timestamps that only cost tokens. */
export function cleanLog(log: string): string {
  return log
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/gm, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
