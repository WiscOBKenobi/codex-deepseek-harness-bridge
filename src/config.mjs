/** Portable local configuration. Credentials remain owned by Harness. */
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { requireValue, boundedInteger, BridgeError } from './util.mjs';
export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
function parseConfig(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch { throw new BridgeError('INVALID_CONFIG', '配置文件不是有效 JSON；请检查格式。'); }
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_CONFIG', '配置必须是 JSON 对象。');
  return raw;
}
export async function loadConfig(root = projectRoot) {
  let raw, configSource = 'config.json';
  try { raw = parseConfig(await readFile(join(root, configSource), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    configSource = 'config.example.json';
    try { raw = parseConfig(await readFile(join(root, configSource), 'utf8')); }
    catch (fallbackError) { if (fallbackError.code !== 'ENOENT') throw fallbackError; throw new BridgeError('MISSING_CONFIG', '找不到配置文件，请先运行安装配置程序。'); }
  }
  const pathValue = (key, fallback) => resolve(root, raw[key] ?? fallback);
  const harnessRoot = pathValue('harnessRoot', '../DS Harness');
  const config = {
    root: resolve(root), dataDir: join(root, '.bridge'), tasksDir: join(root, '.bridge', 'tasks'), configSource,
    harnessRoot, harnessHome: pathValue('harnessHome', join(harnessRoot, '.local', 'dsh-home')),
    nodePath: pathValue('nodePath', process.execPath),
    entryPath: resolve(harnessRoot, raw.entryPath ?? 'apps/cli/src/bin.ts'),
    provider: raw.provider ?? 'deepseek-official', model: raw.model ?? 'deepseek-flash',
    reasoningEffort: raw.reasoningEffort ?? 'max', defaultMode: raw.defaultMode ?? 'files', enableNativeAgent: raw.enableNativeAgent === true,
    prepareWindowsWorkspaceAcl: raw.prepareWindowsWorkspaceAcl === true,
    readRoots: (raw.readRoots ?? ['.']).map(path => resolve(root, path)),
    maxRuntimeSeconds: boundedInteger(raw.maxRuntimeSeconds, 0, 0, Number.MAX_SAFE_INTEGER, '最长运行秒数'),
    maxToolCalls: boundedInteger(raw.maxToolCalls, 0, 0, Number.MAX_SAFE_INTEGER, '最多工具调用'),
    stallWarningSeconds: boundedInteger(raw.stallWarningSeconds, 300, 1, Number.MAX_SAFE_INTEGER, '进度提醒秒数'),
    maxStreamBytes: boundedInteger(raw.maxStreamBytes, 4 * 1024 * 1024, 0, Number.MAX_SAFE_INTEGER, '协议流累计字节上限'),
    maxInputBytes: boundedInteger(raw.maxInputBytes, 2_000_000, 1024, 20_000_000, '输入字节上限'),
    maxOutputBytes: boundedInteger(raw.maxOutputBytes, 5_000_000, 1024, 20_000_000, '输出字节上限'),
  };
  requireValue(['agent', 'files'].includes(config.defaultMode), 'INVALID_CONFIG', 'defaultMode 必须是 agent 或 files。');
  requireValue(config.defaultMode !== 'agent' || config.enableNativeAgent, 'NATIVE_AGENT_DISABLED', '原生 Agent 尚未启用；确认本机命令执行权限后显式配置 enableNativeAgent。');
  requireValue(config.readRoots.length > 0 && config.readRoots.every(isAbsolute), 'INVALID_CONFIG', '必须配置输入目录。');
  for (const key of ['provider', 'model', 'reasoningEffort']) requireValue(typeof config[key] === 'string' && /^[a-zA-Z0-9._/-]{1,100}$/.test(config[key]), 'INVALID_CONFIG', key + ' 无效。');
  return config;
}
export async function checkEnvironment(config) {
  const paths = [
    ['Node', config.nodePath], ['Harness 入口', config.entryPath],
    ...(config.entryPath.endsWith('.ts') ? [['Harness 依赖', join(config.harnessRoot, 'node_modules', 'tsx', 'package.json')]] : []),
    ['已保存凭据文件', join(config.harnessHome, '.credentials.yaml')],
    ['MCP SDK', join(config.root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')],
  ];
  const checks = [];
  for (const [label, path] of paths) {
    try { await access(path); checks.push({ label, ok: true }); }
    catch (error) { checks.push({ label, ok: false, message: '找不到所需文件或没有访问权限。' }); }
  }
  return { ok: checks.every(item => item.ok), checks, model: config.model, provider: config.provider, reasoningEffort: config.reasoningEffort,
    defaultMode: config.defaultMode ?? 'files', supportedModes: config.enableNativeAgent ? ['files', 'agent'] : ['files'], configSource: config.configSource ?? 'config.json',
    ...(config.configSource === 'config.example.json' ? { setupMessage: '正在使用示例配置；请运行安装配置程序填写本机 Harness 路径。' } : {}) };
}
