# 鉴来助手 · 追更不迷路的 AI 阅读助手

[![Chrome Web Store](https://img.shields.io/badge/Chrome-已上线-4285F4?logo=googlechrome)](https://chromewebstore.google.com/detail/鉴来助手-小说-ai-伏笔雷达/ahahdepghanijblcddabfpeipbclobil)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装-success?logo=greasyfork)](https://greasyfork.org/zh-CN/scripts/587834)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/平台-25%2B-orange)](https://jianla.xyz)

打开小说页面，AI 自动追踪伏笔、生成人物关系图、无剧透前情提要。25+ 平台通用，免登录试用。

**官网：[jianla.xyz](https://jianla.xyz)**

---

## ✨ 简介

鉴来助手是一款面向中文网文读者的 AI 阅读助手，后端基于 **FastAPI + DeepSeek AI + SQLite**，前端为 **Chrome 扩展（Manifest V3）** 与油猴脚本。它对每一章做**无剧透**分析，帮助追更读者快速接上剧情、记住伏笔与人物关系。

除了个人阅读辅助，项目还内置了面向创作者 / 推广者的**引流素材生成**能力：一键把已分析的章节记忆，生成可发布的抖音 / B 站口播脚本、章节速览 / 书评，并自动提取正文金句作为钩子。

---

## 快速安装

| 方式 | 适合 | 链接 |
|------|------|------|
| 🌐 Chrome 商店 | Chrome/Edge 用户 | [安装](https://chromewebstore.google.com/detail/鉴来助手-小说-ai-伏笔雷达/ahahdepghanijblcddabfpeipbclobil) |
| 📦 直接下载 | 国内用户免梯子 | [官网下载](https://jianla.xyz) |
| 📜 油猴脚本 | 手机/桌面通用 | [标准版](https://jianla.xyz/static/jianlai-helper.user.js) · [Greasy Fork](https://greasyfork.org/zh-CN/scripts/587834) · [手机版](https://jianla.xyz/static/jianlai-helper-alook.user.js) |

安装后打开任意小说章节 → 点右下角按钮 → AI 自动分析。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| 📝 智能摘要 | 每章提炼前情提要，简洁/标准/详细三种粒度，摘要秒出 |
| 🕵️ 伏笔雷达 | AI 标记线索+可信度评分，跨章追踪（开放中/推进中/已回收） |
| 👥 人物关系图 | 自动生成关系网络，核心角色高亮，几百章也不脸盲 |
| 💬 无剧透问答 | 基于已读记忆回答，绝不偷看后面章节 |
| 🔥 引流素材 | 一键生成口播脚本 / 书评速览 + 正文金句，推广发布直接可用 |
| 🆓 免登录试用 | 不注册也能用 3 次，注册送 10 次 · 每日签到 +8 次 |
| ⚡ 渐进式分析 | 摘要先出（约 5 秒），人物和伏笔随后加载 |

支持平台：起点 · 纵横 · 番茄 · 17K · 晋江 · 七猫 · 69书吧 · 笔趣阁等 **25+ 小说网站**。

---

## 技术栈

**后端：** Python · FastAPI · DeepSeek API · SQLite · Nginx

**前端：** Vanilla JS (Chrome Extension MV3) · vis-network · 油猴脚本三版本

**部署：** 阿里云 · Ubuntu 22.04 · Let's Encrypt SSL

---

## 目录结构

```
novel-copilot-backend/
├── main.py              # FastAPI 后端入口（路由 + SQLite 建表 + 额度/邮件/管理）
├── services/            # AI 分析、引流生成、支付、邮件等业务逻辑
├── models/              # Pydantic 数据模型
├── JianLai_Helper/      # Chrome 扩展（Manifest V3）
├── userscript/          # 油猴脚本（标准版 / 手机版 / Greasy Fork 版）
├── tests/               # 测试
├── scripts/             # 部署脚本
├── static/              # 官网静态资源
├── index.html           # 官网首页
├── privacy.html         # 隐私政策
├── support.html         # 支持 / 常见问题
├── requirements.txt     # 后端依赖
└── .env.example         # 环境变量模板
```

---

## 自行部署

### 1. 后端（FastAPI）

```bash
git clone https://github.com/haoyunh415-create/novel-copilot-backend.git
cd novel-copilot-backend

# 建议使用虚拟环境
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

pip install -r requirements.txt
cp .env.example .env            # 复制环境变量模板
# 编辑 .env，至少填入 DEEPSEEK_API_KEY、SECRET_KEY、ADMIN_KEY

python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

首次启动会自动创建 `users.db`（SQLite）及所有数据表。

### 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek 开放平台 API Key |
| `DEEPSEEK_API_URL` / `DEEPSEEK_MODEL` | — | 接口地址与模型，默认已填好 |
| `SECRET_KEY` | ✅ | JWT 密钥，用 `python -c "import secrets; print(secrets.token_hex(32))"` 生成 |
| `ADMIN_KEY` | ✅ | 访问 `/admin` 后台与 `/api/admin/*` 的管理密钥 |
| `SMTP_HOST/PORT/USER/PASS` | — | QQ 邮箱 SMTP，用于发送验证码（可选） |
| `MOCK_PAYMENTS_ENABLED` | — | 开发模式：`true` = 购买直接到账 + 验证码打印到控制台 |

### 2. 前端（Chrome 扩展）

1. Chrome 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」→ 选择 `JianLai_Helper/` 目录
4. 点击扩展图标 → 设置里把后端地址改成你的部署地址（默认 `https://jianla.xyz:8000`）

### 3. 油猴脚本

`userscript/` 目录内含多个版本（标准版 / 手机版 / Greasy Fork 版），用 Tampermonkey 等脚本管理器安装对应 `.user.js`，并在脚本内把后端地址指向你自己的服务。

---

## 常见问题

**Q：DeepSeek API Key 在哪申请？**
在 [platform.deepseek.com](https://platform.deepseek.com) 注册后创建 API Key，填入 `.env` 的 `DEEPSEEK_API_KEY`。

**Q：注册 / 验证码邮件收不到？**
QQ 邮箱需开启 SMTP 并获取「授权码」填入 `SMTP_PASS`（不是登录密码）。本地开发可设 `MOCK_PAYMENTS_ENABLED=true`，验证码会直接打印到控制台。

**Q：前端怎么指向我自己的后端？**
扩展设置页有「后端地址」输入框（默认 `https://jianla.xyz:8000`），改成你的域名即可；也可直接改 `popup.js` / `content.js` 里 `getAPI()` 的默认值。

**Q：额度 / 积分怎么算？**
免登录可试用 3 次，注册送 10 次，每日签到 +8 次。单章分析、批量分析、全书复盘（20 积分）、引流素材（10 积分）消耗各不相同。

**Q：数据库文件在哪？**
`users.db`（SQLite）在项目根目录，首次启动自动创建；`*.db` 已加入 `.gitignore`，不会被提交。

**Q：为什么 `.env` 不提交到仓库？**
`.env` 包含 API Key 等敏感信息，已用 `.env*` 忽略。请基于 `.env.example` 自行生成。

---

## License

[Apache License 2.0](LICENSE) · Copyright 2026 鉴来助手 Authors

代码开源，欢迎 Star、Fork 与 PR ⭐
