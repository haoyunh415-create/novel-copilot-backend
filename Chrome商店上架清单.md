# 🔗 Chrome Web Store 上架清单

> 打开 [Chrome Web Store 开发者后台](https://chrome.google.com/webstore/devconsole) → 新建商品 → 按以下内容填写

---

## 📦 上传文件

**插件 ZIP 包：** `jianlai-helper-v2.1.0.zip`（已生成，167KB）

---

## 📝 商店详情

### 名称
```
鉴来助手 - 小说 AI 伏笔雷达
```

### 简短说明（最多 132 字符）
```
AI 自动追踪小说伏笔、生成人物关系图、无剧透前情提要。长篇追更党必备浏览器插件。
```

### 详细说明
```html
<p>📖 <strong>鉴来助手</strong> 是一款专为长篇小说读者打造的 AI 阅读伴侣。支持起点、纵横、晋江、17K、番茄等 25+ 主流小说网站。</p>

<h3>✨ 核心功能</h3>
<ul>
<li>📝 <strong>智能章节摘要</strong> — 每章自动提炼前情提要，支持简洁/标准/详细三种粒度</li>
<li>🕵️ <strong>伏笔雷达</strong> — AI 自动标记疑似伏笔，标注可信度，跨章追踪回收状态</li>
<li>👥 <strong>人物关系图谱</strong> — 自动生成人物关系网，核心角色高亮，支持单章/全书两种视图</li>
<li>💬 <strong>无剧透问答</strong> — 基于已读记忆回答你的问题，绝不剧透后文</li>
<li>📊 <strong>全书复盘</strong> — 综合分析全部已读章节，梳理剧情脉络</li>
<li>🔒 <strong>隐私保护</strong> — 不保存小说原文，分析缓存基于文本哈希</li>
</ul>

<h3>💰 免费使用</h3>
<ul>
<li>注册即送 10 次免费额度</li>
<li>每日签到 +8 次</li>
<li>可购买更多额度（50次/¥4.9, 200次/¥12.9, 500次/¥24.9, 月卡无限/¥19.8）</li>
</ul>

<h3>🛠️ 使用方式</h3>
<ol>
<li>安装插件后，点击工具栏图标登录（邮箱验证码，无需密码）</li>
<li>打开任意支持的小说章节页面</li>
<li>点击"分析当前章节"即可开始</li>
</ol>
```

### 分类
```
生产力工具（Productivity）
```

### 语言
```
中文（简体）
```

---

## 🔗 链接

| 字段 | 值 |
|------|-----|
| **隐私政策 URL** | `https://jianla.xyz:8000/privacy` |
| **官方网站** | `https://jianla.xyz:8000` |
| **客服邮箱** | `2313370765@qq.com` |

---

## 🔐 权限说明理由

提交时 Chrome 会要求为以下权限提供**逐条书面理由**，审核人员会阅读：

| 权限 | 声明理由（英文，填在商店表单） |
|------|------------------------------|
| `storage` | To store user login token and preferences (API server URL) locally on the user's device. No data is transmitted without user action. |
| `activeTab` | To access the current page content only when the user clicks the extension icon to analyze a novel chapter. The extension does not read tabs in the background. |
| `scripting` | To inject the analysis panel (content script) into supported novel websites when the user initiates an analysis. This is required because some sites block content scripts from auto-loading. |
| `host_permissions` (小说网站) | The extension supports 25+ Chinese web novel platforms. Host permissions are needed to inject the reading assistant panel and extract chapter text from these specific sites only. |
| `host_permissions` (jianla.xyz) | To communicate with the extension's backend server for AI analysis, user authentication, and credit management. This is the extension's own API server. |

---

## 🖼️ 截图

已调整为 1280×800 像素，位于 `JianLai_Helper/screenshots/` 目录：

| 文件 | 建议说明 |
|------|----------|
| `1.png` | AI 章节分析结果展示（摘要 + 伏笔提示） |
| `2.png` | 人物关系图谱可视化 |
| `3.png` | 无剧透问答功能 |
| `4.png` | 插件弹出窗口与额度管理 |

---

## ⚠️ 提交前最后检查

- [ ] 服务器 `https://jianla.xyz:8000` 正常运行，审核人员会测试
- [ ] `https://jianla.xyz:8000/privacy` 可访问
- [ ] `https://jianla.xyz:8000/api/health` 返回正常
- [ ] 生产环境 `.env` 中 `SECRET_KEY` 不是 `dev_only_change_me`
- [ ] 生产环境 `SMTP_USER` / `SMTP_PASS` 已配置（验证码邮件能正常发送）
- [ ] 生产环境 `DEEPSEEK_API_KEY` 已配置且有余额
- [ ] 生产环境 `MOCK_PAYMENTS_ENABLED=false`（非开发模式）

---

## 📤 提交流程

1. 打开 https://chrome.google.com/webstore/devconsole
2. 点击 **"+ 新增商品"**
3. **上传 ZIP 包** → 选择 `jianlai-helper-v2.1.0.zip`
4. **填写商店详情** → 按本文档内容填写
5. **上传截图** → 4 张 1280×800 PNG
6. **填写权限理由** → 按本文档权限表格填写（需逐条填入英文表单）
7. **填写隐私政策 URL** → `https://jianla.xyz:8000/privacy`
8. **提交审核** → 通常 1-3 个工作日

审核通过后，插件会出现在 Chrome Web Store 中，搜索"鉴来助手"即可找到。
