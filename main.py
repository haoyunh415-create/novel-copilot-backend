import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from typing import Optional

import jwt
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from services.ai_service import analyze_text
from services.auth_service import hash_password as bcrypt_hash_password
from services.auth_service import verify_password as bcrypt_verify_password

app = FastAPI(title="Novel Copilot Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SECRET_KEY = os.getenv("SECRET_KEY", "dev_only_change_me")
ACCESS_TOKEN_TTL_SECONDS = int(os.getenv("ACCESS_TOKEN_TTL_SECONDS", "86400"))
MOCK_PAYMENTS_ENABLED = os.getenv("MOCK_PAYMENTS_ENABLED", "false").lower() == "true"

user_last_request = {}

# 问答缓存：{(username, question_hash, memory_hash): answer} — 同样问题+同样记忆不重复调 AI
qa_cache = {}
QA_CACHE_MAX = 200


@contextmanager
def get_db():
    conn = sqlite3.connect("users.db", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                credits INTEGER NOT NULL DEFAULT 3,
                created_at INTEGER NOT NULL DEFAULT 0
            )
            """
        )

        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(users)").fetchall()
        }
        if "created_at" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS books (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                title TEXT NOT NULL,
                author TEXT DEFAULT '',
                source_url_pattern TEXT DEFAULT '',
                chapter_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(username, title)
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS analyses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                book_id INTEGER DEFAULT NULL REFERENCES books(id),
                chapter_title TEXT NOT NULL,
                chapter_index INTEGER DEFAULT NULL,
                source_url TEXT,
                text_hash TEXT NOT NULL,
                detail_level TEXT NOT NULL,
                spoiler_free INTEGER NOT NULL DEFAULT 1,
                result_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(username, text_hash, detail_level, spoiler_free)
            )
            """
        )

        # 为旧数据库补列（兼容已有 installations）
        analyses_cols = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(analyses)").fetchall()
        }
        if "book_id" not in analyses_cols:
            conn.execute("ALTER TABLE analyses ADD COLUMN book_id INTEGER DEFAULT NULL REFERENCES books(id)")
        if "chapter_index" not in analyses_cols:
            conn.execute("ALTER TABLE analyses ADD COLUMN chapter_index INTEGER DEFAULT NULL")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                plan TEXT NOT NULL,
                amount REAL NOT NULL,
                credits_added INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL DEFAULT 0,
                fulfilled_at INTEGER DEFAULT NULL
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS usage_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                action TEXT NOT NULL,
                detail TEXT DEFAULT '',
                credits_delta INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0
            )
            """
        )


init_db()


class UserRequest(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=6, max_length=128)


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=20, max_length=30000)
    chapter_title: str = Field(min_length=1, max_length=120)
    source_url: Optional[str] = Field(default=None, max_length=1000)
    detail_level: str = Field(default="standard", pattern="^(brief|standard|detailed)$")
    spoiler_free: bool = True
    book_title: Optional[str] = Field(default=None, max_length=200)
    author: Optional[str] = Field(default=None, max_length=200)
    chapter_index: Optional[int] = Field(default=None)


class BuyRequest(BaseModel):
    plan: str


class AskRequest(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    source_url: Optional[str] = Field(default=None, max_length=1000)
    spoiler_free: bool = True
    book_id: Optional[int] = Field(default=None)
    book_title: Optional[str] = Field(default=None, max_length=200)


class SuggestRequest(BaseModel):
    book_id: int


class ReviewRequest(BaseModel):
    book_id: int
    chapter_count: int = Field(default=10, ge=3, le=50)


def ok(data=None, msg="ok"):
    return {"success": True, "msg": msg, "data": data}


def fail(msg="error"):
    return {"success": False, "error": msg}


def legacy_sha256(password: str):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def verify_user_password(plain_password: str, stored_password: str):
    if stored_password.startswith("$2"):
        return bcrypt_verify_password(plain_password, stored_password)
    return legacy_sha256(plain_password) == stored_password


def create_token(username: str):
    return jwt.encode(
        {"sub": username, "exp": int(time.time()) + ACCESS_TOKEN_TTL_SECONDS},
        SECRET_KEY,
        algorithm="HS256",
    )


def text_hash(text: str):
    normalized = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def verify_token(token: str):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None


def get_user(req: Request):
    auth = req.headers.get("Authorization", "")
    scheme, _, token = auth.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="请先登录")

    username = verify_token(token)
    if not username:
        raise HTTPException(status_code=401, detail="登录已过期")

    return username


@app.get("/api/health")
def health():
    return ok({"status": "ok"})


# ── 简单的访问追踪（供 Landing Page 使用） ──
_landing_visits = []


@app.post("/api/track")
async def track_visit(req: Request):
    """记录 Landing Page 访问"""
    try:
        body = await req.json()
    except Exception:
        body = {}
    _landing_visits.append({
        "page": body.get("page", "unknown"),
        "referrer": body.get("ref", "direct"),
        "ip": req.client.host if req.client else "unknown",
        "ts": body.get("ts", 0),
    })
    # 只保留最近 2000 条
    if len(_landing_visits) > 2000:
        del _landing_visits[:-1000]
    return ok({"tracked": True})


@app.post("/api/register")
def register(req: UserRequest):
    username = req.username.strip()

    if not username:
        return fail("用户名不能为空")

    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO users (username, password, credits, created_at) VALUES (?, ?, 3, ?)",
                (username, bcrypt_hash_password(req.password), int(time.time())),
            )
        return ok(msg="注册成功")
    except sqlite3.IntegrityError:
        return fail("用户名已存在")


@app.post("/api/login")
def login(req: UserRequest):
    username = req.username.strip()

    with get_db() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE username=?",
            (username,),
        ).fetchone()

        if not user or not verify_user_password(req.password, user["password"]):
            return fail("用户名或密码错误")

        if not user["password"].startswith("$2"):
            conn.execute(
                "UPDATE users SET password=? WHERE username=?",
                (bcrypt_hash_password(req.password), username),
            )

    return ok({"token": create_token(username), "credits": user["credits"]})


@app.get("/api/me")
def me(user=Depends(get_user)):
    with get_db() as conn:
        row = conn.execute(
            "SELECT credits FROM users WHERE username=?",
            (user,),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=401, detail="用户不存在")

    return ok({"credits": row["credits"]})


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest, user=Depends(get_user)):
    now = time.time()
    last = user_last_request.get(user, 0)
    if now - last < 2:
        return fail("请求太频繁了，请稍后再试")
    user_last_request[user] = now

    content_hash = text_hash(req.text)
    spoiler_free = 1 if req.spoiler_free else 0

    # 解析或创建书籍
    book_id = None
    with get_db() as conn:
        # 先尝试用书名匹配
        if req.book_title and req.book_title.strip():
            book = conn.execute(
                "SELECT id FROM books WHERE username=? AND title=?",
                (user, req.book_title.strip()),
            ).fetchone()
            if book:
                book_id = book["id"]
            else:
                cur = conn.execute(
                    "INSERT INTO books (username, title, author, source_url_pattern, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user, req.book_title.strip(), req.author or "", req.source_url or "", int(time.time())),
                )
                book_id = cur.lastrowid

        # 书名提取不到？用 URL 匹配
        if not book_id and req.source_url:
            # 从 URL 提取书的基础路径
            m = re.match(r"(https?://[^/]+(/[^/]+/[^/]+/)?)", req.source_url)
            url_prefix = m.group(1) if m else req.source_url[:60]
            book = conn.execute(
                "SELECT id FROM books WHERE username=? AND source_url_pattern=?",
                (user, url_prefix),
            ).fetchone()
            if book:
                book_id = book["id"]
            else:
                # 新建书，用章节标题当书名
                fallback_title = req.chapter_title or url_prefix
                cur = conn.execute(
                    "INSERT INTO books (username, title, author, source_url_pattern, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user, fallback_title, req.author or "", url_prefix, int(time.time())),
                )
                book_id = cur.lastrowid

    # 检查缓存
    with get_db() as conn:
        cached = conn.execute(
            """
            SELECT result_json FROM analyses
            WHERE username=? AND text_hash=? AND detail_level=? AND spoiler_free=?
            """,
            (user, content_hash, req.detail_level, spoiler_free),
        ).fetchone()

    if cached:
        return ok({"result": json.loads(cached["result_json"]), "cached": True})

    # 扣额度
    with get_db() as conn:
        row = conn.execute(
            "SELECT credits FROM users WHERE username=?",
            (user,),
        ).fetchone()

        if not row or row["credits"] <= 0:
            return fail("额度不足，请购买后继续使用")

        conn.execute(
            "UPDATE users SET credits = credits - 1 WHERE username=? AND credits > 0",
            (user,),
        )
        log_usage(conn, user, "analyze", f"分析章节: {req.chapter_title}", -1)

    # 调用 AI 分析
    try:
        result = analyze_text(
            req.text,
            req.chapter_title,
            detail_level=req.detail_level,
            spoiler_free=req.spoiler_free,
        )
    except Exception as exc:
        with get_db() as conn:
            conn.execute(
                "UPDATE users SET credits = credits + 1 WHERE username=?",
                (user,),
            )
        return fail(f"AI 分析失败：{exc}")

    # 保存分析结果
    with get_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO analyses (
                username, book_id, chapter_title, chapter_index, source_url, text_hash,
                detail_level, spoiler_free, result_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user,
                book_id,
                req.chapter_title,
                req.chapter_index,
                req.source_url,
                content_hash,
                req.detail_level,
                spoiler_free,
                json.dumps(result, ensure_ascii=False),
                int(time.time()),
            ),
        )
        # 更新书的章节计数
        if book_id:
            conn.execute(
                "UPDATE books SET chapter_count = (SELECT COUNT(*) FROM analyses WHERE book_id=?) WHERE id=?",
                (book_id, book_id),
            )

    return ok({"result": result, "cached": False, "book_id": book_id})


def _find_book(conn, user: str, book_title: str = None, book_id: int = None, source_url: str = None):
    """统一的书匹配逻辑：book_id > book_title 模糊 > URL 前缀 > 返回 None"""
    if book_id:
        book = conn.execute(
            "SELECT id, title FROM books WHERE id=? AND username=?",
            (book_id, user),
        ).fetchone()
        if book:
            return dict(book)

    if book_title and book_title.strip():
        title = book_title.strip()
        # 精确匹配
        book = conn.execute(
            "SELECT id, title FROM books WHERE username=? AND title=?",
            (user, title),
        ).fetchone()
        if not book:
            # 模糊匹配（书名包含关系）
            book = conn.execute(
                "SELECT id, title FROM books WHERE username=? AND (title LIKE ? OR ? LIKE '%' || title || '%')",
                (user, f"%{title}%", title),
            ).fetchone()
        if book:
            return dict(book)
        # 传了书名但完全匹配不到 → 返回特殊标记
        return None

    if source_url:
        m = re.match(r"(https?://[^/]+(/[^/]+/[^/]+/)?)", source_url)
        url_prefix = m.group(1) if m else source_url[:60]
        book = conn.execute(
            "SELECT id, title FROM books WHERE username=? AND source_url_pattern=?",
            (user, url_prefix),
        ).fetchone()
        if book:
            return dict(book)

    return None


def _load_memories(conn, user: str, book_id: int, limit: int = 30):
    """加载书的分析记忆，返回 (memories, chapter_range)"""
    rows = conn.execute(
        """
        SELECT chapter_title, chapter_index, result_json, created_at
        FROM analyses
        WHERE username=? AND book_id=?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (user, book_id, limit),
    ).fetchall()

    if not rows:
        return [], ""

    memories = []
    for row in reversed(rows):
        try:
            result = json.loads(row["result_json"])
        except json.JSONDecodeError:
            continue
        memories.append({
            "chapter_title": row["chapter_title"],
            "summary": result.get("summary", ""),
            "characters": result.get("characters", []),
            "foreshadowing": result.get("foreshadowing", []),
            "terms": result.get("terms", []),
        })

    # 生成章节范围描述
    indices = [row["chapter_index"] for row in rows if row["chapter_index"] is not None]
    if indices:
        chapter_range = f"第{min(indices)}-{max(indices)}章" if min(indices) != max(indices) else f"第{min(indices)}章"
    else:
        chapter_range = f"{len(rows)}个章节"

    return memories, chapter_range


