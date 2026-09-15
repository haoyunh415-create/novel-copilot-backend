# 追更批量分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能在目录页一键批量抓取+分析多章正文，后端建任务队列记录进度，支持断点续跑。

**Architecture:** 混合架构——浏览器 content script 负责目录解析与正文抓取（复用现有 `decodeFanqieText`/`getChapterText` 选择器），后端 FastAPI 负责任务队列（`batch_jobs`/`batch_items` 两张表）+ 复用现有分析管线（`analyze_text` + 积分扣减）。抓取器全程停在目录页一个标签页，用 `fetch`+`DOMParser` 抓章节正文，不跳页。

**Tech Stack:** FastAPI + SQLite（后端）；原生 JS content script + `DOMParser`（前端）；pytest + httpx（后端测试）；vitest + jsdom（前端解析器测试）。

**Spec:** `docs/superpowers/specs/2026-09-15-batch-analysis-design.md`

## Global Constraints

- 站点范围：起点 / 番茄 / 笔趣阁全部要支持（站点适配器）。
- 每章仍扣 1 积分，不另开扣费通道（复用 `log_usage` + `try_daily_bonus`）。
- 逐章串行分析，不做并发；复用 `_check_rate_limit("analyze")` + 2s `user_last_request` 节流。
- 不做后端服务端抓取正文（起点不可行、番茄成本高），正文抓取只在浏览器。
- 不做定时自动追更；只做手动触发 + 断点续跑。
- 复用：`analyze_text` / `text_hash` / `_looks_garbled` / `_is_rejection_result` / `_get_cached_analysis` / `_cache_analysis` / `decodeFanqieText` / `getChapterText` 选择器。
- 用户脚本（`userscript/*.user.js`）为独立副本，本次范围外，只改 Chrome 扩展。

---

### Task 1: 后端测试基建 + 批量任务表结构

**Files:**
- Create: `requirements-dev.txt`
- Create: `tests/conftest.py`
- Create: `tests/test_batch_schema.py`
- Modify: `main.py`（`init_db()` 末尾追加两张表）

**Interfaces:**
- Produces: `get_db` 可被 monkeypatch 的测试夹具 `db`、`client`、`user_token`；`batch_jobs`/`batch_items` 表结构（后续 Task 3/4/5 依赖）。

- [ ] **Step 1: 写 requirements-dev.txt**

```
pytest>=8.0.0
httpx>=0.27.0
```

- [ ] **Step 2: 写 tests/conftest.py（测试夹具：临时 DB + 认证用户）**

```python
import sqlite3
from contextlib import contextmanager

import pytest

import main as m


@pytest.fixture(autouse=True)
def _reset_limits():
    """每个用例前清空内存限流，避免 2s 节流跨用例残留。"""
    m.user_last_request.clear()
    if hasattr(m, "_rate_limits"):
        m._rate_limits.clear()
    yield


@pytest.fixture()
def db(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"

    @contextmanager
    def _get_db():
        conn = sqlite3.connect(str(db_file), check_same_thread=False, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    monkeypatch.setattr(m, "get_db", _get_db)
    m.init_db()
    return db_file


@pytest.fixture()
def user_token(db):
    with m.get_db() as conn:
        conn.execute(
            "INSERT INTO users (username, password, credits) VALUES ('testuser', 'x', 100)"
        )
    return m.create_token("testuser")


@pytest.fixture()
def client(db, user_token):
    from fastapi.testclient import TestClient
    c = TestClient(m.app)
    c.headers = {"Authorization": "Bearer " + user_token}
    return c
```

- [ ] **Step 3: 写 tests/test_batch_schema.py（失败测试）**

```python
import main as m


def test_batch_tables_exist(db):
    with m.get_db() as conn:
        jobs = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='batch_jobs'"
        ).fetchall()
        items = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='batch_items'"
        ).fetchall()
    assert len(jobs) == 1
    assert len(items) == 1
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pip install -r requirements-dev.txt && python -m pytest tests/test_batch_schema.py -v`
Expected: FAIL — `assert len(jobs) == 1` 失败（表不存在）

- [ ] **Step 5: 在 init_db() 末尾（kv_store 块之后）追加两张表**

```python
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS batch_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                book_id INTEGER DEFAULT NULL,
                book_title TEXT NOT NULL,
                total INTEGER NOT NULL DEFAULT 0,
                done INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                detail_level TEXT NOT NULL DEFAULT 'standard',
                spoiler_free INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS batch_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL REFERENCES batch_jobs(id),
                chapter_title TEXT NOT NULL,
                chapter_index INTEGER DEFAULT NULL,
                source_url TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                text_hash TEXT,
                error TEXT DEFAULT '',
                created_at INTEGER NOT NULL
            )
            """
        )
```

- [ ] **Step 6: 跑测试确认通过**

Run: `python -m pytest tests/test_batch_schema.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add requirements-dev.txt tests/conftest.py tests/test_batch_schema.py main.py
git commit -m "feat: add batch_jobs/batch_items schema + pytest harness"
```

---

### Task 2: 抽取共享分析管线 `_resolve_book_id` + `_analyze_one`

**Files:**
- Modify: `main.py`（`/api/analyze` 重构为复用共享函数）
- Create: `tests/test_analyze_regression.py`

**Interfaces:**
- Produces:
  - `_resolve_book_id(user: str, book_title, author, source_url, chapter_title) -> int|None`
  - `_analyze_one(user, *, text, chapter_title, source_url, detail_level, spoiler_free, book_id, chapter_index) -> dict`（返回 `ok()` 的 data；额度不足抛 `_InsufficientCredits`；乱码/拒绝/异常抛 `_AnalysisRejected`）
  - `class _InsufficientCredits(Exception)`、`class _AnalysisRejected(Exception)`（均带 `.msg`）

- [ ] **Step 1: 写回归测试（重构前锁定现有 /api/analyze 行为）**

