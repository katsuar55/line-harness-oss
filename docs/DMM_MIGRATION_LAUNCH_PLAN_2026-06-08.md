# DMM チャットブースト → LINE Harness 完全移行 ローンチ計画 (2026-06-08)

**本線**: 現行の **DMM チャットブースト for EC** を解約し、自前 OSS の LINE Harness に完全移行する。
① 現行ユーザーが使う全機能をエラーなしの**ローンチレベル**に仕上げる → ② 現ユーザーがそのまま移行できる → ③ テスト LINE アカウント → **本番 OA** へ組込 → ④ 完全移行して DMM 解約。
細かいブラッシュアップはローンチ後。ダイナミックワークフロー + PDCA で自律実行。

> single source of truth はこの doc。進捗は TaskCreate/TaskUpdate と本 doc の更新で追跡。

---

## 0. 移行メカニズム (LINE Developers 公式裏取り済 — これが計画の土台)

| 事実 | 含意 |
|---|---|
| 友だち(フォロワー)は **OA に紐づく**。ツールには紐づかない | webhook URL を付け替えても友だちは失われない。DMM 解約後も残る |
| 1 チャネル = webhook URL **1個だけ** (module channel は LINE 認定パートナー限定) | DMM と harness の同時稼働は不可 → **ハードカットオーバー** |
| ツール内部データ(タグ/シナリオ進行/リッチメニュー/フォーム/カルテ)は移行されない | harness で**作り直し or 再導出**が必要 |
| naturism は Shopify が source of truth | ランク/購入履歴/一部タグは Shopify から**再導出可能** = 移行リスク低 |
| Messaging API ch と LINE Login ch が**同一 provider** なら userId 同一 | 本番 OA の両チャネルを同一 provider に置くこと(LIFF↔friend 紐付けの必須要件) |
| webhook は **2秒以内に 2xx** 必須 | harness は `waitUntil()` 非同期で既に対応済 ✓ |
| `getFollowerIds` で全 userId 一括取得可 — ただし**認証済/プレミアム OA 限定** | 認証済なら友だちを一括 import 可。未認証なら自然蓄積 or DMM CSV |
| userId は **provider 単位**。テスト OA と本番 OA が別 provider なら userId 体系が変わる | テスト OA の既存 friend(Katsu 1件)は本番では stale。本番は実質まっさら start |

**最小リスク切替経路**: 同じ Worker(`naturism-line-crm`)・D1・R2 を維持し、LINE secret 5本 + `VITE_LIFF_ID`/`LIFF_URL` を本番 OA 用に差し替えて rebuild+redeploy、LINE コンソール3 URL(webhook / LIFF endpoint / login callback)を変更。URL/CORS/script のハードコード編集は不要。

---

## 1. DMM for EC 機能 → Harness カバレッジ パリティ表

✓=PROD-READY / ▲=backend有・UI/有効化が不足 / ?=要確認

| DMM for EC 機能 | Harness 実装 | 状態 |
|---|---|---|
| 自動応答(キーワード) | `auto_replies` + intent-router + AI 3層 | ▲ **UIなし(DB直編集)** ← 最優先 |
| 定型文 | templates | ✓ |
| シナリオ設定 | scenarios / step-delivery | ✓ |
| 1対1トーク | chats | ✓ |
| 予約配信 | scheduled broadcast | ✓ |
| タグ・グループ セグメント配信 | broadcasts + segment-query + tags | ▲ **タグ/セグメントUI不足** |
| 回答フォーム / 回答選択 | forms | ▲ **builder UIなし**(read-onlyのみ) |
| カードメッセージ / リッチメッセージ | flex/template/imagemap (SDK) | ▲ JSON composing(UI弱) |
| リッチメニュー切替 / 作成 | rich-menus + conductor | ✓ |
| 販促配信(タグ付与N日後) | tag-elapsed-delivery | ▲ **UIなし**(cron稼働) |
| メンバー管理(権限) | staff (owner/admin/staff) | ✓ |
| ステータス管理 / 対応マーク | friend status | ▲ partial |
| タグ管理(自動付与) | automations + tags | ✓ (自動) / ▲ タグCRUD UI弱 |
| グループ管理 | groups | ▲ **UIなし** |
| ユーザーメモ / 情報編集 / 担当者 | friends.memo / detail / assigned_staff | ✓ |
| URLクリック測定 | tracked-links | ✓ |
| コンバージョン計測 | conversions | ✓ |
| ユーザー分析 | dashboard / line-insights | ✓ |
| 流入経路分析URL + 自動タグ | affiliates / tracked-links | ✓ |
| CSV出力 | csv-export (7種) | ✓ |
| ブラックリスト | is_blacklisted (全配信経路適用済) | ✓ |
| Shopify商品自動表示 | product-display | ✓ |
| 商品購入(LINE内) | cart-permalink (3タップ) | ✓ |
| 購入履歴・配送状況確認 | ? | ? 要確認 |
| 決済・発送通知 | shopify webhooks | ▲ **`SHOPIFY_LINE_NOTIFY_ENABLED` gated** |
| 会員ランク(購入額リワード) | loyalty rank engine | ✓ engine / ▲ monetization gated |
| Shopifyタグ配信 | segment `shopify_tag` | ✓ |
| 再入荷通知 | ? | ? 要確認/gap |
| かご落ちメッセージ | abandoned-cart | ✓ |
| Shopify Flow連携 / Slack連携 | notifications(Discord) | ? gap(使用なら要対応) |

**結論**: バックエンドは DMM for EC をほぼ網羅。ローンチ blocker は **(1) 一部機能の管理画面UI欠如**, **(2) EC通知系の gated 有効化**, **(3) 友だち/タグの移行データ投入** の3点に集中。

---

