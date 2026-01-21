import { GoogleGenerativeAI } from "@google/generative-ai";
import sharp from 'sharp';

export interface OcrResult {
  markdown: string;
  modelUsed: string;
  warnings?: string[];
}

// 画像を指定高さで分割
async function splitImage(imageBuffer: Buffer, maxHeight: number = 4000): Promise<Buffer[]> {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    return [imageBuffer];
  }

  if (metadata.height <= maxHeight) {
    return [imageBuffer];
  }

  const chunks: Buffer[] = [];
  const numChunks = Math.ceil(metadata.height / maxHeight);

  console.log(`[Gemini Vision OCR] Splitting image into ${numChunks} chunks (height: ${metadata.height}px)`);

  for (let i = 0; i < numChunks; i++) {
    const top = i * maxHeight;
    const height = Math.min(maxHeight, metadata.height - top);

    const chunk = await sharp(imageBuffer)
      .extract({ left: 0, top, width: metadata.width, height })
      .png()
      .toBuffer();

    chunks.push(chunk);
  }

  return chunks;
}

// リトライ付きでAPIを呼び出す
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 2000
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isRetryable = lastError.message.includes('503') ||
                          lastError.message.includes('overloaded') ||
                          lastError.message.includes('UNAVAILABLE') ||
                          lastError.message.includes('429');
      if (!isRetryable || i === maxRetries - 1) {
        throw lastError;
      }
      console.log(`[Gemini Vision OCR] Retry ${i + 1}/${maxRetries} after error: ${lastError.message.substring(0, 50)}`);
      await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastError;
}

// 単一画像のOCR処理
async function ocrSingleImage(
  ai: GoogleGenerativeAI,
  imageBuffer: Buffer,
  chunkIndex: number,
  totalChunks: number,
  onProgress?: (chunk: number, total: number) => void
): Promise<string> {
  const model = ai.getGenerativeModel({
    model: process.env.GEMINI_OCR_MODEL ?? "gemini-2.0-flash"
  });

  const imageBase64 = imageBuffer.toString('base64');
  const mimeType = 'image/png';

  const prompt = `このスクリーンショットに表示されているすべてのテキストを抽出してください。

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

出力形式: プレーンテキストのみ（テキストがなければ空）`;

  const result = await withRetry(async () => {
    return await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType,
                data: imageBase64,
              },
            },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
      },
    });
  });

  let text = result.response.text().trim();

  // 「テキストがない」系の応答をフィルタリング
  const noTextPatterns = [
    /この画像にはテキストが含まれていません/,
    /テキストは.*ありません/,
    /テキストが存在しません/,
    /テキストを抽出できません/,
    /画像にテキストは見つかりません/,
    /^特にありません/,
    /^なし$/,
  ];

  if (noTextPatterns.some(pattern => pattern.test(text))) {
    text = '';
  }

  console.log(`[Gemini Vision OCR] Chunk ${chunkIndex + 1}/${totalChunks} completed: ${text.length} chars`);
  onProgress?.(chunkIndex + 1, totalChunks);

  return text;
}

// ルールベースの前処理
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

// AIによる後処理（誤字修正・断片結合のみ、順序は維持）
async function postProcessOcr(
  ai: GoogleGenerativeAI,
  rawText: string
): Promise<string> {
  const model = ai.getGenerativeModel({
    model: process.env.GEMINI_OCR_MODEL ?? "gemini-2.0-flash"
  });

  const cleanupPrompt = `以下のOCR抽出テキストを整形してください。

## 重要な制約:
- **テキストの順序は絶対に変更しない**（上から下の順序を厳守）
- **内容の削除・省略・まとめは禁止**
- **構造化・再編成は禁止**

## 許可される処理:
1. **誤字修正**: OCRの明らかな誤認識のみ修正（例：「休舌」→「体重」）
2. **断片結合**: 不自然に分割された数値や単語を結合（例：「1,」「000円」→「1,000円」）
3. **改行整理**: 不自然な改行を適切に調整

## 出力形式:
- プレーンテキストで出力（マークダウン装飾は不要）
- 元のテキストの出現順序をそのまま維持
- ボタンやラベルのテキストも削除せずそのまま残す

## 入力テキスト:
${rawText}

## 整形後のテキスト（順序維持）:`;

  try {
    const result = await withRetry(async () => {
      return await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: cleanupPrompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
        },
      });
    });

    return result.response.text().trim();
  } catch (error) {
    console.error('[Gemini Vision OCR] Post-processing failed, returning pre-cleaned text:', error);
    // 後処理に失敗した場合は前処理済みテキストをそのまま返す
    return rawText;
  }
}

export async function performOcr(
  imageBuffer: Buffer,
  options: {
    onProgress?: (chunk: number, total: number) => void;
    onStatusChange?: (status: 'extracting' | 'cleaning') => void;
  } = {}
): Promise<OcrResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY が設定されていません。.env ファイルを確認してください。");
  }

  console.log('[Gemini Vision OCR] Starting OCR process...');
  console.log('[Gemini Vision OCR] Image size:', imageBuffer.length, 'bytes');

  const ai = new GoogleGenerativeAI(apiKey);
  const startTime = Date.now();

  try {
    const chunks = await splitImage(imageBuffer, 4000);
    const totalChunks = chunks.length;

    let allTexts: string[];

    if (totalChunks === 1) {
      const text = await ocrSingleImage(ai, chunks[0], 0, 1, options.onProgress);
      allTexts = [text];
    } else {
      console.log(`[Gemini Vision OCR] Processing ${totalChunks} chunks in parallel...`);

      const promises = chunks.map((chunk, index) =>
        ocrSingleImage(ai, chunk, index, totalChunks, options.onProgress)
      );

      allTexts = await Promise.all(promises);
    }

    const combinedText = allTexts.join('\n\n');
    console.log(`[Gemini Vision OCR] Raw extraction completed: ${combinedText.length} chars`);

    // Step 1: ルールベースの前処理
    console.log('[Gemini Vision OCR] Applying pre-clean rules...');
    const preCleanedText = preCleanOcr(combinedText);
    console.log(`[Gemini Vision OCR] Pre-cleaned: ${preCleanedText.length} chars`);

    // Step 2: AIによる後処理（整形・重複削除・構造化）
    options.onStatusChange?.('cleaning');
    console.log('[Gemini Vision OCR] Starting AI post-processing...');
    const cleanedText = await postProcessOcr(ai, preCleanedText);
    console.log(`[Gemini Vision OCR] Post-processed: ${cleanedText.length} chars`);

    const elapsed = Date.now() - startTime;
    console.log(`[Gemini Vision OCR] Success! Final output ${cleanedText.length} chars in ${elapsed}ms`);

    return {
      markdown: cleanedText,
      modelUsed: process.env.GEMINI_OCR_MODEL ?? "gemini-2.0-flash",
      warnings: totalChunks > 1 ? [`画像を${totalChunks}分割して処理しました`] : [],
    };
  } catch (error) {
    console.error('[Gemini Vision OCR] Failed:', error);

    if (error instanceof Error) {
      if (error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('quota')) {
        throw new Error('Gemini API のクォータ制限に達しました。しばらく待ってから再試行してください。');
      }
      if (error.message.includes('too large') || error.message.includes('size')) {
        throw new Error('画像サイズが大きすぎます。ページを分割してキャプチャしてください。');
      }
      throw error;
    }

    throw new Error(`OCR処理に失敗しました: ${String(error)}`);
  }
}
