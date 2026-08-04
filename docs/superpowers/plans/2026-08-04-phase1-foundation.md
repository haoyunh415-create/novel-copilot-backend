# 鉴来助手 — 阶段一（筑基）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为鉴来助手补齐数据统计、降低 AI 成本、添加分析历史回看入口

**Architecture:** 后端新增统计聚合 API 和全局分析缓存表，管理后台内嵌 Chart.js 仪表盘，扩展弹窗新增"最近分析"标签页

**Tech Stack:** Python 3.10 + FastAPI + SQLite + Chart.js 4.4 CDN + Vanilla JS (Chrome Extension)

## Global Constraints

- 所有后端改动均在 `main.py` 中完成（FastAPI 单文件架构）
- 扩展前端改动在 `JianLai_Helper/popup.html` 和 `popup.js` 中完成
- 新增数据库表通过 `init_db()` 中的 CREATE TABLE IF NOT EXISTS 创建
- 管理后台验证沿用现有 `verify_admin` + `admin_key` 参数机制
- 免登录试用（guest analyze）相关端点也需要全局缓存支持

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `main.py` | Modify | 新增 `/api/admin/stats` API；新增 `analysis_cache` 表；修改 `init_db()`；修改 analyze 系列端点的缓存逻辑 |
| `JianLai_Helper/popup.html` | Modify | 新增"最近分析"标签页 UI |
| `JianLai_Helper/popup.js` | Modify | 新增历史分析加载和展示逻辑 |

---

### Task 1: 后端统计 API

**Files:**
- Modify: `main.py` — 在管理后台区域新增路由

**Interfaces:**
- Produces: `GET /api/admin/stats?admin_key=xxx` → `{success, data: {dau, wau, total_users, today_analyses, guest_conversion, feature_distribution, error_rate, platforms, retention_d1, retention_d7}}`

- [ ] **Step 1: 在管理后台区域添加 stats API**

在 main.py 中 `# ── 管理后台 ──` 区块内（`@app.get("/api/track/stats")` 之后、`@app.get("/api/admin/users")` 之前，约第 2200 行）插入以下代码：

