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

// POST /api/rich-menus/setup-naturism — naturism用リッチメニュー一括セットアップ
// 1. リッチメニュー構造を作成 2. デフォルトに設定
// ※画像は別途 POST /api/rich-menus/:id/image でアップロード
richMenus.post('/api/rich-menus/setup-naturism', async (c) => {
  try {
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);

    // naturism リッチメニュー定義（2500x1686 フルサイズ、2行3列）
    const richMenuBody = {
      size: { width: 2500, height: 1686 },
      selected: true, // デフォルトでメニュー表示
      name: 'naturism メインメニュー v1',
      chatBarText: 'メニュー',
      areas: [
        // ===== 上段（y: 0〜843） =====
        // 左上: 3種類の違い
        {
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: { type: 'message' as const, label: '3種類の違い', text: '3種類の違いを教えて' },
        },
        // 中上: おすすめ診断
        {
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: { type: 'message' as const, label: 'おすすめ診断', text: '自分に合うのはどれ？' },
        },
        // 右上: 購入する
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: { type: 'uri' as const, label: '購入する', uri: 'https://naturism-diet.com' },
        },
        // ===== 下段（y: 843〜1686） =====
        // 左下: よくある質問
        {
          bounds: { x: 0, y: 843, width: 833, height: 843 },
          action: { type: 'message' as const, label: 'よくある質問', text: 'よくある質問' },
        },
        // 中下: AI相談
        {
          bounds: { x: 833, y: 843, width: 834, height: 843 },
          action: { type: 'message' as const, label: 'AI相談', text: '相談したいことがあります' },
        },
        // 右下: お問い合わせ
        {
          bounds: { x: 1667, y: 843, width: 833, height: 843 },
          action: { type: 'uri' as const, label: 'お問い合わせ', uri: 'mailto:info@kenkoex.com' },
        },
      ],
    };

    // 1. リッチメニュー作成
    const createResult = await lineClient.createRichMenu(richMenuBody);
    const richMenuId = createResult.richMenuId;

    // 2. デフォルトに設定
    await lineClient.setDefaultRichMenu(richMenuId);

    return c.json({
      success: true,
      data: {
        richMenuId,
        message: 'リッチメニューを作成しデフォルトに設定しました。次に画像をアップロードしてください。',
        nextStep: `POST /api/rich-menus/${richMenuId}/image に 2500x1686 の PNG/JPEG 画像をアップロード`,
        imageGuide: '/api/rich-menus/image-guide で画像テンプレートHTMLを取得できます',
      },
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/setup-naturism error:', message);
    return c.json({ success: false, error: `Failed to setup naturism rich menu: ${message}` }, 500);
  }
});

// GET /api/rich-menus/image-guide — リッチメニュー画像テンプレートHTML
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
  color: #fff; text-align: center; gap: 20px; border: 1px solid rgba(255,255,255,0.15);
}
.cell .icon { font-size: 80px; }
.cell .label { font-size: 48px; font-weight: 700; letter-spacing: 2px; }
.cell .sub { font-size: 28px; opacity: 0.7; }
.c1 { background: linear-gradient(135deg, #06C755, #05a847); }
.c2 { background: linear-gradient(135deg, #05a847, #049a3f); }
.c3 { background: linear-gradient(135deg, #049a3f, #038c37); }
.c4 { background: linear-gradient(135deg, #15803d, #166534); }
.c5 { background: linear-gradient(135deg, #166534, #14532d); }
.c6 { background: linear-gradient(135deg, #14532d, #052e16); }
</style></head>
<body>
<div class="grid">
  <div class="cell c1"><span class="icon">💊</span><span class="label">3種類の違い</span><span class="sub">Blue・Pink・Premium</span></div>
  <div class="cell c2"><span class="icon">🔍</span><span class="label">おすすめ診断</span><span class="sub">あなたに合うのは？</span></div>
  <div class="cell c3"><span class="icon">🛒</span><span class="label">購入する</span><span class="sub">公式ストアへ</span></div>
  <div class="cell c4"><span class="icon">❓</span><span class="label">よくある質問</span><span class="sub">FAQ</span></div>
  <div class="cell c5"><span class="icon">🤖</span><span class="label">AI相談</span><span class="sub">何でも聞いてね</span></div>
  <div class="cell c6"><span class="icon">📧</span><span class="label">お問い合わせ</span><span class="sub">info@kenkoex.com</span></div>
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