@app.post("/api/ask")
def ask(req: AskRequest, user=Depends(get_user)):
    from services.ai_service import answer_from_memory

    with get_db() as conn:
        book = _find_book(conn, user, req.book_title, req.book_id, req.source_url)

        if book is None and req.book_title and req.book_title.strip():
            # 传了书名但匹配不到 → 明确告知，不静默回退
            return fail(f"还没有《{req.book_title.strip()}》的分析记录，请先在当前页面分析至少一章后再提问")

        if book is None:
            # 没有任何线索 → 兜底回退，但要在返回中标注
            last_book = conn.execute(
                "SELECT id, title FROM books WHERE id IN ("
                "SELECT DISTINCT book_id FROM analyses WHERE username=? AND book_id IS NOT NULL"
                ") ORDER BY id DESC LIMIT 1",
                (user,),
            ).fetchone()
            if last_book:
                book = dict(last_book)
                memories, chapter_range = _load_memories(conn, user, book["id"])
                if not memories:
                    return fail("还没有可用的章节记忆，请先分析几章")
                # 兜底回退：告知用户当前用的是哪本书
                return _do_ask(user, req.question, req.spoiler_free, memories, book, chapter_range,
                               fallback_warning=f"未识别到当前页面所属书籍，已回退到最近分析的《{book['title']}》")
            return fail("还没有可用的章节记忆，请先分析几章")

        memories, chapter_range = _load_memories(conn, user, book["id"])

    if not memories:
        return fail(f"《{book['title']}》还没有分析过的章节，请先分析至少一章")

    return _do_ask(user, req.question, req.spoiler_free, memories, book, chapter_range)