```python
import main as m


def _stub_analyze_text(text, chapter_title, *, detail_level, spoiler_free):
    return {"summary": "测试摘要", "characters": [], "foreshadowing": [], "terms": []}


def test_analyze_deducts_credit_and_saves(monkeypatch, client, db):
    monkeypatch.setattr(m, "analyze_text", _stub_analyze_text)
    resp = client.post("/api/analyze", json={
        "text": "第一章正文内容，足够长的一段测试文本。" * 30,
        "chapter_title": "第一章 测试",
        "book_title": "测试书",
        "detail_level": "standard",
        "spoiler_free": True,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["result"]["summary"] == "测试摘要"
    with m.get_db() as conn:
        row = conn.execute("SELECT credits FROM users WHERE username='testuser'").fetchone()
        assert row["credits"] == 99
        n = conn.execute("SELECT COUNT(*) FROM analyses WHERE username='testuser'").fetchone()[0]
        assert n == 1


def test_analyze_refunds_on_garbled(monkeypatch, client, db):
    garbled = "" * 40 + "正常中文" * 5
    resp = client.post("/api/analyze", json={
        "text": garbled,
        "chapter_title": "第一章",
        "detail_level": "standard",
    })
    assert resp.json()["success"] is False
    with m.get_db() as conn:
        row = conn.execute("SELECT credits FROM users WHERE username='testuser'").fetchone()
        assert row["credits"] == 100
```

- [ ] **Step 2: 跑测试确认通过（锁定现有行为）**

Run: `python -m pytest tests/test_analyze_regression.py -v`
Expected: PASS（现有实现已满足）

- [ ] **Step 3: 新增共享函数（放在 `_is_rejection_result` 之后、`verify_token` 之前）**

```python
class _InsufficientCredits(Exception):
    def __init__(self, msg: str):
        self.msg = msg


class _AnalysisRejected(Exception):
    def __init__(self, msg: str):
        self.msg = msg


def _resolve_book_id(user, book_title, author, source_url, chapter_title):
    book_id = None
    with get_db() as conn:
        if book_title and book_title.strip():
            book = conn.execute(
                "SELECT id FROM books WHERE username=? AND title=?",
                (user, book_title.strip()),
            ).fetchone()
            if book:
                book_id = book["id"]
            else:
                cur = conn.execute(
                    "INSERT INTO books (username, title, author, source_url_pattern, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user, book_title.strip(), author or "", source_url or "", int(time.time())),
                )
                book_id = cur.lastrowid
        if not book_id and source_url:
            mm = re.match(r"(https?://[^/]+(/[^/]+/[^/]+/)?)", source_url)
            url_prefix = mm.group(1) if mm else source_url[:60]
            book = conn.execute(
                "SELECT id FROM books WHERE username=? AND source_url_pattern=?",
                (user, url_prefix),
            ).fetchone()
            if book:
                book_id = book["id"]
            else:
                fallback_title = chapter_title or url_prefix
                cur = conn.execute(
                    "INSERT INTO books (username, title, author, source_url_pattern, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user, fallback_title, author or "", url_prefix, int(time.time())),
                )
                book_id = cur.lastrowid
    return book_id


def _analyze_one(user, *, text, chapter_title, source_url, detail_level, spoiler_free, book_id, chapter_index):
    content_hash = text_hash(text)
    spoiler_int = 1 if spoiler_free else 0

    with get_db() as conn:
        cached = _get_cached_analysis(conn, content_hash, detail_level, spoiler_int)
        if not cached:
            old = conn.execute(
                "SELECT result_json FROM analyses WHERE username=? AND text_hash=? AND detail_level=? AND spoiler_free=?",
                (user, content_hash, detail_level, spoiler_int),
            ).fetchone()
            if old:
                try:
                    cached = json.loads(old["result_json"])
                except json.JSONDecodeError:
                    cached = None
    if cached:
        try:
            with get_db() as conn:
                _cache_analysis(conn, content_hash, detail_level, spoiler_int, cached)
        except Exception:
            pass
        return {"result": cached, "cached": True, "book_id": book_id}

    with get_db() as conn:
        bonus = try_daily_bonus(conn, user)
        row = conn.execute("SELECT credits FROM users WHERE username=?", (user,)).fetchone()
        if not row or row["credits"] <= 0:
            if bonus > 0:
                raise _InsufficientCredits("额度不足，但今日签到已领取 8 次！刷新页面后重试")
            raise _InsufficientCredits("额度不足，每日签到可领 8 次免费额度，打开插件弹窗自动领取")
        conn.execute("UPDATE users SET credits = credits - 1 WHERE username=? AND credits > 0", (user,))
        log_usage(conn, user, "analyze", f"分析章节: {chapter_title}", -1)

    analysis_text = text
    truncated = False
    MAX_CHARS = 8000
    if len(analysis_text) > MAX_CHARS:
        truncated = True
        cut_point = analysis_text.rfind("\n", 0, MAX_CHARS)
        if cut_point < MAX_CHARS // 2:
            cut_point = MAX_CHARS
        analysis_text = analysis_text[:cut_point] + "\n\n[提示：章节过长，已截取前 {:.0f}% 内容进行分析]".format(
            cut_point / len(text) * 100
        )

    try:
        result = analyze_text(analysis_text, chapter_title, detail_level=detail_level, spoiler_free=spoiler_free)
    except Exception as exc:
        with get_db() as conn:
            conn.execute("UPDATE users SET credits = credits + 1 WHERE username=?", (user,))
        raise _AnalysisRejected(friendly_error(exc))

    if _is_rejection_result(result):
        with get_db() as conn:
            conn.execute("UPDATE users SET credits = credits + 1 WHERE username=?", (user,))
        raise _AnalysisRejected("本章正文疑似乱码（如番茄小说字体加密），暂无法自动分析，请手动复制正文后重试")

    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO analyses (username, book_id, chapter_title, chapter_index, source_url, text_hash, detail_level, spoiler_free, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (user, book_id, chapter_title, chapter_index, source_url, content_hash, detail_level, spoiler_int, json.dumps(result, ensure_ascii=False), int(time.time())),
        )
        if book_id:
            conn.execute(
                "UPDATE books SET chapter_count = (SELECT COUNT(*) FROM analyses WHERE book_id=?) WHERE id=?",
                (book_id, book_id),
            )

    try:
        with get_db() as conn:
            _cache_analysis(conn, content_hash, detail_level, spoiler_int, result)
    except Exception:
        pass

    response_data = {"result": result, "cached": False, "book_id": book_id}
    if truncated:
        response_data["truncated"] = True
        response_data["warning"] = f"章节过长（{len(text)}字），仅分析了前{len(analysis_text)}字"
    return response_data
```