```python
@app.get("/api/admin/stats")
def admin_stats(_admin=Depends(verify_admin)):
    """管理后台统计仪表盘数据"""
    import time as _time
    now = int(_time.time())
    day_ago = now - 86400
    week_ago = now - 86400 * 7
    month_ago = now - 86400 * 30

    with get_db() as conn:
        dau = conn.execute(
            "SELECT COUNT(DISTINCT username) FROM usage_logs WHERE created_at >= ?",
            (day_ago,)
        ).fetchone()[0]

        wau = conn.execute(
            "SELECT COUNT(DISTINCT username) FROM usage_logs WHERE created_at >= ?",
            (week_ago,)
        ).fetchone()[0]

        total_users = conn.execute(
            "SELECT COUNT(*) FROM users"
        ).fetchone()[0]

        today_analyses = conn.execute(
            "SELECT COUNT(*) FROM usage_logs WHERE created_at >= ? AND action IN ('analyze', 'guest_analyze')",
            (day_ago,)
        ).fetchone()[0]

        guest_trial_users = conn.execute(
            "SELECT COUNT(DISTINCT username) FROM usage_logs WHERE action='guest_analyze'"
        ).fetchone()[0]

        guest_to_reg = conn.execute(
            """
            SELECT COUNT(DISTINCT u.username) FROM users u
            WHERE EXISTS (
                SELECT 1 FROM usage_logs ul
                WHERE ul.action='guest_analyze'
                AND 'guest:' || u.username = ul.username
            )
            """
        ).fetchone()[0]
        guest_conversion = round(guest_to_reg / guest_trial_users * 100, 1) if guest_trial_users > 0 else 0

        feature_dist = {}
        for action, label in [
            ("analyze", "章节分析"), ("ask", "问答"),
            ("full_report", "全书复盘"), ("review", "追更回顾"),
            ("guest_analyze", "免登录试用"),
        ]:
            cnt = conn.execute(
                "SELECT COUNT(*) FROM usage_logs WHERE action=? AND created_at >= ?",
                (action, month_ago),
            ).fetchone()[0]
            if cnt > 0:
                feature_dist[label] = cnt

        total_requests = conn.execute(
            "SELECT COUNT(*) FROM usage_logs WHERE created_at >= ?",
            (week_ago,)
        ).fetchone()[0]
        error_count = conn.execute(
            "SELECT COUNT(*) FROM usage_logs WHERE created_at >= ? AND (action='error' OR detail LIKE '%失败%' OR detail LIKE '%错误%')",
            (week_ago,)
        ).fetchone()[0]
        error_rate = round(error_count / total_requests * 100, 1) if total_requests > 0 else 0

        platforms = {}
        rows = conn.execute(
            "SELECT source_url_pattern FROM books WHERE source_url_pattern != ''"
        ).fetchall()
        for row in rows:
            url = row["source_url_pattern"]
            import re as _re
            m = _re.match(r"https?://(?:www\.)?([^/.]+)", url)
            domain = m.group(1) if m else "other"
            platforms[domain] = platforms.get(domain, 0) + 1

        total_reg = conn.execute("SELECT COUNT(*) FROM users WHERE created_at > 0").fetchone()[0]
        active_7d = conn.execute(
            "SELECT COUNT(DISTINCT username) FROM usage_logs WHERE created_at >= ? AND username NOT LIKE 'guest:%'",
            (week_ago,)
        ).fetchone()[0]
        retention_d7 = round(active_7d / total_reg * 100, 1) if total_reg > 0 else 0

    return ok({
        "dau": dau,
        "wau": wau,
        "total_users": total_users,
        "today_analyses": today_analyses,
        "guest_trial_users": guest_trial_users,
        "guest_to_registered": guest_to_reg,
        "guest_conversion": guest_conversion,
        "feature_distribution": feature_dist,
        "error_rate": error_rate,
        "total_requests_7d": total_requests,
        "error_count_7d": error_count,
        "platforms": platforms,
        "retention_d7": retention_d7,
        "generated_at": now,
    })
```

- [ ] **Step 2: 验证 API**

```bash
curl -s "https://jianla.xyz:8000/api/admin/stats?admin_key=f3295289ffa4ed9e0b770682b192558a" | python -m json.tool
```

预期：返回 200，所有字段存在。

- [ ] **Step 3: 提交**

```bash
git add main.py && git commit -m "feat: add admin stats API for dashboard metrics"
```

---

### Task 2: 管理后台仪表盘 UI

**Files:**
- Modify: `main.py` — `/admin` 路由内嵌 HTML

**Interfaces:**
- Consumes: `GET /api/admin/stats`（Task 1）

- [ ] **Step 1: 添加 Chart.js CDN 和仪表盘 HTML**

在 `admin_page()` 返回的 HTML 中，`</head>` 之前添加：

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
```

在 `<h1>鉴来助手 · 管理后台</h1>` 和 `<div id="message"></div>` 之间添加仪表盘卡片：

```html
<div id="message"></div>

