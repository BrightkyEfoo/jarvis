import { describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/forge/github.ts';
import { GitLabClient } from '../src/forge/gitlab.ts';
import { TrelloClient } from '../src/forge/trello.ts';
import { budgetPatches } from '../src/forge/types.ts';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Answers by "METHOD pathname" (query ignored); records every call. */
function fakeFetch(
  routes: Record<string, unknown | ((u: URL) => unknown)>,
  extraHeaders: Record<string, Record<string, string>> = {},
) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({
      method,
      url: url.href,
      headers,
      ...(init?.body && { body: JSON.parse(String(init.body)) }),
    });
    const key = `${method} ${url.pathname}`;
    if (!(key in routes))
      return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 404 });
    const r = routes[key];
    const body = typeof r === 'function' ? (r as (u: URL) => unknown)(url) : r;
    return new Response(JSON.stringify(body), { status: 200, headers: extraHeaders[key] ?? {} });
  }) as typeof fetch;
  return { fn, calls };
}

const TOKEN = 'github_pat_SECRETSECRETSECRET';

describe('GitHub', () => {
  const searchItem = (n: number, repo: string, extra: object = {}) => ({
    number: n,
    title: `PR ${n}`,
    user: { login: 'paul' },
    html_url: `https://github.com/${repo}/pull/${n}`,
    state: 'open',
    draft: false,
    updated_at: '2026-10-01T10:00:00Z',
    repository_url: `https://api.github.com/repos/${repo}`,
    comments: 2,
    labels: [],
    pull_request: { merged_at: null },
    ...extra,
  });

  it('builds the inbox from three searches and adds CI + review state to his own PRs', async () => {
    const { fn, calls } = fakeFetch({
      'GET /search/issues': (u: URL) => {
        const q = u.searchParams.get('q') ?? '';
        if (q.includes('review-requested')) return { items: [searchItem(7, 'acme/app')] };
        if (q.includes('author:@me'))
          return {
            items: [searchItem(3, 'BrightkyEfoo/jarvis', { user: { login: 'BrightkyEfoo' } })],
          };
        return {
          items: [
            { ...searchItem(9, 'acme/app'), pull_request: undefined, labels: [{ name: 'bug' }] },
          ],
        };
      },
      'GET /repos/BrightkyEfoo/jarvis/pulls/3': {
        head: { ref: 'feat/x', sha: 'abc' },
        base: { ref: 'main', repo: { full_name: 'BrightkyEfoo/jarvis' } },
      },
      'GET /repos/BrightkyEfoo/jarvis/commits/abc/check-runs': {
        check_runs: [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'failure' },
        ],
      },
      'GET /repos/BrightkyEfoo/jarvis/pulls/3/reviews': [
        { user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
        { user: { login: 'a' }, state: 'APPROVED' },
        { user: { login: 'b' }, state: 'COMMENTED' },
      ],
    });
    const box = await new GitHubClient({ token: () => TOKEN, fetch: fn }).inbox(10);
    expect(box.toReview[0]).toMatchObject({ repo: 'acme/app', number: 7, author: 'paul' });
    expect(box.mine[0]).toMatchObject({
      number: 3,
      checks: 'failure',
      approvals: 1,
      changesRequested: false,
      source: 'feat/x',
      target: 'main',
    });
    expect(box.issues[0]).toMatchObject({ number: 9, labels: ['bug'] });
    for (const c of calls) {
      expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
      expect(new URL(c.url).host).toBe('api.github.com');
    }
  });

  it('reads a PR with files within the diff budget and the merged discussion', async () => {
    const big = `@@ -1 +1 @@\n${'+x\n'.repeat(5000)}`;
    const { fn } = fakeFetch({
      'GET /repos/acme/app/pulls/7': {
        number: 7,
        title: 'Fix login',
        user: { login: 'paul' },
        html_url: 'u',
        state: 'open',
        draft: false,
        merged_at: null,
        updated_at: '2026-10-01T10:00:00Z',
        body: 'Fixes #1',
        additions: 5001,
        deletions: 1,
        comments: 1,
        review_comments: 1,
        head: { ref: 'fix', sha: 'def' },
        base: { ref: 'main', repo: { full_name: 'acme/app' } },
      },
      'GET /repos/acme/app/pulls/7/files': [
        {
          filename: 'src/login.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-a\n+b',
        },
        { filename: 'big.json', status: 'added', additions: 5000, deletions: 0, patch: big },
      ],
      'GET /repos/acme/app/issues/7/comments': [
        { user: { login: 'ana' }, body: 'LGTM', created_at: '2026-10-01T11:00:00Z' },
      ],
      'GET /repos/acme/app/pulls/7/comments': [
        {
          user: { login: 'bob' },
          body: 'nit',
          created_at: '2026-10-01T10:30:00Z',
          path: 'src/login.ts',
        },
      ],
      'GET /repos/acme/app/commits/def/check-runs': { check_runs: [] },
      'GET /repos/acme/app/pulls/7/reviews': [],
    });
    const pr = await new GitHubClient({ token: () => TOKEN, fetch: fn }).getChange('acme/app', 7, {
      maxPatchChars: 2000,
    });
    expect(pr.files[0]?.patch).toContain('+b');
    expect(pr.files[1]?.patch?.length).toBeLessThan(2100);
    expect(pr.files[1]?.patch).toContain('[… diff tronqué]');
    expect(pr.discussion.map((c) => c.author)).toEqual(['bob', 'ana']);
    expect(pr).toMatchObject({ checks: 'none', additions: 5001 });
  });

  it('comments through the issue endpoint and refuses odd repo names', async () => {
    const { fn, calls } = fakeFetch({
      'POST /repos/acme/app/issues/7/comments': {
        html_url: 'https://github.com/acme/app/pull/7#c1',
      },
    });
    const gh = new GitHubClient({ token: () => TOKEN, fetch: fn });
    expect(await gh.comment('acme/app', 7, 'change', 'Merci !')).toEqual({
      url: 'https://github.com/acme/app/pull/7#c1',
    });
    expect(calls[0]?.body).toEqual({ body: 'Merci !' });
    await expect(gh.comment('../../user', 1, 'issue', 'x')).rejects.toThrow(
      'not a GitHub repository',
    );
    await expect(gh.getChange('acme/app/extra', 1, { maxPatchChars: 10 })).rejects.toThrow(
      'not a GitHub repository',
    );
    for (const bad of ['acme/..', './app', 'acme/./x']) {
      await expect(gh.comment(bad, 1, 'issue', 'x')).rejects.toThrow('not a GitHub repository');
    }
  });

  it('errors carry the status and the API message, never the token', async () => {
    const { fn } = fakeFetch({});
    const err = await new GitHubClient({ token: () => TOKEN, fetch: fn })
      .whoami()
      .catch((e: Error) => e);
    expect(String(err)).toContain('GET /user → 404');
    expect(String(err)).not.toContain(TOKEN);
  });
});

