import type { BasePoint, Line, PathChain, Point, SequenceItem } from "../types";
import { FIELD_SIZE } from "../config";

export interface PixelPoint {
  x: number;
  y: number;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface TraceSettings {
  tolerance: number;
  minBlobPixels: number;
  searchRadius: number;
}

export interface TrackingTemplateSample {
  dx: number;
  dy: number;
  lumaDev: number;
  redGreen: number;
  blueLuma: number;
  weight: number;
}

export interface TrackingTemplate {
  size: number;
  halfSize: number;
  width: number;
  height: number;
  halfWidth: number;
  halfHeight: number;
  sampleStep: number;
  samples: TrackingTemplateSample[];
  lumaSq: number;
  totalWeight: number;
}

export interface TemplateTraceSettings {
  candidateFilter?: (point: PixelPoint) => boolean;
  searchRadius: number;
  searchStep?: number;
  minScore?: number;
  colorWeight?: number;
  motionWeight?: number;
  previousImageData?: ImageData | null;
}

export interface TemplateTrackResult {
  point: PixelPoint;
  score: number;
}

interface TemplateBackground {
  blueLuma: number;
  luma: number;
  redGreen: number;
}

export interface TraceSample {
  time: number;
  pixel: PixelPoint;
  field: BasePoint;
}

export interface VideoClonePath {
  startPoint: Point;
  lines: Line[];
  sequence: SequenceItem[];
  pathChains: PathChain[];
}

export type Homography = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const distance = (a: BasePoint, b: BasePoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function fieldCornerTargets(): BasePoint[] {
  return [
    { x: 0, y: 0 },
    { x: FIELD_SIZE, y: 0 },
    { x: FIELD_SIZE, y: FIELD_SIZE },
    { x: 0, y: FIELD_SIZE },
  ];
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const augmented = matrix.map((row, idx) => [...row, vector[idx]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) {
        pivot = row;
      }
    }

    if (Math.abs(augmented[pivot][col]) < 1e-10) {
      throw new Error("Field calibration points are too close together.");
    }

    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];

    const divisor = augmented[col][col];
    for (let c = col; c <= n; c++) {
      augmented[col][c] /= divisor;
    }

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let c = col; c <= n; c++) {
        augmented[row][c] -= factor * augmented[col][c];
      }
    }
  }

  return augmented.map((row) => row[n]);
}