<div class="card">
  <h2>📊 数据仪表盘 <span style="font-size:11px;color:#888;font-weight:400">（每60秒自动刷新）</span></h2>
  <div class="row" id="stats-cards" style="gap:12px;margin-bottom:16px">
    <div style="flex:1;min-width:120px;padding:14px;background:#f5f0eb;border-radius:8px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#5d4037" id="stat-dau">-</div>
      <div style="font-size:11px;color:#8d6e63">今日活跃 (DAU)</div>
    </div>
    <div style="flex:1;min-width:120px;padding:14px;background:#f5f0eb;border-radius:8px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#5d4037" id="stat-wau">-</div>
      <div style="font-size:11px;color:#8d6e63">7日活跃 (WAU)</div>
    </div>
    <div style="flex:1;min-width:120px;padding:14px;background:#f5f0eb;border-radius:8px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#5d4037" id="stat-users">-</div>
      <div style="font-size:11px;color:#8d6e63">总注册用户</div>
    </div>
    <div style="flex:1;min-width:120px;padding:14px;background:#f5f0eb;border-radius:8px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#2e7d32" id="stat-analyses">-</div>
      <div style="font-size:11px;color:#8d6e63">今日分析次数</div>
    </div>
    <div style="flex:1;min-width:120px;padding:14px;background:#f5f0eb;border-radius:8px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#e65100" id="stat-conversion">-</div>
      <div style="font-size:11px;color:#8d6e63">试用→注册转化</div>
    </div>
  </div>
  <div class="row" style="gap:16px">
    <div style="flex:1;min-width:300px">
      <canvas id="chart-features" height="200"></canvas>
    </div>
    <div style="flex:1;min-width:300px">
      <canvas id="chart-platforms" height="200"></canvas>
    </div>
  </div>
  <div style="margin-top:12px;font-size:12px;color:#8d6e63">
    错误率（7日）：<b id="stat-errors" style="color:#c62828">-</b> &nbsp;|&nbsp;
    留存率 D7：<b id="stat-d7">-</b>
  </div>
</div>
```

- [ ] **Step 2: 添加仪表盘 JS 逻辑**

在 admin HTML 的 `<script>` 标签内，`loadData()` 函数之前添加：

```javascript
var charts = {};

function renderStats(data) {
  document.getElementById("stat-dau").textContent = data.dau;
  document.getElementById("stat-wau").textContent = data.wau;
  document.getElementById("stat-users").textContent = data.total_users;
  document.getElementById("stat-analyses").textContent = data.today_analyses;
  document.getElementById("stat-conversion").textContent = data.guest_conversion + "%";
  document.getElementById("stat-errors").textContent = data.error_rate + "% (" + data.error_count_7d + "/" + data.total_requests_7d + ")";
  document.getElementById("stat-d7").textContent = data.retention_d7 + "%";

  var featCtx = document.getElementById("chart-features").getContext("2d");
  if (charts.features) charts.features.destroy();
  var featLabels = Object.keys(data.feature_distribution);
  var featValues = Object.values(data.feature_distribution);
  charts.features = new Chart(featCtx, {
    type: "doughnut",
    data: {
      labels: featLabels,
      datasets: [{ data: featValues, backgroundColor: ["#5d4037","#8d6e63","#c75b39","#b8860b","#6b8e6b"] }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom", labels: { font: { size: 11 }, padding: 12 } },
        title: { display: true, text: "功能使用分布（30天）", font: { size: 13 } }
      }
    }
  });

  var platCtx = document.getElementById("chart-platforms").getContext("2d");
  if (charts.platforms) charts.platforms.destroy();
  var platLabels = Object.keys(data.platforms);
  var platValues = Object.values(data.platforms);
  charts.platforms = new Chart(platCtx, {
    type: "bar",
    data: {
      labels: platLabels,
      datasets: [{ label: "用户数", data: platValues, backgroundColor: "#8d6e63" }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: { display: true, text: "平台分布", font: { size: 13 } }
      },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
    }
  });
}

async function loadStats() {
  try {
    var res = await fetchAPI("/api/admin/stats");
    if (res.success) renderStats(res.data);
  } catch (e) { console.error("Stats load failed:", e); }
}
```

在 `loadData()` 开头添加 `loadStats();` 调用，并修改页面初始化脚本添加自动刷新：

```javascript
loadData();
setInterval(loadData, 60000);
```

- [ ] **Step 3: 本地验证**

启动本地后端 `python main.py`，浏览器打开 `http://localhost:8001/admin`，设置 admin_key，验证仪表盘显示。

- [ ] **Step 4: 提交**

```bash
git add main.py && git commit -m "feat: add admin dashboard with Chart.js stats visualization"
```

---

### Task 3: 全局分析缓存

**Files:**
- Modify: `main.py` — `init_db()` + 所有 analyze 端点

