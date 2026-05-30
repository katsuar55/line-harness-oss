# Full-Project Code Review — line-harness-oss

**Date:** 2026-05-30  
**Method:** 14-subsystem multi-agent fan-out → per-subsystem adversarial verification → cross-cutting synthesis (29 agents, ~3.8M tokens, 749 tool-uses).  
**Baseline at review:** preflight green, all typechecks green, 2,472 tests passing (worker 2,429 + sdk 43).  
**Scope:** apps/worker (64 routes, 70 services), packages/db (59 migrations), apps/web (Next.js 15), packages/{line-sdk,ai-provider,email-sdk,shared,sdk}.

> Every finding below was independently re-verified by a second skeptic agent that re-read the cited code; false positives were dropped. 98 findings survived verification.

## Overall health: **FAIR**

line-harness-oss is a feature-rich, fast-moving single-operator (naturism) LINE CRM on Cloudflare Workers + D1 + Next.js, and the core happy paths are working in production. However, the review surfaces a consistent and dangerous pattern at the trust boundary: several public, auth-exempt endpoints (form submit, LIFF profile, LIFF reorder, /auth/callback, email resubscribe) derive a privileged identity from attacker-controllable request fields (friendId / lineUserId / orderId / uid) instead of from the already-verified LINE idToken the middleware computes — yielding real IDOR, an account-takeover linking primitive, and a consent-integrity hole. Equally important for a system now taking real revenue traffic: the orders/paid -> membership credit runs in waitUntil() behind a notification-keyed idempotency guard with NO replay/recovery path (the intended drain function is dead code), so a single background failure permanently under-counts members.total_purchase_jpy. Cross-cutting structural debt compounds this: a recurring "select-then-act without atomic claim" race across step delivery and scheduled broadcasts, a pervasive missing-line_account_id multi-tenant gap that is dormant only because exactly one account is active today, several oversized files/functions (1000-2300 lines) that hide these bugs, and a duplicate Hono route that silently kills a shipped feature. None of the security holes require credentials beyond a valid LINE login, and the dormant multi-tenant defects all become live the moment the roadmapped second brand ("健康エクスプレス") is onboarded. The fixes are well-understood and mostly localized.

## Findings at a glance

| Severity | Count |  | Category | Count |
|---|---|---|---|---|
| CRITICAL | 1 |  | data-integrity | 24 |
| HIGH | 14 |  | bug | 23 |
| MEDIUM | 29 |  | security | 18 |
| LOW | 54 |  | maintainability | 18 |
|  |  |  | performance | 7 |
|  |  |  | workers-trap | 6 |
|  |  |  | test-gap | 2 |

**Total: 98 verified findings.**

## Cross-cutting themes

### [CRITICAL] Public/auth-exempt endpoints trust client-supplied identity instead of the verified LINE idToken (IDOR + account-takeover)
- **Affected:** apps/worker/src/routes/forms.ts (/submit); apps/worker/src/routes/liff.ts (/api/liff/profile, /auth/callback); apps/worker/src/routes/liff-portal.ts (reorder/create); apps/worker/src/middleware/auth.ts (skip-list)
- **Recommendation:** Establish one rule: for any endpoint behind liffAuthMiddleware, derive friendId/userId ONLY from c.get('liffUser') and IGNORE body.friendId/body.lineUserId/uid. For ownership-scoped resources (orders), add *_ForFriend(db, id, friendId) query helpers with AND friend_id=? so scoping can't be forgotten. The codebase already removed exactly this lineUserId-only pattern in liff-auth.ts:100 — apply that decision uniformly. Return 404 (not 403) on ownership mismatch to avoid existence oracles.

### [HIGH] Order->membership revenue credit has no idempotent replay/recovery; a waitUntil() failure permanently loses money
- **Affected:** apps/worker/src/routes/shopify-phase2a.ts (payment webhook); packages/db/src/membership.ts (listUnappliedPurchaseEvents is dead code); apps/worker/src/services/membership-promotion-cron.ts
- **Recommendation:** Move the member_purchase_events INSERT OUT from behind the notification-keyed 'Already notified' early-return so it always runs, relying on member_purchase_events.shopify_order_id UNIQUE + applied_at CAS for idempotency. Add a cron that (a) replays shopify_orders LEFT JOIN member_purchase_events WHERE mpe.id IS NULL and (b) drains the currently-unused listUnappliedPurchaseEvents. This is the same atomic-idempotency discipline already adopted for D1 counters in PR #89.

### [HIGH] 'select-then-act' without an atomic claim lets overlapping/fanned-out cron double-send
- **Affected:** apps/worker/src/services/step-delivery.ts; apps/worker/src/services/broadcast.ts (processScheduledBroadcasts / updateBroadcastStatus); apps/worker/src/index.ts (per-token cron fan-out)
- **Recommendation:** Claim every due row before sending: UPDATE ... SET <future-sentinel/'sending'> WHERE id=? AND <observed-value>, proceed only if meta.changes===1. For broadcasts: UPDATE broadcasts SET status='sending' WHERE id=? AND status='scheduled'. Cloudflare does not guarantee non-overlapping scheduled invocations, so this is the correct structural guard, not best-effort sleeps.

### [HIGH] Pervasive missing line_account_id scoping — dormant single-tenant, live the moment account #2 is added
- **Affected:** packages/db migrations 058/059 (members, member_purchase_events, membership_tiers); apps/worker/src/index.ts cron fan-out; scenarios/broadcasts/reminders/weekly-report/birthday/ban-monitor queries; apps/worker/src/services/ai-fact-context.ts (null-account branch leaks all tenants)
- **Recommendation:** Before onboarding '健康エクスプレス': add line_account_id to members/member_purchase_events/membership_tiers and to friend_scenarios; scope every resolve/list/cron query by account (legacy NULL via OR line_account_id IS NULL); make shopify_customer_id uniqueness per-account; and fix ai-fact-context.ts to return '' when lineAccountId is null instead of querying all tenants. Add a regression test asserting cross-account isolation. Treat account-#2 activation as the trigger to raise all these from latent to release-blocking.

### [MEDIUM] Email/Shopify case-sensitive matching silently misses links and creates duplicate/desynced rows
- **Affected:** apps/worker/src/routes/shopify.ts (findFriendAndBackfill); apps/worker/src/services/email-opt-in.ts; packages/db/src/email-subscribers.ts; migration 042 (case-sensitive unique index)
- **Recommendation:** Introduce one normalizeEmail() (trim+toLowerCase) applied at EVERY email write/lookup boundary, and match Shopify friend emails with WHERE email=LOWER(?) (phone is already normalized). Add COLLATE NOCASE to the email columns/unique index via migration and backfill-dedupe before the next campaign. A sibling matcher already lowercases, proving the inconsistency.

### [MEDIUM] Idempotency / out-of-order resilience gaps on webhook ingestion
- **Affected:** apps/worker/src/routes/webhook.ts (no webhookEventId dedup); packages/db/src/email-logs.ts (status can regress clicked->delivered); packages/db/src/scenarios.ts (no UNIQUE friend+scenario; un-guarded enroll callers)
- **Recommendation:** Add an idempotency guard keyed on webhookEventId (KV TTL or processed_events ON CONFLICT DO NOTHING); rank email statuses so updateEmailLogStatus only advances, never regresses; centralize scenario-enroll dedup INTO enrollFriendInScenario (or partial UNIQUE index) so the un-guarded automation/form/tracked-link paths inherit it.

### [LOW] Non-constant-time secret comparisons (consistency hardening)
- **Affected:** apps/worker/src/middleware/auth.ts:62 (master API_KEY ===); apps/worker/src/routes/shopify-auth.ts:76 (OAuth HMAC ===)
- **Recommendation:** Reuse the existing constant-time verifier (utils/shopify-hmac.ts / constantTimeEqual in email-unsubscribe.ts) for both, and guard `if (env.API_KEY && token === env.API_KEY)` so an empty API_KEY can never authenticate. Low remote exploitability but trivial to align with the patterns already in the repo.

### [LOW] Oversized files/functions (>800-line files, >50-line functions) hide the bugs above and dodge type-checking
- **Affected:** webhook.ts (1220, handleEvent ~1066); monthly-broadcast-postback.ts (1730); liff-portal.ts (2407) / liff-pages.ts (2279); shopify.ts (821) / shopify-phase2a.ts (1070); several apps/web pages + lib/api.ts (1014)
- **Recommendation:** Split per-event-type/per-concern modules and extract template-literal SPAs into real .ts/.js assets so they regain lint/type/test coverage. Prioritize the files that also host security/idempotency logic (webhook.ts, shopify-phase2a.ts, forms.ts, liff-portal.ts) so those fixes are reviewable in isolation.

## Architectural recommendations (toward the optimal system)

