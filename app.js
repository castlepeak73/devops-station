let assets = [];
let alerts = [];
let records = [];
let audit = [];
let customTasks = [];
let selectedAssetId = null;
let filters = { query: '', environment: '', status: '', alertLevel: '', auditQuery: '' };
let auditPagination = { page: 1, total: 0, totalPages: 1, pageSize: 10, from: '', to: '' };
let alertHistory = [];
let alertHistoryPagination = { page: 1, total: 0, totalPages: 1, pageSize: 10, query: '', status: '', from: '', to: '' };
let checkPagination = { page: 1, total: 0, totalPages: 1, pageSize: 6 };
let taskPagination = { page: 1, total: 0, totalPages: 1, pageSize: 6 };

const tasks = [
  ['◌', '主机连通性检测', '验证目标主机网络连通与延迟'],
  ['▤', '磁盘空间巡检', '检查所有挂载点的剩余容量'],
  ['⌁', '服务端口检测', '验证关键服务端口监听状态'],
  ['⌁', 'HTTP 健康检查', '请求服务健康检查端点'],
  ['◇', 'SSL 证书检测', '检查证书有效期与签发状态']
];

const $ = selector => document.querySelector(selector);
const statusClass = status => status === '正常' ? 'ok' : status === '注意' ? 'warn' : 'down';

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.classList.remove('show'), 2600);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (response.status === 401) { window.location.replace('/login.html'); throw new Error('登录状态已失效'); }
  if (!response.ok) { const error = new Error(data.error || '请求失败'); error.fields = data.errors; throw error; }
  return data;
}

let currentUser = null;
const roleLabel = role => ({ admin: '管理员', operator: '运维人员', viewer: '只读人员' }[role] || role);

async function loadCurrentUser() {
  const status = await request('/api/auth/status');
  if (!status.user) return window.location.replace('/login.html');
  currentUser = status.user;
  $('#current-user-name').textContent = currentUser.displayName;
  $('#current-user-role').textContent = roleLabel(currentUser.role);
  $('#current-user-avatar').textContent = currentUser.displayName.slice(0, 2).toUpperCase();
}

async function renderUsers() {
  const data = await request('/api/users');
  $('#user-list').innerHTML = data.users.map(user => `<div class="user-list-item"><div><b>${user.displayName}</b><small>${user.username} · ${roleLabel(user.role)}</small></div><span class="badge ${user.role === 'viewer' ? 'warn' : 'ok'}">${roleLabel(user.role)}</span><button class="text-button" data-delete-user="${user.id}" ${user.id === currentUser.id ? 'disabled' : ''}>删除</button></div>`).join('');
}

function setAccountTab(tab) {
  document.querySelectorAll('.account-tab').forEach(button => button.classList.toggle('active', button.dataset.accountTab === tab));
  $('#profile-panel').hidden = tab !== 'profile';
  $('#users-panel').hidden = tab !== 'users';
}

async function loadProfile() {
  const data = await request('/api/auth/profile');
  currentUser = data.user;
  $('#profile-display-name').value = currentUser.displayName;
  $('#profile-username').value = currentUser.username;
  $('#profile-role').value = roleLabel(currentUser.role);
}

async function openUserManagement() {
  await loadProfile();
  const isAdmin = currentUser.role === 'admin';
  $('#users-tab').hidden = !isAdmin;
  if (isAdmin) await renderUsers();
  setAccountTab('profile'); openModal('users-modal');
}

function applyPermissions() {
  const readOnly = currentUser?.role === 'viewer';
  ['#add-asset', '#new-check', '#run-host-check'].forEach(selector => { const element = $(selector); if (element) element.hidden = readOnly; });
  document.querySelectorAll('.run, .task-delete, .task-schedule').forEach(button => button.hidden = readOnly);
  $('#threshold-form').querySelectorAll('input, button').forEach(element => element.disabled = readOnly);
}

function renderOverview(summary = {}) {
  const assetTotal = Number(summary.assetTotal || 0);
  const healthyAssets = Number(summary.healthyAssets || 0);
  const openAlerts = Number(summary.openAlerts || 0);
  const todayChecks = Number(summary.todayChecks || 0);
  const name = currentUser?.displayName || '你';
  $('#asset-total').textContent = assetTotal;
  $('#healthy-assets').textContent = healthyAssets;
  $('#healthy-asset-total').textContent = assetTotal;
  $('#health-rate').textContent = `${Number(summary.healthRate || 0)}%`;
  $('#alert-count').textContent = openAlerts;
  $('#alert-summary-text').textContent = openAlerts ? '当前待处理告警' : '当前没有待处理告警';
  $('#today-checks').textContent = todayChecks;
  $('#check-success-rate').textContent = `${Number(summary.checkSuccessRate || 0)}%`;
  $('#overview-greeting').textContent = openAlerts ? `你好，${name}。当前有 ${openAlerts} 条告警待处理。` : `你好，${name}。当前没有待处理告警。`;
}

function filteredAssets() {
  return assets.filter(asset => {
    const matchesQuery = Object.values(asset).join(' ').toLowerCase().includes(filters.query.toLowerCase());
    return matchesQuery && (!filters.environment || asset.env === filters.environment) && (!filters.status || asset.status === filters.status);
  });
}

