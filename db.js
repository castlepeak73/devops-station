const Database = require('better-sqlite3');

const db = new Database('devops-station.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    ip TEXT NOT NULL,
    environment TEXT NOT NULL,
    type TEXT NOT NULL,
    owner TEXT NOT NULL,
    status TEXT NOT NULL,
    last_check TEXT NOT NULL,
    service TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY,
    level TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    asset TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS check_runs (
    id INTEGER PRIMARY KEY,
    task_name TEXT NOT NULL,
    scope TEXT NOT NULL,
    result TEXT NOT NULL,
    executed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS check_tasks (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    port INTEGER,
    request_path TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS host_metrics (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    cpu_usage REAL,
    memory_usage REAL,
    memory_total REAL,
    memory_used REAL,
    disk_json TEXT,
    uptime TEXT,
    captured_at TEXT NOT NULL,
    FOREIGN KEY(asset_id) REFERENCES assets(id)
  );
`);

// Keep existing local databases compatible when new features are added.
try { db.exec('ALTER TABLE alerts ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE check_runs ADD COLUMN details TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE check_runs ADD COLUMN asset_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE check_runs ADD COLUMN task_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE check_tasks ADD COLUMN asset_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE check_tasks ADD COLUMN connection_type TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE check_tasks ADD COLUMN ssh_port INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE check_tasks ADD COLUMN ssh_username TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE check_tasks ADD COLUMN ssh_key_path TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE check_tasks ADD COLUMN ssh_platform TEXT NOT NULL DEFAULT 'linux'"); } catch (_) {}
try { db.exec('ALTER TABLE assets ADD COLUMN cpu_threshold REAL NOT NULL DEFAULT 80'); } catch (_) {}
try { db.exec('ALTER TABLE assets ADD COLUMN memory_threshold REAL NOT NULL DEFAULT 80'); } catch (_) {}
try { db.exec('ALTER TABLE assets ADD COLUMN disk_threshold REAL NOT NULL DEFAULT 80'); } catch (_) {}

const count = db.prepare('SELECT COUNT(*) AS total FROM assets').get().total;
if (count === 0) {
  const insertAsset = db.prepare(`INSERT INTO assets (name, ip, environment, type, owner, status, last_check, service)
    VALUES (@name, @ip, @environment, @type, @owner, @status, @last_check, @service)`);
  const insertAlert = db.prepare(`INSERT INTO alerts (level, title, detail, asset, created_at)
    VALUES (@level, @title, @detail, @asset, @created_at)`);
  const insertRun = db.prepare(`INSERT INTO check_runs (task_name, scope, result, executed_at)
    VALUES (@task_name, @scope, @result, @executed_at)`);
  const insertAudit = db.prepare(`INSERT INTO audit_logs (actor, action, created_at)
    VALUES (@actor, @action, @created_at)`);

  db.transaction(() => {
    [
      ['api-gateway-01', '10.20.1.11', '生产', '容器节点', '陈宇', '正常', '2 分钟前', 'API Gateway'],
      ['order-service-02', '10.20.1.24', '生产', '应用服务', '林睿', '告警', '5 分钟前', 'Order Service'],
      ['mysql-primary-01', '10.20.2.10', '生产', '数据库', '周明', '正常', '刚刚', 'MySQL Primary'],
      ['redis-cache-01', '10.20.2.31', '生产', '缓存服务', '陈宇', '正常', '1 分钟前', 'Redis Cache'],
      ['web-portal-staging', '10.30.1.18', '测试', 'Web 服务', '孙宁', '注意', '8 分钟前', 'Web Portal'],
      ['monitor-agent-01', '10.20.3.8', '生产', '监控节点', '陈宇', '正常', '刚刚', 'Monitor Agent']
    ].forEach(([name, ip, environment, type, owner, status, last_check, service]) => insertAsset.run({ name, ip, environment, type, owner, status, last_check, service }));

    [
      ['critical', 'order-service-02 CPU 使用率持续过高', '当前使用率 92%，已超过 85% 阈值并持续 15 分钟。', 'order-service-02', '12 分钟前'],
      ['warning', 'web-portal-staging SSL 证书即将过期', '证书将在 7 天后失效，请安排续期。', 'web-portal-staging', '38 分钟前'],
      ['info', 'api-gateway-01 检测到配置变更', '负载均衡路由规则已被更新。', 'api-gateway-01', '1 小时前']
    ].forEach(([level, title, detail, asset, created_at]) => insertAlert.run({ level, title, detail, asset, created_at }));

    [
      ['主机连通性检测', '生产环境 · 24 个目标', '成功', '10:24:18'],
      ['磁盘空间巡检', '生产环境 · 24 个目标', '成功', '10:00:03'],
      ['HTTP 健康检查', '生产环境 · 12 个端点', '异常', '09:35:42'],
      ['SSL 证书检测', '生产环境 · 8 个域名', '成功', '09:00:08']
    ].forEach(([task_name, scope, result, executed_at]) => insertRun.run({ task_name, scope, result, executed_at }));

    [['陈宇', '执行了全量主机连通性检测', '10:24:18'], ['系统', '自动关闭了 api-gateway-02 的高延迟告警', '10:18:02'], ['林睿', '将告警 #AL-2901 指派给 陈宇', '09:58:41']]
      .forEach(([actor, action, created_at]) => insertAudit.run({ actor, action, created_at }));
  })();
}

module.exports = db;
