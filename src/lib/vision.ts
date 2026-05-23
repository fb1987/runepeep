import { createWorker } from "tesseract.js";
import { RUNE_NAMES, type RuneName } from "./runewords";

export type RuneRead = {
  rune: RuneName;
  count: number;
  confidence: number;
  method: "ocr" | "visual" | "empty";
  note?: string;
};

export type VisionResult = {
  reads: RuneRead[];
  imageSize: {
    width: number;
    height: number;
  };
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type ProgressCallback = (message: string, value: number) => void;

const columns = 9;
const rows = 4;

let workerPromise: ReturnType<typeof createDigitWorker> | null = null;

async function createDigitWorker() {
  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: "7",
  } as Record<string, string>);
  return worker;
}

function getDigitWorker() {
  workerPromise ??= createDigitWorker();
  return workerPromise;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image."));
    image.src = src;
  });
}

function getCenteredCrop(width: number, height: number) {
  const aspect = columns / rows;
  let cropWidth = width * 0.92;
  let cropHeight = cropWidth / aspect;

  if (cropHeight > height * 0.86) {
    cropHeight = height * 0.86;
    cropWidth = cropHeight * aspect;
  }

  return {
    x: (width - cropWidth) / 2,
    y: (height - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight,
  };
}

function drawImageToCanvas(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is not available.");
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

function imageVariance(data: Uint8ClampedArray) {
  let sum = 0;
  let sumSquared = 0;
  let brightPixels = 0;
  const pixels = data.length / 4;

  for (let index = 0; index < data.length; index += 4) {
    const lightness = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    sum += lightness;
    sumSquared += lightness * lightness;
    if (lightness > 155) {
      brightPixels += 1;
    }
  }

  const mean = sum / pixels;
  const variance = Math.max(0, sumSquared / pixels - mean * mean);
  return {
    mean,
    deviation: Math.sqrt(variance),
    brightRatio: brightPixels / pixels,
  };
}

function makeDigitCanvas(
  source: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = 6;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(80, Math.round(width * scale));
  canvas.height = Math.max(48, Math.round(height * scale));

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is not available.");
  }

  context.imageSmoothingEnabled = false;
  context.drawImage(source.canvas, x, y, width, height, 0, 0, canvas.width, canvas.height);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let index = 0; index < data.length; index += 4) {
    const lightness = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const alpha = lightness > 118 ? 255 : 0;
    data[index] = alpha;
    data[index + 1] = alpha;
    data[index + 2] = alpha;
    data[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

async function readDigits(canvas: HTMLCanvasElement) {
  const worker = await getDigitWorker();
  const result = await worker.recognize(canvas);
  const digits = result.data.text.replace(/\D/g, "");

  if (!digits) {
    return 0;
  }

  const parsed = Number.parseInt(digits.slice(0, 3), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getVisualScore(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const insetX = width * 0.18;
  const insetY = height * 0.18;
  const imageData = context.getImageData(x + insetX, y + insetY, width - insetX * 2, height - insetY * 2);
  const stats = imageVariance(imageData.data);
  return stats.deviation / 42 + stats.brightRatio * 1.4;
}

export async function analyzeRuneTab(imageSrc: string, onProgress?: ProgressCallback): Promise<VisionResult> {
  onProgress?.("Loading image", 0.05);
  const image = await loadImage(imageSrc);
  const { canvas, context } = drawImageToCanvas(image);
  const crop = getCenteredCrop(canvas.width, canvas.height);
  const cellWidth = crop.width / columns;
  const cellHeight = crop.height / rows;
  const reads: RuneRead[] = [];

  onProgress?.("Reading stack counts", 0.1);

  for (let index = 0; index < RUNE_NAMES.length; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = crop.x + column * cellWidth;
    const cellY = crop.y + row * cellHeight;
    const visualScore = getVisualScore(context, cellX, cellY, cellWidth, cellHeight);
    const digitCrop = {
      x: cellX + cellWidth * 0.42,
      y: cellY + cellHeight * 0.56,
      width: cellWidth * 0.52,
      height: cellHeight * 0.36,
    };
    const digitStats = imageVariance(
      context.getImageData(digitCrop.x, digitCrop.y, digitCrop.width, digitCrop.height).data,
    );

    let count = 0;
    let method: RuneRead["method"] = "empty";
    let confidence = 0.82;
    let note: string | undefined;

    if (digitStats.brightRatio > 0.012 || digitStats.deviation > 22) {
      try {
        const digitCanvas = makeDigitCanvas(context, digitCrop.x, digitCrop.y, digitCrop.width, digitCrop.height);
        count = await readDigits(digitCanvas);
      } catch {
        count = 0;
      }

      if (count > 0) {
        method = "ocr";
        confidence = Math.min(0.98, 0.68 + digitStats.brightRatio * 5 + digitStats.deviation / 120);
      }
    }

    if (count === 0 && visualScore > 1.05) {
      count = 1;
      method = "visual";
      confidence = Math.min(0.74, 0.48 + visualScore / 5);
      note = "No readable stack number; treating visible rune art as one.";
    }

    reads.push({
      rune: RUNE_NAMES[index],
      count,
      confidence,
      method,
      note,
    });

    onProgress?.(`Reading ${RUNE_NAMES[index]}`, 0.1 + ((index + 1) / RUNE_NAMES.length) * 0.86);
  }

  onProgress?.("Done", 1);

  return {
    reads,
    imageSize: {
      width: canvas.width,
      height: canvas.height,
    },
    crop,
  };
}
