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
  ['#add-asset', '#new-check', '#run-all', '#run-host-check'].forEach(selector => { const element = $(selector); if (element) element.hidden = readOnly; });
  document.querySelectorAll('.run').forEach(button => button.hidden = readOnly);
  $('#threshold-form').querySelectorAll('input, button').forEach(element => element.disabled = readOnly);
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
  audit = data.audit;
  auditPagination = { ...auditPagination, page: 1, total: audit.length, totalPages: 1 };
  customTasks = data.tasks || [];
  $('#check-asset').innerHTML = assets.map(asset => `<option value="${asset.id}" data-ip="${asset.ip}">${asset.name} · ${asset.ip}</option>`).join('');
  renderAssets(); renderAlerts(); renderSidebarCounts(); renderServices(); renderChecks(); renderAudit(); applyPermissions();
  $('#updated-at').textContent = '刚刚';
}

async function refreshDashboard() {
  try { applyDashboard(await request('/api/dashboard')); }
  catch (error) { toast('无法连接本机服务，请先启动后端'); }
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
$('#new-check').addEventListener('click', () => openModal('check-modal'));
$('#run-all').addEventListener('click', () => runCheck('全量巡检'));

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
  const payload = { name: $('#custom-check-name').value.trim(), target: selectedOption?.dataset.ip, kind, port: Number($('#check-port').value), requestPath: $('#check-path').value.trim() || '/', assetId: Number($('#check-asset').value), connectionType: kind === 'host' ? $('#connection-type').value : null, sshPort: Number($('#ssh-port').value), sshUsername: $('#ssh-username').value.trim(), sshKeyPath: $('#ssh-key-path').value.trim(), sshPlatform: $('#ssh-platform').value };
  closeModal('check-modal'); event.target.reset();
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
  const deleteUserId = event.target.dataset.deleteUser;
  const auditPage = Number(event.target.dataset.auditPage);
  const historyPage = Number(event.target.dataset.historyPage);
  if (task) return runCheck(task);
  if (auditPage) { auditPagination.page = auditPage; return refreshAuditSearch(); }
  if (historyPage) { alertHistoryPagination.page = historyPage; return refreshAlertHistory(); }
  if (event.target.dataset.runCustom) return runCustomCheck(event.target.dataset.runCustom);
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
  $('#check-form').reset(); $('#check-kind').value = 'host'; $('#check-asset').value = String(asset.id); $('#custom-check-name').value = `${asset.name} 整机健康检查`; $('#check-kind').dispatchEvent(new Event('change')); openModal('check-modal');
});

function updateClock() { $('#clock').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()) + ' CST'; }
updateClock(); window.setInterval(updateClock, 1000); loadCurrentUser().then(refreshDashboard).catch(error => toast(error.message));
