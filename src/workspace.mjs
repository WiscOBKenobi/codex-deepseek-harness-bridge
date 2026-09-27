/** Explicit input copying and bounded output collection; no arbitrary filesystem RPC. */
import { lstat, mkdir, readFile, writeFile, readdir, open } from 'node:fs/promises';
import { relative, resolve, join, basename, dirname, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { BridgeError, requireValue, redact } from './util.mjs';
import { initializeWindowsTaskWorkspace } from './windows-workspace.mjs';

export function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
export async function safePath(root, path, { missing = false } = {}) {
  const target = resolve(path);
  requireValue(inside(root, target), 'PATH_DENIED', '路径不在指定任务目录内。', 403);
  const parts = relative(resolve(root), target).split(sep).filter(Boolean);
  let current = resolve(root);
  for (const part of [null, ...parts]) {
    if (part !== null) {
      requireValue(!part.includes(':') && !/[. ]$/.test(part), 'PATH_DENIED', '不支持的文件路径。', 403);
      current = join(current, part);
    }
    try {
      const info = await lstat(current);
      requireValue(!info.isSymbolicLink(), 'LINK_DENIED', '不接受符号链接或目录联接。', 403);
      if (info.isFile()) requireValue(info.nlink === 1, 'LINK_DENIED', '不接受硬链接文件。', 403);
    } catch (error) { if (missing && error.code === 'ENOENT') break; throw error; }
  }
  return target;
}
export async function prepareWorkspace(config, directory, inputs, mode = 'files', { initializeWindows = initializeWindowsTaskWorkspace } = {}) {
  const inputDir = join(directory, 'input');
  const outputDir = join(directory, 'output');
  const copied = [];
  const validated = [];
  const names = new Set();
  let total = 0;
  for (const input of inputs) {
    requireValue(isAbsolute(input), 'INVALID_INPUT', '输入文件请提供完整绝对路径。');
    const full = resolve(input);
    const root = config.readRoots.find(root => inside(root, full));
    requireValue(root, 'INPUT_ROOT_DENIED', '输入文件不在 config.json 的 readRoots 内。', 403);
    const rel = relative(root, full);
    requireValue(!rel.split(/[\\/]/).some(part => /^(\.git|\.codex|\.bridge|\.local|node_modules|\.ssh)$/i.test(part)), 'SENSITIVE_INPUT', '不能导入运行状态、依赖或凭据目录。', 403);
    requireValue(!/(^\.env($|\.)|credential|secret|token|\.npmrc$|\.pypirc$|\.(pem|pfx|p12|key)$)/i.test(basename(full)), 'SENSITIVE_INPUT', '不能导入凭据或密钥文件。', 403);
    await safePath(root, full);
    const info = await lstat(full);
    requireValue(info.isFile(), 'INVALID_INPUT', 'inputs 仅接受单个常规文件，请逐个列出。');
    total += info.size;
    requireValue(total <= config.maxInputBytes, 'INPUT_TOO_LARGE', '输入文件总大小超过配置上限。');
    const name = basename(full);
    requireValue(!names.has(name.toLowerCase()), 'DUPLICATE_INPUT_NAME', '多个输入文件重名，请先改名。');
    names.add(name.toLowerCase());
    const content = await readFile(full);
    requireValue(redact(content.toString('utf8')) === content.toString('utf8'), 'SENSITIVE_INPUT', '输入中检测到疑似 API 密钥或访问令牌。', 403);
    validated.push({ name, content });
    copied.push({ path: 'input/' + name, size: content.length, sha256: hash(content) });
  }
  await mkdir(directory, { recursive: true });
  if (mode === 'agent' && config.prepareWindowsWorkspaceAcl === true) {
    await initializeWindows({ workspace: directory, taskDir: dirname(directory), harnessRoot: config.harnessRoot });
  }
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  for (const { name, content } of validated) await writeFile(join(inputDir, name), content, { flag: 'wx' });
  return copied;
}
export function hash(content) { return createHash('sha256').update(content).digest('hex'); }
export async function collectArtifacts(workspace, maxBytes) {
  const root = join(workspace, 'output');
  const result = [];
  let total = 0;
  async function walk(directory, depth = 0) {
    requireValue(depth <= 12, 'OUTPUT_TOO_DEEP', '输出目录嵌套过深。');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      requireValue(result.length < 200, 'TOO_MANY_OUTPUTS', '输出文件超过 200 个。');
      const full = join(directory, entry.name);
      await safePath(root, full);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else {
        const info = await lstat(full);
        requireValue(info.isFile(), 'INVALID_OUTPUT', '输出包含非普通文件。');
        total += info.size;
        requireValue(total <= maxBytes, 'OUTPUT_TOO_LARGE', '输出文件总大小超过配置上限。');
        const content = await readFile(full);
        result.push({ path: relative(root, full).split(sep).join('/'), size: content.length, sha256: hash(content) });
      }
    }
  }
  await safePath(workspace, root);
  await walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function readArtifact(workspace, path, offset, maxBytes) {
  requireValue(typeof path === 'string' && path.length > 0 && !isAbsolute(path), 'INVALID_PATH', '产物路径必须是输出目录内的相对路径。');
  const root = join(workspace, 'output');
  const full = await safePath(root, resolve(root, path));
  const handle = await open(full, 'r');
  try {
    const info = await handle.stat();
    requireValue(info.isFile() && info.nlink === 1, 'INVALID_OUTPUT', '只能读取普通产物文件。');
    const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, info.size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    const binary = bytes.includes(0);
    return { path, offset, nextOffset: offset + bytesRead, totalBytes: info.size, truncated: offset + bytesRead < info.size,
      ...(binary ? { binary: true, message: '二进制文件请在任务输出文件夹中打开。' } : { content: redact(bytes.toString('utf8')) }) };
  } finally { await handle.close(); }
}