describe('GitLab', () => {
  const mr = (iid: number, extra: object = {}) => ({
    iid,
    title: `MR ${iid}`,
    author: { username: 'paul' },
    web_url: `https://gitlab.com/g/p/-/merge_requests/${iid}`,
    draft: false,
    state: 'opened',
    updated_at: '2026-10-01T10:00:00Z',
    source_branch: 'feat',
    target_branch: 'main',
    user_notes_count: 1,
    references: { full: `group/sub/proj!${iid}` },
    ...extra,
  });

  it('inbox, project paths encoded, private-token header, self-hosted base', async () => {
    const { fn, calls } = fakeFetch({
      'GET /api/v4/user': { username: 'brightky' },
      'GET /api/v4/merge_requests': (u: URL) =>
        u.searchParams.get('scope') === 'created_by_me' ? [mr(4)] : [mr(2)],
      'GET /api/v4/issues': [
        {
          iid: 5,
          title: 'Bug',
          author: { username: 'ana' },
          web_url: 'w',
          state: 'opened',
          labels: ['p1'],
          updated_at: '2026-10-01T10:00:00Z',
          user_notes_count: 0,
          references: { full: 'group/sub/proj#5' },
        },
      ],
      'GET /api/v4/projects/group%2Fsub%2Fproj/merge_requests/4': mr(4, {
        head_pipeline: { status: 'running' },
      }),
      'GET /api/v4/projects/group%2Fsub%2Fproj/merge_requests/4/approvals': {
        approved_by: [{}, {}],
      },
    });
    const gl = new GitLabClient({
      token: () => 'glpat-SECRET',
      base: 'https://git.example.cm',
      fetch: fn,
    });
    const box = await gl.inbox(10);
    expect(box.toReview[0]).toMatchObject({ forge: 'gitlab', repo: 'group/sub/proj', number: 2 });
    expect(box.mine[0]).toMatchObject({ number: 4, checks: 'pending', approvals: 2 });
    expect(box.issues[0]).toMatchObject({ repo: 'group/sub/proj', number: 5, labels: ['p1'] });
    expect(calls.find((c) => c.url.includes('reviewer_username=brightky'))).toBeTruthy();
    for (const c of calls) {
      expect(c.headers['private-token']).toBe('glpat-SECRET');
      expect(new URL(c.url).host).toBe('git.example.cm');
    }
    expect(() => new GitLabClient({ token: () => 'x', base: 'http://git.example.cm' })).toThrow(
      'https',
    );
  });

  it('reads an MR from /diffs and skips system notes', async () => {
    const { fn } = fakeFetch({
      'GET /api/v4/projects/g%2Fp/merge_requests/2': mr(2, {
        description: 'Desc',
        head_pipeline: { status: 'failed' },
      }),
      'GET /api/v4/projects/g%2Fp/merge_requests/2/diffs': [
        {
          new_path: 'a.ts',
          old_path: 'a.ts',
          new_file: false,
          deleted_file: false,
          renamed_file: false,
          diff: '@@\n-a\n+b\n+c',
        },
      ],
      'GET /api/v4/projects/g%2Fp/merge_requests/2/notes': [
        {
          author: { username: 'bot' },
          body: 'added 1 commit',
          created_at: '2026-10-01T10:00:00Z',
          system: true,
        },
        {
          author: { username: 'ana' },
          body: 'ok',
          created_at: '2026-10-01T11:00:00Z',
          system: false,
        },
      ],
      'GET /api/v4/projects/g%2Fp/merge_requests/2/approvals': { approved_by: [] },
    });
    const c = await new GitLabClient({ token: () => 't', fetch: fn }).getChange('g/p', 2, {
      maxPatchChars: 10_000,
    });
    expect(c).toMatchObject({ checks: 'failure', additions: 2, deletions: 1, body: 'Desc' });
    expect(c.files[0]).toMatchObject({ path: 'a.ts', status: 'modified' });
    expect(c.discussion).toEqual([{ author: 'ana', body: 'ok', at: '2026-10-01T11:00:00Z' }]);
  });
});

