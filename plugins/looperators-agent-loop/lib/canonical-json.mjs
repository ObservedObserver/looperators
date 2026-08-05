import { createHash, timingSafeEqual } from "node:crypto";

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }
  return leftPoints.length - rightPoints.length;
}

function serialize(value, seen) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON rejects non-finite numbers");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new TypeError("canonical JSON rejects circular values");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON accepts only plain objects");
    }
    const keys = Object.keys(value).sort(compareCodePoints);
    const fields = keys.map(
      (key) => `${JSON.stringify(key)}:${serialize(value[key], seen)}`,
    );
    return `{${fields.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value) {
  return serialize(value, new Set());
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function digestJson(value) {
  return sha256(canonicalJson(value));
}

export function digestEqual(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== right.length
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export { compareCodePoints };
