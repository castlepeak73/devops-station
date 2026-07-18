const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const sendJson = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const readBody = req => new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } }); });

function dashboard() {
  return {
    assets: db.prepare('SELECT id, name, ip, environment AS env, type, owner, status, last_check AS "check", service FROM assets ORDER BY id').all(),
    alerts: db.prepare("SELECT id, level, title, detail, asset, created_at AS time FROM alerts WHERE status = 'open' ORDER BY id").all(),
    records: db.prepare('SELECT task_name AS name, scope, result, executed_at AS time FROM check_runs ORDER BY id DESC LIMIT 10').all(),
    audit: db.prepare('SELECT actor, action, created_at AS time FROM audit_logs ORDER BY id DESC LIMIT 10').all()
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/dashboard') return sendJson(res, 200, dashboard());
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
    const assetPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(__dirname, assetPath);
    if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendJson(res, 404, { error: '未找到资源' });
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (error) { sendJson(res, 400, { error: error.message }); }
});

server.listen(port, () => console.log(`运维检测台运行在 http://localhost:${port}`));
