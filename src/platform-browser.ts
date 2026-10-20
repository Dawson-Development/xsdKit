export function readText(_file: string): string {
  throw new Error('Filesystem access is unavailable in the browser. Use parseSchema(text, { resolver }) instead.');
}

export const resolvePath = (file: string, base = 'https://xsdkit.local/'): string =>
  new URL(file, base.endsWith('/') ? base : `${base}/`).href;
export const parentPath = (file: string): string => new URL('.', file).href;

export function encodeBinary(value: Uint8Array, hex: boolean): string {
  if (hex) return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let offset = 0; offset < value.length; offset += 3) {
    const bits = (value[offset] << 16) | ((value[offset + 1] ?? 0) << 8) | (value[offset + 2] ?? 0);
    result += alphabet[(bits >>> 18) & 63] + alphabet[(bits >>> 12) & 63];
    result += offset + 1 < value.length ? alphabet[(bits >>> 6) & 63] : '=';
    result += offset + 2 < value.length ? alphabet[bits & 63] : '=';
  }
  return result;
}