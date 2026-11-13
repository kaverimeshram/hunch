/* Swipe gesture maths. Pure so the thresholds are testable without a pointer. */

export const MAX_TILT_DEG = 16;

/** Drag distance that commits a swipe: 28% of the card width, never under 90px. */
export const thresholdFor = (width) => Math.max(90, width * 0.28);

/**
 * Which action a release at (dx, dy) means: 'yes' (right), 'no' (left), 'skip' (up) or null (spring back).
 * Up wins only when the drag is mostly vertical, so a diagonal flick still counts as its side.
 */
export function decide(dx, dy, threshold) {
  const up = -dy;
  if (up >= threshold && up > Math.abs(dx) * 1.2) return 'skip';
  if (dx >= threshold) return 'yes';
  if (dx <= -threshold) return 'no';
  return null;
}

/** Stamp opacities 0..1 for the live drag; each stamp fades in over the first 70% of the threshold. */
export function stamps(dx, dy, threshold) {
  const ramp = (value) => Math.min(1, Math.max(0, value / (threshold * 0.7)));
  const skip = -dy > Math.abs(dx) * 1.2 ? ramp(-dy) : 0;
  return { yes: skip ? 0 : ramp(dx), no: skip ? 0 : ramp(-dx), skip };
}

export const tilt = (dx, width) => Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, (dx / width) * 28));