**Interfaces:**
- Produces: `analysis_cache(text_hash TEXT, detail_level TEXT, spoiler_free INTEGER, result_json TEXT, created_at INTEGER, UNIQUE(text_hash, detail_level, spoiler_free))`
- Produces: `_get_cached_analysis(conn, text_hash, detail_level, spoiler_free) -> dict | None`
- Produces: `_cache_analysis(conn, text_hash, detail_level, spoiler_free, result)` -> void

- [ ] **Step 1: 创建 `analysis_cache` 表**

在 `init_db()` 中 `email_logs` 表创建之后（约第 304 行）添加：

```python
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS analysis_cache (
                text_hash TEXT NOT NULL,
                detail_level TEXT NOT NULL,
                spoiler_free INTEGER NOT NULL,
                result_json TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(text_hash, detail_level, spoiler_free)
            )
            """
        )
```

- [ ] **Step 2: 添加缓存读写辅助函数**

在 `init_db()` 函数之后添加：

```python
def _get_cached_analysis(conn, text_hash: str, detail_level: str, spoiler_free: int):
    """从全局缓存读取分析结果。返回 dict 或 None。"""
    row = conn.execute(
        "SELECT result_json FROM analysis_cache WHERE text_hash=? AND detail_level=? AND spoiler_free=?",
        (text_hash, detail_level, spoiler_free),
    ).fetchone()
    return json.loads(row["result_json"]) if row else None


def _cache_analysis(conn, text_hash: str, detail_level: str, spoiler_free: int, result: dict):
    """将分析结果写入全局缓存。INSERT OR IGNORE 自动处理并发重复。"""
    conn.execute(
        "INSERT OR IGNORE INTO analysis_cache (text_hash, detail_level, spoiler_free, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
        (text_hash, detail_level, spoiler_free, json.dumps(result, ensure_ascii=False), int(time.time())),
    )
```

- [ ] **Step 3: 修改 `/api/analyze` 缓存检查**

找到（约第 965 行）：

```python
    with get_db() as conn:
        cached = conn.execute(
            "SELECT result_json FROM analyses WHERE username=? AND text_hash=? AND detail_level=? AND spoiler_free=?",
            (user, content_hash, req.detail_level, spoiler_free),
        ).fetchone()
    if cached:
        return ok({"result": json.loads(cached["result_json"]), "cached": True})
```

替换为：

```python
    with get_db() as conn:
        cached = _get_cached_analysis(conn, content_hash, req.detail_level, spoiler_free)
        if not cached:
            old = conn.execute(
                "SELECT result_json FROM analyses WHERE username=? AND text_hash=? AND detail_level=? AND spoiler_free=?",
                (user, content_hash, req.detail_level, spoiler_free),
            ).fetchone()
            if old:
                cached = json.loads(old["result_json"])
    if cached:
        return ok({"result": cached, "cached": True})
```

然后在结果插入部分，`INSERT OR REPLACE INTO analyses` 之后、`if book_id:` 之前添加：

```python
            _cache_analysis(conn, content_hash, req.detail_level, spoiler_free, result)
```

- [ ] **Step 4: 修改 `/api/analyze/progressive` 缓存**

找到（约第 1299 行）的缓存检查，替换为同样模式：

```python
        cached = _get_cached_analysis(conn, content_hash, req.detail_level, spoiler_int)
        if not cached:
            old = conn.execute("SELECT result_json FROM analyses WHERE username=? AND text_hash=? AND detail_level=? AND spoiler_free=?", (user, content_hash, req.detail_level, spoiler_int)).fetchone()
            if old: cached = json.loads(old["result_json"])
        if cached:
            async def ce(): yield f"data: {json.dumps({'type': 'done', 'data': {'result': cached, 'cached': True, 'book_id': book_id}}, ensure_ascii=False)}\n\n"
            return StreamingResponse(ce(), media_type="text/event-stream")
```

在 event_stream 的 INSERT analyses 后添加：

