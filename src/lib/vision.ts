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

export const RUNE_GRID_COLUMNS = 9;
export const RUNE_GRID_ROWS = 5;

export const RUNE_SLOT_LAYOUT: readonly { column: number; row: number }[] = [
  ...Array.from({ length: 27 }, (_, index) => ({
    column: index % RUNE_GRID_COLUMNS,
    row: Math.floor(index / RUNE_GRID_COLUMNS),
  })),
  { column: 0, row: 3 },
  { column: 1, row: 3 },
  { column: 7, row: 3 },
  { column: 8, row: 3 },
  { column: 0, row: 4 },
  { column: 8, row: 4 },
];

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
  const aspect = RUNE_GRID_COLUMNS / RUNE_GRID_ROWS;
  let cropWidth = width * 0.88;
  let cropHeight = cropWidth / aspect;

  if (cropHeight > height * 0.88) {
    cropHeight = height * 0.88;
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

function createLuma(data: Uint8ClampedArray, width: number, height: number) {
  const luma = new Uint8ClampedArray(width * height);

  for (let index = 0; index < luma.length; index += 1) {
    const sourceIndex = index * 4;
    luma[index] = data[sourceIndex] * 0.299 + data[sourceIndex + 1] * 0.587 + data[sourceIndex + 2] * 0.114;
  }

  return luma;
}

function makeVerticalEdgeProjection(
  luma: Uint8ClampedArray,
  width: number,
  height: number,
  yStart: number,
  yEnd: number,
) {
  const projection = new Float32Array(width);
  const top = Math.max(1, Math.round(yStart));
  const bottom = Math.min(height - 2, Math.round(yEnd));

  for (let x = 1; x < width - 1; x += 1) {
    let score = 0;

    for (let y = top; y <= bottom; y += 1) {
      score += Math.abs(luma[y * width + x + 1] - luma[y * width + x - 1]);
    }

    projection[x] = score / Math.max(1, bottom - top + 1);
  }

  return projection;
}

function makeHorizontalEdgeProjection(
  luma: Uint8ClampedArray,
  width: number,
  height: number,
  xStart: number,
  xEnd: number,
) {
  const projection = new Float32Array(height);
  const left = Math.max(1, Math.round(xStart));
  const right = Math.min(width - 2, Math.round(xEnd));

  for (let y = 1; y < height - 1; y += 1) {
    let score = 0;

    for (let x = left; x <= right; x += 1) {
      score += Math.abs(luma[(y + 1) * width + x] - luma[(y - 1) * width + x]);
    }

    projection[y] = score / Math.max(1, right - left + 1);
  }

  return projection;
}

function localPeak(projection: Float32Array, position: number) {
  const center = Math.round(position);
  let peak = 0;

  for (let index = Math.max(0, center - 3); index <= Math.min(projection.length - 1, center + 3); index += 1) {
    peak = Math.max(peak, projection[index]);
  }

  return peak;
}

function searchRepeatedEdges(
  projection: Float32Array,
  slots: number,
  startMin: number,
  startMax: number,
  pitchMin: number,
  pitchMax: number,
  endMax: number,
) {
  let best = {
    start: 0,
    pitch: 0,
    score: 0,
  };

  for (let pitch = pitchMin; pitch <= pitchMax; pitch += 1) {
    for (let start = startMin; start <= startMax; start += 2) {
      if (start + slots * pitch > endMax) {
        continue;
      }

      let score = 0;

      for (let slot = 0; slot <= slots; slot += 1) {
        score += localPeak(projection, start + slot * pitch);
      }

      for (let slot = 0; slot < slots; slot += 1) {
        score += localPeak(projection, start + slot * pitch + pitch * 0.91) * 0.35;
      }

      const normalized = score / (slots + 1 + slots * 0.35);

      if (normalized > best.score) {
        best = { start, pitch, score: normalized };
      }
    }
  }

  return best;
}

function findRuneGridCrop(context: CanvasRenderingContext2D, width: number, height: number) {
  const fallback = getCenteredCrop(width, height);
  const imageData = context.getImageData(0, 0, width, height).data;
  const luma = createLuma(imageData, width, height);
  const verticalEdges = makeVerticalEdgeProjection(luma, width, height, height * 0.18, height * 0.6);
  const horizontalEdges = makeHorizontalEdgeProjection(luma, width, height, width * 0.06, width * 0.94);
  const xAxis = searchRepeatedEdges(
    verticalEdges,
    RUNE_GRID_COLUMNS,
    width * 0.04,
    width * 0.32,
    width * 0.05,
    width * 0.12,
    width * 0.98,
  );
  const yAxis = searchRepeatedEdges(
    horizontalEdges,
    RUNE_GRID_ROWS,
    height * 0.04,
    height * 0.42,
    height * 0.04,
    height * 0.1,
    height * 0.96,
  );

  if (xAxis.score < 10 || yAxis.score < 10) {
    return fallback;
  }

  return {
    x: xAxis.start,
    y: yAxis.start,
    width: xAxis.pitch * RUNE_GRID_COLUMNS,
    height: yAxis.pitch * RUNE_GRID_ROWS,
  };
}

function digitInkStats(data: Uint8ClampedArray) {
  let brightDigitPixels = 0;
  let veryBrightPixels = 0;
  const pixels = data.length / 4;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const lightness = red * 0.299 + green * 0.587 + blue * 0.114;
    const coolHighlight = green >= red * 0.86 && blue >= red * 0.78;

    if (lightness > 146 && coolHighlight) {
      brightDigitPixels += 1;
    }

    if (lightness > 188) {
      veryBrightPixels += 1;
    }
  }

  return {
    brightRatio: brightDigitPixels / pixels,
    veryBrightRatio: veryBrightPixels / pixels,
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

export async function analyzeRuneTab(imageSrc: string, onProgress?: ProgressCallback): Promise<VisionResult> {
  onProgress?.("Loading image", 0.05);
  const image = await loadImage(imageSrc);
  const { canvas, context } = drawImageToCanvas(image);
  const crop = findRuneGridCrop(context, canvas.width, canvas.height);
  const cellWidth = crop.width / RUNE_GRID_COLUMNS;
  const cellHeight = crop.height / RUNE_GRID_ROWS;
  const reads: RuneRead[] = [];

  onProgress?.("Reading stack counts", 0.1);

  for (let index = 0; index < RUNE_NAMES.length; index += 1) {
    const { column, row } = RUNE_SLOT_LAYOUT[index];
    const cellX = crop.x + column * cellWidth;
    const cellY = crop.y + row * cellHeight;
    const digitCrop = {
      x: cellX + cellWidth * 0.5,
      y: cellY + cellHeight * 0.58,
      width: cellWidth * 0.46,
      height: cellHeight * 0.34,
    };
    const digitImageData = context.getImageData(digitCrop.x, digitCrop.y, digitCrop.width, digitCrop.height);
    const digitStats = imageVariance(digitImageData.data);
    const inkStats = digitInkStats(digitImageData.data);

    let count = 0;
    let method: RuneRead["method"] = "empty";
    let confidence = 0.82;
    let note: string | undefined;

    if (inkStats.brightRatio > 0.018 && (digitStats.deviation > 16 || inkStats.veryBrightRatio > 0.004)) {
      try {
        const digitCanvas = makeDigitCanvas(context, digitCrop.x, digitCrop.y, digitCrop.width, digitCrop.height);
        count = await readDigits(digitCanvas);
      } catch {
        count = 0;
      }

      if (count > 0 && count <= 999) {
        method = "ocr";
        confidence = Math.min(0.98, 0.72 + inkStats.brightRatio * 4 + digitStats.deviation / 140);
      } else {
        count = 0;
        note = "Possible count mark detected, but no digit could be read.";
      }
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