def _do_ask(user: str, question: str, spoiler_free: bool, memories: list,
            book: dict, chapter_range: str, fallback_warning: str = None):
    """执行实际的 AI 问答调用"""
    from services.ai_service import answer_from_memory

    # 问答缓存
    mem_json = json.dumps(memories, ensure_ascii=False, sort_keys=True)
    cache_key = (user, hashlib.sha256(question.encode()).hexdigest()[:16],
                 hashlib.sha256(mem_json.encode()).hexdigest()[:16])

    if cache_key in qa_cache:
        result = {
            "answer": qa_cache[cache_key],
            "memory_count": len(memories),
            "book_title": book["title"],
            "chapter_range": chapter_range,
            "cached": True,
        }
        if fallback_warning:
            result["warning"] = fallback_warning
        return ok(result)

    try:
        answer = answer_from_memory(
            question=question,
            memories=memories,
            spoiler_free=spoiler_free,
        )
    except Exception as exc:
        return fail(f"问答失败：{exc}")

    # 写入缓存
    if len(qa_cache) >= QA_CACHE_MAX:
        for k in list(qa_cache.keys())[:QA_CACHE_MAX // 2]:
            qa_cache.pop(k, None)
    qa_cache[cache_key] = answer

    result = {
        "answer": answer,
        "memory_count": len(memories),
        "book_title": book["title"],
        "chapter_range": chapter_range,
        "cached": False,
    }
    if fallback_warning:
        result["warning"] = fallback_warning
    return ok(result)


@app.post("/api/ask/suggest")
def suggest_questions_endpoint(req: SuggestRequest, user=Depends(get_user)):
    """基于最近章节分析生成推荐问题"""
    from services.ai_service import suggest_questions

    with get_db() as conn:
        book = conn.execute(
            "SELECT id, title FROM books WHERE id=? AND username=?",
            (req.book_id, user),
        ).fetchone()
        if not book:
            return fail("书籍不存在")

        rows = conn.execute(
            """
            SELECT chapter_title, result_json, created_at
            FROM analyses
            WHERE book_id=?
            ORDER BY created_at DESC
            LIMIT 5
            """,
            (req.book_id,),
        ).fetchall()

    if not rows:
        return fail("该书还没有分析过的章节")

    recent = []
    for row in rows:
        try:
            result = json.loads(row["result_json"])
        except json.JSONDecodeError:
            continue
        recent.append({
            "chapter_title": row["chapter_title"],
            "summary": result.get("summary", ""),
            "characters": result.get("characters", []),
            "foreshadowing": result.get("foreshadowing", []),
            "terms": result.get("terms", []),
        })

    if not recent:
        return fail("章节记忆解析失败")

    try:
        questions = suggest_questions(
            book_title=book["title"],
            recent_analyses=recent,
        )
    except Exception as exc:
        return fail(f"推荐问题生成失败：{exc}")

    return ok({"book_title": book["title"], "questions": questions})


@app.get("/api/books/match")
def match_book(url: str = None, title: str = None, user=Depends(get_user)):
    """根据 URL 或书名匹配已有书籍"""
    with get_db() as conn:
        if title and title.strip():
            book = conn.execute(
                "SELECT id, title, author, chapter_count FROM books WHERE username=? AND title=?",
                (user, title.strip()),
            ).fetchone()
            if book:
                return ok({"matched": True, "book": dict(book), "method": "title_exact"})

            book = conn.execute(
                "SELECT id, title, author, chapter_count FROM books WHERE username=? AND (title LIKE ? OR ? LIKE '%' || title || '%')",
                (user, f"%{title.strip()}%", title.strip()),
            ).fetchone()
            if book:
                return ok({"matched": True, "book": dict(book), "method": "title_fuzzy"})

        if url:
            m = re.match(r"(https?://[^/]+(/[^/]+/[^/]+/)?)", url)
            url_prefix = m.group(1) if m else url[:60]
            book = conn.execute(
                "SELECT id, title, author, chapter_count FROM books WHERE username=? AND source_url_pattern=?",
                (user, url_prefix),
            ).fetchone()
            if book:
                return ok({"matched": True, "book": dict(book), "method": "url_prefix"})

    return ok({"matched": False, "book": None})


@app.get("/api/books")
def list_books(user=Depends(get_user)):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT b.id, b.title, b.author, b.chapter_count, b.created_at,
                   (SELECT COUNT(*) FROM analyses WHERE book_id=b.id) as analyzed_count,
                   (SELECT MAX(created_at) FROM analyses WHERE book_id=b.id) as last_analyzed_at
            FROM books b
            WHERE b.username=?
            ORDER BY last_analyzed_at DESC
            """,
            (user,),
        ).fetchall()

    books = [dict(row) for row in rows]
    return ok({"books": books})


@app.get("/api/books/{book_id}/analyses")
def list_book_analyses(book_id: int, user=Depends(get_user)):
    with get_db() as conn:
        # 验证权限
        book = conn.execute(
            "SELECT id, title, author, chapter_count FROM books WHERE id=? AND username=?",
            (book_id, user),
        ).fetchone()
        if not book:
            return fail("书籍不存在")

        rows = conn.execute(
            """
            SELECT id, chapter_title, chapter_index, source_url, detail_level,
                   spoiler_free, created_at
            FROM analyses
            WHERE book_id=?
            ORDER BY COALESCE(chapter_index, 999999), created_at ASC
            """,
            (book_id,),
        ).fetchall()

    analyses = [dict(row) for row in rows]
    return ok({"book": dict(book), "analyses": analyses})


@app.post("/api/review")
def review_recent(req: ReviewRequest, user=Depends(get_user)):
    from services.ai_service import review_recent_chapters

    with get_db() as conn:
        # 验证权限
        book = conn.execute(
            "SELECT id, title FROM books WHERE id=? AND username=?",
            (req.book_id, user),
        ).fetchone()
        if not book:
            return fail("书籍不存在")

        rows = conn.execute(
            """
            SELECT chapter_title, chapter_index, result_json, created_at
            FROM analyses
            WHERE book_id=?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (req.book_id, req.chapter_count),
        ).fetchall()

    if not rows:
        return fail("该书还没有分析过的章节")

    memories = []
    for row in reversed(rows):
        try:
            result = json.loads(row["result_json"])
        except json.JSONDecodeError:
            continue
        memories.append(
            {
                "chapter_title": row["chapter_title"],
                "chapter_index": row["chapter_index"],
                "summary": result.get("summary", ""),
                "characters": result.get("characters", []),
                "foreshadowing": result.get("foreshadowing", []),
                "terms": result.get("terms", []),
            }
        )

    if not memories:
        return fail("章节记忆解析失败")

    try:
        review = review_recent_chapters(
            book_title=book["title"],
            memories=memories,
        )
    except Exception as exc:
        return fail(f"回顾生成失败：{exc}")

    return ok({"book_title": book["title"], "review": review, "chapters_covered": len(memories)})