function renderAssets() {
  const rows = filteredAssets();
  $('#asset-body').innerHTML = rows.length ? rows.map(asset => `
    <tr>
      <td class="asset-name">${asset.name}<small>${asset.service}</small></td>
      <td class="mono">${asset.ip}</td>
      <td><span class="env ${asset.env === '测试' ? 'test' : ''}">${asset.env}环境</span></td>
      <td>${asset.type}</td><td>${asset.owner}</td>
      <td><span class="status ${statusClass(asset.status)}">${asset.status}</span></td>
      <td>${asset.check}</td><td><button class="row-menu" title="主机详情" data-detail-asset="${asset.id}">详情</button>${currentUser?.role === 'viewer' ? '' : `<button class="row-menu" title="编辑资产" data-edit-asset="${asset.id}">编辑</button><button class="row-menu" title="删除资产" data-delete-asset="${asset.id}">删除</button>`}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty-cell">没有符合条件的资产</td></tr>';
}

function renderAlerts() {
  const visibleAlerts = alerts.filter(alert => !filters.alertLevel || alert.level === filters.alertLevel);
  $('#dashboard-alerts').innerHTML = alerts.slice(0, 3).map(alert => `
    <div class="alert-row"><span class="severity ${alert.level}"></span><div><strong>${alert.title}</strong><small>${alert.asset}</small></div><time class="alert-time">${alert.time}</time></div>`).join('');
  $('#alert-list').innerHTML = visibleAlerts.length ? visibleAlerts.map(alert => `
    <div class="alert-full"><span class="severity ${alert.level}"></span><div><strong>${alert.title}</strong><p>${alert.detail} · ${alert.asset} · ${alert.time}${alert.acknowledged ? ' · 已确认' : ''}</p></div>${currentUser?.role === 'viewer' ? '' : `<div class="alert-actions">
      <button class="secondary" ${alert.acknowledged ? 'disabled' : ''} data-acknowledge="${alert.id}">${alert.acknowledged ? '已确认' : '确认告警'}</button>
      <button class="primary" data-close-alert="${alert.id}">关闭告警</button></div>`}</div>`).join('') : '<div class="empty">当前没有符合条件的待处理告警。</div>';
  $('#alert-count').textContent = alerts.length;
  $('#all-alert-count').textContent = alerts.length;
  $('#sidebar-alert-count').textContent = alerts.length;
  updateAlertUnreadState();
}

function alertReadKey() { return `devops-station-alert-seen-${currentUser?.username || 'anonymous'}`; }
function updateAlertUnreadState() {
  const latestId = alerts.reduce((latest, alert) => Math.max(latest, Number(alert.id) || 0), 0);
  const seenId = Number(localStorage.getItem(alertReadKey()) || 0);
  const unread = latestId > seenId;
  const badge = $('#sidebar-alert-count');
  badge.classList.toggle('danger', unread);
  badge.classList.toggle('unread', unread);
  $('#notifications').querySelector('em').hidden = !unread;
}

function markAlertsRead() {
  const latestId = alerts.reduce((latest, alert) => Math.max(latest, Number(alert.id) || 0), 0);
  localStorage.setItem(alertReadKey(), String(latestId));
  updateAlertUnreadState();
}

function renderSidebarCounts() {
  $('#sidebar-asset-count').textContent = assets.length;
}

function renderServices() {
  $('#service-list').innerHTML = assets.slice(0, 5).map(asset => `
    <div class="service-row"><span class="service-dot" style="background:${asset.status === '正常' ? '#23b28a' : asset.status === '注意' ? '#e4a13a' : '#df5961'}"></span><div><b>${asset.service}</b><small>${asset.ip}</small></div><span class="badge ${asset.status === '正常' ? 'ok' : 'warn'}">${asset.status === '正常' ? '正常' : '需关注'}</span></div>`).join('');
}

function renderChecks() {
  $('#recent-checks').innerHTML = records.slice(0, 3).map(record => `
    <div class="recent-item"><span class="check-status">${record.result === '成功' ? '✓' : record.result === '无监听' ? '−' : '!'}</span><div><b>${record.name}</b><small>${record.scope}</small></div><time>${record.time}</time>${record.id ? `<button class="text-button" data-check-detail="${record.id}">详情</button>` : ''}</div>`).join('');
  $('#check-cards').innerHTML = tasks.map(task => `
    <div class="check-card"><span class="task-icon">${task[0]}</span><div><b>${task[1]}</b><p>${task[2]}</p></div><button class="run" data-run="${task[1]}">运行</button></div>`).join('');
  $('#execution-list').innerHTML = records.map(record => `
    <div class="execution-item"><span class="check-status">${record.result === '成功' ? '✓' : record.result === '无监听' ? '−' : '!'}</span><div><b>${record.name}</b><p>${record.scope}</p><time>${record.time}</time></div><span class="badge ${record.result === '成功' ? 'ok' : 'warn'}">${record.result}</span>${record.id ? `<button class="text-button" data-check-detail="${record.id}">查看</button>` : ''}</div>`).join('');
  $('#custom-task-list').innerHTML = customTasks.length ? customTasks.map(task => `
    <div class="check-card"><span class="task-icon">${task.kind === 'ping' ? '◌' : task.kind === 'tcp' ? '▤' : '⌁'}</span><div><b>${task.name}</b><p>${task.kind.toUpperCase()} · ${task.target}${task.port ? `:${task.port}` : ''}${task.requestPath && task.kind !== 'ping' ? task.requestPath : ''}</p></div><button class="run" data-run-custom="${task.id}">运行</button></div>`).join('') : '<div class="empty">尚未创建自定义巡检任务。</div>';
}

function renderChecks() {
  const executionLabel = record => record.executionStatus || (record.result === '异常' ? '失败' : '成功');
  const healthLabel = record => record.healthStatus || '正常';
  const taskKindLabel = kind => ({ host: '整机健康', ping: '主机连通', tcp: 'TCP 端口', http: 'HTTP 服务', https: 'HTTPS 服务', tls: 'TLS 证书' }[kind] || String(kind).toUpperCase());
  $('#recent-checks').innerHTML = records.slice(0, 3).map(record => {
    const execution = executionLabel(record);
    return `<div class="recent-item"><span class="check-status">${execution === '成功' ? '✓' : '!'}</span><div><b>${record.name}</b><small>${record.scope}</small></div><time>${record.time}</time>${record.id ? `<button class="text-button" data-check-detail="${record.id}">详情</button>` : ''}</div>`;
  }).join('');
  $('#task-total').textContent = `${taskPagination.total} 个任务`;
  $('#custom-task-list').innerHTML = customTasks.length ? customTasks.map(task => {
    const target = `${task.target}${task.port ? `:${task.port}` : ''}`;
    const icon = task.kind === 'host' ? '◉' : task.kind === 'ping' ? '⌁' : task.kind === 'tcp' ? '⇄' : task.kind === 'tls' ? '◇' : '⌘';
    const schedule = task.scheduleEnabled ? (task.scheduleMode === 'daily' ? `每天 ${task.scheduleTime}` : `每 ${task.scheduleIntervalMinutes} 分钟`) : '手动执行';
    const actions = currentUser?.role === 'viewer' ? '' : `<button class="task-schedule ${task.scheduleEnabled ? 'active' : ''}" data-toggle-schedule="${task.id}" data-schedule-enabled="${task.scheduleEnabled ? '0' : '1'}" data-schedule-interval="${task.scheduleIntervalMinutes || 15}" data-schedule-mode="${task.scheduleMode || 'interval'}" data-schedule-time="${task.scheduleTime || '16:00'}">${task.scheduleEnabled ? '暂停定时' : '启用定时'}</button><button class="run task-run" data-run-custom="${task.id}">执行</button><button class="task-delete" data-delete-task="${task.id}" title="删除任务">×</button>`;
    return `<article class="task-card"><div class="task-card-head"><span class="task-icon">${icon}</span><span class="task-kind">${taskKindLabel(task.kind)}</span></div><b>${task.name}</b><p>${target}</p><div class="task-card-footer"><span>${task.connectionType === 'ssh' ? 'SSH 采集' : task.kind === 'host' ? '本机采集' : '网络检测'}</span><span class="schedule-status ${task.scheduleEnabled ? 'enabled' : ''}">${schedule}</span><div class="task-actions">${actions}</div></div></article>`;
  }).join('') : '<div class="empty task-empty">还没有巡检任务。创建一个任务后，它会一直保留在这里。</div>';
  $('#execution-summary').textContent = `共 ${checkPagination.total} 条记录`;
  $('#execution-list').innerHTML = records.length ? records.map(record => {
    const execution = executionLabel(record); const health = healthLabel(record);
    return `<div class="execution-item"><span class="check-status">${execution === '成功' ? '✓' : '!'}</span><div><b>${record.name}</b><p>${record.scope}</p><time>${record.time}</time></div><div class="execution-statuses"><span class="badge ${execution === '成功' ? 'ok' : 'warn'}">执行：${execution}</span><span class="badge ${health === '正常' ? 'ok' : 'warn'}">健康：${health}</span></div>${record.id ? `<button class="text-button" data-check-detail="${record.id}">查看</button>` : ''}</div>`;
  }).join('') : '<div class="empty">暂无执行记录。</div>';
  const start = Math.max(1, checkPagination.page - 1); const end = Math.min(checkPagination.totalPages, start + 2);
  $('#check-page-buttons').innerHTML = Array.from({ length: end - start + 1 }, (_, index) => { const page = start + index; return `<button class="filter ${page === checkPagination.page ? 'active' : ''}" data-check-page="${page}">${page}</button>`; }).join('');
  $('#check-prev').disabled = checkPagination.page <= 1;
  $('#check-next').disabled = checkPagination.page >= checkPagination.totalPages;
  const taskStart = Math.max(1, taskPagination.page - 1); const taskEnd = Math.min(taskPagination.totalPages, taskStart + 2);
  $('#task-page-buttons').innerHTML = Array.from({ length: taskEnd - taskStart + 1 }, (_, index) => { const page = taskStart + index; return `<button class="filter ${page === taskPagination.page ? 'active' : ''}" data-task-page="${page}">${page}</button>`; }).join('');
  $('#task-prev').disabled = taskPagination.page <= 1;
  $('#task-next').disabled = taskPagination.page >= taskPagination.totalPages;
}

function renderAudit() {
  $('#audit-list').innerHTML = audit.length ? audit.map(item => `
    <div class="audit-item"><span class="audit-symbol">⌁</span><div><b>${item.actor}${item.actorUsername ? ` <small>(${item.actorUsername})</small>` : ''}</b><p>${item.action}</p></div><time>${item.time}</time></div>`).join('') : '<div class="empty">没有匹配的审计记录。</div>';
  renderAuditPagination();
}

function renderAuditPagination() {
  const { page, total, totalPages } = auditPagination;
  const start = Math.max(1, page - 2); const end = Math.min(totalPages, start + 4);
  $('#audit-page-buttons').innerHTML = Array.from({ length: end - start + 1 }, (_, index) => {
    const number = start + index;
    return `<button class="filter ${number === page ? 'active' : ''}" data-audit-page="${number}">${number}</button>`;
  }).join('');
  $('#audit-prev').disabled = page <= 1;
  $('#audit-next').disabled = page >= totalPages;
  $('#audit-page-summary').textContent = `第 ${page} / ${totalPages} 页，共 ${total} 条`;
  $('#audit-page-input').max = totalPages;
}

async function refreshAuditSearch() {
  try {
    const params = new URLSearchParams({ query: filters.auditQuery, page: String(auditPagination.page) });
    if (auditPagination.from) params.set('from', auditPagination.from);
    if (auditPagination.to) params.set('to', auditPagination.to);
    const data = await request(`/api/audit?${params}`);
    audit = data.audit;
    auditPagination = { ...auditPagination, page: data.page, total: data.total, totalPages: data.totalPages, pageSize: data.pageSize };
    renderAudit();
  } catch (error) { toast(error.message); }
}

function renderAlertHistory() {
  $('#history-list').innerHTML = alertHistory.length ? alertHistory.map(alert => {
    const state = alert.status === 'closed' ? '已关闭' : '待处理';
    const acknowledge = alert.acknowledgedBy ? `已确认：${alert.acknowledgedBy}${alert.acknowledgedAt ? `（${alert.acknowledgedAt}）` : ''}` : '未确认';
    const close = alert.closedBy ? `已关闭：${alert.closedBy}${alert.closedAt ? `（${alert.closedAt}）` : ''}` : '尚未关闭';
    return `<article class="history-item"><div><strong>${alert.title}</strong> <span class="badge ${alert.status === 'closed' ? 'ok' : 'warn'}">${state}</span></div><p>${alert.detail}</p><div class="history-meta"><span>资产：${alert.asset}</span><span>创建：${alert.time}</span><span>${acknowledge}</span><span>${close}</span></div></article>`;
  }).join('') : '<div class="empty">没有匹配的告警历史。</div>';
  const { page, total, totalPages } = alertHistoryPagination;
  const start = Math.max(1, page - 2); const end = Math.min(totalPages, start + 4);
  $('#history-page-buttons').innerHTML = Array.from({ length: end - start + 1 }, (_, index) => {
    const number = start + index;
    return `<button class="filter ${number === page ? 'active' : ''}" data-history-page="${number}">${number}</button>`;
  }).join('');
  $('#history-prev').disabled = page <= 1;
  $('#history-next').disabled = page >= totalPages;
  $('#history-page-summary').textContent = `第 ${page} / ${totalPages} 页，共 ${total} 条`;
  $('#history-page-input').max = totalPages;
}

async function refreshAlertHistory() {
  try {
    const state = alertHistoryPagination;
    const params = new URLSearchParams({ query: state.query, page: String(state.page), status: state.status });
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    const data = await request(`/api/alerts/history?${params}`);
    alertHistory = data.alerts;
    alertHistoryPagination = { ...state, page: data.page, total: data.total, totalPages: data.totalPages, pageSize: data.pageSize };
    renderAlertHistory();
  } catch (error) { toast(error.message); }
}

async function openAlertHistory() {
  alertHistoryPagination.page = 1;
  await refreshAlertHistory();
  openModal('alert-history-modal');
}

function applyDashboard(data) {
  assets = data.assets;
  alerts = data.alerts;
  records = data.records;
  checkPagination = { ...checkPagination, page: 1, total: records.length, totalPages: Math.max(1, Math.ceil(records.length / checkPagination.pageSize)) };
  audit = data.audit;
  auditPagination = { ...auditPagination, page: 1, total: audit.length, totalPages: 1 };
  customTasks = data.tasks || [];
  taskPagination = { ...taskPagination, page: 1, total: customTasks.length, totalPages: Math.max(1, Math.ceil(customTasks.length / taskPagination.pageSize)) };
  $('#check-asset').innerHTML = assets.map(asset => `<option value="${asset.id}" data-ip="${asset.ip}">${asset.name} · ${asset.ip}</option>`).join('');
  renderOverview(data.summary); renderAssets(); renderAlerts(); renderSidebarCounts(); renderServices(); renderChecks(); renderAudit(); applyPermissions();
  $('#updated-at').textContent = '刚刚';
  if ($('#checks').classList.contains('active')) { refreshCheckRuns(); refreshCheckTasks(); }
}

async function refreshDashboard() {
  try { applyDashboard(await request('/api/dashboard')); }
  catch (error) { toast('无法连接本机服务，请先启动后端'); }
}

async function refreshCheckRuns() {
  try {
    const data = await request(`/api/check-runs?page=${checkPagination.page}`);
    records = data.records;
    checkPagination = { page: data.page, total: data.total, totalPages: data.totalPages, pageSize: data.pageSize };
    renderChecks();
  } catch (error) { toast(error.message); }
}

async function refreshCheckTasks() {
  try {
    const data = await request(`/api/check-tasks?page=${taskPagination.page}`);
    customTasks = data.tasks;
    taskPagination = { page: data.page, total: data.total, totalPages: data.totalPages, pageSize: data.pageSize };
    renderChecks();
  } catch (error) { toast(error.message); }
}

async function runCheck(taskName) {
  toast(`正在执行「${taskName}」...`);
  try {
    applyDashboard(await request('/api/checks/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskName }) }));
    toast(`「${taskName}」已完成`);
  } catch (error) { toast(error.message); }
}

function openModal(id) { $(`#${id}`).classList.add('show'); }
function closeModal(id) { $(`#${id}`).classList.remove('show'); }

function setView(view) {
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.view').forEach(section => section.classList.toggle('active', section.id === view));
  const labels = { dashboard: ['控制台', '运行总览'], assets: ['资源中心', '资产管理'], 'asset-detail': ['资源中心', '主机详情'], checks: ['作业中心', '巡检中心'], 'check-detail': ['作业中心', '巡检结果'], alerts: ['事件中心', '告警中心'], audit: ['合规中心', '审计日志'] };
  $('#page-kicker').textContent = labels[view][0]; $('#page-title').textContent = labels[view][1];
  if (view === 'alerts') markAlertsRead();
  if (view === 'checks') { refreshCheckRuns(); refreshCheckTasks(); }
  if (view === 'audit') refreshAuditSearch();
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => setView(button.dataset.go)));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.close)));