## 2. フェーズ別タスク (最短距離)

### Phase 0 — スコープ確定 (Katsu 確認待ち)
- [ ] DMM で**実際に使っている機能**を確定 → UI 構築の範囲を right-size (使わない機能の UI は作らない)
- [ ] 友だちデータ移行方針: DMM CSV(userID付き)書き出し可否 / 本番 OA が認証済(verified)か
- [ ] 本番 OA の Messaging API ch + LINE Login ch の準備状況・同一 provider か

### Phase 1 — オペレーター運用 UI ギャップ解消 (自律・コード)
DMM パリティで必要かつ UI 欠落のもの。Phase 0 の使用機能に応じて取捨選択。
- [ ] **P1: キーワード自動応答 管理 UI** (`auto_replies` CRUD) ← DMM 中核・最優先
- [ ] **P1: タグ管理 UI** (作成/改名/削除/色 + 友だち数表示)
- [ ] P2: セグメント絞り込み UI (ビジュアルルールビルダー or 実用フォーム)
- [ ] P2: 回答フォーム builder UI + 一覧
- [ ] P2: A/Bテスト 管理 UI
- [ ] P2: 販促配信(タグ時限) UI
- [ ] P3: グループ UI / アンケート UI / カード・リッチメッセージ composer

### Phase 2 — 移行データ投入経路 (自律・コード)
- [ ] 友だち投入: `getFollowerIds` importer(認証済OA時) + getProfile backfill
- [ ] タグ import: DMM CSV(userId+タグ)→ friends-import 拡張 or 新 tag-import
- [ ] Shopify 再導出: order-email-match(稼働中) + 必要なら friend-customer-link/backfill/rank を有効化

### Phase 3 — 「エラーなく」堅牢化 (自律)
- [ ] 全 worker test green + preflight green を維持
- [ ] 既知リスク対応: AI model silent fallback 監視(conversation_logs.ai_model), gated 有効化の検証
- [ ] launch 信頼性に効く hardening backlog の選別(N pagination / E2 broadcast sweep / O webhook分割 など)
- [ ] 未使用 placeholder(ad-conversion OAuth, shopify sync stub)は使用しないなら touch しない

### Phase 4 — 本番カットオーバー (Katsu ゲート・一部手動)
- [ ] 本番 OA の Messaging API ch + LINE Login ch を同一 provider に用意
- [ ] secret 差し替え: `wrangler secret bulk`(JSON, `\r` trap 回避) で LINE_CHANNEL_SECRET/ACCESS_TOKEN, LINE_LOGIN_CHANNEL_ID/SECRET, LIFF_URL
- [ ] `VITE_LIFF_ID` を local `.env` + GitHub repo vars 両方更新 → rebuild (preflight は missing は弾くが **stale-but-valid は弾かない**ので要注意)
- [ ] LINE コンソール: Webhook URL → `/webhook` + Use webhook ON / LIFF endpoint → worker URL / Login callback → `/auth/callback`
- [ ] OA Manager: 応答モード=Bot / Webhook ON / あいさつ・自動応答 OFF (二重返信防止)
- [ ] harness から `Set default rich menu` で旧 DMM メニュー上書き
- [ ] 本番ブランド用 seed: welcome scenario / tags / automations / templates / monthly broadcast

### Phase 5 — 検証 + 監視 + DMM 解約 (PDCA)
- [ ] テスト友だち(自分)で e2e: follow→welcome / キーワード返信 / AI返信 / リッチメニュータップ / LIFF会員証 / broadcast / scenario / form / CV計測
- [ ] webhook error統計 / 2秒制限 / 署名検証 / AI model を 24-48h 監視
- [ ] 安定確認 → **DMM 解約**

---

## 3. カットオーバー Runbook (最小ダウンタイム)
1. 事前: harness 本番 deploy + smoke 済 / 本番 Login ch を同一 provider に用意 / 本番ブランド seed 投入
2. 事前: DMM から CSV(タグ・ユーザー情報・userId)書き出し → harness に import。`getFollowerIds` でも友だち userId 補完(認証済時)
3. 事前: リッチメニューを Messaging API で**作成のみ**(まだ set default しない)
4. カットオーバー(深夜・低トラフィック):
   a. LINE Developers Console: Webhook URL を harness に変更 → 検証 → Use webhook ON
   b. OA Manager: 応答モード=Bot / Webhook ON / 自動応答・あいさつ OFF
   c. harness から `Set default rich menu` で上書き
   d. テスト友だちで follow/message/リッチメニュー/LIFF 会員証 を実機確認
5. 監視: webhook error・2秒制限・署名 OK を 24-48h
6. 安定後: **DMM 解約**(友だちは残る)

---

## 4. 要確認の不確実点 (フラグ)
1. DMM「CSV出力」に **userId カラム**が含まれるか(タグ移行の成否を左右)
2. 本番 OA が **verified/premium** か(`getFollowerIds` 可否)
3. 既存 LINE Login ch(LIFF/会員証)の provider が本番 Messaging API ch と同一にできるか
4. DMM に A/Bテストが実在し naturism が使っているか(harness は A-B backend 済)
5. DMM が module channel(partner)接続か primary webhook 接続か(Developers Console の Webhook URL 欄で判別)
6. naturism が使う EC 通知系(決済・発送・再入荷・Slack/Flow)の実使用範囲

---

## 5. 参考(ディスカバリ出典)
- DMM for EC 機能: https://chatboost-ec.dmm.com/pages/feature / 料金: https://chatboost-ec.dmm.com/pages/price
- Lステップ全機能(業界標準の物差し): https://linestep.jp/2025/11/21/lstep-all-function/
- LINE Developers: Build a bot / Rich menu overview / Get user IDs / Receive messages(webhook) / LIFF getting started
