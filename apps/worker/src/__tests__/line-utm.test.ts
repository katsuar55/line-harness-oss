import { describe, it, expect } from 'vitest';
import { tagLineUtm, tagLineUtmDeep } from '../services/line-utm.js';
import { lineUtmJs } from '../routes/liff-portal-fragments/line-utm.js';

const MSG = { medium: 'message', campaign: 'welcome' } as const;

describe('tagLineUtm (サーバー側)', () => {
  it('公式ストアのリンクに utm を付ける', () => {
    const out = new URL(tagLineUtm('https://naturism-diet.com/products/x', MSG));
    expect(out.searchParams.get('utm_source')).toBe('line');
    expect(out.searchParams.get('utm_medium')).toBe('message');
    expect(out.searchParams.get('utm_campaign')).toBe('welcome');
    expect(out.searchParams.get('ref')).toBeNull();
  });

  it('www つきも対象・hash は保つ', () => {
    const out = new URL(tagLineUtm('https://www.naturism-diet.com/pages/compare#nxcp-blue', MSG));
    expect(out.searchParams.get('utm_source')).toBe('line');
    expect(out.hash).toBe('#nxcp-blue');
  });

  it('カート直行リンクには ref も付け、discount は残す', () => {
    const out = new URL(
      tagLineUtm('https://naturism-diet.com/cart/123:1?discount=ABC', { medium: 'miniapp', campaign: 'shop' }),
    );
    expect(out.searchParams.get('discount')).toBe('ABC');
    expect(out.searchParams.get('ref')).toBe('line-miniapp-shop');
  });

  it('外部・既に utm_source あり・/apps/・壊れた URL は触らない', () => {
    expect(tagLineUtm('https://www.instagram.com/naturism_supplement/', MSG)).toBe(
      'https://www.instagram.com/naturism_supplement/',
    );
    const tagged = 'https://naturism-diet.com/?utm_source=line&utm_medium=social&utm_campaign=richmenu';
    expect(tagLineUtm(tagged, MSG)).toBe(tagged);
    expect(tagLineUtm('https://naturism-diet.com/apps/line-link', MSG)).toBe(
      'https://naturism-diet.com/apps/line-link',
    );
    expect(tagLineUtm('not a url', MSG)).toBe('not a url');
  });
});

describe('tagLineUtmDeep (メッセージの中を走査)', () => {
  it('flex の uri に印を付け、元のオブジェクトは変えない', () => {
    const messages = [
      { type: 'text', text: 'https://naturism-diet.com/ はそのまま (text は触らない)' },
      {
        type: 'flex',
        altText: 'x',
        contents: {
          type: 'bubble',
          footer: {
            type: 'box',
            contents: [
              { type: 'button', action: { type: 'uri', label: 'a', uri: 'https://naturism-diet.com/' } },
              { type: 'button', action: { type: 'uri', label: 'b', uri: 'https://x.com/naturism_diet' } },
            ],
          },
        },
      },
    ];
    const snapshot = JSON.stringify(messages);
    const out = tagLineUtmDeep(messages, MSG);
    expect(JSON.stringify(messages)).toBe(snapshot);
    const s = JSON.stringify(out);
    expect(s).toContain('utm_campaign=welcome');
    expect(s).toContain('"uri":"https://x.com/naturism_diet"');
    expect((out[0] as { text: string }).text).toBe(messages[0].text);
  });
});

// ── client JS: 実ブラウザの代わりに最小のスタブで評価する ──
type ClickHandler = (ev: { target: unknown }) => void;

function loadClient(campaignDefault?: string) {
  let handler: ClickHandler | null = null;
  const document = {
    addEventListener: (type: string, fn: ClickHandler) => {
      if (type === 'click') handler = fn;
    },
  };
  const window = { location: { href: 'https://liff.example.com/liff/portal' } };
  const fn = new Function(
    'window',
    'document',
    lineUtmJs(campaignDefault) + '\nreturn { nxLineUtm: nxLineUtm, nxLineUtmLast: nxLineUtmLast };',
  );
  const api = fn(window, document) as {
    nxLineUtm: (u: string, c?: string, ct?: string) => string;
    nxLineUtmLast: (u: string) => string;
  };
  return { api, click: (target: unknown) => handler?.({ target }) };
}