```python
                        _cache_analysis(db_conn, content_hash, req.detail_level, spoiler_int, result)
```

- [ ] **Step 5: 修改 `/api/analyze/guest/progressive`**

确认该端点（约第 1352 行）已定义 `content_hash` 和 `spoiler_int` 变量；如果没有，在限流检查后添加：

```python
    content_hash = text_hash(req.text)
    spoiler_int = 1 if req.spoiler_free else 0
```

在 event_stream 中，result 生成后添加：

```python
                try:
                    with get_db() as db_conn:
                        _cache_analysis(db_conn, content_hash, req.detail_level, spoiler_int, result)
                except Exception:
                    pass
```

- [ ] **Step 6: 修改 `/api/analyze/guest`**

在该端点 AI 调用完成后的 `log_usage` 之后添加全局缓存写入：

```python
            _cache_analysis(conn, content_hash, req.detail_level, 1 if req.spoiler_free else 0, result)
```

- [ ] **Step 7: 修改 `/api/analyze/stream`**

在限流检查后添加缓存检查：

```python
    content_hash = text_hash(req.text)
    spoiler_int = 1 if req.spoiler_free else 0
    with get_db() as conn:
        cached = _get_cached_analysis(conn, content_hash, req.detail_level, spoiler_int)
    if cached:
        async def cached_stream():
            yield f"data: {json.dumps({'type': 'done', 'data': {'result': cached, 'cached': True}}, ensure_ascii=False)}\n\n"
        return StreamingResponse(cached_stream(), media_type="text/event-stream")
```

在 event_stream 中 result 生成后添加：

```python
                try:
                    with get_db() as db_conn:
                        _cache_analysis(db_conn, content_hash, req.detail_level, spoiler_int, result)
                except Exception:
                    pass
```

- [ ] **Step 8: 验证**

```bash
# 用两个不同用户/guest分析同一章节，第二个应返回 cached:true
```

- [ ] **Step 9: 提交**

```bash
git add main.py && git commit -m "feat: add global analysis cache to deduplicate AI calls across users"
```

---

### Task 4: 扩展弹窗 — 分析历史回看

**Files:**
- Modify: `JianLai_Helper/popup.html`
- Modify: `JianLai_Helper/popup.js`

**Interfaces:**
- Consumes: `GET /api/books` + `GET /api/books/{id}/analyses`（已存在）

- [ ] **Step 1: 添加"最近分析"HTML**

在 `popup.html` 的 `<div class="settings"` 之前（约第 238 行）插入：

```html
    <!-- 最近分析 -->
    <div id="recent-section" style="display:none">
      <button id="toggle-recent" class="btn btn-outline" style="font-size:11px;min-height:30px">
        📋 最近分析 <span id="recent-count" style="color:var(--brown-light)"></span>
      </button>
      <div id="recent-list" style="display:none;margin-top:6px;max-height:220px;overflow-y:auto;background:var(--card);border:1px solid var(--border);border-radius:8px"></div>
    </div>
```

- [ ] **Step 2: 添加 popup.js 历史加载逻辑**

在 `renderState()` 函数中 `$("user-box").style.display = "block"` 之后添加：

```javascript
    loadRecentAnalyses(token);
```

在 `renderState` 函数之后添加：

