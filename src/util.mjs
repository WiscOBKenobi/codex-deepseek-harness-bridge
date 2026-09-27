/** Shared persistence, redaction and validation helpers. */
import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class BridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'BridgeError'; this.code = code; this.status = status; }
}
export function requireValue(condition, code, message, status = 400) {
  if (!condition) throw new BridgeError(code, message, status);
}
export function redact(value) {
  if (typeof value !== 'string') return JSON.parse(redact(JSON.stringify(value)));
  return value.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[密钥已隐藏]')
    .replace(/Bearer\s+[a-zA-Z0-9._~-]{12,}/gi, 'Bearer [已隐藏]')
    .replace(/([?&#]token=)[^\s&"'<>]+/gi, '$1[已隐藏]')
    .replace(/((?:api[_ -]?key|authorization|access[_ -]?token|refresh[_ -]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;\]}]+/gi, '$1[已隐藏]');
}
export function safeError(error) {
  return { code: error?.code ?? 'INTERNAL_ERROR', message: redact(String(error?.message ?? error)).slice(0, 2000) };
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
export function boundedInteger(value, fallback, min, max, label) {
  const result = value ?? fallback;
  requireValue(Number.isInteger(result) && result >= min && result <= max, 'INVALID_ARGUMENT', label + ' 必须是 ' + min + ' 到 ' + max + ' 的整数。');
  return result;
}
export function exactKeys(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_ARGUMENT', '参数必须是对象。');
  for (const key of Object.keys(value)) requireValue(keys.includes(key), 'INVALID_ARGUMENT', '不支持的参数：' + key);
}
export function taskId(value) {
  requireValue(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), 'INVALID_TASK_ID', '任务编号无效。');
  return value;
}