@app.get("/api/books/{book_id}/characters")
def list_book_characters(book_id: int, user=Depends(get_user)):
    """跨章合并人物列表"""
    with get_db() as conn:
        book = conn.execute(
            "SELECT id, title FROM books WHERE id=? AND username=?",
            (book_id, user),
        ).fetchone()
        if not book:
            return fail("书籍不存在")

        rows = conn.execute(
            """
            SELECT chapter_title, chapter_index, result_json
            FROM analyses
            WHERE book_id=?
            ORDER BY COALESCE(chapter_index, 999999), created_at ASC
            """,
            (book_id,),
        ).fetchall()

    # 跨章合并人物
    characters_map = {}  # name -> merged character info
    for row in rows:
        try:
            result = json.loads(row["result_json"])
        except json.JSONDecodeError:
            continue
        chars = result.get("characters", [])
        for char in chars:
            name = (char.get("name") or char.get("label") or "").strip()
            if not name:
                continue
            if name not in characters_map:
                characters_map[name] = {
                    "name": name,
                    "first_seen": {"chapter_title": row["chapter_title"], "chapter_index": row["chapter_index"]},
                    "last_seen": {"chapter_title": row["chapter_title"], "chapter_index": row["chapter_index"]},
                    "appearances": [],
                    "notes": [],
                    "relationships": [],
                }
            entry = characters_map[name]
            entry["last_seen"] = {"chapter_title": row["chapter_title"], "chapter_index": row["chapter_index"]}
            entry["appearances"].append(row["chapter_title"])
            if char.get("note") or char.get("role"):
                entry["notes"].append(f"【{row['chapter_title']}】{char.get('note') or char.get('role')}")
            if char.get("relationship_hints"):
                entry["relationships"].append(char["relationship_hints"])

    # 按出现次数降序排列
    character_list = sorted(characters_map.values(), key=lambda c: len(c["appearances"]), reverse=True)
    return ok({"book_title": book["title"], "characters": character_list})