- [ ] **Step 4: 用共享函数重写 `/api/analyze`（保留限流/节流/乱码预检顺序）**

```python
@app.post("/api/analyze")
def analyze(req: AnalyzeRequest, user=Depends(get_user)):
    allowed, retry = _check_rate_limit("analyze", user=user)
    if not allowed:
        return fail(f"请求太频繁，请 {retry} 秒后再试")

    now = time.time()
    last = user_last_request.get(user, 0)
    if now - last < 2:
        return fail("请求太频繁了，请稍后再试")
    user_last_request[user] = now
    _cleanup_user_last_request()

    if _looks_garbled(req.text):
        return fail("本章正文疑似乱码（如番茄小说字体加密），暂无法自动分析，请手动复制正文后重试")

    book_id = _resolve_book_id(user, req.book_title, req.author, req.source_url, req.chapter_title)

    try:
        data = _analyze_one(
            user,
            text=req.text,
            chapter_title=req.chapter_title,
            source_url=req.source_url,
            detail_level=req.detail_level,
            spoiler_free=req.spoiler_free,
            book_id=book_id,
            chapter_index=req.chapter_index,
        )
        return ok(data)
    except _InsufficientCredits as e:
        return fail(e.msg)
    except _AnalysisRejected as e:
        return fail(e.msg)
```

- [ ] **Step 5: 跑回归测试确认重构后行为不变**

Run: `python -m pytest tests/test_analyze_regression.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add main.py tests/test_analyze_regression.py
git commit -m "refactor: extract _analyze_one/_resolve_book_id shared pipeline"
```

---

### Task 3: `POST /api/analyze/batch/create`

**Files:**
- Modify: `main.py`（`AnalyzeRequest` 之后新增 Pydantic 模型 + 端点）
- Create: `tests/test_batch_create.py`

**Interfaces:**
- Consumes: `_resolve_book_id`（Task 2）
- Produces: `BatchChapterItem`、`BatchCreateRequest`；端点 `POST /api/analyze/batch/create`；返回 `{job_id, total, pending, skipped}`

- [ ] **Step 1: 写失败测试**

```python
import main as m


def test_create_batch_marks_already_analyzed_as_skipped(client, db):
    with m.get_db() as conn:
        conn.execute(
            "INSERT INTO analyses (username, book_id, chapter_title, chapter_index, source_url, text_hash, detail_level, spoiler_free, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("testuser", None, "第一章", 1, "https://biquge.example/1.html", "h1", "standard", 1, "{}", 0),
        )
    resp = client.post("/api/analyze/batch/create", json={
        "book_title": "测试书",
        "chapter_list": [
            {"chapter_title": "第一章", "chapter_index": 1, "source_url": "https://biquge.example/1.html"},
            {"chapter_title": "第二章", "chapter_index": 2, "source_url": "https://biquge.example/2.html"},
            {"chapter_title": "第三章", "chapter_index": 3, "source_url": "https://biquge.example/3.html"},
        ],
    })
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["total"] == 3
    assert data["pending"] == 2
    assert data["skipped"] == 1
    job_id = data["job_id"]
    with m.get_db() as conn:
        items = conn.execute(
            "SELECT chapter_index, status FROM batch_items WHERE job_id=? ORDER BY chapter_index",
            (job_id,),
        ).fetchall()
    assert items[0]["status"] == "skipped"
    assert items[1]["status"] == "pending"
    assert items[2]["status"] == "pending"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_batch_create.py -v`
Expected: FAIL（端点不存在 404）

- [ ] **Step 3: 新增 Pydantic 模型**

先把 `main.py:14` 的 `from typing import Optional` 改为 `from typing import Optional, List`，再新增模型：

```python
class BatchChapterItem(BaseModel):
    chapter_title: str = Field(min_length=1, max_length=120)
    chapter_index: Optional[int] = Field(default=None)
    source_url: Optional[str] = Field(default=None, max_length=1000)


class BatchCreateRequest(BaseModel):
    book_title: Optional[str] = Field(default=None, max_length=200)
    author: Optional[str] = Field(default=None, max_length=200)
    chapter_list: List[BatchChapterItem] = Field(min_length=1, max_length=3000)
    detail_level: str = Field(default="standard", pattern="^(brief|standard|detailed)$")
    spoiler_free: bool = True
```

- [ ] **Step 4: 新增端点**

```python
@app.post("/api/analyze/batch/create")
def batch_create(req: BatchCreateRequest, user=Depends(get_user)):
    first = req.chapter_list[0] if req.chapter_list else None
    book_id = _resolve_book_id(
        user, req.book_title, req.author,
        first.source_url if first else None,
        first.chapter_title if first else "批量分析",
    )
    book_title = req.book_title or (first.chapter_title if first else "批量分析")

    with get_db() as conn:
        analyzed_indexes = {
            r["chapter_index"]
            for r in conn.execute("SELECT chapter_index FROM analyses WHERE book_id=?", (book_id,)).fetchall()
            if r["chapter_index"] is not None
        }
        analyzed_urls = {
            r["source_url"]
            for r in conn.execute("SELECT source_url FROM analyses WHERE book_id=?", (book_id,)).fetchall()
            if r["source_url"]
        }

    total = len(req.chapter_list)
    skipped = 0
    pending = 0
    now = int(time.time())
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO batch_jobs (username, book_id, book_title, total, status, detail_level, spoiler_free, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
            (user, book_id, book_title, total, req.detail_level, 1 if req.spoiler_free else 0, now),
        )
        job_id = cur.lastrowid
        for ch in req.chapter_list:
            is_done = (ch.chapter_index is not None and ch.chapter_index in analyzed_indexes) or (
                ch.source_url and ch.source_url in analyzed_urls
            )
            status = "skipped" if is_done else "pending"
            if is_done:
                skipped += 1
            else:
                pending += 1
            conn.execute(
                "INSERT INTO batch_items (job_id, chapter_title, chapter_index, source_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (job_id, ch.chapter_title, ch.chapter_index, ch.source_url, status, now),
            )
        conn.execute(
            "UPDATE batch_jobs SET total=?, done=?, status=? WHERE id=?",
            (total, skipped, "done" if pending == 0 else "pending", job_id),
        )

    return ok({"job_id": job_id, "total": total, "pending": pending, "skipped": skipped})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `python -m pytest tests/test_batch_create.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add main.py tests/test_batch_create.py
