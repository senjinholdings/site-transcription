#!/usr/bin/env npx tsx
/**
 * サイトキャプチャツール
 * 使い方: npx tsx capture.ts <URL> [出力ファイル名]
 * 例: npx tsx capture.ts https://example.com output.png
 */

import { chromium, devices } from 'playwright';
import type { Page } from 'playwright';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

// デバイス設定（iPhone 13 Pro相当）
const DEVICE_PRESET = {
  ...devices['iPhone 13 Pro'],
  deviceScaleFactor: 3,
};

interface CaptureResult {
  finalUrl: string;
  imageBuffer: Buffer;
  pageTitle: string;
  dimensions: { width: number; height: number };
}

/**
 * 手動でセグメントをキャプチャして合成する
 */
async function captureFullPageManually(
  page: Page,
  deviceScaleFactor: number
): Promise<Buffer> {
  const dims = await page.evaluate(() => ({
    docHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
  }));

  const totalHeight = dims.docHeight;
  const viewportHeight = dims.viewportHeight;
  const viewportWidth = dims.viewportWidth;

  const imageWidth = viewportWidth * deviceScaleFactor;
  const segmentImageHeight = viewportHeight * deviceScaleFactor;

  const numSegments = Math.ceil(totalHeight / viewportHeight);
  console.log(`[Capture] ${numSegments} segments, page height: ${totalHeight}px`);

  // 各セグメントをキャプチャ
  const segments: Buffer[] = [];
  for (let i = 0; i < numSegments; i++) {
    let scrollY: number;
    if (i === numSegments - 1) {
      scrollY = Math.max(0, totalHeight - viewportHeight);
    } else {
      scrollY = i * viewportHeight;
    }
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(100);

    const buffer = await page.screenshot({
      fullPage: false,
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      timeout: 60000,
    });
    segments.push(buffer);
    process.stdout.write(`\r[Capture] Segment ${i + 1}/${numSegments}`);
  }
  console.log('');

  const totalImageHeight = totalHeight * deviceScaleFactor;
  console.log(`[Capture] Compositing into ${imageWidth}x${totalImageHeight}px image`);

  const compositeInputs: sharp.OverlayOptions[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (i === segments.length - 1) {
      const yOffset = totalImageHeight - segmentImageHeight;
      compositeInputs.push({
        input: segments[i],
        top: Math.round(Math.max(0, yOffset)),
        left: 0,
      });
    } else {
      const yOffset = i * segmentImageHeight;
      compositeInputs.push({
        input: segments[i],
        top: Math.round(yOffset),
        left: 0,
      });
    }
  }

  const result = await sharp({
    create: {
      width: imageWidth,
      height: Math.round(totalImageHeight),
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(compositeInputs)
    .png()
    .toBuffer();

  return result;
}

/**
 * 固定要素をフリーズするスクリプト
 */
const FREEZE_SCRIPT = `
(function() {
  var STYLE_ID = '__pw-freeze-fixed-sticky-style';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.__pw-freeze-fixed { position: absolute !important; } .__pw-freeze-sticky { position: relative !important; top: auto !important; bottom: auto !important; }';
    document.head.appendChild(style);
  }

  var fixedCount = 0;
  var stickyCount = 0;

  var elements = Array.from(document.querySelectorAll('*'));
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (el === document.documentElement || el === document.body) continue;
    var computed = window.getComputedStyle(el);
    if (computed.display === 'none' || computed.visibility === 'hidden') continue;

    if (computed.position === 'fixed') {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (!el.hasAttribute('data-pw-fixed-sticky-style')) {
        el.setAttribute('data-pw-fixed-sticky-style', el.getAttribute('style') || '');
      }
      var top = rect.top + window.scrollY;
      var left = rect.left + window.scrollX;
      el.classList.add('__pw-freeze-fixed');
      el.style.setProperty('top', top + 'px', 'important');
      el.style.setProperty('left', left + 'px', 'important');
      el.style.setProperty('width', rect.width + 'px', 'important');
      el.style.setProperty('height', rect.height + 'px', 'important');
      fixedCount++;
    } else if (computed.position === 'sticky') {
      if (!el.hasAttribute('data-pw-fixed-sticky-style')) {
        el.setAttribute('data-pw-fixed-sticky-style', el.getAttribute('style') || '');
      }
      el.classList.add('__pw-freeze-sticky');
      stickyCount++;
    }
  }
  return { fixed: fixedCount, sticky: stickyCount };
})()
`;

/**
 * フルページキャプチャを実行
 */
async function captureFullPage(url: string): Promise<CaptureResult> {
  console.log(`[Capture] Starting capture for: ${url}`);

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  });

  const context = await browser.newContext(DEVICE_PRESET);
  const page = await context.newPage();

  try {
    // ページ読み込み
    console.log('[Capture] Navigating to URL...');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    // 遅延読み込みコンテンツをロード
    console.log('[Capture] Loading lazy content...');
    await page.evaluate(() => {
      document.querySelectorAll('img[data-src], img[data-lazy-src]').forEach((img) => {
        const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (dataSrc) img.setAttribute('src', dataSrc);
      });
      document.querySelectorAll('video source[data-src]').forEach((source) => {
        const dataSrc = source.getAttribute('data-src');
        if (dataSrc) {
          source.setAttribute('src', dataSrc);
          (source.parentElement as HTMLVideoElement)?.load();
        }
      });
    });

    // スクロールしてコンテンツをロード
    console.log('[Capture] Auto-scrolling...');
    let lastHeight = 0;
    for (let i = 0; i < 50; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(300);
      const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      if (currentHeight === lastHeight) break;
      lastHeight = currentHeight;
    }

    // トップに戻る
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    // 固定要素をフリーズ
    console.log('[Capture] Freezing fixed elements...');
    const frozenStats = await page.evaluate(FREEZE_SCRIPT);
    console.log(`[Capture] Frozen: fixed=${frozenStats.fixed}, sticky=${frozenStats.sticky}`);

    // スクリーンショット
    console.log('[Capture] Taking screenshot...');
    const imageBuffer = await captureFullPageManually(page, DEVICE_PRESET.deviceScaleFactor);

    const finalUrl = page.url();
    const pageTitle = await page.title();

    // 画像サイズを取得
    const metadata = await sharp(imageBuffer).metadata();

    return {
      finalUrl,
      imageBuffer,
      pageTitle,
      dimensions: {
        width: metadata.width || 0,
        height: metadata.height || 0,
      },
    };
  } finally {
    await context.close();
    await browser.close();
    console.log('[Capture] Browser closed');
  }
}

// メイン処理
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npx tsx capture.ts <URL> [output.png]');
    console.log('Example: npx tsx capture.ts https://example.com screenshot.png');
    process.exit(1);
  }

  const url = args[0];
  const outputFile = args[1] || 'capture.png';
  const outputPath = path.resolve(outputFile);

  try {
    const result = await captureFullPage(url);

    fs.writeFileSync(outputPath, result.imageBuffer);

    console.log('\n=== Capture Complete ===');
    console.log(`URL: ${result.finalUrl}`);
    console.log(`Title: ${result.pageTitle}`);
    console.log(`Size: ${result.dimensions.width}x${result.dimensions.height}px`);
    console.log(`File: ${outputPath}`);
    console.log(`File size: ${(result.imageBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