@app.get("/api/books/{book_id}/foreshadowing")
def list_book_foreshadowing(book_id: int, user=Depends(get_user)):
    """跨章伏笔列表"""
    with get_db() as conn:
        book = conn.execute(
            "SELECT id, title FROM books WHERE id=? AND username=?",
            (book_id, user),
        ).fetchone()
        if not book:
            return fail("书籍不存在")

        rows = conn.execute(
            """
            SELECT chapter_title, chapter_index, result_json, created_at
            FROM analyses
            WHERE book_id=?
            ORDER BY COALESCE(chapter_index, 999999), created_at ASC
            """,
            (book_id,),
        ).fetchall()

    clues = []
    for row in rows:
        try:
            result = json.loads(row["result_json"])
        except json.JSONDecodeError:
            continue
        foreshadowing = result.get("foreshadowing", [])
        for i, clue in enumerate(foreshadowing):
            clues.append({
                "id": f"{row['chapter_title']}_{i}",
                "clue": clue.get("clue", ""),
                "reason": clue.get("reason", ""),
                "confidence": clue.get("confidence", 0),
                "related_entities": clue.get("related_entities", []),
                "chapter_title": row["chapter_title"],
                "chapter_index": row["chapter_index"],
                "created_at": row["created_at"],
                "status": "open",  # open/progress/payoff
            })

    # 按可信度降序
    clues.sort(key=lambda c: c["confidence"], reverse=True)
    return ok({"book_title": book["title"], "foreshadowing": clues, "total": len(clues)})


