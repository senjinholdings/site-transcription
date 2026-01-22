# Site Transcription 仕様書

フルページWebサイトキャプチャ＆OCR文字起こしツール

---

## 概要

指定したURLのWebページをフルページキャプチャし、Gemini Vision APIを使用してテキストを抽出するツール。

### 本番URL
https://site-transcription-592499304231.asia-northeast1.run.app

---

## システム構成

### 技術スタック

| 項目 | 技術 |
|------|------|
| サーバー | Express.js (Node.js) |
| ブラウザ自動化 | Playwright + Stealth Plugin |
| 画像処理 | Sharp |
| OCR | Gemini Vision API (gemini-2.0-flash) |
| ストレージ | Google Cloud Storage |
| ホスティング | Google Cloud Run |

### 依存関係

```json
{
  "@google-cloud/storage": "^7.18.0",
  "@google/generative-ai": "^0.21.0",
  "playwright": "1.52.0",
  "playwright-extra": "^4.3.6",
  "puppeteer-extra-plugin-stealth": "^2.11.2",
  "sharp": "^0.34.0"
}
```

---

## 処理フロー

### 全体フロー図

```
[ユーザー] → [URLを入力] → [サーバー]
                              ↓
                    [1. ブラウザ起動]
                              ↓
                    [2. ページ読み込み]
                              ↓
                    [3. コンテンツ待機]
                        - 遅延読み込み画像
                        - 動画再生開始
                        - スクロールトリガー
                              ↓
                    [4. 固定要素フリーズ]
                              ↓
                    [5. セグメントキャプチャ]
                              ↓
                    [6. 画像合成]
                              ↓
                    [7. Cloud Storage保存]
                              ↓
                    [8. OCR処理]
                        - 画像分割
                        - テキスト抽出
                        - 後処理整形
                              ↓
                    [9. 結果返却]
```

---

## Phase 1: ページキャプチャ

### 1.1 ブラウザ設定

```typescript
const DEVICE_PRESET = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,              // Retina相当
  userAgent: 'Chrome/120.0.0.0',
  isMobile: false,
  hasTouch: false,
};
```

| 設定 | 値 | 理由 |
|------|-----|------|
| viewport幅 | 1280px | デスクトップ向けLPの標準幅 |
| viewport高さ | 800px | セグメント分割の基準 |
| deviceScaleFactor | 2 | 高解像度キャプチャ |
| isMobile | false | デスクトップ表示を取得 |

### 1.2 HTTPヘッダー

```typescript
extraHTTPHeaders: {
  'Referer': 'https://www.google.com/',
  'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
}
```

- **Referer**: 広告LPが正しく表示されるよう、Google検索からの流入をシミュレート
- **Accept-Language**: 日本語コンテンツを優先

### 1.3 ボット検出回避

```typescript
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(StealthPlugin());
```

- Playwright + Stealth Plugin で自動化検出を回避
- WebDriver検出、Chrome DevTools Protocol検出などをバイパス

### 1.4 ページ読み込み

```typescript
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForTimeout(5000);  // JS実行完了待機
```

- タイムアウト: 120秒
- 追加待機: 5秒（JavaScript実行完了）

### 1.5 遅延読み込みコンテンツの処理

#### 画像の遅延読み込み対応

```typescript
document.querySelectorAll('img[data-src], img[data-lazy-src]').forEach((img) => {
  const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
  if (dataSrc) img.setAttribute('src', dataSrc);
});
```

#### 動画の再生開始（GIF風MP4対応）

```typescript
const videos = document.querySelectorAll('video');
videos.forEach(async (video) => {
  video.muted = true;
  await video.play();
  // readyState >= 2 (HAVE_CURRENT_DATA) まで待機
});
```

- `muted = true`: ブラウザの自動再生ポリシー対策
- タイムアウト: 3秒

#### スクロールによるコンテンツ読み込み

```typescript
for (let i = 0; i < 30; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  await page.waitForTimeout(200);
}
await page.evaluate(() => window.scrollTo(0, 0));
```

- 30回スクロール（約24000px分）
- 200ms間隔で遅延読み込みをトリガー

### 1.6 固定要素のフリーズ

フルページキャプチャ時に`position: fixed`や`position: sticky`の要素が重複表示されるのを防止。

```typescript
// fixed要素 → absolute に変換して現在位置に固定
if (computed.position === 'fixed') {
  el.classList.add('__pw-freeze-fixed');
  el.style.setProperty('top', (rect.top + window.scrollY) + 'px', 'important');
  el.style.setProperty('left', (rect.left + window.scrollX) + 'px', 'important');
}

// sticky要素 → relative に変換
if (computed.position === 'sticky') {
  el.classList.add('__pw-freeze-sticky');
}
```