export function solveHomography(
  source: PixelPoint[],
  target: BasePoint[] = fieldCornerTargets(),
): Homography {
  if (source.length !== 4 || target.length !== 4) {
    throw new Error("Field calibration needs exactly four corners.");
  }

  const matrix: number[][] = [];
  const vector: number[] = [];

  source.forEach((src, idx) => {
    const dst = target[idx];
    matrix.push([src.x, src.y, 1, 0, 0, 0, -src.x * dst.x, -src.y * dst.x]);
    vector.push(dst.x);

    matrix.push([0, 0, 0, src.x, src.y, 1, -src.x * dst.y, -src.y * dst.y]);
    vector.push(dst.y);
  });

  const h = solveLinearSystem(matrix, vector);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(h: Homography, point: PixelPoint): BasePoint {
  const denominator = h[6] * point.x + h[7] * point.y + h[8];
  if (Math.abs(denominator) < 1e-10) {
    return { x: 0, y: 0 };
  }

  return {
    x: clamp(
      (h[0] * point.x + h[1] * point.y + h[2]) / denominator,
      0,
      FIELD_SIZE,
    ),
    y: clamp(
      (h[3] * point.x + h[4] * point.y + h[5]) / denominator,
      0,
      FIELD_SIZE,
    ),
  };
}

export function samplePixelColor(
  imageData: ImageData,
  point: PixelPoint,
): RgbColor {
  const x = clamp(Math.round(point.x), 0, imageData.width - 1);
  const y = clamp(Math.round(point.y), 0, imageData.height - 1);
  const idx = (y * imageData.width + x) * 4;
  return {
    r: imageData.data[idx],
    g: imageData.data[idx + 1],
    b: imageData.data[idx + 2],
  };
}

function pixelIndex(imageData: ImageData, x: number, y: number) {
  const px = clamp(Math.round(x), 0, imageData.width - 1);
  const py = clamp(Math.round(y), 0, imageData.height - 1);
  return (py * imageData.width + px) * 4;
}

function sampleLuma(imageData: ImageData, x: number, y: number) {
  const idx = pixelIndex(imageData, x, y);
  return (
    imageData.data[idx] * 0.299 +
    imageData.data[idx + 1] * 0.587 +
    imageData.data[idx + 2] * 0.114
  );
}

function sampleEdge(imageData: ImageData, x: number, y: number) {
  return (
    Math.abs(sampleLuma(imageData, x + 2, y) - sampleLuma(imageData, x - 2, y)) +
    Math.abs(sampleLuma(imageData, x, y + 2) - sampleLuma(imageData, x, y - 2))
  );
}

function sampleTemplateFeatures(imageData: ImageData, x: number, y: number) {
  const idx = pixelIndex(imageData, x, y);
  const r = imageData.data[idx];
  const g = imageData.data[idx + 1];
  const b = imageData.data[idx + 2];
  const luma = r * 0.299 + g * 0.587 + b * 0.114;

  return {
    luma,
    redGreen: r - g,
    blueLuma: b - luma,
  };
}

function makeTemplateFromSamples(
  width: number,
  height: number,
  sampleStep: number,
  rawSamples: Array<
    Omit<TrackingTemplateSample, "lumaDev" | "weight"> & {
      edge: number;
      luma: number;
    }
  >,
  background?: TemplateBackground,
): TrackingTemplate {
  const meanLuma =
    rawSamples.reduce((sum, sample) => sum + sample.luma, 0) /
    Math.max(1, rawSamples.length);

  const weightedSamples = rawSamples
    .map((sample) => {
      const lumaDev = sample.luma - meanLuma;
      const chroma = Math.hypot(sample.redGreen, sample.blueLuma);
      const backgroundDiff = background
        ? Math.abs(sample.luma - background.luma) +
          Math.abs(sample.redGreen - background.redGreen) +
          Math.abs(sample.blueLuma - background.blueLuma)
        : 0;
      const distinctiveness =
        sample.edge / 42 +
        Math.abs(lumaDev) / 36 +
        chroma / 120 +
        backgroundDiff / 90;

      return {
        dx: sample.dx,
        dy: sample.dy,
        lumaDev,
        redGreen: sample.redGreen,
        blueLuma: sample.blueLuma,
        weight: clamp(distinctiveness, 0.04, 3),
      };
    })
    .sort((a, b) => b.weight - a.weight);

  const filteredSamples = weightedSamples.filter(
    (sample) => sample.weight >= 0.18,
  );
  const samples = (
    filteredSamples.length >= 24 ? filteredSamples : weightedSamples
  ).slice(0, 320);

  const lumaSq = samples.reduce(
    (sum, sample) => sum + sample.weight * sample.lumaDev * sample.lumaDev,
    0,
  );
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);

  return {
    size: Math.max(width, height),
    halfSize: Math.max(width, height) / 2,
    width,
    height,
    halfWidth: width / 2,
    halfHeight: height / 2,
    sampleStep,
    samples,
    lumaSq,
    totalWeight,
  };
}

export function createTrackingTemplate(
  imageData: ImageData,
  point: PixelPoint,
  options: {
    background?: TemplateBackground;
    height?: number;
    sampleStep?: number;
    size?: number;
    width?: number;
  } = {},
): TrackingTemplate {
  const width = clamp(
    Math.round(options.width || options.size || 56),
    16,
    Math.max(16, imageData.width),
  );
  const height = clamp(
    Math.round(options.height || options.size || 56),
    16,
    Math.max(16, imageData.height),
  );
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const maxDimension = Math.max(width, height);
  const sampleStep = clamp(
    Math.round(options.sampleStep || Math.max(3, maxDimension / 18)),
    3,
    8,
  );
  const rawSamples: Array<
    Omit<TrackingTemplateSample, "lumaDev" | "weight"> & {
      edge: number;
      luma: number;
    }
  > = [];

  for (let dy = -halfHeight; dy <= halfHeight; dy += sampleStep) {
    for (let dx = -halfWidth; dx <= halfWidth; dx += sampleStep) {
      const x = point.x + dx;
      const y = point.y + dy;
      rawSamples.push({
        dx,
        dy,
        edge: sampleEdge(imageData, x, y),
        ...sampleTemplateFeatures(imageData, x, y),
      });
    }
  }

  return makeTemplateFromSamples(
    width,
    height,
    sampleStep,
    rawSamples,
    options.background,
  );
}