@app.post("/api/foreshadowing/check")
def check_foreshadowing(book_id: int, chapter_text: str = None, user=Depends(get_user)):
    """伏笔回收检测：判断当前章节是否回应了历史伏笔"""
    from services.ai_service import check_foreshadowing_payoff

    with get_db() as conn:
        book = conn.execute(
            "SELECT id, title FROM books WHERE id=? AND username=?",
            (book_id, user),
        ).fetchone()
        if not book:
            return fail("书籍不存在")

        # 获取当前最新分析
        latest = conn.execute(
            """
            SELECT chapter_title, result_json FROM analyses
            WHERE book_id=? ORDER BY created_at DESC LIMIT 1
            """,
            (book_id,),
        ).fetchone()

        if not latest:
            return fail("该书还没有分析过的章节")

        # 获取历史伏笔
        rows = conn.execute(
            """
            SELECT chapter_title, result_json FROM analyses
            WHERE book_id=? ORDER BY created_at ASC
            """,
            (book_id,),
        ).fetchall()

    current_result = json.loads(latest["result_json"])
    saved_clues = []
    for row in rows:
        try:
            result = json.loads(row["result_json"])
        except json.JSONDecodeError:
            continue
        for i, clue in enumerate(result.get("foreshadowing", [])):
            saved_clues.append({
                "id": f"{row['chapter_title']}_{i}",
                "clue": clue.get("clue", ""),
                "reason": clue.get("reason", ""),
                "confidence": clue.get("confidence", 0),
                "chapter_title": row["chapter_title"],
            })

    if not saved_clues:
        return ok({"matches": [], "message": "暂无历史伏笔可检测"})

    try:
        matches = check_foreshadowing_payoff(
            current_analysis={
                "chapter_title": latest["chapter_title"],
                "summary": current_result.get("summary", ""),
                "characters": current_result.get("characters", []),
                "foreshadowing": current_result.get("foreshadowing", []),
                "terms": current_result.get("terms", []),
            },
            saved_clues=saved_clues,
        )
    except Exception as exc:
        return fail(f"伏笔检测失败：{exc}")

    return ok({"book_title": book["title"], "current_chapter": latest["chapter_title"], "matches": matches})


def log_usage(conn, username: str, action: str, detail: str = "", delta: int = 0):
    """记录使用日志"""
    conn.execute(
        "INSERT INTO usage_logs (username, action, detail, credits_delta, created_at) VALUES (?, ?, ?, ?, ?)",
        (username, action, detail, delta, int(time.time())),
    )


@app.post("/api/buy")
def buy(req: BuyRequest, user=Depends(get_user)):
    plans = {
        "basic": {"credits": 100, "name": "100 次额度包", "amount": 9.9},
        "pro": {"credits": 300, "name": "300 次额度包", "amount": 19.9},
        "monthly": {"credits": 0, "name": "月卡（30天无限）", "amount": 19.9},
        "earlybird": {"credits": 2000, "name": "早鸟高级版", "amount": 49.0},
        "lifetime": {"credits": 9999, "name": "早鸟永久版", "amount": 99.0},
    }
    plan = plans.get(req.plan)
    if not plan:
        return fail("未知套餐")

    # 记录订单
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO orders (username, plan, amount, credits_added, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
            (user, req.plan, plan["amount"], plan["credits"], int(time.time())),
        )
        order_id = cur.lastrowid

        if MOCK_PAYMENTS_ENABLED:
            # 开发模式直接发放
            conn.execute(
                "UPDATE users SET credits = credits + ? WHERE username=?",
                (plan["credits"], user),
            )
            conn.execute(
                "UPDATE orders SET status='fulfilled', fulfilled_at=? WHERE id=?",
                (int(time.time()), order_id),
            )
            log_usage(conn, user, "buy", f"套餐: {plan['name']} (+{plan['credits']}次)", plan["credits"])
            return ok({
                "order_id": order_id,
                "added": plan["credits"],
                "message": f"已购买 {plan['name']}（开发模式自动发放）"
            })

    return ok(
        {
            "order_id": order_id,
            "checkout_required": True,
            "message": f"订单已创建。请通过微信/支付宝转账 {plan['amount']} 元并备注用户名「{user}」，客服确认后手动发放额度。",
        }
    )


