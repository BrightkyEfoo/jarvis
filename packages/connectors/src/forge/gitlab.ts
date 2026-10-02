import type { FetchFn } from '../google/oauth.ts';
import { HttpJson } from './http.ts';
import {
  budgetPatches,
  type ChangeDetail,
  type ChangeRequest,
  type ChecksState,
  type ForgeClient,
  type ForgeInbox,
  type Issue,
  type IssueDetail,
  type NewChange,
  REPO_PATH,
  type RepoInfo,
} from './types.ts';

interface GlUser {
  username: string;
}
interface GlMr {
  iid: number;
  title: string;
  author: GlUser | null;
  web_url: string;
  draft?: boolean;
  work_in_progress?: boolean;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  updated_at: string;
  source_branch: string;
  target_branch: string;
  user_notes_count: number;
  references: { full: string };
  description?: string | null;
  head_pipeline?: { status: string } | null;
}
interface GlDiff {
  new_path: string;
  old_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
}
interface GlNote {
  author: GlUser | null;
  body: string;
  created_at: string;
  system: boolean;
  position?: { new_path?: string };
}
interface GlIssue {
  iid: number;
  title: string;
  author: GlUser | null;
  web_url: string;
  state: 'opened' | 'closed';
  labels: string[];
  updated_at: string;
  user_notes_count: number;
  references: { full: string };
  description?: string | null;
}

