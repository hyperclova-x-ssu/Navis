import frontalFaceModel from './lbpcascade_frontalface.xml?raw';
import type {FaceBox} from './attempt';

// OpenCV 4.12.0 frontal-face LBP cascade weights, Apache-2.0 (see LICENSE.opencv).
// This evaluator uses the model's 24×24 window and categorical decision stumps.
const WINDOW = 24;
const SAMPLE_EDGE = 240;
const MIN_FACE = 26;
const SCALE_STEP = 1.19;
const SCAN_STEP = 2;
const MIN_NEIGHBORS = 3;
const CLOCKWISE_NEIGHBORS = [0, 1, 2, 5, 8, 7, 6, 3];

interface Stump {
  feature: number;
  categories: number[];
  left: number;
  right: number;
}

const numbers = (node: Element, tag: string) => node.querySelector(tag)!.textContent!.trim().split(/\s+/).map(Number);

function readModel() {
  const xml = new DOMParser().parseFromString(frontalFaceModel, 'application/xml');
  const stages = Array.from(xml.querySelector('stages')!.children, stage => ({
    threshold: numbers(stage, 'stageThreshold')[0],
    stumps: Array.from(stage.querySelector('weakClassifiers')!.children, (node): Stump => {
      const [, , feature, ...categories] = numbers(node, 'internalNodes');
      const [left, right] = numbers(node, 'leafValues');
      return {feature, categories, left, right};
    }),
  }));
  const features = Array.from(xml.querySelector('features')!.children, feature => numbers(feature, 'rect'));
  return {stages, features};
}

function integralImage(rgba: Uint8ClampedArray, width: number, height: number) {
  const stride = width + 1;
  const integral = new Int32Array(stride * (height + 1));
  let offset = 0;
  for (let row = 1; row <= height; row++) {
    let sum = 0;
    for (let col = 1; col <= width; col++, offset += 4) {
      sum += (77 * rgba[offset] + 150 * rgba[offset + 1] + 29 * rgba[offset + 2]) >> 8;
      const pixel = row * stride + col;
      integral[pixel] = integral[pixel - stride] + sum;
    }
  }
  return integral;
}

function clusterFaces(candidates: FaceBox[]): FaceBox[] {
  const faces: FaceBox[] = [];
  const grouped = new Set<FaceBox>();
  // Largest windows first. A single real face produces overlapping detections at adjacent scales.
  for (const seed of candidates.reverse()) {
    if (grouped.has(seed)) continue;
    const neighbors = candidates.filter(box => {
      if (grouped.has(box)) return false;
      const width = Math.min(seed.x + seed.width, box.x + box.width) - Math.max(seed.x, box.x);
      const height = Math.min(seed.y + seed.height, box.y + box.height) - Math.max(seed.y, box.y);
      if (width <= 0 || height <= 0) return false;
      const overlap = width * height;
      return overlap / (seed.width * seed.height + box.width * box.height - overlap) > .28;
    });
    neighbors.forEach(box => grouped.add(box));
    if (neighbors.length < MIN_NEIGHBORS) continue;
    const mean = (key: keyof FaceBox) => neighbors.reduce((sum, box) => sum + box[key], 0) / neighbors.length;
    faces.push({x: mean('x'), y: mean('y'), width: mean('width'), height: mean('height')});
  }
  return faces;
}

export function createFaceDetector(): (canvas: HTMLCanvasElement) => readonly FaceBox[] {
  const {stages, features} = readModel();
  const sample = document.createElement('canvas');
  const context = sample.getContext('2d', {willReadFrequently: true})!;

  return canvas => {
    const candidates: FaceBox[] = [];
    const shrink = SAMPLE_EDGE / Math.max(canvas.width, canvas.height);
    const width = Math.round(canvas.width * shrink);
    const height = Math.round(canvas.height * shrink);
    for (let size = MIN_FACE; size <= Math.min(width, height); size *= SCALE_STEP) {
      const scaledWidth = Math.round(width * WINDOW / size);
      const scaledHeight = Math.round(height * WINDOW / size);
      sample.width = scaledWidth;
      sample.height = scaledHeight;
      context.drawImage(canvas, 0, 0, scaledWidth, scaledHeight);
      const stride = scaledWidth + 1;
      const integral = integralImage(context.getImageData(0, 0, scaledWidth, scaledHeight).data, scaledWidth, scaledHeight);
      const offsets = features.map(([x, y, w, h]) => ({
        blocks: Array.from({length: 9}, (_, index) => (y + Math.floor(index / 3) * h) * stride + x + (index % 3) * w),
        w,
        heightOffset: h * stride,
      }));

      const passes = (base: number) => {
        for (const stage of stages) {
          let score = 0;
          for (const stump of stage.stumps) {
            const {blocks, w, heightOffset} = offsets[stump.feature];
            const sumAt = (i: number) => {
              const at = base + blocks[i];
              return integral[at] - integral[at + w] - integral[at + heightOffset] + integral[at + w + heightOffset];
            };
            const center = sumAt(4);
            let code = 0;
            for (const i of CLOCKWISE_NEIGHBORS) code = (code << 1) | Number(sumAt(i) >= center);
            score += (stump.categories[code >>> 5] & (1 << (code & 31))) ? stump.left : stump.right;
          }
          if (score < stage.threshold) return false;
        }
        return true;
      };

      for (let y = 0; y <= scaledHeight - WINDOW; y += SCAN_STEP) {
        for (let x = 0; x <= scaledWidth - WINDOW; x += SCAN_STEP) {
          if (passes(y * stride + x)) {
            candidates.push({x: x / scaledWidth, y: y / scaledHeight, width: WINDOW / scaledWidth, height: WINDOW / scaledHeight});
          }
        }
      }
    }
    sample.width = 0;
    sample.height = 0;
    return clusterFaces(candidates);
  };
}
