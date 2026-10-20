import * as fs from 'node:fs';
import * as path from 'node:path';

export const readText = (file: string): string => fs.readFileSync(file, 'utf8');
export const resolvePath = (file: string, base = process.cwd()): string => path.resolve(base, file);
export const parentPath = (file: string): string => path.dirname(file);
export const encodeBinary = (value: Uint8Array, hex: boolean): string =>
  hex ? Buffer.from(value).toString('hex').toUpperCase() : Buffer.from(value).toString('base64');