# ── 管理后台 ──

ADMIN_KEY = os.getenv("ADMIN_KEY", "admin_dev_key")


def verify_admin(req: Request):
    """简易管理员验证"""
    key = req.headers.get("X-Admin-Key", "")
    if key != ADMIN_KEY:
        raise HTTPException(status_code=403, detail="无管理权限")


@app.get("/api/track/stats")
def track_stats(_admin=Depends(verify_admin)):
    """查看 Landing Page 访问统计（管理员）"""
    from collections import Counter
    total = len(_landing_visits)
    if total == 0:
        return ok({"total": 0, "by_referrer": {}, "recent": []})
    by_ref = Counter(v.get("referrer", "direct") for v in _landing_visits)
    return ok({
        "total": total,
        "by_referrer": dict(by_ref.most_common(10)),
        "recent": _landing_visits[-20:],
    })


@app.get("/api/admin/users")
def admin_list_users(_req: Request = None, _admin=Depends(verify_admin)):
    """列出所有用户"""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT u.username, u.credits, u.created_at,
                   (SELECT COUNT(*) FROM analyses WHERE username=u.username) as total_analyses,
                   (SELECT COUNT(*) FROM orders WHERE username=u.username AND status='fulfilled') as total_orders
            FROM users u
            ORDER BY u.created_at DESC
            """
        ).fetchall()
    return ok({"users": [dict(row) for row in rows]})


@app.get("/api/admin/orders")
def admin_list_orders(status: str = None, _admin=Depends(verify_admin)):
    """列出订单，可按状态过滤"""
    with get_db() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM orders WHERE status=? ORDER BY created_at DESC",
                (status,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM orders ORDER BY created_at DESC"
            ).fetchall()
    return ok({"orders": [dict(row) for row in rows]})


@app.post("/api/admin/orders/{order_id}/fulfill")
def admin_fulfill_order(order_id: int, _admin=Depends(verify_admin)):
    """手动发放订单额度"""
    with get_db() as conn:
        order = conn.execute(
            "SELECT * FROM orders WHERE id=?",
            (order_id,),
        ).fetchone()
        if not order:
            return fail("订单不存在")
        if order["status"] != "pending":
            return fail(f"订单状态为 {order['status']}，无法重复发放")

        conn.execute(
            "UPDATE users SET credits = credits + ? WHERE username=?",
            (order["credits_added"], order["username"]),
        )
        conn.execute(
            "UPDATE orders SET status='fulfilled', fulfilled_at=? WHERE id=?",
            (int(time.time()), order_id),
        )
        log_usage(conn, order["username"], "admin_fulfill",
                   f"订单 #{order_id} 发放 {order['credits_added']} 次额度", order["credits_added"])

    return ok({"message": f"已向 {order['username']} 发放 {order['credits_added']} 次额度"})


@app.post("/api/admin/users/{username}/credits")
def admin_add_credits(username: str, req: Request, _admin=Depends(verify_admin)):
    """手动增减用户额度"""
    body = req.json()
    delta = int(body.get("delta", 0))
    if delta == 0:
        return fail("delta 不能为 0")

    with get_db() as conn:
        user = conn.execute(
            "SELECT username FROM users WHERE username=?",
            (username,),
        ).fetchone()
        if not user:
            return fail("用户不存在")

        conn.execute(
            "UPDATE users SET credits = MAX(0, credits + ?) WHERE username=?",
            (delta, username),
        )
        log_usage(conn, username, "admin_credit", f"管理员调整额度 ({delta})", delta)

    return ok({"message": f"已调整 {username} 额度 ({delta:+d})"})


@app.get("/admin")
def admin_page():
    """管理后台页面"""
    return HTMLResponse(content="""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鉴来助手 - 管理后台</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:20px;color:#2f2925;background:#fbfaf6;font-family:Arial,"Microsoft YaHei",sans-serif}
