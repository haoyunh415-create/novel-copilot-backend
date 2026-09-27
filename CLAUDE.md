# CLAUDE.md

本文件为 Claude Code 在此仓库工作时提供项目指引。

## 项目简介

「鉴来助手」是一款面向中文网文读者的 AI 阅读助手：Chrome 扩展（Manifest V3）+ 油猴脚本，配合 FastAPI + SQLite 后端，调用 DeepSeek AI 做无剧透摘要、伏笔追踪、人物关系图，以及批量分析、全书复盘/周报；并针对起点/番茄的反爬字体做了自动解密。

## 架构

- `main.py` — FastAPI 入口：路由、SQLite 建表、额度/邮件/管理后台/激活码
- `services/ai_service.py` — DeepSeek 调用：单章/批量分析、问答、复盘、全书报告、伏笔回收
- `services/auth_service.py` — 密码哈希（bcrypt）
- `services/qidian_decrypt.py` — 起点「错位字体」反爬解密（字形匹配还原）
- `JianLai_Helper/` — Chrome 扩展（`content.js` 核心逻辑 + `batch_parser.js` 批量解析）
- `userscript/` — 油猴脚本（标准版 / Greasy Fork 版 / 手机版，与 content.js 同源逻辑）
- `tests/` — pytest（后端）+ vitest（前端 batch_parser）

## 常用命令

```bash
# 后端开发服务器
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000

# 后端测试
pytest

# 前端 batch_parser 测试
npx vitest run

# 生产部署（服务器）
systemctl restart novel-copilot
```

## 约定

- 环境变量基于 `.env.example`；不要提交 `.env*`、`*.db`
- API 响应统一 `{ success, data, error }` 信封
- 前端 `content.js` 与 `userscript/` 需同步改动（同源不同写法：扩展用现代语法，油猴用 ES5 兼容写法）
- 版本线独立：`manifest.json` 版本 ≠ 油猴 `@version`；改 `content.js` 才 bump manifest，改 userscript 只 bump `@version`
- 面向用户的错误信息用中文
- 数据库表在 `main.py` 的 `init_db()` 中定义，首次启动自动建表