const who = (u: GlUser | null) => u?.username ?? 'ghost';
/** "group/project!12" or "group/project#3" → "group/project". */
const repoOf = (full: string) => full.replace(/[!#]\d+$/, '');
const project = (repo: string) => {
  if (!REPO_PATH.test(repo)) throw new Error(`not a GitLab project path: ${repo}`);
  return encodeURIComponent(repo);
};

/** X-Next-Page (GitLab keyset/offset pagination). */
const nextPage = (h: Headers, url: string): string | null => {
  const n = h.get('x-next-page');
  if (!n) return null;
  const u = new URL(url);
  u.searchParams.set('page', n);
  return u.href;
};

function checks(status: string | undefined): ChecksState {
  if (!status) return 'none';
  if (status === 'success') return 'success';
  if (['failed', 'canceled'].includes(status)) return 'failure';
  return 'pending';
}

/** GitLab REST v4 (gitlab.com or self-hosted) with a personal access token. */
export class GitLabClient implements ForgeClient {
  readonly forge = 'gitlab' as const;
  readonly gitUser = 'oauth2';
  readonly #token: () => string;
  readonly #http: HttpJson;
  #login: string | null = null;

  constructor(o: { token: () => string; base?: string; fetch?: FetchFn }) {
    this.#token = o.token;
    const root = (o.base ?? 'https://gitlab.com').replace(/\/+$/, '');
    if (!root.startsWith('https://')) throw new Error('GitLab must be reached over https');
    this.#http = new HttpJson({
      base: `${root}/api/v4`,
      auth: () => ({ 'private-token': o.token() }),
      ...(o.fetch && { fetch: o.fetch }),
    });
  }

  async whoami(): Promise<string> {
    this.#login ??= (await this.#http.get<GlUser>('/user')).username;
    return this.#login;
  }

  #mr(m: GlMr): ChangeRequest {
    return {
      forge: 'gitlab',
      repo: repoOf(m.references.full),
      number: m.iid,
      title: m.title,
      author: who(m.author),
      url: m.web_url,
      draft: m.draft ?? m.work_in_progress ?? false,
      state: m.state === 'opened' || m.state === 'locked' ? 'open' : m.state,
      updatedAt: m.updated_at,
      comments: m.user_notes_count,
      source: m.source_branch,
      target: m.target_branch,
      ...(m.head_pipeline !== undefined && { checks: checks(m.head_pipeline?.status) }),
    };
  }

  #issue(i: GlIssue): Issue {
    return {
      forge: 'gitlab',
      repo: repoOf(i.references.full),
      number: i.iid,
      title: i.title,
      author: who(i.author),
      url: i.web_url,
      state: i.state === 'opened' ? 'open' : 'closed',
      labels: i.labels,
      updatedAt: i.updated_at,
      comments: i.user_notes_count,
    };
  }

  async #mrStatus(m: ChangeRequest): Promise<ChangeRequest> {
    const id = project(m.repo);
    const [detail, approvals] = await Promise.all([
      this.#http.get<GlMr>(`/projects/${id}/merge_requests/${m.number}`),
      this.#http
        .get<{ approved_by: unknown[] }>(`/projects/${id}/merge_requests/${m.number}/approvals`)
        .catch(() => ({ approved_by: [] })),
    ]);
    return {
      ...m,
      checks: checks(detail.head_pipeline?.status),
      approvals: approvals.approved_by.length,
    };
  }

  async inbox(max: number): Promise<ForgeInbox> {
    const me = await this.whoami();
    const per = Math.min(max, 100);
    const [review, mine, issues] = await Promise.all([
      this.#http.get<GlMr[]>('/merge_requests', {
        state: 'opened',
        scope: 'all',
        reviewer_username: me,
        per_page: per,
      }),
      this.#http.get<GlMr[]>('/merge_requests', {
        state: 'opened',
        scope: 'created_by_me',
        per_page: per,
      }),
      this.#http.get<GlIssue[]>('/issues', {
        state: 'opened',
        scope: 'assigned_to_me',
        per_page: per,
      }),
    ]);
    const minePrs = mine.map((m) => this.#mr(m));
    await Promise.all(
      minePrs.slice(0, 10).map(async (p, i) => {
        minePrs[i] = await this.#mrStatus(p).catch(() => p);
      }),
    );
    return {
      toReview: review.map((m) => this.#mr(m)),
      mine: minePrs,
      issues: issues.map((i) => this.#issue(i)),
    };
  }

  async listChanges(o: {
    repo?: string;
    state: 'open' | 'closed' | 'all';
    max: number;
  }): Promise<ChangeRequest[]> {
    const state = o.state === 'open' ? 'opened' : o.state;
    const query = {
      state,
      order_by: 'updated_at',
      per_page: Math.min(o.max, 100),
      ...(!o.repo && { scope: 'all' }),
    };
    const path = o.repo ? `/projects/${project(o.repo)}/merge_requests` : '/merge_requests';
    if (!o.repo) {
      // Everything involving Brightky: his own and the ones he reviews.
      const me = await this.whoami();
      const [mine, review] = await Promise.all([
        this.#http.get<GlMr[]>(path, { ...query, scope: 'created_by_me' }),
        this.#http.get<GlMr[]>(path, { ...query, reviewer_username: me }),
      ]);
      const seen = new Set<string>();
      return [...mine, ...review]
        .filter((m) => !seen.has(m.web_url) && seen.add(m.web_url))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, o.max)
        .map((m) => this.#mr(m));
    }
    return (await this.#http.all<GlMr>(path, query, o.max, nextPage)).map((m) => this.#mr(m));
  }

  async getChange(
    repo: string,
    number: number,
    o: { maxPatchChars: number },
  ): Promise<ChangeDetail> {
    const id = project(repo);
    const [m, diffs, notes, approvals] = await Promise.all([
      this.#http.get<GlMr>(`/projects/${id}/merge_requests/${number}`),
      this.#http.all<GlDiff>(
        `/projects/${id}/merge_requests/${number}/diffs`,
        { per_page: 100 },
        300,
        nextPage,
      ),
      this.#http.all<GlNote>(
        `/projects/${id}/merge_requests/${number}/notes`,
        { sort: 'asc', per_page: 100 },
        200,
        nextPage,
      ),
      this.#http
        .get<{ approved_by: unknown[] }>(`/projects/${id}/merge_requests/${number}/approvals`)
        .catch(() => ({ approved_by: [] })),
    ]);
    const files = diffs.map((d) => {
      const lines = d.diff.split('\n');
      return {
        path: d.new_path,
        status: d.new_file
          ? 'added'
          : d.deleted_file
            ? 'removed'
            : d.renamed_file
              ? 'renamed'
              : 'modified',
        additions: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
        deletions: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
        ...(d.diff && { patch: d.diff }),
      };
    });
    return {
      ...this.#mr(m),
      repo,
      checks: checks(m.head_pipeline?.status),
      approvals: approvals.approved_by.length,
      body: m.description ?? '',
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      files: budgetPatches(files, o.maxPatchChars),
      discussion: notes
        .filter((n) => !n.system)
        .map((n) => ({
          author: who(n.author),
          body: n.body,
          at: n.created_at,
          ...(n.position?.new_path && { path: n.position.new_path }),
        })),
    };
  }

  async listIssues(o: {
    repo?: string;
    state: 'open' | 'closed' | 'all';
    max: number;
  }): Promise<Issue[]> {
    const state = o.state === 'open' ? 'opened' : o.state;
    const path = o.repo ? `/projects/${project(o.repo)}/issues` : '/issues';
    const query = {
      state,
      order_by: 'updated_at',
      per_page: Math.min(o.max, 100),
      ...(!o.repo && { scope: 'assigned_to_me' }),
    };
    return (await this.#http.all<GlIssue>(path, query, o.max, nextPage)).map((i) => this.#issue(i));
  }

  async getIssue(repo: string, number: number): Promise<IssueDetail> {
    const id = project(repo);
    const [i, notes] = await Promise.all([
      this.#http.get<GlIssue>(`/projects/${id}/issues/${number}`),
      this.#http.all<GlNote>(
        `/projects/${id}/issues/${number}/notes`,
        { sort: 'asc', per_page: 100 },
        200,
        nextPage,
      ),
    ]);
    return {
      ...this.#issue(i),
      repo,
      body: i.description ?? '',
      discussion: notes
        .filter((n) => !n.system)
        .map((n) => ({ author: who(n.author), body: n.body, at: n.created_at })),
    };
  }

  gitToken(_repo: string): string {
    return this.#token();
  }

  async repoInfo(repo: string): Promise<RepoInfo> {
    const p = await this.#http.get<{
      default_branch: string;
      visibility: string;
      http_url_to_repo: string;
    }>(`/projects/${project(repo)}`);
    return {
      defaultBranch: p.default_branch,
      private: p.visibility !== 'public',
      cloneUrl: p.http_url_to_repo,
    };
  }

  async openChange(c: NewChange): Promise<{ number: number; url: string }> {
    const r = await this.#http.request<{ iid: number; web_url: string }>(
      'POST',
      `/projects/${project(c.repo)}/merge_requests`,
      {
        body: {
          source_branch: c.head,
          target_branch: c.base,
          title: c.draft ? `Draft: ${c.title}` : c.title,
          description: c.body,
          remove_source_branch: true,
        },
      },
    );
    return { number: r.data.iid, url: r.data.web_url };
  }

  async comment(
    repo: string,
    number: number,
    kind: 'change' | 'issue',
    body: string,
  ): Promise<{ url: string }> {
    const id = project(repo);
    const kindPath = kind === 'change' ? 'merge_requests' : 'issues';
    const r = await this.#http.request<{ id: number }>(
      'POST',
      `/projects/${id}/${kindPath}/${number}/notes`,
      { body: { body } },
    );
    const page = await this.#http.get<{ web_url: string }>(`/projects/${id}/${kindPath}/${number}`);
    return { url: `${page.web_url}#note_${r.data.id}` };
  }
}