### 1.7 セグメントキャプチャ

ページ全体を1枚の画像としてキャプチャするため、セグメント分割方式を採用。

```
[ページ全体]
    ↓
[セグメント1] viewport高さ分
[セグメント2] viewport高さ分
[セグメント3] viewport高さ分
    ...
[セグメントN] 残り部分
    ↓
[Sharp で合成] → 1枚の画像
```

```typescript
const numSegments = Math.ceil(totalHeight / viewportHeight);

for (let i = 0; i < numSegments; i++) {
  const scrollY = i === numSegments - 1
    ? Math.max(0, totalHeight - viewportHeight)  // 最後は端から
    : i * viewportHeight;

  await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  const buffer = await page.screenshot({ fullPage: false, type: 'png' });
  segments.push(buffer);
}
```

### 1.8 画像合成

```typescript
const result = await sharp({
  create: {
    width: imageWidth,
    height: totalImageHeight,
    channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  },
})
  .composite(compositeInputs)  // セグメントを重ねる
  .png()
  .toBuffer();
```

---

## Phase 2: 画像保存

### 2.1 Cloud Storage アップロード

```typescript
const BUCKET_NAME = 'site-transcription-captures';
```

### 2.2 画像最適化

| 処理 | 値 | 理由 |
|------|-----|------|
| フォーマット | JPEG | PNG比で70-80%サイズ削減 |
| 品質 | 85 | 視認性とサイズのバランス |
| 最大高さ | 16000px | JPEG形式の制限対策 |

```typescript
const compressedBuffer = await sharp(buffer)
  .resize({ height: maxHeight, withoutEnlargement: true })
  .jpeg({ quality: 85 })
  .toBuffer();
```

### 2.3 ファイル管理

- ファイル名: `{jobId}.jpg`
- ライフサイクル: Cloud Storageのライフサイクルポリシーで自動削除
- ジョブステータス: 1時間後にメモリから削除

---

## Phase 3: OCR処理

### 3.1 使用モデル

```typescript
model: process.env.GEMINI_OCR_MODEL ?? "gemini-2.0-flash"
```

- デフォルト: `gemini-2.0-flash`
- 環境変数で変更可能

### 3.2 画像分割

長いページは4000px単位で分割して並列処理。

```typescript
const chunks = await splitImage(imageBuffer, 4000);
const allTexts = await Promise.all(
  chunks.map((chunk, index) => ocrSingleImage(ai, chunk, index, totalChunks))
);
```

| 設定 | 値 |
|------|-----|
| 分割単位 | 4000px |
| 処理方式 | 並列（Promise.all） |

### 3.3 テキスト抽出プロンプト

```
このスクリーンショットに表示されているすべてのテキストを抽出してください。

## 重要: 以下のテキストもすべて抽出すること
- バナー画像・広告画像の中に書かれているテキスト
- ロゴ画像の中のテキスト
- インフォグラフィック・図解の中のテキスト
- 写真に重ねて表示されているテキスト
- ボタン・アイコンの中のテキスト
- 装飾的なキャッチコピー・見出し

## 要件:
- 画面に見えているテキストは、HTMLテキストでも画像内テキストでも、すべて抽出する
- テキストの読み順（上から下、左から右）を維持する
- 段落やセクションの区切りは空行で表現する
- 表がある場合は、セル内のテキストを行ごとに抽出する
- 抽出したテキストのみを出力し、説明や前置きは不要
- テキストが存在しない場合は、何も出力せず空のまま返す
```

### 3.4 前処理（ルールベース）

```typescript
function preCleanOcr(text: string): string {
  return text
    // よくあるOCR誤字を修正
    .replace(/休舌/g, '体重')
    .replace(/內臟|内臟/g, '内臓')
    .replace(/㎡/g, '㎠')
    // 数値の断片化を修正
    .replace(/(\d+\.?\d*)\n(kg|円|%|cm|㎠)/g, '$1$2')
    // 連続空行を2つまでに制限
    .replace(/\n{4,}/g, '\n\n\n')
    // 行頭・行末の不要スペースを削除
    .split('\n').map(line => line.trim()).join('\n');
}
```

### 3.5 後処理（AI整形）

