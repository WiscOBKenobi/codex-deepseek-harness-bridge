'use strict';

/** Browser client for the authenticated local task service. */
const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const CONTINUABLE = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const STATUS = {queued:'排队中',running:'正在执行',cancelling:'正在停止',succeeded:'执行完成',failed:'执行失败',cancelled:'已停止',timed_out:'达到时间上限',interrupted:'运行已中断'};
const REVIEW = {accepted:'验收通过',needs_changes:'需要修改',pending:'待验收'};
const EVENT_LABELS = {queued:'任务进入队列',running:'开始执行',session:'会话已建立',tool_call:'调用工具',tool_result:'工具返回结果',final:'模型提交结果',error:'执行错误',cancelled:'任务已停止',timed_out:'达到时间上限',succeeded:'执行完成',failed:'执行失败',review:'更新验收记录',continued:'收到补充要求',interrupted:'运行中断'};
const state = {token:'',tasks:[],selected:null,task:null,events:[],cursor:0,filter:'all',health:null,refreshing:false,needsRefresh:false,creating:false,continuing:false,actionBusy:false,listSignature:'',previewPath:null,reviewStale:false,reviewSignature:'',timer:null};
let toastTimer;
let pendingCreate;
let pendingContinue;

/** Keep the local service token out of the page URL and rendered content. */
function takeToken() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const incoming = fragment.get('token');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (incoming) {
    state.token = incoming;
    try { sessionStorage.setItem('bridge-token', incoming); } catch { /* Memory-only authentication remains available. */ }
  } else {
    try { state.token = sessionStorage.getItem('bridge-token') || ''; } catch { /* A launcher URL is required when storage is unavailable. */ }
  }
}