git commit -m "feat: add POST /api/analyze/batch/create with gap diff"
```

---

### Task 4: `POST /api/analyze/batch/{job_id}/submit`

**Files:**
- Modify: `main.py`（`_recount_job` 助手 + `BatchSubmitRequest` + 端点）
- Create: `tests/test_batch_submit.py`

**Interfaces:**
- Consumes: `_analyze_one`（Task 2）、`batch_jobs`/`batch_items`（Task 1）
- Produces: `_recount_job(conn, job_id)`、端点 `POST /api/analyze/batch/{job_id}/submit`

- [ ] **Step 1: 写失败测试**

```python
import main as m


def _stub_analyze_text(text, chapter_title, *, detail_level, spoiler_free):
    return {"summary": "批量摘要", "characters": [], "foreshadowing": [], "terms": []}


def _make_job(client):
    resp = client.post("/api/analyze/batch/create", json={
        "book_title": "测试书",
        "chapter_list": [
            {"chapter_title": "第一章", "chapter_index": 1, "source_url": "https://biquge.example/1.html"},
            {"chapter_title": "第二章", "chapter_index": 2, "source_url": "https://biquge.example/2.html"},
        ],
    })
    return resp.json()["data"]


def test_submit_analyzes_and_updates_progress(monkeypatch, client, db):
    monkeypatch.setattr(m, "analyze_text", _stub_analyze_text)
    job = _make_job(client)
    with m.get_db() as conn:
        item = conn.execute(
            "SELECT id FROM batch_items WHERE job_id=? AND status='pending' ORDER BY id LIMIT 1",
            (job["job_id"],),
        ).fetchone()
    resp = client.post(f"/api/analyze/batch/{job['job_id']}/submit", json={
        "item_id": item["id"],
        "text": "第二章正文内容，足够长的一段测试文本。" * 30,
    })
    assert resp.status_code == 200
    assert resp.json()["success"] is True
    with m.get_db() as conn:
        row = conn.execute("SELECT status FROM batch_items WHERE id=?", (item["id"],)).fetchone()
        assert row["status"] == "done"
        j = conn.execute("SELECT done, status FROM batch_jobs WHERE id=?", (job["job_id"],)).fetchone()
        assert j["done"] == 1
        assert j["status"] == "running"


def test_submit_pauses_on_insufficient_credits(monkeypatch, client, db):
    monkeypatch.setattr(m, "analyze_text", _stub_analyze_text)
    with m.get_db() as conn:
        conn.execute("UPDATE users SET credits=0 WHERE username='testuser'")
    job = _make_job(client)
    with m.get_db() as conn:
        item = conn.execute(
            "SELECT id FROM batch_items WHERE job_id=? AND status='pending' ORDER BY id LIMIT 1",
            (job["job_id"],),
        ).fetchone()
    resp = client.post(f"/api/analyze/batch/{job['job_id']}/submit", json={
        "item_id": item["id"],
        "text": "正文内容，足够长的一段测试文本。" * 30,
    })
    assert resp.json()["success"] is False
    with m.get_db() as conn:
        j = conn.execute("SELECT status FROM batch_jobs WHERE id=?", (job["job_id"],)).fetchone()
        assert j["status"] == "paused"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_batch_submit.py -v`
Expected: FAIL（端点不存在 404）

- [ ] **Step 3: 新增 `_recount_job` + `BatchSubmitRequest` + 端点**

```python
class BatchSubmitRequest(BaseModel):
    item_id: int
    text: str = Field(min_length=20, max_length=60000)


def _recount_job(conn, job_id):
    done = conn.execute(
        "SELECT COUNT(*) FROM batch_items WHERE job_id=? AND status='done'", (job_id,)
    ).fetchone()[0]
    failed = conn.execute(
        "SELECT COUNT(*) FROM batch_items WHERE job_id=? AND status='failed'", (job_id,)
    ).fetchone()[0]
    pending = conn.execute(
        "SELECT COUNT(*) FROM batch_items WHERE job_id=? AND status IN ('pending','analyzing')", (job_id,)
    ).fetchone()[0]
    if pending == 0:
        conn.execute(
            "UPDATE batch_jobs SET done=?, failed=?, status='done' WHERE id=?", (done, failed, job_id)
        )
    else:
        conn.execute(
            "UPDATE batch_jobs SET done=?, failed=? WHERE id=?", (done, failed, job_id)
        )


@app.post("/api/analyze/batch/{job_id}/submit")
def batch_submit(job_id: int, req: BatchSubmitRequest, user=Depends(get_user)):
    with get_db() as conn:
        job = conn.execute(
            "SELECT * FROM batch_jobs WHERE id=? AND username=?", (job_id, user)
        ).fetchone()
        if not job:
            return fail("任务不存在")
        item = conn.execute(
            "SELECT * FROM batch_items WHERE id=? AND job_id=?", (req.item_id, job_id)
        ).fetchone()
        if not item:
            return fail("章节不存在")
        if job["status"] == "done":
            return fail("任务已完成")

    allowed, retry = _check_rate_limit("analyze", user=user)
    if not allowed:
        return fail(f"请求太频繁，请 {retry} 秒后再试")
    now = time.time()
    last = user_last_request.get(user, 0)
    if now - last < 2:
        return fail("请求太频繁了，请稍后再试")
    user_last_request[user] = now
    _cleanup_user_last_request()

    with get_db() as conn:
        conn.execute("UPDATE batch_jobs SET status='running' WHERE id=?", (job_id,))

    if _looks_garbled(req.text):
        with get_db() as conn:
            conn.execute("UPDATE batch_items SET status='failed', error=? WHERE id=?", ("正文乱码", req.item_id))
            _recount_job(conn, job_id)
        return fail("本章正文疑似乱码，已跳过")

    try:
        data = _analyze_one(
            user,
            text=req.text,
            chapter_title=item["chapter_title"],
            source_url=item["source_url"],
            detail_level=job["detail_level"],
            spoiler_free=bool(job["spoiler_free"]),
            book_id=job["book_id"],
            chapter_index=item["chapter_index"],
        )
    except _InsufficientCredits as e:
        with get_db() as conn:
            conn.execute("UPDATE batch_items SET status='failed', error=? WHERE id=?", ("额度不足", req.item_id))
            conn.execute("UPDATE batch_jobs SET status='paused' WHERE id=?", (job_id,))
            _recount_job(conn, job_id)
        return fail(e.msg)
    except _AnalysisRejected as e:
        with get_db() as conn:
            conn.execute("UPDATE batch_items SET status='failed', error=? WHERE id=?", (e.msg, req.item_id))
            _recount_job(conn, job_id)
        return fail(e.msg)

    with get_db() as conn:
        conn.execute(
            "UPDATE batch_items SET status='done', text_hash=?, error='' WHERE id=?",
            (text_hash(req.text), req.item_id),
        )
        _recount_job(conn, job_id)

    return ok({"item_id": req.item_id, "result": data})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest tests/test_batch_submit.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_batch_submit.py
