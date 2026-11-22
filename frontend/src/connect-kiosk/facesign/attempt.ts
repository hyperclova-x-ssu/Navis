export const FACE_HOLD_MS = 1000;
export const FACE_TIMEOUT_MS = 10_000;
export const FRAME_SAMPLE_MS = 125;
const MAX_SAMPLE_GAP_MS = 500;

export interface FaceBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Shared by the visible overlay and the detector, in the cropped preview's coordinates.
export const FACE_FRAME: FaceBox = {x: .18, y: .20, width: .64, height: .58};

export function hasFaceInFrame(faces: readonly FaceBox[]): boolean {
  if (faces.length !== 1) return false;
  const [face] = faces;
  return face.x >= FACE_FRAME.x
    && face.y >= FACE_FRAME.y
    && face.x + face.width <= FACE_FRAME.x + FACE_FRAME.width
    && face.y + face.height <= FACE_FRAME.y + FACE_FRAME.height;
}

type AttemptStatus = 'scanning' | 'approved' | 'timed-out';

export function createFaceAttempt(startedAt: number) {
  const deadline = startedAt + FACE_TIMEOUT_MS;
  let status: AttemptStatus = 'scanning';
  let heldSince: number | null = null;
  let lastSampleAt = startedAt;

  function advance(now: number): AttemptStatus {
    if (status === 'scanning' && now >= deadline) status = 'timed-out';
    return status;
  }

  return {
    advance,
    observe(present: boolean, now: number): AttemptStatus {
      if (advance(now) !== 'scanning') return status;
      if (now - lastSampleAt > MAX_SAMPLE_GAP_MS) heldSince = null;
      lastSampleAt = now;
      heldSince = present ? heldSince ?? now : null;
      if (heldSince !== null && now - heldSince >= FACE_HOLD_MS) status = 'approved';
      return status;
    },
  };
}
