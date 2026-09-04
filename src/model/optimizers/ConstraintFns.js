export const EPSILON = 1e-6;

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function isNearlyEqual(a, b, tol = EPSILON) {
  return Math.abs(a - b) <= tol;
}

export function distanceBetweenPoints(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function normalizeAngle(angle) {
  let value = angle % (Math.PI * 2);
  if (value < -Math.PI) value += Math.PI * 2;
  if (value > Math.PI) value -= Math.PI * 2;
  return value;
}

export function quantizeAngle(angle, quantValue, offset = 0) {
  const steps = Math.max(1, Number(quantValue) || 1);
  const period = (Math.PI * 2) / steps;
  const shifted = normalizeAngle(angle - offset);
  const index = Math.round(shifted / period);
  return normalizeAngle(offset + index * period);
}

export function reflectPoint(point, centerX, centerY) {
  if (!point) return null;
  return {
    x: 2 * centerX - point.x,
    y: 2 * centerY - point.y
  };
}

export function projectPointToLine(point, start, end) {
  if (!point || !start || !end) return point;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq <= EPSILON) {
    return { x: start.x, y: start.y };
  }

  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
  const x = start.x + t * dx;
  const y = start.y + t * dy;

  return { x, y };
}

export function pointIsCollinear(a, b, c, tol = EPSILON) {
  if (!a || !b || !c) return false;
  const dx1 = b.x - a.x;
  const dy1 = b.y - a.y;
  const dx2 = c.x - a.x;
  const dy2 = c.y - a.y;
  const cross = dx1 * dy2 - dy1 * dx2;
  return Math.abs(cross) <= tol;
}
