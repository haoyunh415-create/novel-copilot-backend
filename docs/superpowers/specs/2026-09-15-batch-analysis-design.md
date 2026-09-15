# 鉴来助手 — 追更批量分析功能设计文档

**日期**: 2026-09-15
**状态**: 待用户确认
**项目**: 鉴来助手（Novel Copilot），Chrome 扩展 + FastAPI 后端

---

## 背景与动机

当前逐章分析需要用户手动翻页 → 手动点分析，追更时"一口气补十几章"非常繁琐。用户提出需要一个"批量/自动分析"能力，能自动选中一批章节、自动抓取正文、自动调用 AI 分析。

**核心诉求**（已与用户逐条确认）：

| 维度 | 决策 |
|------|------|
| 核心体验 | 追更自动分析最新章节 |
| 站点范围 | 起点 / 番茄 / 笔趣阁，全部要支持（需站点适配器） |
| 章节来源 | 目录页解析章节列表，与后端"已分析"比对出缺口 |
| 规模与等待 | 大批量、后台队列，能关页面、断点续跑 |

---

## 核心约束（架构的出发点）

> **正文抓取几乎只能留在浏览器里做。**

- 番茄字体加密（`decodeFanqieText`）、起点登录态 cookie + SPA、各站反爬，这些能力都在现有 `content.js` 里、依赖真实浏览器环境。
- 后端 `requests` 服务端抓取：笔趣阁可行；番茄需把 372 字符码表移植到 Python（可行，码表是纯数据）；**起点基本抓不到、会被风控**。

因此"关页面也能跑"与"正文得浏览器抓"存在天然张力。折中方案：**后端当"大脑"（队列 + 进度 + AI），浏览器当"手"（抓目录 + 抓正文）**。手需要 Chrome 和一个标签页/扩展进程活着，但大脑全程记账，随时可断点续跑。

---

## 总体架构

```
[目录页]  content script 识别目录页 → 解析章节列表（标题+序号+URL）
   │  POST /api/analyze/batch/create  { book_title, chapter_list[], ... }
   ▼
[后端]  建 batch_jobs + batch_items，跟 analyses 表比对出"缺口"
        （已分析过的章节直接标 skipped，不重复花积分）
   │  返回 { job_id, pending: 61-65 }
   ▼
[目录页抓取器]  逐个 fetch(章节URL) → DOMParser 抓正文（番茄先解密）
   │  POST /api/analyze/batch/{job_id}/submit  { item_id, text }
   ▼
[后端]  复用现有分析管线：乱码检测 → 缓存 → 扣积分 → analyze_text → 存 analyses
        → 更新 batch_items + batch_jobs 进度
   │
   ▼
[目录页进度面板]  实时轮询进度 done/total，可暂停/续跑
```

**关键设计**：抓取器全程停在目录页一个标签页里，用 `fetch` 抓章节正文，不跳页（笔趣阁/番茄都是同源静态页，`fetch` 直接拿到 HTML）。"关页面也能跑"的实际边界是：**Chrome 开着、留一个目录页标签**；后端全程记账，重开目录页即可续跑。

---

## 后端改动

### 新增数据表（`init_db()` 内追加，沿用 `ALTER TABLE` 兼容旧库风格）

```sql
CREATE TABLE IF NOT EXISTS batch_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    book_id INTEGER DEFAULT NULL,
    book_title TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | paused | done
    detail_level TEXT NOT NULL DEFAULT 'standard',
    spoiler_free INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES batch_jobs(id),
    chapter_title TEXT NOT NULL,
    chapter_index INTEGER DEFAULT NULL,
    source_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | analyzing | done | failed | skipped
    text_hash TEXT,
    error TEXT DEFAULT '',
    created_at INTEGER NOT NULL
);
```

### 新增接口（全部 `Depends(get_user)`）

| 接口 | 作用 |
|------|------|
| `POST /api/analyze/batch/create` | 收章节列表 → 解析/建书（复用 `/api/analyze` 的 title/URL 匹配逻辑）→ 比对已分析 → 建 job + items（缺口只建 pending，已分析标 skipped）→ 返回 `{job_id, total, pending, skipped}` |
| `POST /api/analyze/batch/{job_id}/submit` | 收单章正文 → 复用分析管线 → 更新 item/job 进度。乱码/额度不足/拒绝文案 → item 标 `failed` 并退款/记 error |
| `GET /api/analyze/batch/{job_id}` | 返回 `{job, items[]}` 进度 |
| `GET /api/analyze/batch` | 列出该用户未完成任务（供续跑） |

