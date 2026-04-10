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

// POST /api/rich-menus/setup-naturism — naturism用リッチメニュー一括セットアップ v2
// 6ボタン（2×3）: ストア / マイページ / ランク / 友だち紹介 / 今日のヒント(postback) / お問い合わせ
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

    // naturism リッチメニュー定義（2500×1686 フルサイズ、2行3列）
    const cellW = 833;
    const cellWMid = 834; // 中央列は834（2500 = 833 + 834 + 833）
    const rowH = 843;

    const richMenuBody = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: 'naturism メインメニュー v2',
      chatBarText: 'メニュー',
      areas: [
        // 上段: ストア / マイページ / ランク
        {
          bounds: { x: 0, y: 0, width: cellW, height: rowH },
          action: { type: 'uri' as const, label: 'ストア', uri: `${liffUrl}#shop` },
        },
        {
          bounds: { x: cellW, y: 0, width: cellWMid, height: rowH },
          action: { type: 'uri' as const, label: 'マイページ', uri: `${liffUrl}#home` },
        },
        {
          bounds: { x: cellW + cellWMid, y: 0, width: cellW, height: rowH },
          action: { type: 'uri' as const, label: 'マイランク', uri: `${liffUrl}#rank` },
        },
        // 下段: 友だち紹介 / 今日のヒント(postback) / お問い合わせ
        {
          bounds: { x: 0, y: rowH, width: cellW, height: rowH },
          action: { type: 'uri' as const, label: '友だち紹介', uri: `${liffUrl}#referral` },
        },
        {
          bounds: { x: cellW, y: rowH, width: cellWMid, height: rowH },
          action: { type: 'postback' as const, label: '今日のヒント', data: 'action=daily_tip', displayText: '💡 今日のヒント' },
        },
        {
          bounds: { x: cellW + cellWMid, y: rowH, width: cellW, height: rowH },
          action: { type: 'message' as const, label: 'お問い合わせ', text: 'お問い合わせ' },
        },
      ],
    };

    // Step 1: リッチメニュー作成
    const createResult = await lineClient.createRichMenu(richMenuBody);
    const richMenuId = createResult.richMenuId;

    // Step 2: 画像アップロード（事前生成済み 2500×1686 緑PNG）
    const pngData = base64ToArrayBuffer(NATURISM_MENU_PNG_B64);
    await lineClient.uploadRichMenuImage(richMenuId, pngData, 'image/png');

    // Step 3: デフォルトに設定
    await lineClient.setDefaultRichMenu(richMenuId);

    return c.json({
      success: true,
      data: {
        richMenuId,
        areas: richMenuBody.areas.map((a) => ({ label: a.action.label, type: a.action.type })),
        message: 'リッチメニュー v2（6ボタン）を作成・画像アップロード・デフォルト設定まで完了。LINEトーク画面にメニューが表示されます。',
      },
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/setup-naturism error:', message);
    return c.json({ success: false, error: `Failed to setup naturism rich menu: ${message}` }, 500);
  }
});

/**
 * naturism リッチメニュー用PNG（2500x843 ソリッド #06C755）
 * Node.jsで事前生成済み（zlib level-9 圧縮）— 7,505バイト
 * Worker内でのリアルタイム生成はCPU制限超過のため使用しない
 */
const NATURISM_MENU_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAACcQAAANLCAIAAADqh5spAAAdGElEQVR42uzZMQ0AAAzDsF5jOMyltX8YLBlB3mS6AAAAAAAAADyRAAAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwExVAQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwExVAQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADNVAgAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADNVBQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADNVBQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUCQAAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUFQAAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTJQAAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAADMVAAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAAAzFQAAAAAAAMBMBQAAAAAAADBTAQAAAAAAAMxUAAAAAAAAADMVAAAAAAAAwEwFAAAAAAAAMFMBAAAAAAAAzFQAAAAAAAAAMxUAAAAAAADATAUAAAAAAAAwUwEAAAAAAADMVAAAAAAAAAAzFQAAAAAAAIAGUm/s2ogJBqAAAAAASUVORK5CYII=';

/** base64文字列をArrayBufferに変換 */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// GET /api/rich-menus/image-guide — リッチメニュー画像テンプレートHTML v2
// ブラウザで開いてスクリーンショット（2500x1686）を撮って画像として使用
richMenus.get('/api/rich-menus/image-guide', async (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 2500px; height: 1686px; font-family: 'Hiragino Sans', 'Noto Sans JP', sans-serif; }
.grid { display: grid; grid-template-columns: 833px 834px 833px; grid-template-rows: 843px 843px; width: 2500px; height: 1686px; }
.cell {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: #fff; text-align: center; gap: 20px; border: 1px solid rgba(255,255,255,0.12);
}
.cell .icon { font-size: 96px; }
.cell .label { font-size: 52px; font-weight: 700; letter-spacing: 2px; text-shadow: 0 2px 8px rgba(0,0,0,.15); }
.cell .sub { font-size: 28px; opacity: 0.8; }
.c1 { background: linear-gradient(135deg, #06C755, #059669); }
.c2 { background: linear-gradient(135deg, #059669, #047857); }
.c3 { background: linear-gradient(135deg, #f59e0b, #d97706); }
.c4 { background: linear-gradient(135deg, #3b82f6, #2563eb); }
.c5 { background: linear-gradient(135deg, #8b5cf6, #7c3aed); }
.c6 { background: linear-gradient(135deg, #64748b, #475569); }
</style></head>
<body>
<div class="grid">
  <div class="cell c1"><span class="icon">🛍️</span><span class="label">ストア</span><span class="sub">商品を見る</span></div>
  <div class="cell c2"><span class="icon">📋</span><span class="label">マイページ</span><span class="sub">記録・プロフィール</span></div>
  <div class="cell c3"><span class="icon">🏆</span><span class="label">マイランク</span><span class="sub">ランク・特典</span></div>
  <div class="cell c4"><span class="icon">👥</span><span class="label">友だち紹介</span><span class="sub">紹介してポイントGET</span></div>
  <div class="cell c5"><span class="icon">💡</span><span class="label">今日のヒント</span><span class="sub">美容・健康情報</span></div>
  <div class="cell c6"><span class="icon">💬</span><span class="label">お問い合わせ</span><span class="sub">ご質問はこちら</span></div>
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
    } else if (contentType.includes('image/')) {
      // Accept raw binary upload
      imageData = await c.req.arrayBuffer();
      imageContentType = contentType.includes('jpeg') || contentType.includes('jpg') ? 'image/jpeg' : 'image/png';
    } else {
      return c.json({ success: false, error: 'Content-Type must be application/json (with base64) or image/png or image/jpeg' }, 400);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.uploadRichMenuImage(richMenuId, imageData, imageContentType);

    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/:id/image error:', message);
    return c.json({ success: false, error: `Failed to upload rich menu image: ${message}` }, 500);
  }
});
