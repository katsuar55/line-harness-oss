# LP ローンチサポート資料 (naturism)

**作成**: 2026-05-22 (= LP ローンチ直前)
**対象ブランド**: naturism (= 株式会社ケンコーエクスプレス、 D2C インナーケアサプリ)
**製品**: Blue — 7日分（42粒）¥696 (= お試し価格)
**目的**: LP / SNS で自然流入を発生させ、 LINE 友だち追加 → クーポン自動発行 flow を実流入で初検証する

---

## ⚠️ 薬機法 注意事項 (必読)

サプリメント（= 健康食品）は医薬品ではないため、 以下の表現は薬機法 (旧薬事法) で禁止:

| カテゴリ | NG 例 | OK 代替 |
|---|---|---|
| 効能効果の断定 | 「痩せる」「治る」「予防する」 | 「整える」「考えた配合」「サポート」 |
| 病気の治療示唆 | 「便秘解消」「ダイエット効果」 | 「すっきり毎日」「美しさを考えて」 |
| 即効性の強調 | 「飲めばすぐ」「7日で-3kg」 | 「毎日続けることで」「7日間試せる」 |
| 部位特定の効果 | 「肌が白くなる」「お腹が凹む」 | 「内側からのケア」「コンディション」 |

**最終判断は brand 側の法務 / 薬機法専門家確認必須**。 本資料の文言案は **テンプレート (= 出発点)** であり、 製品分類 (= 一般食品 / 機能性表示食品 / トクホ) と届出範囲によって使える表現が変わる。

機能性表示食品なら届出表示範囲内の「○○の機能があると報告されている」 等の表現可。 トクホなら認可された保健効果の表現可。 naturism「Blue」 がどの分類かは brand 側で確認のこと。

---

## 1. LP 文言案 (= 薬機法 safe 寄せ)

### ヘッドライン候補 (3 案)

**案 A: 価格訴求型**
> 7日間 696円で試せる、 naturism のインナーケア
> — 毎日のリズムを内側から考えた、 D2C サプリメント。

**案 B: 体験訴求型**
> 1日6粒、 7日間続けたら何が変わる?
> naturism Blue が提案する、 内側からの新習慣。

**案 C: 共感訴求型**
> 「最近、 なんとなく整わない」 を感じている方に。
> naturism Blue は、 毎日のリズムを考えたサプリメントです。

### サブコピー (共通候補)

- 美しさと健康を考えた、 独自配合
- お試し価格 ¥696 (7日分・42粒) で気軽にスタート
- 毎日続けることで、 内側からのコンディションをサポート
- LINE 友だち追加で、 初回限定クーポン (= ¥500 OFF) プレゼント

### CTA (Call to Action) 文言

- **LP ボタン**: 「7日間お試しを ¥696 で始める」「公式 LINE で 500円クーポンを受け取る」
- **二段階 CTA**: ① LINE 友だち追加 → ② クーポン受領 → ③ 公式ストアで購入
- **緊急性 (= 過度な緊急性は薬機法 NG ではないが体験訴求として)**: 「今だけ 500円 OFF」「3日間限定クーポン」

---

## 2. SNS 投稿テンプレート

### X (旧 Twitter) — 文字数制約 140 字以内

**投稿 1 (= 製品紹介)**:
```
毎日のリズム、 整ってますか?

naturism Blue は、 美しさと健康を考えた D2C サプリ。
7日分 (42粒) ¥696 のお試し価格で気軽にスタートできます。

LINE 友だち追加で 500円 OFF クーポン
→ [tracked URL]

#naturism #インナーケア #毎日習慣
```

**投稿 2 (= LINE 友だち追加 訴求)**:
```
naturism 公式 LINE で 500円 OFF クーポンを配布中

✓ 7日分 ¥696 のお試しがさらにお得に
✓ 友だち追加だけで自動でクーポン到着
✓ 内側からのケアを始めるきっかけに

[tracked URL]
```

### Instagram — 視覚 + 長文 caption

**caption**:
```
✦ naturism Blue ✦
内側からのケアを、 毎日の習慣に。

「最近、 なんとなく整わない」
そんな日々のリズムを、
独自配合のサプリメントが考えてサポート。

🌿 7日分 42粒 ¥696
🌿 毎日6粒、 続けやすい設計
🌿 LINE 友だち追加で 500円 OFF クーポン

プロフィール URL から公式 LINE へ
→ [tracked URL]

#naturism #インナーケア #サプリメント #毎日習慣 #美と健康 #D2C #ケンコーエクスプレス
```

### LINE 公式アカウント — 既存友だちへの broadcast 文案