git commit -m "feat: add POST /api/analyze/batch/{job_id}/submit reusing pipeline"
```

---

### Task 5: `GET /api/analyze/batch/{job_id}` + `GET /api/analyze/batch`

**Files:**
- Modify: `main.py`（两个 GET 端点）
- Create: `tests/test_batch_get.py`

**Interfaces:**
- Consumes: `batch_jobs`/`batch_items`（Task 1）
- Produces: `GET /api/analyze/batch/{job_id}` 返回 `{job, items[]}`；`GET /api/analyze/batch` 返回 `{jobs[]}`

- [ ] **Step 1: 写失败测试**

```python
def test_get_job_returns_progress(client):
    resp = client.post("/api/analyze/batch/create", json={
        "book_title": "测试书",
        "chapter_list": [{"chapter_title": "第一章", "chapter_index": 1, "source_url": "https://biquge.example/1.html"}],
    })
    job_id = resp.json()["data"]["job_id"]
    g = client.get(f"/api/analyze/batch/{job_id}")
    assert g.status_code == 200
    data = g.json()["data"]
    assert data["job"]["id"] == job_id
    assert len(data["items"]) == 1
    assert data["items"][0]["status"] == "pending"


def test_list_jobs_only_returns_unfinished(client):
    client.post("/api/analyze/batch/create", json={
        "book_title": "测试书",
        "chapter_list": [{"chapter_title": "第一章", "chapter_index": 1, "source_url": "https://biquge.example/1.html"}],
    })
    g = client.get("/api/analyze/batch")
    assert g.status_code == 200
    assert len(g.json()["data"]["jobs"]) == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest tests/test_batch_get.py -v`
Expected: FAIL（端点不存在 404）

- [ ] **Step 3: 新增两个端点**

```python
@app.get("/api/analyze/batch/{job_id}")
def batch_get(job_id: int, user=Depends(get_user)):
    with get_db() as conn:
        job = conn.execute(
            "SELECT * FROM batch_jobs WHERE id=? AND username=?", (job_id, user)
        ).fetchone()
        if not job:
            return fail("任务不存在")
        items = conn.execute(
            "SELECT id, chapter_title, chapter_index, source_url, status, error FROM batch_items WHERE job_id=? ORDER BY id",
            (job_id,),
        ).fetchall()
    return ok({"job": dict(job), "items": [dict(i) for i in items]})


@app.get("/api/analyze/batch")
def batch_list(user=Depends(get_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM batch_jobs WHERE username=? AND status IN ('pending','running','paused') ORDER BY id DESC",
            (user,),
        ).fetchall()
    return ok({"jobs": [dict(r) for r in rows]})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest tests/test_batch_get.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_batch_get.py
git commit -m "feat: add batch progress + list endpoints"
```

---

### Task 6: 前端解析器纯函数模块 + vitest 测试基建

**Files:**
- Create: `JianLai_Helper/batch_parser.js`
- Modify: `JianLai_Helper/manifest.json`（content_scripts.js 数组加入 `batch_parser.js`，置于 `content.js` 之前）
- Create: `package.json`（项目根）
- Create: `vitest.config.js`（项目根）
- Create: `tests/batch_parser.test.js`

**Interfaces:**
- Produces: 全局 `JLBatchParser`，方法：`parseHtml(html)`、`parseCatalog(html, site) -> [{chapter_title, chapter_index, source_url}]`、`extractChapterText(html, site) -> string`、`extractIndex(title, href) -> int|null`、`cnToInt(s) -> int|null`、`looksLikeChapterHref(href) -> bool`、`cleanTitle(t) -> string`
- 后续 Task 7/8/9 依赖此模块。

- [ ] **Step 1: 写 package.json（根目录）**

```json
{
  "name": "novel-copilot-backend",
  "private": true,
  "type": "module",
  "scripts": {
    "test:js": "vitest run tests/batch_parser.test.js"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "jsdom": "^25.0.0"
  }
}
```

- [ ] **Step 2: 写 vitest.config.js（根目录）**

```javascript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
  },
});
```

- [ ] **Step 3: 写 JianLai_Helper/batch_parser.js**

```javascript
// 目录解析 + 章节正文提取（纯函数，浏览器与测试环境通用）
(function () {
  "use strict";

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function cleanTitle(t) {
    return (t || "").replace(/\s+/g, " ").trim();
  }

  function looksLikeChapterHref(href) {
    if (!href) return false;
    return /\/(\d{4,})(\.html?)?$/i.test(href) || /[?&](?:id|chapterId)=(\d{4,})/i.test(href);
  }

  function cnToInt(s) {
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var map = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
    var units = { "十": 10, "百": 100, "千": 1000, "万": 10000 };
    var total = 0, section = 0, num = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (map[ch] !== undefined) { num = map[ch]; }
      else if (units[ch] !== undefined) {
        var u = units[ch];
        if (u === 10000) { section = (section + num) * u; total += section; section = 0; num = 0; }
        else { section += (num || 1) * u; num = 0; }
      } else { return null; }
    }
    return total + section + num;
  }

  function extractIndex(title, href) {
    var m = title.match(/第\s*([0-9一二三四五六七八九十百千万零]+)\s*[章节卷回]/);
    if (m) return cnToInt(m[1]);
    var m2 = href.match(/[?&](?:id|chapterId)=(\d+)/i);
    if (m2) return parseInt(m2[1], 10);
    var m3 = href.match(/\/(\d{4,})\.html?/i);
    if (m3) return parseInt(m3[1], 10);
    return null;
  }

  function absoluteUrl(doc, href) {
    var base = doc.querySelector("base[href]");
    var baseHref = base ? base.getAttribute("href") : doc.baseURI;
    try { return new URL(href, baseHref || "http://x/").href; } catch (_) { return null; }
  }

  function parseCatalog(html, site) {
    var doc = parseHtml(html);
    var anchors = Array.from(doc.querySelectorAll("a[href]"));
    var seen = new Set();
    var out = [];
    anchors.forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href) return;
      var title = cleanTitle(a.textContent || a.getAttribute("title"));
      if (!title || title.length < 1 || title.length > 120) return;
      var abs = absoluteUrl(doc, href);
      if (!abs) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push({ chapter_title: title, chapter_index: extractIndex(title, href), source_url: abs });
    });
    return out;
  }

  function extractChapterText(html, site) {
    var doc = parseHtml(html);
    var selectors = [
      "#content", "#chaptercontent", "#ChapterContent", "#txt",
      ".read-content", ".main-text-wrap", ".chapter-content",
      ".content", ".article-content", ".post-content",
      ".txt", ".text", ".novel-content", ".book-content",
      "article", ".entry-content", "#article", "#text",
    ];
    var best = "";
    selectors.forEach(function (sel) {
      var c = doc.querySelector(sel);
      if (!c) return;
      var ps = c.querySelectorAll("p, div");
      var text = Array.from(ps).map(function (p) { return (p.textContent || "").trim(); }).filter(function (t) { return t.length > 5; }).join("\n");
      if (text.length > best.length) best = text;
    });
    if (best.length < 80) {
      var all = doc.querySelectorAll("p");
      best = Array.from(all).map(function (p) { return (p.textContent || "").trim(); }).filter(function (t) { return t.length > 8; }).join("\n");
    }
    return best;
  }

  globalThis.JLBatchParser = {
    parseHtml: parseHtml,
    parseCatalog: parseCatalog,
    extractChapterText: extractChapterText,
    extractIndex: extractIndex,
    cnToInt: cnToInt,
    cleanTitle: cleanTitle,
    looksLikeChapterHref: looksLikeChapterHref,
  };
})();
```

- [ ] **Step 4: 写 tests/batch_parser.test.js**

```javascript
import { describe, it, expect } from "vitest";
import "../JianLai_Helper/batch_parser.js";

