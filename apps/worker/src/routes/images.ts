import { Hono } from 'hono';
import type { Env } from '../index.js';

const images = new Hono<Env>();

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
    await c.env.IMAGES.delete(key);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/images/:key error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { images };