$('#asset-search').addEventListener('input', event => { filters.query = event.target.value; renderAssets(); });
$('#audit-search').addEventListener('input', event => {
  filters.auditQuery = event.target.value;
  auditPagination.page = 1;
  window.clearTimeout(refreshAuditSearch.timer);
  refreshAuditSearch.timer = window.setTimeout(refreshAuditSearch, 220);
});
$('#audit-filter').addEventListener('click', () => { auditPagination.from = $('#audit-from').value; auditPagination.to = $('#audit-to').value; auditPagination.page = 1; refreshAuditSearch(); });
$('#audit-reset').addEventListener('click', () => { filters.auditQuery = ''; auditPagination = { ...auditPagination, page: 1, from: '', to: '' }; $('#audit-search').value = ''; $('#audit-from').value = ''; $('#audit-to').value = ''; refreshAuditSearch(); });
$('#audit-prev').addEventListener('click', () => { if (auditPagination.page > 1) { auditPagination.page -= 1; refreshAuditSearch(); } });
$('#audit-next').addEventListener('click', () => { if (auditPagination.page < auditPagination.totalPages) { auditPagination.page += 1; refreshAuditSearch(); } });
$('#audit-go-page').addEventListener('click', () => { const page = Number($('#audit-page-input').value); if (Number.isInteger(page) && page >= 1 && page <= auditPagination.totalPages) { auditPagination.page = page; refreshAuditSearch(); } else toast('请输入有效页码'); });
$('#alert-history').addEventListener('click', () => { openAlertHistory(); });
$('#history-search').addEventListener('input', event => { alertHistoryPagination.query = event.target.value; alertHistoryPagination.page = 1; window.clearTimeout(refreshAlertHistory.timer); refreshAlertHistory.timer = window.setTimeout(refreshAlertHistory, 220); });
$('#history-filter').addEventListener('click', () => { alertHistoryPagination = { ...alertHistoryPagination, page: 1, status: $('#history-status').value, from: $('#history-from').value, to: $('#history-to').value }; refreshAlertHistory(); });
$('#history-reset').addEventListener('click', () => { alertHistoryPagination = { ...alertHistoryPagination, page: 1, query: '', status: '', from: '', to: '' }; $('#history-search').value = ''; $('#history-status').value = ''; $('#history-from').value = ''; $('#history-to').value = ''; refreshAlertHistory(); });
$('#history-prev').addEventListener('click', () => { if (alertHistoryPagination.page > 1) { alertHistoryPagination.page -= 1; refreshAlertHistory(); } });
$('#history-next').addEventListener('click', () => { if (alertHistoryPagination.page < alertHistoryPagination.totalPages) { alertHistoryPagination.page += 1; refreshAlertHistory(); } });
$('#history-go-page').addEventListener('click', () => { const page = Number($('#history-page-input').value); if (Number.isInteger(page) && page >= 1 && page <= alertHistoryPagination.totalPages) { alertHistoryPagination.page = page; refreshAlertHistory(); } else toast('请输入有效页码'); });
$('#asset-environment-filter').addEventListener('change', event => { filters.environment = event.target.value; renderAssets(); });
$('#asset-status-filter').addEventListener('change', event => { filters.status = event.target.value; renderAssets(); });
$('#alert-level-filter').addEventListener('change', event => { filters.alertLevel = event.target.value; renderAlerts(); });
$('#add-asset').addEventListener('click', () => { $('#asset-form').reset(); $('#asset-id').value = ''; $('#asset-modal-title').textContent = '添加资产'; openModal('asset-modal'); });
function syncScheduleSettings() {
  const enabled = $('#schedule-enabled').checked;
  const daily = $('#schedule-mode').value === 'daily';
  $('#schedule-mode-label').hidden = !enabled;
  $('#schedule-interval-label').hidden = !enabled || daily;
  $('#schedule-time-label').hidden = !enabled || !daily;
}

