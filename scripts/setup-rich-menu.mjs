#!/usr/bin/env node
/**
 * naturism リッチメニュー セットアップスクリプト
 *
 * 使い方:
 *   node scripts/setup-rich-menu.mjs <API_KEY>
 *
 * やること:
 *   1. リッチメニュー構造を作成
 *   2. SVG→PNG 画像を生成してアップロード
 *   3. デフォルトに設定
 */

const API_KEY = process.argv[2];
if (!API_KEY) {
  console.error('Usage: node scripts/setup-rich-menu.mjs <API_KEY>');
  process.exit(1);
}

const WORKER_URL = 'https://naturism-line-crm.katsu-7d5.workers.dev';
const headers = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

async function main() {
  console.log('🌿 naturism リッチメニュー セットアップ開始...\n');

  // Step 1: セットアップ
  console.log('Step 1: リッチメニュー構造を作成中...');
  const setupRes = await fetch(`${WORKER_URL}/api/rich-menus/setup-naturism`, {
    method: 'POST',
    headers,
  });
  const setupData = await setupRes.json();

  if (!setupData.success) {
    console.error('❌ 作成失敗:', setupData.error);
    process.exit(1);
  }

  const richMenuId = setupData.data.richMenuId;
  console.log(`✅ 作成成功: ${richMenuId}`);
  console.log(`✅ デフォルトに設定済み\n`);

  // Step 2: 画像生成（シンプルなPNG）
  console.log('Step 2: メニュー画像を生成中...');

  // SVGを生成して、LINE APIに直接アップロード
  const svg = generateMenuSVG();

  // SVG をそのままアップロードはできないので、ガイドを表示
  console.log(`\n⚠️  画像のアップロードが必要です。`);
  console.log(`\n   以下のURLをブラウザで開いてスクリーンショットを撮ってください:`);
  console.log(`   ${WORKER_URL}/api/rich-menus/image-guide`);
  console.log(`\n   撮ったスクリーンショット（2500x1686px）を以下のコマンドでアップロード:`);
  console.log(`   curl -X POST "${WORKER_URL}/api/rich-menus/${richMenuId}/image" \\`);
  console.log(`     -H "Authorization: Bearer ${API_KEY}" \\`);
  console.log(`     -H "Content-Type: image/png" \\`);
  console.log(`     --data-binary @richmenu.png`);

  console.log(`\n🎉 リッチメニューID: ${richMenuId}`);
  console.log(`\n📋 セットアップ完了。画像をアップロードするとLINEに表示されます。`);
}

function generateMenuSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2500" height="1686">
    <defs>
      <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#06C755"/><stop offset="100%" stop-color="#05a847"/></linearGradient>
      <linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#05a847"/><stop offset="100%" stop-color="#049a3f"/></linearGradient>
      <linearGradient id="g3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#049a3f"/><stop offset="100%" stop-color="#038c37"/></linearGradient>
      <linearGradient id="g4" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#15803d"/><stop offset="100%" stop-color="#166534"/></linearGradient>
      <linearGradient id="g5" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#166534"/><stop offset="100%" stop-color="#14532d"/></linearGradient>
      <linearGradient id="g6" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#14532d"/><stop offset="100%" stop-color="#052e16"/></linearGradient>
    </defs>
    <rect x="0" y="0" width="833" height="843" fill="url(#g1)"/>
    <rect x="833" y="0" width="834" height="843" fill="url(#g2)"/>
    <rect x="1667" y="0" width="833" height="843" fill="url(#g3)"/>
    <rect x="0" y="843" width="833" height="843" fill="url(#g4)"/>
    <rect x="833" y="843" width="834" height="843" fill="url(#g5)"/>
    <rect x="1667" y="843" width="833" height="843" fill="url(#g6)"/>
    <style>text{font-family:'Hiragino Sans',sans-serif;fill:#fff;text-anchor:middle}</style>
    <text x="416" y="380" font-size="72">💊</text><text x="416" y="460" font-size="48" font-weight="bold">3種類の違い</text><text x="416" y="520" font-size="28" opacity="0.7">Blue・Pink・Premium</text>
    <text x="1250" y="380" font-size="72">🔍</text><text x="1250" y="460" font-size="48" font-weight="bold">おすすめ診断</text><text x="1250" y="520" font-size="28" opacity="0.7">あなたに合うのは？</text>
    <text x="2083" y="380" font-size="72">🛒</text><text x="2083" y="460" font-size="48" font-weight="bold">購入する</text><text x="2083" y="520" font-size="28" opacity="0.7">公式ストアへ</text>
    <text x="416" y="1223" font-size="72">❓</text><text x="416" y="1303" font-size="48" font-weight="bold">よくある質問</text><text x="416" y="1363" font-size="28" opacity="0.7">FAQ</text>
    <text x="1250" y="1223" font-size="72">🤖</text><text x="1250" y="1303" font-size="48" font-weight="bold">AI相談</text><text x="1250" y="1363" font-size="28" opacity="0.7">何でも聞いてね</text>
    <text x="2083" y="1223" font-size="72">📧</text><text x="2083" y="1303" font-size="48" font-weight="bold">お問い合わせ</text><text x="2083" y="1363" font-size="28" opacity="0.7">info@kenkoex.com</text>
  </svg>`;
}

main().catch(console.error);