const P = globalThis.JLBatchParser;

describe("cnToInt", () => {
  it("parses arabic and chinese numerals", () => {
    expect(P.cnToInt("12")).toBe(12);
    expect(P.cnToInt("一百二十三")).toBe(123);
    expect(P.cnToInt("六十五")).toBe(65);
  });
});

describe("extractIndex", () => {
  it("extracts from title", () => {
    expect(P.extractIndex("第65章 大结局", "/12345.html")).toBe(65);
    expect(P.extractIndex("第二部第二章 为君饮", "/x.html")).toBe(2);
  });
  it("falls back to href", () => {
    expect(P.extractIndex("某章", "/88888.html")).toBe(88888);
  });
});

describe("parseCatalog", () => {
  it("extracts unique chapter list", () => {
    const html = `
      <html><body>
        <a href="/book/1/101.html">第一章 开端</a>
        <a href="/book/1/102.html">第二章 转折</a>
        <a href="/book/1/101.html">第一章 开端</a>
      </body></html>`;
    const list = P.parseCatalog(html, "biquge");
    expect(list).toHaveLength(2);
    expect(list[0].chapter_index).toBe(101);
    expect(list[1].chapter_title).toBe("第二章 转折");
  });
});

describe("extractChapterText", () => {
  it("extracts from #content", () => {
    const html = `<html><body><div id="content"><p>第一段正文内容</p><p>第二段正文内容</p></div></body></html>`;
    const text = P.extractChapterText(html, "biquge");
    expect(text).toContain("第一段正文内容");
    expect(text).toContain("第二段正文内容");
  });
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm install && npm run test:js`
Expected: PASS

- [ ] **Step 6: 改 manifest.json，让 batch_parser.js 先于 content.js 加载**

```json
      "js": ["vis-network.min.js", "batch_parser.js", "content.js"],
```

- [ ] **Step 7: Commit**

```bash
git add JianLai_Helper/batch_parser.js JianLai_Helper/manifest.json package.json vitest.config.js tests/batch_parser.test.js package-lock.json
git commit -m "feat: add batch parser module + vitest harness"
```

---

### Task 7: 目录页识别 + "批量分析"浮动按钮 + 建任务接线

**Files:**
- Modify: `JianLai_Helper/content.js`（IIFE 内新增函数）

**Interfaces:**
- Consumes: `JLBatchParser`（Task 6）、`getAPI`/`getToken`/`fetchWithRetry`（content.js 现有）、`getBookTitle`/`getAuthor`
- Produces: `detectCatalogPage() -> bool`、`showBatchButton()`、`startBatchJob(list) -> Promise`、`runBatchFromCatalog()`

- [ ] **Step 1: 新增目录页识别 + 按钮注入函数**

```javascript
  function detectCatalogPage() {
    var links = document.querySelectorAll("a[href]");
    var chapterLike = 0;
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href");
      if (globalThis.JLBatchParser && globalThis.JLBatchParser.looksLikeChapterHref(href)) chapterLike++;
      if (chapterLike >= 5) return true;
    }
    return false;
  }

  function showBatchButton() {
    if (document.getElementById("jl-batch-btn")) return;
    var btn = document.createElement("button");
    btn.id = "jl-batch-btn";
    btn.textContent = "📚 批量分析";
    btn.style.cssText =
      "position:fixed;right:20px;bottom:120px;z-index:2147483646;padding:10px 16px;" +
      "background:#E65100;color:#fff;border:none;border-radius:24px;font-size:14px;cursor:pointer;" +
      "box-shadow:0 4px 16px rgba(230,81,0,.35);";
    btn.addEventListener("click", function () { runBatchFromCatalog(); });
    document.body.appendChild(btn);
  }

  async function runBatchFromCatalog() {
    var btn = document.getElementById("jl-batch-btn");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ 解析中…"; }
    var html = document.documentElement.outerHTML;
    // site 形参暂未参与解析（batch_parser.parseCatalog 的 site 留待站点特化）；Task 8 才引入 detectSite
    var list = globalThis.JLBatchParser.parseCatalog(html, "biquge");
    if (!list.length) {
      alert("未在目录页解析到章节列表");
      if (btn) { btn.disabled = false; btn.textContent = "📚 批量分析"; }
      return;
    }
    var job = await startBatchJob(list);
    if (btn) { btn.disabled = false; btn.textContent = "📚 批量分析"; }
    // 抓取循环由 Task 8 接入：if (job) runBatchJob(job);
  }

  async function startBatchJob(list) {
    var API = await getAPI();
    var token = await getToken();
    if (!token) { alert("请先登录"); return null; }
    var resp = await fetchWithRetry(API + "/api/analyze/batch/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({
        book_title: getBookTitle(),
        author: getAuthor(),
        chapter_list: list,
        detail_level: localStorage.getItem("JL_Detail_Level") || "standard",
        spoiler_free: true,
      }),
    }, 2);
    var data = await resp.json();
    if (!data.success) { alert(data.error || "创建任务失败"); return null; }
    var d = data.data;
    alert("任务已创建：共 " + d.total + " 章，需分析 " + d.pending + " 章，已跳过 " + d.skipped + " 章");
    return d;
  }
