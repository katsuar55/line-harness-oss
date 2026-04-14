import type {
  BroadcastRequest,
  FlexContainer,
  InsightMessageEventResponse,
  Message,
  MulticastRequest,
  PushMessageRequest,
  ReplyMessageRequest,
  RichMenuObject,
  UserProfile,
} from './types.js';

const LINE_API_BASE = 'https://api.line.me/v2/bot';

export class LineClient {
  constructor(private readonly channelAccessToken: string) {}

  // ─── Core request helper ──────────────────────────────────────────────────

  private async request<T = unknown>(
    path: string,
    body: object,
    method: 'GET' | 'POST' | 'DELETE' = 'POST',
  ): Promise<T> {
    const result = await this.requestWithHeaders<T>(path, body, method);
    return result.data;
  }

  /**
   * Same as request() but also returns response headers (for X-Line-Request-Id etc).
   */
  private async requestWithHeaders<T = unknown>(
    path: string,
    body: object,
    method: 'GET' | 'POST' | 'DELETE' = 'POST',
  ): Promise<{ data: T; headers: Headers }> {
    const url = `${LINE_API_BASE}${path}`;

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
    };

    if (method !== 'GET' && method !== 'DELETE') {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `LINE API error: ${res.status} ${res.statusText} — ${text}`,
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? ((await res.json()) as T)
      : (undefined as unknown as T);

    return { data, headers: res.headers };
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<UserProfile> {
    return this.request<UserProfile>(
      `/profile/${encodeURIComponent(userId)}`,
      {},
      'GET',
    );
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  async pushMessage(to: string, messages: Message[]): Promise<void> {
    const body: PushMessageRequest = { to, messages };
    await this.request('/message/push', body);
  }

  async multicast(to: string[], messages: Message[]): Promise<void> {
    const body: MulticastRequest = { to, messages };
    await this.request('/message/multicast', body);
  }

  async broadcast(messages: Message[]): Promise<void> {
    const body: BroadcastRequest = { messages };
    await this.request('/message/broadcast', body);
  }

  /**
   * Broadcast a message and return the X-Line-Request-Id header.
   * Used for tracking message insights (impression/click) via LINE Insight API.
   */
  async broadcastWithRequestId(messages: Message[]): Promise<{ requestId: string | null }> {
    const body: BroadcastRequest = { messages };
    const result = await this.requestWithHeaders('/message/broadcast', body);
    return { requestId: result.headers.get('x-line-request-id') };
  }

  /**
   * Get message event statistics (impressions, unique clicks) for a broadcast.
   * Requires the X-Line-Request-Id returned by broadcastWithRequestId().
   * Stats are available for 14 days and only when 20+ users have seen the message.
   * See: https://developers.line.biz/en/reference/messaging-api/#get-message-event
   */
  async getInsightMessageEvent(requestId: string): Promise<InsightMessageEventResponse> {
    return this.request<InsightMessageEventResponse>(
      `/insight/message/event?requestId=${encodeURIComponent(requestId)}`,
      {},
      'GET',
    );
  }

  /**
   * Get the aggregated number of sent messages (delivered counts).
   * date must be in YYYYMMDD format (JST).
   */
  async getNumberOfSentMessages(
    type: 'reply' | 'push' | 'multicast' | 'broadcast',
    date: string,
  ): Promise<{ status: string; success?: number }> {
    return this.request<{ status: string; success?: number }>(
      `/message/delivery/${type}?date=${date}`,
      {},
      'GET',
    );
  }

  async replyMessage(
    replyToken: string,
    messages: Message[],
  ): Promise<void> {
    const body: ReplyMessageRequest = { replyToken, messages };
    await this.request('/message/reply', body);
  }

  // ─── Loading Animation ────────────────────────────────────────────────────

  /** Show "..." typing indicator to user (5-60 seconds) */
  async showLoadingAnimation(chatId: string, loadingSeconds = 20): Promise<void> {
    await this.request('/chat/loading/start', { chatId, loadingSeconds });
  }

  // ─── Rich Menu ────────────────────────────────────────────────────────────

  async getRichMenuList(): Promise<{ richmenus: RichMenuObject[] }> {
    return this.request<{ richmenus: RichMenuObject[] }>(
      '/richmenu/list',
      {},
      'GET',
    );
  }

  async createRichMenu(menu: RichMenuObject): Promise<{ richMenuId: string }> {
    return this.request<{ richMenuId: string }>('/richmenu', menu);
  }

  async deleteRichMenu(richMenuId: string): Promise<void> {
    await this.request(
      `/richmenu/${encodeURIComponent(richMenuId)}`,
      {},
      'DELETE',
    );
  }

  async setDefaultRichMenu(richMenuId: string): Promise<void> {
    await this.request(
      `/user/all/richmenu/${encodeURIComponent(richMenuId)}`,
      {},
    );
  }

  async deleteDefaultRichMenu(): Promise<void> {
    await this.request('/user/all/richmenu', {}, 'DELETE');
  }

  async linkRichMenuToUser(userId: string, richMenuId: string): Promise<void> {
    await this.request(
      `/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`,
      {},
    );
  }

  async unlinkRichMenuFromUser(userId: string): Promise<void> {
    await this.request(
      `/user/${encodeURIComponent(userId)}/richmenu`,
      {},
      'DELETE',
    );
  }

  async getRichMenuIdOfUser(userId: string): Promise<{ richMenuId: string }> {
    return this.request<{ richMenuId: string }>(
      `/user/${encodeURIComponent(userId)}/richmenu`,
      {},
      'GET',
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async pushTextMessage(to: string, text: string): Promise<void> {
    await this.pushMessage(to, [{ type: 'text', text }]);
  }

  async pushFlexMessage(
    to: string,
    altText: string,
    contents: FlexContainer,
  ): Promise<void> {
    await this.pushMessage(to, [{ type: 'flex', altText, contents }]);
  }

  // ─── Rich Menu Image Upload ─────────────────────────────────────────────

  /** Upload image to a rich menu. Accepts PNG/JPEG binary (ArrayBuffer or Uint8Array). */
  async uploadRichMenuImage(
    richMenuId: string,
    imageData: ArrayBuffer,
    contentType: 'image/png' | 'image/jpeg' = 'image/png',
  ): Promise<void> {
    const url = `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
      body: imageData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LINE API error: ${res.status} ${res.statusText} — ${text}`);
    }
  }
}