```
以下のOCR抽出テキストの改行を整理してください。

## 重要な制約:
- テキストの順序は絶対に変更しない（上から下の順序を厳守）
- 内容の削除・省略・要約は絶対禁止
- 構造化・再編成は禁止

## 必須の処理:
1. 文章の結合: 意味的に繋がっている文章を1行にまとめる
   - 例: 「肥満気味\nな方へ」→「肥満気味な方へ」
   - 例: 「1,000円\nOFF」→「1,000円OFF」

2. 段落の区切り: 異なるセクション・話題の間は空行で区切る

3. 誤字修正: OCRの明らかな誤認識のみ修正
```

### 3.6 リトライ機構

```typescript
async function withRetry<T>(fn, maxRetries = 3, delayMs = 2000): Promise<T> {
  // リトライ対象エラー: 503, overloaded, UNAVAILABLE, 429
  // 遅延: 2秒 × (リトライ回数 + 1)
}
```

| 設定 | 値 |
|------|-----|
| 最大リトライ | 3回 |
| 基本遅延 | 2秒 |
| 遅延増加 | 線形（2秒, 4秒, 6秒） |

### 3.7 Gemini API設定

```typescript
generationConfig: {
  temperature: 0.1,      // 抽出時（低温で正確性重視）
  // temperature: 0.2,   // 後処理時
  maxOutputTokens: 8192,
}
```

---

## API仕様

### POST /api/capture

キャプチャジョブを開始する。

**リクエスト**
```json
{
  "url": "https://example.com"
}
```

**レスポンス**
```json
{
  "jobId": "m1abc123xyz"
}
```

### GET /api/status/:jobId

ジョブの進行状況を取得する。

**レスポンス**
```json
{
  "status": "ocr_processing",
  "progress": 75,
  "ocrChunks": { "current": 3, "total": 4 }
}
```

**ステータス一覧**

| status | progress | 説明 |
|--------|----------|------|
| starting | 0 | ジョブ開始 |
| launching | 5 | ブラウザ起動中 |
| loading | 10 | ページ読み込み中 |
| capturing | 10-50 | セグメントキャプチャ中 |
| compositing | 50 | 画像合成中 |
| ocr_starting | 55 | OCR開始 |
| ocr_processing | 55-85 | OCRテキスト抽出中 |
| ocr_cleaning | 90 | OCR後処理中 |
| completed | 100 | 完了 |
| error | 0 | エラー発生 |

### GET /api/download/:jobId

キャプチャ画像をダウンロードする。

**レスポンス**: JPEG画像バイナリ

### GET /api/preview/:jobId

サムネイル画像を取得する（幅400px）。

**レスポンス**: PNG画像バイナリ

### GET /api/ocr/:jobId

OCRテキストを取得する。

**レスポンス**
```json
{
  "text": "抽出されたテキスト..."
}
```

---

## 制限事項

### 技術的制限

| 項目 | 制限 | 対策 |
|------|------|------|
| 画像高さ | 16000px | 超過時は自動リサイズ |
| Cloud Runレスポンス | 32MB | JPEG圧縮で対応 |
| ページ読み込み | 120秒 | タイムアウトでエラー |
| OCRチャンク | 4000px単位 | 自動分割 |

### キャプチャできないコンテンツ

| コンテンツ | 理由 |
|------------|------|
| ログイン必須ページ | 認証が必要 |
| CAPTCHAページ | 自動化検出 |
| iframe内コンテンツ | クロスオリジン制限 |
| Flash/Silverlight | 非対応形式 |

### OCRの限界

| ケース | 対応状況 |
|--------|----------|
| 手書き文字 | 認識精度が低下 |
| 極小文字 | 読み取り困難 |
| 複雑な表組み | 構造が崩れる可能性 |
| 縦書きテキスト | 部分的にサポート |

---

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| GEMINI_API_KEY | ○ | Gemini API キー |
| GEMINI_OCR_MODEL | - | OCRモデル（デフォルト: gemini-2.0-flash） |
| PORT | - | サーバーポート（デフォルト: 3100） |
| GOOGLE_APPLICATION_CREDENTIALS | ○ | GCP認証情報 |

---

## バージョン履歴

| バージョン | 日付 | 変更内容 |
|------------|------|----------|
| 1.0.0 | - | 初期リリース |
| 1.1.0 | - | Cloud Storage対応、JPEG圧縮追加 |
| 1.2.0 | - | デスクトップviewport変更（1280px） |
| 1.3.0 | - | 動画再生待機処理追加（GIF風MP4対応） |
| 1.4.0 | - | OCR改行結合処理追加 |

---

**最終更新**: 2026-01-22
