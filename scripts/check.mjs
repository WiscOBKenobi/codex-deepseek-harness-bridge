/** Syntax checks can run without configuration, Harness, credentials, or installed bridge dependencies. */
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.some(value => value !== '--syntax-only') || args.length > 1) {
  console.error('用法：node scripts/check.mjs [--syntax-only]');
  process.exit(1);
}
const syntaxOnly = args.includes('--syntax-only');
let failed = false, count = 0;
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) { failed = true; console.error(`语法检查失败：${relative(projectRoot, file)}`); }
      count++;
    }
  }
}
async function main() {
  for (const dir of ['src', 'scripts', 'public', 'tests']) await walk(join(projectRoot, dir));
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (!manifest.dependencies?.['@modelcontextprotocol/sdk']) failed = true;
  let environment;
  if (!syntaxOnly) {
    try {
      const { loadConfig, checkEnvironment } = await import('../src/config.mjs');
      environment = await checkEnvironment(await loadConfig());
      if (!environment.ok) failed = true;
    } catch {
      // Configuration and provider exceptions can contain private values; expose only a fixed explanation.
      failed = true;
      environment = { ok: false, checks: [], message: '本机环境检查失败。请核对配置格式、安装路径和文件权限，或重新运行“配置本机”；原始错误已隐藏。' };
    }
  }
  console.log(JSON.stringify({ syntaxFiles: count, syntaxOnly, ...(environment ? { environment } : {}), ok: !failed }, null, 2));
  process.exitCode = failed ? 1 : 0;
}
main().catch(() => {
  console.error('检查未完成。请检查项目文件、package.json 格式和读取权限；原始错误已隐藏。');
  process.exitCode = 1;
});
