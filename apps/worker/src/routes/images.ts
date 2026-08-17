import { Hono } from 'hono';
import type { Env } from '../index.js';

const images = new Hono<Env>();

/**
 * 公開配信してよい R2 key の判定。
 *
 * 🚨 なぜ必要か (2026-08-16 本番実測で発覚した情報漏洩の根治):
 * `GET /images/:key` は認証不要 (middleware/auth.ts の skip-list に `/images/` がある)。
 * Hono は path 中の `%2F` をデコードして `:key` に渡すため、ガードが無いと
 * **IMAGES バケット内の任意オブジェクト**が無認証で読めた。
 * 実際に D1 日次バックアップ (`backups/<日付>/naturism-d1-backup-<日付>.sql`
 * = friends の line_user_id・氏名を含む DB 全体) が 206 で取得可能な状態だった。
 * キーは日付ベースで推測が容易 = 事実上の全公開。
 *
 * 方針は **allowlist 一択**。「backups/ を弾く」 deny-list にすると、
 * 将来この共用バケットに別の機微プレフィックスを足した人が無言で漏らす。
 * ここに書いていない名前空間は公開されない、が既定。
 *
 * 許可する形:
 *   - フラットキー (スラッシュ無し) — POST /api/images の `<uuid>.<ext>` と
 *     customKey、PUT /api/rich-menus/image-r2 の `richmenu-*.jpg|png`、
 *     手動配置の `quiz-hero-v1.mp4` / `rank-silver-v2.png` 等
 *   - `food/<id>.<ext>` — webhook の食事画像 (routes/webhook.ts が
 *     `/images/food/<uuid>.<ext>` として顧客に配信する唯一のスラッシュ名前空間)
 */
const PUBLIC_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** スラッシュを含むキーで公開配信を許す名前空間。追加は意図的な判断として行うこと。 */
const PUBLIC_KEY_PREFIXES = ['food/'] as const;

export function isPubliclyServableImageKey(key: string): boolean {
  // ⚠️ この行は冗長ではない。プレフィックス付きキーはセグメント正規表現が `/` を
  // 許さないので traversal できないが、**フラットキーでは `.` が許可文字**なので
  // `a..b.png` は正規表現を通過する (レビューで実測確認)。消さないこと。
  if (key.includes('..')) return false;
  const prefix = PUBLIC_KEY_PREFIXES.find((p) => key.startsWith(p));
  const segment = prefix === undefined ? key : key.slice(prefix.length);
  // セグメントは `/` を含めないので、許可プレフィックス配下から他所へは抜けられない。
  return PUBLIC_KEY_SEGMENT.test(segment);
}