$('#new-check').addEventListener('click', () => { $('#check-form').reset(); syncScheduleSettings(); openModal('check-modal'); });

$('#asset-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#save-asset'); button.disabled = true;
  const id = $('#asset-id').value;
  const payload = { name: $('#asset-name').value, ip: $('#asset-ip').value, type: $('#asset-type').value, owner: $('#asset-owner').value, environment: $('#asset-environment').value };
  try {
    applyDashboard(await request(id ? `/api/assets/${id}` : '/api/assets', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
    event.target.reset(); $('#asset-id').value = ''; closeModal('asset-modal'); setView('assets'); toast(`资产「${payload.name}」已${id ? '更新' : '添加'}`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$('#check-form').addEventListener('submit', async event => {
  event.preventDefault();
  const kind = $('#check-kind').value;
  const selectedOption = $('#check-asset').selectedOptions[0];
  const payload = { name: $('#custom-check-name').value.trim(), target: selectedOption?.dataset.ip, kind, port: Number($('#check-port').value), requestPath: $('#check-path').value.trim() || '/', assetId: Number($('#check-asset').value), connectionType: kind === 'host' ? $('#connection-type').value : null, sshPort: Number($('#ssh-port').value), sshUsername: $('#ssh-username').value.trim(), sshKeyPath: $('#ssh-key-path').value.trim(), sshPlatform: $('#ssh-platform').value, scheduleEnabled: $('#schedule-enabled').checked, scheduleMode: $('#schedule-mode').value, scheduleIntervalMinutes: Number($('#schedule-interval').value), scheduleTime: $('#schedule-time').value };
  closeModal('check-modal'); event.target.reset(); syncScheduleSettings();
  try {
    const data = await request('/api/check-tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    applyDashboard(data); toast('巡检任务已创建，正在执行');
    await runCustomCheck(data.taskId);
  } catch (error) { toast(error.message); }
});

async function runCustomCheck(id) {
  try {
    const data = await request(`/api/check-tasks/${id}/run`, { method: 'POST' });
    const message = data.outcome.result === '成功' ? '巡检正常' : data.outcome.result === '无监听' ? '端口无监听' : '巡检异常';
    applyDashboard(data); toast(`${message}：${data.outcome.details}`);
  } catch (error) { toast(error.message); }
}

function beginEditAsset(id) {
  const asset = assets.find(item => item.id === id); if (!asset) return;
  $('#asset-id').value = asset.id; $('#asset-name').value = asset.name; $('#asset-ip').value = asset.ip; $('#asset-type').value = asset.type; $('#asset-owner').value = asset.owner; $('#asset-environment').value = asset.env;
  $('#asset-modal-title').textContent = '编辑资产'; openModal('asset-modal');
}

async function showAssetDetail(id) {
  try {
    const data = await request(`/api/assets/${id}/metrics`); selectedAssetId = id;
    $('#detail-asset-name').textContent = data.asset.name;
    $('#detail-asset-meta').textContent = `${data.asset.ip} · ${data.asset.env}环境 · ${data.asset.type} · ${data.asset.owner}`;
    $('#cpu-threshold').value = data.asset.cpuThreshold ?? 80; $('#memory-threshold').value = data.asset.memoryThreshold ?? 80; $('#disk-threshold').value = data.asset.diskThreshold ?? 80;
    const latest = data.metrics[0];
    $('#host-metric-cards').innerHTML = latest ? [
      ['CPU 使用率', `${latest.cpuUsage ?? '-'}%`, '最近采集'], ['内存使用率', `${latest.memoryUsage ?? '-'}%`, `${latest.memoryUsed ?? '-'} / ${latest.memoryTotal ?? '-'} MB`], ['系统运行时间', latest.uptime || '-', '最近采集'], ['采集来源', latest.source === 'ssh' ? 'SSH' : '本机', latest.capturedAt]
    ].map(item => `<article class="metric"><div class="metric-label">${item[0]}</div><strong>${item[1]}</strong><p>${item[2]}</p></article>`).join('') : '<article class="metric"><div class="metric-label">尚无采集数据</div><strong>-</strong><p>运行整机健康巡检后显示</p></article>';
    $('#host-disks').innerHTML = latest?.disks?.length ? latest.disks.map(disk => `<div class="service-row"><span class="service-dot" style="background:${disk.usage > 85 ? '#df5961' : disk.usage > 70 ? '#e4a13a' : '#23b28a'}"></span><div><b>${disk.name}</b><small>${disk.usedGb} GB / ${disk.totalGb} GB</small></div><span class="badge ${disk.usage > 85 ? 'warn' : 'ok'}">${disk.usage}%</span></div>`).join('') : '<div class="empty">尚无磁盘数据。</div>';
    $('#host-history').innerHTML = data.metrics.length ? data.metrics.map(metric => `<div class="audit-item"><span class="audit-symbol">⌁</span><div><b>${metric.source === 'ssh' ? 'SSH 采集' : '本机采集'}</b><p>CPU ${metric.cpuUsage ?? '-'}% · 内存 ${metric.memoryUsage ?? '-'}%</p></div><time>${metric.capturedAt}</time></div>`).join('') : '<div class="empty">尚无健康检查历史。</div>';
    setView('asset-detail');
  } catch (error) { toast(error.message); }
}

async function showCheckDetail(id) {
  try {
    const data = await request(`/api/check-runs/${id}`); const { run, task, metrics } = data;
    $('#check-detail-name').textContent = run.name;
    $('#check-detail-meta').textContent = `${run.scope} · ${run.time}${task ? ` · ${task.kind.toUpperCase()}` : ''}`;
    const status = $('#check-detail-status'); status.textContent = run.result; status.className = `badge ${run.result === '成功' ? 'ok' : 'warn'}`;
    $('#check-detail-metrics').innerHTML = metrics ? [
      ['CPU 使用率', `${metrics.cpuUsage ?? '-'}%`, '本次采集'], ['内存使用率', `${metrics.memoryUsage ?? '-'}%`, `${metrics.memoryUsed ?? '-'} / ${metrics.memoryTotal ?? '-'} MB`], ['系统运行时间', metrics.uptime || '-', '本次采集'], ['磁盘数量', `${metrics.disks?.length || 0}`, '已采集分区']
    ].map(item => `<article class="metric"><div class="metric-label">${item[0]}</div><strong>${item[1]}</strong><p>${item[2]}</p></article>`).join('') : '';
    $('#check-detail-output').innerHTML = `<div class="audit-item"><span class="audit-symbol">⌁</span><div><b>执行结果</b><p>${run.details || '该记录为早期模拟或基础巡检，未保存额外返回信息。'}</p></div><time>${run.time}</time></div>${metrics?.disks?.length ? metrics.disks.map(disk => `<div class="audit-item"><span class="audit-symbol">▤</span><div><b>${disk.name}</b><p>${disk.usedGb} GB / ${disk.totalGb} GB · 已使用 ${disk.usage}%</p></div></div>`).join('') : ''}`;
    setView('check-detail');
  } catch (error) { toast(error.message); }
}

$('#export-audit').addEventListener('click', () => { window.location.href = '/api/audit/export'; });
$('#notifications').addEventListener('click', () => setView('alerts'));
$('#help').addEventListener('click', () => toast('可通过资产、巡检、告警与审计模块完成日常运维操作'));
$('#settings').addEventListener('click', () => { openUserManagement().catch(error => toast(error.message)); });
$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#profile-username-error').textContent = ''; $('#profile-display-name-error').textContent = '';
  try {
    const data = await request('/api/auth/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#profile-username').value.trim(), displayName: $('#profile-display-name').value.trim() }) });
    currentUser = data.user;
    $('#current-user-name').textContent = currentUser.displayName;
    $('#current-user-avatar').textContent = currentUser.displayName.slice(0, 2).toUpperCase();
    localStorage.setItem('devops-station-username', currentUser.username);
    toast('个人资料已保存');
  } catch (error) {
    if (error.fields) {
      if (error.fields.username) $('#profile-username-error').textContent = error.fields.username;
      if (error.fields.displayName) $('#profile-display-name-error').textContent = error.fields.displayName;
    } else toast(error.message);
  }
});
$('#user-form').addEventListener('submit', async event => {
  event.preventDefault();
  ['new-username-error', 'new-display-name-error', 'new-password-error', 'new-user-role-error'].forEach(id => $(`#${id}`).textContent = '');
  try {
    await request('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#new-username').value.trim(), displayName: $('#new-display-name').value.trim(), password: $('#new-password').value, role: $('#new-user-role').value }) });
    event.target.reset(); await renderUsers(); toast('账号已创建');
  } catch (error) {
    if (error.fields) {
      if (error.fields.username) $('#new-username-error').textContent = error.fields.username;
      if (error.fields.displayName) $('#new-display-name-error').textContent = error.fields.displayName;
      if (error.fields.password) $('#new-password-error').textContent = error.fields.password;
      if (error.fields.role) $('#new-user-role-error').textContent = error.fields.role;
    } else toast(error.message);
  }
});
$('#logout-button').addEventListener('click', async () => {
  try {
    const keepRemembered = localStorage.getItem('devops-station-remember-session') === 'true';
    await request('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keepRemembered }) });
    window.location.replace('/login.html');
  }
  catch (error) { toast(error.message); }
});
document.addEventListener('click', event => {
  const inputId = event.target.dataset.passwordToggle;
  if (!inputId) return;
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
  event.target.textContent = input.type === 'password' ? '显示' : '隐藏';
});
document.addEventListener('click', async event => {
  const accountTab = event.target.dataset.accountTab;
  if (accountTab) { setAccountTab(accountTab); return; }
  const task = event.target.dataset.run;
  const closeId = event.target.dataset.closeAlert;
  const acknowledgeId = event.target.dataset.acknowledge;
  const editAssetId = event.target.dataset.editAsset;
  const deleteAssetId = event.target.dataset.deleteAsset;
  const detailAssetId = event.target.dataset.detailAsset;
  const checkDetailId = event.target.dataset.checkDetail;
  const deleteTaskId = event.target.dataset.deleteTask;
  const toggleScheduleId = event.target.dataset.toggleSchedule;
  const checkPage = Number(event.target.dataset.checkPage);
  const taskPage = Number(event.target.dataset.taskPage);
  const deleteUserId = event.target.dataset.deleteUser;
  const auditPage = Number(event.target.dataset.auditPage);
  const historyPage = Number(event.target.dataset.historyPage);
  if (task) return runCheck(task);
  if (checkPage) { checkPagination.page = checkPage; return refreshCheckRuns(); }
  if (taskPage) { taskPagination.page = taskPage; return refreshCheckTasks(); }
  if (auditPage) { auditPagination.page = auditPage; return refreshAuditSearch(); }
  if (historyPage) { alertHistoryPagination.page = historyPage; return refreshAlertHistory(); }
  if (event.target.dataset.runCustom) return runCustomCheck(event.target.dataset.runCustom);
  if (toggleScheduleId) {
    try {
      const enabled = event.target.dataset.scheduleEnabled === '1';
      applyDashboard(await request(`/api/check-tasks/${toggleScheduleId}/schedule`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, intervalMinutes: Number(event.target.dataset.scheduleInterval) || 15, mode: event.target.dataset.scheduleMode || 'interval', time: event.target.dataset.scheduleTime || '16:00' }) }));
      toast(enabled ? '已启用定时巡检' : '已暂停定时巡检');
    } catch (error) { toast(error.message); }
    return;
  }
  if (deleteTaskId) {
    if (!window.confirm('确定删除这个巡检任务吗？已有执行记录会继续保留。')) return;
    try { applyDashboard(await request(`/api/check-tasks/${deleteTaskId}`, { method: 'DELETE' })); toast('巡检任务已删除'); }
    catch (error) { toast(error.message); }
    return;
  }
  if (checkDetailId) return showCheckDetail(Number(checkDetailId));
  if (deleteUserId) {
    if (!window.confirm('确定删除该账号吗？')) return;
    try { await request(`/api/users/${deleteUserId}`, { method: 'DELETE' }); await renderUsers(); toast('账号已删除'); } catch (error) { toast(error.message); }
    return;
  }
  if (detailAssetId) return showAssetDetail(Number(detailAssetId));
  if (editAssetId) return beginEditAsset(Number(editAssetId));
  if (deleteAssetId) {
    const asset = assets.find(item => item.id === Number(deleteAssetId));
    if (!asset || !window.confirm(`确定删除资产「${asset.name}」吗？`)) return;
    try { applyDashboard(await request(`/api/assets/${deleteAssetId}`, { method: 'DELETE' })); toast(`资产「${asset.name}」已删除`); } catch (error) { toast(error.message); }
    return;
  }
  try {
    if (closeId) { applyDashboard(await request(`/api/alerts/${closeId}/close`, { method: 'POST' })); toast('告警已关闭并记录到审计日志'); }
    if (acknowledgeId) { applyDashboard(await request(`/api/alerts/${acknowledgeId}/acknowledge`, { method: 'POST' })); toast('告警已确认'); }
  } catch (error) { toast(error.message); }
});