```
【naturism より お知らせ】

新規友だち向けに、 ¥500 OFF クーポンの配布を始めました
(= 既に友だちの皆さまには別途、 リピート割引のご用意も準備中)

引き続き、 naturism Blue が皆さまの毎日に寄り添えるよう
コンテンツを発信してまいります。

何かご質問があれば、 このトークルームから直接お送りください。
```

---

## 3. 流入計測 KPI plan (= UTM parameter 設計)

### 推奨 UTM 命名規則

`utm_source` / `utm_medium` / `utm_campaign` の 3 軸で集計可。 /traffic-sources page で UTM グループ別 breakdown が見える。

| パラメータ | 値の規則 | 例 |
|---|---|---|
| utm_source | 媒体名 (lowercase, snake_case) | `x` / `instagram` / `meta_ads` / `google_ads` / `lp_direct` / `email` |
| utm_medium | 媒体タイプ | `social` / `cpc` / `referral` / `email` / `direct` |
| utm_campaign | キャンペーン識別子 (snake_case + 日付) | `launch_2026_05` / `coupon_500yen` / `monthly_promo_06` |

### 推奨 tracked_links 一覧 (= LP ローンチ時に admin web で作成)

| name | originalUrl | tag | scenario | 目的 |
|---|---|---|---|---|
| lp-x-launch | `https://line.me/R/ti/p/@naturism?utm_source=x&utm_medium=social&utm_campaign=launch_2026_05` | `from-x` | `naturism-welcome-v1` | X 投稿からの流入計測 |
| lp-instagram-launch | `https://line.me/R/ti/p/@naturism?utm_source=instagram&utm_medium=social&utm_campaign=launch_2026_05` | `from-instagram` | `naturism-welcome-v1` | Instagram 投稿/プロフィール URL |
| lp-meta-ads-launch | `https://line.me/R/ti/p/@naturism?utm_source=meta&utm_medium=cpc&utm_campaign=launch_2026_05` | `from-meta-ads` | `naturism-welcome-v1` | Meta 広告 (= 有料運用時) |
| lp-google-ads-launch | `https://line.me/R/ti/p/@naturism?utm_source=google&utm_medium=cpc&utm_campaign=launch_2026_05` | `from-google-ads` | `naturism-welcome-v1` | Google 広告 (= 有料運用時) |
| lp-direct-website | `https://line.me/R/ti/p/@naturism?utm_source=lp&utm_medium=referral&utm_campaign=launch_2026_05` | `from-lp` | `naturism-welcome-v1` | naturism-diet.com 自社 LP の「LINE 追加」 ボタン |

**注意**: `https://line.me/R/ti/p/@naturism` の `@naturism` 部分は LINE 公式アカウントの **basic_id** に置き換える (= LINE Official Account Manager で確認可能)。 現状 `line_accounts` table に basic_id 保存されていれば確認可能。

### tracked_links 作成手順

