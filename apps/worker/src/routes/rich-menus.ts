import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { getFriendById } from '@line-crm/db';
import type { Env } from '../index.js';

const richMenus = new Hono<Env>();

// GET /api/rich-menus — list all rich menus from LINE API
richMenus.get('/api/rich-menus', async (c) => {
  try {
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const result = await lineClient.getRichMenuList();
    return c.json({ success: true, data: result.richmenus ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/rich-menus error:', message);
    return c.json({ success: false, error: `Failed to fetch rich menus: ${message}` }, 500);
  }
});

// POST /api/rich-menus — create a rich menu via LINE API
richMenus.post('/api/rich-menus', async (c) => {
  try {
    const body = await c.req.json();
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const result = await lineClient.createRichMenu(body);
    return c.json({ success: true, data: result }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus error:', message);
    return c.json({ success: false, error: `Failed to create rich menu: ${message}` }, 500);
  }
});

// DELETE /api/rich-menus/:id — delete a rich menu
richMenus.delete('/api/rich-menus/:id', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.deleteRichMenu(richMenuId);
    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('DELETE /api/rich-menus/:id error:', message);
    return c.json({ success: false, error: `Failed to delete rich menu: ${message}` }, 500);
  }
});

// POST /api/rich-menus/:id/default — set rich menu as default for all users
richMenus.post('/api/rich-menus/:id/default', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.setDefaultRichMenu(richMenuId);
    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/:id/default error:', message);
    return c.json({ success: false, error: `Failed to set default rich menu: ${message}` }, 500);
  }
});

// ─── Rich Menu Alias endpoints ─────────────────────────────────────────────
// alias は LINE プラットフォーム上の「固定ID」。richMenuId は画像変更のたびに
// 新規発行されるが、alias は付替え可能で UI から見ると一貫したID で扱える。