/** Call the local RPC endpoint without exposing the bearer token. */
async function rpc(method, params = {}) {
  if (!state.token) throw new Error('当前页面没有连接凭据。请使用项目文件夹中的启动入口重新打开面板。');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`/api/${method}`, {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${state.token}`},body:JSON.stringify(params),signal:controller.signal,cache:'no-store',credentials:'omit'});
    if (response.status === 401) {
      throw new Error('连接授权已失效。请使用项目文件夹中的启动入口重新打开面板。');
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('本地服务没有返回可识别的数据。请重新打开面板。'); }
    if (!response.ok || data.error) {
      const message = typeof data.error === 'string' ? data.error : data.error?.message;
      throw new Error(message || `请求未完成（${response.status}）。`);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('本地服务响应超时。任务可能仍在执行，请刷新查看。');
    if (error instanceof TypeError) throw new Error('无法连接本地服务。请确认连接程序正在运行。');
    throw error;
  } finally { clearTimeout(timeout); }
}

function notice(message = '') { $('global-notice').textContent = message; $('global-notice').hidden = !message; }
function formError(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function dateText(value, full = false) { const date = new Date(value); if (!value || Number.isNaN(date.getTime())) return '—'; return date.toLocaleString('zh-CN',full ? {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'} : {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function reviewStatus(task) { return typeof task?.review === 'string' ? task.review : task?.review?.status || 'pending'; }
function shortId(id) { return String(id || '').slice(0,8); }
function bytes(value) { if (value < 1024) return `${value} B`; if (value < 1024*1024) return `${(value/1024).toFixed(1)} KB`; return `${(value/1024/1024).toFixed(1)} MB`; }
function isActive(task) { return ACTIVE.has(task?.status); }
function badge(label, status) { return element('span', `badge ${STATUS[status] || REVIEW[status] ? status : ''}`, label); }

function renderList() {
  const tasks = state.tasks.filter((task) => state.filter === 'all' || (state.filter === 'active' ? isActive(task) : task.status === 'succeeded' && reviewStatus(task) !== 'accepted'));
  const signature = JSON.stringify([state.selected,state.filter,tasks]);
  $('task-count').textContent = String(state.tasks.length);
  if (signature === state.listSignature) return;
  state.listSignature = signature;
  const list = $('task-list');
  const scroll = list.scrollLeft;
  list.replaceChildren();
  if (!tasks.length) {
    list.append(element('p','list-empty',state.tasks.length ? '没有符合筛选条件的任务。' : '还没有任务。请先在 Codex 中安排工作。'));
    return;
  }
  for (const task of tasks) {
    const item = element('button',`task-item${state.selected === task.id ? ' selected' : ''}`);
    item.type = 'button'; item.setAttribute('aria-pressed',String(state.selected === task.id));
    item.append(element('span','task-item-title',task.title || `任务 ${shortId(task.id)}`));
    const meta = element('span','task-item-meta');
    const accepted = reviewStatus(task) === 'accepted';
    meta.append(badge(accepted ? '验收通过' : STATUS[task.status] || task.status, accepted ? 'accepted' : task.status),element('span','',dateText(task.createdAt)));
    item.append(meta);
    item.addEventListener('click',() => selectTask(task.id));
    list.append(item);
  }
  list.scrollLeft = scroll;
}

function renderTask(task) {
  state.task = task;
  $('detail-loading').hidden = true;
  $('welcome').hidden = true;
  $('task-detail').hidden = false;
  $('task-reference').textContent = `任务 ${shortId(task.id)}`;
  $('task-title').textContent = task.title || `任务 ${shortId(task.id)}`;
  $('task-status').textContent = STATUS[task.status] || task.status;
  $('task-status').className = `badge ${STATUS[task.status] ? task.status : ''}`;
  const review = reviewStatus(task);
  $('task-review').textContent = REVIEW[review] || '待验收';
  $('task-review').className = `badge review-badge ${REVIEW[review] ? review : ''}`;
  $('task-review').hidden = isActive(task);
  $('task-updated').textContent = `更新于 ${dateText(task.updatedAt,true)}`;
  $('task-model').textContent = typeof task.model === 'string' ? task.model : task.model?.model || state.health?.model || '—';
  $('task-tools').textContent = `${task.toolCalls || 0} 次`;
  $('task-mode').textContent = (task.actualMode || task.mode || 'files') === 'agent' ? '完整代理' : '文件模式';
  $('task-limits').textContent = task.limits ? `${task.limits.maxRuntimeSeconds === 0 ? '不限时' : `${task.limits.maxRuntimeSeconds} 秒`} · ${task.limits.maxToolCalls === 0 ? '不限调用次数' : `${task.limits.maxToolCalls} 次`}` : '—';
  renderTaskHealth(task);
  $('task-instruction').textContent = task.instruction || '任务要求暂不可用。';
  $('task-workspace').textContent = task.workspace || '—';
  const error = typeof task.error === 'string' ? task.error : task.error?.message;
  formError('task-error',error || (task.status === 'interrupted' ? '服务重启前的任务未完成，系统不会自动重复运行。可以新建任务重新提交。' : ''));
  $('cancel-button').hidden = !isActive(task);
  $('cancel-button').disabled = state.actionBusy || task.status === 'cancelling';
  $('cancel-button').textContent = task.status === 'cancelling' ? '正在停止…' : '停止任务';
  const terminal = !isActive(task);
  $('review-panel').hidden = !terminal;
  $('accept-button').disabled = state.actionBusy || task.status !== 'succeeded' || (review === 'accepted' && !state.reviewStale);
  $('accept-button').textContent = state.reviewStale ? '重新验收通过' : '标记为验收通过';
  $('changes-button').disabled = state.actionBusy || review === 'needs_changes';
  $('continue-button').hidden = !task.sessionId || !CONTINUABLE.has(task.status);
  $('continue-button').disabled = state.actionBusy;
  const signature = JSON.stringify([task.id,task.review]);
  if (signature !== state.reviewSignature) {
    state.reviewSignature = signature;
    $('review-note').value = task.review?.note || '';
  }
  $('review-heading').textContent = state.reviewStale ? '文件在验收后发生变化，请重新验收' : review === 'accepted' ? '结果已验收通过' : review === 'needs_changes' ? '结果已标记为需要修改' : task.status === 'succeeded' ? '执行完成，还需要检查结果' : '本次执行未完成目标';
  $('review-description').textContent = review === 'accepted' ? '验收结论已保存。继续修改会重新进入待验收状态。' : task.status === 'succeeded' ? '先打开文件核对内容，再记录验收结论。模型完成不等于结果已验收。' : '可以查看执行记录与已有产物；有可继续的会话时，可补充要求后继续执行。';
}

function renderTaskHealth(task) {
  const health = task.health;
  const status = health?.state;
  const label = status === 'suspected_stall' ? '疑似停滞，需检查' : status === 'healthy' ? '运行监测中' : status === 'stopped' ? '本次运行已停止' : isActive(task) ? '等待活动信息' : '本次运行已结束';
  $('task-health-state').textContent = label;
  $('task-health-state').className = `badge ${status === 'suspected_stall' ? 'needs_changes' : status === 'healthy' ? 'running' : ''}`;
  const threshold = health?.stallWarningSeconds ?? task.stallWarningSeconds ?? state.health?.stallWarningSeconds;
  const duration = Number.isFinite(threshold) && threshold > 0 ? `${threshold} 秒` : '一段时间';
  $('task-health-note').textContent = status === 'suspected_stall' ? `已超过 ${duration} 没有新的进展事件，请检查执行记录。长工具调用可能仍在正常工作；此提示不会自动停止任务，也不代表已确认卡死。` : isActive(task) ? '心跳表示执行监督仍在运行；最近进展记录模型或工具活动。长工具调用可能暂时没有新事件。' : '可查看执行记录和产物，确认本次运行结果。';
  $('task-heartbeat').textContent = dateText(task.lastHeartbeatAt, true);
  $('task-progress').textContent = dateText(task.lastProgressAt, true);
}

function renderEvents() {
  $('event-count').textContent = String(state.events.length);
  const list = $('event-list');
  list.replaceChildren();
  if (!state.events.length) { list.append(element('li','panel-empty','还没有执行事件。')); return; }
  for (const event of state.events) {
    const li = element('li');
    const type = event.type || event.event?.type || 'event';
    const tool = event.name || event.tool || event.toolName || event.tool_call?.name;
    const title = `${EVENT_LABELS[type] || type}${typeof tool === 'string' ? ` · ${tool}` : ''}`;
    const heading = element('div','event-heading');
    heading.append(element('span','',title),element('time','',dateText(event.at || event.time || event.timestamp)));
    li.append(heading);
    const details = element('details'); details.append(element('summary','','查看事件详情'));
    const json = JSON.stringify(event,null,2);
    details.append(element('pre','',json.length > 20000 ? `${json.slice(0,20000)}\n…内容已截断` : json));
    li.append(details); list.append(li);
  }
}

function renderResult(result) {
  const stale = Boolean(result.reviewStale);
  if (state.reviewStale !== stale) { state.reviewStale = stale; if (state.task) renderTask(state.task); }
  formError('result-warning',stale ? '文件在验收后发生变化，请重新验收。原验收记录保留，但不代表当前文件已通过检查。' : '');
  const summary = typeof result.summary === 'string' ? result.summary : result.summary?.finalText || result.summary?.text || '';
  $('result-summary').hidden = !summary;
  $('result-summary-text').textContent = summary;
  const artifacts = result.artifacts || [];
  $('artifact-count').textContent = String(artifacts.length);
  const list = $('artifact-list'); list.replaceChildren();
  if (!artifacts.length) { list.append(element('p','panel-empty',isActive(state.task) ? '执行过程中产生的文件会显示在这里。' : '当前任务没有可展示的输出文件。')); return; }
  for (const file of artifacts) {
    const row = element('button','artifact-row'); row.type = 'button';
    const name = element('span'); name.append(element('span','artifact-name',file.path));
    if (file.sha256) name.append(element('span','artifact-hash',`SHA-256 ${file.sha256}`));
    row.append(name,element('span','artifact-meta',`${bytes(file.size)}  查看 →`));
    row.addEventListener('click',() => previewFile(file.path)); list.append(row);
  }
}

async function previewFile(path) {
  const id = state.selected;
  state.previewPath = path;
  $('file-preview').hidden = false;
  $('preview-title').textContent = path;
  $('preview-content').textContent = '正在读取文件…';
  $('preview-note').textContent = '';
  try {
    const result = await rpc('result',{taskId:id,path,maxBytes:24000});
    if (state.selected !== id || state.previewPath !== path) return;
    const file = result.file;
    $('preview-content').textContent = file?.binary ? file.message || '该文件为二进制格式，请在本地使用对应应用打开。' : file?.content ?? '没有可预览的文本内容。';
    $('preview-note').textContent = file?.truncated ? '内容较长，此处仅预览前 24 KB。完整文件保存在任务的 output 目录中。' : '只读预览，修改要求请通过“继续修改”提交。';
  } catch (error) {
    if (state.selected === id && state.previewPath === path) $('preview-content').textContent = error.message;
  }
}

async function selectTask(id) {
  state.selected = id; state.task = null; state.cursor = 0; state.events = []; state.previewPath = null; state.reviewStale = false; state.reviewSignature = '';
  $('file-preview').hidden = true; $('task-detail').hidden = true; $('welcome').hidden = true; $('detail-loading').hidden = false;
  renderList(); renderEvents();
  setTab('results');
  await refresh();
}

function renderHealth(health) {
  state.health = health;
  $('service-label').textContent = health.ok ? '本地服务已连接' : '连接配置需检查';
  $('service-dot').className = `dot ${health.ok ? 'ready' : 'failed'}`;
  $('version-label').textContent = health.version ? `v${health.version}` : '';
  $('health-model').textContent = `模型：${health.provider || '—'} / ${health.model || '—'} · 推理档位：${health.reasoningEffort || '—'}`;
  const list = $('health-checks'); list.replaceChildren();
  for (const check of health.checks || []) {
    const row = element('div',`health-check${check.ok ? '' : ' failed'}`);
    const body = element('div','',check.label);
    if (check.message) body.append(element('p','',check.message));
    row.append(body,element('span','',check.ok ? '可用' : '需检查')); list.append(row);
  }
  if (!health.checks?.length) list.append(element('p','muted','服务已响应，未提供额外配置检查。'));
  configureLimits(health.limits);
  configureMode(health, !$('create-dialog').open);
}

/** Serialize polling while preserving selection changes made during requests. */
async function refresh(withHealth = false) {
  if (!state.token) return;
  if (state.refreshing) { state.needsRefresh = true; return; }
  state.refreshing = true; $('refresh-button').disabled = true;
  try {
    if (withHealth || !state.health) renderHealth(await rpc('health'));
    const listing = await rpc('list');
    state.tasks = listing.tasks || []; renderList();
    if (state.selected) {
      const id = state.selected;
      const detail = await rpc('get',{taskId:id,afterEvent:state.cursor});
      if (state.selected === id) {
        renderTask(detail.task);
        if (detail.events?.length) { state.events.push(...detail.events); renderEvents(); }
        state.cursor = detail.nextCursor ?? state.cursor;
        const result = await rpc('result',{taskId:id});
        if (state.selected === id) renderResult(result);
      }
    }
    notice();
    if (state.health?.ok) { $('service-label').textContent = '本地服务已连接'; $('service-dot').className = 'dot ready'; }
  } catch (error) {
    notice(error.message); $('service-label').textContent = '连接需检查'; $('service-dot').className = 'dot failed';
    if (state.selected && !state.task) { $('detail-loading').hidden = true; $('welcome').hidden = false; $('task-detail').hidden = true; }
  } finally {
    state.refreshing = false; $('refresh-button').disabled = false;
    if (state.needsRefresh) { state.needsRefresh = false; void refresh(); }
  }
}

function setTab(name) {
  for (const tab of ['results','events']) {
    const active = name === tab;
    $(`${tab}-tab`).setAttribute('aria-selected',String(active));
    $(`${tab}-tab`).tabIndex = active ? 0 : -1;
    $(`${tab}-panel`).hidden = !active;
  }
}

function configureLimits(limits) {
  for (const [id, key] of [['runtime-limit', 'maxRuntimeSeconds'], ['tool-limit', 'maxToolCalls']]) {
    const input = $(id);
    const maximum = Number(limits?.[key] ?? 0);
    input.min = maximum > 0 ? '1' : '0';
    if (maximum > 0) input.max = String(maximum);
    else input.removeAttribute('max');
    if (!$('create-dialog').open) {
      const current = Number(input.value);
      input.value = String(maximum > 0 && (current <= 0 || current > maximum) ? maximum : current);
    }
  }
}

function configureMode(health, reset = false) {
  const supported = Array.isArray(health?.supportedModes) ? health.supportedModes : ['files'];
  const select = $('task-mode-select');
  for (const option of select.options) {
    option.disabled = !supported.includes(option.value);
    if (option.value === 'agent') option.textContent = option.disabled ? '完整代理 · 服务端尚未启用' : '完整代理 · Harness 原生能力';
  }
  if (reset || !supported.includes(select.value)) select.value = supported.includes(health?.defaultMode) ? health.defaultMode : 'files';
  renderModeHelp();
}

function renderModeHelp() {
  $('mode-help').textContent = $('task-mode-select').value === 'files' ? '文件模式只开放受限制的读取、写入和编辑；读 input/ 与 output/，写 output/，不执行命令。' : '完整代理使用 Harness 已配置的命令、文件等能力，须由服务端启用。使用本机权限与 Harness 规则，不是独立的操作系统隔离；浏览器等工具是否可用取决于 Harness 的配置。';
}

function openCreate() {
  if (!state.token) { notice('请使用项目文件夹中的启动入口重新打开面板。'); return; }
  configureLimits(state.health?.limits);
  configureMode(state.health, true);
  formError('create-error'); $('create-dialog').showModal();
  $('instruction').focus();
}

async function runAction(action) {
  if (state.actionBusy) return;
  state.actionBusy = true;
  if (state.task) renderTask(state.task);
  try { await action(); notice(); await refresh(); }
  catch (error) { notice(error.message); }
  finally { state.actionBusy = false; if (state.task) renderTask(state.task); }
}

$('task-mode-select').addEventListener('change',renderModeHelp);
$('new-task-button').addEventListener('click',openCreate);
$('welcome-create').addEventListener('click',openCreate);
$('refresh-button').addEventListener('click',() => refresh(true));
$('service-button').addEventListener('click',() => { $('service-dialog').showModal(); if (state.token) void refresh(true); });
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click',() => $(button.dataset.close).close());
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click',() => {
  state.filter = button.dataset.filter;
  for (const filter of document.querySelectorAll('[data-filter]')) { const active = filter === button; filter.classList.toggle('active',active); filter.setAttribute('aria-pressed',String(active)); }
  renderList();
});
for (const name of ['results','events']) {
  $(`${name}-tab`).addEventListener('click',() => setTab(name));
  $(`${name}-tab`).addEventListener('keydown',(event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); const next = name === 'results' ? 'events' : 'results'; setTab(next); $(`${next}-tab`).focus();
  });
}
$('close-preview').addEventListener('click',() => { state.previewPath = null; $('file-preview').hidden = true; });
$('copy-workspace').addEventListener('click',async () => {
  if (!state.task?.workspace) return;
  try { await navigator.clipboard.writeText(state.task.workspace); toast('工作目录路径已复制。'); }
  catch { toast('浏览器未允许复制。可手动选中上方目录路径复制。'); }
});

$('create-form').addEventListener('submit',async (event) => {
  event.preventDefault(); if (state.creating) return;
  const inputs = $('inputs').value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
  const instruction = $('instruction').value.trim();
  if (!instruction) { formError('create-error','请填写明确的任务要求。'); return; }
  if (inputs.length > 30) { formError('create-error','一次最多提供 30 个输入文件。'); return; }
  const payload = {instruction,inputs,mode:$('task-mode-select').value,maxRuntimeSeconds:Number($('runtime-limit').value),maxToolCalls:Number($('tool-limit').value)};
  const fingerprint = JSON.stringify(payload);
  if (pendingCreate?.fingerprint !== fingerprint) pendingCreate = {fingerprint,requestId:crypto.randomUUID()};
  state.creating = true; $('submit-button').disabled = true; $('submit-button').textContent = '正在提交…'; formError('create-error');
  try {
    const response = await rpc('submit',{...payload,requestId:pendingCreate.requestId});
    const task = response.task || response;
    $('create-dialog').close(); $('create-form').reset(); pendingCreate = null;
    toast('任务已提交，正在安排执行。'); await selectTask(task.id);
  } catch (error) { formError('create-error',error.message); }
  finally { state.creating = false; $('submit-button').disabled = false; $('submit-button').textContent = '提交任务'; }
});

$('cancel-button').addEventListener('click',() => {
  const id = state.selected;
  void runAction(async () => { await rpc('cancel',{taskId:id}); toast('停止请求已处理。'); });
});
for (const [id,status] of [['accept-button','accepted'],['changes-button','needs_changes']]) {
  $(id).addEventListener('click',() => {
    const taskId = state.selected; const note = $('review-note').value.trim();
    if (!note) { toast('请先填写实际检查结果，再记录验收结论。'); $('review-note').focus(); return; }
    void runAction(async () => { await rpc('review',{taskId,status,note}); toast(status === 'accepted' ? '验收结论已保存：通过。' : '验收结论已保存：需要修改。'); });
  });
}
$('continue-button').addEventListener('click',() => { formError('continue-error'); $('continue-dialog').showModal(); $('continue-instruction').focus(); });
$('continue-form').addEventListener('submit',async (event) => {
  event.preventDefault(); if (state.continuing) return;
  const instruction = $('continue-instruction').value.trim();
  if (!instruction) { formError('continue-error','请填写补充要求。'); return; }
  const taskId = state.selected;
  const fingerprint = JSON.stringify([taskId,instruction]);
  if (pendingContinue?.fingerprint !== fingerprint) pendingContinue = {fingerprint,requestId:crypto.randomUUID()};
  state.continuing = true; $('continue-submit').disabled = true; $('continue-submit').textContent = '正在提交…'; formError('continue-error');
  try {
    await rpc('continue',{taskId,instruction,requestId:pendingContinue.requestId});
    $('continue-dialog').close(); $('continue-form').reset(); pendingContinue = null;
    toast('补充要求已提交，任务将继续执行。'); await refresh();
  } catch (error) { formError('continue-error',error.message); }
  finally { state.continuing = false; $('continue-submit').disabled = false; $('continue-submit').textContent = '继续执行'; }
});

async function poll() {
  if (!document.hidden) await refresh();
  clearTimeout(state.timer);
  state.timer = setTimeout(poll,state.tasks.some(isActive) ? 2500 : 8000);
}
document.addEventListener('visibilitychange',() => { if (!document.hidden) { clearTimeout(state.timer); void poll(); } });
window.addEventListener('pagehide',() => clearTimeout(state.timer));
takeToken();
if (!state.token) {
  $('service-label').textContent = '需要重新连接'; $('service-dot').className = 'dot failed';
  $('task-list').replaceChildren(element('p','list-empty','请通过启动入口打开此面板。'));
  $('new-task-button').disabled = true; $('welcome-create').disabled = true;
  $('health-checks').replaceChildren(element('p','muted','页面缺少连接凭据，尚未读取服务状态。'));
  notice('请双击项目文件夹中的启动入口打开任务面板。连接凭据不会显示在页面中。');
} else { void poll(); }
