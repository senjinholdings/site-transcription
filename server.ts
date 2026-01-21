import 'dotenv/config';
import express from 'express';
import { chromium, devices } from 'playwright';
import type { Page } from 'playwright';
import sharp from 'sharp';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { performOcr } from './gemini-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// デバイス設定
const DEVICE_PRESET = {
  ...devices['iPhone 13 Pro'],
  deviceScaleFactor: 3,
};

// ジョブステータス
interface JobStatus {
  status: string;
  progress: number;
  error?: string;
  ocrText?: string;
  ocrChunks?: { current: number; total: number };
}

const captureStatus = new Map<string, JobStatus>();
const captureResults = new Map<string, Buffer>();

/**
 * 手動セグメントキャプチャ
 */
async function captureFullPageManually(
  page: Page,
  deviceScaleFactor: number,
  jobId: string
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

    const progress = Math.round(((i + 1) / numSegments) * 40) + 10;
    captureStatus.set(jobId, { status: 'capturing', progress });
  }

  const totalImageHeight = totalHeight * deviceScaleFactor;

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

  captureStatus.set(jobId, { status: 'compositing', progress: 50 });

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

const FREEZE_SCRIPT = `
(function() {
  var STYLE_ID = '__pw-freeze-fixed-sticky-style';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.__pw-freeze-fixed { position: absolute !important; } .__pw-freeze-sticky { position: relative !important; top: auto !important; bottom: auto !important; }';
    document.head.appendChild(style);
  }
  var fixedCount = 0, stickyCount = 0;
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

// キャプチャAPI
app.post('/api/capture', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  captureStatus.set(jobId, { status: 'starting', progress: 0 });

  res.json({ jobId });

  // バックグラウンドでキャプチャ＋OCR実行
  (async () => {
    let browser;
    try {
      captureStatus.set(jobId, { status: 'launching', progress: 5 });

      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const context = await browser.newContext({
        ...DEVICE_PRESET,
        // 広告からのアクセスをシミュレート
        extraHTTPHeaders: {
          'Referer': 'https://www.google.com/',
          'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });
      const page = await context.newPage();

      captureStatus.set(jobId, { status: 'loading', progress: 10 });

      // ページ読み込み
      await page.goto(url, { waitUntil: 'load', timeout: 120000 });

      // リダイレクト先URLをログ
      const finalUrl = page.url();
      console.log(`[Capture] Requested: ${url}`);
      console.log(`[Capture] Final URL: ${finalUrl}`);

      // JavaScript実行完了を待つ
      await page.waitForTimeout(5000);

      // 遅延読み込みコンテンツ
      await page.evaluate(() => {
        document.querySelectorAll('img[data-src], img[data-lazy-src]').forEach((img) => {
          const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
          if (dataSrc) img.setAttribute('src', dataSrc);
        });
      });

      // スクロール
      for (let i = 0; i < 30; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(200);
      }

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1000);

      // 固定要素フリーズ
      await page.evaluate(FREEZE_SCRIPT);

      // キャプチャ
      const imageBuffer = await captureFullPageManually(page, DEVICE_PRESET.deviceScaleFactor, jobId);
      captureResults.set(jobId, imageBuffer);

      await context.close();
      await browser.close();
      browser = undefined;

      // OCR処理
      captureStatus.set(jobId, { status: 'ocr_starting', progress: 55 });

      if (process.env.GEMINI_API_KEY) {
        try {
          const ocrResult = await performOcr(imageBuffer, {
            onProgress: (current, total) => {
              // OCR抽出: 55-85%
              const ocrProgress = Math.round((current / total) * 30) + 55;
              captureStatus.set(jobId, {
                status: 'ocr_processing',
                progress: ocrProgress,
                ocrChunks: { current, total },
              });
            },
            onStatusChange: (status) => {
              if (status === 'cleaning') {
                // 整形処理: 85-95%
                captureStatus.set(jobId, {
                  status: 'ocr_cleaning',
                  progress: 90,
                });
              }
            },
          });

          captureStatus.set(jobId, {
            status: 'completed',
            progress: 100,
            ocrText: ocrResult.markdown,
          });
        } catch (ocrError: any) {
          console.error('[OCR Error]', ocrError);
          captureStatus.set(jobId, {
            status: 'completed',
            progress: 100,
            ocrText: '',
            error: `OCRエラー: ${ocrError.message}`,
          });
        }
      } else {
        captureStatus.set(jobId, {
          status: 'completed',
          progress: 100,
          ocrText: '',
          error: 'GEMINI_API_KEY が設定されていません',
        });
      }

      // 10分後に結果を削除
      setTimeout(() => {
        captureResults.delete(jobId);
        captureStatus.delete(jobId);
      }, 10 * 60 * 1000);

    } catch (error: any) {
      captureStatus.set(jobId, { status: 'error', progress: 0, error: error.message });
      if (browser) await browser.close();
    }
  })();
});

// 進行状況API
app.get('/api/status/:jobId', (req, res) => {
  const status = captureStatus.get(req.params.jobId);
  if (!status) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(status);
});

// 画像ダウンロードAPI
app.get('/api/download/:jobId', (req, res) => {
  const imageBuffer = captureResults.get(req.params.jobId);
  if (!imageBuffer) {
    return res.status(404).json({ error: 'Image not found' });
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename=capture-${req.params.jobId}.png`);
  res.send(imageBuffer);
});

// 画像プレビューAPI
app.get('/api/preview/:jobId', async (req, res) => {
  const imageBuffer = captureResults.get(req.params.jobId);
  if (!imageBuffer) {
    return res.status(404).json({ error: 'Image not found' });
  }
  const thumbnail = await sharp(imageBuffer)
    .resize(400, undefined, { fit: 'inside' })
    .png()
    .toBuffer();
  res.setHeader('Content-Type', 'image/png');
  res.send(thumbnail);
});

// OCRテキストAPI
app.get('/api/ocr/:jobId', (req, res) => {
  const status = captureStatus.get(req.params.jobId);
  if (!status) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({ text: status.ocrText || '' });
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log(`Site Capture App running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.log('Warning: GEMINI_API_KEY is not set. OCR will not work.');
  }
});
