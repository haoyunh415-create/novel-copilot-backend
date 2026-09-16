# CLAUDE.md

本文件为 Claude Code 在此仓库工作时提供项目指引。

## 项目简介

「鉴来助手」是一款面向中文网文读者的 AI 阅读助手：Chrome 扩展（Manifest V3）+ 油猴脚本，配合 FastAPI + SQLite 后端，调用 DeepSeek AI 做无剧透摘要、伏笔追踪、人物关系图、以及引流文案生成。

## 架构

- `main.py` — FastAPI 入口：路由、SQLite 建表、额度/邮件/管理后台
- `services/ai_service.py` — DeepSeek 调用：单章/批量分析、引流生成、金句提取
- `models/` — Pydantic 数据模型
- `JianLai_Helper/` — Chrome 扩展（`content.js` 为核心逻辑）
- `userscript/` — 油猴脚本（多版本，与 content.js 同源逻辑）
- `tests/` — pytest 测试

## 常用命令

```bash
# 后端开发服务器
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000

# 测试
pytest

# 生产部署（服务器）
systemctl restart novel-copilot
```

## 约定

- 环境变量基于 `.env.example`；不要提交 `.env*`、`*.db`
- API 响应统一 `{ success, data, error }` 信封
- 前端 `content.js` 与 `userscript/` 需同步改动
- 面向用户的错误信息用中文
- 数据库表在 `main.py` 的 `init_db()` 中定义，首次启动自动建表