h1{font-size:20px;margin:0 0 16px}h2{font-size:16px;margin:0 0 10px}
input,select,button{padding:8px 10px;border:1px solid #d7c8bc;border-radius:6px;font:inherit;font-size:13px}
button{cursor:pointer;color:#fff;background:#5d4037;border:0}button:hover{opacity:.9}
button.secondary{color:#5d4037;background:#e4d6ca}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}
th,td{padding:8px 10px;border:1px solid #e2d9d1;text-align:left}th{background:#efe8df}
.card{padding:16px;margin:16px 0;border:1px solid #e2d9d1;border-radius:8px;background:#fff}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.badge{padding:2px 8px;border-radius:10px;font-size:11px}
.badge.pending{background:#fff3e0;color:#e65100}
.badge.fulfilled{background:#e8f5e9;color:#2e7d32}
#message{padding:8px;margin:8px 0;border-radius:6px;font-size:13px;display:none}
</style>
</head>
<body>
<h1>鉴来助手 · 管理后台</h1>
<div id="message"></div>

<div class="card">
<h2>待处理订单</h2>
<table><thead><tr><th>ID</th><th>用户</th><th>套餐</th><th>金额</th><th>额度</th><th>时间</th><th>操作</th></tr></thead>
<tbody id="pending-orders"><tr><td colspan="7">加载中...</td></tr></tbody></table>
</div>

<div class="card">
<h2>手动充值</h2>
<div class="row">
  <input id="recharge-username" placeholder="用户名" style="width:160px">
  <input id="recharge-delta" type="number" placeholder="额度 (+/-)" style="width:120px">
  <button onclick="recharge()">确认充值</button>
</div>
</div>

<div class="card">
<h2>用户列表</h2>
<table><thead><tr><th>用户名</th><th>额度</th><th>分析次数</th><th>购买次数</th><th>注册时间</th></tr></thead>
<tbody id="user-list"><tr><td colspan="5">加载中...</td></tr></tbody></table>
</div>

<script>
const API = window.location.origin;
let adminKey = localStorage.getItem("admin_key") || "admin_dev_key";

function setAdminKey() {
  const key = prompt("管理员密钥:", localStorage.getItem("admin_key") || "admin_dev_key");
  if (key) { adminKey = key; localStorage.setItem("admin_key", key); }
}

async function fetchAPI(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { ...opts.headers, "X-Admin-Key": adminKey, "Content-Type": "application/json" }
  });
  return res.json();
}

function msg(text, isErr) {
  const el = document.getElementById("message");
  el.style.display = "block";
  el.textContent = text;
  el.style.background = isErr ? "#ffebee" : "#e8f5e9";
  el.style.color = isErr ? "#c62828" : "#2e7d32";
  setTimeout(() => el.style.display = "none", 4000);
}

async function loadData() {
  try {
    const [orderRes, userRes] = await Promise.all([
      fetchAPI("/api/admin/orders?status=pending"),
      fetchAPI("/api/admin/users")
    ]);

    const pending = document.getElementById("pending-orders");
    const orders = orderRes.data?.orders || [];
    if (orders.length === 0) {
      pending.innerHTML = '<tr><td colspan="7">暂无待处理订单</td></tr>';
    } else {
      pending.innerHTML = orders.map(o => `<tr>
        <td>${o.id}</td><td>${o.username}</td><td>${o.plan}</td>
        <td>${o.amount}元</td><td>+${o.credits_added}</td>
        <td>${new Date(o.created_at*1000).toLocaleString()}</td>
        <td><button onclick="fulfill(${o.id})">发放额度</button></td>
      </tr>`).join("");
    }

    const ul = document.getElementById("user-list");
    const users = userRes.data?.users || [];
    ul.innerHTML = users.map(u => `<tr>
      <td>${u.username}</td><td>${u.credits} 次</td><td>${u.total_analyses}</td>
      <td>${u.total_orders}</td>
      <td>${new Date(u.created_at*1000).toLocaleString()}</td>
    </tr>`).join("");
  } catch (e) {
    msg("加载失败: " + e.message, true);
  }
}

async function fulfill(orderId) {
  if (!confirm("确认发放？")) return;
  try {
    const res = await fetchAPI(`/api/admin/orders/${orderId}/fulfill`, { method: "POST" });
    if (res.success) msg(res.data.message); else msg(res.error || "操作失败", true);
    loadData();
  } catch (e) { msg("操作失败: " + e.message, true); }
}

async function recharge() {
  const username = document.getElementById("recharge-username").value.trim();
  const delta = parseInt(document.getElementById("recharge-delta").value, 10);
  if (!username || !delta) { msg("请填写用户名和额度", true); return; }
  if (!confirm(`确认向 ${username} ${delta > 0 ? "增加" : "减少"} ${Math.abs(delta)} 次额度？`)) return;
  try {
    const res = await fetchAPI(`/api/admin/users/${encodeURIComponent(username)}/credits`, {
      method: "POST",
      body: JSON.stringify({ delta })
    });
    if (res.success) {
      msg(res.data.message);
      loadData();
     } else msg(res.error || "操作失败", true);
  } catch (e) { msg("操作失败: " + e.message, true); }
}

loadData();
</script>
</body>
</html>
""")
