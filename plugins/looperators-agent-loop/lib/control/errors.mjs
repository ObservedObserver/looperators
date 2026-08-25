export class LoopControlError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LoopControlError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = undefined) {
  throw new LoopControlError(code, message, details);
}