export function createTrackingTemplateFromBox(
  imageData: ImageData,
  box: { x: number; y: number; width: number; height: number },
  options: { sampleStep?: number } = {},
): { point: PixelPoint; template: TrackingTemplate } {
  const minWidth = 16;
  const minHeight = 16;
  const width = clamp(Math.round(Math.abs(box.width)), minWidth, imageData.width);
  const height = clamp(
    Math.round(Math.abs(box.height)),
    minHeight,
    imageData.height,
  );
  const left = clamp(
    Math.min(box.x, box.x + box.width),
    0,
    Math.max(0, imageData.width - width),
  );
  const top = clamp(
    Math.min(box.y, box.y + box.height),
    0,
    Math.max(0, imageData.height - height),
  );
  const point = {
    x: left + width / 2,
    y: top + height / 2,
  };
  const background = sampleBackgroundRing(imageData, {
    height,
    width,
    x: left,
    y: top,
  });

  return {
    point,
    template: createTrackingTemplate(imageData, point, {
      background,
      width,
      height,
      sampleStep: options.sampleStep,
    }),
  };
}

function sampleBackgroundRing(
  imageData: ImageData,
  box: { x: number; y: number; width: number; height: number },
): TemplateBackground | undefined {
  const ring = clamp(Math.round(Math.max(box.width, box.height) * 0.18), 8, 28);
  const step = clamp(Math.round(Math.max(box.width, box.height) / 18), 3, 10);
  let count = 0;
  let luma = 0;
  let redGreen = 0;
  let blueLuma = 0;

  const sample = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) {
      return;
    }
    const features = sampleTemplateFeatures(imageData, x, y);
    count++;
    luma += features.luma;
    redGreen += features.redGreen;
    blueLuma += features.blueLuma;
  };

  for (let x = box.x - ring; x <= box.x + box.width + ring; x += step) {
    sample(x, box.y - ring);
    sample(x, box.y + box.height + ring);
  }

  for (let y = box.y - ring; y <= box.y + box.height + ring; y += step) {
    sample(box.x - ring, y);
    sample(box.x + box.width + ring, y);
  }

  if (count < 8) return undefined;
  return {
    blueLuma: blueLuma / count,
    luma: luma / count,
    redGreen: redGreen / count,
  };
}

function scoreTemplateAt(
  imageData: ImageData,
  template: TrackingTemplate,
  x: number,
  y: number,
  settings: Required<Pick<TemplateTraceSettings, "colorWeight" | "motionWeight">> &
    Pick<TemplateTraceSettings, "previousImageData">,
) {
  if (
    template.samples.length === 0 ||
    template.lumaSq < 1 ||
    template.totalWeight < 1
  ) {
    return -Infinity;
  }

  let meanLuma = 0;
  template.samples.forEach((sample) => {
    meanLuma +=
      sample.weight * sampleLuma(imageData, x + sample.dx, y + sample.dy);
  });
  meanLuma /= template.totalWeight;

  let numerator = 0;
  let candidateSq = 0;
  let chromaError = 0;
  let motion = 0;

  template.samples.forEach((sample) => {
    const features = sampleTemplateFeatures(
      imageData,
      x + sample.dx,
      y + sample.dy,
    );
    const lumaDev = features.luma - meanLuma;
    numerator += sample.weight * sample.lumaDev * lumaDev;
    candidateSq += sample.weight * lumaDev * lumaDev;
    chromaError +=
      sample.weight *
      (Math.abs(features.redGreen - sample.redGreen) +
        Math.abs(features.blueLuma - sample.blueLuma));

    if (settings.previousImageData) {
      motion +=
        sample.weight *
        Math.abs(
          features.luma -
            sampleLuma(settings.previousImageData, x + sample.dx, y + sample.dy),
        );
    }
  });

  if (candidateSq < 1) return -Infinity;

  const textureScore =
    numerator / Math.sqrt(Math.max(1, template.lumaSq * candidateSq));
  const chromaPenalty = clamp(
    chromaError / Math.max(1, template.totalWeight * 510),
    0,
    1,
  );
  const motionScore = clamp(motion / Math.max(1, template.totalWeight * 55), 0, 1);

  return (
    (textureScore + 1) / 2 -
    chromaPenalty * settings.colorWeight +
    motionScore * settings.motionWeight
  );
}

