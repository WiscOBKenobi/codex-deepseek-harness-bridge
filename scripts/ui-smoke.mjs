/** Offline browser acceptance against the real local API and TaskManager. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApiServer } from '../src/daemon.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { loadConfig } from '../src/config.mjs';

const config = await loadConfig();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const testRoot = join(config.dataDir, `ui-smoke-${randomUUID()}`);
const screenshots = join(config.dataDir, 'verification');
const checks = [];
const errors = [];
const observed = { runs: 0, cancellations: 0 };
let manager, api, browser, authContext, unauthorizedContext, page;

/** Exercise process-independent task state with real files and cancellable work. */
async function fixtureRunner({ workspace, prompt, sessionId, onEvent }) {
  observed.runs++;
  const session = sessionId || `ui-fixture-${randomUUID()}`;
  onEvent({ type: 'session', sessionId: session });
  const revision = sessionId ? 2 : 1;
  const slow = prompt.includes('等待停止');
  let resolveDone, settled = false, timer;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = outcome => { if (settled) return; settled = true; clearTimeout(timer); resolveDone(outcome); };
  timer = setTimeout(async () => {
    try {
      onEvent({ type: 'tool_call', name: 'write' });
      const content = `中文任务面板验收\n修订版本：${revision}\n结果：输入已整理\n<img src="invalid" onerror="window.__unsafeMarkup=1">\n`;
      await writeFile(join(workspace, 'output', 'report.txt'), content);
      onEvent({ type: 'tool_result', name: 'write', result: { ok: true, path: 'output/report.txt' } });
      finish({ status: 'succeeded', sessionId: session, finalText: `已生成中文验收说明，修订版本 ${revision}。`, toolCalls: 1, exitCode: 0 });
    } catch (error) { finish({ status: 'failed', sessionId: session, finalText: '', toolCalls: 1, exitCode: 1, error: error.message }); }
  }, slow ? 60000 : 350);
  return {
    done,
    cancel: async () => {
      if (!settled) observed.cancellations++;
      finish({ status: 'cancelled', sessionId: session, finalText: '', toolCalls: 0, exitCode: 0 });
      await done;
    },
  };
}

function ok(name) { checks.push(name); }
async function waitText(page, id, text) {
  await page.waitForFunction(({ id, text }) => document.getElementById(id)?.textContent.includes(text), { id, text }, { timeout: 15000 });
}
async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1, `${label} has horizontal page overflow: ${JSON.stringify(dimensions)}`);
  ok(label);
}