```

- [ ] **Step 2: 在 content.js 初始化处挂接检测**

在现有浮动按钮初始化逻辑（创建 `jl-floating-btn` 的位置）之后追加：

```javascript
    if (detectCatalogPage()) { showBatchButton(); }
```

（注：现有浮动按钮 `jl-floating-btn` 仅在 `getChapterText().length >= 80` 时显示，即只出现在章节页。目录页走本分支。）

- [ ] **Step 3: 手工验证（无自动化测试——依赖浏览器）**

在笔趣阁目录页打开，确认右下角出现"📚 批量分析"按钮；点击后 alert 显示解析到的章节数与 pending 数。

- [ ] **Step 4: Commit**

```bash
git add JianLai_Helper/content.js
git commit -m "feat: catalog detection + batch button + create-job wiring"
```

---

### Task 8: 批量抓取循环 + 进度面板 + 暂停/续跑

**Files:**
- Modify: `JianLai_Helper/content.js`（`runBatchJob` + 进度面板 + 暂停标志）

**Interfaces:**
- Consumes: `JLBatchParser.extractChapterText`、`decodeFanqieText`、`fetchWithRetry`、`getAPI`/`getToken`、`startBatchJob` 返回的 `{job_id, pending}`
- Produces: `runBatchJob(jobData)`、`showBatchPanel()`、`updateBatchPanel(done, total, text)`、`detectSite()`、`fetchChapterText(source_url) -> Promise<string>`、`window.__jlBatchPaused`
- 注：`fetchChapterText` 基础版（笔趣阁/番茄）在本任务定义；Task 9 只在其上追加起点 iframe 分支。

- [ ] **Step 1: 新增 detectSite + fetchChapterText（基础版）+ 进度面板 + 抓取循环**

```javascript
  function detectSite() {
    var h = location.hostname;
    if (/fanqienovel\.com/i.test(h)) return "fanqie";
    if (/qidian\.com/i.test(h)) return "qidian";
    return "biquge";
  }

  async function fetchChapterText(source_url) {
    var site = detectSite();
    var r = await fetchWithRetry(source_url, { credentials: "include" }, 2);
    var html = await r.text();
    var text = globalThis.JLBatchParser.extractChapterText(html, site);
    if (site === "fanqie") text = decodeFanqieText(text);
    return text;
  }

  var __jlBatchPaused = false;

  function showBatchPanel() {
    if (document.getElementById("jl-batch-panel")) return;
    var panel = document.createElement("div");
    panel.id = "jl-batch-panel";
    panel.style.cssText =
      "position:fixed;right:20px;bottom:170px;z-index:2147483646;width:260px;background:#fffef9;" +
      "border-radius:12px;padding:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);font-size:13px;color:#333;";
    panel.innerHTML =
      '<div style="font-weight:600;margin-bottom:8px">📚 批量分析</div>' +
      '<div id="jl-batch-status">准备中…</div>' +
      '<div id="jl-batch-bar" style="height:8px;background:#eee;border-radius:4px;margin:10px 0;overflow:hidden">' +
      '<div id="jl-batch-fill" style="height:100%;width:0%;background:#E65100"></div></div>' +
      '<button id="jl-batch-pause" style="margin-right:8px">暂停</button>' +
      '<button id="jl-batch-close">关闭</button>';
    document.body.appendChild(panel);
    document.getElementById("jl-batch-pause").addEventListener("click", function () {
      __jlBatchPaused = true;
      document.getElementById("jl-batch-status").textContent = "已暂停";
    });
    document.getElementById("jl-batch-close").addEventListener("click", function () {
      panel.remove();
    });
  }

  function updateBatchPanel(done, total, text) {
    var status = document.getElementById("jl-batch-status");
    var fill = document.getElementById("jl-batch-fill");
    if (status) status.textContent = text || (done + " / " + total);
    if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
  }

  async function runBatchJob(jobData) {
    showBatchPanel();
    var API = await getAPI();
    var token = await getToken();
    var jobResp = await fetchWithRetry(API + "/api/analyze/batch/" + jobData.job_id, {
      headers: { "Authorization": "Bearer " + token },
    }, 2);
    var jobBody = await jobResp.json();
    var items = (jobBody.data && jobBody.data.items) || [];
    var pending = items.filter(function (i) { return i.status === "pending" || i.status === "failed"; });
    var done = jobData.total - pending.length;
    updateBatchPanel(done, jobData.total);

    for (var item of pending) {
      if (__jlBatchPaused) { updateBatchPanel(done, jobData.total, "已暂停（可点击「批量分析」续跑）"); return; }
      var text = "";
      try {
        text = await fetchChapterText(item.source_url);
        if (!text || text.length < 80) throw new Error("正文抓取为空");
      } catch (e) {
        updateBatchPanel(done, jobData.total, "抓取失败：" + item.chapter_title);
        continue;
      }
      var submitResp = await fetchWithRetry(API + "/api/analyze/batch/" + jobData.job_id + "/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ item_id: item.id, text: text }),
      }, 2);
      var submitBody = await submitResp.json();
      if (!submitBody.success) {
        if (/额度不足/.test(submitBody.error || "")) {
          updateBatchPanel(done, jobData.total, "额度不足，任务已暂停，攒够后点击「批量分析」续跑");
          return;
        }
        if (/请求太频繁/.test(submitBody.error || "")) {
          await new Promise(function (res) { setTimeout(res, 3000); });
          submitResp = await fetchWithRetry(API + "/api/analyze/batch/" + jobData.job_id + "/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
            body: JSON.stringify({ item_id: item.id, text: text }),
          }, 2);
          submitBody = await submitResp.json();
        }
      }
      if (submitBody.success) { done++; }
      updateBatchPanel(done, jobData.total);
    }
    __jlBatchPaused = false;
    updateBatchPanel(done, jobData.total, "✅ 完成：" + done + " 章");
  }
