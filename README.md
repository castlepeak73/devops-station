# 运维检测台

一个纯前端的内部运维检测工作台演示应用，包含资产管理、巡检、告警和审计日志。

现在已包含本机 API 与 SQLite 数据库。浏览器中的巡检和关闭告警操作会写入数据库，刷新页面后仍会保留。

## 使用

安装 Node.js 20 LTS 后，在项目目录执行：

```powershell
npm install
npm start
```

随后访问 `http://localhost:3000`。首次启动会在项目目录创建 `devops-station.db`，其中保存资产、告警、巡检和审计数据。

## 功能

- 生产环境运行总览与健康趋势
- 资产搜索与状态跟踪
- 一键执行模拟巡检任务
- 告警确认与关闭
- 操作审计记录

## 接口

- `GET /api/dashboard`：读取资产、待处理告警、巡检记录和审计日志
- `POST /api/checks/run`：创建一次巡检记录
- `POST /api/alerts/:id/close`：关闭指定告警并写入审计日志
