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

type Point = {
  x: number;
  y: number;
};

type VerticalGridLine = {
  a: number;
  b: number;
};

type HorizontalGridLine = {
  c: number;
  d: number;
};

type CellCorners = {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
};

type RuneGridModel = {
  crop: VisionResult["crop"];
  verticalLines: VerticalGridLine[];
  horizontalLines: HorizontalGridLine[];
};

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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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

function verticalEdgeAt(luma: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const px = clamp(Math.round(x), 1, width - 2);
  const py = clamp(Math.round(y), 1, height - 2);
  let score = 0;

  for (let offset = -1; offset <= 1; offset += 1) {
    const row = clamp(py + offset, 1, height - 2);
    score += Math.abs(luma[row * width + px + 1] - luma[row * width + px - 1]);
  }

  return score / 3;
}

function horizontalEdgeAt(luma: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const px = clamp(Math.round(x), 1, width - 2);
  const py = clamp(Math.round(y), 1, height - 2);
  let score = 0;

  for (let offset = -1; offset <= 1; offset += 1) {
    const column = clamp(px + offset, 1, width - 2);
    score += Math.abs(luma[(py + 1) * width + column] - luma[(py - 1) * width + column]);
  }

  return score / 3;
}

function fitXFromY(points: Point[], fallbackX: number): VerticalGridLine {
  if (points.length < 2) {
    return { a: 0, b: fallbackX };
  }

  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  let numerator = 0;
  let denominator = 0;

  for (const point of points) {
    numerator += (point.y - meanY) * (point.x - meanX);
    denominator += (point.y - meanY) ** 2;
  }

  if (denominator < 0.001) {
    return { a: 0, b: fallbackX };
  }

  const a = numerator / denominator;
  return {
    a,
    b: meanX - a * meanY,
  };
}

function fitYFromX(points: Point[], fallbackY: number): HorizontalGridLine {
  if (points.length < 2) {
    return { c: 0, d: fallbackY };
  }

  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;

  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }

  if (denominator < 0.001) {
    return { c: 0, d: fallbackY };
  }

  const c = numerator / denominator;
  return {
    c,
    d: meanY - c * meanX,
  };
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

function findRuneGridModel(context: CanvasRenderingContext2D, width: number, height: number): RuneGridModel {
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

  const crop =
    xAxis.score < 10 || yAxis.score < 10
      ? fallback
      : {
    x: xAxis.start,
    y: yAxis.start,
    width: xAxis.pitch * RUNE_GRID_COLUMNS,
    height: yAxis.pitch * RUNE_GRID_ROWS,
        };

  return refineRuneGridModel(luma, width, height, crop);
}

function refineRuneGridModel(
  luma: Uint8ClampedArray,
  width: number,
  height: number,
  crop: VisionResult["crop"],
): RuneGridModel {
  const cellWidth = crop.width / RUNE_GRID_COLUMNS;
  const cellHeight = crop.height / RUNE_GRID_ROWS;
  const verticalLines: VerticalGridLine[] = [];
  const horizontalLines: HorizontalGridLine[] = [];
  const sampleCount = 7;

  for (let column = 0; column <= RUNE_GRID_COLUMNS; column += 1) {
    const expectedX = crop.x + column * cellWidth;
    const searchRadius = Math.max(5, Math.round(cellWidth * 0.18));
    const points: Point[] = [];

    for (let sample = 0; sample < sampleCount; sample += 1) {
      const y = crop.y + cellHeight * 0.15 + (sample / (sampleCount - 1)) * cellHeight * (RUNE_GRID_ROWS - 0.3);
      let bestScore = 0;
      let bestX = expectedX;

      for (let x = expectedX - searchRadius; x <= expectedX + searchRadius; x += 1) {
        const score = verticalEdgeAt(luma, width, height, x, y);

        if (score > bestScore) {
          bestScore = score;
          bestX = x;
        }
      }

      if (bestScore > 8) {
        points.push({ x: bestX, y });
      }
    }

    verticalLines.push(fitXFromY(points, expectedX));
  }

  for (let row = 0; row <= RUNE_GRID_ROWS; row += 1) {
    const expectedY = crop.y + row * cellHeight;
    const searchRadius = Math.max(5, Math.round(cellHeight * 0.18));
    const points: Point[] = [];

    for (let sample = 0; sample < sampleCount; sample += 1) {
      const x = crop.x + cellWidth * 0.1 + (sample / (sampleCount - 1)) * cellWidth * (RUNE_GRID_COLUMNS - 0.2);
      let bestScore = 0;
      let bestY = expectedY;

      for (let y = expectedY - searchRadius; y <= expectedY + searchRadius; y += 1) {
        const score = horizontalEdgeAt(luma, width, height, x, y);

        if (score > bestScore) {
          bestScore = score;
          bestY = y;
        }
      }

      if (bestScore > 8) {
        points.push({ x, y: bestY });
      }
    }

    horizontalLines.push(fitYFromX(points, expectedY));
  }

  return {
    crop,
    verticalLines,
    horizontalLines,
  };
}

