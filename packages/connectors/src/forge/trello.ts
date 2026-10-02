import type { FetchFn } from '../google/oauth.ts';
import { HttpJson } from './http.ts';

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  lastActivity: string | null;
}

export interface TrelloList {
  id: string;
  name: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  board: string;
  list: string;
  labels: string[];
  due: string | null;
  dueComplete: boolean;
  url: string;
  lastActivity: string;
  members: string[];
}

export interface TrelloCardDetail extends TrelloCard {
  desc: string;
  checklists: { name: string; items: { name: string; done: boolean }[] }[];
  comments: { author: string; text: string; at: string }[];
}

interface RawCard {
  id: string;
  name: string;
  idBoard: string;
  idList: string;
  labels: { name: string; color: string | null }[];
  due: string | null;
  dueComplete: boolean;
  url: string;
  dateLastActivity: string;
  idMembers: string[];
  desc?: string;
  checklists?: { name: string; checkItems: { name: string; state: 'complete' | 'incomplete' }[] }[];
  actions?: {
    type: string;
    date: string;
    data: { text?: string };
    memberCreator?: { username: string };
  }[];
}

const ID = /^[0-9a-f]{24}$|^[A-Za-z0-9]{8}$/;
const checkId = (id: string, what: string) => {
  if (!ID.test(id)) throw new Error(`not a Trello ${what} id: ${id}`);
  return id;
};

const CARD_FIELDS = 'name,idBoard,idList,labels,due,dueComplete,url,dateLastActivity,idMembers';

/** Trello REST v1. Key and token go in the Authorization header, never in the URL. */
export class TrelloClient {
  readonly #http: HttpJson;
  #names = new Map<string, string>();

  constructor(o: { key: () => string; token: () => string; fetch?: FetchFn; base?: string }) {
    this.#http = new HttpJson({
      base: o.base ?? 'https://api.trello.com/1',
      auth: () => ({
        authorization: `OAuth oauth_consumer_key="${o.key()}", oauth_token="${o.token()}"`,
      }),
      ...(o.fetch && { fetch: o.fetch }),
    });
  }

  async whoami(): Promise<{ id: string; username: string }> {
    return this.#http.get('/members/me', { fields: 'username' });
  }

  async boards(): Promise<TrelloBoard[]> {
    const raw = await this.#http.get<
      { id: string; name: string; url: string; dateLastActivity: string | null }[]
    >('/members/me/boards', { filter: 'open', fields: 'name,url,dateLastActivity' });
    for (const b of raw) this.#names.set(b.id, b.name);
    return raw
      .map((b) => ({ id: b.id, name: b.name, url: b.url, lastActivity: b.dateLastActivity }))
      .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  }

  async lists(boardId: string): Promise<TrelloList[]> {
    const raw = await this.#http.get<TrelloList[]>(`/boards/${checkId(boardId, 'board')}/lists`, {
      filter: 'open',
      fields: 'name',
    });
    for (const l of raw) this.#names.set(l.id, l.name);
    return raw.map((l) => ({ id: l.id, name: l.name }));
  }

  async #nameOf(id: string, kind: 'board' | 'list'): Promise<string> {
    const known = this.#names.get(id);
    if (known) return known;
    const r = await this.#http.get<{ name: string }>(`/${kind}s/${id}`, { fields: 'name' });
    this.#names.set(id, r.name);
    return r.name;
  }

  async #card(c: RawCard): Promise<TrelloCard> {
    const [board, list] = await Promise.all([
      this.#nameOf(c.idBoard, 'board'),
      this.#nameOf(c.idList, 'list'),
    ]);
    return {
      id: c.id,
      name: c.name,
      board,
      list,
      labels: c.labels.map((l) => l.name || l.color || '').filter(Boolean),
      due: c.due,
      dueComplete: c.dueComplete,
      url: c.url,
      lastActivity: c.dateLastActivity,
      members: c.idMembers,
    };
  }

  /** Cards of a board, of a list, or assigned to Brightky; optionally only those with a label. */
  async cards(o: {
    boardId?: string;
    listId?: string;
    mine?: boolean;
    label?: string;
    max: number;
  }): Promise<TrelloCard[]> {
    const path = o.listId
      ? `/lists/${checkId(o.listId, 'list')}/cards`
      : o.boardId
        ? `/boards/${checkId(o.boardId, 'board')}/cards`
        : '/members/me/cards';
    const raw = await this.#http.get<RawCard[]>(path, { filter: 'open', fields: CARD_FIELDS });
    const label = o.label?.toLowerCase();
    const me = o.mine && (o.boardId || o.listId) ? (await this.whoami()).id : null;
    const picked = raw
      .filter(
        (c) => !label || c.labels.some((l) => (l.name || l.color || '').toLowerCase() === label),
      )
      .filter((c) => !me || c.idMembers.includes(me))
      .sort((a, b) => b.dateLastActivity.localeCompare(a.dateLastActivity))
      .slice(0, o.max);
    const out: TrelloCard[] = [];
    for (const c of picked) out.push(await this.#card(c));
    return out;
  }

  async card(id: string): Promise<TrelloCardDetail> {
    const c = await this.#http.get<RawCard>(`/cards/${checkId(id, 'card')}`, {
      fields: `${CARD_FIELDS},desc`,
      checklists: 'all',
      actions: 'commentCard',
      actions_limit: 30,
    });
    return {
      ...(await this.#card(c)),
      desc: c.desc ?? '',
      checklists: (c.checklists ?? []).map((l) => ({
        name: l.name,
        items: l.checkItems.map((i) => ({ name: i.name, done: i.state === 'complete' })),
      })),
      comments: (c.actions ?? [])
        .filter((a) => a.type === 'commentCard')
        .map((a) => ({
          author: a.memberCreator?.username ?? '?',
          text: a.data.text ?? '',
          at: a.date,
        }))
        .reverse(),
    };
  }

  async comment(cardId: string, text: string): Promise<{ url: string }> {
    await this.#http.request('POST', `/cards/${checkId(cardId, 'card')}/actions/comments`, {
      body: { text },
    });
    const c = await this.#http.get<{ url: string }>(`/cards/${cardId}`, { fields: 'url' });
    return { url: c.url };
  }

  async move(cardId: string, listId: string): Promise<{ list: string }> {
    await this.#http.request('PUT', `/cards/${checkId(cardId, 'card')}`, {
      body: { idList: checkId(listId, 'list') },
    });
    return { list: await this.#nameOf(listId, 'list') };
  }
}
