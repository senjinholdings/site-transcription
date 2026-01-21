# Site Capture App

フルページサイトキャプチャツール。モバイル（iPhone 13 Pro）表示でサイト全体をキャプチャします。

## セットアップ

```bash
cd ~/Desktop/site-capture-app
pnpm install
npx playwright install chromium
```

## 使い方

```bash
# 基本的な使い方
npx tsx capture.ts <URL> [出力ファイル名]

# 例
npx tsx capture.ts https://example.com
npx tsx capture.ts https://example.com screenshot.png
```

## 特徴

- モバイル表示（iPhone 13 Pro、deviceScaleFactor: 3）
- 遅延読み込み画像の自動ロード
- 固定要素（position: fixed/sticky）の適切な処理
- 手動セグメントキャプチャ＋合成（Playwrightのfullpage問題を回避）