**缺口判重键**：章节"已分析"按 `(book_id, chapter_index)` 判定为主；`chapter_index` 缺失时回退用 `(book_id, source_url)`；两者都没有则按 `text_hash`（提交正文后才能命中缓存/历史）。任一命中即标 `skipped`，不重复花积分。

### 复用而非重造

以下全部原样复用，批量只是把它们套进循环：

- `analyze_text(text, chapter_title, detail_level, spoiler_free)` — AI 分析调用
- `text_hash()` — 正文去重
- `_looks_garbled()` — 字体加密乱码检测
- `_is_rejection_result()` — AI 拒绝文案检测
- `_get_cached_analysis()` / `_cache_analysis()` — 全局缓存
- 积分扣减 + `log_usage()` + 异常/拒绝退款
- 书籍解析/创建（title / URL 匹配）

**成本约定**：每章仍扣 1 积分，与当前逐章一致，不另开扣费通道。

---

## 前端改动（`JianLai_Helper/content.js` + 弹窗）

1. **目录页识别**：判断当前页是"章节列表页"（启发式：存在大量指向章节的同构 `<a>` 链接）。
2. **目录解析适配器**：从 DOM 提取 `[{chapter_title, chapter_index, source_url}]`。
3. **抓取器循环**：对每个 pending item，`fetch(source_url)` → `DOMParser` → 复用现有 `getChapterText` 选择器逻辑 + `decodeFanqieText` → `submit`。番茄先解密再提交。
4. **进度面板**：目录页右下角浮层，显示 `done/total`、当前章、失败数、暂停/继续按钮，轮询 `GET /api/analyze/batch/{job_id}`。

---

## 站点适配器

每个站一个适配器对象，实现统一接口 `{detectCatalog(), parseCatalog(), fetchChapter(url) → text}`，新站只需加一个适配器。

| 站点 | 目录解析 | 正文抓取 | 难点/风险 |
|------|---------|---------|----------|
| 笔趣阁 | 静态列表，简单 | `fetch` + DOMParser，最稳 | 章节名/顺序可能错乱（沿用已修的 `getChapterTitle`） |
| 番茄 | 列表可抓 | `fetch` 拿到 PUA 加密 HTML → `decodeFanqieText` | 需确认目录页结构；解密码表已硬编码，直接复用 |
| 起点 | SPA，目录常分页/懒加载 | `fetch` 大概率拿到空壳 → **兜底：隐藏 iframe（`all_frames` 内容脚本 + `postMessage`）或真实跳页** | 最硬的一块，反爬最强 |

---

## 错误处理与断点续跑

**错误处理**（每章独立，一章失败不拖垮整批）：

- 抓取失败/超时 → item 标 `failed`，记 error，自动跳到下一章；面板显示"失败 N 章，可重试"
- 额度不足 → job 自动 `paused`，攒够积分后一键续跑
- 乱码/拒绝 → item 标 `failed`，退款，不写历史（与现有行为一致）

**断点续跑**：进度全在 `batch_jobs/batch_items` 表，重开目录页 → `GET /api/analyze/batch` 列出未完成任务 → 一键续跑，只补 pending/failed。

---

## 测试

- **后端**：pytest 单测 `/api/analyze/batch/*`（建任务、缺口比对、submit 复用管线、额度不足暂停、断点续跑），`analyze_text` 打桩。
- **前端**：目录页解析适配器用 3 个站的真实 DOM 样本做单元测试；fetch 抓取 + 番茄解密抽成纯函数测试。
- **E2E**：playwright 跑"笔趣阁目录页 → 建任务 → 抓 3 章 → 进度 3/3"。

---

## 风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| 起点 SPA 抓取失败/被风控 | 高 | iframe/跳页兜底；若仍不稳，起点降级为"手动复制正文"提示，不影响其他站 |
| 番茄目录页结构未知 | 中 | 先抓真实样本确认结构再写适配器 |
| 批量耗积分快（80 章 = 80 积分） | 中 | job 额度不足自动暂停 + 明确提示，攒够续跑 |
| 长时间批量被限流 | 中 | 复用现有 `_check_rate_limit` + 2s 节流，逐章串行 |

---

## 不做的

以下主动排除，避免范围膨胀：

- ❌ 不做后端服务端抓取正文（起点不可行，番茄成本高）
- ❌ 不做真正的"关 Chrome 也能跑"（需要服务器抓取或常驻进程，违背核心约束）
- ❌ 不做定时自动追更（每天定点跑），本次只做手动触发 + 断点续跑
- ❌ 不做多线程并发分析（串行已够，避免触发限流与反爬）
