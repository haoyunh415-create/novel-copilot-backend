# 鉴来助手 —— 追更不迷路的 AI 阅读助手

浏览器插件，AI 自动追踪小说伏笔、生成人物关系图、无剧透前情提要。长篇追更党必备。

[![Landing Page](https://img.shields.io/badge/🌐-Landing_Page-5D4037)](https://haoyunh415-create.github.io/novel-copilot-backend/)

---

## ✨ 功能

| 功能 | 说明 |
|------|------|
| 📝 **智能章节摘要** | 每章自动提炼前情提要，支持简洁/标准/详细三种粒度 |
| 🕵️ **伏笔雷达** | AI 自动标记疑似伏笔，标注可信度，跨章追踪回收状态 |
| 👥 **人物关系图谱** | 自动生成人物关系网，核心角色高亮 |
| 💬 **无剧透问答** | 基于已读记忆回答，绝不剧透后文 |
| 🔒 **隐私保护** | 不保存小说原文，分析缓存基于文本哈希 |

## 📦 项目结构

```
novel-copilot-backend/
├── main.py                # FastAPI 后端入口
├── services/              # AI 分析、认证、额度管理
├── JianLai_Helper/        # Chrome 浏览器插件
├── requirements.txt       # Python 依赖
├── .env.example           # 配置文件模板
├── start_server.bat       # Windows 启动脚本
├── index.html             # Landing Page
└── README.md
```

## 🚀 快速开始

### 1. 环境要求

- Python 3.10+
- Chrome 浏览器

### 2. 安装依赖

```bash
# 克隆项目
git clone https://github.com/haoyunh415-create/novel-copilot-backend.git
cd novel-copilot-backend

# 创建虚拟环境（推荐）
python -m venv venv

# 激活虚拟环境
# Windows:
venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

### 3. 配置 API Key

```bash
# 复制配置模板
cp .env.example .env

# 编辑 .env，填入你的 DeepSeek API Key
# DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
```

> 去 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 免费注册获取 API Key。

### 4. 启动后端

```bash
# Windows 用户：双击 start_server.bat 即可
# 或手动启动：
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

看到 `Uvicorn running on http://127.0.0.1:8000` 就成功了。

### 5. 安装 Chrome 插件

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 打开右上角「**开发者模式**」
3. 点击「**加载已解压的扩展程序**」
4. 选择项目中的 `JianLai_Helper` 文件夹
5. 插件出现在工具栏，点击使用！

### 6. 开始使用

1. 打开任意小说章节页面
2. 点击浏览器工具栏的「鉴来助手」图标
3. 注册/登录（本地账号，数据不上传）
4. 点击「分析当前章节」，等待 AI 分析完成
5. 切换到「问答」面板，开始提问！

## 🔧 可选配置

`.env` 文件中的全部配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填） | - |
| `DEEPSEEK_API_URL` | API 地址 | `https://api.deepseek.com/v1/chat/completions` |
| `DEEPSEEK_MODEL` | 模型名称 | `deepseek-chat` |
| `SECRET_KEY` | JWT 签名密钥 | `dev_only_change_me`（建议改成随机字符串） |
| `ACCESS_TOKEN_TTL_SECONDS` | 登录有效期（秒） | `86400` |
| `MOCK_PAYMENTS_ENABLED` | 开发模式自动发放额度 | `false` |

## 🖥️ 开机自启动（Windows）

项目内置了 Windows 开机自启功能：

```
start_server.bat  → 开机启动用这个
start_server.vbs  → 静默启动（不显示命令行窗口）
start_server.ps1  → PowerShell 版本
```

> 首次启动：将 `start_server.vbs` 的快捷方式放入 Windows 启动文件夹即可（`Win+R` → `shell:startup`）

## 💰 定价

插件内置了额度系统，可自行配置支付（微信/支付宝）。默认开发模式下 `MOCK_PAYMENTS_ENABLED=true` 自动发放额度。

| 套餐 | 价格 | 说明 |
|------|------|------|
| 免费体验 | ¥0 | 注册即送 3 次额度 |
| 100 次包 | ¥9.9 | 约 0.1 元/次 |
| 月卡 | ¥19.9 | 30 天无限分析 |
| 永久版 | ¥99 | 终身使用 |

> 所有分析基于 DeepSeek API，成本极低（约 ¥0.001/次），可自建。

## 📄 许可证

MIT License

---

**Made with ❤️ for 追更党**