export function trackTemplateCenter(
  imageData: ImageData,
  template: TrackingTemplate,
  previousPoint: PixelPoint,
  settings: TemplateTraceSettings,
): TemplateTrackResult | null {
  const radius = Math.max(8, settings.searchRadius);
  const coarseStep = clamp(Math.round(settings.searchStep || 4), 1, 12);
  const minScore = settings.minScore ?? 0.28;
  const weights = {
    colorWeight: settings.colorWeight ?? 0.14,
    motionWeight: settings.motionWeight ?? 0.28,
    previousImageData: settings.previousImageData ?? null,
  };
  const marginX = template.halfWidth + 1;
  const marginY = template.halfHeight + 1;
  const minX = clamp(
    previousPoint.x - radius,
    marginX,
    imageData.width - marginX,
  );
  const maxX = clamp(
    previousPoint.x + radius,
    marginX,
    imageData.width - marginX,
  );
  const minY = clamp(
    previousPoint.y - radius,
    marginY,
    imageData.height - marginY,
  );
  const maxY = clamp(
    previousPoint.y + radius,
    marginY,
    imageData.height - marginY,
  );

  let bestPoint: PixelPoint | null = null;
  let bestScore = -Infinity;

  const consider = (x: number, y: number) => {
    if (settings.candidateFilter && !settings.candidateFilter({ x, y })) {
      return;
    }

    const distancePenalty =
      (Math.hypot(x - previousPoint.x, y - previousPoint.y) / radius) * 0.035;
    const score =
      scoreTemplateAt(imageData, template, x, y, weights) - distancePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestPoint = { x, y };
    }
  };

  for (let y = minY; y <= maxY; y += coarseStep) {
    for (let x = minX; x <= maxX; x += coarseStep) {
      consider(x, y);
    }
  }

  if (bestPoint && coarseStep > 1) {
    const refineMinX = clamp(
      bestPoint.x - coarseStep,
      marginX,
      imageData.width - marginX,
    );
    const refineMaxX = clamp(
      bestPoint.x + coarseStep,
      marginX,
      imageData.width - marginX,
    );
    const refineMinY = clamp(
      bestPoint.y - coarseStep,
      marginY,
      imageData.height - marginY,
    );
    const refineMaxY = clamp(
      bestPoint.y + coarseStep,
      marginY,
      imageData.height - marginY,
    );

    for (let y = refineMinY; y <= refineMaxY; y += 1) {
      for (let x = refineMinX; x <= refineMaxX; x += 1) {
        consider(x, y);
      }
    }
  }

  if (!bestPoint || bestScore < minScore) return null;
  return {
    point: bestPoint,
    score: bestScore,
  };
}

export function updateTrackingTemplate(
  template: TrackingTemplate,
  imageData: ImageData,
  point: PixelPoint,
  adaptRate = 0.08,
): TrackingTemplate {
  const next = createTrackingTemplate(imageData, point, {
    width: template.width,
    height: template.height,
    sampleStep: template.sampleStep,
  });
  const rate = clamp(adaptRate, 0, 0.35);
  const samples = template.samples.map((sample, idx) => {
    const fresh = next.samples[idx] || sample;
    return {
      dx: sample.dx,
      dy: sample.dy,
      lumaDev: sample.lumaDev * (1 - rate) + fresh.lumaDev * rate,
      redGreen: sample.redGreen * (1 - rate) + fresh.redGreen * rate,
      blueLuma: sample.blueLuma * (1 - rate) + fresh.blueLuma * rate,
      weight: sample.weight * (1 - rate) + fresh.weight * rate,
    };
  });

  return {
    ...template,
    samples,
    lumaSq: samples.reduce(
      (sum, sample) => sum + sample.weight * sample.lumaDev * sample.lumaDev,
      0,
    ),
    totalWeight: samples.reduce((sum, sample) => sum + sample.weight, 0),
  };
}

export function trackColorCentroid(
  imageData: ImageData,
  targetColor: RgbColor,
  previousPoint: PixelPoint | null,
  settings: TraceSettings,
): PixelPoint | null {
  const toleranceSq = settings.tolerance * settings.tolerance;
  const radius = Math.max(0, settings.searchRadius);
  const hasRoi = previousPoint && radius > 0;
  const minX = hasRoi
    ? clamp(Math.floor(previousPoint.x - radius), 0, imageData.width - 1)
    : 0;
  const maxX = hasRoi
    ? clamp(Math.ceil(previousPoint.x + radius), 0, imageData.width - 1)
    : imageData.width - 1;
  const minY = hasRoi
    ? clamp(Math.floor(previousPoint.y - radius), 0, imageData.height - 1)
    : 0;
  const maxY = hasRoi
    ? clamp(Math.ceil(previousPoint.y + radius), 0, imageData.height - 1)
    : imageData.height - 1;
  const stride = imageData.width * 4;
  const sampleStride = 2;

  let count = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = minY; y <= maxY; y += sampleStride) {
    const row = y * stride;
    for (let x = minX; x <= maxX; x += sampleStride) {
      const idx = row + x * 4;
      const alpha = imageData.data[idx + 3];
      if (alpha < 32) continue;

      const dr = imageData.data[idx] - targetColor.r;
      const dg = imageData.data[idx + 1] - targetColor.g;
      const db = imageData.data[idx + 2] - targetColor.b;

      if (dr * dr + dg * dg + db * db <= toleranceSq) {
        count++;
        sumX += x;
        sumY += y;
      }
    }
  }

  if (count < settings.minBlobPixels) {
    return null;
  }

  return {
    x: sumX / count,
    y: sumY / count,
  };
}