- Introduce a single 'verified identity' contract for all public/LIFF endpoints: a thin helper (e.g. requireLiffFriend(c)) that returns c.get('liffUser') and is the ONLY source of friendId/userId; lint/ban reads of body.friendId/body.lineUserId/uid in route handlers. This systematically eliminates the IDOR class (ranks #1-4) rather than patching each endpoint.
- Adopt a uniform idempotency + atomic-claim toolkit and apply it everywhere a row is 'selected then acted on': member_purchase_events INSERT outside the notification guard, step-delivery and broadcast claim-before-send, and webhook webhookEventId dedup. The project already proved this pattern for D1 counters (PR #89) — promote it to a shared helper (claimRow(db,table,id,observed) / ON CONFLICT DO NOTHING) so future features inherit it.
- Make line_account_id a first-class, non-optional dimension before brand #2: add it to members/member_purchase_events/membership_tiers/friend_scenarios and messages_log, thread it through every resolve/list/cron query, make per-account uniqueness on shopify_customer_id, and add a cross-tenant isolation regression test. Gate the '健康エクスプレス' onboarding on this work, since ~8 dormant findings go live simultaneously at that moment.
- Push delivery/cron selection into bounded SQL (WHERE due<=? AND line_account_id=? LIMIT n, normalized timestamps) and add per-job KV/D1 mutexes; stop loading whole tables into the 128MB isolate and stop relying on the activeTokens Set coincidence to prevent duplicate sends. This addresses the N+1/unbounded-scan/fan-out cluster (ranks #9,#23,#24,#57,#58) coherently as the system scales toward 5k friends.
- Type the LINE SDK error surface (LineApiError with .status/.code) and add timeout + bounded backoff to its fetch client, so callers can branch on status instead of substring-matching '400', stalled calls fail fast inside waitUntil, and the SDK matches the public @line-harness/sdk contract (ranks #53,#60,#45).
- Break up the oversized files that concentrate risk — webhook.ts (extract per-event handlers + Flex builders), shopify-phase2a.ts (split the order->member webhook into its own focused file), forms.ts, liff-portal.ts/liff-pages.ts (extract template-literal SPAs into real bundled .ts/.js assets). Beyond the 800-line rule, this restores type-checking/lint/test coverage to code that currently ships untyped inside template literals and makes the security/idempotency fixes reviewable in isolation.
- Centralize an email/contact normalization boundary (normalizeEmail at every email_subscribers and users write/lookup) plus COLLATE NOCASE on email columns and a one-time backfill-dedupe, eliminating the duplicate-row/consent-desync and Shopify match-miss classes (ranks #15,#16) at the source rather than per-call-site.
- Add a startup invariant/test that fails on duplicate Hono path+method registration and on auth-skip-list entries lacking an alternative verification (HMAC/idToken), so regressions like the duplicate product webhook and any future unauth endpoint are caught in CI rather than in production.

## Quick wins (trivial/small, high-value)

- liff.ts:526 — stop returning user_id and read identity from c.get('liffUser') instead of body.lineUserId (closes the profile IDOR; trivial).
- liff-portal.ts:285 — add `if (order.friend_id !== user.friendId) return 404` after getShopifyOrderById (closes the reorder IDOR).
- index.ts:178 — return undefined for non-allowlisted origins so the CORS allowlist is actually enforced; add a separate cors({origin:'*'}) only on /images/*.
- auth.ts:62 — guard `if (c.env.API_KEY && token === c.env.API_KEY)` and use a constant-time compare (reuse constantTimeEqual already in the repo).
- apps/web/page.tsx:156 — replace the hardcoded line-crm-worker.line-crm-api.workers.dev host with one derived from the API base (dead user-facing link today).
- api.ts:91 — parse the JSON body on !res.ok and throw body.error (surfaces real server errors to ~25 callers; mirrors uploadImage).
- Delete the duplicate POST /webhook/product route in shopify-products.ts (or shopify.ts) — un-shadows the dead auto-notify feature and removes divergent delete semantics.
- ai-response.ts:276 — run detectNgWords on raw model output / union redact's detectedPhrases so the 薬機法 audit column stops under-reporting.
- ai-fact-context.ts — return '' when lineAccountId is null instead of querying all tenants' broadcasts (cross-tenant leak guard).
- membership.ts:220-230 — add a console.error when oldTier/newTier lookup fails (drift visibility, matches existing push-failure log).
- liff.ts:945 — wrap pictureUrl in escapeHtml (only un-escaped sink in the file).

## Prioritized remediation backlog

Ranked by severity × blast-radius × confidence. `fixEffort`: trivial/small/medium/large.

**1. [CRITICAL][security][small]** Unauthenticated form /submit allows IDOR writes against any friend (metadata poison, forced tag/enroll, unsolicited push)  
`apps/worker/src/routes/forms.ts:172-258`  
→ Add /api/forms/:id/submit to liffAuthMiddleware coverage (or inline idToken verify) and derive friendId solely from the verified sub; ignore body.friendId/body.lineUserId. If anonymous submissions must persist, store with friendId=null and apply NO friend side-effects (metadata/tag/scenario/push). Add per-IP rate limit + body-size cap. Verified: auth.ts:40 exempts the route; handler at forms.ts:212-257 trusts body and runs metadata merge/tag/enroll/push.

**2. [HIGH][security][trivial]** POST /api/liff/profile IDOR: ignores verified identity, leaks any friend's internal id + account user_id by lineUserId  
`apps/worker/src/routes/liff.ts:508-533`  
→ Read c.get('liffUser') and look up by the verified lineUserId/friendId; do NOT accept body.lineUserId. Stop returning user_id (the cross-account linking key). Verified: handler at liff.ts:515 calls getFriendByLineUserId(body.lineUserId) and returns user_id at line 526 despite liffAuthMiddleware providing a verified identity.

**3. [HIGH][security][medium]** /auth/callback trusts unverified uid param to bind a friend to an arbitrary user account (account-takeover primitive)  
`apps/worker/src/routes/liff.ts:291-313`  
→ Require a signed, short-lived linking token issued to an authenticated session of the target user instead of a raw UUID in the OAuth state; validate the verified LINE identity may merge with that user (e.g. matching verified email). Pairs with rank #2 so user_id UUIDs aren't externally discoverable. Verified: uid flows unauthenticated /auth/line -> state -> linkFriendToUser at liff.ts:292-293.

**4. [HIGH][security][small]** Reorder/create reads arbitrary orderId without friend ownership check (IDOR exposes another customer's SKUs/quantities)  
`apps/worker/src/routes/liff-portal.ts:283-294`  
→ After getShopifyOrderById, enforce order.friend_id===user.friendId and return 404 on mismatch; better add getShopifyOrderByIdForFriend(db,id,friendId) with AND friend_id=?. shopify_orders has no line_account_id, so friend_id is the correct ownership boundary. Verified: getLiffUser provides verified friendId but the handler never compares it to order.friend_id.

**5. [HIGH][data-integrity][medium]** orders/paid member credit gated by notification key + runs in waitUntil with NO replay path -> permanent revenue under-count  
`apps/worker/src/routes/shopify-phase2a.ts:439-442, 492-499, 517-544`  
→ Move the member_purchase_events INSERT/syncOrderToMember OUT from behind the 'Already notified' early-return (line 440) so it always runs, relying on shopify_order_id UNIQUE + applied_at CAS for idempotency; add a cron replaying shopify_orders LEFT JOIN member_purchase_events WHERE mpe.id IS NULL and draining listUnappliedPurchaseEvents. Verified: createPaymentNotification commits before the waitUntil member-sync; listUnappliedPurchaseEvents has zero callers (dead code) and no cron replays orders.

**6. [HIGH][data-integrity][small]** Unbounded resubscribe re-activates bounce-/complaint-suppressed subscribers (deliverability + 特定電子メール法 risk)  
`packages/db/src/email-subscribers.ts:219-234`  
→ Refuse reactivation when complaint_count>0 (or require an explicit audited force flag); for bounce_count>=threshold only on deliberate logged admin action; surface a distinct outcome like performEmailOptIn's hadComplaint. Verified: resubscribeById does is_active=1 with no guard and is reachable from public /email/resubscribe and admin PATCH.

**7. [HIGH][security][small]** Unsubscribe HMAC token doubles as a permanent, action-agnostic re-subscribe credential on a public endpoint  
`apps/worker/src/routes/email-unsubscribe.ts:315-330`  
→ Bind the signed payload to action+expiry (sign `${id}:unsub` vs `${id}:resub:${exp}`), or drop public /email/resubscribe and re-subscribe only via authenticated admin PATCH or the time-boxed opt-in flow. Verified: /email/resubscribe is auth-exempt (auth.ts:27) and verifies only HMAC(key,subscriberId) with no expiry/action binding.

**8. [HIGH][data-integrity][medium]** Step delivery has no atomic claim -> overlapping cron re-sends the same scenario step  
`apps/worker/src/services/step-delivery.ts:113-128, 230-244`  
→ Claim each due row before sending: UPDATE friend_scenarios SET next_delivery_at=<claimed marker> WHERE id=? AND next_delivery_at=<observed>, proceed only if meta.changes===1; push the epoch filter + LIMIT into getFriendScenariosDueForDelivery and make advance idempotent. Verified: send (step-delivery.ts:286) precedes advance (:240) with no CAS; schema has no claim column.

**9. [HIGH][workers-trap][medium]** Cron fans out per account token but step/broadcast queries are global -> cross-account duplicate sends once a 2nd token exists  
`apps/worker/src/index.ts:371-403`  
→ Thread lineAccountId into processStepDeliveries/processScheduledBroadcasts/reminders and scope: broadcasts.line_account_id=? (column exists), step delivery JOIN friend_scenarios->friends on friends.line_account_id=?. Decide an owner for line_account_id IS NULL broadcasts. Dormant today only because activeTokens is a Set and one account is active; becomes live with account #2. Build each token's job set only for friends it owns.

**10. [HIGH][bug][small]** Duplicate Hono route /webhook/product silently kills the shipped products/create auto-notify feature  
`apps/worker/src/routes/shopify-products.ts:225-304`  
→ Pick one canonical handler and delete the other route. The first-mounted (shopify.ts:373) wins, so shopify-products.ts:225-304 (incl. auto-notify) never executes; their delete semantics also diverge (soft-archive vs hard-delete). If auto-notify is wanted, port the FIXED query (see rank #20) into shopify.ts; add a startup/test assertion that fails on duplicate path+method registration. Verified by grep: both files register the same path.

**11. [HIGH][data-integrity][small]** 薬機法 NG-word detection runs on already-redacted text -> compliance-monitoring column systematically under-reports highest-risk phrases  
`apps/worker/src/services/ai-response.ts:274-295`  
→ Detect on RAW model output: surface redactProhibitedPhrases' existing detectedPhrases (redact.ts:73) on TextGenerationResponse and either run detectNgWords on rawText or union detectedPhrases into ng_words_detected. End users are still protected by redaction; the defect is purely the audit signal the team relies on for weekly compliance sanity. Verified: both providers redact before ai-response.ts:276 detects.

**12. [MEDIUM][data-integrity][small]** Scheduled-broadcast 'sending' flip is not atomic -> overlapping/fanned-out cron double-sends an all/tag broadcast  
`apps/worker/src/services/broadcast.ts:33-41, 508-526`  
→ Claim atomically: UPDATE broadcasts SET status='sending' WHERE id=? AND status='scheduled', proceed only if meta.changes===1. Verified: updateBroadcastStatus is an unconditional UPDATE with no status guard, after a non-atomic select of status==='scheduled'. Combine with rank #9 account scoping.

**13. [MEDIUM][bug][small]** One malformed automation row aborts all remaining automations for the event (no per-row try/catch around JSON.parse)  
`apps/worker/src/services/event-bus.ts:211-251`  
→ Wrap the per-automation body (both JSON.parse + matchConditions + action loop + createAutomationLog) in its own try/catch inside the for-loop so a bad row is logged 'failed' and skipped; add zod validation of conditions/actions at write time in routes/automations.ts. Verified: JSON.parse at event-bus.ts:219-220 sits outside the per-action try.

**14. [MEDIUM][workers-trap][trivial]** AI fact-context null-account branch returns ALL tenants' broadcast titles into a per-friend prompt (cross-tenant leak)  
`apps/worker/src/services/ai-fact-context.ts:103-123`  
→ When lineAccountId is null return '' (no broadcast context) instead of querying all tenants, or make lineAccountId required. Reachable because webhook.ts defaults lineAccountId to null. Zero blast radius today (single account) but a real cross-tenant leak as multi-brand lands.

**15. [MEDIUM][data-integrity][small]** Friend email matching is case-sensitive -> Shopify casing differences silently break linkage/tagging/enrollment  
`apps/worker/src/routes/shopify.ts:74-84`  
→ Match WHERE email=LOWER(?) and store users.email lowercased on every write (LIFF login, backfill). Phone is already normalized; a sibling matcher already lowercases, proving the inconsistency. This is the 'matching 0件' class the comment block at shopify.ts:43-56 was added to fix.

**16. [MEDIUM][data-integrity][medium]** Email subscriber case-sensitivity split creates duplicate rows + silent consent desync  
`apps/worker/src/services/email-opt-in.ts:190-208`  
→ Apply a single normalizeEmail() at every email_subscribers write/lookup (performEmailOptIn, getEmailSubscriberByEmail, recordMarketingOptIn, GET opt-in check, admin generate-url/add) and/or add COLLATE NOCASE to the column+unique index (migration 042 is case-sensitive); backfill-dedupe before any campaign. Verified: candidate JOIN lowercases but the opt-in write path uses raw-case WHERE email=?.

**17. [MEDIUM][security][small]** CORS reflects any Origin (allowlist is dead code) — effectively Access-Control-Allow-Origin: *  
`apps/worker/src/index.ts:168-180`  
→ Return undefined for non-allowlisted origins so Hono omits ACAO on API routes; scope a separate app.use('/images/*', cors({origin:'*'})) for public assets. Keep credentials unset. Add a test that an evil origin gets no ACAO. Verified: index.ts:178 unconditionally `return origin`. Bounded impact (no cookie credentials) but defeats the intended restriction.

**18. [MEDIUM][data-integrity][medium]** Webhook events processed with no idempotency (LINE redelivery / webhookEventId ignored) -> duplicate messages_log/food_logs/AI sends  
`apps/worker/src/routes/webhook.ts:137-149`  
→ Guard handleEvent on event.webhookEventId (KV TTL or processed_events ON CONFLICT DO NOTHING) and short-circuit repeats; at minimum gate the side-effecting INSERTs/AI sends on !deliveryContext?.isRedelivery. Exposure is conditional (200 returned fast via waitUntil; redelivery only on genuine 5xx/timeout) but the text/image INSERTs are unconditional.

**19. [MEDIUM][data-integrity][medium]** Payment webhook credits members on non-'paid' states and has no refund handler -> total_purchase_jpy inflated, ghost tiers  
`apps/worker/src/routes/shopify-phase2a.ts:430, 515-534`  
→ Gate the member credit on financial_status==='paid'; add a refunds/create webhook recording a negative member_purchase_event with its own idempotency key (tiers don't demote, so refunded gross otherwise sticks forever). Pairs with the rank #5 recovery cron. Verified: financialStatus defaults 'paid' and amountJpy is passed with no status check.

**20. [MEDIUM][bug][small]** Product auto-notify query JOINs product id to customer id (+ fallback LIMIT 0) -> recipient set always empty/garbage  
`apps/worker/src/routes/shopify-products.ts:263-271`  
→ Resolves itself if the dead handler is deleted (rank #10). If ported/kept, target by product_type via shopify_orders.line_items (or a normalized line-items table) and change fallback LIMIT 0 to a real cap. Verified: JOIN sp.shopify_product_id = so.shopify_customer_id is across disjoint ID spaces.

**21. [MEDIUM][data-integrity][small]** Email webhook status can regress on out-of-order events (clicked -> delivered) corrupting KPI/status filter  
`packages/db/src/email-logs.ts:164-198`  
→ Rank statuses and only advance (SET status=CASE WHEN rank(new)>rank(current) THEN ? ELSE status END), treating bounced/complained/failed as terminal; leave counters/timestamps (already first-write/atomic). Add an out-of-order unit test. Verified: updateEmailLogStatus sets status unconditionally; Resend/Svix don't guarantee order.

**22. [MEDIUM][data-integrity][small]** Form submission merges arbitrary non-allowlisted keys into friends.metadata (incl. preferred_hour driving delivery window)  
`apps/worker/src/routes/forms.ts:189-209`  
→ Project submissionData onto the declared field.name set (drop unknown keys) and namespace under metadata.form_<id> rather than spreading into top-level metadata. Primary fix remains authenticating /submit (rank #1). Verified: merged={...existing,...submissionData} with no projection at forms.ts:241.

**23. [MEDIUM][data-integrity][medium]** Delivery crons ignore line_account_id and run once per active token (reminder/weekly/subscription/birthday)  
`apps/worker/src/index.ts:371-403`  
→ Thread account id through each delivery cron and add AND line_account_id=? (legacy NULL via OR IS NULL); iterate per active account with its matching token. Dormant today (Set-dedup + globally-unique line_user_id pool) — raise to HIGH the moment a 2nd token is activated. Same root cause as rank #9; fix together.

**24. [MEDIUM][performance][small]** N+1 over an unbounded set in reminder delivery cron (1+2N queries, no LIMIT)  
`packages/db/src/reminders.ts:123-153`  
→ Batch: collect reminder_ids/friend_reminder_ids then fetch steps and deliveries via two IN(...) queries and join in memory; add a bounded LIMIT to the outer query and page across ticks. Verified: getReminderSteps + per-row deliveries SELECT inside an unbounded loop in the 5-min handler.

**25. [MEDIUM][bug][small]** Failed scheduled broadcast resets to 'draft' and is never retried by cron (misleading 'so it can be retried' comment)  
`apps/worker/src/services/broadcast.ts:67-81, 517-522`  
→ Keep failed scheduled broadcasts in a cron-retryable state with a bounded attempt counter (or back to 'scheduled'), and on LINE tag retries consult the existing broadcast_id-keyed messages_log rows to skip already-sent friends (mirroring the email loadSentSubscriberIdsForBroadcast dedup). Verified: cron only re-selects status==='scheduled'.

**26. [MEDIUM][data-integrity][small]** Blacklist (is_blacklisted) not honored on tag/all broadcast and step delivery  
`apps/worker/src/services/broadcast.ts:137-139, 228-239`  
→ Add COALESCE(is_blacklisted,0)=0 to getFriendsByTag and both resolveFollowingFriends 'all' email queries, and check is_blacklisted in processSingleDelivery (add the field to the Friend interface). Document that LINE's server-side 'all'-broadcast API cannot filter blacklist client-side. Verified: segment-query filters it but tag/step paths don't.

**27. [MEDIUM][workers-trap][large]** members / member_purchase_events / membership_tiers have no line_account_id (single-tenant only)  
`packages/db/migrations/058_membership_tiers.sql:50-61`  
→ Before onboarding brand #2: add line_account_id to these tables (backfill from friends), scope every resolve/upsert/promote/tier/stat query + index by it, make shopify_customer_id uniqueness per-account, and scope the friend-match SELECTs to the order's owning account. Until then document the single-tenant assumption atop shopify-order-member-sync.ts. Verified: zero line_account_id columns; migration 060 adds a GLOBALLY unique friends(shopify_customer_id) index.

**28. [MEDIUM][bug][medium]** X (Twitter) conversion API called without required OAuth 1.0a signature -> branch silently 401s forever  
`apps/worker/src/services/ad-conversion.ts:146-158`  
→ Implement OAuth 1.0a signing for the X endpoint, or feature-flag/mark 'x' unsupported and log a distinct errorMessage ('x integration not implemented') so failed rows are distinguishable from transient API errors. meta/google/tiktok send real auth, so this is X-specific. Verified: only a Content-Type header + 'placeholder' comment.

**29. [MEDIUM][bug][small]** Manual /api/integrations/shopify/sync fetches only the first page -> partial import reported as full reconciliation  
`apps/worker/src/routes/shopify.ts:560-709`  
→ Reuse the exported parseNextUrl() Link-following loop (already used by syncShopifyCustomers) for products/orders/customers, add limit=250, or at minimum return a truncated/cap flag. Watch Workers CPU when iterating many pages. Verified: products/orders/customers each fetched once with no rel=next loop but success:true regardless.

**30. [MEDIUM][data-integrity][medium]** friend_scenarios has no UNIQUE(friend_id,scenario_id); un-guarded enroll callers cause duplicate enrollments/step messages  
`packages/db/src/scenarios.ts:325-378`  
→ Move dedup INTO enrollFriendInScenario (return existing active/paused row instead of inserting) or add a partial UNIQUE index + INSERT...ON CONFLICT DO NOTHING (backfill-dedupe first). This closes the un-guarded start_scenario(event-bus)/form-submit/tracked-link/manual paths; webhook/liff/tag callers already guard. Corrected cause: highest-volume friend_add path is already guarded.

**31. [MEDIUM][security][small]** Shopify OAuth callback does not validate `shop` against a myshopify.com allowlist (token-exfiltration + reflected XSS surface)  
`apps/worker/src/routes/shopify-auth.ts:147-218`  
→ Reject 400 unless shop matches /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, assert shop===storedState.store_domain (already fetched) before code exchange, apply the same regex to the /auth/shopify start handler, and HTML-escape shop in the success page. HMAC over shop limits a fully-blind attacker, but the sibling sync paths already guard — make install consistent. Verified: shop used verbatim to build the token-exchange URL.

**32. [LOW][security][small]** Admin coach/reorder/email mutating routes gated only by authMiddleware, not requireRole  
`apps/worker/src/routes/coach-admin.ts:71-272`  
→ Apply requireRole('admin','owner') to mutating /api/admin/* endpoints (at least PUT /coach/sku-map) to match staff.ts's model; sweep reorder/email *-admin.ts for the same gap; add a test that a 'staff' token gets 403. Not a bypass (valid token required) — coarse authz granularity.

**33. [LOW][security][trivial]** Owner master API_KEY compared with non-constant-time === (and no empty-key guard)  
`apps/worker/src/middleware/auth.ts:62`  
→ Use a constant-time compare and guard `if (c.env.API_KEY && token === c.env.API_KEY)` so an empty/undefined API_KEY can never authenticate an empty bearer. Reuse constantTimeEqual already in the repo. Verified at auth.ts:62.

**34. [LOW][security][trivial]** Shopify OAuth-install HMAC uses non-constant-time string compare  
`apps/worker/src/routes/shopify-auth.ts:76`  
→ Hex-decode and verify via crypto.subtle.verify, or reuse constantTimeEqual after a ^[a-f0-9]{64}$ check; mirror utils/shopify-hmac.ts so all Shopify HMAC paths share one helper. Verified: `return computed === hmac` at line 76. Low remote exploitability.

**35. [MEDIUM][bug][trivial]** Dashboard CTA hardcodes a wrong/stale Worker hostname (dead friend-add link)  
`apps/web/src/app/page.tsx:156`  
→ Replace the hardcoded https://line-crm-worker.line-crm-api.workers.dev host with a value derived from the API base (or the public LINE/LIFF add-friend URL); the page already imports api. Verify the host resolves to the naturism worker before next deploy. Verified: a host found nowhere else in apps/web.

**36. [MEDIUM][maintainability][trivial]** fetchApi discards the server's structured {success:false,error} message  
`apps/web/src/lib/api.ts:82-92`  
→ On !res.ok do const body=await res.json().catch(()=>null); throw new Error(body?.error || `API error: ${res.status}`), mirroring the richer uploadImage path. ~25 callers currently can only show generic fallbacks.

**37. [LOW][security][small]** GET /api/forms/:id is public and leaks tag/scenario IDs + save_to_metadata + submit_count  
`apps/worker/src/middleware/auth.ts:41`  
→ Return a public-safe projection (id,name,description,fields only) for the unauthenticated GET; keep full serializeForm behind authMiddleware. Informational disclosure only (side-effects use server-stored IDs, not caller-supplied), so downgraded to LOW.

**38. [LOW][bug][trivial]** Unguarded JSON.parse of friend.metadata aborts the text handler on a corrupt row  
`apps/worker/src/routes/webhook.ts:564-565`  
→ Add safeParseJson(str):Record<string,unknown> returning {} on failure and use it at webhook.ts:565 and event-bus.ts:392 so one corrupt row degrades gracefully. Low: stored metadata is normally well-formed.

**39. [LOW][data-integrity][small]** Unguarded Number() coercion of Shopify money/count fields can persist NaN into D1  
`apps/worker/src/services/shopify-customer-sync.ts:116-117`  
→ Add toFiniteNumber(v)=>Number.isFinite(Number(v))?Number(v):undefined and use it for total_spent/total_price/orders_count/order_number across shopify-customer-sync.ts and shopify.ts (nullish ?? does not catch NaN). Preventive — Shopify returns well-formed values today.

**40. [LOW][data-integrity][small]** currency recorded but ignored — non-JPY orders credited as JPY (Shopify Markets incident precedent)  
`packages/db/src/membership.ts:371-423`  
→ In addPurchaseEvent (or the webhook), if (currency ?? 'JPY')!=='JPY' record the event with applied_at NULL + reason 'non-JPY' and skip the member credit (or convert). Cheap insurance given the documented Shopify Markets 29-country incident.

**41. [LOW][security][trivial]** completionPage interpolates pictureUrl into <img src> without escaping  
`apps/worker/src/routes/liff.ts:945`  
→ Use <img src="${escapeHtml(pictureUrl)}"> and optionally assert https:// prefix, matching every sibling field. Source is LINE CDN (trusted) so LOW, but it's the only un-escaped sink in the file.

**42. [LOW][data-integrity][small]** redactProhibitedPhrases uses naive substring replace (boundary bleed-through: 保証書, secure, healthy)  
`packages/ai-provider/src/redact.ts:60-74`  
→ Anchor English entries (/\bcure\b/gi, /\bheal\b/gi), reconsider bare 保証, and prefer verb-phrase regex style for Japanese. Failure direction is safe (over-redaction degrades copy, never leaks), hence LOW.

**43. [LOW][security][trivial]** Coach SKU click opens server-supplied shopifyProductId as a URL without scheme validation  
`apps/worker/src/routes/liff-coach-page.ts:259-265`  
→ Assert /^https?:\/\// before liff.openWindow/window.open, or build the store URL from a known base + product id/handle. Value is AI/system-generated today, so LOW.

**44. [LOW][security][small]** Survey list embeds double-JSON into a single-quoted onclick without HTML-attribute escaping  
`apps/worker/src/routes/liff-pages.ts:1683`  
→ Stash surveys in a JS array and pass only an index to openSurvey(idx), or attach via addEventListener; if inline must stay, HTML-attribute-escape the serialized string. Survey data is admin-authored, so LOW.

**45. [LOW][bug][trivial]** line-sdk/shared package.json exports.default resolves to raw .ts with no require/CJS condition  
`packages/line-sdk/package.json:8-14`  
→ Point default at ./dist/index.js and/or add a require condition (mirror @line-harness/sdk's require:./dist/index.cjs); same one-line fix in shared/package.json. Internal-only consumption makes it harmless today, but it would crash any CJS require.

**46. [MEDIUM][bug][medium]** Reorder product-picker sends Product id into the variantId field -> Draft Orders API rejects/mis-resolves  
`apps/worker/src/client/reorder.ts:892-895`  
→ Return the default/selected ProductVariant id in the Product payload and send that as variantId, or accept productId and resolve the variant server-side before building the draft order; add an integration test asserting a real ProductVariant gid is posted. Past-order path is unaffected (it uses stored variant_id). Verified: variantId mapped from shopifyProductId.

**47. [LOW][maintainability][small]** Step delivery messages_log records pre-expansion/pre-tracking content (audit/analytics mismatch)  
`apps/worker/src/services/step-delivery.ts:289-296`  
→ Log the rendered payload actually sent (trackedType/trackedContent for steps; auto-tracked finalContent for the LINE broadcast path) or store template id + rendered content. Drop segment-send from the claim (it logs what it sends). Verified for step + broadcast paths.

**48. [LOW][data-integrity][trivial]** Conversion eventValue of 0 silently dropped by truthiness checks  
`apps/worker/src/services/ad-conversion.ts:102-103`  
→ Guard on presence/finiteness (typeof===number && Number.isFinite) instead of truthiness across all four platform builders so a legitimate ¥0 CV is included.

**49. [LOW][maintainability][small]** Inconsistent delivery-window hours: enrollment 9-21 vs step scheduler 9-23 (duplicated literals)  
`packages/db/src/scenarios.ts:357-364`  
→ Extract the window constants + enforceDeliveryWindow into a shared package and call from both enrollFriendInScenario and step-delivery so first-step and subsequent-step scheduling agree. (Mind the packages/db vs apps/worker layer boundary.)

**50. [LOW][bug][small]** enforceDeliveryWindow ignores preferredHour 6-8 vs the hardcoded 9-23 cron gate  
`apps/worker/src/services/step-delivery.ts:85-100`  
→ Clamp per-friend preferred_hour to [DEFAULT_START_HOUR,DEFAULT_END_HOUR] (or tighten the webhook to reject <9) so scheduling and the cron gate agree; document precedence. webhook.ts allows 6-22.

**51. [LOW][maintainability][trivial]** AI nutrition copy clipped at 120 chars despite 60-char design/prompt (constant/comment mismatch)  
`apps/worker/src/services/nutrition-recommender.ts:44-48`  
→ Set AI_MESSAGE_MAX_LEN=60 to match prompt/SKU/header, or if 120 is intentional headroom update the comment+SYSTEM_PROMPT+header so all three agree, to avoid overflowing the LINE card layout.

**52. [LOW][bug][trivial]** Tier promotion silently skipped (no log) when membership_tier lookup fails after a committed promote  
`apps/worker/src/services/membership.ts:220-230`  
→ Add a console.error in the !oldTier||!newTier branch (signals members/membership_tiers drift, same as the existing push-failure log); optionally validate the tier exists before promoteMemberIfEligible runs its UPDATE. Tier is persisted, so no data loss.

**53. [LOW][bug][small]** Reply-token-expiry fallback relies on fragile substring match of '400'  
`apps/worker/src/services/event-bus.ts:331-341`  
→ Have the LINE SDK throw a typed LineApiError with .status and the parsed code, then branch on status===400 + the documented reply-token message rather than includes('400'). Low: replyMessage 400s here are nearly always expired tokens.

**54. [LOW][bug][small]** Shared EventPayload.replyToken mutated in place while Phase-2 handlers run concurrently  
`apps/worker/src/services/event-bus.ts:330`  
→ Treat payload as immutable: thread a private {replyToken} consumption context (or pass by value and return whether consumed) instead of writing onto the shared enrichedPayload. Caller object is already shielded by the spread copy; the notification body's replyToken is the only non-deterministic field. Aligns with repo immutability rule.

**55. [LOW][performance][trivial]** Redundant indexes duplicate UNIQUE-constraint implicit indexes (members.friend_id, member_purchase_events.shopify_order_id)  
`packages/db/migrations/058_membership_tiers.sql:63-64`  
→ Future migration: DROP idx_members_friend and idx_member_purchase_events_order (covered by the UNIQUE auto-index); keep the composite friend index and the partial unapplied index. Minor write-cost cleanup, safe to defer.

**56. [MEDIUM][performance][small]** Unbounded list SELECTs without LIMIT on traffic-growing tables (chats, users, calendar_bookings)  
`packages/db/src/chats.ts:87`  
→ Add LIMIT/OFFSET (or keyset) pagination to getChats, getUsers, getCalendarBookings matching the shopify.ts pattern (default ~100) and thread limit/offset from callers; prioritize getChats (agent inbox) and getCalendarBookings. Latent at current scale.

**57. [MEDIUM][workers-trap][small]** weekly-report pushes up to 5000 friends sequentially in one cron invocation (subrequest/duration cap risk)  
`apps/worker/src/services/weekly-report.ts:37-109`  
→ SELECT only friends not yet sent this week (LIMIT 200-500) using the existing content-LIKE dedup as cursor so the send drains across several Monday ticks; consider LINE multicast to cut subrequests. Likely survives at ~1,891 mostly-inactive friends today, hence MEDIUM.

**58. [MEDIUM][performance][small]** Unbounded in-memory load of all active scenarios / all broadcasts each cron tick  
`packages/db/src/scenarios.ts:380-397`  
→ Push the due-time predicate into SQL (WHERE next_delivery_at<=? normalized at write time, + LIMIT + ORDER BY) and have processScheduledBroadcasts query WHERE status='scheduled' AND scheduled_at<=? instead of fetching all rows; add line_account_id scoping in the same change (compounds with the per-token fan-out).

**59. [MEDIUM][data-integrity][small]** Birthday & membership-sanity crons query all friends but push with the single env token  
`apps/worker/src/services/birthday-cron.ts:94-122`  
→ Filter the birthday candidate query by line_account_id and iterate per active account with the matching token; scope members similarly. Dormant today (single account + global line_user_id pool); selecting+auditing line_account_id while not filtering on it is the tell. Fix with ranks #9/#23.

**60. [LOW][workers-trap][medium]** No retry/backoff/Retry-After and no fetch timeout in the line-sdk HTTP client  
`packages/line-sdk/src/client.ts:41-53`  
→ Attach signal:AbortSignal.timeout(ms) to all fetches (mirror the public SDK) and add opt-out bounded exponential backoff honoring Retry-After for idempotent GETs only (avoid duplicate LINE pushes). Callers retry on next cron, so LOW, but a hung api.line.me call can hold a waitUntil context until platform kill.

## All verified findings (full detail, by severity)

### CRITICAL (1)

#### [security] Unauthenticated form submit allows IDOR writes against any friend (metadata poisoning, forced tagging/enrollment, unsolicited push)
- **Location:** `apps/worker/src/routes/forms.ts:172-258`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.92
- **Verdict:** Confirmed: auth.ts:40 regex /^\/api\/forms\/[^/]+\/submit$/ returns next() with no token, and forms.ts:212-258 derives friendId from attacker-controlled body.friendId/body.lineUserId then runs privileged side-effects (metadata merge L240-245, addTagToFriend L252, enrollFriendInScenario L257, lineClient.pushMessage L322) with zero ownership proof. The repo's own liff-auth.ts:100-101 explicitly REMOVED the lineUserId-only path because 'knowing the ID = impersonation', proving the team already recognizes this exact risk — yet /submit reintroduces it. No rate limit or body-size cap.
- **Fix:** Gate /submit behind verified identity: reuse liffAuthMiddleware (verifies idToken against LINE Platform) and resolve the friend ONLY from the verified sub (c.get('liffUser').friendId). Ignore body.friendId/body.lineUserId entirely. If anonymous submissions must remain, persist them without acting on any friend (no tag/enroll/metadata/push) until identity is verified. Add per-IP rate limiting and a request body-size limit.

### HIGH (14)

#### [bug] Duplicate route `/api/integrations/shopify/webhook/product` — the shopify-products.ts handler (with auto-notify) is dead code
- **Location:** `apps/worker/src/routes/shopify-products.ts:225-304`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.95
- **Verdict:** Confirmed and empirically reproduced. index.ts:40 imports shopify.ts as `shopifyRoutes` (mounted line 215); index.ts:52 imports shopify-products.ts as `shopifyProducts` (mounted line 227). Both register POST /api/integrations/shopify/webhook/product (shopify.ts:373 and shopify-products.ts:225). A minimal Hono 4.12 repro shows the FIRST-mounted router's handler wins and returns the Response, so the shopify-products.ts handler — including the products/create auto-notify feature (lines 258-297) — never executes. Delete semantics also diverge: shopify.ts soft-archives (UPDATE status='archived', line 408) while shopify-products.ts hard-deletes (deleteShopifyProduct, line 246). A shipped feature is silently dead.
- **Fix:** Pick one canonical handler and delete the other route. If the products/create auto-notify is desired, port the corrected version (see next finding) into shopify.ts; otherwise remove the dead handler block in shopify-products.ts (225-304). Add a startup assertion or test that fails on duplicate Hono path+method registration to prevent recurrence.

#### [data-integrity] 薬機法 NG-word detection runs on already-redacted text, masking the compliance monitoring signal
- **Location:** `apps/worker/src/services/ai-response.ts:274-295`
- **Subsystem:** AI auto-reply + provider abstraction | **Confidence:** 0.9
- **Verdict:** Confirmed: WorkersAIProvider (workers-ai.ts:87) and ClaudeProvider (claude.ts:131) both return text already passed through redactProhibitedPhrases(); ai-response.ts:276 then runs detectNgWords(result.text) on that post-redaction text and stores it to conversation_logs.ng_words_detected (ai-response.ts:284). Overlap is real and heavy: redact PROHIBITED_PHRASES has 治る/治療/効く/予防効果/予防できる, ai-ng-filter NG_PATTERNS detects 治[りるっれら]/効く/(を)予防/(を)治療 — all replaced with [省略] before detection sees them. The monitoring column the team relies on for weekly compliance sanity systematically under-reports the highest-risk phrases.
- **Fix:** Run NG detection on RAW model output. redactProhibitedPhrases already computes detectedPhrases (redact.ts:73) — surface it: add rawText/detectedPhrases to TextGenerationResponse and either (a) detectNgWords(response.rawText) in ai-response.ts, or (b) union response.detectedPhrases into ngWordsDetected so the audit row records what redaction caught. Note: the redaction still protects the END USER (banned phrase never reaches the customer); the defect is purely in the audit/monitoring signal, which is why it is HIGH for data-integrity but not a user-facing compliance breach.

#### [security] POST /api/liff/profile is an IDOR: ignores verified identity, leaks any friend's internal id + user_id by lineUserId
- **Location:** `apps/worker/src/routes/liff.ts:508-533`
- **Subsystem:** LIFF pages/portal (huge files, user-facing) | **Confidence:** 0.9
- **Verdict:** Confirmed: liffAuthMiddleware (index.ts:190, liff-auth.ts:80-97) verifies SOME idToken and sets c.get('liffUser') to the VERIFIED identity, but the handler (liff.ts:515) ignores it and calls getFriendByLineUserId(DB, body.lineUserId) with the attacker-supplied id, returning internal friend UUID (id), display_name, is_following, and the account UUID (user_id, line 526). getFriendByLineUserId does SELECT * (friends.ts:58-62). Any authenticated LINE friend can enumerate other users' friend/account UUIDs — exactly the impersonation pattern the middleware comment at liff-auth.ts:100 says was removed.
- **Fix:** Read the verified identity: const u = c.get('liffUser'); look up by u.lineUserId (or just return u.friendId data). Do NOT accept lineUserId from the request body. Stop returning the internal user_id UUID to the client (it is the cross-account linking capability — see /auth/callback uid finding).

#### [security] IDOR: reorder/create reads arbitrary orderId without friend ownership check
- **Location:** `apps/worker/src/routes/liff-portal.ts:283-294`
- **Subsystem:** Coaching/nutrition/food + commerce features | **Confidence:** 0.9
- **Verdict:** Confirmed: getLiffUser (liff-portal.ts:80-81) returns the middleware-verified friendId (liff-auth.ts:96), but line 285 calls getShopifyOrderById which runs `SELECT * FROM shopify_orders WHERE id = ?` (shopify.ts:120-122) with no friend scoping, and the handler never compares order.friend_id to user.friendId — the only friend_id===user.friendId check in the file is at line 1093 for referral self-referral, unrelated. Any authenticated LIFF user can pass another customer's order UUID and have its stored line_items reconstructed into a draft order, exposing that customer's SKUs/quantities and acting on their order record. v4 UUID (shopify.ts:54) bounds but does not eliminate exposure.
- **Fix:** After fetching, enforce ownership and return 404 (not 403) to avoid an existence oracle: `if (order.friend_id !== user.friendId) return c.json({ success:false, error:'Order not found' }, 404);`. Better, add a friend-scoped helper getShopifyOrderByIdForFriend(db, id, friendId) with `AND friend_id = ?` so scoping cannot be forgotten by future callers. Note shopify_orders has no line_account_id column today, so friend_id is the correct ownership boundary here.

#### [security] Public form-submit trusts client-supplied friendId/lineUserId (IDOR + data-integrity)
- **Location:** `apps/worker/src/routes/forms.ts:172-258`
- **Subsystem:** Security / Auth / cross-cutting (SECURITY PRIORITY) | **Confidence:** 0.88
- **Verdict:** Confirmed: route is in auth skip-list (auth.ts:40 regex `^/api/forms/[^/]+/submit$`), reads body.friendId/body.lineUserId with no idToken/ownership check, resolves via getFriendByLineUserId (packages/db friends.ts:58, bare `WHERE line_user_id = ?`), then writes friend metadata (forms.ts:243), adds tag (252), enrolls scenario (257) and pushes a LINE message (261+). Anonymous caller knowing/guessing a friendId(UUID) or lineUserId(U...) performs cross-friend writes, forced automation enrollment, and unsolicited push spam. Genuine IDOR. Side-effects use parameterized .bind() so no SQLi, but the authz hole is real.
- **Fix:** Move the friend-binding path behind liffAuthMiddleware (or inline idToken verify) and derive friendId solely from the verified `sub`, ignoring body.friendId/lineUserId. If anonymous submissions must persist, store them with friendId=null and apply NO friend-side side-effects (metadata write / tag / scenario enroll / push) unless ownership was proven. Add a test that a body-supplied friendId belonging to another friend cannot trigger metadata/tag/scenario/push.

#### [security] OAuth callback does not validate the `shop` parameter against a myshopify.com allowlist (token-exfiltration vector)
- **Location:** `apps/worker/src/routes/shopify-auth.ts:147-218`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.85
- **Verdict:** Confirmed: `shop` (line 147) is used verbatim to build the token-exchange URL `https://${shop}/admin/oauth/access_token` (line 185) and the success HTML (line 242); no `^...\.myshopify\.com$` regex anywhere, and `storedState.store_domain` is SELECTed (162-165) but never compared to `shop`. The sibling cron/sync paths DO guard (shopify.ts:570, shopify-customer-sync.ts:56), so the install path is inconsistently weaker. The HMAC at line 155 signs over `shop`, so a fully-blind external attacker cannot forge an arbitrary host without client_secret — that meaningfully reduces exploitability — but defense-in-depth host validation is standard Shopify OAuth guidance and the token obtained is an offline (effectively permanent) token stored as id='default'. `/auth/*` is auth-excluded (middleware/auth.ts:23) so the endpoint is public.
- **Fix:** Immediately after reading `shop`, reject 400 unless it matches `/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/`, AND assert `shop === storedState.store_domain` before the code exchange (the value is already fetched). Apply the same regex to the `/auth/shopify` start handler (shopify-auth.ts:102) where `shop` is also taken from the query string. Also HTML-escape `shop` in the success page (line 242) to avoid reflected XSS once arbitrary hosts are no longer rejected.

#### [data-integrity] orders/paid member sync is gated by payment-notification check + runs only in waitUntil → first-delivery failure permanently under-counts total_purchase_jpy
- **Location:** `apps/worker/src/routes/shopify-phase2a.ts:439-442, 492-499, 517-544`
- **Subsystem:** Shopify orders → membership (recent, real traffic) | **Confidence:** 0.85
- **Verdict:** Confirmed by reading the handler: line 439-442 early-returns 'Already notified' when getPaymentNotificationByOrder finds a row; createPaymentNotification (db/shopify-phase2a.ts:339, plain INSERT, no ON CONFLICT) commits synchronously at line 492 BEFORE the member-sync block; syncOrderToMember→addPurchaseEvent runs only inside c.executionCtx.waitUntil at 517-544. The two are gated by different keys. I verified there is NO recovery path: grep shows listUnappliedPurchaseEvents (membership.ts:503) has zero callers in source (only its own def + dist artifacts), and the only cron (membership-promotion-cron.ts) calls promoteMemberIfEligible over existing members rows — it never re-runs syncOrderToMember/addPurchaseEvent and never drains unapplied events. No backfill query selects shopify_orders missing a member_purchase_events row (PR #86 is the shopify_customer_id bridge, not an order replay). So if memberSyncWork fails in waitUntil before any event row is created, Shopify's re-delivery short-circuits at line 440 and the amount is permanently lost from members.total_purchase_jpy. The addPurchaseEvent applied_at CAS retry is unreachable for this case because no row exists to retry.
- **Fix:** Move the addPurchaseEvent/syncOrderToMember call (or at least the event-row INSERT) OUT from behind the 'Already notified' early-return so it always runs and relies on member_purchase_events.shopify_order_id UNIQUE + applied_at CAS for idempotency. Alternatively (or additionally) add a cron that (a) drains listUnappliedPurchaseEvents — currently dead code — AND (b) replays shopify_orders that have no member_purchase_events row at all (LEFT JOIN ... WHERE mpe.id IS NULL). Note the existing applied_at-NULL retry can only recover rows that were created; it cannot recover orders gated out before any row exists.

#### [security] Unsubscribe HMAC token doubles as a permanent re-subscribe credential on a public endpoint
- **Location:** `apps/worker/src/routes/email-unsubscribe.ts:315-330`
- **Subsystem:** Email channel (Resend) | **Confidence:** 0.85
- **Verdict:** Confirmed: POST /email/resubscribe is auth-exempt (auth.ts:27) and authenticates only via verifyUnsubscribeToken = constantTimeEqual(HMAC(key, subscriberId), token) (email-unsubscribe.ts:96-97). The identical token is HMAC(key, subscriberId) with NO expiry and NO action binding (renderer.ts:62-65), embedded in the List-Unsubscribe header of every marketing email (channel-dispatcher.ts:297). So the same emailed credential gates both opt-OUT (/email/unsubscribe, line 296) and opt-IN re-activation (/email/resubscribe, line 328) — a consent-integrity / 特定電子メール法 opt-out-violation hole.
- **Fix:** Bind the signed payload to the action and add expiry: sign over `${subscriberId}:unsub` vs `${subscriberId}:resub:${expiresAt}` with distinct semantics, OR drop the public /email/resubscribe entirely and only re-subscribe via the authenticated admin PATCH or the existing action-specific, time-boxed opt-in flow (performEmailOptIn using EMAIL_OPTIN_HMAC_KEY). Note for the author: the GET unsubscribe page itself does not LEAK the token to third parties (the visitor must already hold it in the URL) — the real defect is the shared, non-expiring, action-agnostic credential plus the unauthenticated state-changing endpoint, not page disclosure.

#### [bug] Reorder product-picker sends product ID into the variantId field (broken checkout)
- **Location:** `apps/worker/src/client/reorder.ts:892-895`
- **Subsystem:** Coaching/nutrition/food + commerce features | **Confidence:** 0.85
- **Verdict:** Confirmed: submitCartOrder (reorder.ts:885-895) maps `variantId: item.product.shopifyProductId` — a Shopify PRODUCT id. The Product interface (reorder.ts:40-49) carries shopifyProductId/handle but no variant id, so no variant data is ever fetched for this path. Server (liff-portal.ts:295-301) wraps the non-gid value as `gid://shopify/ProductVariant/<productId>` then strips it back to a bare variant_id (lines 322-325) posted to the Draft Orders API. A product id is not a variant id, so Shopify will reject or mis-resolve the draft order. The past-order path (liff-portal.ts:288-294) is unaffected because it reads real variant_id values from stored line_items.
- **Fix:** Return the default/selected ProductVariant id in the Product payload from GET/POST /api/liff/reorder and send that as variantId; or change the product-picker create branch to accept productId and resolve the variant server-side via Shopify before building the draft order. Add an integration test asserting the cart path posts a real ProductVariant gid (not a Product id).

#### [security] /auth/callback trusts unverified `uid` param to link a friend to an arbitrary user account (account-takeover primitive)
- **Location:** `apps/worker/src/routes/liff.ts:291-313`
- **Subsystem:** LIFF pages/portal (huge files, user-facing) | **Confidence:** 0.82
- **Verdict:** Confirmed: /auth/line reads uid from an unauthenticated query param (liff.ts:45), packs it into OAuth state (liff.ts:87), /auth/callback decodes it to uidParam (liff.ts:185), and for an unlinked freshly-verified friend sets userId=uidParam (liff.ts:292-293) then linkFriendToUser(db, friend.id, uidParam) → UPDATE friends SET user_id=? (users.ts:136). No check that the verified LINE identity owns/may-merge with that user UUID. user_id is the aggregation key for friends/orders/member data (getUserFriends users.ts:146), so an attacker who learns a victim's user_id (via the finding-1 IDOR) can bind their own LINE account to the victim's user record. Note /api/liff/link does NOT have this hole — it only links by verified email or creates a new user; the declared body.existingUuid is never used. The defect is isolated to /auth/callback.
- **Fix:** Treat cross-account linking as privileged: require a signed, short-lived linking token issued to an already-authenticated session of the target user, not a raw UUID in a URL/state. Validate the uid corresponds to a user the verified LINE identity is allowed to merge with (e.g. matching verified email). Fix alongside the profile IDOR so user_id UUIDs are not externally discoverable.

#### [data-integrity] resubscribeById re-activates bounce-/complaint-suppressed subscribers with no guard
- **Location:** `packages/db/src/email-subscribers.ts:219-234`
- **Subsystem:** Email channel (Resend) | **Confidence:** 0.82
- **Verdict:** Confirmed: resubscribeById (email-subscribers.ts:219-234) runs UPDATE ... SET is_active=1, unsubscribed_at=NULL WHERE id=? with no complaint_count/bounce_count check. recordComplaint sets is_active=0 on the first complaint (line 167-189). resubscribeById is reachable from the auth-exempt public /email/resubscribe (email-unsubscribe.ts:328) AND admin PATCH /api/admin/email/subscribers/:id (email-admin.ts:330), so a prior spam-complainer or 3x-bouncer can be silently re-enabled for marketing — a deliverability/sender-reputation and compliance hazard. performEmailOptIn deliberately surfaces hadComplaint; resubscribeById bypasses it.
- **Fix:** Refuse reactivation when complaint_count > 0 (or require an explicit, audited force flag); for bounce_count >= BOUNCE_THRESHOLD reset only on a deliberate, logged admin action. At minimum return a distinct outcome so callers can warn, mirroring performEmailOptIn's hadComplaint signal. Fixing the public-endpoint exposure (related finding #1) also reduces blast radius.

#### [bug] One malformed automation row aborts all remaining automations for the event
- **Location:** `apps/worker/src/services/event-bus.ts:211-251`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.8
- **Verdict:** Confirmed: event-bus.ts:219-220 calls JSON.parse(automation.conditions) and JSON.parse(automation.actions) inside the for-loop, but the only try/catch wraps the whole function (L211/L248). A single row with malformed JSON throws, abandons the loop, and silently skips every later automation for the event with no automation_log written for the skipped ones. Note the per-action body IS individually wrapped (L228-235), but the two JSON.parse calls at L219-220 are not. Likelihood is moderate (conditions/actions are normally machine-serialized via JSON.stringify in createAutomation/updateAutomation), but updateAutomation accepts raw body so a bad edit or double-encoded value can corrupt a row — the 'abort all remaining' blast radius justifies HIGH.
- **Fix:** Move the per-automation body (both JSON.parse calls + matchConditions + action loop + createAutomationLog) into its own try/catch inside the for-loop so a bad row is logged with status 'failed' and skipped without aborting the rest. Add zod/JSON validation of conditions/actions at write time in routes/automations.ts (POST and PUT) as defense in depth.

#### [data-integrity] Step delivery has no atomic claim — overlapping cron runs re-send the same step
- **Location:** `apps/worker/src/services/step-delivery.ts:113-128, 230-244`
- **Subsystem:** Broadcasts + step/monthly delivery | **Confidence:** 0.8
- **Verdict:** Confirmed: getFriendScenariosDueForDelivery (scenarios.ts:386-396) selects WHERE status='active' AND next_delivery_at IS NOT NULL then JS-filters; advanceFriendScenario (scenarios.ts:399-416) runs ONLY after pushMessage (step-delivery.ts:286 send, then :240 advance). No row claim/CAS between select and send, and schema.sql:178-187 shows friend_scenarios has no in_flight/claimed_at column. Cloudflare does NOT guarantee non-overlapping scheduled invocations, so a tick that runs >5min (the next */5 tick re-selects the same still-active, still-past rows) double-sends. Per-row sleep is only addJitter(50,200)=50-250ms, so overlap needs a large backlog, but the structural lack of idempotency-on-retry is real and grows with the 5k-friend target.
- **Fix:** Atomically claim each due scenario before sending: UPDATE friend_scenarios SET next_delivery_at = <claimed marker/future>, updated_at=? WHERE id=? AND next_delivery_at = <observed value>, and proceed only if .meta.changes===1. Alternatively gate the whole step-delivery job behind a short KV/D1 lock so two scheduled invocations cannot process the same due-set. A CAS on current_step_order also works. This is the same atomic-claim pattern the project already adopted for D1 counters (PR #89).

#### [workers-trap] Cron fans out per account token but step/broadcast queries are global → duplicate sends across accounts
- **Location:** `apps/worker/src/index.ts:371-377`
- **Subsystem:** Broadcasts + step/monthly delivery | **Confidence:** 0.7
- **Verdict:** Mechanism confirmed: index.ts:371 loops `for (const token of activeTokens)` (a Set seeded with env.LINE_CHANNEL_ACCESS_TOKEN plus every active line_accounts.channel_access_token) and calls processStepDeliveries / processScheduledBroadcasts once per token; both callees query globally (scenarios.ts:386 no line_account_id; getBroadcasts broadcasts.ts:32-37 SELECT * with no filter). With ≥2 distinct active tokens every due scenario/broadcast is sent N times via the wrong sender. CAVEAT 1: activeTokens is a Set, so if the naturism DB-account token equals the env secret, N=1 and there is no fan-out today (latent until account #2 '健康エクスプレス' is added, which the roadmap confirms). CAVEAT 2 (factual error in finding): friend_scenarios has NO line_account_id column (schema.sql:178-187 — only friends.line_account_id at :21 and broadcasts.line_account_id at :213), so the recommended scenario-query filter must join through friends.line_account_id, not a direct column.
- **Fix:** Thread lineAccountId into processStepDeliveries/processScheduledBroadcasts and scope the due-set: for broadcasts filter broadcasts.line_account_id = ? (column exists); for step delivery JOIN friend_scenarios→friends and filter friends.line_account_id = ? (friend_scenarios has no own column — a migration adding one is an alternative). Decide an explicit owner account for broadcasts with line_account_id IS NULL. Until then, the single-account Set dedup is the only thing preventing dup sends.

### MEDIUM (29)

#### [maintainability] handleEvent is a ~1066-line function inside a 1220-line file (far over size/nesting limits)
- **Location:** `apps/worker/src/routes/webhook.ts:152-1218`
- **Subsystem:** Webhook + Event Bus (entry point) | **Confidence:** 0.95
- **Verdict:** Verified by reading file: wc -l = 1220 (repo limit 800); handleEvent opens at line 152 and closes at line 1218 (~1066 lines vs <50 guideline). Single function mixes follow/unfollow/postback/text(auto-reply+time-setting+cross-account+3 AI guards+intent+fallback)/image pipeline with large inline Flex JSON blobs and nesting well past 4 levels.
- **Fix:** Extract per-event-type handlers (handleFollow, handleUnfollow, handlePostback, handleTextMessage, handleImageMessage) into separate modules and move inline Flex builders to a builders file. This brings webhook.ts under 800 lines and isolates each branch for unit testing. Pure refactor — keep behavior identical and rely on existing webhook.test.ts/webhook-image.test.ts as a regression net.

#### [maintainability] Oversized files and a ~2250-line render function exceed the repo's 800-line / 50-line limits
- **Location:** `apps/worker/src/routes/liff-pages.ts:27-2277`
- **Subsystem:** LIFF pages/portal (huge files, user-facing) | **Confidence:** 0.92
- **Verdict:** Confirmed by line count: liff-pages.ts = 2279 lines, liff-portal.ts = 2407, packages/db/src/liff-portal.ts = 1357 (finding said 1207, but still well over the 800 cap). portalPage() is a single template-literal SPA starting at line 27 spanning nearly the whole file. The embedded-JS-in-template-literal style gets no type-checking/linting/tests and is exposed to the documented esbuild backtick trap. Real violation of the repo's own <800-line file / <50-line function rules.
- **Fix:** Extract the client SPA(s) into separate static .js assets via a bundler, or at minimum split the page builders into per-section helpers and move shared logic to real .ts modules to restore type-checking/linting/tests. Lower priority than the two auth findings.

#### [data-integrity] friend_scenarios has no UNIQUE(friend_id, scenario_id) and enroll performs no dedup → duplicate enrollments cause repeated step messages
- **Location:** `packages/db/src/scenarios.ts:325-378`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.9
- **Verdict:** Partially confirmed with a corrected cause: enrollFriendInScenario (scenarios.ts:366) always INSERTs with no existence check and schema.sql:178-191 has NO UNIQUE on (friend_id,scenario_id) and no migration adds one (verified). HOWEVER the finding's headline cause is WRONG — both friend_add paths ARE dedup-guarded (webhook.ts:229-248 SELECT...WHERE friend_id=? AND scenario_id=? + if(!existing), and liff.ts:426-430), as is tag_added (friends.ts:292-298). Real duplicate risk remains only on the UN-guarded callers: start_scenario automation action (event-bus.ts:306), form submit (forms.ts:257), tracked-link click (tracked-links.ts:288), and manual enroll (scenarios.ts:400). Downgraded HIGH→MEDIUM because the highest-volume automatic trigger is already guarded and remaining paths are lower-frequency.
- **Fix:** Centralize the dedup that webhook.ts/liff.ts/friends.ts already duplicate by moving it INTO enrollFriendInScenario: SELECT an existing active/paused (friend_id,scenario_id) row and return it instead of inserting, OR add a partial UNIQUE index and INSERT...ON CONFLICT DO NOTHING. Backfill/dedup existing active rows before adding the constraint. This also closes the un-guarded automation/form/tracked-link/manual paths.

#### [bug] Nonsensical JOIN compares product id to customer id in product auto-notify query
- **Location:** `apps/worker/src/routes/shopify-products.ts:263-271`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.9
- **Verdict:** Confirmed at lines 267 (`JOIN shopify_products sp ON sp.shopify_product_id = so.shopify_customer_id`) and 280 (fallback `ORDER BY f.updated_at DESC LIMIT 0`). Schema confirms these are disjoint ID spaces: shopify_products.shopify_product_id is a product identifier (schema.sql:1002) while shopify_orders.shopify_customer_id is a customer identifier (schema.sql:757) — the equality is never meaningful, so the recipient set is essentially always empty/garbage, and the fallback's LIMIT 0 guarantees zero rows. The intent ('friends who bought this product_type') is not expressed. Latent because this handler is unreachable (see duplicate-route finding); MEDIUM rather than HIGH for that reason.
- **Fix:** If the handler is deleted per the duplicate-route fix, this resolves itself. If kept/ported, target by product_type via shopify_orders.line_items (JSON) or a normalized line-items table, and change the fallback LIMIT 0 to a real cap (e.g. LIMIT 50).

#### [security] CORS policy reflects any Origin (effectively Access-Control-Allow-Origin: *)
- **Location:** `apps/worker/src/index.ts:168-180`
- **Subsystem:** Security / Auth / cross-cutting (SECURITY PRIORITY) | **Confidence:** 0.9
- **Verdict:** Confirmed at index.ts:178 the origin callback does `return origin;` for every non-allowlisted origin, making the 4-entry allowlist (170-175) dead code and reflecting any Origin into ACAO. Single global cors() at 168; verified no `credentials:true` is set anywhere (Hono defaults to NOT emitting Access-Control-Allow-Credentials), and auth is Bearer-token in JS storage (not cookies), so no ambient-credential CSRF read. Real defect but impact is bounded to reading responses where the page can already supply a token, plus loss of intended origin restriction — MEDIUM, not HIGH.
- **Fix:** Return undefined from the origin callback for non-allowlisted origins so Hono omits the ACAO header on API routes. If R2/public GET assets need wildcard CORS, scope a separate `app.use('/images/*', cors({ origin: '*' }))` and keep the strict allowlist on everything else. Keep credentials unset/false. Add a test asserting an evil origin gets no ACAO header.

#### [test-gap] Fallback AI responses are never written to conversation_logs (silent provider-failure blind spot)
- **Location:** `apps/worker/src/services/ai-response.ts:274-309`
- **Subsystem:** AI auto-reply + provider abstraction | **Confidence:** 0.85
- **Verdict:** Confirmed: insertConversationLog is called only inside the `if (result.text)` branch (ai-response.ts:278). The two fallback returns at :304 and :308 (layer='fallback') write nothing. insertConversationLog's aiLayer param already accepts 'fallback' and aiModel is optional, so the omission is accidental. A sustained provider outage degrading every user to FALLBACK_MESSAGE produces zero conversation_logs rows — only scattered console.error — exactly the silent-fallback failure mode the team documented (feedback_ai_model_silent_fallback).
- **Fix:** Best-effort log the empty/error outcomes too with aiLayer='fallback', aiModel=null, using the same .catch() pattern already at :288. Then a provider outage is queryable as a spike in fallback rows. Keep it best-effort so logging failure never breaks the user reply.

#### [performance] N+1 queries over an unbounded set in the reminder delivery cron
- **Location:** `packages/db/src/reminders.ts:123-153`
- **Subsystem:** DB layer + migrations + schema integrity | **Confidence:** 0.85
- **Verdict:** Confirmed by reading reminders.ts:125-152. getDueReminderDeliveries fetches ALL active friend_reminders via a JOIN with no LIMIT (125-129), then for each row calls getReminderSteps (133) and a per-row friend_reminder_deliveries SELECT (135-138) = 1+2N queries, executed inside the 5-minute scheduled handler. Genuine N+1 over an unbounded set that scales with the friend base and can exhaust Workers subrequest/CPU budget. Today N is small (naturism), so MEDIUM not HIGH.
- **Fix:** Collect distinct reminder_ids and friend_reminder_ids from the first query, then fetch all steps and all deliveries in two IN(...)-batched queries and join in memory. Add a bounded LIMIT/batch size to the outer query so one cron tick processes a capped number of reminders, and page across ticks if needed.

#### [bug] Dashboard "LINE で体験する" CTA hardcodes a wrong/stale Worker hostname
- **Location:** `apps/web/src/app/page.tsx:156`
- **Subsystem:** Admin web (Next.js 15) | **Confidence:** 0.85
- **Verdict:** Confirmed at page.tsx:156: href="https://line-crm-worker.line-crm-api.workers.dev/auth/line?ref=dashboard" — a hardcoded host found nowhere else in apps/web (grep) and distinct from both NEXT_PUBLIC_API_URL (used by api.ts/affiliates/login) and the documented prod worker naturism-line-crm.katsu-7d5.workers.dev. The friend-add CTA on the dashboard home will route to a foreign/likely-dead worker.
- **Fix:** Replace the hardcoded host. Since the page already imports `api`, derive from the API base or expose a single `API_URL` const from lib/api and use `${API_URL}/auth/line?ref=dashboard` (better: the public LINE add-friend / LIFF URL). Verify the host resolves to the naturism worker before next deploy. Downgraded from HIGH to MEDIUM: this is an isolated static link in a labeled demo banner; it degrades to a dead link rather than breaking the app, but it is genuinely user-facing and points at the wrong/old project.

#### [maintainability] fetchApi throws away the server's structured error message
- **Location:** `apps/web/src/lib/api.ts:82-92`
- **Subsystem:** Admin web (Next.js 15) | **Confidence:** 0.85
- **Verdict:** Confirmed at api.ts:91: `if (!res.ok) throw new Error(`API error: ${res.status}`)` with no body parse, while the worker returns {success:false,error:'...'}. Contrast uploadImage (api.ts:720-733) which parses data.error and even surfaces diagnostic steps. The ~25 callers using the shared `api` wrapper can only show generic Japanese fallbacks on HTTP errors.
- **Fix:** On `!res.ok`, do `const body = await res.json().catch(() => null)` and `throw new Error(body?.error || `API error: ${res.status}`)`. Keeps the status fallback for non-JSON/network errors and lets all callers surface the real reason, matching the richer uploadImage path already in this file.

#### [bug] X (Twitter) conversion API called without required OAuth 1.0a signature
- **Location:** `apps/worker/src/services/ad-conversion.ts:146-158`
- **Subsystem:** Coaching/nutrition/food + commerce features | **Confidence:** 0.85
- **Verdict:** Confirmed: sendXConversion (ad-conversion.ts:146-158) POSTs to https://ads-api.x.com/12/measurement/conversions with only a Content-Type header and a literal comment 'OAuth 1.0a signature required — placeholder for production implementation'. The X Ads API mandates OAuth 1.0a, so every call will 401. It fails safe — the surrounding try/catch (lines 69-79) records status='failed' via logAdConversion — but the 'x' branch is silently non-functional and only ever accumulates failed rows with a generic API-error message.
- **Fix:** Either implement OAuth 1.0a signing for the X endpoint, or gate the 'x' platform branch behind a feature flag / mark it unsupported so it stops silently accumulating failed logs. At minimum log a distinct errorMessage ('x integration not implemented') so operators can distinguish 'never finished' from a transient API failure. The other three platforms (meta/google/tiktok) do send real auth headers, so this gap is X-specific.

#### [data-integrity] Webhook events are processed without idempotency (LINE redelivery / webhookEventId ignored)
- **Location:** `apps/worker/src/routes/webhook.ts:137-149`
- **Subsystem:** Webhook + Event Bus (entry point) | **Confidence:** 0.8
- **Verdict:** Confirmed: grep shows webhookEventId/isRedelivery appear ONLY in test files, never in handleEvent; no processed-events/dedup table exists in packages/db. Text path unconditionally INSERTs messages_log (line 541) and food-image path inserts a fresh food_logs row (line 947); follow path does guard enrollment (if(!existing) line 248) and reminder (if(!existingReminder) line 308) as described.
- **Fix:** Add an idempotency guard keyed on event.webhookEventId (KV with TTL, or a small processed_events table with ON CONFLICT DO NOTHING) and short-circuit handleEvent on a repeat. At minimum gate the side-effecting message/image INSERTs and AI sends on !event.deliveryContext?.isRedelivery. Note real exposure is conditional: this path returns 200 quickly via waitUntil, so LINE only redelivers on genuine timeout/5xx AND only when per-channel redelivery is enabled — so duplicates are possible but not routine.

#### [workers-trap] Active-broadcast fact context leaks across LINE accounts when lineAccountId is null
- **Location:** `apps/worker/src/services/ai-fact-context.ts:103-123`
- **Subsystem:** AI auto-reply + provider abstraction | **Confidence:** 0.8
- **Verdict:** Confirmed by construction: broadcasts has line_account_id (schema.sql:213) and the scoped SQL branch (ai-fact-context.ts:105) filters on it, but the null branch (:111-117) omits line_account_id entirely, returning ALL tenants' broadcast titles into the per-friend prompt. Caller webhook.ts:878 passes `friendRecord.line_account_id ?? lineAccountId ?? null`, and lineAccountId defaults to null (webhook.ts:157), so both-null IS reachable. Matches trap #8. Blast radius is zero today (single naturism account) and only triggers when BOTH the friend's line_account_id and the resolved routing account are null, but it is a real cross-tenant leak as multi-brand lands.
- **Fix:** When lineAccountId is null, return '' (no broadcast context) instead of querying all tenants — fact context is per-tenant by nature. Or make lineAccountId a required arg of getActiveBroadcastsContext so the unscoped branch cannot exist. Never feed an unscoped multi-tenant query into a per-friend prompt.

#### [data-integrity] Form submission merges arbitrary, non-allowlisted keys into friends.metadata
- **Location:** `apps/worker/src/routes/forms.ts:189-209`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.8
- **Verdict:** Confirmed: required-field validation (forms.ts:199-209) only checks declared required fields are present; it never restricts submissionData to the form's field.name set. When save_to_metadata is on, forms.ts:241 does `const merged = { ...existing, ...submissionData }` with no projection, so any key (including preferred_hour, which step-delivery.ts:153 reads to drive the delivery window) can be injected/overwritten. Combined with the unauthenticated /submit (finding #1) this is a real metadata-poisoning vector affecting segmentation and delivery scheduling.
- **Fix:** Before merging, project submissionData onto the declared field.name set (drop unknown keys) and namespace answers under a sub-object (e.g. metadata.form_<id>) rather than spreading into top-level metadata that drives delivery/segmentation. Primary fix is still authenticating /submit (finding #1).

#### [bug] Manual /api/integrations/shopify/sync fetches only the first page (no pagination)
- **Location:** `apps/worker/src/routes/shopify.ts:560-709`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.8
- **Verdict:** Confirmed: products.json (line 582, no limit → Shopify default 50, single request), orders.json?status=any&limit=50 (line 629), and customers.json?limit=250 (line 669) are each fetched once with no Link rel=next loop, unlike syncShopifyCustomers which follows parseNextUrl up to 50 pages (shopify-customer-sync.ts:71-127). The endpoint returns productsSynced/ordersSynced/customersSynced and success:true regardless, so a store exceeding those counts silently gets a partial import reported as a full reconciliation.
- **Fix:** Reuse the exported parseNextUrl() Link-following loop for all three resources (add limit=250 to products and orders), or at minimum surface a `truncated`/`cap` flag in the response so a partial sync is not mistaken for complete. Watch Workers CPU limits if iterating many pages synchronously.

#### [data-integrity] Delivery crons ignore line_account_id and run once per active token → cross-account duplicate/mis-routed pushes
- **Location:** `apps/worker/src/index.ts:371-403`
- **Subsystem:** Cron scheduler + monitors | **Confidence:** 0.8
- **Verdict:** Confirmed: index.ts:371-403 loops `for (const token of activeTokens)` building per-token LineClients and runs processReminderDeliveries/processWeeklyReports/processScheduledBroadcasts/processTagElapsedDeliveries/processSubscriptionReminders, none of which scope by account (getDueReminderDeliveries reminders.ts:126-128 has no account predicate; weekly-report.ts:39-43 `FROM friends WHERE is_following=1` has none; subscription-reminder.ts:136-139 has none). With ≥2 active accounts each due item is processed N=token-count times.
- **Fix:** Genuine latent multi-account defect but currently DORMANT for two reasons the finding under-weights: (1) activeTokens is a Set (index.ts:353) so default env token + DB tokens dedup to one entry today; (2) friends.line_user_id is GLOBALLY UNIQUE (schema.sql:9) — a single shared friends pool, not per-account partitions, so today every push routes to the one correct user. Duplicate/mis-route only manifests once a 2nd active account with a distinct token exists. Before enabling account #2: thread account id through each delivery cron, add `AND line_account_id = ?` (legacy NULL via `OR line_account_id IS NULL`), and build each token's job set only for friends it owns. Downgraded HIGH→MEDIUM because it cannot fire in the current single-account deployment; raise to HIGH the moment a 2nd token is activated.

#### [data-integrity] Email case-sensitivity split creates duplicate subscriber rows and silent consent desync
- **Location:** `apps/worker/src/services/email-opt-in.ts:190-208`
- **Subsystem:** Email channel (Resend) | **Confidence:** 0.8
- **Verdict:** Confirmed: the UNIQUE index idx_email_subscribers_email is case-sensitive (migration 042:21,37 — plain TEXT email, no COLLATE NOCASE). Write/lookup paths split: candidate JOIN lowercases (LOWER(es.email)=LOWER(sc.email), email-admin.ts:647) and bulk pre-registration stores recipient.email.trim().toLowerCase() (bulk-opt-in-invitation.ts:119), but performEmailOptIn (email-opt-in.ts:192-193), getEmailSubscriberByEmail (email-subscribers.ts:61), recordMarketingOptIn (email-subscribers.ts:269), the GET opt-in already-opted-in check (email-opt-in.ts:207) and admin generate-url (email-admin.ts:587, only .trim()) all use RAW-case WHERE email = ?. A mixed-case address opting in via admin URL misses the lowercased pre-registered row and INSERTs a second subscriber, leaving the original transactional_only row un-upgraded. Real desync; MEDIUM is apt (data-quality/consent visibility, not direct RCE/leak).
- **Fix:** Introduce a single normalizeEmail() (trim + toLowerCase) applied at every email_subscribers write/lookup boundary (upsertEmailSubscriber, recordMarketingOptIn, getEmailSubscriberByEmail, performEmailOptIn before-state SELECT, GET opt-in check, admin generate-url/add), and/or add COLLATE NOCASE to the email column + unique index via migration. Backfill-dedupe existing mixed-case rows before any campaign.

#### [workers-trap] members and member_purchase_events have no line_account_id — order→member sync is single-tenant only
- **Location:** `packages/db/migrations/058_membership_tiers.sql:50-61`
- **Subsystem:** Shopify orders → membership (recent, real traffic) | **Confidence:** 0.78
- **Verdict:** Confirmed: migration 058 members (50-61) and membership_tiers (29-41) and migration 059 member_purchase_events have zero line_account_id columns (grep count = 0). resolveFriendForOrder (shopify-order-member-sync.ts:55-105) resolves friends purely by shopify_customer_id / users.email COLLATE NOCASE / users.phone with no account scoping, and the payment-webhook inline friend match (shopify-phase2a.ts:467-489) likewise. friends DOES carry line_account_id (schema.sql:21) but it is never used in any resolve query. Migration 060 even adds a GLOBALLY UNIQUE index on friends(shopify_customer_id) (not scoped by account), so one Shopify customer maps to exactly one friend across all tenants. Not a live leak (single naturism account today), but once '健康エクスプレス' is added, an order under account A matching a friend under account B mis-attributes revenue/tier, and membership_tiers is shared across brands. Severity MEDIUM is appropriate: latent, schema-baked, no current exploit.
- **Fix:** Before onboarding the second LINE account: add line_account_id to members / member_purchase_events / membership_tiers, include it in every resolve/upsert/promote query and in the friend-match SELECTs (scope to the order's owning account), and make the shopify_customer_id uniqueness per-account. Until then, document the single-tenant assumption at the top of shopify-order-member-sync.ts and the migrations so the multi-account rollout doesn't silently mis-attribute revenue.

#### [data-integrity] Birthday & membership-sanity crons query all friends but push with the single env token, ignoring friend.line_account_id
- **Location:** `apps/worker/src/services/birthday-cron.ts:94-122`
- **Subsystem:** Cron scheduler + monitors | **Confidence:** 0.78
- **Verdict:** Confirmed: birthday-cron.ts:94-103 selects `FROM friends WHERE birth_month=? AND is_following=1 AND is_blacklisted=0` across all accounts (it even SELECTs line_account_id and audits it at line 165), then pushes every row via a single lineClientFactory(env.LINE_CHANNEL_ACCESS_TOKEN) at line 122. membership-promotion-cron.ts:88 `SELECT friend_id FROM members` is likewise account-unscoped.
- **Fix:** Real oversight (selecting+auditing line_account_id while not filtering on it is a clear tell) but DORMANT: with a single active account and a globally-unique line_user_id pool (schema.sql:9) the env token correctly addresses every friend today. The membership cron does NO LINE push (only promoteMemberIfEligible), so its sole multi-account risk is processing other accounts' members — low impact. Downgraded HIGH→MEDIUM. Fix before account #2: filter the birthday candidate query by line_account_id and iterate per active account with the matching token; scope members similarly.

#### [data-integrity] Webhook status can regress on out-of-order events (clicked -> delivered)
- **Location:** `packages/db/src/email-logs.ts:164-198`
- **Subsystem:** Email channel (Resend) | **Confidence:** 0.78
- **Verdict:** Confirmed: updateEmailLogStatus builds updates starting with unconditional 'status = ?' (email-logs.ts:172, no rank/monotonicity guard). integrations-resend.ts maps each Resend event to a fixed newStatus independently (delivered/opened/clicked/bounced/complained, lines 108-176) and Svix/Resend do not guarantee ordering, so a delivered/opened event arriving after clicked regresses the status column that GET /api/admin/email/messages?status= filters on. Counters (open_count/click_count) are correctly atomic and delivered_at/first_opened_at are first-write-only, so impact is confined to the single status column (display/KPI), hence MEDIUM.
- **Fix:** Apply a status rank and only advance, never regress: SET status = CASE WHEN <rank(newStatus)> > <rank(current status)> THEN ? ELSE status END, treating bounced/complained/failed as terminal. Leave counters/timestamps as-is. Add an out-of-order unit test (clicked then delivered).

#### [bug] Failed scheduled broadcast resets to 'draft' and is never retried by cron
- **Location:** `apps/worker/src/services/broadcast.ts:67-81, 517-522`
- **Subsystem:** Broadcasts + step/monthly delivery | **Confidence:** 0.75
- **Verdict:** Confirmed: processBroadcastSend catch sets status='draft' (broadcast.ts:69) with the comment 'so it can be retried', but processScheduledBroadcasts only re-selects b.status==='scheduled' (broadcast.ts:519). A scheduled broadcast that throws mid-send becomes a stuck 'draft' the cron never re-attempts — only a manual admin /send re-triggers it. The retry comment is misleading. Sub-claim partially inaccurate: LINE tag sends DO write per-friend rows to messages_log keyed by broadcast_id (broadcast.ts:170-174), but that log is not consulted on retry (only the email path uses loadSentSubscriberIdsForBroadcast at :247), so a manual retry of a tag broadcast does re-send to everyone.
- **Fix:** Keep a failed scheduled broadcast in a cron-retryable state with a bounded attempt counter (e.g. a 'failed' status retried with backoff, or back to 'scheduled') instead of silent 'draft', or surface the stuck draft to an operator. For LINE tag retries, consult the existing messages_log rows (broadcast_id keyed) to skip already-sent friends, mirroring the email loadSentSubscriberIdsForBroadcast dedup.

#### [data-integrity] Blacklist (is_blacklisted) not honored on tag/all broadcast and step delivery
- **Location:** `apps/worker/src/services/broadcast.ts:137-139, 228-239`
- **Subsystem:** Broadcasts + step/monthly delivery | **Confidence:** 0.72
- **Verdict:** Confirmed inconsistency: segment-query.ts:206 applies COALESCE(f.is_blacklisted,0)=0, but getFriendsByTag (tags.ts:104-115) has no blacklist predicate, resolveFollowingFriends 'all' queries (broadcast.ts:230 and :237) have no blacklist filter, and step delivery only checks friend.is_following (step-delivery.ts:146) — the Friend interface (friends.ts:2-14) does not even expose is_blacklisted though the column exists (schema.sql:26). So a blacklisted friend still receives tag broadcasts (LINE+email) and scenario steps. Note: target_type='all' LINE path uses LINE's broadcast API (sends to all followers server-side, cannot filter blacklist there); the gap there is only the 'all' email path. Tag and step paths are the genuine gaps.
- **Fix:** Add COALESCE(is_blacklisted,0)=0 to getFriendsByTag and to both resolveFollowingFriends 'all' queries, and read+check is_blacklisted in processSingleDelivery (add the field to the Friend interface so it is not silently dropped). Document that the LINE 'all'-broadcast path cannot honor blacklist client-side.

#### [data-integrity] Friend email matching is case-sensitive exact compare — Shopify casing differences cause silent match misses
- **Location:** `apps/worker/src/routes/shopify.ts:74-84`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.7
- **Verdict:** Confirmed: findFriendAndBackfill queries `WHERE email = ?` with the raw Shopify email (line 76) while phone IS normalized (line 87). users.email has no DB-level lowercasing (schema.sql:270, plain index line 278) and no write-path toLowerCase was found. A sibling Shopify→member matcher already compares case-insensitively (shopify-order-member-sync.test.ts:66 `(u.email ?? '').toLowerCase() === ...`), confirming the inconsistency. A casing mismatch silently prevents friend linkage, tagging, and purchase_completed/re-purchase enrollment — exactly the 'matching 0件' class the comment block at lines 43-56 was added to address. SQLite '=' on TEXT is case-sensitive by default.
- **Fix:** Match with `WHERE email = LOWER(?)` AND store users.email lowercased on every write path (LIFF login, backfill at shopify.ts:110, etc.), or add a generated/lowercased column with an index. Apply consistently wherever users/shopify_customers are matched by email so the index stays usable.

#### [workers-trap] weekly-report pushes up to 5000 friends sequentially in one cron invocation → Workers subrequest/duration limit
- **Location:** `apps/worker/src/services/weekly-report.ts:37-109`
- **Subsystem:** Cron scheduler + monitors | **Confidence:** 0.7
- **Verdict:** Confirmed: weekly-report.ts:37-43 `LIMIT 5000` then a single sequential `for` loop (65-109) doing getIntakeStreak + getHealthSummary + pushMessage + INSERT (~4 subrequests/friend) plus sleep per friend. No batching/cursor. The content-LIKE dedup Set (48-59) lets a later Monday tick resume, but a single invocation hitting the ~1000-subrequest cap aborts mid-run.
- **Fix:** Real Workers-scale risk. Evidence correction: sleep is addJitter(50,200) not 50-250 (line 84), and the streak/health-empty branch (77-80) skips the 2 heavy subrequests for inactive friends, so per-friend cost is lower than worst case — at naturism's ~1,891 friends (mostly inactive) it likely survives today, hence MEDIUM not HIGH. Fix: SELECT only friends not yet sent this week (LIMIT 200-500) using the existing content-LIKE dedup as cursor so the send drains across several Monday ticks; consider LINE multicast to cut subrequests.

#### [performance] Unbounded list SELECTs without LIMIT on traffic-growing tables
- **Location:** `packages/db/src/chats.ts:87`
- **Subsystem:** DB layer + migrations + schema integrity | **Confidence:** 0.7
- **Verdict:** Confirmed: getChats (chats.ts:87 'SELECT * FROM chats ORDER BY last_message_at DESC'), getUsers (users.ts:56-61 'SELECT * FROM users ORDER BY created_at DESC'), and getCalendarBookings (calendar.ts:70 'SELECT * FROM calendar_bookings ORDER BY start_at ASC') all lack LIMIT/OFFSET on their unfiltered branch. The paginated comparison is accurate (shopify.ts:99/107/114/228/236/243 use LIMIT ? OFFSET ?). These tables grow with end-user activity (chats/bookings) so loading the full table into the isolate risks memory/latency and eventually the D1 response-size cap. Latent at current scale, hence not HIGH.
- **Fix:** Add LIMIT/OFFSET (or keyset) pagination to getChats, getUsers, and getCalendarBookings matching the shopify.ts pattern (default ~100), and thread limit/offset from the callers. Prioritize getChats (agent inbox) and getCalendarBookings.

#### [data-integrity] Scheduled-broadcast 'sending' status is not a concurrency guard against overlapping cron
- **Location:** `apps/worker/src/services/broadcast.ts:33-41, 508-526`
- **Subsystem:** Broadcasts + step/monthly delivery | **Confidence:** 0.66
- **Verdict:** Confirmed: processScheduledBroadcasts filters b.status==='scheduled' (broadcast.ts:519) then awaits processBroadcastSend, whose first action is updateBroadcastStatus(db,id,'sending') (broadcast.ts:41) — an unconditional UPDATE broadcasts SET status=... WHERE id=? (broadcasts.ts:198-201) with no WHERE status='scheduled' guard / changes check. The select-then-flip is not atomic, so two concurrent invocations (overlapping cron, or the per-token fan-out) can both observe 'scheduled' and double-send an all/tag broadcast. Same overlap precondition as finding #1.
- **Fix:** Claim atomically: UPDATE broadcasts SET status='sending' WHERE id=? AND status='scheduled', then proceed only if meta.changes===1 (skip otherwise). Combined with per-account line_account_id scoping this prevents double-send under overlapping or fanned-out cron invocations.

#### [performance] Unbounded in-memory load of all active scenarios / all broadcasts each cron tick
- **Location:** `packages/db/src/scenarios.ts:380-397`
- **Subsystem:** Broadcasts + step/monthly delivery | **Confidence:** 0.65
- **Verdict:** Confirmed: getFriendScenariosDueForDelivery (scenarios.ts:386-392) does SELECT * FROM friend_scenarios WHERE status='active' AND next_delivery_at IS NOT NULL with no LIMIT/time-upper-bound, then .filter/.sort in JS; getBroadcasts (broadcasts.ts:33-35) does SELECT * FROM broadcasts ORDER BY created_at DESC (full table) consumed every 5min by processScheduledBroadcasts. Both run once per active token (compounds with the fan-out finding). Real but currently low-impact at present volume; grows toward the 5k-friend target on a 128MB isolate.
- **Fix:** Push the due-time predicate into SQL (WHERE next_delivery_at <= ? with both Z and +09:00 formats normalized at write time, plus LIMIT batch size and ORDER BY next_delivery_at) and have processScheduledBroadcasts query WHERE status='scheduled' AND scheduled_at <= ? instead of fetching all broadcasts. Add line_account_id scoping in the same change.

#### [bug] Shared EventPayload.replyToken is mutated in place while Phase-2 handlers run concurrently
- **Location:** `apps/worker/src/services/event-bus.ts:330`
- **Subsystem:** Webhook + Event Bus (entry point) | **Confidence:** 0.62
- **Verdict:** Partly confirmed: executeAction does payload.replyToken=undefined (line 330), and the SAME enrichedPayload reference is passed to both processAutomations and processNotifications under Promise.allSettled (lines 115-117); processNotifications serializes it via JSON.stringify(payload) (line 470), so the notification body's replyToken is non-deterministic and the input-mutation violates the repo immutability rule. BUT the finding's claim that the webhook caller's own object is altered is WRONG in the common case: line 104-112 builds enrichedPayload as a fresh spread copy whenever payload.friendId is truthy (true for message_received), so only the internal copy is mutated; the caller object is untouched. Race is real but low-impact (single V8 isolate; only matters at await interleaving).
- **Fix:** Treat payload as immutable: thread a private mutable {replyToken} consumption context through processAutomations/executeAction (or pass replyToken by value and return whether it was consumed) instead of writing onto the shared enrichedPayload. Drop the inaccurate 'caller object altered' phrasing — the spread copy already shields the caller when friendId is set.

#### [workers-trap] Step delivery has no claim/lock; overlapping cron runs can double-send a scenario step
- **Location:** `apps/worker/src/services/step-delivery.ts:102-128`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.6
- **Verdict:** Confirmed: processSingleDelivery sends (sendLineStep/sendEmailStep, L206-228) BEFORE advanceFriendScenario/completeFriendScenario (L240/243) — no atomic claim, no status='sending' flip, no conditional UPDATE guarded by the observed next_delivery_at. getFriendScenariosDueForDelivery (scenarios.ts:386-397) loads ALL active rows with no LIMIT and no line_account scoping, filtering in JS. The scheduled handler (index.ts:371-375) runs processStepDeliveries per active token with no run-level mutex, so an overlapping cron invocation (or Cloudflare scheduled retry) reads the same un-advanced rows and re-sends. Window is real but bounded by the 9-23 JST early-return and per-delivery sleep; MEDIUM is appropriate.
- **Fix:** Claim each due row atomically before sending: UPDATE friend_scenarios SET next_delivery_at=<future sentinel> (or status='sending') WHERE id=? AND next_delivery_at=<observed value>, and only send if meta.changes/rowsAffected===1. Push the epoch filter and a LIMIT into the SQL in getFriendScenariosDueForDelivery, and make advance idempotent (e.g. store last_delivered_step_order).

#### [data-integrity] Payment webhook trusts financial_status and credits members even on non-'paid' / refund-adjacent states
- **Location:** `apps/worker/src/routes/shopify-phase2a.ts:430, 515-534`
- **Subsystem:** Shopify orders → membership (recent, real traffic) | **Confidence:** 0.6
- **Verdict:** Confirmed: financialStatus defaults to 'paid' (line 430) and is only stored in the notification row; the member-sync block (517-534) passes amountJpy: totalPrice ?? 0 with NO check that financialStatus === 'paid'. The handler is bound to orders/paid (comment line 418), so in the normal path orders are paid — this bounds the partially_paid/authorized risk somewhat. The stronger, clearly-real half is refunds: grep confirms there is NO refunds/create or orders/updated handler in this subsystem, total_price is gross, and tiers are non-demoting (membership.ts promoteMemberIfEligible only promotes), so any refund permanently inflates members.total_purchase_jpy and can grant a tier never actually reached. Keeping MEDIUM: real net-spend integrity gap, but mitigated for the common case by the orders/paid binding and low refund volume at launch.
- **Fix:** Gate the member credit on financial_status === 'paid' (skip authorized/partially_paid). Add a refunds/create webhook that records a negative member_purchase_event with its own idempotency key so total_purchase_jpy reflects net spend; since tiers don't demote, at minimum stop crediting refunded gross. This pairs naturally with the recovery-cron fix from finding #1.

### LOW (54)

#### [maintainability] Several page files exceed the 800-line guideline
- **Location:** `apps/web/src/app/email/page.tsx:1-1155`
- **Subsystem:** Admin web (Next.js 15) | **Confidence:** 0.95
- **Verdict:** Confirmed via wc -l: email/page.tsx 1155, rich-menus/page.tsx 1030, chats/page.tsx 1011, conductor/page.tsx 1000, reorder/page.tsx 880, lib/api.ts 1014 — all exceed the repo's 800-line ceiling and mix types+fetch+large JSX.
- **Fix:** Extract presentational sub-components and shared interfaces into their own files (email template editor/subscriber table, rich-menus editor, conductor per-kind previews); split lib/api.ts into per-domain modules re-exported from an index. LOW priority but accurate; tackle opportunistically when touching these files.

#### [maintainability] shopify.ts route file exceeds the 800-line limit and mixes many concerns
- **Location:** `apps/worker/src/routes/shopify.ts:1-821`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.9
- **Verdict:** Confirmed: the file is 821 lines (repo rule: <800) and combines HMAC webhook receiver (138-369), product webhook (373-449), findFriendAndBackfill business logic (64-134), order/customer list+detail endpoints (453-556), a ~150-line manual full-sync (560-709), and webhook register/list (713-819). It also hosts the duplicate product-webhook route. Style/maintainability only.
- **Fix:** Extract into focused modules: shopify-webhook.ts (receiver + HMAC dispatch), shopify-friend-match.ts (findFriendAndBackfill + unit tests), shopify-sync.ts (manual sync), shopify-admin.ts (webhook register/list + order/customer queries). Doing so also naturally resolves the duplicate product-webhook route.

#### [maintainability] monthly-broadcast-postback.ts is 1730 lines — far over the 800-line limit
- **Location:** `apps/worker/src/services/monthly-broadcast-postback.ts:1-1730`
- **Subsystem:** Broadcasts + step/monthly delivery | **Confidence:** 0.9
- **Verdict:** Confirmed: file is 1729 lines (wc -l), ~2.2x the repo's 800-line guideline. Structure matches the finding: a thin parser/dispatcher (parseMonthlyDetailPostback :26, isMonthlyBroadcastPostback :35) plus the bulk being per-month Flex builders (build6JuneIntro :44, build6JuneTipFlex :51, etc.) with repeated header/body/footer box scaffolding. Pure maintainability, no runtime risk.
- **Fix:** Extract the 12 months of Flex content into per-month modules (or a data-driven table consumed by one small renderer) under a content/ directory, leaving monthly-broadcast-postback.ts with just the parser, dispatcher, and handler. Removes the repeated box scaffolding and brings the file under the limit.

#### [bug] package.json `exports.default` resolves to raw TypeScript (./src/index.ts); no `require`/CJS condition
- **Location:** `packages/line-sdk/package.json:8-14`
- **Subsystem:** Core SDK packages | **Confidence:** 0.9
- **Verdict:** Verified line-sdk/package.json:12 and shared/package.json:12 both set `default`:`./src/index.ts` with no `require` condition, while dist/index.js exists for both (confirmed via ls). Any CJS `require('@line-crm/line-sdk')` would load raw .ts and crash; `src` is in `files` and prepublishOnly+MIT license make them publish-oriented. Real metadata defect. Downgraded MEDIUM→LOW because both packages are consumed only internally via `workspace:*` (worker prebuilds dist; bundler uses import/source), so nothing is broken today and neither is actually published yet.
- **Fix:** Point `default` at the built artifact (`./dist/index.js`) and/or add an explicit `require` condition; mirror the public @line-harness/sdk which already uses `require`:`./dist/index.cjs`. If only ESM is intended, drop `src` from `files`. Same one-line fix in shared/package.json:12.

#### [bug] No retry/backoff or Retry-After handling in either SDK HTTP client
- **Location:** `packages/sdk/src/http.ts:40-71`
- **Subsystem:** Core SDK packages | **Confidence:** 0.85
- **Verdict:** Confirmed: http.ts:57 does a single `await fetch` then throws on !res.ok with no loop/backoff; grep for retry|backoff|429|Retry-After across both packages/sdk/src and packages/line-sdk/src returned zero matches. line-sdk client.ts:53 is likewise single-shot. The absence is real. Adjusted MEDIUM→LOW: it is a resilience enhancement, not a correctness defect — current callers (cron insights fetcher, quota monitor) already wrap calls in try/catch and retry on the next 5-min cron tick, so transient 429s self-heal rather than surfacing as hard failures.
- **Fix:** Add opt-out bounded exponential backoff with jitter for retriable statuses (429/502/503/504) honoring Retry-After, capped (~3 attempts) within the request timeout; only auto-retry idempotent GETs to avoid duplicate LINE pushes/broadcasts. Add a unit test for retry-then-success and Retry-After respect.

#### [maintainability] line-quota-monitor only checks the default env token; multi-account quota is unmonitored
- **Location:** `apps/worker/src/index.ts:422-436`
- **Subsystem:** Cron scheduler + monitors | **Confidence:** 0.82
- **Verdict:** Confirmed: index.ts:426 `const defaultClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN)` is the only client passed to checkLineQuota despite activeTokens being enumerated earlier; the inline comment at index.ts:419 explicitly states 'multi-account は次 PR で対応 (= 今は default account のみ check)'.
- **Fix:** Valid and accurately scoped as LOW — explicitly documented as deferred and harmless for the single active account. When multi-account is enabled, iterate active accounts for quota checks (each token has independent monthly quota) and key the audit_logs cooldown per account so one account's alert does not suppress another's. Severity confirmed LOW.

#### [maintainability] buildSystemPrompt is a single 180-line function / ~6KB string literal — maintainability + cost
- **Location:** `apps/worker/src/services/ai-response.ts:43-226`
- **Subsystem:** AI auto-reply + provider abstraction | **Confidence:** 0.8
- **Verdict:** Confirmed: buildSystemPrompt spans ai-response.ts:43-225 (~183 lines), almost entirely a hardcoded naturism knowledge base, violating the repo <50-line function guideline and hardcoding brand content into a service slated to go multi-brand. Price drift risk verified real: Blue ¥2,376/¥6,415 at ai-response.ts:139 are duplicated in ai-message-builder.ts:279 PRICE_ROWS (two sources of truth). Author correctly notes the FMT prefixes use 「」 brackets not backticks, so the esbuild template-literal trap #5 is NOT present here.
- **Fix:** Externalize the brand knowledge base to a per-account config table or a brand-scoped constant module and inject it, making the AI service brand-agnostic. At minimum, derive both buildSystemPrompt prices and buildPriceTableMessage from a single shared PRICE_ROWS source to prevent silent price drift.

#### [security] OAuth HMAC verified with non-constant-time string comparison (timing side-channel)
- **Location:** `apps/worker/src/routes/shopify-auth.ts:76`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.8
- **Verdict:** Confirmed: verifyOAuthHmac does `return computed === hmac` (line 76), a short-circuiting hex-string compare, whereas the webhook path deliberately uses crypto.subtle.verify which the util comments as constant-time (utils/shopify-hmac.ts:33-34). The inconsistency is real. Downgraded from MEDIUM to LOW: this is a one-shot OAuth install callback (not a high-volume oracle), the comparison is over a hex digest of a server-computed value, and any timing benefit only helps an attacker who would still need to brute-force a full SHA-256 HMAC over the network — practically infeasible. It is a hardening/consistency nit, not an exploitable defect.
- **Fix:** For consistency reuse a shared constant-time verifier: import the secret with ['verify'], hex-decode the supplied hmac to bytes, and call crypto.subtle.verify (mirroring utils/shopify-hmac.ts). Low priority given the limited attack surface.

#### [security] Shopify OAuth-install HMAC uses non-constant-time string compare
- **Location:** `apps/worker/src/routes/shopify-auth.ts:76`
- **Subsystem:** Security / Auth / cross-cutting (SECURITY PRIORITY) | **Confidence:** 0.8
- **Verdict:** Confirmed at shopify-auth.ts:76 `return computed === hmac` — hex string `===` short-circuits at first differing char, unlike crypto.subtle.verify (utils/shopify-hmac.ts:34) and constantTimeEqual (email-unsubscribe.ts:62) used elsewhere. Real inconsistency on the install-callback signature, but remote timing exploitability is very low: single-shot per nonce, network/edge jitter dwarfs per-char timing, and a verified-sub gate follows. Downgraded MEDIUM→LOW to reflect true exploitability while affirming it should be tightened.
- **Fix:** Hex-decode the incoming hmac and verify via crypto.subtle.verify('HMAC', key, sigBytes, encode(message)), or reuse constantTimeEqual on the two hex strings (after a `^[a-f0-9]{64}$` format check). Mirror utils/shopify-hmac.ts verifyShopifySignature so all Shopify HMAC paths share one constant-time helper.

#### [performance] Redundant indexes duplicate UNIQUE-constraint implicit indexes
- **Location:** `packages/db/migrations/058_membership_tiers.sql:63-64`
- **Subsystem:** DB layer + migrations + schema integrity | **Confidence:** 0.8
- **Verdict:** Confirmed: members.friend_id is 'TEXT NOT NULL UNIQUE' (058:52) and an explicit 'CREATE INDEX idx_members_friend ON members(friend_id)' is created at 058:63-64; SQLite auto-creates an index for every UNIQUE constraint, so idx_members_friend is redundant. Same for member_purchase_events.shopify_order_id 'TEXT NOT NULL UNIQUE' (059:24) duplicated by idx_member_purchase_events_order (059:38-39). The composite idx_member_purchase_events_friend (059:41-42) and partial idx_member_purchase_events_unapplied (059:44-45) are genuinely useful and should stay. Minor extra write cost only.
- **Fix:** In a future migration, DROP idx_members_friend and idx_member_purchase_events_order (both fully covered by the UNIQUE auto-index) and remove them from schema.sql. Keep the composite friend index and the partial unapplied index. Low priority cleanup; safe to defer.

#### [performance] Account-scoped list pages double-fetch and issue an un-scoped query during initial load
- **Location:** `apps/web/src/app/friends/page.tsx:79-91`
- **Subsystem:** Admin web (Next.js 15) | **Confidence:** 0.8
- **Verdict:** Confirmed: friends/page.tsx:64 sets accountId only when selectedAccountId truthy; loadFriends deps are [page, selectedTagId, selectedAccountId] (line 79); account-context.tsx:37 starts selectedAccountId=null and resolves async (refreshAccounts useEffect). So the mount effect fires once unscoped, then again when the id resolves — two round-trips, first returning unscoped data immediately replaced. Functionally harmless (second fetch wins).
- **Fix:** useAccount already exposes `loading`; gate loadFriends/loadChats to early-return until `!loading` (or skip when selectedAccountId is null for always-scoped pages). Confirmed LOW: UX/perf only, server is source of truth. Note the brief unscoped result is whatever /api/friends returns for no accountId — verify that endpoint does not leak other LINE accounts' friends to an operator who shouldn't see them.

#### [maintainability] Inconsistent delivery-window hours between enrollment and step delivery
- **Location:** `packages/db/src/scenarios.ts:357-364`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.75
- **Verdict:** Confirmed: enrollFriendInScenario enforces 9:00-21:00 JST for the first step (scenarios.ts:360 `if (hours < 9 || hours >= 21)`) while the step scheduler uses 9:00-23:00 JST (step-delivery.ts:82-83 DEFAULT_START_HOUR=9/DEFAULT_END_HOUR=23 and early-return L110). So a scenario's first message obeys a narrower window than subsequent ones, and the cutoff is duplicated as literals in two files inviting drift. Genuine maintainability/consistency issue, low functional impact.
- **Fix:** Export the window constants and enforceDeliveryWindow from step-delivery.ts and call it from enrollFriendInScenario so first-step and subsequent-step scheduling share identical hours. (Note scenarios.ts is in packages/db and step-delivery.ts in apps/worker — extract the shared helper into packages/db or a shared package to avoid a cross-layer import.)

#### [maintainability] AI nutrition copy clipped at 120 chars despite 60-char design/prompt
- **Location:** `apps/worker/src/services/nutrition-recommender.ts:44-48`
- **Subsystem:** Coaching/nutrition/food + commerce features | **Confidence:** 0.75
- **Verdict:** Confirmed: AI_MESSAGE_MAX_LEN = 120 (line 46) with a comment that literally says '60 字', while SKU_COPY_MAX_LEN = 60 (line 48), the SYSTEM_PROMPT mandates 60字 (line 72), and the file header (line 6) says 60 字. AI output is clipped with AI_MESSAGE_MAX_LEN at line 212, so a model reply of 61-120 chars is persisted and shown, contradicting the stated 60-char UX/LINE-card constraint. The comment is factually inconsistent with the constant. Templates also use this constant (line 249) but are hand-authored within 60, so the practical drift is the AI path.
- **Fix:** Decide the real limit and make it consistent: set AI_MESSAGE_MAX_LEN = 60 to match prompt/SKU/design, or, if 120 is intentional headroom, update the comment and SYSTEM_PROMPT/header so all three agree. Keeping AI and SKU/template limits aligned avoids overflowing the intended LINE card layout.

#### [data-integrity] ban-monitor counts outgoing messages across all accounts (messages_log has no tenant key) → per-account risk levels are inaccurate
- **Location:** `apps/worker/src/services/ban-monitor.ts:41-49`
- **Subsystem:** Cron scheduler + monitors | **Confidence:** 0.72
- **Verdict:** Confirmed: messages_log has NO line_account_id column (schema.sql:226-237 verified). ban-monitor.ts:41-47 counts `direction='outgoing' AND created_at>=?` with no account scope, and createAccountHealthLog (79-85) writes that global count per-account inside the per-account loop.
- **Fix:** Real correctness gap but LOW: the totalSent>5000 branch only sets riskLevel='warning' (soft signal), while the actionable 'danger' path keys off the real per-account 403 from api.line.me/v2/bot/info using account.channel_access_token (line 56-57) which IS correctly per-account. So the important detection is already account-accurate; only the volume-warning heuristic is global, and only once a 2nd account exists. Longer term: add line_account_id to messages_log (backfill from friends.line_account_id) and scope the count. Downgraded MEDIUM→LOW.

#### [data-integrity] redactProhibitedPhrases uses naive substring replace — boundary bleed-through and order dependence
- **Location:** `packages/ai-provider/src/redact.ts:60-74`
- **Subsystem:** AI auto-reply + provider abstraction | **Confidence:** 0.7
- **Verdict:** Confirmed substring bleed: redact.ts:67 builds `new RegExp(escapeRegex(phrase),'gi')` with no word boundary. '保証' (redact.ts:46) over-matches benign '保証書'/'品質を保証'→'[省略]'; English 'cure'/'heal' (redact.ts:48-49) with /gi mangle 'secure'/'healthy'. Real, but downgraded from MEDIUM: (1) this is output redaction of a JP-instructed LLM so English emission is rare; (2) over-redaction FAILS SAFE — it degrades copy quality, it does not leak banned content; (3) the order-dependence sub-claim is weak (author concedes it is 'fine here').
- **Fix:** Anchor the English entries: /\bcure\b/gi, /\bheal\b/gi. Reconsider bare '保証' (over-matches legitimate quality-assurance copy). For Japanese, prefer the verb-phrase regex style already in ai-ng-filter.ts (治[りるっれら]) over bare substrings. Low priority since the failure direction is safe.

#### [security] GET /api/forms/:id is public and leaks full form definition incl. internal tag/scenario IDs
- **Location:** `apps/worker/src/middleware/auth.ts:41`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.7
- **Verdict:** Confirmed factually: auth.ts:41 exempts GET /api/forms/:id and serializeForm (forms.ts:19-33) returns on_submit_tag_id, on_submit_scenario_id, save_to_metadata and submit_count to the public caller. But the exploit it claims to enable does NOT depend on these IDs — the /submit side-effects use the tag/scenario IDs stored on the FORM ROW (server-driven), not caller-supplied ones, so leaking them does not let an attacker choose which tag/scenario is applied. The IDs are opaque UUIDs; impact is informational disclosure only. Downgraded MEDIUM→LOW.
- **Fix:** Return a public-safe projection for the unauthenticated GET (id, name, description, fields only — omit on_submit_tag_id, on_submit_scenario_id, save_to_metadata, submit_count) and keep the full serializeForm shape behind authMiddleware for admin use.

#### [maintainability] shopify_oauth_states nonce rows are not garbage-collected on expiry/abandonment
- **Location:** `apps/worker/src/routes/shopify-auth.ts:108-113`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.7
- **Verdict:** Confirmed: shopify_oauth_states rows are INSERTed on every /auth/shopify call (lines 108-113) with a 10-min expiry, but DELETE only ever happens by-nonce in the callback (lines 173, 180); a grep across apps/worker/src found no TTL-sweep cron. Abandoned installs or spam to /auth/shopify accumulate stale rows indefinitely, and the endpoint is publicly reachable (auth excluded at middleware/auth.ts:23). Genuinely minor for a single-merchant (id='default') app but unbounded in theory. LOW is accurate.
- **Fix:** Add a periodic cleanup to an existing cron (the codebase already does cron-based cleanups) running `DELETE FROM shopify_oauth_states WHERE expires_at < ?`, and/or rate-limit the public /auth/shopify endpoint.

#### [maintainability] shopify-phase2a.ts is 933 lines mixing 6 unrelated concerns (4 webhooks + restock + coupons + deprecated ranks + carts)
- **Location:** `apps/worker/src/routes/shopify-phase2a.ts:1-1071`
- **Subsystem:** Shopify orders → membership (recent, real traffic) | **Confidence:** 0.7
- **Verdict:** Confirmed: wc -l reports 1070 lines, over the repo's 800-line ceiling. The file mixes checkout/fulfillment/inventory/payment webhooks, restock-request CRUD (557+), coupon CRUD (630+), explicitly-DEPRECATED member_ranks CRUD (verified at 800-951 with X-Sunset-Date 2026-06-15 headers), and abandoned-cart CRUD (957-1068). The payment webhook handler (420-551) is ~130 lines doing HMAC parse, 3-path friend resolution, notification insert, and two separate waitUntil blocks — exceeding the 50-line guideline and directly contributing to why the finding-#1 idempotency-ordering bug is easy to miss. Legitimate maintainability finding; LOW severity is appropriate.
- **Fix:** Split into shopify-webhooks.ts (checkout/fulfillment/inventory/payment), shopify-coupons.ts, shopify-restock.ts, shopify-abandoned-carts.ts, and move the deprecated ranks routes into shopify-ranks-legacy.ts (or fast-forward them to 410 Gone now, per their own sunset date). Isolating the order→member webhook path into its own focused file makes the idempotency logic from finding #1 reviewable in one place.

#### [maintainability] messages_log records pre-expansion / pre-tracking content (audit + analytics mismatch)
- **Location:** `apps/worker/src/services/step-delivery.ts:289-296`
- **Subsystem:** Broadcasts + step/monthly delivery | **Confidence:** 0.7
- **Verdict:** Confirmed for two of the three paths: step-delivery.ts builds buildMessage(trackedType, trackedContent) and sends it (:285-286) but logs the raw currentStep.message_content (:295); broadcast.ts sends auto-tracked finalContent (:107-112) but logs raw broadcast.message_content (:173). So the log misrepresents the delivered payload (no expanded {{name}}, no tracking links). Partial inaccuracy: segment-send.ts builds buildMessage from raw broadcast.message_content (line 34, no auto-track applied), so its log (:82) actually matches what it sends — segment-send is not a real mismatch.
- **Fix:** Log the rendered payload actually sent (trackedType/trackedContent for steps; auto-tracked finalContent for the LINE broadcast path), or store both the template id and the rendered content. Drop segment-send from the claim since it logs what it sends. At minimum document that messages_log holds the pre-tracking template for steps/broadcasts.

#### [security] completionPage interpolates pictureUrl into <img src> without escaping (only un-escaped sink in the file)
- **Location:** `apps/worker/src/routes/liff.ts:945`
- **Subsystem:** LIFF pages/portal (huge files, user-facing) | **Confidence:** 0.7
- **Verdict:** Confirmed: liff.ts:945 emits <img src="${pictureUrl}"> raw, while every sibling (displayName line 946, ref line 949, errorPage) goes through escapeHtml (liff.ts:980, which DOES escape "). pictureUrl originates from LINE /v2/profile (liff.ts:269), so it is LINE-CDN-controlled, not directly attacker-settable — genuine but low-exploitability inconsistency. Downgraded from MEDIUM to LOW because the source is a trusted LINE response, not user input.
- **Fix:** Escape for consistency and future-proofing: <img src="${escapeHtml(pictureUrl)}">, and optionally assert it starts with https:// before rendering, matching the rest of the codebase.

#### [maintainability] email-admin.ts exceeds the 800-line file guideline and mixes unrelated concerns
- **Location:** `apps/worker/src/routes/email-admin.ts:1-928`
- **Subsystem:** Email channel (Resend) | **Confidence:** 0.7
- **Verdict:** Confirmed: file is 927 lines (wc -l), exceeding the repo's 800-line guideline, and combines KPI SQL aggregation, subscriber CRUD (incl. PATCH at 314), template CRUD, opt-in URL generation (570), and the bulk invitation campaign (634+) with embedded SQL in one module. Legitimate maintainability/auditability concern but purely stylistic — LOW.
- **Fix:** Split into focused Hono route modules (email-admin-kpi.ts, email-admin-subscribers.ts, email-admin-templates.ts, email-admin-optin-campaign.ts) mounted under the same app, and move KPI/candidate SQL into packages/db query functions so the security-relevant endpoints (generate-url, send-invitations) are easier to audit. Low priority relative to the HIGH/MEDIUM findings.

#### [maintainability] API-base defined with `|| 'http://localhost:8787'` fallback bypasses the build-time guard
- **Location:** `apps/web/src/app/affiliates/page.tsx:9`
- **Subsystem:** Admin web (Next.js 15) | **Confidence:** 0.7
- **Verdict:** Confirmed at affiliates/page.tsx:9 (`const WORKER_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'`, used at :86 and :150) and login/page.tsx:18. BUT affiliates imports `fetchApi` from @/lib/api, whose module-load throw-guard (api.ts:64-69) fires for any build including this page — so the 'silent localhost in production' scenario is already prevented by the existing guard. The fallback is a misleading dead branch / inconsistency, not a live production trap.
- **Fix:** Reuse the validated base: export an `API_URL` const from lib/api (after the existing throw) and import it here and in login/page.tsx, dropping the `|| 'http://localhost:8787'` fallback so there is a single source of truth. Downgraded HIGH->LOW because the api.ts guard already fails the build on unset env.

#### [bug] GET helpers can silently return undefined typed as T (non-JSON / empty body)
- **Location:** `packages/line-sdk/src/client.ts:62-65`
- **Subsystem:** Core SDK packages | **Confidence:** 0.7
- **Verdict:** Confirmed at client.ts:62-65: non-application/json responses are coerced to `undefined as unknown as T` while GET methods (getInsightMessageEvent→InsightMessageEventResponse, getMessageQuota→MessageQuotaResponse, getRichMenuIdOfUser→{richMenuId}) are typed non-optional. Real type hole: caller broadcast-insights-fetcher.ts:104 does `if (!insights.overview)`, which would throw on undefined. Stays LOW (not raised): LINE returns JSON for these endpoints in practice so it is latent, and both confirmed callers wrap the call in try/catch (best-effort), so worst case is a logged error, not a crash.
- **Fix:** For GET endpoints required to return JSON, throw a clear error when the body is missing/non-JSON instead of returning `undefined as T`; alternatively type these returns as `T | undefined` so callers must handle the empty case. The cast hides the failure mode from the type system.

#### [data-integrity] Conversion eventValue of 0 is silently dropped by truthiness checks
- **Location:** `apps/worker/src/services/ad-conversion.ts:102-103`
- **Subsystem:** Coaching/nutrition/food + commerce features | **Confidence:** 0.7
- **Verdict:** Confirmed: Meta uses `if (eventValue)` (line 102) and X/Google/TikTok use `...(eventValue && {...})` (lines 142, 174, 214). A legitimate value of exactly 0 (e.g. a ¥0 trial/sample CV) is falsy and omitted from the payload. Minor real correctness issue; ¥0 CVs are uncommon but the truthiness guard would also drop any future falsy-but-valid value.
- **Fix:** Guard on presence/finiteness instead of truthiness, e.g. `const hasValue = typeof eventValue === 'number' && Number.isFinite(eventValue);` then include value/currency when hasValue is true. Apply consistently across all four platform builders.

#### [bug] Once-per-month / once-per-week 5-minute gating windows have no catch-up if Cloudflare skips the matching cron tick
- **Location:** `apps/worker/src/services/birthday-cron.ts:79-91`
- **Subsystem:** Cron scheduler + monitors | **Confidence:** 0.68
- **Verdict:** Confirmed: birthday-cron.ts:79 `jstDay===1 && jstHour===10 && jstMinute<5` is one 5-min window/month; membership-promotion-cron.ts:70 (09:00<5) and weekly-coach-push.ts:113-121 (Tue 10:00-10:04) are the same narrow pattern. Cloudflare Cron Triggers are best-effort; a dropped :00 tick leaves the next :05 tick outside `<5` → that period is skipped.
- **Fix:** Real but LOW: probability of Cloudflare dropping the single matching :00 tick within a >=5-min window is small, and cron-monitor (30h/31d silence threshold) catches a fully-missed period after the fact. Note monthly-food-report is NOT affected the same way — monthly-food-report.ts:103 gates on dayOfMonth===1 for the whole of day-1 (~288 ticks), so it is far more tolerant than the finding implies. Improvement: make the gate idempotent-by-period (trigger whenever period-not-yet-processed AND now>=scheduled, using cron_run_logs / a per-period marker) so a missed :00 tick is picked up by the next 5-min tick the same day. Downgraded MEDIUM→LOW.

#### [bug] enforceDeliveryWindow ignores preferredHour when computing next-day push-forward
- **Location:** `apps/worker/src/services/step-delivery.ts:85-100`
- **Subsystem:** Broadcasts + step/monthly delivery | **Confidence:** 0.65
- **Verdict:** Confirmed: the cron-level early return hardcodes DEFAULT_START_HOUR/DEFAULT_END_HOUR (9/23) regardless of preferred_hour (step-delivery.ts:109-110), while enforceDeliveryWindow honors preferredHour as startHour (:88,91,98). webhook.ts:562 lets a friend set preferred_hour to any value 6-22, so hours 6/7/8 get scheduled (e.g. 08:00) by enforceDeliveryWindow but blocked by the outer gate until 09:00+. The plumbing is only partially dead (preferred_hour 9-22 works; 6-8 conflicts). Minor inconsistency, no data loss.
- **Fix:** Either clamp per-friend preferred_hour to [DEFAULT_START_HOUR, DEFAULT_END_HOUR] (or tighten the webhook to reject <9) so scheduling and the cron gate agree, or remove the early-return gate and rely solely on per-scenario next_delivery_at (which already encodes the window via enforceDeliveryWindow). Document the intended precedence.

#### [security] Survey list embeds double-JSON into a single-quoted onclick attribute without HTML-attribute escaping
- **Location:** `apps/worker/src/routes/liff-pages.ts:1683`
- **Subsystem:** LIFF pages/portal (huge files, user-facing) | **Confidence:** 0.65
- **Verdict:** Confirmed: liff-pages.ts:1683 renders onclick='openSurvey(' + JSON.stringify(JSON.stringify(s)) + ')' inside single-quoted HTML attribute delimiters. JSON.stringify escapes for a JS-string context but NOT for HTML attributes, so a ', > or & in any survey field breaks out of the attribute. Title/description in the same row ARE esc()'d (lines 1686-1687) but the onclick payload is not. Survey data is admin-authored (POST /api/liff/ambassador/surveys, liff-portal.ts:1313), keeping severity LOW; genuine latent injection and fragile pattern.
- **Fix:** Avoid serializing objects into inline onclick. Stash surveys in a JS array/map and pass only an index/id to openSurvey(idx), or attach the handler via addEventListener with a closure over s (as the SKU/reorder rows do). If inline must remain, additionally HTML-attribute-escape the serialized string.

#### [security] Shopify webhook secret falls back to CLIENT_SECRET, widening accepted signing keys
- **Location:** `apps/worker/src/routes/shopify-phase2a.ts:138-158`
- **Subsystem:** Security / Auth / cross-cutting (SECURITY PRIORITY) | **Confidence:** 0.65
- **Verdict:** Confirmed at shopify-phase2a.ts:138 (`SHOPIFY_WEBHOOK_SECRET || SHOPIFY_CLIENT_SECRET` primary) and 146-158 (retry against CLIENT_SECRET only when both set and unequal, success logs console.warn + a `security_warning` D1 audit row via logWebhook). Mirrored exactly in shopify.ts:147-166. Two distinct secrets are simultaneously valid signers — defended, intentional migration resilience rather than a hole. LOW as the reviewer set; the only real risk is masking a stale/rotated WEBHOOK_SECRET indefinitely.
- **Fix:** Treat CLIENT_SECRET fallback as a time-boxed migration aid: when it triggers, raise an out-of-band alert (Discord/Axiom), not only a D1 row, and add a tracked follow-up to delete the fallback branch once SHOPIFY_WEBHOOK_SECRET is confirmed in prod so exactly one key is ever accepted.

#### [data-integrity] members / member_purchase_events have no line_account_id (tenancy only transitive via friend_id)
- **Location:** `packages/db/migrations/059_member_purchase_events.sql:22-36`
- **Subsystem:** DB layer + migrations + schema integrity | **Confidence:** 0.65
- **Verdict:** Confirmed: members (058:50-61) is keyed by friend_id NOT NULL UNIQUE with no line_account_id; member_purchase_events (059:22-36) likewise has only a nullable friend_id. getMembersByTier (membership.ts:305-318) and getMembershipStats (membership.ts:526-548) aggregate across all rows with no account scoping. Tenancy is purely transitive via friends.friend_id. Correct, fine for single-brand today, but will silently span brands once a 2nd account exists. LOW/latent.
- **Fix:** Before onboarding a second brand, either add line_account_id to members/member_purchase_events (backfill from friends) and scope the tier/stat queries + indexes by it, or add an explicit code comment documenting that membership aggregation is intentionally global. Track with the multi-tenant hardening item.

#### [bug] Broadcast scheduler hardcodes the +09:00 JST offset
- **Location:** `apps/web/src/components/broadcasts/broadcast-form.tsx:67-69`
- **Subsystem:** Admin web (Next.js 15) | **Confidence:** 0.65
- **Verdict:** Confirmed at broadcast-form.tsx:67-69: scheduledAt = `form.scheduledAt + ':00.000+09:00'`, with a comment explaining datetime-local is JST wall-clock. Correct for the current naturism (JST) deployment; latent only under the stated future multi-tenant/multi-timezone direction.
- **Fix:** When multi-tenant timezones land, derive the offset from the selected line account's timezone (or store wall-clock + tz and convert server-side) instead of the hardcoded +09:00. Confirmed LOW/latent — not currently incorrect.

#### [workers-trap] LineClient fetch calls have no timeout (unlike the public SDK)
- **Location:** `packages/line-sdk/src/client.ts:41-53`
- **Subsystem:** Core SDK packages | **Confidence:** 0.65
- **Verdict:** Confirmed: client.ts:41-53 builds RequestInit with no `signal`; grep for AbortSignal|timeout in packages/line-sdk/src returned zero matches, while the public SDK http.ts:50 uses `AbortSignal.timeout(this.timeout)`. uploadRichMenuImage (295-302) also lacks a signal. Real inconsistency; in Workers a hung api.line.me call inside waitUntil() can hold context until platform kill. LOW is right — Cloudflare enforces subrequest/wall limits as a backstop, so it is a robustness gap rather than a guaranteed failure.
- **Fix:** Add an optional timeout to LineClient and attach `signal: AbortSignal.timeout(ms)` (default ~10-30s) to fetch in request/requestWithHeaders and uploadRichMenuImage, mirroring HttpClient, so stalled LINE calls fail fast inside waitUntil().

#### [bug] Tier promotion silently skipped (member left at old tier) when membership_tier lookup fails after a successful promote
- **Location:** `apps/worker/src/services/membership.ts:220-230`
- **Subsystem:** Shopify orders → membership (recent, real traffic) | **Confidence:** 0.62
- **Verdict:** Confirmed: promoteAndNotify calls promoteMemberIfEligible first (membership.ts:208), which has ALREADY committed current_tier_id=newTier via UPDATE (db/membership.ts:290-300) when promoted=true. Then it loads oldTier/newTier (220-221); if either getMembershipTierById returns null it returns {promoted:true, pushed:false, reason:'tier lookup failed'} with NO console.error — in contrast to the push-failure branch (250-255) which DOES console.error. So a tier persisted in members but missing/unreadable in membership_tiers yields a silent no-notify that is only observable via the return value. Correctly characterized as a minor robustness gap, not data loss (the tier IS persisted). LOW is right.
- **Fix:** Add a console.error in the !oldTier || !newTier branch (it signals membership_tiers/members drift worth alerting on, same as the existing push-failure log). Optionally validate that the eligible tier exists before promoteMemberIfEligible runs its UPDATE, so the DB row and the notification stay consistent.

#### [security] Admin coach/reorder/email routes gated only by authMiddleware, not requireRole
- **Location:** `apps/worker/src/routes/coach-admin.ts:71-272`
- **Subsystem:** Security / Auth / cross-cutting (SECURITY PRIORITY) | **Confidence:** 0.62
- **Verdict:** Confirmed: coach-admin.ts has no requireRole import/usage (grep shows requireRole only in line-accounts.ts and staff.ts). PUT /api/admin/coach/sku-map (272) and the analytics/recommendations GETs (71,244) rely solely on the global authMiddleware, so any role='staff' token can read business analytics and mutate the SKU map. staff.ts uses requireRole('owner') for comparable surfaces. Not a bypass (valid token still required) — coarse authorization granularity. LOW correct. sku-map input is validated (isAllowedDeficitKey, length caps) so no injection.
- **Fix:** Apply `requireRole('admin','owner')` (or 'owner') to mutating /api/admin/* endpoints — at minimum PUT /api/admin/coach/sku-map — to match the staff-management privilege model. Sweep the other *-admin.ts route files (reorder/email) for the same gap and add a test that a 'staff' token gets 403 on the mutating admin endpoints.

#### [bug] Reply-token-expiry fallback relies on fragile substring match of '400'
- **Location:** `apps/worker/src/services/event-bus.ts:331-341`
- **Subsystem:** Webhook + Event Bus (entry point) | **Confidence:** 0.6
- **Verdict:** Confirmed: line 335 isTokenError = errMsg.includes('400') || errMsg.includes('Invalid reply token'); and the SDK (client.ts:57-59) throws a plain Error with message `LINE API error: ${status} ${statusText} — ${text}`, so any genuine 400 validation error, or a 5xx whose body text happens to contain '400', is misclassified as an expired token and silently retried as a push (consuming push quota); a token error worded differently would be re-thrown.
- **Fix:** Have the LINE SDK throw a typed LineApiError carrying .status (number) and the parsed LINE error message/code, then branch on status===400 plus the documented reply-token message rather than substring-matching free text. Low severity: in practice replyMessage 400s here are nearly always expired/invalid tokens, so the misclassification rarely bites.

#### [bug] Unguarded JSON.parse of friend.metadata in text time-setting and event-bus set_metadata paths
- **Location:** `apps/worker/src/routes/webhook.ts:564-565`
- **Subsystem:** Webhook + Event Bus (entry point) | **Confidence:** 0.6
- **Verdict:** Confirmed: webhook.ts line 565 const meta = JSON.parse(existing?.metadata || '{}') sits OUTSIDE the try that starts at line 571 (and the text branch has no enclosing try before it), so a corrupt metadata row throws and aborts the whole text handler for that event, caught only by the outer per-event catch (no reply sent). Mirror at event-bus.ts:392 const current = JSON.parse(existing?.metadata || '{}'). Note the event-bus mirror is wrapped by the per-action try/catch in processAutomations (lines 228-234), so there it is recorded as a failed action rather than aborting the loop — smaller blast radius than the webhook path.
- **Fix:** Add a safeParseJson(str): Record<string,unknown> helper returning {} on failure (optionally logging once) and use it at both sites so a single corrupt row degrades gracefully instead of throwing. Low severity since stored metadata is normally well-formed.

#### [test-gap] Dynamic import of ai-router-factory inside webhook text handler (vi.mock interference risk per project trap)
- **Location:** `apps/worker/src/routes/webhook.ts:852-853`
- **Subsystem:** AI auto-reply + provider abstraction | **Confidence:** 0.6
- **Verdict:** Confirmed redundant: createAIRouterFromEnv is statically imported at webhook.ts:35 AND dynamically re-imported at webhook.ts:852 (`const { createAIRouterFromEnv } = await import('../services/ai-router-factory.js')`). The dynamic form is pure redundancy and matches the family of the documented vi.mock+dynamic-import trap (CLAUDE.md テストコーディングルール). Low severity: the static import already provides the symbol so deletion is trivially safe, and ai-router-factory is a trivial factory with no bundle-size benefit to lazy-load.
- **Fix:** Delete the redundant dynamic import at webhook.ts:852 and use the static import already present at line 35. Removes a known test-fragility pattern and a needless await on every text message. Verify no test depends on the dynamic-import seam before removing.

#### [maintainability] forms.ts /submit handler is an oversized, deeply nested function with hot-path dynamic imports
- **Location:** `apps/worker/src/routes/forms.ts:172-339`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.6
- **Verdict:** Confirmed: the /submit handler spans forms.ts:172-339 (~167 lines, exceeds the repo <50-line guideline) with a large inline IIFE (L261-324) mixing token resolution, Flex card construction and pushMessage, three hot-path `await import()` calls (L265 line-sdk, L269 db, L321 step-delivery) and `as unknown as Record<string,unknown>` casts (L268/270). Maintainability only. Worth noting the dynamic import of '@line-crm/db' inside this handler, whose test (forms.test.ts) vi.mock's @line-crm/db, matches the documented project trap (CLAUDE.md vi.mock + dynamic import silently swallows) — a latent test-reliability risk.
- **Fix:** Extract the confirmation-message build+push into a named service (e.g. services/form-confirmation.ts) and split validation/persistence/side-effects into helpers. Convert the db/line-sdk/step-delivery dynamic imports to static top-level imports (they are lightweight and this also removes the vi.mock-interference risk), and resolve the account access token via a typed helper instead of `as unknown as` casts.

#### [data-integrity] currency is recorded but ignored — non-JPY orders credited as if JPY (no conversion, no skip)
- **Location:** `packages/db/src/membership.ts:371-423`
- **Subsystem:** Shopify orders → membership (recent, real traffic) | **Confidence:** 0.6
- **Verdict:** Confirmed: addPurchaseEvent (371-423) computes amount = Math.max(0, Math.floor(Number.isFinite(input.amountJpy)?input.amountJpy:0)) and binds currency into the row (line 414) but never compares currency to 'JPY' before adding amountJpy to members.total_purchase_jpy (ON CONFLICT ... + excluded.total_purchase_jpy at 473). The webhook forwards currency through (shopify-phase2a.ts:432→525-526). Migration 059 comment asserts 'naturism は JPY only', so this is correct today and only breaks if Shopify Markets emits a non-JPY order — which this project's own memory documents as a feature that silently activated 29 countries once. Genuinely real but LOW: depends on an external assumption that currently holds; the NaN/negative guard already exists.
- **Fix:** In addPurchaseEvent (or the webhook), if (input.currency ?? 'JPY') !== 'JPY' then record the event with applied_at left NULL + reason 'non-JPY currency' and skip the member credit (or convert). Given the documented Shopify Markets incident, defensively rejecting non-JPY here is cheap insurance and keeps the cumulative total trustworthy.

#### [bug] tag-elapsed-delivery comment/behavior mismatch + UTC date window vs JST-stored assigned_at
- **Location:** `apps/worker/src/services/tag-elapsed-delivery.ts:51-60`
- **Subsystem:** Cron scheduler + monitors | **Confidence:** 0.6
- **Verdict:** Confirmed both parts: tag-elapsed-delivery.ts:53 `if (Math.abs(jstHour - rule.send_hour) > 0) continue;` is an exact-hour match (1-hour window = 12 ticks) yet the comment at line 52 claims '±1時間の余裕'; and lines 58-60 compute targetDate from `new Date()` (UTC) then `.toISOString().split('T')[0]`, while the JOIN compares `date(ft.assigned_at)` where assigned_at is JST (friends timestamps default '+9 hours', schema.sql:16) — so near 09:00 JST (UTC midnight) the target date can be off by one day.
- **Fix:** Real but LOW and partly self-mitigating: the INSERT OR IGNORE dedup keyed `${rule.id}_${friend_id}` (lines 92-95) makes a day-early/late match idempotent (at most one delivery per rule per friend), so the date-skew worst case is a delivery one day off, not a duplicate/storm. Fix: correct the comment to 'exact hour match', and compute targetDate in JST (add 9h before toISOString) to align with how assigned_at is stored, consistent with the other crons. Severity confirmed LOW.

#### [security] coach SKU click opens server-supplied shopifyProductId as a URL without scheme validation
- **Location:** `apps/worker/src/routes/liff-coach-page.ts:259-265`
- **Subsystem:** LIFF pages/portal (huge files, user-facing) | **Confidence:** 0.6
- **Verdict:** Confirmed: liff-coach-page.ts:259-265 coerces r.body.data.shopifyProductId to a string and passes it directly to liff.openWindow({url, external:true}) / window.open(url,'_blank','noopener') with no http(s) assertion. Value comes from sku_suggestions_json (system/AI-generated today), so not directly user-controlled — a javascript:/data: payload would require compromising that data first. Real latent issue, correctly rated LOW.
- **Fix:** Assert /^https?:\/\// before opening; otherwise treat the value as a Shopify product id/handle and construct the store URL from a known base rather than navigating to a raw string.

#### [bug] Opt-in token expiry comparison is inconsistent and off-by-one between layers
- **Location:** `apps/worker/src/services/email-opt-in.ts:127-137`
- **Subsystem:** Email channel (Resend) | **Confidence:** 0.6
- **Verdict:** Confirmed: verifyEmailOptInToken rejects only when input.expiresAt < now (email-opt-in.ts:135), so a token is still valid AT the exact expiry second, while signEmailOptInToken sets expiresAt = now + ttl (line 92-94) and the admin upper-bound check uses n > 30d (email-admin.ts:595). The 1-second boundary deviates from the typical 'now >= exp -> expired' convention. Genuine but cosmetic; the comment at line 28 also still says 'default 30 days' while DEFAULT_TOKEN_TTL_SECONDS is 14 days — a stale doc, not the bug claimed.
- **Fix:** Standardize on `now >= expiresAt -> expired` (use <=) across sign/verify and add a boundary unit test. While here, fix the stale '30 days' comment at email-opt-in.ts:28/66/69 to match the actual 14-day DEFAULT_TOKEN_TTL_SECONDS. Cosmetic; safe to bundle with finding #3's normalization work.

#### [security] Owner master API_KEY compared with non-constant-time ===
- **Location:** `apps/worker/src/middleware/auth.ts:62`
- **Subsystem:** Security / Auth / cross-cutting (SECURITY PRIORITY) | **Confidence:** 0.6
- **Verdict:** Confirmed at auth.ts:62 `if (token === c.env.API_KEY)` — non-constant-time compare on the highest-privilege (role 'owner') credential. Real, but the key is a high-entropy secret and cross-edge remote timing is impractical; LOW is correct. Note: no bypass from unset API_KEY (token slice is a string, `'x' === undefined` is false), but an accidentally empty-string API_KEY would still be a separate misconfig concern worth guarding.
- **Fix:** Replace with a constant-time compare (encode both to bytes, XOR-accumulate, or HMAC-then-compare). Additionally guard `if (c.env.API_KEY && token === c.env.API_KEY)` so an empty/undefined API_KEY can never authenticate an empty bearer.

#### [maintainability] LineClient / HttpClient constructors do not validate credentials at the boundary
- **Location:** `packages/line-sdk/src/client.ts:18`
- **Subsystem:** Core SDK packages | **Confidence:** 0.6
- **Verdict:** Confirmed client.ts:18 `constructor(private readonly channelAccessToken: string){}` performs no validation; an empty token produces `Authorization: Bearer ` (line 45→opaque 401). HttpClient (http.ts:14-18) likewise does not validate apiKey/baseUrl. Real but minor; matches repo 'validate at boundaries / fail fast' guidance. LOW is appropriate — it only affects error clarity, not correctness, and in this monorepo the token comes from a validated wrangler secret.
- **Fix:** Throw a clear Error in each constructor when channelAccessToken/apiKey is empty (and optionally validate baseUrl is a well-formed URL). Cheap guard that converts opaque downstream 401s into an immediate, actionable failure.

#### [bug] body.events iteration is unguarded against malformed (but signature-valid) payloads
- **Location:** `apps/worker/src/routes/webhook.ts:138`
- **Subsystem:** Webhook + Event Bus (entry point) | **Confidence:** 0.55
- **Verdict:** Confirmed: body = JSON.parse(rawBody) as WebhookRequestBody (line 69) with no runtime shape validation; for (const event of body.events) (line 138) has its try/catch INSIDE the loop body (line 139), so a non-iterable body.events throws before any catch and rejects the waitUntil promise. Exploitability is genuinely minimal: the body must already pass HMAC verification and LINE always sends an events array, and the 200 is already returned (line 149) so the unhandled rejection is merely logged, not user-visible.
- **Fix:** Add a boundary guard before scheduling background work: if (!Array.isArray(body.events)) return c.json({status:'ok'},200); (or validate the full body with zod). Cheap hardening of an unvalidated boundary; functional impact today is near zero.

#### [data-integrity] Unguarded Number() coercion of Shopify money/count fields can persist NaN into D1
- **Location:** `apps/worker/src/services/shopify-customer-sync.ts:116-117`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.55
- **Verdict:** Partially confirmed as a defensive gap. Lines 116-117 use `cust.orders_count ? Number(cust.orders_count) : undefined` / same for total_spent; the truthiness guard skips '', 0, null, undefined, but a truthy non-numeric (e.g. unexpected schema drift) yields NaN, and downstream upsertShopifyCustomer binds `customer.totalSpent ?? null` (packages/db/src/shopify.ts:172) — nullish coalescing does NOT catch NaN, so NaN would reach .bind(). The same pattern repeats in shopify.ts (201, 330-331, 656, 687-688). Downgraded to LOW: Shopify reliably returns well-formed decimal strings for total_spent/orders_count, so there is no evidence of NaN actually occurring; this is hardening aligned with the project's prior NaN-guard convention rather than an active bug.
- **Fix:** Add a small `toFiniteNumber(v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined }` helper and use it for total_spent/total_price/orders_count/order_number across shopify-customer-sync.ts and shopify.ts so NaN can never reach .bind().

#### [performance] cron-cleanup DELETE has no LIMIT — a large backlog purge runs as one unbounded statement
- **Location:** `apps/worker/src/services/cron-cleanup.ts:62-68`
- **Subsystem:** Cron scheduler + monitors | **Confidence:** 0.55
- **Verdict:** Confirmed: cron-cleanup.ts:63-67 `DELETE FROM cron_run_logs WHERE ran_at < ?` with no LIMIT/batching. On failure it early-returns without self-recording (74-76), so a backlog exceeding D1 statement limits would leave the table unpurged each run.
- **Fix:** Real but genuinely LOW: the 03:00 window runs daily and normal operation deletes only ~1 day (~3k rows). A multi-hundred-thousand-row first purge requires the cleanup to be dormant for weeks AND the table to have grown unbounded — and even then a single indexed DELETE of a few hundred k rows on D1 typically succeeds; CRON_CLEANUP_FORCE is a manual escape hatch. Defensive hardening, not a live bug: delete in bounded chunks `WHERE id IN (SELECT id FROM cron_run_logs WHERE ran_at<? LIMIT 5000)` looped until changes===0 within a per-invocation cap. Severity confirmed LOW.

#### [security] Latent multi-tenant data leak: list queries omit line_account_id filter on multi-tenant tables
- **Location:** `packages/db/src/automations.ts:30-33`
- **Subsystem:** DB layer + migrations + schema integrity | **Confidence:** 0.55
- **Verdict:** The headline claim is FALSE: the event-bus does NOT call getAutomations(); it calls getActiveAutomationsByEvent (automations.ts:99-103) and then explicitly filters by line_account_id (event-bus.ts:213-216), and notifications are filtered identically (event-bus.ts:456-458). The admin route also scopes by account when lineAccountId is passed (automations.ts route:21-26), falling back to unfiltered getAutomations only when no account context exists. So 'account A's rules fire on account B's events' cannot happen. The finding also misstates schema: templates (schema.sql:484-492), tags (84-89), and operators (499-507) do NOT have line_account_id, so listing those is correct, not a leak. Real residue: chats/broadcasts/reminders/automations DO carry line_account_id (519/213/422/612) yet their raw list helpers (getChats:87, getBroadcasts:32-36, getReminders:34-36, getAutomations:30-33) take no account param, so any future admin route that forgets to scope returns all accounts' rows. That is a latent defense-in-depth gap only; single-tenant today and the automation engine itself is already scoped.
- **Fix:** Reframe as defense-in-depth, not a HIGH leak. Add an optional lineAccountId param to the raw list helpers that back account-scoped admin endpoints (getChats, getBroadcasts, getReminders) and append WHERE line_account_id IS ? to also match NULL/legacy rows; have routes pass the resolved id. Do NOT touch getAutomations for the engine path — it is already filtered in event-bus.ts. Drop templates/tags/operators from scope (no such column). Add a regression test before onboarding a 2nd account.

#### [data-integrity] parseDelay accepts unbounded digit strings (silent overflow / precision loss)
- **Location:** `packages/sdk/src/delay.ts:8-14`
- **Subsystem:** Core SDK packages | **Confidence:** 0.55
- **Verdict:** Confirmed delay.ts:8-14 validates `^(\d+)([mhdw])$` with no upper bound or finiteness check; result flows into createStepScenario as delayMinutes (workflows.ts:25). A pathological input like '999999999999w' yields a huge value with no guard. Real but low-impact: input is developer-supplied SDK args (not untrusted end-user input), and the test suite only covers normal/format-error cases, so an absurd value would be silently persisted. LOW/edge-case.
- **Fix:** Enforce a sane maximum (e.g. reject > a few years in minutes) and guard the result with Number.isSafeInteger, throwing a clear error when exceeded; add a regression test for the overflow case. Optional given inputs are developer-controlled.

#### [performance] Slow-path account fallback re-verifies HMAC against every active account on each unkeyed webhook
- **Location:** `apps/worker/src/routes/webhook.ts:101-121`
- **Subsystem:** Webhook + Event Bus (entry point) | **Confidence:** 0.5
- **Verdict:** Confirmed: when destination is present but the bot_user_id fast lookup misses, the loop (lines 105-120) runs verifySignature (HMAC import+sign) for each active account until a match, auto-populating bot_user_id on first match (lines 113-117). A destination matching no account triggers O(active-accounts) HMAC work per request with no rate limit. Accurate, but a non-issue at the current single/low account count and the finding already frames it as future-scale only.
- **Fix:** Acceptable at current scale (self-acknowledged). As accounts grow, bound the fallback (cap iterations, short-circuit) and run a one-time backfill to populate bot_user_id so the slow path is essentially never hit. Note every webhook already incurs at least one HMAC (fast path or final fallback line 127), so this only adds a per-active-account multiplier on unmatched-destination requests.

#### [bug] WorkersAIProvider passes temperature straight to ai.run without finite-number validation
- **Location:** `packages/ai-provider/src/providers/workers-ai.ts:74-82`
- **Subsystem:** AI auto-reply + provider abstraction | **Confidence:** 0.5
- **Verdict:** Confirmed latent only: workers-ai.ts:81 forwards temperature verbatim when `!== undefined` and :74-76 forwards maxTokens via ??, with no Number.isFinite guard. But verified that NO in-scope caller passes temperature, and every generateText/generateVision caller supplies maxTokens as a literal constant or `?? DEFAULT` (form/scenario/rich-menu/message-conductor, nutrition-recommender, monthly-food-report, translate, food-analyzer). No path computes these from parseFloat of admin input, so NaN cannot currently arise. Real per the project's own trap #3 (guard numeric runtime inputs) but purely hypothetical today.
- **Fix:** Cheap boundary hardening: `const maxTokens = Number.isFinite(request.maxTokens) ? request.maxTokens! : default;` and only include temperature when `Number.isFinite(request.temperature)`. Apply the same in claude.ts:66-67. Low urgency — no live caller can produce NaN, so this is preventive.

#### [data-integrity] Multi-tenant list endpoints fall back to returning all accounts' rows when lineAccountId is omitted
- **Location:** `apps/worker/src/routes/automations.ts:17-29`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.5
- **Verdict:** Behavior confirmed: GET /api/automations falls back to getAutomations (automations.ts:28 → db/automations.ts:31 SELECT * with no filter); same for scenarios (scenarios.ts:103 → getScenarios) and forms (getForms has no line_account_id column at all — Form interface forms.ts:6-18 lacks it). HOWEVER the claimed 'staff scoped to one account can enumerate another' presumes per-staff tenant partitioning that does NOT exist in this codebase — authMiddleware sets a staff/owner role with no line_account binding, and this is effectively a single-operator (naturism) admin that is INTENDED to see all accounts. Real latent issue for future multi-brand, but not an active leak today. Downgraded MEDIUM→LOW (design debt).
- **Fix:** When/if per-staff tenant scoping is introduced, derive allowed line_account_id(s) from the authenticated staff context and always filter, rather than trusting an optional query param. For forms, add a line_account_id column or document forms as global-only. Until staff are tenant-partitioned this is hardening, not a fix.

#### [data-integrity] start_scenario automation action does not verify the scenario belongs to the same LINE account
- **Location:** `apps/worker/src/services/event-bus.ts:305-307`
- **Subsystem:** Conductors + Automation engine | **Confidence:** 0.5
- **Verdict:** Confirmed: executeAction case 'start_scenario' (event-bus.ts:306) calls enrollFriendInScenario(db, friendId!, action.params.scenarioId) with no check that the scenario's line_account_id matches the event's lineAccountId, and friend_scenarios stores no line_account_id (schema.sql:178-187) so the link is unauditable. processAutomations scopes which automations RUN by account (L213-216) but trusts the embedded scenarioId. Exploitation requires a misconfigured/cross-account automation authored by an admin, so real-world likelihood is low — LOW is correct.
- **Fix:** Resolve the scenario via getScenarioById and verify scenario.line_account_id matches the event's lineAccountId before enrolling; log/skip mismatches. Consider adding line_account_id to friend_scenarios for auditability (also helps findings #4 and #7).

#### [bug] Shopify GraphQL discountAmount sent as a JSON number where a Decimal string is expected
- **Location:** `apps/worker/src/services/shopify-coupon-issuer.ts:179`
- **Subsystem:** Shopify core (auth/products/customer-sync) | **Confidence:** 0.45
- **Verdict:** Confirmed via schema introspection that DiscountAmountInput.amount is the Decimal scalar, and at line 179 `discountAmount` is bound as a JS number (default 500 from DEFAULT_DISCOUNT_VALUE_JPY). However Shopify's GraphQL server accepts numeric JSON literals for Decimal inputs in practice (the finding itself acknowledges this), so this is a forward-compat fragility, not a confirmed defect — and a regression would surface as userErrors, which the code handles by returning null (silent coupon-less fallback) rather than corrupting data. Tests mock fetch so this is never exercised against real Shopify. LOW/hardening.
- **Fix:** Pass `amount: String(discountAmount)` (or discountAmount.toFixed(2)) to match the Decimal scalar contract and remove the version-drift risk. Optionally add a dev-store smoke test instead of relying solely on mocked fetch.

#### [maintainability] Migration runner state-drift risk from non-contiguous numbering and duplicate ordinal
- **Location:** `packages/db/migrations/009_token_expiry.sql:1`
- **Subsystem:** DB layer + migrations + schema integrity | **Confidence:** 0.4
- **Verdict:** The facts are true (009 ordinal is shared by 009_delivery_type.sql and 009_token_expiry.sql; 038/046/057 are absent). BUT the finding's recommendation is already implemented: packages/db/migrations/README.md documents the duplicate-009 with a do-not-rename warning and ordering rationale (lines 29-44), documents the d1_migrations state-drift and that it was RESOLVED on 2026-05-22 via a one-time recovery script (lines 64-78), and documents the safe apply path. So the actionable part is largely moot; the only gap is that the README lists 038/046 as 欠番 but not 057. Near-INVALID as an actionable defect.
- **Fix:** Minimal: add 057 to the existing '欠番' note in packages/db/migrations/README.md for completeness and keep the 'do not reuse ordinals going forward' convention. No new doc, no code change, no re-numbering needed — the duplicate-009 and state-drift are already documented and the drift is resolved.