```

- [ ] **Step 2: 接入 runBatchJob + 支持续跑**

先把 Task 7 留下的 `// 抓取循环由 Task 8 接入：if (job) runBatchJob(job);` 这行替换为真实调用：

```javascript
    if (job) runBatchJob(job);
```

再在 `runBatchFromCatalog` 的 `parseCatalog` 之后、`startBatchJob` 之前插入续跑查询：

```javascript
    var API = await getAPI();
    var token = await getToken();
    var listResp = await fetchWithRetry(API + "/api/analyze/batch", {
      headers: { "Authorization": "Bearer " + token },
    }, 2);
    var listBody = await listResp.json();
    var unfinished = (listBody.data && listBody.data.jobs) || [];
    if (unfinished.length) {
      if (confirm("检测到 " + unfinished.length + " 个未完成任务，是否续跑最近一个？")) {
        runBatchJob(unfinished[0]);
        if (btn) { btn.disabled = false; btn.textContent = "📚 批量分析"; }
        return;
      }
    }
```

- [ ] **Step 3: 手工验证**

笔趣阁目录页 → 点批量分析 → 观察面板进度递增、失败章节跳过、额度不足自动暂停、关闭面板后重开可续跑。

- [ ] **Step 4: Commit**

```bash
git add JianLai_Helper/content.js
git commit -m "feat: batch runner loop + progress panel + resume"
```

---

### Task 9: 番茄 + 起点适配器（含起点 iframe 兜底）

**Files:**
- Modify: `JianLai_Helper/content.js`（`detectSite` + `fetchChapterText` 兜底）
- Modify: `JianLai_Helper/manifest.json`（content_scripts 增加 `"all_frames": true`）

**Interfaces:**
- Consumes: `JLBatchParser.extractChapterText`、`decodeFanqieText`、`fetchChapterText`/`detectSite`（Task 8）
- Produces: `fetchChapterText(source_url) -> Promise<string>`（扩展为三分支：笔趣阁/番茄走 fetch，起点走 iframe 兜底）、`fetchChapterViaIframe(source_url) -> Promise<string>`

**⚠️ 风险标注**：起点 SPA 抓取是最硬的一块，反爬最强。`fetch` 大概率拿到空壳。本任务的 iframe 兜底是"尽力而为"——若实测仍失败，按 spec 降级为"该站提示手动复制正文"，不影响笔趣阁/番茄。

- [ ] **Step 1: 扩展 fetchChapterText 增加起点 iframe 分支 + 新增 fetchChapterViaIframe**

```javascript
  async function fetchChapterText(source_url) {
    var site = detectSite();
    if (site === "qidian") {
      return fetchChapterViaIframe(source_url);
    }
    var r = await fetchWithRetry(source_url, { credentials: "include" }, 2);
    var html = await r.text();
    var text = globalThis.JLBatchParser.extractChapterText(html, site);
    if (site === "fanqie") text = decodeFanqieText(text);
    return text;
  }

  function fetchChapterViaIframe(source_url) {
    return new Promise(function (resolve) {
      var iframe = document.createElement("iframe");
      iframe.style.cssText = "position:absolute;left:-9999px;width:900px;height:900px;";
      iframe.src = source_url;
      document.body.appendChild(iframe);
      var finished = false;
      function done(text) {
        if (finished) return;
        finished = true;
        try { iframe.remove(); } catch (_) {}
        resolve(text || "");
      }
      iframe.addEventListener("load", function () {
        try {
          var doc = iframe.contentDocument;
          var text = doc ? globalThis.JLBatchParser.extractChapterText(doc.documentElement.outerHTML, "qidian") : "";
          done(text);
        } catch (_) { done(""); }
      });
      setTimeout(function () { done(""); }, 15000);
    });
  }
```

- [ ] **Step 2: 改 manifest.json 加 all_frames**

```json
      "js": ["vis-network.min.js", "batch_parser.js", "content.js"],
      "run_at": "document_idle",
      "all_frames": true
```

- [ ] **Step 3: 手工验证（番茄 + 笔趣阁真实目录页）**

- 番茄目录页 → 批量分析 → 确认 `decodeFanqieText` 解出正常中文、后端不再报乱码。
- 笔趣阁目录页 → 批量分析 → 确认 fetch+DOMParser 全流程跑通。
- 起点目录页 → 批量分析 → 记录 fetch/iframe 是否拿到正文；若都失败，确认面板提示"抓取失败"并跳过、不拖垮整批。

- [ ] **Step 4: Commit**

```bash
git add JianLai_Helper/content.js JianLai_Helper/manifest.json
git commit -m "feat: fanqie/qidian adapters + qidian iframe fallback"
```

---

## 后续（不在本计划）

- E2E：playwright 自动化跑通"笔趣阁目录页 → 建任务 → 抓 3 章 → 进度 3/3"（依赖浏览器环境，作为后续验证）。
- userscript 三份副本（`userscript/*.user.js`）同步批量功能（独立代码库，需单独一轮）。
