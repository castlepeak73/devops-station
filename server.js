const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { execFile } = require('child_process');
const httpClient = require('http');
const httpsClient = require('https');
const db = require('./db');

const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const sendJson = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const readBody = req => new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } }); });
const isIpv4 = value => /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(value);
const insertAudit = (action) => db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run('青山', action, now());

function ping(target) {
  const args = process.platform === 'win32' ? ['-n', '1', '-w', '1500', target] : ['-c', '1', '-W', '2', target];
  return new Promise(resolve => execFile('ping', args, { timeout: 3000 }, error => resolve({ result: error ? '异常' : '成功', details: error ? '主机无响应或 Ping 被防火墙阻止' : '主机可达' })));
}

function tcp(target, port) {
  return new Promise(resolve => {
    const started = Date.now(); const socket = net.createConnection({ host: target, port });
    const done = (result, details) => { socket.destroy(); resolve({ result, details }); };
    socket.setTimeout(2500); socket.once('connect', () => done('成功', `TCP ${port} 可连接，耗时 ${Date.now() - started}ms`));
    socket.once('timeout', () => done('异常', `TCP ${port} 连接超时`)); socket.once('error', error => done('异常', `TCP ${port} 不可用：${error.code || error.message}`));
  });
}

function web(target, port, requestPath, secure) {
  return new Promise(resolve => {
    const client = secure ? httpsClient : httpClient; const protocol = secure ? 'https' : 'http';
    const request = client.get({ hostname: target, port, path: requestPath || '/', timeout: 4000, rejectUnauthorized: false }, response => {
      response.resume(); const result = response.statusCode < 400 ? '成功' : '异常'; resolve({ result, details: `${protocol.toUpperCase()} ${response.statusCode} · ${target}:${port}${requestPath || '/'}` });
    });
    request.once('timeout', () => request.destroy(new Error('请求超时'))); request.once('error', error => resolve({ result: '异常', details: `${protocol.toUpperCase()} 请求失败：${error.message}` }));
  });
}

function certificate(target, port) {
  return new Promise(resolve => {
    const socket = tls.connect({ host: target, port, servername: target, rejectUnauthorized: false, timeout: 4000 }, () => {
      const cert = socket.getPeerCertificate(); socket.end();
      if (!cert || !cert.valid_to) return resolve({ result: '异常', details: '未读取到 TLS 证书' });
      const expiry = new Date(cert.valid_to); const days = Math.ceil((expiry - Date.now()) / 86400000);
      resolve({ result: days < 0 ? '异常' : '成功', details: `证书到期：${expiry.toLocaleDateString('zh-CN')}（剩余 ${days} 天）` });
    });
    socket.once('timeout', () => { socket.destroy(); resolve({ result: '异常', details: 'TLS 连接超时' }); }); socket.once('error', error => resolve({ result: '异常', details: `TLS 连接失败：${error.message}` }));
  });
}

async function executeTask(task) {
  if (task.kind === 'ping') return ping(task.target);
  if (task.kind === 'tcp') return tcp(task.target, task.port);
  if (task.kind === 'http') return web(task.target, task.port || 80, task.request_path, false);
  if (task.kind === 'https') return web(task.target, task.port || 443, task.request_path, true);
  return certificate(task.target, task.port || 443);
}

