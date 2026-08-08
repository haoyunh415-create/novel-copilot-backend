# 🔗 Chrome Web Store 上架清单 v2.3.0

> 打开 [Chrome Web Store 开发者后台](https://chrome.google.com/webstore/devconsole) → 找到「鉴来助手」→ 修改商品信息

---

## 📦 上传文件

**插件 ZIP 包：** `jianlai-helper-v2.3.0.zip`（已生成，2.7MB）

路径：`C:\Users\32639\novel-copilot-backend\jianlai-helper-v2.3.0.zip`

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
<p>📖 <strong>鉴来助手</strong> 是一款专为长篇小说读者打造的 AI 阅读伴侣，支持 25+ 主流小说阅读平台。无需离开阅读页面，点击按钮即可获得 AI 生成的章节分析。</p>

<h3>✨ 核心功能</h3>
<ul>
<li>📝 <strong>智能章节摘要</strong> — AI 自动提炼每章前情提要，支持简洁/标准/详细三种粒度，追更不迷路</li>
<li>🕵️ <strong>伏笔雷达</strong> — 自动识别文中疑似伏笔并标注可信度，跨章追踪伏笔的铺设与回收</li>
<li>👥 <strong>人物关系图谱</strong> — 自动生成可视化人物关系网络图，核心角色高亮，支持单章/全书两种视图</li>
<li>💬 <strong>无剧透问答</strong> — 基于已读内容回答你的疑问，绝不剧透后续章节</li>
<li>📊 <strong>全书复盘</strong> — 综合分析全部已读章节，一键梳理完整剧情脉络</li>
</ul>

<h3>🎁 免费使用</h3>
<ul>
<li>免登录即可体验 3 次完整分析，满意再注册</li>
<li>注册账号后获得更多免费额度</li>
<li>每日签到可领取额外免费额度</li>
</ul>

<h3>🛠️ 快速上手</h3>
<ol>
<li>安装插件后，点击浏览器工具栏的插件图标</li>
<li>打开任意支持的小说阅读网站章节页面</li>
<li>点击分析按钮，AI 将自动生成本章摘要和伏笔提示</li>
</ol>

<h3>🔒 隐私保护</h3>
<ul>
<li>不保存小说原文，仅存储 AI 分析结果</li>
<li>分析缓存基于文本内容哈希，确保隐私安全</li>
<li>最小权限原则，仅在用户主动点击时访问当前页面</li>
</ul>
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
| **官方网站** | `https://jianla.xyz` |
| **隐私政策 URL** | `https://novel-copilot-backend.pages.dev/privacy.html` |
| **客服邮箱** | `2313370765@qq.com` |

---

## 🔐 权限说明理由（英文）

| 权限 | 理由 |
|------|------|
| `storage` | To store user login token and preferences (API server URL, sort mode) locally on the user's device. No data is transmitted without user action. |
| `activeTab` | To access the current page content only when the user clicks the extension icon to analyze a novel chapter. The extension does not read tabs in the background. |
| `scripting` | To inject the analysis panel (content script) into supported novel websites when the user initiates an analysis. Required because some sites block auto-loading content scripts. |
| `host_permissions`（小说网站） | The extension supports 25+ Chinese web novel platforms. Host permissions are needed to inject the reading assistant panel and extract chapter text from these specific sites only when the user initiates an action. |
| `host_permissions`（jianla.xyz） | To communicate with the extension's backend server for AI analysis, user authentication, and credit management. This is the extension's own API server. |

---

## 🖼️ 截图

位于 `JianLai_Helper/screenshots/` 目录，1280×800：

| 文件 | 建议说明 |
|------|----------|
| `1.png` | AI 章节分析结果展示（摘要 + 伏笔提示） |
| `2.png` | 人物关系图谱可视化 |
| `3.png` | 无剧透问答功能 |
| `4.png` | 插件弹出窗口与额度管理 |

---

## ⚠️ 提交前最后检查

- [ ] 服务器 `https://jianla.xyz` 正常运行
- [ ] `https://jianla.xyz/api/health` 返回正常
- [ ] `https://novel-copilot-backend.pages.dev/privacy.html` 可访问
- [ ] `DEEPSEEK_API_KEY` 有余额
- [ ] SMTP 邮件正常（验证码能发送）
- [ ] 联系人邮箱 `2313370765@qq.com` 可收件
- [ ] **确认支付功能已关闭** — 说明中未列出任何价格

---

## 🚫 v2.3.0 被拒原因分析 & 本次修改

| 问题 | 旧版 | 新版 |
|------|------|------|
| 列出价格但支付未上线 | 50次/¥4.9, 200次/¥12.9 等 | **全部删除**，仅保留「免登录试用 3 次」「每日签到」 |
| 额度描述与实际不符 | "注册即送 10 次" | "注册后获得更多免费额度"（不写具体数字） |
| 隐私/官网 URL 用非标准端口 | `jianla.xyz:8000` | 改为 `jianla.xyz` 和 `pages.dev/privacy.html` |
| 预览图可能过时 | 旧版截图 | 如 UI 有变化需重新截图 |

---

## 📤 提交流程

1. 打开 https://chrome.google.com/webstore/devconsole
2. 找到「鉴来助手 - 小说 AI 伏笔雷达」
3. **Package** → Upload new package → 选择 `jianlai-helper-v2.3.0.zip`
4. **Store listing** → 按本文档更新名称/说明/截图
5. **Privacy** → 确认隐私政策 URL 正确
6. **Submit for review** → 提交审核
