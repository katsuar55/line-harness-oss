/**
 * Tests for expandVariables (services/step-delivery.ts).
 *
 * Phase 5β-1d-2b 新規: {{line_friend_coupon_code}} placeholder + {{#if_coupon}} conditional block
 * を追加した際、 既存 placeholder (name/uid/friend_id/ref) と conditional block の挙動が
 * 変わっていないこと + 新規 block の挙動を検証する。
 */

import { describe, it, expect } from 'vitest';
import { expandVariables } from '../services/step-delivery.js';

interface MinimalFriend {
  id: string;
  display_name: string | null;
  user_id: string | null;
  ref_code?: string | null;
  line_friend_coupon_code?: string | null;
}

const baseFriend: MinimalFriend = {
  id: 'friend-1',
  display_name: '太郎',
  user_id: 'user-uuid-1',
  ref_code: null,
  line_friend_coupon_code: null,
};

describe('expandVariables — basic placeholders', () => {
  it('{{name}} → display_name に置換', () => {
    expect(expandVariables('こんにちは {{name}} さん', baseFriend)).toBe(
      'こんにちは 太郎 さん',
    );
  });

  it('display_name が null なら空文字に置換', () => {
    expect(expandVariables('Hello {{name}}!', { ...baseFriend, display_name: null })).toBe(
      'Hello !',
    );
  });

  it('{{uid}} → user_id', () => {
    expect(expandVariables('uid={{uid}}', baseFriend)).toBe('uid=user-uuid-1');
  });

  it('{{friend_id}} → friend.id', () => {
    expect(expandVariables('fid={{friend_id}}', baseFriend)).toBe('fid=friend-1');
  });

  it('{{ref}} → ref_code (truthy)', () => {
    expect(expandVariables('ref={{ref}}', { ...baseFriend, ref_code: 'AMB-123' })).toBe(
      'ref=AMB-123',
    );
  });

  it('{{ref}} → 空文字 (ref_code null)', () => {
    expect(expandVariables('ref={{ref}}', baseFriend)).toBe('ref=');
  });

  it('複数 placeholder を一度に置換', () => {
    expect(
      expandVariables('{{name}} (uid={{uid}}, fid={{friend_id}})', baseFriend),
    ).toBe('太郎 (uid=user-uuid-1, fid=friend-1)');
  });

  it('placeholder が無いテキストはそのまま返す', () => {
    expect(expandVariables('hello world', baseFriend)).toBe('hello world');
  });
});

describe('expandVariables — {{#if_ref}} conditional', () => {
  it('ref_code 有り → block を表示', () => {
    const content = '{{#if_ref}}コード: {{ref}}{{/if_ref}}';
    expect(expandVariables(content, { ...baseFriend, ref_code: 'X1' })).toBe('コード: X1');
  });

  it('ref_code null → block を非表示 (空文字)', () => {
    const content = 'before{{#if_ref}}コード: {{ref}}{{/if_ref}}after';
    expect(expandVariables(content, baseFriend)).toBe('beforeafter');
  });

  it('複数行 block も非表示', () => {
    const content = 'A\n{{#if_ref}}line1\nline2\n{{/if_ref}}B';
    expect(expandVariables(content, baseFriend)).toBe('A\nB');
  });
});

describe('expandVariables — {{line_friend_coupon_code}} (5β-1d-2b)', () => {
  it('coupon code 有り → 文字列に置換', () => {
    const content = 'クーポン: {{line_friend_coupon_code}}';
    expect(
      expandVariables(content, { ...baseFriend, line_friend_coupon_code: 'LINE-ABCD2345' }),
    ).toBe('クーポン: LINE-ABCD2345');
  });

  it('coupon code null → 空文字 (raw placeholder は残らない)', () => {
    expect(expandVariables('code={{line_friend_coupon_code}}', baseFriend)).toBe('code=');
  });

  it('coupon code undefined (field 無し) → 空文字', () => {
    const friendNoCouponField = {
      id: 'f-1',
      display_name: null,
      user_id: null,
    };
    expect(expandVariables('{{line_friend_coupon_code}}', friendNoCouponField)).toBe('');
  });

  it('coupon code 空文字 → 空文字 (falsy として扱う)', () => {
    expect(
      expandVariables('{{line_friend_coupon_code}}', { ...baseFriend, line_friend_coupon_code: '' }),
    ).toBe('');
  });
});

describe('expandVariables — {{#if_coupon}} conditional block (5β-1d-2b)', () => {
  it('coupon code 有り → block 表示 + 内部 placeholder 展開', () => {
    const content =
      '本文\n{{#if_coupon}}🎁 クーポン: {{line_friend_coupon_code}} (初回限定){{/if_coupon}}\n末尾';
    const result = expandVariables(content, {
      ...baseFriend,
      line_friend_coupon_code: 'LINE-XYZ23456',
    });
    expect(result).toContain('🎁 クーポン: LINE-XYZ23456 (初回限定)');
    expect(result).toContain('本文');
    expect(result).toContain('末尾');
  });

  it('coupon code null → block 全削除 (前後の本文は残る)', () => {
    const content =
      '本文{{#if_coupon}}\n🎁 クーポン: {{line_friend_coupon_code}}\n{{/if_coupon}}末尾';
    expect(expandVariables(content, baseFriend)).toBe('本文末尾');
  });

  it('coupon code 空文字 → block 削除', () => {
    const content = 'A{{#if_coupon}}coupon{{/if_coupon}}B';
    expect(
      expandVariables(content, { ...baseFriend, line_friend_coupon_code: '' }),
    ).toBe('AB');
  });

  it('複数 block / 複数行を正しく削除', () => {
    const content = '1{{#if_coupon}}X{{/if_coupon}}2{{#if_coupon}}Y{{/if_coupon}}3';
    expect(expandVariables(content, baseFriend)).toBe('123');
  });

  it('{{#if_ref}} と {{#if_coupon}} の組み合わせ', () => {
    const content =
      '{{#if_ref}}REF={{ref}}{{/if_ref}}|{{#if_coupon}}COUPON={{line_friend_coupon_code}}{{/if_coupon}}';
    expect(
      expandVariables(content, {
        ...baseFriend,
        ref_code: 'R1',
        line_friend_coupon_code: 'C1',
      }),
    ).toBe('REF=R1|COUPON=C1');

    expect(
      expandVariables(content, {
        ...baseFriend,
        ref_code: 'R1',
        line_friend_coupon_code: null,
      }),
    ).toBe('REF=R1|');

    expect(
      expandVariables(content, {
        ...baseFriend,
        ref_code: null,
        line_friend_coupon_code: 'C1',
      }),
    ).toBe('|COUPON=C1');
  });
});

describe('expandVariables — {{auth_url:CHANNEL_ID}} (apiOrigin 必須)', () => {
  it('apiOrigin あり → URL 生成', () => {
    const result = expandVariables(
      'open: {{auth_url:U123}}',
      { ...baseFriend, user_id: 'uid-abc' },
      'https://example.workers.dev',
    );
    expect(result).toContain('https://example.workers.dev/auth/line?');
    expect(result).toContain('account=U123');
    expect(result).toContain('uid=uid-abc');
    expect(result).toContain('ref=cross-link');
  });

  it('apiOrigin なし → placeholder のまま (展開しない)', () => {
    const result = expandVariables('{{auth_url:U1}}', baseFriend);
    expect(result).toBe('{{auth_url:U1}}');
  });
});