describe('Trello', () => {
  const B = '5f0000000000000000000001';
  const L = '5f0000000000000000000002';
  const C = '5f0000000000000000000003';
  const raw = {
    id: C,
    name: 'Ajouter le mode sombre',
    idBoard: B,
    idList: L,
    labels: [{ name: 'jarvis', color: 'green' }],
    due: null,
    dueComplete: false,
    url: 'https://trello.com/c/x',
    dateLastActivity: '2026-10-01T10:00:00Z',
    idMembers: ['me1'],
  };

  it('auth in the header, label filter, names resolved, comments and moves', async () => {
    const { fn, calls } = fakeFetch({
      'GET /1/members/me/cards': [raw, { ...raw, id: '5f0000000000000000000004', labels: [] }],
      [`GET /1/boards/${B}`]: { name: 'CodeVault' },
      [`GET /1/lists/${L}`]: { name: 'À faire' },
      [`GET /1/cards/${C}`]: (u: URL) =>
        u.searchParams.get('fields') === 'url'
          ? { url: raw.url }
          : {
              ...raw,
              desc: 'Détails',
              checklists: [{ name: 'Étapes', checkItems: [{ name: 'UI', state: 'complete' }] }],
              actions: [
                {
                  type: 'commentCard',
                  date: '2026-10-01T09:00:00Z',
                  data: { text: 'go' },
                  memberCreator: { username: 'ana' },
                },
              ],
            },
      [`POST /1/cards/${C}/actions/comments`]: {},
      [`PUT /1/cards/${C}`]: {},
    });
    const t = new TrelloClient({ key: () => 'KEY123', token: () => 'TOK456', fetch: fn });
    const cards = await t.cards({ label: 'JARVIS', max: 10 });
    expect(cards).toEqual([
      expect.objectContaining({
        name: 'Ajouter le mode sombre',
        board: 'CodeVault',
        list: 'À faire',
        labels: ['jarvis'],
      }),
    ]);
    const card = await t.card(C);
    expect(card).toMatchObject({
      desc: 'Détails',
      checklists: [{ name: 'Étapes', items: [{ name: 'UI', done: true }] }],
      comments: [{ author: 'ana', text: 'go' }],
    });
    await t.comment(C, 'Pris par Jarvis');
    await t.move(C, L);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ text: 'Pris par Jarvis' });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ idList: L });
    for (const c of calls) {
      expect(c.headers.authorization).toBe(
        'OAuth oauth_consumer_key="KEY123", oauth_token="TOK456"',
      );
      expect(c.url).not.toMatch(/KEY123|TOK456/);
    }
    await expect(t.card('../../members/me')).rejects.toThrow('not a Trello card id');
  });
});

describe('diff budget', () => {
  it('keeps small files whole and truncates the big one', () => {
    const files = [
      { path: 'big', status: 'm', additions: 1, deletions: 0, patch: 'x'.repeat(5000) },
      { path: 'small', status: 'm', additions: 1, deletions: 0, patch: 'y'.repeat(100) },
      { path: 'binary', status: 'm', additions: 0, deletions: 0 },
    ];
    const out = budgetPatches(files, 1000);
    expect(out[1]?.patch).toBe('y'.repeat(100));
    expect(out[0]?.patch?.startsWith('x'.repeat(900))).toBe(true);
    expect(out[0]?.patch).toContain('tronqué');
    expect(out[2]?.patch).toBeUndefined();
    expect(out.map((f) => f.path)).toEqual(['big', 'small', 'binary']);
  });
});
