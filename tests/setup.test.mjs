/** Installation regressions use isolated fake installations; no model calls or credential reads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configureProject, mergeMcpConfig } from '../scripts/setup.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-ds-setup-'));
  t.after(async () => {
    assert(!relative(tmpdir(), root).startsWith('..'));
    assert(root.includes('codex-ds-setup-'));
    await rm(root, { recursive: true, force: true });
  });
  const harnessRoot = join(root, 'Harness 空格');
  const harnessHome = join(harnessRoot, '.local', 'dsh-home');
  await mkdir(join(harnessRoot, 'apps', 'cli', 'src'), { recursive: true });
  await mkdir(harnessHome, { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts'), '// fixture\n');
  await writeFile(join(root, 'src', 'mcp-server.mjs'), '// fixture\n');
  await writeFile(join(root, 'config.example.json'), JSON.stringify({
    harnessRoot: './Harness 空格', harnessHome: './Harness 空格/.local/dsh-home',
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max',
    defaultMode: 'files', enableNativeAgent: false, maxRuntimeSeconds: 0, maxToolCalls: 0, stallWarningSeconds: 300, readRoots: ['.'],
  }));
  return { root, harnessRoot, harnessHome };
}

test('setup records absolute MCP launch paths and succeeds without readable credential contents', async t => {
  const paths = await fixture(t);
  // A directory cannot be read as a credential file on supported Windows/Linux hosts.
  await mkdir(join(paths.harnessHome, '.credentials.yaml'));
  const result = await configureProject(paths);
  assert.equal(result.configChanged, true);
  assert.equal(result.mcpChanged, true);
  const config = JSON.parse(await readFile(join(paths.root, 'config.json'), 'utf8'));
  assert.equal(resolve(paths.root, config.nodePath), process.execPath);
  assert.equal(config.defaultMode, 'files');
  assert.equal(config.enableNativeAgent, false);
  const toml = await readFile(result.mcpPath, 'utf8');
  const command = JSON.parse(toml.match(/^command = (.+)$/m)[1]);
  const [server] = JSON.parse(toml.match(/^args = (.+)$/m)[1]);
  const cwd = JSON.parse(toml.match(/^cwd = (.+)$/m)[1]);
  assert.equal(command, process.execPath);
  assert.equal(server, join(paths.root, 'src', 'mcp-server.mjs'));
  assert.equal(cwd, paths.root);
  assert([command, server, cwd].every(isAbsolute));
  assert(!toml.includes('credentials'));
});

test('setup preserves existing model, effort, limits and unrelated MCP settings, then is idempotent', async t => {
  const paths = await fixture(t);
  await writeFile(join(paths.root, 'config.json'), JSON.stringify({ provider: 'user-provider', model: 'user-model', reasoningEffort: 'low', enableNativeAgent: true, maxRuntimeSeconds: 888, maxToolCalls: 42, readRoots: ['chosen-inputs'], extra: { preserve: true } }));
  await mkdir(join(paths.root, '.codex'));
  const source = '# my project settings\r\nmodel = "my-codex-model"\r\n\r\n[mcp_servers.other]\r\ncommand = "keep-me"\r\n\r\n[mcp_servers.codex_ds_harness]\r\ncommand = "old-node"\r\nargs = ["old-server"]\r\ncwd = "old-root"\r\ncustom_option = "preserved"\r\n\r\n[mcp_servers.codex_ds_harness.env]\r\nCUSTOM_ENV = "preserved"\r\n';
  await writeFile(join(paths.root, '.codex', 'config.toml'), source);
  await configureProject(paths);
  const config = JSON.parse(await readFile(join(paths.root, 'config.json'), 'utf8'));
  assert.equal(config.model, 'user-model'); assert.equal(config.provider, 'user-provider'); assert.equal(config.reasoningEffort, 'low');
  assert.equal(config.enableNativeAgent, true); assert.equal(config.maxRuntimeSeconds, 888); assert.equal(config.maxToolCalls, 42);
  assert.deepEqual(config.readRoots, ['chosen-inputs']); assert.deepEqual(config.extra, { preserve: true });
  const toml = await readFile(join(paths.root, '.codex', 'config.toml'), 'utf8');
  assert(toml.includes('# my project settings\r\nmodel = "my-codex-model"'));
  assert(toml.includes('[mcp_servers.other]\r\ncommand = "keep-me"'));
  assert(toml.includes('custom_option = "preserved"'));
  assert(toml.includes('[mcp_servers.codex_ds_harness.env]\r\nCUSTOM_ENV = "preserved"'));
  assert.equal(toml.match(/^command = /gm).length, 2);
  const repeated = await configureProject(paths);
  assert.equal(repeated.configChanged, false); assert.equal(repeated.mcpChanged, false);
});

test('ambiguous existing MCP config fails before writing either file', async t => {
  const paths = await fixture(t);
  const original = '{"model":"preserve","maxRuntimeSeconds":50}\n';
  await writeFile(join(paths.root, 'config.json'), original);
  await mkdir(join(paths.root, '.codex'));
  const source = '[mcp_servers.codex_ds_harness]\ncommand = "first"\n[mcp_servers.codex_ds_harness]\ncommand = "second"\n';
  await writeFile(join(paths.root, '.codex', 'config.toml'), source);
  await assert.rejects(configureProject(paths), /重复声明/);
  assert.equal(await readFile(join(paths.root, 'config.json'), 'utf8'), original);
  assert.equal(await readFile(join(paths.root, '.codex', 'config.toml'), 'utf8'), source);
});

test('setup rejects invalid installation paths before creating machine config', async t => {
  const paths = await fixture(t);
  await assert.rejects(configureProject({ ...paths, harnessRoot: join(paths.root, 'missing') }), /找不到Harness 根目录/);
  await assert.rejects(readFile(join(paths.root, 'config.json')), { code: 'ENOENT' });
  await assert.rejects(configureProject({ ...paths, nodePath: 'node\nmalformed' }), /有效的本机路径/);
});

test('unsupported server declarations are preserved through a clear error', () => {
  const paths = { root: '/project', nodePath: '/node', serverPath: '/project/src/mcp-server.mjs' };
  assert.throws(() => mergeMcpConfig('[mcp_servers]\ncodex_ds_harness = { command = "node" }\n', paths), /内联或点式/);
  assert.throws(() => mergeMcpConfig('[mcp_servers.codex_ds_harness]\nargs = [\n "server"\n]\n', paths), /多行格式/);
  assert.throws(() => mergeMcpConfig('project_notes = """\ntext\n"""\n', paths), /多行 TOML/);
});

test('syntax-only check works in a clean project without src/config or machine settings', async t => {
  const paths = await fixture(t);
  for (const directory of ['scripts', 'public', 'tests']) await mkdir(join(paths.root, directory));
  const actualRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await writeFile(join(paths.root, 'scripts', 'check.mjs'), await readFile(join(actualRoot, 'scripts', 'check.mjs')));
  await writeFile(join(paths.root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@modelcontextprotocol/sdk': '1.30.1' } }));
  const result = spawnSync(process.execPath, [join(paths.root, 'scripts', 'check.mjs'), '--syntax-only'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.syntaxOnly, true); assert.equal(report.ok, true);
  assert.equal(report.environment, undefined);
  await assert.rejects(readFile(join(paths.root, 'config.json')), { code: 'ENOENT' });
});

test('setup refuses a project config directory linked outside the project', async t => {
  const paths = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside.root, 'config.toml'), 'model = "unchanged"\n');
  await symlink(outside.root, join(paths.root, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(configureProject(paths), /配置路径使用了链接/);
  assert.equal(await readFile(join(outside.root, 'config.toml'), 'utf8'), 'model = "unchanged"\n');
  await assert.rejects(readFile(join(paths.root, 'config.json')), { code: 'ENOENT' });
});

test('quoted MCP launch keys are updated once without duplicate TOML declarations', () => {
  const paths = { root: '/project', nodePath: '/node', serverPath: '/project/src/mcp-server.mjs' };
  const updated = mergeMcpConfig('[mcp_servers."codex_ds_harness"]\n"command" = "old"\n\'args\' = ["old-server"]\n', paths);
  assert.equal(updated.match(/^command = /gm).length, 1);
  assert.equal(updated.match(/^args = /gm).length, 1);
  assert(!updated.includes('"command" ='));
  assert(!updated.includes("'args' ="));
});

test('choosing a different Harness root derives its home unless an existing home was explicit', async t => {
  const paths = await fixture(t);
  const selected = await fixture(t);
  const first = await configureProject({ root: paths.root, harnessRoot: selected.harnessRoot });
  assert.equal(first.harnessHome, selected.harnessHome);
  const config = JSON.parse(await readFile(join(paths.root, 'config.json'), 'utf8'));
  config.harnessHome = paths.harnessHome;
  await writeFile(join(paths.root, 'config.json'), JSON.stringify(config));
  const second = await configureProject({ root: paths.root, harnessRoot: selected.harnessRoot });
  assert.equal(second.harnessHome, paths.harnessHome);
});

test('whole inline MCP server declarations fail before either configuration file changes', async t => {
  const paths = await fixture(t);
  const original = '{"model":"preserve-local-model"}\n';
  await writeFile(join(paths.root, 'config.json'), original);
  await mkdir(join(paths.root, '.codex'));
  for (const source of [
    'mcp_servers = { codex_ds_harness = { command = "old-node", args = ["old-server"] } }\n',
    '"mcp_servers" = { other = { command = "keep" } }\n',
    "'mcp_servers' = { other = { command = \"keep\" } }\n",
    '[mcp_servers]\ncodex_ds_harness = { command = "old-node" }\n',
  ]) {
    await writeFile(join(paths.root, '.codex', 'config.toml'), source);
    await assert.rejects(configureProject(paths), /内联/);
    assert.equal(await readFile(join(paths.root, 'config.json'), 'utf8'), original);
    assert.equal(await readFile(join(paths.root, '.codex', 'config.toml'), 'utf8'), source);
  }
});

test('environment checker hides private exception messages and malformed package content', async t => {
  const paths = await fixture(t);
  for (const directory of ['scripts', 'public', 'tests']) await mkdir(join(paths.root, directory));
  const actualRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await writeFile(join(paths.root, 'scripts', 'check.mjs'), await readFile(join(actualRoot, 'scripts', 'check.mjs')));
  await writeFile(join(paths.root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@modelcontextprotocol/sdk': '1.30.1' } }));
  const marker = 'private-setting-that-must-not-appear';
  await writeFile(join(paths.root, 'src', 'config.mjs'), `export async function loadConfig() { throw new Error(${JSON.stringify(marker)}); }\nexport async function checkEnvironment() { throw new Error('should not run'); }\n`);
  const result = spawnSync(process.execPath, [join(paths.root, 'scripts', 'check.mjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert(!(result.stdout + result.stderr).includes(marker));
  assert(!/Error:|SyntaxError:|\n\s+at /.test(result.stdout + result.stderr));
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.environment.ok, false);
  assert(report.environment.message.includes('原始错误已隐藏'));
  await writeFile(join(paths.root, 'package.json'), `{"private":"${marker}", invalid}`);
  const malformed = spawnSync(process.execPath, [join(paths.root, 'scripts', 'check.mjs'), '--syntax-only'], { encoding: 'utf8', windowsHide: true });
  assert.equal(malformed.status, 1);
  assert(!(malformed.stdout + malformed.stderr).includes(marker));
  assert(!/Error:|SyntaxError:|\n\s+at /.test(malformed.stdout + malformed.stderr));
  assert(malformed.stderr.includes('原始错误已隐藏'));
});
