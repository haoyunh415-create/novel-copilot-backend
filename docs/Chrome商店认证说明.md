# 🔐 Chrome 商店认证说明（Certification Justification）

> 用途：Chrome Web Store **每次提审**时的「认证说明（少于 2,000 个字符）」字段。
> 直接复制下方英文全文粘贴即可。**每次提交都必须提供，即使之前提交过类似信息**；没有认证说明的提交可能被标记或失败。

## 适用版本与权限范围

- 当前 manifest 权限：`storage` / `activeTab` / `scripting` / `host_permissions`
- `host_permissions` = **28 个小说阅读域名** + `https://jianla.xyz:8000/*`（自有后端）
- 首次编写 v2.1.0，沿用至今（v2.3.29 权限结构未变，仅域名数量随平台扩充）

---

## 📜 认证说明全文（约 1400 字符，<2000 上限，直接复制）

```text
"鉴来助手" (Novel Copilot) is a reading assistant for Chinese web-novel readers. It produces spoiler-free chapter summaries, foreshadowing tracking, and character-relationship graphs via the user's own AI backend.

Permission justifications:

1. storage — Stores the login token and UI preferences (chapter sort order, server URL) locally. Accessed only on user action; no background reads or transmission.

2. activeTab — Reads the current tab only when the user clicks the extension icon. The extension does not monitor tabs in the background.

3. scripting — Injects the assistant panel on user action. Needed because several supported single-page-app sites block content scripts from auto-loading.

4. host_permissions https://jianla.xyz:8000/* — The extension's own backend API, used for AI analysis, email-code login, and credit management. This is our single self-hosted endpoint.

5. Content scripts on 28 novel-reading domains — These are the supported reading platforms (e.g., qidian.com, book.qq.com, fanqienovel.com). Access is limited to reading the currently-open chapter text and rendering the panel; no cross-site collection.

Remote code: None. All code is bundled in this package; the extension only calls our own backend and never loads or executes remote code.

Data use: Only the chapter text a user explicitly chooses to analyze is sent to our backend to generate summaries. Original text is not stored (results are cached by content hash), data is never sold or used for advertising, and email is used solely for verification-code login.
```

---

## 📋 逐条权限理由（若表单要求逐条填写，非单一「认证说明」字段）

| 权限 | 声明理由（英文） |
|------|------------------|
| `storage` | To store user login token and preferences (API server URL) locally on the user's device. No data is transmitted without user action. |
| `activeTab` | To access the current page content only when the user clicks the extension icon to analyze a novel chapter. The extension does not read tabs in the background. |
| `scripting` | To inject the analysis panel (content script) into supported novel websites when the user initiates an analysis. This is required because some sites block content scripts from auto-loading. |
| `host_permissions`（28 个小说网站） | The extension supports 28 Chinese web novel platforms. Host permissions are needed to inject the reading assistant panel and extract chapter text from these specific sites only. |
| `host_permissions`（jianla.xyz:8000） | To communicate with the extension's backend server for AI analysis, user authentication, and credit management. This is the extension's own API server. |

---

## ⚠️ 备注

- 字符数约 **1400**，远低于 2000 上限，无需删减。
- 「28 novel-reading domains」= `manifest.json` 中 `content_scripts.matches` 的域名数，**与当前 manifest 一致**（若日后新增/删减平台域名，需同步更新此数字）。
- 审核员重点看三点，全文已覆盖：
  1. 权限**只在用户主动操作时**使用（activeTab/scripting 均强调 user action）
  2. **不后台读取**标签页（no background reads/monitor）
  3. **数据最小化**：不存原文（按内容哈希缓存）、不追踪、不卖数据、邮箱仅用于验证码登录
