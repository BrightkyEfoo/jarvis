import type { FetchFn } from '../google/oauth.ts';
import { HttpJson, linkNext } from './http.ts';
import {
  budgetPatches,
  type ChangeDetail,
  type ChangeRequest,
  type ChecksState,
  type CiFailure,
  type Comment,
  cleanLog,
  type ForgeClient,
  type ForgeInbox,
  type Issue,
  type IssueDetail,
  type NewChange,
  REPO_PATH,
  type RepoInfo,
  type ReviewFacts,
} from './types.ts';

interface GhUser {
  login: string;
}
interface GhLabel {
  name: string;
}
interface GhSearchItem {
  number: number;
  title: string;
  user: GhUser | null;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  updated_at: string;
  repository_url: string;
  comments: number;
  labels: GhLabel[];
  pull_request?: { merged_at: string | null };
}
interface GhPull {
  number: number;
  title: string;
  user: GhUser | null;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  updated_at: string;
  created_at?: string;
  body: string | null;
  additions: number;
  deletions: number;
  comments: number;
  review_comments: number;
  head: { ref: string; sha: string };
  base: { ref: string; repo: { full_name: string } };
}
interface GhCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  app?: { slug: string } | null;
  output?: { summary?: string | null; annotations_count?: number } | null;
}
interface GhFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}
interface GhComment {
  user: GhUser | null;
  body: string | null;
  created_at: string;
  path?: string;
}
interface GhReview {
  user: GhUser | null;
  state: string;
  body: string | null;
  submitted_at?: string;
}
interface GhIssue {
  number: number;
  title: string;
  user: GhUser | null;
  html_url: string;
  state: 'open' | 'closed';
  labels: GhLabel[];
  updated_at: string;
  comments: number;
  body: string | null;
  pull_request?: unknown;
}