export function dedupeNearPoints(
  points: BasePoint[],
  minDistance: number,
): BasePoint[] {
  const cleaned: BasePoint[] = [];
  points.forEach((point) => {
    const previous = cleaned[cleaned.length - 1];
    if (!previous || distance(previous, point) >= minDistance) {
      cleaned.push(point);
    }
  });
  return cleaned;
}

export function smoothPoints(points: BasePoint[], windowSize = 3): BasePoint[] {
  if (points.length <= 2 || windowSize <= 1) return points;
  const radius = Math.floor(windowSize / 2);

  return points.map((point, idx) => {
    if (idx === 0 || idx === points.length - 1) return point;
    const slice = points.slice(
      Math.max(0, idx - radius),
      Math.min(points.length, idx + radius + 1),
    );
    return {
      x: slice.reduce((sum, p) => sum + p.x, 0) / slice.length,
      y: slice.reduce((sum, p) => sum + p.y, 0) / slice.length,
    };
  });
}

function perpendicularDistance(
  point: BasePoint,
  start: BasePoint,
  end: BasePoint,
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return distance(point, start);

  const numerator = Math.abs(
    dy * point.x - dx * point.y + end.x * start.y - end.y * start.x,
  );
  const denominator = Math.hypot(dx, dy);
  return numerator / denominator;
}

export function simplifyRdp(points: BasePoint[], epsilon: number): BasePoint[] {
  if (points.length <= 2) return points;

  let maxDistance = 0;
  let index = 0;
  const start = points[0];
  const end = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], start, end);
    if (dist > maxDistance) {
      index = i;
      maxDistance = dist;
    }
  }

  if (maxDistance <= epsilon) {
    return [start, end];
  }

  const left = simplifyRdp(points.slice(0, index + 1), epsilon);
  const right = simplifyRdp(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

export function limitPointCount(
  points: BasePoint[],
  maxPoints: number,
): BasePoint[] {
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const limited: BasePoint[] = [];
  const lastIndex = points.length - 1;
  const targetLast = maxPoints - 1;

  for (let i = 0; i < maxPoints; i++) {
    const sourceIdx = Math.round((i / targetLast) * lastIndex);
    limited.push(points[sourceIdx]);
  }

  return limited.filter(
    (point, idx, arr) => idx === 0 || distance(point, arr[idx - 1]) > 0.01,
  );
}

export function prepareTracePoints(
  rawPoints: BasePoint[],
  options: {
    minDistance: number;
    simplification: number;
    maxPoints: number;
  },
): BasePoint[] {
  const deduped = dedupeNearPoints(rawPoints, options.minDistance);
  const smoothed = smoothPoints(deduped, 3);
  const simplified = simplifyRdp(smoothed, options.simplification);
  return limitPointCount(simplified, options.maxPoints);
}

function headingBetween(start: BasePoint, end: BasePoint) {
  return (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
}

export function buildVideoClonePath(
  points: BasePoint[],
  color = "#38bdf8",
  chainName = "Video Clone",
): VideoClonePath {
  if (points.length < 2) {
    throw new Error("At least two traced points are needed.");
  }

  const startHeading = headingBetween(points[0], points[1]);
  const startPoint: Point = {
    x: Number(points[0].x.toFixed(3)),
    y: Number(points[0].y.toFixed(3)),
    heading: "linear",
    startDeg: Number(startHeading.toFixed(3)),
    endDeg: Number(startHeading.toFixed(3)),
    locked: false,
  };

  const lines: Line[] = points.slice(1).map((point, idx) => ({
    id: makeId("video-line"),
    name: `Video ${idx + 1}`,
    endPoint: {
      x: Number(point.x.toFixed(3)),
      y: Number(point.y.toFixed(3)),
      heading: "tangential",
      reverse: false,
    },
    controlPoints: [],
    color,
    locked: false,
    waitBeforeMs: 0,
    waitAfterMs: 0,
    waitBeforeName: "",
    waitAfterName: "",
  }));

  const sequence: SequenceItem[] = lines.map((line) => ({
    kind: "path",
    lineId: line.id!,
  }));

  const pathChains: PathChain[] = [
    {
      id: makeId("video-chain"),
      name: chainName,
      color,
      lineIds: lines.map((line) => line.id!),
    },
  ];

  return {
    startPoint,
    lines,
    sequence,
    pathChains,
  };
}
