const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { execFile } = require('child_process');
const httpClient = require('http');
const httpsClient = require('https');
const crypto = require('crypto');
const { Client: SshClient } = require('ssh2');
const db = require('./db');

const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const sendJson = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const readBody = req => new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } }); });
const isIpv4 = value => /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(value);
const isValidPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 32 && /[A-Za-z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);
const accountErrors = ({ username, displayName, password }, includeName = true) => {
  const errors = {};
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username || '')) errors.username = '用户名需为 3-32 位字母、数字或 . _ -';
  if (includeName && (!String(displayName || '').trim() || String(displayName).trim().length > 32)) errors.displayName = '请输入 1-32 位姓名';
  if (!isValidPassword(password)) errors.password = '密码须为 8-32 位，且包含字母、数字和特殊符号';
  return errors;
};
const insertAudit = (action) => db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run('青山', action, now());
const SESSION_COOKIE = 'devops_station_session';
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const parseCookies = header => Object.fromEntries(String(header || '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(item => item.length === 2));
const userCount = () => db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
const publicUser = user => user && ({ id: user.id, username: user.username, displayName: user.display_name, role: user.role });
const sessionUser = req => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare('SELECT users.id, users.username, users.display_name, users.role, sessions.id AS session_id, sessions.expires_at, sessions.persistent FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?').get(hashToken(token));
  if (!row || row.expires_at < Date.now()) { if (row) db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id); return null; }
  return row;
};
const setSession = (res, userId, remember) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const lifetime = remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, persistent) VALUES (?, ?, ?, ?, ?)').run(hashToken(token), userId, Date.now() + lifetime, Date.now(), remember ? 1 : 0);
  const persistence = remember ? `; Max-Age=${Math.floor(lifetime / 1000)}` : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/${persistence}`);
};
const clearSession = (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
};

function createThresholdAlert(assetId, title, detail) {
  const active = db.prepare("SELECT id FROM alerts WHERE title = ? AND status = 'open'").get(title);
  if (active) return;
  const asset = db.prepare('SELECT name, cpu_threshold AS cpuThreshold, memory_threshold AS memoryThreshold, disk_threshold AS diskThreshold FROM assets WHERE id = ?').get(assetId);
  db.prepare("INSERT INTO alerts (level, title, detail, asset, created_at) VALUES ('warning', ?, ?, ?, ?)").run(title, detail, asset?.name || '未知资产', now());
  insertAudit(`创建了阈值告警：${title}`);
}

function evaluateThresholds(assetId, metrics) {
  const asset = db.prepare('SELECT name, cpu_threshold AS cpuThreshold, memory_threshold AS memoryThreshold, disk_threshold AS diskThreshold FROM assets WHERE id = ?').get(assetId);
  if (!asset) return;
  const findings = [];
  if (Number(metrics.cpu) > asset.cpuThreshold) findings.push([`${asset.name} CPU 使用率过高`, `当前 CPU 使用率 ${metrics.cpu}%，超过 ${asset.cpuThreshold}% 阈值。`]);
  if (Number(metrics.memoryUsage) > asset.memoryThreshold) findings.push([`${asset.name} 内存使用率过高`, `当前内存使用率 ${metrics.memoryUsage}%，超过 ${asset.memoryThreshold}% 阈值。`]);
  (metrics.disks || []).filter(disk => Number(disk.usage) > asset.diskThreshold).forEach(disk => findings.push([`${asset.name} 磁盘 ${disk.name} 使用率过高`, `当前磁盘使用率 ${disk.usage}%，已使用 ${disk.usedGb} GB / ${disk.totalGb} GB，超过 ${asset.diskThreshold}% 阈值。`]));
  findings.forEach(([title, detail]) => createThresholdAlert(assetId, title, detail));
  if (findings.length) db.prepare("UPDATE assets SET status = '告警', last_check = ? WHERE id = ?").run('刚刚', assetId);
  else db.prepare("UPDATE assets SET status = '正常', last_check = ? WHERE id = ? AND status <> '注意'").run('刚刚', assetId);
  return findings;
}

function assetHealthStatus(assetId) {
  if (!assetId) return '正常';
  const asset = db.prepare('SELECT name FROM assets WHERE id = ?').get(assetId);
  if (!asset) return '正常';
  return db.prepare("SELECT COUNT(*) AS total FROM alerts WHERE asset = ? AND status = 'open'").get(asset.name).total > 0 ? '异常' : '正常';
}

function collectLocalWindowsMetrics() {
  const script = "$os=Get-CimInstance Win32_OperatingSystem;$cpu=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average;$disks=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|ForEach-Object {[pscustomobject]@{name=$_.DeviceID;totalGb=[math]::Round($_.Size/1GB,2);usedGb=[math]::Round(($_.Size-$_.FreeSpace)/1GB,2);usage=[math]::Round((1-$_.FreeSpace/$_.Size)*100,1)}};[pscustomobject]@{cpu=[math]::Round($cpu,1);memoryTotal=[math]::Round($os.TotalVisibleMemorySize/1MB,2);memoryUsed=[math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,2);memoryUsage=[math]::Round((1-$os.FreePhysicalMemory/$os.TotalVisibleMemorySize)*100,1);uptime=((Get-Date)-$os.LastBootUpTime).ToString();disks=@($disks)}|ConvertTo-Json -Compress";
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 12000 }, (error, stdout) => {
    if (error) return resolve({ result: '异常', details: `无法采集本机指标：${error.message}` });
    try { resolve({ result: '成功', metrics: JSON.parse(stdout), details: '已采集本机 Windows 指标' }); } catch (_) { resolve({ result: '异常', details: '本机指标解析失败' }); }
  }));
}

function collectWindowsSshMetrics(task) {
  return new Promise(resolve => {
    if (!task.ssh_username || !task.ssh_key_path || !fs.existsSync(task.ssh_key_path)) return resolve({ result: '异常', details: 'SSH 用户名或私钥文件路径无效' });
    const script = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$os=Get-CimInstance Win32_OperatingSystem;$cpu=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average;$disks=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|ForEach-Object {[pscustomobject]@{name=$_.DeviceID;totalGb=[math]::Round($_.Size/1GB,2);usedGb=[math]::Round(($_.Size-$_.FreeSpace)/1GB,2);usage=[math]::Round((1-$_.FreeSpace/$_.Size)*100,1)}};[pscustomobject]@{cpu=[math]::Round($cpu,1);memoryTotal=[math]::Round($os.TotalVisibleMemorySize/1MB,2);memoryUsed=[math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,2);memoryUsage=[math]::Round((1-$os.FreePhysicalMemory/$os.TotalVisibleMemorySize)*100,1);uptime=((Get-Date)-$os.LastBootUpTime).ToString();disks=@($disks)}|ConvertTo-Json -Compress";
    const command = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
    const client = new SshClient(); let settled = false;
    const done = value => { if (!settled) { settled = true; client.end(); resolve(value); } };
    client.on('ready', () => client.exec(command, (error, stream) => {
      if (error) return done({ result: '异常', details: `SSH PowerShell 启动失败：${error.message}` }); let output = ''; let errorOutput = '';
      stream.on('data', data => output += data); stream.stderr.on('data', data => errorOutput += data);
      stream.on('close', code => {
        if (code !== 0) return done({ result: '异常', details: `远程 PowerShell 执行失败：${String(errorOutput || output).slice(0, 180)}` });
        try {
          const metrics = JSON.parse(output.trim().replace(/^\uFEFF/, ''));
          done({ result: '成功', metrics, details: '已通过 SSH 采集 Windows 指标' });
        } catch (_) { done({ result: '异常', details: `远程 Windows 指标解析失败：${String(errorOutput || output).slice(0, 180)}` }); }
      });
    })).on('error', error => done({ result: '异常', details: `SSH 连接失败：${error.message}` })).connect({ host: task.target, port: task.ssh_port || 22, username: task.ssh_username, privateKey: fs.readFileSync(task.ssh_key_path), readyTimeout: 7000 });
  });
}

function collectLinuxSshMetrics(task) {
  return new Promise(resolve => {
    if (!task.ssh_username || !task.ssh_key_path || !fs.existsSync(task.ssh_key_path)) return resolve({ result: '异常', details: 'SSH 用户名或私钥文件路径无效' });
    const client = new SshClient(); let settled = false;
    const done = value => { if (!settled) { settled = true; client.end(); resolve(value); } };
    const run = command => new Promise((resolveCommand, rejectCommand) => client.exec(command, (error, stream) => {
      if (error) return rejectCommand(error); let output = '';
      stream.on('data', data => output += data); stream.stderr.on('data', data => output += data);
      stream.on('close', code => code === 0 ? resolveCommand(output.trim()) : rejectCommand(new Error(output || `退出码 ${code}`)));
    }));
    client.on('ready', async () => {
      try {
        const [cpuOutput, memoryOutput, diskOutput, uptimeOutput] = await Promise.all([
          run("LC_ALL=C top -bn1 | awk '/Cpu/ {print 100-$8; exit}'"), run('LC_ALL=C free -m'), run('LC_ALL=C df -P -B1'), run('uptime -p')
        ]);
        const memory = memoryOutput.split('\n').find(line => line.startsWith('Mem:')).trim().split(/\s+/);
        const disks = diskOutput.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 6).map(parts => ({ name: parts[5], totalGb: Number((Number(parts[1]) / 1073741824).toFixed(2)), usedGb: Number((Number(parts[2]) / 1073741824).toFixed(2)), usage: Number(String(parts[4]).replace('%', '')) }));
        const total = Number(memory[1]); const used = Number(memory[2]);
        done({ result: '成功', metrics: { cpu: Number(Number(cpuOutput).toFixed(1)), memoryTotal: total, memoryUsed: used, memoryUsage: Number((used / total * 100).toFixed(1)), uptime: uptimeOutput, disks }, details: '已通过 SSH 采集 Linux 指标' });
      } catch (error) { done({ result: '异常', details: `SSH 采集失败：${error.message}` }); }
    }).on('error', error => done({ result: '异常', details: `SSH 连接失败：${error.message}` })).connect({ host: task.target, port: task.ssh_port || 22, username: task.ssh_username, privateKey: fs.readFileSync(task.ssh_key_path), readyTimeout: 7000 });
  });
}

function collectMacSshMetrics(task) {
  return new Promise(resolve => {
    if (!task.ssh_username || !task.ssh_key_path || !fs.existsSync(task.ssh_key_path)) return resolve({ result: '异常', details: 'SSH 用户名或私钥文件路径无效' });
    const client = new SshClient(); let settled = false;
    const done = value => { if (!settled) { settled = true; client.end(); resolve(value); } };
    const run = command => new Promise((resolveCommand, rejectCommand) => client.exec(command, (error, stream) => {
      if (error) return rejectCommand(error); let output = '';
      stream.on('data', data => output += data); stream.stderr.on('data', data => output += data);
      stream.on('close', code => code === 0 ? resolveCommand(output.trim()) : rejectCommand(new Error(output || `退出码 ${code}`)));
    }));
    client.on('ready', async () => {
      try {
        const [cpuOutput, totalMemoryOutput, pageSizeOutput, vmStatOutput, diskOutput, uptimeOutput] = await Promise.all([
          run("top -l 1 -n 0 | awk '/CPU usage/ {gsub(\"%\", \"\", $3); gsub(\"%\", \"\", $5); print $3+$5; exit}'"), run('sysctl -n hw.memsize'), run('sysctl -n hw.pagesize'), run('vm_stat'), run('df -kP'), run('uptime')
        ]);
        const pageValue = label => { const match = vmStatOutput.match(new RegExp(`${label}:\\s+(\\d+)\\.`)); return match ? Number(match[1]) : 0; };
        const pageSize = Number(pageSizeOutput); const totalBytes = Number(totalMemoryOutput);
        const usedBytes = (pageValue('Pages active') + pageValue('Pages wired down') + pageValue('Pages occupied by compressor')) * pageSize;
        const disks = diskOutput.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 6).map(parts => ({ name: parts[5], totalGb: Number((Number(parts[1]) * 1024 / 1073741824).toFixed(2)), usedGb: Number((Number(parts[2]) * 1024 / 1073741824).toFixed(2)), usage: Number(String(parts[4]).replace('%', '')) }));
        done({ result: '成功', metrics: { cpu: Number(Number(cpuOutput).toFixed(1)), memoryTotal: Number((totalBytes / 1048576).toFixed(2)), memoryUsed: Number((usedBytes / 1048576).toFixed(2)), memoryUsage: Number((usedBytes / totalBytes * 100).toFixed(1)), uptime: uptimeOutput, disks }, details: '已通过 SSH 采集 macOS 指标' });
      } catch (error) { done({ result: '异常', details: `SSH macOS 采集失败：${error.message}` }); }
    }).on('error', error => done({ result: '异常', details: `SSH 连接失败：${error.message}` })).connect({ host: task.target, port: task.ssh_port || 22, username: task.ssh_username, privateKey: fs.readFileSync(task.ssh_key_path), readyTimeout: 7000 });
  });
}

async function executeHostCheck(task) {
  const outcome = task.connection_type === 'local' ? await collectLocalWindowsMetrics() : task.ssh_platform === 'windows' ? await collectWindowsSshMetrics(task) : task.ssh_platform === 'macos' ? await collectMacSshMetrics(task) : await collectLinuxSshMetrics(task);
  if (outcome.metrics) {
    const metrics = outcome.metrics;
    db.prepare('INSERT INTO host_metrics (asset_id, source, cpu_usage, memory_usage, memory_total, memory_used, disk_json, uptime, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(task.asset_id, task.connection_type, metrics.cpu, metrics.memoryUsage, metrics.memoryTotal, metrics.memoryUsed, JSON.stringify(metrics.disks || []), metrics.uptime || '', now());
    evaluateThresholds(task.asset_id, metrics);
  }
  outcome.healthStatus = assetHealthStatus(task.asset_id);
  return outcome;
}

function ping(target) {
  const args = process.platform === 'win32' ? ['-n', '1', '-w', '1500', target] : ['-c', '1', '-W', '2', target];
  return new Promise(resolve => execFile('ping', args, { timeout: 3000 }, error => resolve({ result: error ? '异常' : '成功', details: error ? '主机无响应或 Ping 被防火墙阻止' : '主机可达' })));
}

function tcp(target, port) {
  return new Promise(resolve => {
    const started = Date.now(); const socket = net.createConnection({ host: target, port });
    const done = (result, details) => { socket.destroy(); resolve({ result, details }); };
    socket.setTimeout(2500); socket.once('connect', () => done('成功', `TCP ${port} 可连接，耗时 ${Date.now() - started}ms`));
    socket.once('timeout', () => done('异常', `TCP ${port} 连接超时，可能被防火墙丢弃或主机不可达`));
    socket.once('error', error => error.code === 'ECONNREFUSED'
      ? done('无监听', `TCP ${port} 连接被目标主机拒绝：端口当前没有服务监听`)
      : done('异常', `TCP ${port} 不可用：${error.code || error.message}`));
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
  if (task.kind === 'http' || task.kind === 'https') {
    const port = task.port || (task.kind === 'http' ? 80 : 443);
    const outcome = await tcp(task.target, port);
    const protocol = task.kind.toUpperCase();
    const details = outcome.result === '成功'
      ? `${protocol} 端口 ${port} 可连接`
      : outcome.result === '无监听'
        ? `${protocol} 端口 ${port} 当前没有服务监听`
        : `${protocol} 端口 ${port} 无法连接`;
    return { ...outcome, details };
  }
  if (task.kind === 'tls') return certificate(task.target, task.port || 443);
  return executeHostCheck(task);
}

let scheduledRunsInProgress = false;
async function runDueScheduledTasks() {
  if (scheduledRunsInProgress) return;
  scheduledRunsInProgress = true;
  try {
    const timestamp = Date.now();
    const current = new Date();
    const dateKey = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
    const timeKey = `${String(current.getHours()).padStart(2, '0')}:${String(current.getMinutes()).padStart(2, '0')}`;
    const dueTasks = db.prepare('SELECT * FROM check_tasks WHERE schedule_enabled = 1').all().filter(task => {
      if (task.schedule_mode === 'daily') return task.schedule_time === timeKey && task.last_scheduled_date !== dateKey;
      return Number(task.schedule_interval_minutes) >= 5 && (!task.last_scheduled_at_ms || task.last_scheduled_at_ms + task.schedule_interval_minutes * 60000 <= timestamp);
    });
    for (const task of dueTasks) {
      // Mark before collecting so a long SSH probe cannot be started twice by the scheduler.
      db.prepare('UPDATE check_tasks SET last_scheduled_at_ms = ?, last_scheduled_date = ? WHERE id = ?').run(timestamp, dateKey, task.id);
      const outcome = await executeTask(task);
      const executionStatus = outcome.result === '异常' ? '失败' : '成功';
      const healthStatus = outcome.healthStatus || assetHealthStatus(task.asset_id);
      db.prepare('INSERT INTO check_runs (task_id, asset_id, task_name, scope, result, execution_status, health_status, executed_at, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(task.id, task.asset_id || null, task.name, `${task.target}${task.port ? `:${task.port}` : ''}`, outcome.result, executionStatus, healthStatus, now(), outcome.details);
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)')
        .run('系统定时任务', `定时执行了巡检任务 ${task.name}`, now());
    }
  } finally { scheduledRunsInProgress = false; }
}

function dashboard() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000;
  const assetSummary = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = '正常' THEN 1 ELSE 0 END) AS healthy FROM assets").get();
  const alertSummary = db.prepare("SELECT COUNT(*) AS total FROM alerts WHERE status = 'open'").get();
  const checkSummary = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN result = '成功' THEN 1 ELSE 0 END) AS successful FROM check_runs WHERE executed_at_ms >= ? AND executed_at_ms < ?").get(dayStart.getTime(), dayEnd);
  const assetTotal = assetSummary.total || 0;
  const healthyAssets = assetSummary.healthy || 0;
  const todayChecks = checkSummary.total || 0;
  const successfulChecks = checkSummary.successful || 0;
  return {
    summary: {
      assetTotal,
      healthyAssets,
      healthRate: assetTotal ? Number((healthyAssets / assetTotal * 100).toFixed(1)) : 0,
      openAlerts: alertSummary.total || 0,
      todayChecks,
      checkSuccessRate: todayChecks ? Number((successfulChecks / todayChecks * 100).toFixed(1)) : 0
    },
    assets: db.prepare('SELECT id, name, ip, environment AS env, type, owner, status, last_check AS "check", service, cpu_threshold AS cpuThreshold, memory_threshold AS memoryThreshold, disk_threshold AS diskThreshold FROM assets ORDER BY id').all(),
    alerts: db.prepare("SELECT id, level, title, detail, asset, acknowledged, created_at AS time FROM alerts WHERE status = 'open' ORDER BY id").all(),
    records: db.prepare(`SELECT cr.id, cr.task_id AS taskId, cr.task_name AS name, cr.scope, cr.result,
      cr.execution_status AS executionStatus,
      CASE WHEN cr.asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM alerts al WHERE al.asset = a.name AND al.status = 'open') THEN '异常' ELSE COALESCE(cr.health_status, '正常') END AS healthStatus,
      cr.details, cr.executed_at AS time
      FROM check_runs cr LEFT JOIN assets a ON a.id = cr.asset_id
      ORDER BY cr.id DESC LIMIT 20`).all(),
    audit: db.prepare('SELECT audit_logs.actor, audit_logs.action, audit_logs.created_at AS time, users.username AS actorUsername FROM audit_logs LEFT JOIN users ON users.display_name = audit_logs.actor ORDER BY audit_logs.id DESC LIMIT 10').all()
    , tasks: db.prepare("SELECT id, name, kind, target, port, request_path AS requestPath, asset_id AS assetId, connection_type AS connectionType, ssh_platform AS sshPlatform, schedule_enabled AS scheduleEnabled, schedule_interval_minutes AS scheduleIntervalMinutes, schedule_mode AS scheduleMode, schedule_time AS scheduleTime FROM check_tasks ORDER BY id DESC").all()
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      const user = sessionUser(req);
      return sendJson(res, 200, { setupRequired: userCount() === 0, user: publicUser(user), rememberSession: Boolean(user?.persistent) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
      if (userCount() > 0) return sendJson(res, 409, { error: '管理员账号已创建，请直接登录' });
      const { username, displayName, password } = await readBody(req);
      const errors = accountErrors({ username, displayName, password });
      if (Object.keys(errors).length) return sendJson(res, 422, { error: '请检查填写内容', errors });
      const salt = crypto.randomBytes(16).toString('hex');
      const result = db.prepare('INSERT INTO users (username, display_name, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(username.trim(), displayName.trim(), 'admin', salt, hashPassword(password, salt), now());
      setSession(res, result.lastInsertRowid, true);
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run(displayName.trim(), '创建了首个管理员账号', now());
      return sendJson(res, 201, { user: { id: result.lastInsertRowid, username: username.trim(), displayName: displayName.trim(), role: 'admin' } });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { username, password, remember } = await readBody(req);
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
      if (!user || !password || !crypto.timingSafeEqual(Buffer.from(user.password_hash, 'hex'), Buffer.from(hashPassword(password, user.password_salt), 'hex'))) return sendJson(res, 401, { error: '账号或密码错误' });
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
      setSession(res, user.id, Boolean(remember));
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run(user.display_name, '登录了运维检测台', now());
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const { keepRemembered } = await readBody(req);
      const user = sessionUser(req);
      if (keepRemembered && user?.persistent) return sendJson(res, 200, { ok: true, remembered: true });
      clearSession(req, res); return sendJson(res, 200, { ok: true });
    }

    const currentUser = sessionUser(req);
    if (url.pathname.startsWith('/api/') && !currentUser) return sendJson(res, 401, { error: '登录状态已失效，请重新登录' });
    if ((url.pathname === '/' || url.pathname === '/index.html') && !currentUser) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
    if (currentUser?.role === 'viewer' && req.method !== 'GET' && url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/profile') return sendJson(res, 403, { error: '当前账号为只读账号，不能修改平台数据' });

    if (url.pathname === '/api/auth/profile' && req.method === 'GET') return sendJson(res, 200, { user: publicUser(currentUser) });
    if (url.pathname === '/api/auth/profile' && req.method === 'PUT') {
      const { username, displayName } = await readBody(req);
      const errors = {};
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username || '')) errors.username = '用户名需为 3-32 位字母、数字或 . _ -';
      if (!String(displayName || '').trim() || String(displayName).trim().length > 32) errors.displayName = '请输入 1-32 位姓名';
      if (Object.keys(errors).length) return sendJson(res, 422, { error: '请检查填写内容', errors });
      try {
        db.prepare('UPDATE users SET username = ?, display_name = ? WHERE id = ?').run(username.trim(), displayName.trim(), currentUser.id);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) return sendJson(res, 422, { error: '请检查填写内容', errors: { username: '该用户名已被使用' } });
        throw error;
      }
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run(displayName.trim(), '更新了个人资料', now());
      return sendJson(res, 200, { user: { id: currentUser.id, username: username.trim(), displayName: displayName.trim(), role: currentUser.role } });
    }

    if (url.pathname === '/api/users' && req.method === 'GET') {
      if (currentUser.role !== 'admin') return sendJson(res, 403, { error: '只有管理员可以管理账号' });
      return sendJson(res, 200, { users: db.prepare('SELECT id, username, display_name AS displayName, role, created_at AS createdAt, last_login_at AS lastLoginAt FROM users ORDER BY id').all() });
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      if (currentUser.role !== 'admin') return sendJson(res, 403, { error: '只有管理员可以创建账号' });
      const { username, displayName, password, role } = await readBody(req);
      const errors = accountErrors({ username, displayName, password });
      if (!['admin', 'operator', 'viewer'].includes(role)) errors.role = '请选择有效权限';
      if (Object.keys(errors).length) return sendJson(res, 422, { error: '请检查填写内容', errors });
      const salt = crypto.randomBytes(16).toString('hex');
      const result = db.prepare('INSERT INTO users (username, display_name, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(username.trim(), displayName.trim(), role, salt, hashPassword(password, salt), now());
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run(currentUser.display_name, `创建了账号 ${username.trim()}`, now());
      return sendJson(res, 201, { id: result.lastInsertRowid });
    }
    if (url.pathname === '/api/audit' && req.method === 'GET') {
      const query = String(url.searchParams.get('query') || '').trim();
      const from = Date.parse(String(url.searchParams.get('from') || ''));
      const to = Date.parse(String(url.searchParams.get('to') || ''));
      const pageSize = 10;
      const requestedPage = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const filters = [query, `%${query}%`, `%${query}%`, `%${query}%`, Number.isFinite(from) ? from : null, Number.isFinite(to) ? to : null];
      const where = `(? = '' OR audit_logs.actor LIKE ? COLLATE NOCASE OR users.username LIKE ? COLLATE NOCASE OR audit_logs.action LIKE ? COLLATE NOCASE)
        AND (? IS NULL OR audit_logs.created_at_ms >= ?) AND (? IS NULL OR audit_logs.created_at_ms <= ?)`;
      const filterValues = [query, `%${query}%`, `%${query}%`, `%${query}%`, Number.isFinite(from) ? from : null, Number.isFinite(from) ? from : null, Number.isFinite(to) ? to : null, Number.isFinite(to) ? to : null];
      const total = db.prepare(`SELECT COUNT(*) AS total FROM audit_logs LEFT JOIN users ON users.display_name = audit_logs.actor WHERE ${where}`).get(...filterValues).total;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const like = `%${query}%`;
      const rows = db.prepare(`SELECT audit_logs.actor, audit_logs.action, audit_logs.created_at AS time, users.username AS actorUsername
        FROM audit_logs LEFT JOIN users ON users.display_name = audit_logs.actor
        WHERE ${where} ORDER BY audit_logs.id DESC LIMIT ? OFFSET ?`).all(...filterValues, pageSize, (page - 1) * pageSize);
      return sendJson(res, 200, { audit: rows, page, pageSize, total, totalPages });
    }
    if (url.pathname === '/api/alerts/history' && req.method === 'GET') {
      const query = String(url.searchParams.get('query') || '').trim();
      const status = ['open', 'closed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '';
      const from = Date.parse(String(url.searchParams.get('from') || ''));
      const to = Date.parse(String(url.searchParams.get('to') || ''));
      const pageSize = 10;
      const requestedPage = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const where = `(? = '' OR alerts.title LIKE ? COLLATE NOCASE OR alerts.detail LIKE ? COLLATE NOCASE OR alerts.asset LIKE ? COLLATE NOCASE OR alerts.acknowledged_by LIKE ? COLLATE NOCASE OR alerts.closed_by LIKE ? COLLATE NOCASE)
        AND (? = '' OR alerts.status = ?) AND (? IS NULL OR alerts.created_at_ms >= ?) AND (? IS NULL OR alerts.created_at_ms <= ?)`;
      const filterValues = [query, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, status, status, Number.isFinite(from) ? from : null, Number.isFinite(from) ? from : null, Number.isFinite(to) ? to : null, Number.isFinite(to) ? to : null];
      const total = db.prepare(`SELECT COUNT(*) AS total FROM alerts WHERE ${where}`).get(...filterValues).total;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const alertsHistory = db.prepare(`SELECT id, level, title, detail, asset, status, acknowledged, acknowledged_by AS acknowledgedBy, acknowledged_at AS acknowledgedAt, closed_by AS closedBy, closed_at AS closedAt, created_at AS time
        FROM alerts WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...filterValues, pageSize, (page - 1) * pageSize);
      return sendJson(res, 200, { alerts: alertsHistory, page, pageSize, total, totalPages });
    }
    const userDeleteMatch = url.pathname.match(/^\/api\/users\/(\d+)$/);
    if (userDeleteMatch && req.method === 'DELETE') {
      if (currentUser.role !== 'admin') return sendJson(res, 403, { error: '只有管理员可以删除账号' });
      const id = Number(userDeleteMatch[1]);
      if (id === currentUser.id) return sendJson(res, 422, { error: '不能删除当前登录的账号' });
      const target = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
      if (!target) return sendJson(res, 404, { error: '未找到账号' });
      db.transaction(() => { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); db.prepare('DELETE FROM users WHERE id = ?').run(id); })();
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run(currentUser.display_name, `删除了账号 ${target.username}`, now());
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') return sendJson(res, 200, dashboard());
    if (req.method === 'GET' && url.pathname === '/api/check-runs') {
      const pageSize = 6;
      const total = db.prepare('SELECT COUNT(*) AS total FROM check_runs').get().total;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(Math.max(1, Number(url.searchParams.get('page')) || 1), totalPages);
      const runs = db.prepare(`SELECT cr.id, cr.task_id AS taskId, cr.task_name AS name, cr.scope, cr.result,
        cr.execution_status AS executionStatus,
        CASE WHEN cr.asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM alerts al WHERE al.asset = a.name AND al.status = 'open') THEN '异常' ELSE COALESCE(cr.health_status, '正常') END AS healthStatus,
        cr.details, cr.executed_at AS time
        FROM check_runs cr LEFT JOIN assets a ON a.id = cr.asset_id
        ORDER BY cr.id DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize);
      return sendJson(res, 200, { records: runs, page, pageSize, total, totalPages });
    }
    if (req.method === 'GET' && url.pathname === '/api/check-tasks') {
      const pageSize = 6;
      const total = db.prepare('SELECT COUNT(*) AS total FROM check_tasks').get().total;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(Math.max(1, Number(url.searchParams.get('page')) || 1), totalPages);
      const tasks = db.prepare("SELECT id, name, kind, target, port, request_path AS requestPath, asset_id AS assetId, connection_type AS connectionType, ssh_platform AS sshPlatform, schedule_enabled AS scheduleEnabled, schedule_interval_minutes AS scheduleIntervalMinutes, schedule_mode AS scheduleMode, schedule_time AS scheduleTime FROM check_tasks ORDER BY id DESC LIMIT ? OFFSET ?")
        .all(pageSize, (page - 1) * pageSize);
      return sendJson(res, 200, { tasks, page, pageSize, total, totalPages });
    }
    const metricsMatch = url.pathname.match(/^\/api\/assets\/(\d+)\/metrics$/);
    if (metricsMatch && req.method === 'GET') {
      const asset = db.prepare('SELECT id, name, ip, environment AS env, type, owner, status, last_check AS "check", service, cpu_threshold AS cpuThreshold, memory_threshold AS memoryThreshold, disk_threshold AS diskThreshold FROM assets WHERE id = ?').get(Number(metricsMatch[1]));
      if (!asset) return sendJson(res, 404, { error: '未找到资产' });
      const metrics = db.prepare('SELECT cpu_usage AS cpuUsage, memory_usage AS memoryUsage, memory_total AS memoryTotal, memory_used AS memoryUsed, disk_json AS diskJson, uptime, captured_at AS capturedAt, source FROM host_metrics WHERE asset_id = ? ORDER BY id DESC LIMIT 20').all(asset.id)
        .map(metric => ({ ...metric, disks: JSON.parse(metric.diskJson || '[]') }));
      return sendJson(res, 200, { asset, metrics });
    }
    const runMatch = url.pathname.match(/^\/api\/check-runs\/(\d+)$/);
    if (runMatch && req.method === 'GET') {
      const run = db.prepare(`SELECT cr.id, cr.task_id AS taskId, cr.task_name AS name, cr.scope, cr.result,
        cr.execution_status AS executionStatus,
        CASE WHEN cr.asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM alerts al WHERE al.asset = a.name AND al.status = 'open') THEN '异常' ELSE COALESCE(cr.health_status, '正常') END AS healthStatus,
        cr.details, cr.executed_at AS time
        FROM check_runs cr LEFT JOIN assets a ON a.id = cr.asset_id WHERE cr.id = ?`).get(Number(runMatch[1]));
      if (!run) return sendJson(res, 404, { error: '未找到执行记录' });
      const task = run.taskId ? db.prepare('SELECT kind, target, port, request_path AS requestPath, asset_id AS assetId, connection_type AS connectionType FROM check_tasks WHERE id = ?').get(run.taskId) : null;
      const metrics = task?.assetId ? db.prepare('SELECT cpu_usage AS cpuUsage, memory_usage AS memoryUsage, memory_total AS memoryTotal, memory_used AS memoryUsed, disk_json AS diskJson, uptime, captured_at AS capturedAt FROM host_metrics WHERE asset_id = ? ORDER BY id DESC LIMIT 1').get(task.assetId) : null;
      return sendJson(res, 200, { run, task, metrics: metrics ? { ...metrics, disks: JSON.parse(metrics.diskJson || '[]') } : null });
    }
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
    const thresholdMatch = url.pathname.match(/^\/api\/assets\/(\d+)\/thresholds$/);
    if (thresholdMatch && req.method === 'PUT') {
      const { cpuThreshold, memoryThreshold, diskThreshold } = await readBody(req);
      const values = [cpuThreshold, memoryThreshold, diskThreshold].map(Number);
      if (values.some(value => !Number.isFinite(value) || value < 1 || value > 99)) return sendJson(res, 422, { error: '阈值必须在 1 到 99 之间' });
      const updated = db.prepare('UPDATE assets SET cpu_threshold = ?, memory_threshold = ?, disk_threshold = ? WHERE id = ?').run(...values, Number(thresholdMatch[1]));
      if (!updated.changes) return sendJson(res, 404, { error: '未找到资产' });
      insertAudit(`更新了资产告警阈值：CPU ${values[0]}%，内存 ${values[1]}%，磁盘 ${values[2]}%`);
      return sendJson(res, 200, dashboard());
    }
    if (req.method === 'POST' && url.pathname === '/api/check-tasks') {
      const { name, kind, target, port, requestPath, assetId, connectionType, sshPort, sshUsername, sshKeyPath, sshPlatform, scheduleEnabled, scheduleIntervalMinutes, scheduleMode, scheduleTime } = await readBody(req);
      const allowed = ['ping', 'tcp', 'http', 'https', 'tls', 'host']; const validPort = Number(port || (kind === 'http' ? 80 : 443));
      const asset = assetId ? db.prepare('SELECT id, ip FROM assets WHERE id = ?').get(Number(assetId)) : null;
      if (!name?.trim() || !allowed.includes(kind) || !isIpv4(target) || (kind !== 'ping' && kind !== 'host' && (!Number.isInteger(validPort) || validPort < 1 || validPort > 65535))) return sendJson(res, 422, { error: '请填写有效的任务名称、目标 IPv4 地址和端口' });
      if (kind === 'host' && (!asset || asset.ip !== target || !['local', 'ssh'].includes(connectionType))) return sendJson(res, 422, { error: '主机健康巡检必须选择已登记资产，并使用其对应 IP 地址' });
      const platform = ['windows', 'macos', 'linux'].includes(sshPlatform) ? sshPlatform : 'linux';
      const interval = Number(scheduleIntervalMinutes);
      const scheduled = Boolean(scheduleEnabled);
      const mode = scheduleMode === 'daily' ? 'daily' : 'interval';
      const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(scheduleTime || '')) ? String(scheduleTime) : null;
      if (scheduled && mode === 'interval' && (!Number.isInteger(interval) || interval < 5 || interval > 1440)) return sendJson(res, 422, { error: '定时巡检间隔必须在 5 到 1440 分钟之间' });
      if (scheduled && mode === 'daily' && !time) return sendJson(res, 422, { error: '请设置每天执行的具体时间' });
      const result = db.prepare('INSERT INTO check_tasks (name, kind, target, port, request_path, created_at, asset_id, connection_type, ssh_port, ssh_username, ssh_key_path, ssh_platform, schedule_enabled, schedule_interval_minutes, schedule_mode, schedule_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name.trim(), kind, target, kind === 'ping' || kind === 'host' ? null : validPort, requestPath || '/', now(), asset?.id || null, connectionType || null, sshPort || null, sshUsername || null, sshKeyPath || null, platform, scheduled ? 1 : 0, scheduled && mode === 'interval' ? interval : null, mode, scheduled && mode === 'daily' ? time : null);
      if (scheduled && mode === 'interval') db.prepare('UPDATE check_tasks SET last_scheduled_at_ms = ? WHERE id = ?').run(Date.now(), result.lastInsertRowid);
      insertAudit(`创建了巡检任务 ${name.trim()}`); return sendJson(res, 201, { taskId: result.lastInsertRowid, ...dashboard() });
    }
    const taskRunMatch = url.pathname.match(/^\/api\/check-tasks\/(\d+)\/run$/);
    if (taskRunMatch && req.method === 'POST') {
      const task = db.prepare('SELECT * FROM check_tasks WHERE id = ?').get(Number(taskRunMatch[1])); if (!task) return sendJson(res, 404, { error: '未找到巡检任务' });
      const outcome = await executeTask(task);
      // A completed probe can still report a closed service port. That is a check finding,
      // not a failure of the inspection runner itself.
      const executionStatus = outcome.result === '异常' ? '失败' : '成功';
      const healthStatus = outcome.healthStatus || assetHealthStatus(task.asset_id);
      outcome.executionStatus = executionStatus; outcome.healthStatus = healthStatus;
      db.prepare('INSERT INTO check_runs (task_id, asset_id, task_name, scope, result, execution_status, health_status, executed_at, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(task.id, task.asset_id || null, task.name, `${task.target}${task.port ? `:${task.port}` : ''}`, outcome.result, executionStatus, healthStatus, now(), outcome.details);
      insertAudit(`执行了巡检任务 ${task.name}：${outcome.result}`); return sendJson(res, 200, { outcome, ...dashboard() });
    }
    const taskScheduleMatch = url.pathname.match(/^\/api\/check-tasks\/(\d+)\/schedule$/);
    if (taskScheduleMatch && req.method === 'PUT') {
      const { enabled, intervalMinutes, mode: requestedMode, time: requestedTime } = await readBody(req);
      const interval = Number(intervalMinutes);
      const mode = requestedMode === 'daily' ? 'daily' : 'interval';
      const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(requestedTime || '')) ? String(requestedTime) : null;
      if (enabled && mode === 'interval' && (!Number.isInteger(interval) || interval < 5 || interval > 1440)) return sendJson(res, 422, { error: '定时巡检间隔必须在 5 到 1440 分钟之间' });
      if (enabled && mode === 'daily' && !time) return sendJson(res, 422, { error: '请设置每天执行的具体时间' });
      const updated = db.prepare('UPDATE check_tasks SET schedule_enabled = ?, schedule_interval_minutes = ?, schedule_mode = ?, schedule_time = ?, last_scheduled_at_ms = ?, last_scheduled_date = NULL WHERE id = ?')
        .run(enabled ? 1 : 0, enabled && mode === 'interval' ? interval : null, mode, enabled && mode === 'daily' ? time : null, enabled && mode === 'interval' ? Date.now() : null, Number(taskScheduleMatch[1]));
      if (!updated.changes) return sendJson(res, 404, { error: '未找到巡检任务' });
      insertAudit(`更新了巡检任务定时设置`);
      return sendJson(res, 200, dashboard());
    }
    const taskDeleteMatch = url.pathname.match(/^\/api\/check-tasks\/(\d+)$/);
    if (taskDeleteMatch && req.method === 'DELETE') {
      const task = db.prepare('SELECT name FROM check_tasks WHERE id = ?').get(Number(taskDeleteMatch[1]));
      if (!task) return sendJson(res, 404, { error: '未找到巡检任务' });
      db.prepare('DELETE FROM check_tasks WHERE id = ?').run(Number(taskDeleteMatch[1]));
      insertAudit(`删除了巡检任务 ${task.name}`);
      return sendJson(res, 200, dashboard());
    }
    if (req.method === 'POST' && url.pathname === '/api/checks/run') {
      const { taskName = '全量巡检' } = await readBody(req);
      db.prepare('INSERT INTO check_runs (task_name, scope, result, execution_status, health_status, executed_at) VALUES (?, ?, ?, ?, ?, ?)').run(taskName, '生产环境 · 自动检测', '成功', '成功', '正常', now());
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run('陈宇', `执行了「${taskName}」`, now());
      return sendJson(res, 201, dashboard());
    }
    const closeMatch = url.pathname.match(/^\/api\/alerts\/(\d+)\/close$/);
    if (req.method === 'POST' && closeMatch) {
      const id = Number(closeMatch[1]);
      const updated = db.prepare("UPDATE alerts SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(currentUser.display_name, now(), id);
      if (!updated.changes) return sendJson(res, 404, { error: '未找到待处理告警' });
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run(currentUser.display_name, `关闭了告警 #AL-${2900 + id}`, now());
      return sendJson(res, 200, dashboard());
    }
    const acknowledgeMatch = url.pathname.match(/^\/api\/alerts\/(\d+)\/acknowledge$/);
    if (req.method === 'POST' && acknowledgeMatch) {
      const id = Number(acknowledgeMatch[1]);
      const updated = db.prepare("UPDATE alerts SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = ? WHERE id = ? AND status = 'open'").run(currentUser.display_name, now(), id);
      if (!updated.changes) return sendJson(res, 404, { error: '未找到待处理告警' });
      db.prepare('INSERT INTO audit_logs (actor, action, created_at) VALUES (?, ?, ?)').run(currentUser.display_name, `确认了告警 #AL-${2900 + id}`, now());
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

server.listen(port, () => {
  console.log(`运维检测台运行在 http://localhost:${port}`);
  runDueScheduledTasks().catch(error => console.error('Scheduled inspection failed:', error.message));
  setInterval(() => runDueScheduledTasks().catch(error => console.error('Scheduled inspection failed:', error.message)), 30 * 1000);
});