function el(attrs: Record<string, string>, parent: unknown = null, href?: string) {
  const node: Record<string, unknown> = {
    nodeType: 1,
    id: attrs.id ?? '',
    parentNode: parent,
    getAttribute: (k: string) => (k === 'href' ? href ?? null : attrs[k] ?? null),
  };
  if (href !== undefined) node.href = href;
  node.closest = (sel: string) => {
    let n: Record<string, unknown> | null = node;
    while (n) {
      if (sel === 'a[href]' && n.href !== undefined) return n;
      n = n.parentNode as Record<string, unknown> | null;
    }
    return null;
  };
  return node;
}

describe('lineUtmJs (ミニアプリの client JS)', () => {
  it('バックスラッシュを含まない (template literal で潰れない)', () => {
    expect(lineUtmJs()).not.toContain('\\');
  });

  it('nxLineUtm は サーバー側と同じ規則', () => {
    const { api } = loadClient();
    const out = new URL(api.nxLineUtm('https://naturism-diet.com/cart/1:1', 'shop'));
    expect(out.searchParams.get('utm_medium')).toBe('miniapp');
    expect(out.searchParams.get('utm_campaign')).toBe('shop');
    expect(out.searchParams.get('ref')).toBe('line-miniapp-shop');
    expect(api.nxLineUtm('https://naturism-diet.com/apps/line-link', 'home')).toBe(
      'https://naturism-diet.com/apps/line-link',
    );
  });

  it('リンクを押すと、囲む section-<名前> を campaign にして href を書き換える', () => {
    const { click } = loadClient();
    const section = el({ id: 'section-quiz' });
    const a = el({ 'data-utm-content': 'compare' }, section, 'https://naturism-diet.com/pages/compare');
    click(a);
    const out = new URL(a.href as string);
    expect(out.searchParams.get('utm_campaign')).toBe('quiz');
    expect(out.searchParams.get('utm_content')).toBe('compare');
  });

  it('section が無ければ既定の campaign (会員証は rank)', () => {
    const { click } = loadClient('rank');
    const a = el({}, null, 'https://naturism-diet.com/discount/ABC');
    click(a);
    expect(new URL(a.href as string).searchParams.get('utm_campaign')).toBe('rank');
  });

  it('openExternalUrl 用: 直前に押した画面名を使う', () => {
    const { api, click } = loadClient();
    const section = el({ id: 'section-shop' });
    const button = el({}, section);
    click(button);
    const out = new URL(api.nxLineUtmLast('https://naturism-diet.com/products/x'));
    expect(out.searchParams.get('utm_campaign')).toBe('shop');
  });

  it('# だけのリンクと外部リンクは触らない', () => {
    const { click } = loadClient();
    const hashA = el({}, null, '#top');
    click(hashA);
    expect(hashA.href).toBe('#top');
    const ext = el({}, null, 'https://www.instagram.com/x/');
    click(ext);
    expect(ext.href).toBe('https://www.instagram.com/x/');
  });
});

// ── 配線の確認 (ソース): 画面に組み込まれていること ──
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');

describe('配線', () => {
  it('ポータルは lineUtmJs を読み込み、openExternalUrl が印を付ける', () => {
    const src = readFileSync(join(routesDir, 'liff-pages.ts'), 'utf8');
    expect(src).toContain('${lineUtmJs()}');
    expect(src).toMatch(/function openExternalUrl\(url\) \{\r?\n  url = nxLineUtmLast\(url\);/);
  });
  it('会員証は campaign=rank で読み込む', () => {
    const src = readFileSync(join(routesDir, 'liff-my-rank.ts'), 'utf8');
    expect(src).toContain("${lineUtmJs('rank')}");
  });
});