$('#check-kind').addEventListener('change', event => {
  const kind = event.target.value; const port = $('#check-port');
  const host = kind === 'host'; $('#check-asset-label').style.display = 'block'; $('#host-connection-fields').style.display = host ? 'block' : 'none';
  if (kind === 'ping' || host) { $('#check-port-label').style.display = 'none'; $('#check-path-label').style.display = 'none'; }
  else { $('#check-port-label').style.display = 'block'; $('#check-path-label').style.display = 'none'; port.value = kind === 'http' ? 80 : 443; }
});

$('#connection-type').addEventListener('change', event => { $('#ssh-fields').style.display = event.target.value === 'ssh' ? 'block' : 'none'; });
$('#schedule-enabled').addEventListener('change', syncScheduleSettings);
$('#schedule-mode').addEventListener('change', syncScheduleSettings);
$('#check-prev').addEventListener('click', () => { if (checkPagination.page > 1) { checkPagination.page -= 1; refreshCheckRuns(); } });
$('#check-next').addEventListener('click', () => { if (checkPagination.page < checkPagination.totalPages) { checkPagination.page += 1; refreshCheckRuns(); } });
$('#task-prev').addEventListener('click', () => { if (taskPagination.page > 1) { taskPagination.page -= 1; refreshCheckTasks(); } });
$('#task-next').addEventListener('click', () => { if (taskPagination.page < taskPagination.totalPages) { taskPagination.page += 1; refreshCheckTasks(); } });
$('#threshold-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedAssetId) return;
  const payload = { cpuThreshold: Number($('#cpu-threshold').value), memoryThreshold: Number($('#memory-threshold').value), diskThreshold: Number($('#disk-threshold').value) };
  try { applyDashboard(await request(`/api/assets/${selectedAssetId}/thresholds`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })); toast('告警阈值已保存'); }
  catch (error) { toast(error.message); }
});
$('#back-to-assets').addEventListener('click', () => setView('assets'));
$('#back-to-checks').addEventListener('click', () => setView('checks'));
$('#run-host-check').addEventListener('click', () => {
  const asset = assets.find(item => item.id === selectedAssetId); if (!asset) return;
  $('#check-form').reset(); syncScheduleSettings(); $('#check-kind').value = 'host'; $('#check-asset').value = String(asset.id); $('#custom-check-name').value = `${asset.name} 整机健康检查`; $('#check-kind').dispatchEvent(new Event('change')); openModal('check-modal');
});