// POST /api/images — upload image (base64 or binary)
images.post('/api/images', async (c) => {
  try {
    const contentType = c.req.header('Content-Type') || '';

    let data: ArrayBuffer;
    let mimeType: string;
    let filename: string | undefined;

    // 明示指定された決定的キー (例: quiz-hero-v1.mp4)。差し替え可能な固定 asset 用。
    let customKey: string | undefined;

    if (contentType.includes('application/json')) {
      const body = await c.req.json<{
        data: string;
        mimeType?: string;
        filename?: string;
        key?: string;
      }>();

      if (!body.data) {
        return c.json({ success: false, error: 'data (base64) is required' }, 400);
      }

      let base64 = body.data;
      if (base64.startsWith('data:')) {
        const match = base64.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          base64 = match[2];
        }
      }
      mimeType ??= body.mimeType ?? 'image/png';
      filename = body.filename;
      customKey = body.key;

      const binary = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      data = binary.buffer;
    } else {
      data = await c.req.arrayBuffer();
      mimeType = contentType.split(';')[0] || 'image/png';
    }

    // MIME ごとの拡張子 + サイズ上限 (画像 5MB / 動画 20MB)。
    const MIME_EXT: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
      'video/mp4': 'mp4', 'video/webm': 'webm',
    };
    const ext = MIME_EXT[mimeType];
    if (!ext) {
      return c.json({ success: false, error: `Unsupported type: ${mimeType}. Allowed: ${Object.keys(MIME_EXT).join(', ')}` }, 400);
    }

    const isVideo = mimeType.startsWith('video/');
    const maxBytes = isVideo ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
    if (data.byteLength > maxBytes) {
      return c.json({ success: false, error: `File too large (max ${maxBytes / (1024 * 1024)}MB)` }, 400);
    }

    if (!c.env.IMAGES) {
      return c.json({ success: false, error: 'Image storage is not configured' }, 503);
    }

    let key: string;
    if (customKey !== undefined) {
      // path traversal / 予約キー衝突を防ぐため厳格サニタイズ。拡張子は mimeType と一致必須。
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(customKey) || customKey.includes('..')) {
        return c.json({ success: false, error: 'Invalid key: use [a-z0-9._-], max 64 chars, no path separators' }, 400);
      }
      if (!customKey.endsWith(`.${ext}`)) {
        return c.json({ success: false, error: `Key extension must match mimeType (.${ext})` }, 400);
      }
      key = customKey;
    } else {
      key = `${crypto.randomUUID()}.${ext}`;
    }

    await c.env.IMAGES.put(key, data, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalFilename: filename ?? key },
    });

    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const url = `${workerUrl}/images/${key}`;

    return c.json({
      success: true,
      data: { id: key, key, url, mimeType, size: data.byteLength },
    }, 201);
  } catch (err) {
    console.error('POST /api/images error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /images/:key — serve image/video (public, no auth)
// Range (206) 対応: LINE 内 WebView (特に iOS) は <video> の再生/シーク/ループに
// HTTP Range を要求する。Accept-Ranges を返さないと動画が再生されないことがある。
images.get('/images/:key', async (c) => {
  if (!c.env.IMAGES) {
    return c.json({ success: false, error: 'Image storage is not configured' }, 503);
  }
  const key = c.req.param('key');
  const rangeHeader = c.req.header('Range');

  // 公開名前空間の外 (例: backups/) は R2 に触れる前に拒否する。
  // 応答は「存在しない」と完全に同一 — 403 で区別できると鍵の存在確認に使える。
  if (!isPubliclyServableImageKey(key)) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }

  // まず HEAD 相当でメタ+サイズを得る (Range パースに total size が要る)
  const head = await c.env.IMAGES.head(key);
  if (!head) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }
  const total = head.size;
  const contentType = head.httpMetadata?.contentType || 'image/png';
  const baseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': head.etag,
    'Accept-Ranges': 'bytes',
  };

  // `bytes=start-end` を解釈 (単一レンジのみ対応)。不正/複数レンジは全体返却にフォールバック。
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start: number;
    let end: number;
    if (m[1] === '') {
      // suffix: 末尾 N バイト
      const suffix = Math.min(parseInt(m[2], 10), total);
      start = total - suffix;
      end = total - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
    }
    if (Number.isNaN(start) || start > end || start >= total) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
      });
    }
    const length = end - start + 1;
    const partial = await c.env.IMAGES.get(key, { range: { offset: start, length } });
    if (!partial) {
      return c.json({ success: false, error: 'Image not found' }, 404);
    }
    return new Response(partial.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(length),
      },
    });
  }

  const object = await c.env.IMAGES.get(key);
  if (!object) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }
  return new Response(object.body, {
    headers: { ...baseHeaders, 'Content-Length': String(total) },
  });
});

// DELETE /api/images/:key — delete image
images.delete('/api/images/:key', async (c) => {
  try {
    if (!c.env.IMAGES) {
      return c.json({ success: false, error: 'Image storage is not configured' }, 503);
    }
    const key = c.req.param('key');
    // 認証済みルートだが、画像管理の権限で DR バックアップ (backups/) を消せてはいけない。
    // 削除できる範囲は配信できる範囲と一致させる。
    if (!isPubliclyServableImageKey(key)) {
      return c.json({ success: false, error: 'Image not found' }, 404);
    }
    await c.env.IMAGES.delete(key);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/images/:key error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { images };
