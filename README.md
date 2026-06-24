# 鉴来助手 —— 追更不迷路的 AI 阅读助手

浏览器插件，AI 自动追踪小说伏笔、生成人物关系图、无剧透前情提要。长篇追更党必备。

[![国内](https://img.shields.io/badge/🌏-国内可访问-C75B39)](https://novel-copilot-backend.haoyunh415.workers.dev)
[![GitHub Pages](https://img.shields.io/badge/🌐-备用地址-5D4037)](https://haoyunh415-create.github.io/novel-copilot-backend/)

---

## ✨ 功能一览

| 功能 | 说明 |
|------|------|
| 📝 **智能章节摘要** | 每章自动提炼前情提要，支持简洁/标准/详细三种粒度 |
| 🕵️ **伏笔雷达** | AI 自动标记疑似伏笔，标注可信度，跨章追踪回收状态 |
| 👥 **人物关系图谱** | 自动生成人物关系网，核心角色高亮 |
| 💬 **无剧透问答** | 基于已读记忆回答，绝不剧透后文 |
| 🔒 **隐私保护** | 不保存小说原文，分析缓存基于文本哈希 |

---

## 🚀 托管版（即将推出）

> 目前正在收集用户反馈，如果需求量大，将推出**即开即用的托管版**：
> - 不需要自己搭服务器
> - 不需要申请 API Key
> - Chrome Web Store 一键安装
> - 注册即用，每天免费额度

**如果你想用托管版，请给这个仓库点个 ⭐ Star，人数够了我就开搞！**

---

## 🛠️ 自行部署（开发者）

等不及托管版？你可以用自己的 DeepSeek API Key 自建，成本极低（约 ¥0.001/次分析）。

### 环境要求

- Python 3.10+
- Chrome 浏览器
- [DeepSeek API Key](https://platform.deepseek.com/api_keys)（免费注册，新用户送额度）

### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/haoyunh415-create/novel-copilot-backend.git
cd novel-copilot-backend

# 2. 安装依赖
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # Mac/Linux
pip install -r requirements.txt

# 3. 配置 API Key
cp .env.example .env
# 编辑 .env，填入你的 DeepSeek API Key

# 4. 启动后端
python -m uvicorn main:app --host 127.0.0.1 --port 8000

# 5. 加载插件
# Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序
# 选择 JianLai_Helper 文件夹
```

### 开机自启（Windows）

双击 `start_server.bat` 即可。将 `start_server.vbs` 的快捷方式放入启动文件夹（`Win+R` → `shell:startup`），每次开机自动后台运行。

---

## 📄 许可证

MIT License

---

**⭐ 想要托管版？点个 Star 让我知道！**