async function showCheckDetail(id) {
  try {
    const data = await request(`/api/check-runs/${id}`);
    const { run, task, metrics } = data;
    const execution = run.executionStatus || (run.result === '\u5f02\u5e38' ? '\u5931\u8d25' : '\u6210\u529f');
    const health = run.healthStatus || '\u6b63\u5e38';
    $('#check-detail-name').textContent = run.name;
    $('#check-detail-meta').textContent = `${run.scope} | ${run.time}${task ? ` | ${task.kind.toUpperCase()}` : ''}`;
    const status = $('#check-detail-status');
    status.textContent = `\u6267\u884c\uff1a${execution} | \u5065\u5eb7\uff1a${health}`;
    status.className = `badge ${execution === '\u6210\u529f' && health === '\u6b63\u5e38' ? 'ok' : 'warn'}`;
    $('#check-detail-metrics').innerHTML = metrics ? [
      ['CPU', `${metrics.cpuUsage ?? '-'}%`, '\u672c\u6b21\u91c7\u96c6'],
      ['\u5185\u5b58', `${metrics.memoryUsage ?? '-'}%`, `${metrics.memoryUsed ?? '-'} / ${metrics.memoryTotal ?? '-'} MB`],
      ['\u8fd0\u884c\u65f6\u95f4', metrics.uptime || '-', '\u672c\u6b21\u91c7\u96c6'],
      ['\u78c1\u76d8\u6570\u91cf', `${metrics.disks?.length || 0}`, '\u5df2\u91c7\u96c6\u5206\u533a']
    ].map(item => `<article class="metric"><div class="metric-label">${item[0]}</div><strong>${item[1]}</strong><p>${item[2]}</p></article>`).join('') : '';
    const disks = metrics?.disks?.length ? metrics.disks.map(disk => `<div class="audit-item"><span class="audit-symbol">+</span><div><b>${disk.name}</b><p>${disk.usedGb} GB / ${disk.totalGb} GB | ${disk.usage}%</p></div></div>`).join('') : '';
    $('#check-detail-output').innerHTML = `<div class="audit-item"><span class="audit-symbol">i</span><div><b>\u68c0\u6d4b\u7ed3\u679c</b><p>${run.details || '\u672a\u4fdd\u5b58\u989d\u5916\u8fd4\u56de\u4fe1\u606f\u3002'}</p></div><time>${run.time}</time></div>${disks}`;
    setView('check-detail');
  } catch (error) { toast(error.message); }
}

function updateClock() { $('#clock').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()) + ' CST'; }
updateClock(); window.setInterval(updateClock, 1000); loadCurrentUser().then(refreshDashboard).catch(error => toast(error.message));
