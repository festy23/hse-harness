export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected a JSON object');
  }
  return value;
}
export function parseRecord(text: string): Record<string, unknown> {
  return record(JSON.parse(text));
}
export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) {
    throw new Error('Expected a string array');
  }
  return value as string[];
}
export function numberArray(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    !value.every((item: unknown) => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new Error('Expected a number array');
  }
  return value as number[];
}
export function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a string');
  }
  return value;
}
export function requiredNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Expected a finite number');
  }
  return value;
}
export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error('Expected a boolean');
  }
  return value;
}
