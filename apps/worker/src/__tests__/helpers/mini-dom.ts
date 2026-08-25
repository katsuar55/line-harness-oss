/**
 * 吐き出された client JS を **実際に評価して** 観測するための最小 DOM (2026-08-25)。
 *
 * 背景: このリポジトリの LIFF は inline script なので、静的な文字列検査だけでは
 *   「emit されているが動かない」を取り逃がす (2026-07-10 の全損、2026-07-29 の 2.5 ヶ月不可視障害)。
 *   一方 worker の vitest environment は 'node' で jsdom が無い。
 *   そこで **createElement / appendChild / textContent 集約** だけを本物と同じ意味論で持つ
 *   極小 DOM を用意し、DOM 組み立て型のレンダラ (shop-v2 の buildShopTile 系、
 *   rank-hero の renderRankHero) を素で走らせて描画結果を逐語照合する。
 *
 * 意図的に持たない機能: レイアウト、CSS 適用、イベント伝播、querySelector のセレクタ解釈
 *   (必要になったら足す。「あるように見えて嘘をつく」より無い方が安全)。
 */

export interface MiniNode {
  tagName: string;
  id: string;
  className: string;
  childNodes: MiniNode[];
  parentNode: MiniNode | null;
  style: Record<string, string>;
  attrs: Record<string, string>;
  listeners: Record<string, Array<(ev: unknown) => void>>;
  textContent: string;
  innerHTML: string;
  appendChild(child: MiniNode): MiniNode;
  removeChild(child: MiniNode): MiniNode;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  /** テスト用: 登録済みハンドラを発火する (currentTarget は自分)。 */
  dispatch(type: string): void;
  /** テスト用: この部分木の全 id を列挙する。 */
  ids(): string[];
  [key: string]: unknown;
}

export interface MiniDocument {
  createElement(tag: string): MiniNode;
  createTextNode(text: string): MiniNode;
  getElementById(id: string): MiniNode | null;
  /** ルート (テストが子を足す土台)。 */
  body: MiniNode;
}

function makeNode(tagName: string): MiniNode {
  let ownText = '';
  // img は本物と同じ既定を持たせる。 これが無いと rhMedal の
  // `img.complete && img.naturalWidth === 0` (= キャッシュ済み 404 の即時フォールバック) が
  // 常に false になり、その分岐が一度も実行されないまま緑になる (採点ループ P3)。
  const node = {
    tagName,
    id: '',
    className: '',
    childNodes: [] as MiniNode[],
    parentNode: null as MiniNode | null,
    style: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    listeners: {} as Record<string, Array<(ev: unknown) => void>>,
    get textContent(): string {
      if (node.childNodes.length === 0) return ownText;
      return node.childNodes.map((c) => c.textContent).join('');
    },
    set textContent(v: string) {
      // 本物と同じ意味論: 代入は子を全部捨ててテキスト 1 個になる
      for (const c of node.childNodes) c.parentNode = null;
      node.childNodes = [];
      ownText = v === undefined || v === null ? '' : String(v);
    },
    get innerHTML(): string {
      // このヘルパは DOM 組み立て型のレンダラ用。innerHTML 代入は検出したいので落とす。
      return '';
    },
    set innerHTML(_v: string) {
      throw new Error('mini-dom: innerHTML への代入は未対応 (DOM 組み立てで書くこと)');
    },
    appendChild(child: MiniNode): MiniNode {
      // 子が付いたら「自前テキスト」は消える (本物は共存しないため)
      if (node.childNodes.length === 0 && ownText !== '') {
        const t = makeNode('#text');
        t.textContent = ownText;
        t.parentNode = node;
        node.childNodes.push(t);
        ownText = '';
      }
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    removeChild(child: MiniNode): MiniNode {
      const i = node.childNodes.indexOf(child);
      if (i >= 0) node.childNodes.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(k: string, v: string): void {
      node.attrs[k] = String(v);
    },
    getAttribute(k: string): string | null {
      return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null;
    },
    addEventListener(type: string, fn: (ev: unknown) => void): void {
      (node.listeners[type] ||= []).push(fn);
    },
    complete: false,
    naturalWidth: 0,
    dispatch(type: string): void {
      for (const fn of node.listeners[type] || []) fn({ currentTarget: node, preventDefault() {} });
    },
    ids(): string[] {
      const out: string[] = [];
      const walk = (n: MiniNode): void => {
        if (n.id) out.push(n.id);
        for (const c of n.childNodes) walk(c);
      };
      walk(node);
      return out;
    },
  } as unknown as MiniNode;
  return node;
}

export function makeMiniDocument(): MiniDocument {
  const body = makeNode('body');
  const find = (n: MiniNode, id: string): MiniNode | null => {
    if (n.id === id) return n;
    for (const c of n.childNodes) {
      const hit = find(c, id);
      if (hit) return hit;
    }
    return null;
  };
  return {
    body,
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (text: string) => {
      const t = makeNode('#text');
      t.textContent = text;
      return t;
    },
    getElementById: (id: string) => find(body, id),
  };
}

/** id を辿って 1 個返す (見つからなければ throw — 「無いのに緑」を防ぐ)。 */
export function byId(doc: MiniDocument, id: string): MiniNode {
  const el = doc.getElementById(id);
  if (!el) throw new Error('mini-dom: #' + id + ' が見つかりません');
  return el;
}