// GET /api/rich-menus/aliases — list all aliases
richMenus.get('/api/rich-menus/aliases', async (c) => {
  try {
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const result = await lineClient.getRichMenuAliasList();
    return c.json({ success: true, data: result.aliases ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/rich-menus/aliases error:', message);
    return c.json({ success: false, error: `Failed to list aliases: ${message}` }, 500);
  }
});

// POST /api/rich-menus/aliases — create alias { aliasId, richMenuId }
richMenus.post('/api/rich-menus/aliases', async (c) => {
  try {
    const body = await c.req.json<{ aliasId: string; richMenuId: string }>();
    if (!body.aliasId || !body.richMenuId) {
      return c.json({ success: false, error: 'aliasId and richMenuId are required' }, 400);
    }
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.createRichMenuAlias(body.aliasId, body.richMenuId);
    return c.json({ success: true, data: { aliasId: body.aliasId, richMenuId: body.richMenuId } }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/aliases error:', message);
    return c.json({ success: false, error: `Failed to create alias: ${message}` }, 500);
  }
});

// PUT /api/rich-menus/aliases/:aliasId — point alias at a different richMenuId
richMenus.put('/api/rich-menus/aliases/:aliasId', async (c) => {
  try {
    const aliasId = c.req.param('aliasId');
    const body = await c.req.json<{ richMenuId: string }>();
    if (!body.richMenuId) {
      return c.json({ success: false, error: 'richMenuId is required' }, 400);
    }
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.updateRichMenuAlias(aliasId, body.richMenuId);
    return c.json({ success: true, data: { aliasId, richMenuId: body.richMenuId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('PUT /api/rich-menus/aliases/:aliasId error:', message);
    return c.json({ success: false, error: `Failed to update alias: ${message}` }, 500);
  }
});

// DELETE /api/rich-menus/aliases/:aliasId
richMenus.delete('/api/rich-menus/aliases/:aliasId', async (c) => {
  try {
    const aliasId = c.req.param('aliasId');
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.deleteRichMenuAlias(aliasId);
    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('DELETE /api/rich-menus/aliases/:aliasId error:', message);
    return c.json({ success: false, error: `Failed to delete alias: ${message}` }, 500);
  }
});

// POST /api/friends/:friendId/rich-menu — link rich menu to a specific friend
richMenus.post('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const body = await c.req.json<{ richMenuId: string }>();

    if (!body.richMenuId) {
      return c.json({ success: false, error: 'richMenuId is required' }, 400);
    }

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.linkRichMenuToUser(friend.line_user_id, body.richMenuId);

    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/friends/:friendId/rich-menu error:', message);
    return c.json({ success: false, error: `Failed to link rich menu to friend: ${message}` }, 500);
  }
});

// DELETE /api/friends/:friendId/rich-menu — unlink rich menu from a specific friend
richMenus.delete('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.unlinkRichMenuFromUser(friend.line_user_id);

    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('DELETE /api/friends/:friendId/rich-menu error:', message);
    return c.json({ success: false, error: `Failed to unlink rich menu from friend: ${message}` }, 500);
  }
});

// GET /api/rich-menus/status — リッチメニュー診断（デフォルト設定・全メニュー一覧）
richMenus.get('/api/rich-menus/status', async (c) => {
  try {
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);

    // デフォルトリッチメニューのIDを取得
    let defaultMenuId: string | null = null;
    try {
      const resp = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        headers: { Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      });
      if (resp.ok) {
        const data = await resp.json<{ richMenuId: string }>();
        defaultMenuId = data.richMenuId;
      }
    } catch { /* no default */ }

    // 全リッチメニュー一覧
    const list = await lineClient.getRichMenuList();
    const menus = (list.richmenus ?? []).map((m: any) => ({
      richMenuId: m.richMenuId,
      name: m.name,
      size: m.size,
      chatBarText: m.chatBarText,
      selected: m.selected,
      areaCount: Array.isArray(m.areas) ? m.areas.length : 0,
      isDefault: m.richMenuId === defaultMenuId,
    }));

    return c.json({
      success: true,
      data: { defaultRichMenuId: defaultMenuId, totalMenus: menus.length, menus },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});

// POST /api/rich-menus/setup-naturism — naturism用リッチメニュー一括セットアップ v3
// 8ボタン（本番同等レイアウト）: 左2列大 + 右1列上下分割×4
// フロー: 1. 既存デフォルト削除 → 2. 構造作成 → 3. 画像アップロード → 4. デフォルト設定
richMenus.post('/api/rich-menus/setup-naturism', async (c) => {
  try {
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const liffUrl = c.env.LIFF_URL || 'https://liff.line.me/2009713578-NbdHyFZf';

    // Step 0: 既存デフォルトリッチメニューを解除（新規設定のため）
    try {
      await lineClient.deleteDefaultRichMenu();
    } catch {
      // デフォルトが無い場合は無視
    }

    // naturism リッチメニュー定義（2500×1686 フルサイズ）
    // レイアウト: 左2列(各833px) + 右1列(834px, 上下分割)
    const colW = 833;       // 左2列の幅
    const colWR = 834;      // 右列の幅 (2500 - 833*2 = 834)
    const rowH = 843;       // 行の高さ (1686/2)
    const halfH = 421;      // 右列セル高さ (上)
    const halfH2 = 422;     // 右列セル高さ (下, 843-421=422)

    const richMenuBody = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: 'naturism メインメニュー v3',
      chatBarText: 'メニュー',
      areas: [
        // 上段左: ホームページ
        {
          bounds: { x: 0, y: 0, width: colW, height: rowH },
          action: { type: 'uri' as const, label: 'ホームページ', uri: 'https://naturism-diet.com' },
        },
        // 上段中: カテゴリー
        {
          bounds: { x: colW, y: 0, width: colW, height: rowH },
          action: { type: 'uri' as const, label: 'カテゴリー', uri: 'https://naturism-diet.com/collections' },
        },
        // 上段右上: 友達紹介
        {
          bounds: { x: colW * 2, y: 0, width: colWR, height: halfH },
          action: { type: 'uri' as const, label: '友達紹介', uri: `${liffUrl}#referral` },
        },
        // 上段右下: マイランク
        {
          bounds: { x: colW * 2, y: halfH, width: colWR, height: halfH2 },
          action: { type: 'uri' as const, label: 'マイランク', uri: `${liffUrl}#rank` },
        },
        // 下段左: 配送状況をみる
        {
          bounds: { x: 0, y: rowH, width: colW, height: rowH },
          action: { type: 'uri' as const, label: '配送状況をみる', uri: `${liffUrl}#delivery` },
        },
        // 下段中: 購入履歴・再購入
        {
          bounds: { x: colW, y: rowH, width: colW, height: rowH },
          action: { type: 'uri' as const, label: '購入履歴・再購入', uri: `${liffUrl}#reorder` },
        },
        // 下段右上: SNS
        {
          bounds: { x: colW * 2, y: rowH, width: colWR, height: halfH },
          action: { type: 'uri' as const, label: 'SNS', uri: 'https://www.instagram.com/naturism_supplement/' },
        },
        // 下段右下: Q&A お問い合わせ
        {
          bounds: { x: colW * 2, y: rowH + halfH, width: colWR, height: halfH2 },
          action: { type: 'message' as const, label: 'Q&A お問い合わせ', text: 'お問い合わせ' },
        },
      ],
    };

    // Step 1: リッチメニュー作成
    const createResult = await lineClient.createRichMenu(richMenuBody);
    const richMenuId = createResult.richMenuId;

    // Step 2: 画像アップロード（事前生成済み 2500×1686 PNG）
    const pngData = base64ToArrayBuffer(NATURISM_MENU_PNG_B64);
    await lineClient.uploadRichMenuImage(richMenuId, pngData, 'image/png');

    // Step 3: デフォルトに設定
    await lineClient.setDefaultRichMenu(richMenuId);

    return c.json({
      success: true,
      data: {
        richMenuId,
        areas: richMenuBody.areas.map((a) => ({ label: a.action.label, type: a.action.type })),
        message: 'リッチメニュー v3（8ボタン）を作成・画像アップロード・デフォルト設定まで完了。',
      },
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/setup-naturism error:', message);
    return c.json({ success: false, error: `Failed to setup naturism rich menu: ${message}` }, 500);
  }
});

/**
 * naturism リッチメニュー用PNG（2500x1686 ソリッド #06C755）
 * Node.jsで事前生成済み（zlib level-9 圧縮）— 14,923バイト
 * Worker内でのリアルタイム生成はCPU制限超過のため使用しない
 */
const NATURISM_MENU_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAACcQAAAaWCAIAAAAWH7t/AAA6EklEQVR42uzZMQ0AAAzDsF5jOMyltX8YLBlB3mS6AAAAAAAAADyRAAAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwExVAQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwExVAQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADNVAgAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADNVBQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADNVBQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUCQAAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFADj27JgEAAAAYFD/1hYRTLB3VVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmbpCVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmbpCVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ+oEVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ+oKVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ+oKVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnakTVFVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVVdaZWVVVVVVVVdaZWVVVVVVVVnalVVVVVVVVVZ2pVVVVVVVXVmVpVVVVVVVV1plZVVVVVVVWdqVVVVVVVVVVnalVVVVVVVdWZWlVVVVVVVXWmVlVVVVVVVZ2pVVVVVVVVVWdqVVVVVVVV1ZlaVVVVVVVpz45pAAAAAAT1b20BI7CRwFcAzFQAAAAAAAAAM1UFAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAM1UFAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQJAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQVAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQVAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMlAAAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFNVAAAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAgBdhzNnC4l8DggAAAABJRU5ErkJggg==';

/** base64文字列をArrayBufferに変換 */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// GET /api/rich-menus/image-guide — リッチメニュー画像テンプレートHTML v3
// 8ボタン・シルバーアクセント付き豪華デザイン
// ブラウザで開いてスクリーンショット（2500x1686）を撮って画像として使用
richMenus.get('/api/rich-menus/image-guide', async (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700;900&display=swap');
* { margin: 0; padding: 0; box-sizing: border-box; }
html { background: #222; }
body {
  font-family: 'Noto Sans JP', 'Hiragino Sans', sans-serif;
  display: flex; justify-content: center; align-items: center;
  min-height: 100vh; padding: 20px;
}
.wrapper {
  width: 100%; max-width: 1000px;
  aspect-ratio: 2500 / 1686;
}
.container {
  width: 100%; height: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  background: linear-gradient(160deg, #f8f9fa 0%, #e8eaed 50%, #d4d7dc 100%);
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
}
.cell-large {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; position: relative; overflow: hidden;
  border: 1px solid rgba(192,192,192,0.3);
}
.cell-large .icon { font-size: 4vw; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.15)); }
.cell-large .label {
  font-size: 1.6vw; font-weight: 900; letter-spacing: 2px;
  background: linear-gradient(135deg, #2a2a2a, #666, #2a2a2a);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
}
.cell-large .sub { font-size: 0.9vw; color: #888; font-weight: 400; }
.cell-large::after {
  content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
  background: linear-gradient(45deg, transparent 40%, rgba(255,255,255,0.06) 50%, transparent 60%);
  pointer-events: none;
}
.right-col {
  display: grid; grid-template-rows: 1fr 1fr;
  border: 1px solid rgba(192,192,192,0.3);
}
.cell-small {
  display: flex; flex-direction: row; align-items: center; justify-content: center;
  gap: 10px; position: relative; overflow: hidden;
  border-bottom: 1px solid rgba(192,192,192,0.2);
}
.cell-small .icon { font-size: 2.8vw; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); }
.cell-small .label {
  font-size: 1.3vw; font-weight: 700;
  background: linear-gradient(135deg, #2a2a2a, #555);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
}
.bg-home     { background: linear-gradient(135deg, #f0f4f8, #e2e8f0); border-left: 3px solid rgba(180,180,200,0.4); }
.bg-category { background: linear-gradient(135deg, #f0f4f8, #e2e8f0); }
.bg-referral { background: linear-gradient(135deg, #eef6f0, #d4edda); }
.bg-rank     { background: linear-gradient(135deg, #fff9e6, #ffeeba); }
.bg-delivery { background: linear-gradient(135deg, #e8f4fd, #cce5ff); border-left: 3px solid rgba(180,180,200,0.4); }
.bg-reorder  { background: linear-gradient(135deg, #e8f4fd, #cce5ff); }
.bg-sns      { background: linear-gradient(135deg, #f3eefb, #e2d5f1); }
.bg-qa       { background: linear-gradient(135deg, #f0f0f0, #ddd); }
.cell-large::before, .cell-small::before {
  content: ''; position: absolute; top: 4px; left: 4px; right: 4px; bottom: 4px;
  border: 1px solid rgba(200,200,210,0.2); border-radius: 8px; pointer-events: none;
}
.note { color: #aaa; font-size: 14px; text-align: center; margin-top: 16px; }
</style></head>
<body>
<div>
<div class="wrapper">
<div class="container">
  <div class="cell-large bg-home"><span class="icon">🖥️</span><span class="label">ホームページ</span><span class="sub">naturism公式サイト</span></div>
  <div class="cell-large bg-category"><span class="icon">🔍</span><span class="label">カテゴリー</span><span class="sub">商品を探す</span></div>
  <div class="right-col">
    <div class="cell-small bg-referral"><span class="icon">👥</span><span class="label">友達紹介</span></div>
    <div class="cell-small bg-rank"><span class="icon">🏅</span><span class="label">マイランク</span></div>
  </div>
  <div class="cell-large bg-delivery"><span class="icon">🚚</span><span class="label">配送状況をみる</span><span class="sub">お届け状況を確認</span></div>
  <div class="cell-large bg-reorder"><span class="icon">🛒</span><span class="label">購入履歴・再購入</span><span class="sub">ワンタップで再注文</span></div>
  <div class="right-col">
    <div class="cell-small bg-sns"><span class="icon">💬</span><span class="label">SNS</span></div>
    <div class="cell-small bg-qa"><span class="icon">✉️</span><span class="label">Q&A お問い合わせ</span></div>
  </div>
</div>
</div>
<p class="note">📐 リッチメニュー画像テンプレート (2500×1686) — このプレビューはブラウザに合わせて縮小表示されています</p>
</div>
</body></html>`);
});

export { richMenus };

// POST /api/rich-menus/:id/image — upload rich menu image (accepts base64 body or binary)
richMenus.post('/api/rich-menus/:id/image', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const contentType = c.req.header('content-type') ?? '';

    let imageData: ArrayBuffer;
    let imageContentType: 'image/png' | 'image/jpeg' = 'image/png';

    if (contentType.includes('application/json')) {
      // Accept base64 encoded image in JSON body
      const body = await c.req.json<{ image: string; contentType?: string }>();
      if (!body.image) {
        return c.json({ success: false, error: 'image (base64) is required' }, 400);
      }
      // Strip data URI prefix if present
      const base64 = body.image.replace(/^data:image\/\w+;base64,/, '');
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      imageData = bytes.buffer;
      if (body.contentType === 'image/jpeg') imageContentType = 'image/jpeg';
    } else if (contentType.includes('multipart/form-data')) {
      // Defensive: legacy clients (or older cached UI) may send multipart with field name "image"
      const form = await c.req.formData();
      const file = form.get('image') as unknown as { arrayBuffer?: () => Promise<ArrayBuffer>; type?: string } | null;
      if (!file || typeof file.arrayBuffer !== 'function') {
        return c.json({ success: false, error: 'multipart field "image" must be a file' }, 400);
      }
      imageData = await file.arrayBuffer();
      const blobType = file.type ?? '';
      imageContentType = blobType.includes('jpeg') || blobType.includes('jpg') ? 'image/jpeg' : 'image/png';
    } else if (contentType.includes('image/')) {
      // Accept raw binary upload (preferred path)
      imageData = await c.req.arrayBuffer();
      imageContentType = contentType.includes('jpeg') || contentType.includes('jpg') ? 'image/jpeg' : 'image/png';
    } else {
      return c.json({
        success: false,
        error: `Unsupported Content-Type "${contentType}". Send raw binary with image/png or image/jpeg, JSON with {image: base64}, or multipart/form-data with field "image".`,
      }, 400);
    }

    // Pre-flight size check (LINE limit: 1MB)
    if (imageData.byteLength > 1024 * 1024) {
      return c.json({
        success: false,
        error: `Image too large: ${(imageData.byteLength / 1024 / 1024).toFixed(2)}MB exceeds LINE's 1MB limit.`,
      }, 413);
    }
    if (imageData.byteLength === 0) {
      return c.json({ success: false, error: 'Empty image body' }, 400);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    // Step trace for diagnostics — returned in both success and error responses
    // so we can see exactly which path the request took.
    const steps: string[] = [`build=v6-recreate, contentType=${imageContentType}, bytes=${imageData.byteLength}`];

    // ── Try direct upload first ──
    // LINE allows uploading to a richmenu only ONCE. If the menu already has an
    // image, a subsequent POST returns 400 "An image has already been uploaded".
    // To support "画像変更" UX, we transparently clone the menu, upload to the
    // clone, swap default if applicable, and delete the original.
    let directUploadError: string | null = null;
    try {
      await lineClient.uploadRichMenuImage(richMenuId, imageData, imageContentType);
      steps.push('direct_upload_ok');
      return c.json({ success: true, data: { richMenuId, replaced: false, steps } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      directUploadError = msg;
      // Match LINE's "An image has already been uploaded" message variations
      const alreadyUploaded = /already.*upload/i.test(msg);
      steps.push(`direct_upload_failed: ${msg.slice(0, 200)} (alreadyUploaded=${alreadyUploaded})`);
      if (!alreadyUploaded) {
        return c.json({ success: false, error: msg, steps }, 500);
      }
      // Fall through to recreate flow
    }

    // ── Recreate flow ──
    // 1. Fetch original menu structure
    type MenuShape = { size: { width: number; height: number }; selected: boolean; name: string; chatBarText: string; areas: unknown[] };
    let original: MenuShape;
    try {
      const list = await lineClient.getRichMenuList();
      const found = (list.richmenus ?? []).find((m) => m.richMenuId === richMenuId);
      if (!found) {
        steps.push(`get_list_ok but original ${richMenuId} not found in ${list.richmenus?.length ?? 0} menus`);
        return c.json({ success: false, error: '元のリッチメニューが LINE 上で見つかりません。一覧を更新してください。', steps }, 404);
      }
      original = found as unknown as MenuShape;
      steps.push(`get_list_ok found_size=${original.size.width}x${original.size.height} areas=${original.areas.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push(`get_list_failed: ${msg.slice(0, 200)}`);
      return c.json({ success: false, error: `getRichMenuList failed: ${msg}`, steps }, 500);
    }

    // 2. Detect if original is the default — we'll need to swap
    let wasDefault = false;
    try {
      const r = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        headers: { Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      });
      if (r.ok) {
        const d = await r.json<{ richMenuId?: string }>();
        wasDefault = d.richMenuId === richMenuId;
      }
      steps.push(`default_check_ok wasDefault=${wasDefault}`);
    } catch (e) {
      steps.push(`default_check_failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3. Create new menu with same structure (strip richMenuId, force selected:false to avoid conflict)
    let newRichMenuId: string;
    try {
      const newMenu = await lineClient.createRichMenu({
        size: original.size,
        selected: false,
        name: original.name,
        chatBarText: original.chatBarText,
        areas: original.areas as never,
      });
      newRichMenuId = newMenu.richMenuId;
      steps.push(`create_new_ok newId=${newRichMenuId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push(`create_new_failed: ${msg.slice(0, 200)}`);
      return c.json({ success: false, error: `createRichMenu failed: ${msg}`, steps }, 500);
    }

    // 4. Upload image to new menu — with retry (race condition: brand new menu may
    //    take a moment before LINE accepts content uploads)
    let uploadOk = false;
    let lastUploadErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await lineClient.uploadRichMenuImage(newRichMenuId, imageData, imageContentType);
        uploadOk = true;
        steps.push(`upload_to_new_ok attempt=${attempt}`);
        break;
      } catch (err) {
        lastUploadErr = err instanceof Error ? err.message : String(err);
        steps.push(`upload_to_new_attempt_${attempt}_failed: ${lastUploadErr.slice(0, 150)}`);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
    }
    if (!uploadOk) {
      try { await lineClient.deleteRichMenu(newRichMenuId); steps.push('cleanup_delete_new_ok'); }
      catch (e) { steps.push(`cleanup_delete_new_failed: ${e instanceof Error ? e.message : String(e)}`); }
      return c.json({ success: false, error: `LINE への画像アップロードに失敗しました (${lastUploadErr})`, steps }, 500);
    }

    // 5. Set default if needed (best-effort)
    if (wasDefault) {
      try {
        await lineClient.setDefaultRichMenu(newRichMenuId);
        steps.push('set_default_ok');
      } catch (e) {
        steps.push(`set_default_failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 5.5 Re-point any alias that targeted the old richMenuId → new richMenuId.
    //     LINE アプリ側は alias 経由で参照している場合、ここで updateAlias することで
    //     richmenuswitch action の参照先が即反映される。
    //     UI 上は alias が「固定ID」として振る舞うので、Katsu の運用感として
    //     「同じメニューの画像だけ差し替わった」ように見える。
    const rebindAliases: string[] = [];
    try {
      const aliasRes = await lineClient.getRichMenuAliasList();
      for (const alias of aliasRes.aliases ?? []) {
        if (alias.richMenuId === richMenuId) {
          try {
            await lineClient.updateRichMenuAlias(alias.richMenuAliasId, newRichMenuId);
            rebindAliases.push(alias.richMenuAliasId);
            steps.push(`alias_rebind_ok id=${alias.richMenuAliasId}`);
          } catch (e) {
            steps.push(`alias_rebind_failed id=${alias.richMenuAliasId}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } catch (e) {
      steps.push(`alias_list_failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 6. Delete the old menu (best-effort — new one is already up)
    try {
      await lineClient.deleteRichMenu(richMenuId);
      steps.push('delete_old_ok');
    } catch (e) {
      steps.push(`delete_old_failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    return c.json({
      success: true,
      data: {
        richMenuId: newRichMenuId,
        replaced: true,
        oldRichMenuId: richMenuId,
        wasDefault,
        rebindAliases,
        steps,
        directUploadError,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/:id/image outer error:', message);
    return c.json({ success: false, error: `Outer handler error: ${message}` }, 500);
  }
});

// GET /api/rich-menus/:id/image — fetch rich menu image binary (proxy from api-data.line.me)
// Admin UI の一覧プレビューで背景画像として表示するために使用。
// LINE の image content は api-data.line.me からのみ取得可能で、要 Channel Access Token。
richMenus.get('/api/rich-menus/:id/image', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const resp = await fetch(
      `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`,
      { headers: { Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}` } },
    );
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return c.json(
        { success: false, error: `LINE content API ${resp.status}: ${detail}` },
        resp.status === 404 ? 404 : 502,
      );
    }
    const contentType = resp.headers.get('Content-Type') ?? 'image/png';
    const buf = await resp.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // 30秒キャッシュ: 画像変更後もすぐ反映させたい、かつ連続表示で過度なLINE API呼び出しを抑える
        'Cache-Control': 'private, max-age=30',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/rich-menus/:id/image error:', message);
    return c.json({ success: false, error: `Failed to fetch rich menu image: ${message}` }, 500);
  }
});
