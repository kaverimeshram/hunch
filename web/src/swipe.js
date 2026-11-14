/* Swipe gesture maths. Pure so the thresholds are testable without a pointer. */

export const MAX_TILT_DEG = 16;

/** Drag distance that commits a swipe: 28% of the card width, never under 90px. */
export const thresholdFor = (width) => Math.max(90, width * 0.28);

/**
 * Which action a release at (dx, dy) means: 'yes' (right), 'no' (left), 'skip' (up) or null (spring back).
 * Up wins only when the drag is mostly vertical, so a diagonal flick still counts as its side.
 */
export function decide(dx, dy, threshold, vx = 0) {
  const up = -dy;
  if (up >= threshold && up > Math.abs(dx) * 1.2) return 'skip';
  if (dx >= threshold) return 'yes';
  if (dx <= -threshold) return 'no';
  // A quick flick commits early: fast enough and past a third of the threshold.
  if (Math.abs(vx) >= FLICK_SPEED && Math.abs(dx) >= threshold * 0.35 && Math.sign(vx) === Math.sign(dx)) return dx > 0 ? 'yes' : 'no';
  return null;
}

/** Release speed (px per ms) that turns a short drag into a swipe. */
export const FLICK_SPEED = 0.6;

/** How far the drag has pulled the next card forward, 0..1; the cards behind rise as the top card leaves. */
export const pullOf = (dx, dy, threshold) => Math.min(1, Math.hypot(dx, dy) / (threshold * 1.4));

/** Stamp scale 0.7..1.15 from the stamp opacity, so the stamp lands harder the further the card is dragged. */
export const stampScale = (opacity) => 0.7 + 0.45 * Math.min(1, Math.max(0, opacity));

/**
 * One step of a damped spring pulling x to 0 (stiffness k, damping c, unit mass). Returns the next state.
 * Underdamped on purpose: a released card overshoots once and settles, which is what a dropped card does.
 */
export function springStep({ x, v }, dt, k = 170, c = 15) {
  const a = -k * x - c * v;
  const nv = v + a * dt;
  return { x: x + nv * dt, v: nv };
}

/** Stamp opacities 0..1 for the live drag; each stamp fades in over the first 70% of the threshold. */
export function stamps(dx, dy, threshold) {
  const ramp = (value) => Math.min(1, Math.max(0, value / (threshold * 0.7)));
  const skip = -dy > Math.abs(dx) * 1.2 ? ramp(-dy) : 0;
  return { yes: skip ? 0 : ramp(dx), no: skip ? 0 : ramp(-dx), skip };
}

export const tilt = (dx, width) => Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, (dx / width) * 28));