function intersectGridLines(vertical: VerticalGridLine, horizontal: HorizontalGridLine): Point {
  const denominator = 1 - vertical.a * horizontal.c;
  const x = Math.abs(denominator) < 0.0001 ? vertical.b : (vertical.a * horizontal.d + vertical.b) / denominator;

  return {
    x,
    y: horizontal.c * x + horizontal.d,
  };
}

function getCellCorners(model: RuneGridModel, column: number, row: number): CellCorners {
  return {
    topLeft: intersectGridLines(model.verticalLines[column], model.horizontalLines[row]),
    topRight: intersectGridLines(model.verticalLines[column + 1], model.horizontalLines[row]),
    bottomRight: intersectGridLines(model.verticalLines[column + 1], model.horizontalLines[row + 1]),
    bottomLeft: intersectGridLines(model.verticalLines[column], model.horizontalLines[row + 1]),
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

function cellPoint(corners: CellCorners, u: number, v: number): Point {
  const topX = corners.topLeft.x + (corners.topRight.x - corners.topLeft.x) * u;
  const topY = corners.topLeft.y + (corners.topRight.y - corners.topLeft.y) * u;
  const bottomX = corners.bottomLeft.x + (corners.bottomRight.x - corners.bottomLeft.x) * u;
  const bottomY = corners.bottomLeft.y + (corners.bottomRight.y - corners.bottomLeft.y) * u;

  return {
    x: topX + (bottomX - topX) * v,
    y: topY + (bottomY - topY) * v,
  };
}

function sampleSourcePixel(data: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const left = clamp(Math.floor(x), 0, width - 1);
  const right = clamp(left + 1, 0, width - 1);
  const top = clamp(Math.floor(y), 0, height - 1);
  const bottom = clamp(top + 1, 0, height - 1);
  const xWeight = clamp(x - left, 0, 1);
  const yWeight = clamp(y - top, 0, 1);
  const result = [0, 0, 0, 255];

  for (let channel = 0; channel < 3; channel += 1) {
    const topLeft = data[(top * width + left) * 4 + channel];
    const topRight = data[(top * width + right) * 4 + channel];
    const bottomLeft = data[(bottom * width + left) * 4 + channel];
    const bottomRight = data[(bottom * width + right) * 4 + channel];
    const topValue = topLeft + (topRight - topLeft) * xWeight;
    const bottomValue = bottomLeft + (bottomRight - bottomLeft) * xWeight;
    result[channel] = topValue + (bottomValue - topValue) * yWeight;
  }

  return result;
}

function makeNormalizedDigitRegion(
  sourceData: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  corners: CellCorners,
) {
  const outputWidth = 112;
  const outputHeight = 72;
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is not available.");
  }

  const imageData = context.createImageData(outputWidth, outputHeight);
  const data = imageData.data;
  const uStart = 0.5;
  const uEnd = 0.98;
  const vStart = 0.56;
  const vEnd = 0.95;

  for (let y = 0; y < outputHeight; y += 1) {
    const v = vStart + ((y + 0.5) / outputHeight) * (vEnd - vStart);

    for (let x = 0; x < outputWidth; x += 1) {
      const u = uStart + ((x + 0.5) / outputWidth) * (uEnd - uStart);
      const point = cellPoint(corners, u, v);
      const pixel = sampleSourcePixel(sourceData, sourceWidth, sourceHeight, point.x, point.y);
      const target = (y * outputWidth + x) * 4;
      data[target] = pixel[0];
      data[target + 1] = pixel[1];
      data[target + 2] = pixel[2];
      data[target + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
  return {
    canvas,
    imageData,
  };
}

function makeOcrCanvas(source: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is not available.");
  }

  context.drawImage(source, 0, 0);
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
  const sourceImage = context.getImageData(0, 0, canvas.width, canvas.height);
  onProgress?.("Normalizing grid", 0.08);
  const grid = findRuneGridModel(context, canvas.width, canvas.height);
  const reads: RuneRead[] = [];

  onProgress?.("Reading stack counts", 0.1);

  for (let index = 0; index < RUNE_NAMES.length; index += 1) {
    const { column, row } = RUNE_SLOT_LAYOUT[index];
    const corners = getCellCorners(grid, column, row);
    const digitRegion = makeNormalizedDigitRegion(sourceImage.data, canvas.width, canvas.height, corners);
    const digitImageData = digitRegion.imageData;
    const digitStats = imageVariance(digitImageData.data);
    const inkStats = digitInkStats(digitImageData.data);

    let count = 0;
    let method: RuneRead["method"] = "empty";
    let confidence = 0.82;
    let note: string | undefined;

    if (inkStats.brightRatio > 0.018 && (digitStats.deviation > 16 || inkStats.veryBrightRatio > 0.004)) {
      try {
        const digitCanvas = makeOcrCanvas(digitRegion.canvas);
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
    crop: grid.crop,
  };
}
