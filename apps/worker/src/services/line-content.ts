/**
 * LINE Content API ダウンローダ
 *
 * LINE プラットフォームから画像/動画/音声のバイナリを取得するヘルパー。
 * Phase 3 (AI 食事診断) の image message 処理で使う。
 *
 * 設計方針:
 * - **5MB ハードキャップ**: Workers の sub-request body 制限と Anthropic Vision の
 *   推奨サイズに合わせる。超過時は payload を読まずに即座にエラー。
 * - **タイムアウト**: AbortController で 10 秒。LINE 側遅延が webhook 1 秒応答を
 *   食い潰さないよう、呼び出し側は ctx.waitUntil() 内で使うこと。
 * - **token redaction**: 例外メッセージにアクセストークンが混ざらないようにする。
 *
 * 使い方:
 *   const blob = await downloadLineContent(messageId, env.LINE_CHANNEL_ACCESS_TOKEN);
 *   // blob.bytes / blob.contentType を Anthropic に渡す
 */

const LINE_CONTENT_ENDPOINT = 'https://api-data.line.me/v2/bot/message';
const DEFAULT_SIZE_LIMIT_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT_MS = 10_000;

export interface LineContentBlob {
  /** 生バイナリ。`Uint8Array` で Anthropic SDK にそのまま渡せる */
  bytes: Uint8Array;
  /** "image/jpeg" / "image/png" 等。LINE が返す Content-Type をそのまま */
  contentType: string;
  /** バイト数 (= bytes.byteLength) */
  size: number;
}

export class LineContentError extends Error {
  constructor(
    message: string,
    /** "size_exceeded" / "timeout" / "http_error" / "empty" */
    public readonly code: 'size_exceeded' | 'timeout' | 'http_error' | 'empty' | 'invalid_response',
    /** HTTP ステータス (該当する場合) */
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LineContentError';
  }
}

export interface DownloadLineContentOptions {
  /** バイト数上限。default 5MB */
  sizeLimitBytes?: number;
  /** タイムアウト ms。default 10000 */
  timeoutMs?: number;
  /** テスト用 fetch override */
  fetchImpl?: typeof fetch;
}

/**
 * LINE Content API から指定 messageId のバイナリを取得する。
 *
 * @throws {LineContentError} サイズ超過 / タイムアウト / HTTP エラー / 空レスポンス
 */
export async function downloadLineContent(
  messageId: string,
  channelAccessToken: string,
  options: DownloadLineContentOptions = {},
): Promise<LineContentBlob> {
  if (!messageId) {
    throw new LineContentError('messageId is required', 'invalid_response');
  }
  if (!channelAccessToken) {
    throw new LineContentError('channelAccessToken is required', 'http_error');
  }

  const sizeLimit = options.sizeLimitBytes ?? DEFAULT_SIZE_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      `${LINE_CONTENT_ENDPOINT}/${encodeURIComponent(messageId)}/content`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${channelAccessToken}` },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new LineContentError(
        `LINE Content API returned ${response.status}`,
        'http_error',
        response.status,
      );
    }

    // Content-Length が返るケースは先にチェックして早期リジェクト
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      const n = Number(declaredLength);
      if (Number.isFinite(n) && n > sizeLimit) {
        throw new LineContentError(
          `Content-Length ${n} exceeds size limit ${sizeLimit}`,
          'size_exceeded',
        );
      }
    }

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

    // ストリーム読み込み: 制限超過したら即 abort して body 全体をメモリに展開しない
    // (LINE が Content-Length を返さないケースでも OOM を防ぐため)
    if (!response.body) {
      throw new LineContentError('LINE Content API returned no body stream', 'empty');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        if (size > sizeLimit) {
          // body を読み切らずに中断 — 残りバイトは捨てる
          await reader.cancel();
          throw new LineContentError(
            `Body exceeds size limit ${sizeLimit}`,
            'size_exceeded',
          );
        }
        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }

    if (size === 0) {
      throw new LineContentError('LINE Content API returned empty body', 'empty');
    }

    // 結合
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { bytes, contentType, size };
  } catch (err: unknown) {
    if (err instanceof LineContentError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LineContentError(`LINE Content API timed out after ${timeoutMs}ms`, 'timeout');
    }
    // 予期せぬエラー: token を含み得る err.message をそのまま流さず汎用化
    throw new LineContentError(
      `LINE Content API fetch failed: ${err instanceof Error ? err.name : 'unknown'}`,
      'http_error',
    );
  } finally {
    clearTimeout(timer);
  }
}