function dashboard() {
  return {
    assets: db.prepare('SELECT id, name, ip, environment AS env, type, owner, status, last_check AS "check", service FROM assets ORDER BY id').all(),
    alerts: db.prepare("SELECT id, level, title, detail, asset, acknowledged, created_at AS time FROM alerts WHERE status = 'open' ORDER BY id").all(),
    records: db.prepare('SELECT task_name AS name, scope, result, executed_at AS time FROM check_runs ORDER BY id DESC LIMIT 10').all(),
    audit: db.prepare('SELECT actor, action, created_at AS time FROM audit_logs ORDER BY id DESC LIMIT 10').all()
    , tasks: db.prepare('SELECT id, name, kind, target, port, request_path AS requestPath FROM check_tasks ORDER BY id DESC').all()
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/dashboard') return sendJson(res, 200, dashboard());
    if (req.method === 'POST' && url.pathname === '/api/assets') {
      const { name, ip, environment, type, owner } = await readBody(req);
      if (![name, ip, environment, type, owner].every(value => typeof value === 'string' && value.trim()) || !isIpv4(ip.trim())) return sendJson(res, 422, { error: '请填写完整且有效的 IPv4 资产信息' });
      const service = name.trim().replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
      db.prepare(`INSERT INTO assets (name, ip, environment, type, owner, status, last_check, service) VALUES (?, ?, ?, ?, ?, '正常', '待首次巡检', ?)`)
        .run(name.trim(), ip.trim(), environment.trim(), type.trim(), owner.trim(), service);
      insertAudit(`添加了资产 ${name.trim()}`); return sendJson(res, 201, dashboard());
    }
    const assetMatch = url.pathname.match(/^\/api\/assets\/(\d+)$/);
    if (assetMatch && req.method === 'PUT') {
      const id = Number(assetMatch[1]); const { name, ip, environment, type, owner } = await readBody(req);
      if (![name, ip, environment, type, owner].every(value => typeof value === 'string' && value.trim()) || !isIpv4(ip.trim())) return sendJson(res, 422, { error: '请填写完整且有效的 IPv4 资产信息' });
      const updated = db.prepare('UPDATE assets SET name = ?, ip = ?, environment = ?, type = ?, owner = ? WHERE id = ?').run(name.trim(), ip.trim(), environment.trim(), type.trim(), owner.trim(), id);
      if (!updated.changes) return sendJson(res, 404, { error: '未找到资产' }); insertAudit(`修改了资产 ${name.trim()}`); return sendJson(res, 200, dashboard());
    }
    if (assetMatch && req.method === 'DELETE') {
      const asset = db.prepare('SELECT name FROM assets WHERE id = ?').get(Number(assetMatch[1])); if (!asset) return sendJson(res, 404, { error: '未找到资产' });
      db.prepare('DELETE FROM assets WHERE id = ?').run(Number(assetMatch[1])); insertAudit(`删除了资产 ${asset.name}`); return sendJson(res, 200, dashboard());
    }
    if (req.method === 'POST' && url.pathname === '/api/check-tasks') {
      const { name, kind, target, port, requestPath } = await readBody(req);
      const allowed = ['ping', 'tcp', 'http', 'https', 'tls']; const validPort = Number(port || (kind === 'http' ? 80 : 443));
      if (!name?.trim() || !allowed.includes(kind) || !isIpv4(target) || (kind !== 'ping' && (!Number.isInteger(validPort) || validPort < 1 || validPort > 65535))) return sendJson(res, 422, { error: '请填写有效的任务名称、目标 IPv4 地址和端口' });
      const result = db.prepare('INSERT INTO check_tasks (name, kind, target, port, request_path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(name.trim(), kind, target, kind === 'ping' ? null : validPort, requestPath || '/', now());
      insertAudit(`创建了巡检任务 ${name.trim()}`); return sendJson(res, 201, { taskId: result.lastInsertRowid, ...dashboard() });
    }
    const taskRunMatch = url.pathname.match(/^\/api\/check-tasks\/(\d+)\/run$/);
    if (taskRunMatch && req.method === 'POST') {
      const task = db.prepare('SELECT * FROM check_tasks WHERE id = ?').get(Number(taskRunMatch[1])); if (!task) return sendJson(res, 404, { error: '未找到巡检任务' });
      const outcome = await executeTask(task); db.prepare('INSERT INTO check_runs (task_name, scope, result, executed_at, details) VALUES (?, ?, ?, ?, ?)').run(task.name, `${task.target}${task.port ? `:${task.port}` : ''}`, outcome.result, now(), outcome.details);
      insertAudit(`执行了巡检任务 ${task.name}：${outcome.result}`); return sendJson(res, 200, { outcome, ...dashboard() });
    }
    if (req.method === 'POST' && url.pathname === '/api/checks/run') {
      const { taskName = '全量巡检' } = await readBody(req);
      db.prepare('INSERT INTO check_runs (task_name, scope, result, executed_at) VALUES (?, ?, ?, ?)').run(taskName, '生产环境 · 自动检测', '成功', now());
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run('陈宇', `执行了「${taskName}」`, now());
      return sendJson(res, 201, dashboard());
    }
    const closeMatch = url.pathname.match(/^\/api\/alerts\/(\d+)\/close$/);
    if (req.method === 'POST' && closeMatch) {
      const id = Number(closeMatch[1]);
      const updated = db.prepare("UPDATE alerts SET status = 'closed' WHERE id = ? AND status = 'open'").run(id);
      if (!updated.changes) return sendJson(res, 404, { error: '未找到待处理告警' });
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run('陈宇', `关闭了告警 #AL-${2900 + id}`, now());
      return sendJson(res, 200, dashboard());
    }
    const acknowledgeMatch = url.pathname.match(/^\/api\/alerts\/(\d+)\/acknowledge$/);
    if (req.method === 'POST' && acknowledgeMatch) {
      const id = Number(acknowledgeMatch[1]);
      const updated = db.prepare("UPDATE alerts SET acknowledged = 1 WHERE id = ? AND status = 'open'").run(id);
      if (!updated.changes) return sendJson(res, 404, { error: '未找到待处理告警' });
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run('青山', `确认了告警 #AL-${2900 + id}`, now());
      return sendJson(res, 200, dashboard());
    }
    if (req.method === 'GET' && url.pathname === '/api/audit/export') {
      const lines = ['操作人,操作内容,时间', ...db.prepare('SELECT actor, action, created_at FROM audit_logs ORDER BY id DESC').all().map(row => [row.actor, row.action, row.created_at].map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))];
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-logs.csv"' });
      return res.end(`\uFEFF${lines.join('\n')}`);
    }
    const assetPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(__dirname, assetPath);
    if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendJson(res, 404, { error: '未找到资源' });
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (error) { sendJson(res, 400, { error: error.message }); }
});

server.listen(port, () => console.log(`运维检测台运行在 http://localhost:${port}`));