1. admin web (= https://naturism-admin.pages.dev) にログイン
2. 左サイドバーから「トラッキングリンク」 (= /tracked-links page) を開く
3. 「新規作成」 ボタンから上記表の各行を 1 件ずつ作成
4. 生成された短縮 URL (= `https://naturism-line-crm.katsu-7d5.workers.dev/t/<linkId>`) を該当媒体に貼る
5. SNS 投稿 / 広告クリエイティブ / LP ボタンに埋め込み

---

## 4. /traffic-sources 効果測定手順

### 4.1 admin web で確認できる metrics

`/traffic-sources` page (= apps/web/src/app/traffic-sources/page.tsx) で以下が見える:

| 上部 stat cards | 意味 |
|---|---|
| 総クリック | 全 tracked link の累計 click 数 |
| 識別済クリック | friend_id 紐付け済 click 数 (= LIFF 経由 or LINE 友だち化済) |
| ユニーク友だち | click した distinct friend 数 |
| 30日クリック | 直近 30 日 click 数 |
| 7日クリック | 直近 7 日 click 数 |

| 中央 UTM 集計 | 意味 |
|---|---|
| source / medium / campaign | UTM 3 軸で grouping した click + 友だち + リンク数 |

| 下部 リンク別 table | 意味 |
|---|---|
| リンク名 / 総クリック / 30日 / 7日 / ユニーク友だち / 識別率 / 最終クリック | 個別 link の deep dive |

### 4.2 LP ローンチ後の確認 cadence

| タイミング | 確認内容 | アクション |
|---|---|---|
| ローンチ後 1 時間 | 総クリック > 0? UTM 別 click 発生? | クリック 0 → tracked link URL 正しく貼れているか、 LINE 公式 basic_id 正しいか確認 |
| ローンチ後 24 時間 | ユニーク友だち > 0? 識別率は? | 友だち 0 → 流入はあるが友だち化されてない (= LIFF / 友だち追加 flow 確認)。 識別率 < 30% → tracked link 経由ではなく直接友だち追加が多い (= LP CTA を tracked URL に変更検討) |
| ローンチ後 7 日 | source 別 conversion rate (= click → 友だち化) | 低い source は LP/広告クリエイティブ見直し、 高い source は予算配分強化 |
| 継続 | クーポン発行成功率 (= /audit-logs) | line_friend_coupon.issue_failed が出たら Discord alert + admin UI で詳細確認 |

### 4.3 関連 admin pages

LP ローンチ後に併用する admin pages:

| Page | 役割 | URL |
|---|---|---|
| /traffic-sources | 流入経路別の集計 | https://naturism-admin.pages.dev/traffic-sources |
| /line-insights | AI 返信率 / 配信 / シナリオ / クーポン overview | https://naturism-admin.pages.dev/line-insights |
| /coupons | LINE 友だち追加クーポン発行履歴 | https://naturism-admin.pages.dev/coupons |
| /audit-logs | クーポン発行成否 + 監査ログ | https://naturism-admin.pages.dev/audit-logs?actionPrefix=line_friend_coupon. |
| /friend-detail | 個別友だちの coupon + 関連 audit logs | https://naturism-admin.pages.dev/friend-detail?friendId=... |
| /broadcasts | 配信状況 (= insights modal で read/click rate) | https://naturism-admin.pages.dev/broadcasts |

### 4.4 Discord 通知 (= 既配線済)

`line_friend_coupon.issue_failed` が一定数発生した場合、 Discord webhook 経由で `#一般` channel に CRITICAL alert が来る (= 5/22 朝 Katsu 設定済)。 alert 来たら即 /audit-logs で詳細確認 → 真因確定 → fix PR。

---

## 5. ローンチ前 checklist (= Katsu 確認用)

### LP / SNS 準備
- [ ] LP の文言が薬機法 OK (= 法務確認済)
- [ ] LINE 公式アカウントの basic_id (= `@naturism` 部分) 確認
- [ ] LINE 友だち追加 URL を tracked_links 化 (= /tracked-links page で作成)
- [ ] SNS 投稿テンプレを実投稿用に customize (= 製品具体名 / 表現を薬機法 safe に)
- [ ] LP の「LINE 友だち追加」 ボタンに tracked URL を埋め込み

### 監視 / alert 準備
- [x] cron monitoring (broadcast-insights-fetch + audit-failure-monitor) 稼働
- [x] Discord webhook 配線済 (= #一般)
- [ ] /traffic-sources / /coupons / /audit-logs を Katsu の Bookmark に追加
- [ ] LP ローンチ直後 1 時間は集計 page を 15 分毎に確認 (= 想定外問題の早期発見)

### Welcome scenario 確認
- [x] `naturism-welcome-v1` scenario が active で正常配信中
- [x] step 0/1/2 配信 + クーポン埋込 動作確認 (= Katsu 実機 LINE で完了)
- [x] クーポン有効期限 3 日 (= B2C best practice、 PR #34)

### 流入後の対応準備
- [ ] 1 日 1 回 /traffic-sources でクリック傾向確認
- [ ] alert 来たら即対応 (= /audit-logs 真因確定 → fix PR)
- [ ] 想定外の流入急増時の handling (= Worker rate limit / D1 size check)

---

## 6. 関連リソース

| Resource | 場所 |
|---|---|
| LINE 公式 OA Manager | https://manager.line.biz/account/@naturism |
| Cloudflare worker dashboard | https://dash.cloudflare.com → Workers & Pages → naturism-line-crm |
| D1 console | https://dash.cloudflare.com → D1 → naturism-line-crm |
| Shopify admin | https://xn-0ckn0a9fxa4a.myshopify.com/admin |
| 自社 LP | https://naturism-diet.com |

---

## 補足: 想定 KPI (= ローンチ後 1 ヶ月、 達成度合いで施策見直し)

- 総クリック: 1,000+
- ユニーク友だち追加: 100+
- 識別率: 50%+ (= tracked URL 経由)
- クーポン発行成功率: 95%+ (= /audit-logs `issue_succeeded` 比率)
- クーポン使用率: 20-30% (= B2C average)

これらは naturism の規模感からの**目安**。 実流入を見ながら見直す。

---

**作成者注 (Claude)**: 本資料は autonomous 進行で作成した template。 実 LP / 広告クリエイティブには brand voice + 法務確認が必須。 薬機法に関する解釈は brand 側責任、 本資料は出発点として活用すること。