try {
  await mkdir(testRoot, { recursive: true });
  await mkdir(screenshots, { recursive: true });
  const fixtureInput = join(config.root, 'examples', 'numbers.json');
  const forbiddenInput = join(testRoot, 'input-example.txt');
  await writeFile(forbiddenInput, '仅用于离线浏览器验收，不调用外部 API。\n');
  const fixtureConfig = { ...config, dataDir: testRoot, tasksDir: join(testRoot, 'tasks') };
  manager = await new TaskManager(fixtureConfig, { runner: fixtureRunner }).init();
  api = await createApiServer({ config: fixtureConfig, manager });
  const base = `http://127.0.0.1:${api.port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  authContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  page = await authContext.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#token=${api.token}`, { waitUntil: 'domcontentloaded' });
  await waitText(page, 'service-label', '本地服务已连接');
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.locator('h1').innerText(), '工作任务 0');
  ok('authenticated fragment removed; Chinese page loaded');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText(page, 'service-label', '本地服务已连接');
  ok('same-tab reload remains authenticated');
  await assertNoOverflow(page, 'desktop welcome layout');

  await page.locator('#new-task-button').click();
  await page.locator('#instruction').fill('整理输入并输出验收说明 <b>只显示文字</b>');
  await page.locator('#inputs').fill(forbiddenInput);
  await page.locator('#submit-button').click();
  await waitText(page, 'create-error', '不能导入运行状态');
  assert.equal((await manager.list()).tasks.length, 0);
  ok('forbidden input shows permission error without losing authentication');
  await page.locator('#inputs').fill(fixtureInput);
  await page.locator('#submit-button').click();
  await waitText(page, 'task-status', '执行完成');
  await waitText(page, 'task-review', '待验收');
  assert.equal(await page.locator('#task-title b').count(), 0);
  assert.ok((await page.locator('#task-title').innerText()).includes('<b>只显示文字</b>'));
  const task = (await manager.list()).tasks[0];
  assert.equal(task.status, 'succeeded');
  assert.equal(task.review.status, 'pending');
  assert.equal(task.runCount, 1);
  assert.equal((await manager.result(task.id)).artifacts[0].path, 'report.txt');
  ok('UI submits to real API; runner completion remains pending review');

  await page.locator('.artifact-row').click();
  await waitText(page, 'preview-content', '修订版本：1');
  assert.equal(await page.locator('#preview-content img').count(), 0);
  assert.equal(await page.evaluate(() => window.__unsafeMarkup), undefined);
  assert.ok((await readFile(join(task.workspace, 'output', 'report.txt'), 'utf8')).includes('修订版本：1'));
  ok('real output file preview; untrusted markup remains plain text');

  await page.locator('#accept-button').click();
  await waitText(page, 'toast', '请先填写实际检查结果');
  assert.equal((await manager.get(task.id)).task.review.status, 'pending');
  await page.locator('#review-note').fill('已打开实际输出文件，核对中文内容和修订版本 1。');
  await page.locator('#accept-button').click();
  await waitText(page, 'task-review', '验收通过');
  assert.equal((await manager.get(task.id)).task.review.status, 'accepted');
  ok('explicit review note required; acceptance stored separately');
  await writeFile(join(task.workspace, 'output', 'report.txt'), '验收后的本地文件修改，用于验证重新验收提示。\n');
  await page.locator('#refresh-button').click();
  await waitText(page, 'result-warning', '文件在验收后发生变化');
  assert.equal(await page.locator('#accept-button').isEnabled(), true);
  assert.equal((await manager.get(task.id)).task.status, 'succeeded');
  assert.equal((await manager.result(task.id)).reviewStale, true);
  await page.locator('#review-note').fill('已重新检查修改后的实际文件。');
  await page.locator('#accept-button').click();
  await page.waitForFunction(() => document.getElementById('result-warning').hidden);
  assert.equal((await manager.result(task.id)).reviewStale, false);
  ok('changed files invalidate the visible review and can be reviewed again');

  await page.locator('#continue-button').click();
  await page.locator('#continue-instruction').fill('请更新说明，生成修订版本 2。');
  await page.locator('#continue-submit').click();
  await waitText(page, 'result-summary-text', '修订版本 2');
  await waitText(page, 'task-status', '执行完成');
  await waitText(page, 'task-review', '待验收');
  const continued = (await manager.get(task.id)).task;
  assert.equal(continued.runCount, 2);
  assert.equal(continued.sessionId, task.sessionId);
  await page.locator('.artifact-row').click();
  await waitText(page, 'preview-content', '修订版本：2');
  ok('continue reuses session, updates output, and resets review');

  await page.locator('#events-tab').click();
  await page.locator('#event-list').getByText('开始执行', { exact: true }).first().waitFor();
  assert.ok(await page.locator('#event-list li').count() >= 7);
  await page.locator('#results-tab').click();
  ok('execution events are visible');

  await page.locator('#new-task-button').click();
  await page.locator('#instruction').fill('等待停止：用于验证正在执行任务的取消操作。');
  await page.locator('#submit-button').click();
  await waitText(page, 'task-status', '正在执行');
  await page.locator('#cancel-button').click();
  await waitText(page, 'task-status', '已停止');
  assert.equal(observed.cancellations, 1);
  assert.equal((await manager.list()).tasks[0].status, 'cancelled');
  assert.equal(await page.locator('#accept-button').isDisabled(), true);
  ok('running task cancelled; unsuccessful task cannot be accepted');

  await page.locator('.task-item').filter({ hasText: '整理输入并输出验收说明' }).click();
  await waitText(page, 'task-status', '执行完成');
  await page.locator('.artifact-row').click();
  await waitText(page, 'preview-content', '修订版本：2');
  await assertNoOverflow(page, 'desktop task layout');
  await page.screenshot({ path: join(screenshots, 'ui-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoOverflow(page, 'mobile task layout');
  await page.screenshot({ path: join(screenshots, 'ui-mobile.png'), fullPage: true });
  await page.locator('#new-task-button').click();
  await assertNoOverflow(page, 'mobile create-dialog layout');
  await page.locator('[data-close="create-dialog"]').click();
  await page.locator('#service-button').click();
  await page.getByRole('heading', { name: '服务与权限说明' }).waitFor();
  await page.getByRole('heading', { name: '密钥沿用已有配置' }).waitFor();
  await assertNoOverflow(page, 'mobile service-dialog layout');
  await page.locator('[data-close="service-dialog"]').click();
  ok('service explanation and narrow-screen dialogs');

  const unauthenticated = await fetch(`${base}/api/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticated.status, 401);
  unauthorizedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const denied = await unauthorizedContext.newPage();
  denied.on('pageerror', error => errors.push(error.message));
  await denied.goto(base, { waitUntil: 'domcontentloaded' });
  await waitText(denied, 'global-notice', '请双击项目文件夹中的启动入口');
  assert.equal(await denied.locator('#new-task-button').isDisabled(), true);
  const invalid = await unauthorizedContext.newPage();
  invalid.on('pageerror', error => errors.push(error.message));
  await invalid.goto(`${base}/#token=invalid-local-fixture`, { waitUntil: 'domcontentloaded' });
  await waitText(invalid, 'global-notice', '连接授权已失效');
  assert.equal(new URL(invalid.url()).hash, '');
  ok('missing and invalid authorization produce clear errors');
  assert.deepEqual(errors, []);
  ok('no browser page errors');
  const report = { passed: true, liveApiCalled: false, checks, observed, pageErrors: errors, screenshots: ['.bridge/verification/ui-desktop.png', '.bridge/verification/ui-mobile.png'], taskDirectory: testRoot };
  await writeFile(join(screenshots, 'ui-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  const clean = String(error.stack || error.message).replaceAll(api?.token || 'no-token-placeholder', '[redacted]').replace(/#token=[^\s"']+/g, '#token=[redacted]');
  process.stderr.write(`UI smoke failed after ${checks.length} checks: ${clean}\nCompleted: ${JSON.stringify(checks)}\n`);
  if (page) process.stderr.write(JSON.stringify({errors,visible:await page.locator('body').innerText(),tasks:await manager?.list()},null,2)+'\n');
  process.exitCode = 1;
} finally {
  await unauthorizedContext?.close();
  await authContext?.close();
  await browser?.close();
  await manager?.shutdown();
  await api?.close();
}
