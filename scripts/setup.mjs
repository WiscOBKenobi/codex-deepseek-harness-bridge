/** Write machine-local bridge and project MCP settings without reading Harness credentials. */
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ownedKeys = ['command', 'args', 'cwd', 'startup_timeout_sec', 'tool_timeout_sec', 'enabled'];
const serverHeader = /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:codex_ds_harness|"codex_ds_harness"|'codex_ds_harness')\s*\]\s*(?:#.*)?$/;

function checkedPath(value, root, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}必须是有效的本机路径。`);
  return resolve(root, value);
}

async function rejectLinkedPath(path) {
  try {
    const item = await lstat(path);
    if (item.isSymbolicLink() || item.nlink > 1 && item.isFile()) throw new Error('配置路径使用了链接。为避免更改项目外设置，请先改用本项目的普通文件夹和文件。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function readJson(path, optional = false) {
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw new Error(`无法读取${optional ? '已有配置' : '示例配置'}文件。`, { cause: error }); }
  try {
    const value = JSON.parse(source.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch (error) { throw new Error(`${optional ? '已有配置' : '示例配置'}不是有效的 JSON 对象，请先修复。`, { cause: error }); }
}

async function requireKind(path, kind, label) {
  let item;
  try { item = await stat(path); }
  catch (error) { throw new Error(`找不到${label}，请选择已安装并可访问的路径。`, { cause: error }); }
  if (kind === 'directory' ? !item.isDirectory() : !item.isFile()) throw new Error(`${label}的路径类型不正确。`);
}

/** Update only this MCP server's launch fields; preserve other settings and server options.
 * Unsupported TOML forms fail before either configuration file is changed.
 * @param {string} source Existing project TOML, or an empty string.
 * @param {{nodePath:string,serverPath:string,root:string}} paths Absolute launch paths.
 * @returns {string} Project TOML with one bridge server declaration.
 */
export function mergeMcpConfig(source, paths) {
  if (source.includes('"""') || source.includes("'''")) throw new Error('项目 MCP 配置含多行 TOML 字符串，请手动配置本服务器；已有文件未更改。');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const matching = lines.flatMap((line, index) => serverHeader.test(line) ? [index] : []);
  if (matching.length > 1) throw new Error('项目配置重复声明了 codex_ds_harness；已有文件未更改。');
  if (lines.some(line => /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*=/.test(line))) {
    throw new Error('项目配置使用整体内联 mcp_servers 声明，无法追加服务器子表；请手动配置本服务器，已有文件未更改。');
  }
  if (lines.some(line => /^\s*(?:(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*)?(?:codex_ds_harness|"codex_ds_harness"|'codex_ds_harness')\s*(?:=|\.)/.test(line))) {
    throw new Error('项目配置使用内联或点式 codex_ds_harness 声明，请手动配置本服务器；已有文件未更改。');
  }
  const values = {
    command: JSON.stringify(paths.nodePath), args: `[${JSON.stringify(paths.serverPath)}]`, cwd: JSON.stringify(paths.root),
    startup_timeout_sec: '30', tool_timeout_sec: '60', enabled: 'true',
  };
  if (matching.length === 0) {
    const prefix = source.replace(/\s*$/, '');
    return `${prefix ? prefix + newline + newline : ''}[mcp_servers.codex_ds_harness]${newline}${ownedKeys.map(key => `${key} = ${values[key]}`).join(newline)}${newline}`;
  }
  const start = matching[0];
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;
  const seen = new Set();
  for (let index = start + 1; index < end; index++) {
    const match = lines[index].match(/^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*=\s*(.*)$/);
    if (!match || !ownedKeys.includes(match[1])) continue;
    const [, key, value] = match;
    if (seen.has(key)) throw new Error(`项目 MCP 配置重复声明 ${key}；已有文件未更改。`);
    if (key === 'args' && !/^\[.*\]\s*(?:#.*)?$/.test(value)) throw new Error('项目 MCP 的 args 使用多行格式，请先改为单行；已有文件未更改。');
    seen.add(key);
    lines[index] = `${key} = ${values[key]}`;
  }
  const missing = ownedKeys.filter(key => !seen.has(key)).map(key => `${key} = ${values[key]}`);
  lines.splice(start + 1, 0, ...missing);
  return `${lines.join(newline).replace(/\s*$/, '')}${newline}`;
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
  try { await rename(temporary, path); }
  catch (error) {
    // Only this invocation's temporary file is removed if publication fails.
    await unlink(temporary).catch(cleanupError => { if (cleanupError.code !== 'ENOENT') error.cleanupFailed = true; });
    throw error;
  }
}

/** Configure this project only; preserve existing provider, model, limits, and unrelated MCP settings.
 * Harness credentials are never opened or copied. The selected Node has already launched this script.
 * @param {{root?:string,harnessRoot?:string,harnessHome?:string,nodePath?:string}} options Local installation paths.
 * @returns {Promise<object>} Nonsecret installation paths and whether files changed.
 */
export async function configureProject(options = {}) {
  const root = checkedPath(options.root ?? defaultRoot, process.cwd(), '项目目录');
  await requireKind(root, 'directory', '项目目录');
  const configPath = join(root, 'config.json');
  await rejectLinkedPath(configPath);
  await rejectLinkedPath(join(root, 'config.example.json'));
  await rejectLinkedPath(join(root, '.codex'));
  await rejectLinkedPath(join(root, '.codex', 'config.toml'));
  const example = await readJson(join(root, 'config.example.json'));
  const existing = await readJson(configPath, true);
  const current = { ...example, ...existing };
  const harnessRoot = checkedPath(options.harnessRoot ?? current.harnessRoot ?? '../DS Harness', root, 'Harness 根目录');
  const inheritedHome = existing?.harnessHome ?? (options.harnessRoot === undefined && existing?.harnessRoot === undefined ? example.harnessHome : undefined);
  const harnessHome = checkedPath(options.harnessHome ?? inheritedHome ?? join(harnessRoot, '.local', 'dsh-home'), root, 'Harness 配置目录');
  const nodePath = checkedPath(options.nodePath ?? process.execPath, root, 'Node');
  await requireKind(harnessRoot, 'directory', 'Harness 根目录');
  await requireKind(harnessHome, 'directory', 'Harness 配置目录');
  await requireKind(nodePath, 'file', 'Node 运行程序');
  const nodeVersion = nodePath === process.execPath ? process.version : spawnSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).stdout?.trim();
  if (!/^v(?:2[4-9]|[3-9][0-9]|[1-9][0-9]{2,})\./.test(nodeVersion ?? '')) throw new Error('所选 Node 需要 24 或更高版本。');
  await requireKind(resolve(harnessRoot, current.entryPath ?? 'apps/cli/src/bin.ts'), 'file', 'Harness 启动入口');
  const serverPath = join(root, 'src', 'mcp-server.mjs');
  await requireKind(serverPath, 'file', '本项目 MCP 入口');
  const portable = path => (relative(root, path) || '.').replaceAll('\\', '/');
  const configuration = { ...current, harnessRoot: portable(harnessRoot), harnessHome: portable(harnessHome), nodePath: portable(nodePath) };
  const mcpPath = join(root, '.codex', 'config.toml');
  let previousMcp = '';
  try { previousMcp = await readFile(mcpPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取项目 MCP 配置。', { cause: error }); }
  const nextMcp = mergeMcpConfig(previousMcp, { nodePath, serverPath, root });
  const configChanged = JSON.stringify(existing) !== JSON.stringify(configuration);
  const mcpChanged = previousMcp !== nextMcp;
  if (configChanged) await atomicWrite(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
  if (mcpChanged) await atomicWrite(mcpPath, nextMcp);
  return { root, configurationPath: configPath, mcpPath, harnessRoot, harnessHome, nodePath, configChanged, mcpChanged };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('用法：node scripts/setup.mjs [--harness-root 路径] [--harness-home 路径] [--node-path 路径]');
    return;
  }
  const names = { '--harness-root': 'harnessRoot', '--harness-home': 'harnessHome', '--node-path': 'nodePath' };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = Object.hasOwn(names, args[index]) ? names[args[index]] : undefined;
    if (!name || args[index + 1] === undefined || Object.hasOwn(options, name)) throw new Error('设置参数无效，请使用 --help 查看用法。');
    options[name] = args[index + 1];
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('本项目需要已经安装的 Node 24 或更新版本。');
  const result = await configureProject(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
