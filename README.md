# 鉴来助手 · 追更不迷路的 AI 阅读助手

[![Chrome Web Store](https://img.shields.io/badge/Chrome-已上线-4285F4?logo=googlechrome)](https://chromewebstore.google.com/detail/鉴来助手-小说-ai-伏笔雷达/ahahdepghanijblcddabfpeipbclobil)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装-success?logo=greasyfork)](https://greasyfork.org/zh-CN/scripts/587834)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/平台-25%2B-orange)](https://jianla.xyz)

打开小说页面，AI 自动追踪伏笔、生成人物关系图、无剧透前情提要。25+ 平台通用，免登录试用。

**官网：[jianla.xyz](https://jianla.xyz)**

---

## 快速安装

| 方式 | 适合 | 链接 |
|------|------|------|
| 🌐 Chrome 商店 | Chrome/Edge 用户 | [安装](https://chromewebstore.google.com/detail/鉴来助手-小说-ai-伏笔雷达/ahahdepghanijblcddabfpeipbclobil) |
| 📦 直接下载 | 国内用户免梯子 | [v2.2.2](https://jianla.xyz/static/jianlai-helper-v2.2.2.zip) |
| 📜 油猴脚本 | 手机/桌面通用 | [标准版](https://jianla.xyz/static/jianlai-helper.user.js) · [Greasy Fork](https://greasyfork.org/zh-CN/scripts/587834) · [手机版](https://jianla.xyz/static/jianlai-helper-alook.user.js) |

安装后打开任意小说章节 → 点右下角按钮 → AI 自动分析。

---

## 功能介绍

| 功能 | 说明 |
|------|------|
| 📝 智能摘要 | 每章提炼前情提要，简洁/标准/详细三种粒度，摘要秒出 |
| 🕵️ 伏笔雷达 | AI 标记线索+可信度评分，跨章追踪（开放中/推进中/已回收） |
| 👥 人物关系图 | 自动生成关系网络，核心角色高亮，几百章也不脸盲 |
| 💬 无剧透问答 | 基于已读记忆回答，绝不偷看后面章节 |
| 🆓 免登录试用 | 不注册也能用 3 次，注册送 10 次 · 每日签到 +8 次 |
| ⚡ 渐进式分析 | 摘要先出（约 5 秒），人物和伏笔随后加载 |

支持平台：起点 · 纵横 · 番茄 · 17K · 晋江 · 七猫 · 69书吧 · 笔趣阁等 **25+ 小说网站**。

---

## 技术栈

**后端：** Python · FastAPI · DeepSeek API · SQLite · Nginx

**前端：** Vanilla JS (Chrome Extension MV3) · vis-network · 油猴脚本三版本

**部署：** 阿里云 · Ubuntu 22.04 · Let's Encrypt SSL

---

## 自行开发

```bash
git clone https://github.com/haoyunh415-create/novel-copilot-backend.git
cd novel-copilot-backend
pip install -r requirements.txt
cp .env.example .env   # 填入 DeepSeek API Key
python -m uvicorn main:app --host 127.0.0.1 --port 8000
# Chrome → chrome://extensions → 开发者模式 → 加载 JianLai_Helper 文件夹
```

---

## License

MIT · 代码开源，欢迎 PR 和 Star ⭐