const repoOf = (repositoryUrl: string) => repositoryUrl.replace(/^.*\/repos\//, '');
const who = (u: GhUser | null) => u?.login ?? 'ghost';

function checkRepo(repo: string): string {
  if (!REPO_PATH.test(repo) || repo.split('/').length !== 2)
    throw new Error(`not a GitHub repository: ${repo}`);
  return repo;
}

/** GitHub REST v3 with a fine-grained token (Bearer, from the Keychain). */
export interface GitHubOptions {
  /** Token for an owner, or the personal one (owner undefined). Read at each call. */
  token: (owner?: string) => string;
  owners?: () => string[];
  fetch?: FetchFn;
  base?: string;
}

export class GitHubClient implements ForgeClient {
  readonly forge = 'github' as const;
  readonly gitUser = 'x-access-token';
  readonly #o: GitHubOptions;
  readonly #clients = new Map<string, HttpJson>();
  #login: string | null = null;

  constructor(o: GitHubOptions) {
    this.#o = o;
  }

  /** Owners (organisations) that have their own token: fine-grained tokens cover one owner each. */
  #owners(): string[] {
    return (this.#o.owners?.() ?? []).map((x) => x.toLowerCase());
  }

  /** API client for an owner's token, or the default (personal) one. */
  #api(owner?: string): HttpJson {
    const key = owner && this.#owners().includes(owner.toLowerCase()) ? owner.toLowerCase() : '';
    let c = this.#clients.get(key);
    if (!c) {
      c = new HttpJson({
        base: this.#o.base ?? 'https://api.github.com',
        auth: () => ({ authorization: `Bearer ${this.#o.token(key || undefined)}` }),
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        ...(this.#o.fetch && { fetch: this.#o.fetch }),
      });
      this.#clients.set(key, c);
    }
    return c;
  }

  #for(repo: string): HttpJson {
    return this.#api(repo.split('/')[0]);
  }

  async whoami(): Promise<string> {
    this.#login ??= (await this.#api().get<GhUser>('/user')).login;
    return this.#login;
  }

  /** Search with every token (personal + organisations), merged and newest first. */
  async #search(q: string, max: number): Promise<GhSearchItem[]> {
    const keys = ['', ...this.#owners()];
    const pages = await Promise.all(
      keys.map((k) =>
        this.#api(k || undefined)
          .get<{ items: GhSearchItem[] }>('/search/issues', {
            q,
            sort: 'updated',
            order: 'desc',
            per_page: Math.min(max, 100),
          })
          .then((r) => r.items)
          .catch((e: Error) => (k ? [] : Promise.reject(e))),
      ),
    );
    const seen = new Set<string>();
    return pages
      .flat()
      .filter((i) => !seen.has(i.html_url) && seen.add(i.html_url))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, max);
  }

  #changeFromSearch(i: GhSearchItem): ChangeRequest {
    return {
      forge: 'github',
      repo: repoOf(i.repository_url),
      number: i.number,
      title: i.title,
      author: who(i.user),
      url: i.html_url,
      draft: i.draft ?? false,
      state: i.pull_request?.merged_at ? 'merged' : i.state,
      updatedAt: i.updated_at,
      comments: i.comments,
    };
  }

  #issueFromSearch(i: GhSearchItem): Issue {
    return {
      forge: 'github',
      repo: repoOf(i.repository_url),
      number: i.number,
      title: i.title,
      author: who(i.user),
      url: i.html_url,
      state: i.state,
      labels: i.labels.map((l) => l.name),
      updatedAt: i.updated_at,
      comments: i.comments,
    };
  }

  /** CI and review state of one PR (3 calls). */
  async #status(
    repo: string,
    number: number,
  ): Promise<
    Pick<ChangeRequest, 'checks' | 'approvals' | 'changesRequested' | 'source' | 'target'>
  > {
    const pr = await this.#for(repo).get<GhPull>(`/repos/${repo}/pulls/${number}`);
    const [runs, reviews] = await Promise.all([
      this.#for(repo).get<{ check_runs: { status: string; conclusion: string | null }[] }>(
        `/repos/${repo}/commits/${pr.head.sha}/check-runs`,
        { per_page: 100 },
      ),
      this.#for(repo).get<GhReview[]>(`/repos/${repo}/pulls/${number}/reviews`, { per_page: 100 }),
    ]);
    // Latest review per reviewer decides.
    const latest = new Map<string, string>();
    for (const r of reviews) if (r.state !== 'COMMENTED') latest.set(who(r.user), r.state);
    return {
      checks: aggregate(runs.check_runs),
      approvals: [...latest.values()].filter((s) => s === 'APPROVED').length,
      changesRequested: [...latest.values()].includes('CHANGES_REQUESTED'),
      source: pr.head.ref,
      target: pr.base.ref,
    };
  }

  async ciFailures(
    repo: string,
    target: { number?: number; ref?: string },
    tailChars: number,
  ): Promise<CiFailure[]> {
    checkRepo(repo);
    const api = this.#for(repo);
    const sha =
      target.number !== undefined
        ? (await api.get<GhPull>(`/repos/${repo}/pulls/${target.number}`)).head.sha
        : (
            await api.get<{ sha: string }>(
              `/repos/${repo}/commits/${encodeURIComponent(target.ref ?? 'HEAD')}`,
            )
          ).sha;
    const { check_runs } = await api.get<{ check_runs: GhCheckRun[] }>(
      `/repos/${repo}/commits/${sha}/check-runs`,
      { per_page: 100, filter: 'latest' },
    );
    const failed = check_runs.filter((r) =>
      ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(r.conclusion ?? ''),
    );
    // The first three failures explain the rest; logs only for the first two (data is metered).
    return Promise.all(
      failed.slice(0, 3).map(async (r, i): Promise<CiFailure> => {
        const annotations = r.output?.annotations_count
          ? await api
              .get<
                { path: string; start_line?: number; message: string; annotation_level: string }[]
              >(`/repos/${repo}/check-runs/${r.id}/annotations`, { per_page: 20 })
              .catch(() => [])
          : [];
        const isActions = r.app?.slug === 'github-actions';
        const log =
          isActions && i < 2
            ? await api
                .textTail(`/repos/${repo}/actions/jobs/${r.id}/logs`, tailChars)
                .catch(() => '')
            : '';
        return {
          name: r.name,
          ...(r.html_url && { url: r.html_url }),
          ...(r.output?.summary && { summary: r.output.summary.slice(0, 2000) }),
          annotations: annotations
            .filter((a) => a.annotation_level !== 'notice')
            .map((a) => ({
              path: a.path,
              ...(a.start_line && { line: a.start_line }),
              message: a.message.slice(0, 500),
            })),
          ...(log && { logTail: cleanLog(log) }),
        };
      }),
    );
  }

  async reviewFacts(repo: string, number: number): Promise<ReviewFacts> {
    checkRepo(repo);
    const [pr, files] = await Promise.all([
      this.#for(repo).get<GhPull>(`/repos/${repo}/pulls/${number}`),
      this.#for(repo).all<GhFile>(
        `/repos/${repo}/pulls/${number}/files`,
        { per_page: 100 },
        300,
        linkNext,
      ),
    ]);
    const state = await this.#status(repo, number).catch(() => ({}));
    return {
      ...(pr.created_at && { createdAt: pr.created_at }),
      additions: pr.additions,
      deletions: pr.deletions,
      paths: files.map((f) => f.filename),
      ...state,
    };
  }

  async inbox(max: number): Promise<ForgeInbox> {
    const [review, mine, issues] = await Promise.all([
      this.#search('is:open is:pr archived:false review-requested:@me', max),
      this.#search('is:open is:pr archived:false author:@me', max),
      this.#search('is:open is:issue archived:false assignee:@me', max),
    ]);
    const minePrs = mine.map((i) => this.#changeFromSearch(i));
    // Status for his own PRs (the ones he waits on), capped to keep the briefing fast.
    await Promise.all(
      minePrs.slice(0, 10).map(async (p, i) => {
        minePrs[i] = { ...p, ...(await this.#status(p.repo, p.number).catch(() => ({}))) };
      }),
    );
    return {
      toReview: review.map((i) => this.#changeFromSearch(i)),
      mine: minePrs,
      issues: issues.map((i) => this.#issueFromSearch(i)),
    };
  }

  async listChanges(o: {
    repo?: string;
    state: 'open' | 'closed' | 'all';
    max: number;
  }): Promise<ChangeRequest[]> {
    if (!o.repo) {
      const state = o.state === 'all' ? '' : ` is:${o.state}`;
      return (await this.#search(`is:pr archived:false involves:@me${state}`, o.max)).map((i) =>
        this.#changeFromSearch(i),
      );
    }
    const repo = checkRepo(o.repo);
    const pulls = await this.#for(repo).all<GhPull>(
      `/repos/${repo}/pulls`,
      { state: o.state, sort: 'updated', direction: 'desc', per_page: Math.min(o.max, 100) },
      o.max,
      linkNext,
    );
    return pulls.map((p) => ({
      forge: 'github',
      repo,
      number: p.number,
      title: p.title,
      author: who(p.user),
      url: p.html_url,
      draft: p.draft,
      state: p.merged_at ? 'merged' : p.state,
      updatedAt: p.updated_at,
      source: p.head.ref,
      target: p.base.ref,
    }));
  }

  async getChange(
    repo: string,
    number: number,
    o: { maxPatchChars: number },
  ): Promise<ChangeDetail> {
    checkRepo(repo);
    const pr = await this.#for(repo).get<GhPull>(`/repos/${repo}/pulls/${number}`);
    const [files, comments, inline, status] = await Promise.all([
      this.#for(repo).all<GhFile>(
        `/repos/${repo}/pulls/${number}/files`,
        { per_page: 100 },
        300,
        linkNext,
      ),
      this.#for(repo).all<GhComment>(
        `/repos/${repo}/issues/${number}/comments`,
        { per_page: 100 },
        100,
        linkNext,
      ),
      this.#for(repo).all<GhComment>(
        `/repos/${repo}/pulls/${number}/comments`,
        { per_page: 100 },
        100,
        linkNext,
      ),
      this.#status(repo, number),
    ]);
    const discussion: Comment[] = [...comments, ...inline]
      .map((c) => ({
        author: who(c.user),
        body: c.body ?? '',
        at: c.created_at,
        ...(c.path && { path: c.path }),
      }))
      .sort((a, b) => a.at.localeCompare(b.at));
    return {
      forge: 'github',
      repo,
      number,
      title: pr.title,
      author: who(pr.user),
      url: pr.html_url,
      draft: pr.draft,
      state: pr.merged_at ? 'merged' : pr.state,
      updatedAt: pr.updated_at,
      comments: pr.comments + pr.review_comments,
      ...status,
      body: pr.body ?? '',
      additions: pr.additions,
      deletions: pr.deletions,
      files: budgetPatches(
        files.map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          ...(f.patch && { patch: f.patch }),
        })),
        o.maxPatchChars,
      ),
      discussion,
    };
  }

  async listIssues(o: {
    repo?: string;
    state: 'open' | 'closed' | 'all';
    max: number;
  }): Promise<Issue[]> {
    if (!o.repo) {
      const state = o.state === 'all' ? '' : ` is:${o.state}`;
      return (await this.#search(`is:issue archived:false involves:@me${state}`, o.max)).map((i) =>
        this.#issueFromSearch(i),
      );
    }
    const repo = checkRepo(o.repo);
    const issues = await this.#for(repo).all<GhIssue>(
      `/repos/${repo}/issues`,
      { state: o.state, sort: 'updated', direction: 'desc', per_page: Math.min(o.max, 100) },
      o.max * 2,
      linkNext,
    );
    return issues
      .filter((i) => !i.pull_request)
      .slice(0, o.max)
      .map((i) => ({
        forge: 'github',
        repo,
        number: i.number,
        title: i.title,
        author: who(i.user),
        url: i.html_url,
        state: i.state,
        labels: i.labels.map((l) => l.name),
        updatedAt: i.updated_at,
        comments: i.comments,
      }));
  }

  async getIssue(repo: string, number: number): Promise<IssueDetail> {
    checkRepo(repo);
    const [i, comments] = await Promise.all([
      this.#for(repo).get<GhIssue>(`/repos/${repo}/issues/${number}`),
      this.#for(repo).all<GhComment>(
        `/repos/${repo}/issues/${number}/comments`,
        { per_page: 100 },
        100,
        linkNext,
      ),
    ]);
    return {
      forge: 'github',
      repo,
      number,
      title: i.title,
      author: who(i.user),
      url: i.html_url,
      state: i.state,
      labels: i.labels.map((l) => l.name),
      updatedAt: i.updated_at,
      comments: i.comments,
      body: i.body ?? '',
      discussion: comments.map((c) => ({
        author: who(c.user),
        body: c.body ?? '',
        at: c.created_at,
      })),
    };
  }

  gitToken(repo: string): string {
    const owner = repo.split('/')[0]?.toLowerCase();
    return this.#o.token(owner && this.#owners().includes(owner) ? owner : undefined);
  }

  async repoInfo(repo: string): Promise<RepoInfo> {
    checkRepo(repo);
    const r = await this.#for(repo).get<{
      default_branch: string;
      private: boolean;
      clone_url: string;
    }>(`/repos/${repo}`);
    return { defaultBranch: r.default_branch, private: r.private, cloneUrl: r.clone_url };
  }

  async openChange(c: NewChange): Promise<{ number: number; url: string }> {
    checkRepo(c.repo);
    const r = await this.#for(c.repo).request<{ number: number; html_url: string }>(
      'POST',
      `/repos/${c.repo}/pulls`,
      {
        body: {
          title: c.title,
          head: c.head,
          base: c.base,
          body: c.body,
          draft: c.draft,
          maintainer_can_modify: true,
        },
      },
    );
    return { number: r.data.number, url: r.data.html_url };
  }

  async comment(
    repo: string,
    number: number,
    _kind: 'change' | 'issue',
    body: string,
  ): Promise<{ url: string }> {
    checkRepo(repo);
    // PR conversation comments live on the issue endpoint too.
    const r = await this.#for(repo).request<{ html_url: string }>(
      'POST',
      `/repos/${repo}/issues/${number}/comments`,
      { body: { body } },
    );
    return { url: r.data.html_url };
  }
}

function aggregate(runs: { status: string; conclusion: string | null }[]): ChecksState {
  if (runs.length === 0) return 'none';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  const bad = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
  return runs.some((r) => bad.includes(r.conclusion ?? '')) ? 'failure' : 'success';
}