```javascript
var _recentBooks = [];

async function loadRecentAnalyses(token) {
  try {
    var booksData = await apiFetch("/api/books", {
      headers: { Authorization: "Bearer " + token }
    });
    var books = booksData.books || [];
    _recentBooks = books;
    if (books.length === 0) return;

    $("recent-section").style.display = "block";
    $("recent-count").textContent = "（" + books.length + " 本书）";

    var allAnalyses = [];
    for (var i = 0; i < Math.min(books.length, 5); i++) {
      try {
        var analysesData = await apiFetch("/api/books/" + books[i].id + "/analyses?limit=3", {
          headers: { Authorization: "Bearer " + token }
        });
        var items = (analysesData.analyses || []).map(function(a) {
          a._bookTitle = books[i].title;
          a._bookId = books[i].id;
          return a;
        });
        allAnalyses = allAnalyses.concat(items);
      } catch (_) {}
    }

    if (allAnalyses.length === 0) return;
    allAnalyses.sort(function(a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    allAnalyses = allAnalyses.slice(0, 10);

    var html = "";
    for (var j = 0; j < allAnalyses.length; j++) {
      var a = allAnalyses[j];
      var result = typeof a.result_json === "string" ? JSON.parse(a.result_json) : a.result_json;
      var summary = (result && result.summary) ? result.summary.slice(0, 60) : "无摘要";
      var time = a.created_at ? new Date(a.created_at * 1000).toLocaleDateString("zh-CN") : "";
      html += '<div style="padding:8px 12px;border-bottom:1px solid #eee;font-size:11px">' +
        '<div style="font-weight:600;color:#5d4037">' + escHtml(a.chapter_title || "未知章节") + '</div>' +
        '<div style="color:#8d6e63;font-size:10px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(summary) + '</div>' +
        '<div style="color:#b0a395;font-size:10px;margin-top:2px">' + escHtml(a._bookTitle) + ' · ' + time + '</div>' +
      '</div>';
    }
    $("recent-list").innerHTML = html;
  } catch (_) {}
}

function escHtml(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str || ""));
  return div.innerHTML;
}
```

- [ ] **Step 3: 添加折叠展开事件**

在 `DOMContentLoaded` 事件监听器中添加：

```javascript
  var toggleRecentBtn = $("toggle-recent");
  if (toggleRecentBtn) {
    toggleRecentBtn.addEventListener("click", function () {
      var list = $("recent-list");
      if (list.style.display === "none" || list.style.display === "") {
        list.style.display = "block";
        toggleRecentBtn.innerHTML = '📋 收起 <span id="recent-count" style="color:var(--brown-light)">（' + (_recentBooks.length || 0) + ' 本书）</span>';
      } else {
        list.style.display = "none";
        toggleRecentBtn.innerHTML = '📋 最近分析 <span id="recent-count" style="color:var(--brown-light)">（' + (_recentBooks.length || 0) + ' 本书）</span>';
      }
    });
  }
```

- [ ] **Step 4: 本地测试**

Chrome `chrome://extensions` → 加载 `JianLai_Helper` → 打开小说页 → 登录 → 点扩展 → 验证"最近分析"可展开。

- [ ] **Step 5: 提交**

```bash
git add JianLai_Helper/popup.html JianLai_Helper/popup.js
git commit -m "feat: add recent analysis history to extension popup"
```

---

### Task 5: 部署与发布

- [ ] **Step 1: 推送代码到 GitHub**

```bash
git push origin main
```

- [ ] **Step 2: 服务器部署**

```bash
ssh root@8.134.8.50
cd /opt/novel-copilot-backend && git pull && systemctl restart novel-copilot
systemctl status novel-copilot
```

- [ ] **Step 3: 验证线上**

- 打开 `https://jianla.xyz/admin` → 仪表盘显示数据
- 扩展弹窗 → "最近分析"正常显示
- 两个不同用户分析同一章节 → 第二个返回 cached

- [ ] **Step 4: 打包扩展并上传商店**

```bash
cd C:\Users\32639\novel-copilot-backend
zip -r jianlai-helper-v2.3.0.zip JianLai_Helper/ -x "*.git*"
```

上传到 Chrome Web Store 和 Edge Store 开发者后台。

---

## Self-Review

1. **Spec coverage**: 统计仪表盘 → Task 1+2 ✅；全局缓存 → Task 3 ✅；历史回看 → Task 4 ✅
2. **Placeholder scan**: 无 TBD/TODO，所有步骤包含实际代码 ✅
3. **Type consistency**: `_get_cached_analysis` / `_cache_analysis` 签名在所有端点一致 ✅；popup.js 与现有 apiFetch 返回格式兼容 ✅
