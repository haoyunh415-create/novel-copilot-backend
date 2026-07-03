import hashlib
import json
import os
import random
import re
import smtplib
import sqlite3
import time
from contextlib import contextmanager
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional

import jwt
import requests as http_requests
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from services.ai_service import analyze_text
from services.auth_service import hash_password as bcrypt_hash_password
from services.auth_service import verify_password as bcrypt_verify_password


def friendly_error(exc: Exception) -> str:
    """将技术异常映射为用户可理解的错误提示"""
    msg = str(exc)

    if "缺少 DEEPSEEK_API_KEY" in msg:
        return "服务器 AI 服务未配置，请联系管理员"

    if isinstance(exc, http_requests.Timeout) or "timeout" in msg.lower():
        return "AI 服务响应超时，章节内容太长或网络不稳定，请稍后重试"

    if isinstance(exc, http_requests.ConnectionError) or "connection" in msg.lower():
        return "无法连接 AI 服务，请检查网络后重试"

    if "429" in msg or "rate" in msg.lower():
        return "AI 服务繁忙，请稍等几秒后重试"

    if "401" in msg or "403" in msg:
        return "AI 服务认证失败，请联系管理员检查 API Key"

    if "500" in msg or "502" in msg or "503" in msg:
        return "AI 服务暂时不可用，请稍后重试"

    if "没有返回 JSON" in msg or "格式异常" in msg:
        return "AI 返回格式异常，请重试或换个章节试试"

    if "内容太短" in msg or "正文字数不足" in msg:
        return "页面内容太少，请确保当前页面包含小说章节正文"

    # 兜底：隐藏技术细节
    return "操作失败，请稍后重试或联系客服"

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

# ── 邮件配置 ──
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.qq.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
EMAIL_ENABLED = bool(SMTP_USER and SMTP_PASS)

# 验证码存储（内存）：{email: {code, expires}}
_email_codes = {}

# ── 请求限流 ──
# {key: [timestamp, ...]}
_rate_limits = {}
RATE_LIMITS = {
    "analyze": {"per_user": 20, "window": 60},       # 每用户每分钟最多20次分析
    "ask": {"per_user": 10, "window": 60},            # 每用户每分钟最多10次问答
    "send_code": {"per_ip": 3, "window": 300},         # 每IP每5分钟最多3次发验证码
    "verify_code": {"per_ip": 10, "window": 300},      # 每IP每5分钟最多10次验证
    "register": {"per_ip": 5, "window": 3600},          # 每IP每小时最多5次注册
    "login": {"per_ip": 20, "window": 60},              # 每IP每分钟最多20次登录
}


def _check_rate_limit(category: str, user: str = None, ip: str = None):
    """检查请求频率。返回 (allowed: bool, retry_after: int)"""
    limits = RATE_LIMITS.get(category)
    if not limits:
        return True, 0

    key = f"{category}:{user or ip or 'unknown'}"
    max_req = limits.get("per_user") or limits.get("per_ip", 20)
    window = limits.get("window", 60)
    now = time.time()

    timestamps = _rate_limits.get(key, [])
    # 清理过期记录
    timestamps = [t for t in timestamps if now - t < window]
    _rate_limits[key] = timestamps

    if len(timestamps) >= max_req:
        retry_after = int(window - (now - timestamps[0]))
        return False, max(1, retry_after)

    timestamps.append(now)
    return True, 0


def _cleanup_rate_limits():
    """定期清理过期的限流记录"""
    now = time.time()
    expired = []
    for key, timestamps in _rate_limits.items():
        active = [t for t in timestamps if now - t < max(RATE_LIMITS.get(key.split(":")[0], {}).get("window", 300), 60)]
        if active:
            _rate_limits[key] = active
        else:
            expired.append(key)
    for key in expired:
        del _rate_limits[key]
    # 每100次请求清理一次
    if len(_rate_limits) > 500:
        for key in list(_rate_limits.keys())[:200]:
            del _rate_limits[key]

user_last_request = {}

# 问答缓存：{(username, question_hash, memory_hash): answer} — 同样问题+同样记忆不重复调 AI
qa_cache = {}
QA_CACHE_MAX = 200


@contextmanager
def get_db():
    conn = sqlite3.connect("users.db", check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    # WAL 模式：读写不互斥，并发性能更好
    conn.execute("PRAGMA journal_mode=WAL")
    # 忙等待 5 秒（写入冲突时重试而非立即失败）
    conn.execute("PRAGMA busy_timeout=5000")
    # 启用外键约束
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except sqlite3.OperationalError as e:
        conn.rollback()
        if "database is locked" in str(e).lower():
            # 数据库锁：等待重试一次
            import time as _time
            _time.sleep(0.5)
            try:
                conn.commit()
                return
            except Exception:
                conn.rollback()
        raise
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
                credits INTEGER NOT NULL DEFAULT 10,
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
        if "daily_bonus_date" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN daily_bonus_date TEXT NOT NULL DEFAULT ''")
        if "email" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''")
        if "registration_ip" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN registration_ip TEXT NOT NULL DEFAULT ''")

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


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=20, max_length=60000)
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


class FeedbackRequest(BaseModel):
    book_id: Optional[int] = None
    chapter_title: str = Field(min_length=1, max_length=120)
    rating: str = Field(pattern="^(good|bad)$")
    detail: Optional[str] = Field(default=None, max_length=500)


class ReviewRequest(BaseModel):
    book_id: int
    chapter_count: int = Field(default=10, ge=3, le=50)


class FullReportRequest(BaseModel):
    book_id: int


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


@app.get("/")
def root():
    return HTMLResponse(content="""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>鉴来助手 · 后端</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#2C2416;
background:linear-gradient(180deg,#FBF8F0,#F5EDE0);min-height:100vh;
display:flex;align-items:center;justify-content:center;padding:20px}
.card{max-width:420px;width:100%;padding:32px 24px;background:#FFFDF7;
border:1px solid #E8DDD2;border-radius:12px;box-shadow:0 4px 24px rgba(44,36,22,.1);
text-align:center}
h2{font-size:22px;color:#5D4037;margin-bottom:4px}
.status{display:inline-block;padding:4px 12px;border-radius:10px;
background:#E8F5E9;color:#2E7D32;font-size:12px;font-weight:600;margin:12px 0}
.links{display:flex;flex-direction:column;gap:8px;margin:20px 0;text-align:left}
.links a{display:block;padding:12px 16px;background:#F5EDE0;border-radius:8px;
color:#5D4037;text-decoration:none;font-size:14px;font-weight:500;
transition:all .15s}
.links a:hover{background:#E8DDD2;transform:translateX(2px)}
.links a span{float:right;color:#A1887F;font-size:12px}
</style>
</head>
<body>
<div class="card">
  <h2>📖 鉴来助手</h2>
  <p style="color:#A1887F;font-size:13px;margin-top:4px">后端服务运行中</p>
  <div class="status">✅ 正常运行</div>
  <div class="links">
    <a href="/docs">📚 API 文档 <span>Swagger UI →</span></a>
    <a href="/admin">⚙️ 管理后台 <span>→</span></a>
    <a href="/api/health">💚 健康检查 <span>/api/health →</span></a>
  </div>
  <p style="font-size:10px;color:#B0A395">鉴来助手 · 追更不迷路的 AI 阅读助手</p>
</div>
</body>
</html>
""")

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


# ── 邮箱验证码登录（唯一登录方式）──

def _send_email(to_email: str, subject: str, body: str):
    """通过 QQ 邮箱 SMTP 发送邮件。返回 (success, message)。"""
    if not EMAIL_ENABLED:
        return False, "邮件服务未配置（请设置 SMTP_USER 和 SMTP_PASS）"

    msg = MIMEMultipart()
    msg["From"] = SMTP_USER
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_USER, [to_email], msg.as_string())
        return True, "发送成功"
    except smtplib.SMTPAuthenticationError:
        return False, "邮件服务认证失败，请检查 SMTP 配置"
    except smtplib.SMTPException as e:
        return False, f"邮件发送失败：{e}"


class SendCodeRequest(BaseModel):
    email: str = Field(min_length=5, max_length=100)


@app.post("/api/auth/send-code")
def send_code(req: SendCodeRequest, http_req: Request):
    """发送邮箱验证码（6 位数字，5 分钟有效）"""
    allowed, retry = _check_rate_limit("send_code", ip=http_req.client.host if http_req.client else "unknown")
    if not allowed:
        return fail(f"验证码发送太频繁，请 {retry} 秒后再试")

    email = req.email.strip().lower()

    # 基本邮箱格式校验
    if "@" not in email or "." not in email.split("@")[-1]:
        return fail("邮箱格式不正确")

    # 限制发送频率（60 秒内不能重复发送）
    existing = _email_codes.get(email)
    if existing and time.time() - existing.get("sent_at", 0) < 60:
        return fail("验证码已发送，请 60 秒后再试")

    code = str(random.randint(100000, 999999))
    _email_codes[email] = {
        "code": code,
        "expires": time.time() + 300,  # 5 分钟有效
        "sent_at": time.time(),
    }

    # 清理过期验证码
    expired = [e for e, v in _email_codes.items() if v["expires"] < time.time()]
    for e in expired:
        del _email_codes[e]

    body = f"""
    <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px;
                background:#FFFDF7;border:1px solid #E8DDD2;border-radius:10px">
      <h2 style="color:#5D4037">📖 鉴来助手</h2>
      <p>你的登录验证码是：</p>
      <div style="text-align:center;padding:16px;margin:12px 0;background:#F5EDE0;
                  border-radius:8px;font-size:28px;font-weight:700;color:#3E2723;letter-spacing:6px">
        {code}
      </div>
      <p style="color:#8D6E63;font-size:12px">5 分钟内有效，请勿分享给他人。</p>
      <p style="color:#A1887F;font-size:11px">如果这不是你的操作，请忽略此邮件。</p>
    </div>
    """

    if not EMAIL_ENABLED:
        # 开发模式：验证码直接返回（方便测试）
        print(f"[DEV] 邮箱验证码 for {email}: {code}")
        return ok({"dev_code": code, "message": "开发模式：验证码已打印在控制台"})

    ok_flag, msg = _send_email(email, "鉴来助手 · 登录验证码", body)
    if not ok_flag:
        return fail(msg)
    return ok({"message": "验证码已发送，请查收邮件"})


class VerifyCodeLoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=100)
    code: str = Field(min_length=6, max_length=6)


@app.post("/api/auth/verify-code")
def verify_code_login(req: VerifyCodeLoginRequest, http_req: Request):
    """验证码登录：验证通过后自动注册或登录，返回 token"""
    client_ip = http_req.client.host if http_req.client else "unknown"
    email = req.email.strip().lower()

    record = _email_codes.get(email)
    if not record:
        return fail("请先获取验证码")
    if record["expires"] < time.time():
        del _email_codes[email]
        return fail("验证码已过期，请重新获取")
    if record["code"] != req.code:
        return fail("验证码错误")

    # 验证通过，清除验证码
    del _email_codes[email]

    # 从邮箱提取用户名（@ 前面的部分）
    base_username = email.split("@")[0].replace(".", "_").replace("-", "_")

    with get_db() as conn:
        # 检查是否已有该邮箱的用户
        existing = conn.execute(
            "SELECT username FROM users WHERE email=?",
            (email,),
        ).fetchone()

        if existing:
            username = existing["username"]
        else:
            # 新用户：检查 IP 上限
            ip_count = conn.execute(
                "SELECT COUNT(*) as cnt FROM users WHERE registration_ip=?",
                (client_ip,),
            ).fetchone()["cnt"]
            if ip_count >= 3:
                return fail("该网络环境注册已达上限，请使用已有账号或联系客服")

            # 新用户：自动注册
            username = base_username
            # 处理重名
            suffix = 1
            while True:
                try:
                    conn.execute(
                        "INSERT INTO users (username, password, email, credits, created_at, registration_ip) VALUES (?, ?, ?, 10, ?, ?)",
                        (username, "email_login_no_password", email, int(time.time()), client_ip),
                    )
                    break
                except sqlite3.IntegrityError:
                    suffix += 1
                    username = f"{base_username}{suffix}"

        token = create_token(username)
        credits = conn.execute(
            "SELECT credits FROM users WHERE username=?",
            (username,),
        ).fetchone()["credits"]

    return ok({
        "token": token,
        "username": username,
        "credits": credits,
        "is_new": not bool(existing),
    })


# ── 密码找回 ──

class ForgotPasswordRequest(BaseModel):
    username_or_email: str = Field(min_length=3, max_length=100)


@app.post("/api/auth/forgot-password")
def forgot_password(req: ForgotPasswordRequest):
    """发送密码重置验证码到用户绑定的邮箱"""
    identifier = req.username_or_email.strip()

    with get_db() as conn:
        user = conn.execute(
            "SELECT username, email FROM users WHERE username=? OR email=?",
            (identifier, identifier.lower()),
        ).fetchone()

    if not user:
        # 不暴露用户是否存在，统一返回
        return ok({"message": "如果该账号存在且绑定了邮箱，验证码已发送"})

    email = user["email"]
    if not email or "@" not in email:
        return ok({"message": "该账号未绑定邮箱，请联系客服重置密码"})

    # 发送验证码（复用 email login 的验证码机制）
    code = str(random.randint(100000, 999999))
    _email_codes[email] = {
        "code": code,
        "expires": time.time() + 300,
        "sent_at": time.time(),
    }

    body = f"""
    <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px;
                background:#FFFDF7;border:1px solid #E8DDD2;border-radius:10px">
      <h2 style="color:#5D4037">📖 鉴来助手 · 密码重置</h2>
      <p>你的密码重置验证码是：</p>
      <div style="text-align:center;padding:16px;margin:12px 0;background:#F5EDE0;
                  border-radius:8px;font-size:28px;font-weight:700;color:#3E2723;letter-spacing:6px">
        {code}
      </div>
      <p style="color:#8D6E63;font-size:12px">5 分钟内有效。</p>
      <p style="color:#A1887F;font-size:11px">如果这不是你的操作，请忽略。</p>
    </div>
    """

    if not EMAIL_ENABLED:
        print(f"[DEV] 密码重置验证码 for {email}: {code}")
        return ok({"dev_code": code, "message": "开发模式：验证码已打印"})

    ok_flag, msg = _send_email(email, "鉴来助手 · 密码重置", body)
    if not ok_flag:
        return fail(msg)
    return ok({"message": "验证码已发送到绑定邮箱"})


class ResetPasswordRequest(BaseModel):
    username_or_email: str = Field(min_length=3, max_length=100)
    code: str = Field(min_length=6, max_length=6)
    new_password: str = Field(min_length=6, max_length=128)


@app.post("/api/auth/reset-password")
def reset_password(req: ResetPasswordRequest):
    """验证码通过后重置密码"""
    identifier = req.username_or_email.strip()

    with get_db() as conn:
        user = conn.execute(
            "SELECT username, email FROM users WHERE username=? OR email=?",
            (identifier, identifier.lower()),
        ).fetchone()

    if not user or not user["email"]:
        return fail("账号不存在或未绑定邮箱")

    email = user["email"]
    record = _email_codes.get(email)
    if not record:
        return fail("请先获取验证码")
    if record["expires"] < time.time():
        del _email_codes[email]
        return fail("验证码已过期")
    if record["code"] != req.code:
        return fail("验证码错误")

    # 验证通过，重置密码
    del _email_codes[email]
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET password=? WHERE username=?",
            (bcrypt_hash_password(req.new_password), user["username"]),
        )

    return ok({"message": "密码已重置，请使用新密码登录"})


@app.get("/api/me")
def me(user=Depends(get_user)):
    from datetime import date as date_type
    today = str(date_type.today())

    with get_db() as conn:
        row = conn.execute(
            "SELECT credits, daily_bonus_date FROM users WHERE username=?",
            (user,),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=401, detail="用户不存在")

    credits = row["credits"]
    daily_bonus = 0
    if row["daily_bonus_date"] != today:
        daily_bonus = 8
        credits += daily_bonus
        with get_db() as conn:
            conn.execute(
                "UPDATE users SET credits=?, daily_bonus_date=? WHERE username=?",
                (credits, today, user),
            )
            log_usage(conn, user, "daily_bonus", f"每日签到 +{daily_bonus} 次", daily_bonus)

    return ok({
        "credits": credits,
        "daily_bonus": daily_bonus,
        "message": f"今日签到已领取 {daily_bonus} 次额度" if daily_bonus else "今日已签到",
    })


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest, user=Depends(get_user)):
    # 限流检查
    allowed, retry = _check_rate_limit("analyze", user=user)
    if not allowed:
        return fail(f"请求太频繁，请 {retry} 秒后再试")

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

    # 超长文本智能截断
    analysis_text = req.text
    truncated = False
    MAX_CHARS = 12000
    if len(analysis_text) > MAX_CHARS:
        truncated = True
        # 尽量在段落边界截断
        cut_point = analysis_text.rfind("\n", 0, MAX_CHARS)
        if cut_point < MAX_CHARS // 2:
            cut_point = MAX_CHARS
        analysis_text = analysis_text[:cut_point] + "\n\n[提示：章节过长，已截取前 {:.0f}% 内容进行分析]".format(
            cut_point / len(req.text) * 100
        )

    # 调用 AI 分析
    try:
        result = analyze_text(
            analysis_text,
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
        return fail(friendly_error(exc))

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

    response_data = {"result": result, "cached": False, "book_id": book_id}
    if truncated:
        response_data["truncated"] = True
        response_data["warning"] = f"章节过长（{len(req.text)}字），仅分析了前{len(analysis_text)}字"
    return ok(response_data)


@app.post("/api/feedback")
def submit_feedback(req: FeedbackRequest, user=Depends(get_user)):
    """收集用户对分析结果的评价"""
    detail = req.detail or ""
    with get_db() as conn:
        log_usage(conn, user, "feedback_" + req.rating,
                   f"章节: {req.chapter_title}" + (f" | {detail}" if detail else ""), 0)
    return ok({"message": "感谢反馈！"})


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
    allowed, retry = _check_rate_limit("ask", user=user)
    if not allowed:
        return fail(f"提问太频繁，请 {retry} 秒后再试")

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
        return fail(friendly_error(exc))

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
        return fail(friendly_error(exc))

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
        return fail(friendly_error(exc))

    return ok({"book_title": book["title"], "review": review, "chapters_covered": len(memories)})


@app.post("/api/report/full")
def generate_full_report(req: FullReportRequest, user=Depends(get_user)):
    """全书复盘报告：基于全部已分析章节生成完整阅读复盘。

    消耗 20 积分，返回结构化 Markdown 报告。
    """
    from services.ai_service import generate_full_report as do_full_report
    from services.ai_service import FULL_REPORT_COST

    with get_db() as conn:
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
            ORDER BY COALESCE(chapter_index, 999999), created_at ASC
            """,
            (req.book_id,),
        ).fetchall()

    if not rows:
        return fail("该书还没有分析过的章节，请先分析至少几章后再生成复盘报告")

    # 加载全部记忆
    memories = []
    for row in rows:
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

    if not memories:
        return fail("章节记忆解析失败")

    # 检查额度
    with get_db() as conn:
        row = conn.execute(
            "SELECT credits FROM users WHERE username=?",
            (user,),
        ).fetchone()

        if not row or row["credits"] < FULL_REPORT_COST:
            return fail(f"额度不足，全书复盘需要 {FULL_REPORT_COST} 次额度，当前剩余 {row['credits'] if row else 0} 次")

        # 扣额度
        conn.execute(
            "UPDATE users SET credits = credits - ? WHERE username=? AND credits >= ?",
            (FULL_REPORT_COST, user, FULL_REPORT_COST),
        )
        log_usage(conn, user, "full_report",
                   f"全书复盘: 《{book['title']}》({len(memories)}章)", -FULL_REPORT_COST)

    # 调用 AI 生成报告
    try:
        report = do_full_report(
            book_title=book["title"],
            memories=memories,
        )
    except Exception as exc:
        # 失败退款
        with get_db() as conn:
            conn.execute(
                "UPDATE users SET credits = credits + ? WHERE username=?",
                (FULL_REPORT_COST, user),
            )
            log_usage(conn, user, "full_report_refund",
                       f"报告生成失败退款: {exc}", FULL_REPORT_COST)
        return fail(friendly_error(exc))

    return ok({
        "book_title": book["title"],
        "report": report,
        "chapters_covered": len(memories),
        "credits_cost": FULL_REPORT_COST,
    })


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

        # 从 graph.edges 提取关系，映射 node ID → 人物名称
        graph = result.get("graph", {})
        graph_nodes = graph.get("nodes", [])
        graph_edges = graph.get("edges", [])
        # 构建 nodeId → name 的映射
        node_name_map = {}
        for node in graph_nodes:
            nid = node.get("id", "")
            nlabel = node.get("label", "")
            if nid and nlabel:
                node_name_map[nid] = nlabel

        # 为每个人物生成关系描述
        char_relationships = {}  # name -> [关系描述字符串]
        for edge in graph_edges:
            from_id = edge.get("from", "")
            to_id = edge.get("to", "")
            label = edge.get("label", "")
            from_name = node_name_map.get(from_id, from_id)
            to_name = node_name_map.get(to_id, to_id)
            if from_name and to_name and from_name != to_name:
                rel_text = f"与{to_name}：{label}" if label else f"与{to_name}"
                char_relationships.setdefault(from_name, []).append(rel_text)
                # 双向关系
                rel_text_rev = f"与{from_name}：{label}" if label else f"与{from_name}"
                char_relationships.setdefault(to_name, []).append(rel_text_rev)

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

        # 把从 graph.edges 提取的关系也合并进去
        for name, rels in char_relationships.items():
            if name in characters_map:
                for r in rels:
                    if r not in characters_map[name]["relationships"]:
                        characters_map[name]["relationships"].append(r)

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
        return fail(friendly_error(exc))

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
            "pay_url": f"/pay/{order_id}",
            "message": f"订单已创建，请在支付页面完成转账",
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


class AdminCreditsBody(BaseModel):
    delta: int


@app.post("/api/admin/users/{username}/credits")
def admin_add_credits(username: str, body: AdminCreditsBody, _admin=Depends(verify_admin)):
    """手动增减用户额度，也支持邮箱查找"""
    delta = body.delta
    if delta == 0:
        return fail("delta 不能为 0")

    with get_db() as conn:
        # 先按用户名精确匹配
        user = conn.execute(
            "SELECT username FROM users WHERE username=?",
            (username,),
        ).fetchone()

        # 找不到？试试邮箱匹配
        if not user:
            user = conn.execute(
                "SELECT username FROM users WHERE email=?",
                (username.lower().strip(),),
            ).fetchone()

        if not user:
            return fail(f"用户不存在：{username}（可输入用户名或邮箱）")

        actual_username = user["username"]

        conn.execute(
            "UPDATE users SET credits = MAX(0, credits + ?) WHERE username=?",
            (delta, actual_username),
        )
        log_usage(conn, actual_username, "admin_credit", f"管理员调整额度 ({delta})", delta)

    return ok({"message": f"已调整 {actual_username} 额度 ({delta:+d})"})


@app.get("/pay/{order_id}")
def pay_page(order_id: int):
    """支付引导页面"""
    with get_db() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not order:
        return HTMLResponse(content="<h2>订单不存在</h2>", status_code=404)

    plans_display = {
        "basic": "100 次额度包", "pro": "300 次额度包",
        "monthly": "月卡（30天无限）", "earlybird": "早鸟高级版", "lifetime": "早鸟永久版",
    }

    return HTMLResponse(content=f"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>支付 - 鉴来助手</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#2C2416;background:linear-gradient(180deg,#FBF8F0,#F5EDE0);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}}
.card{{max-width:420px;width:100%;padding:28px 24px;background:#FFFDF7;border:1px solid #E8DDD2;border-radius:12px;box-shadow:0 4px 24px rgba(44,36,22,.1);text-align:center}}
h2{{font-size:20px;color:#5D4037;margin-bottom:4px}}
.order-id{{font-size:12px;color:#A1887F;margin-bottom:20px}}
.amount{{font-size:36px;font-weight:800;color:#5D4037;margin:16px 0}}
.plan-name{{font-size:14px;color:#8D6E63}}
.pay-section{{margin:20px 0;padding:16px;background:#FFF8E1;border:1px solid #FFE082;border-radius:10px;text-align:left}}
.pay-section h3{{font-size:14px;color:#E65100;margin-bottom:12px}}
.pay-section .step{{font-size:13px;color:#5D4037;margin:8px 0;line-height:1.6}}
.qr-placeholder{{width:180px;height:180px;margin:16px auto;border:2px dashed #D7CCC8;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#A1887F;font-size:13px}}
.note{{font-size:11px;color:#A1887F;margin-top:16px}}
</style>
</head>
<body>
<div class="card">
  <h2>📖 鉴来助手</h2>
  <div class="order-id">订单号 #{order["id"]}</div>
  <div class="plan-name">{plans_display.get(order["plan"], order["plan"])}</div>
  <div class="amount">¥{order["amount"]}</div>

  <div class="pay-section">
    <h3>📱 扫码支付</h3>
    <div class="qr-placeholder">
      ⚙️ 请配置<br>支付二维码
    </div>
    <div class="step">1️⃣ 使用微信/支付宝扫描上方二维码</div>
    <div class="step">2️⃣ 转账 <b>¥{order["amount"]}</b></div>
    <div class="step">3️⃣ 在转账备注中填写：<b>{order["username"]}</b></div>
    <div class="step">4️⃣ 支付完成后联系客服确认，或等待自动到账</div>
  </div>

  <div class="note">
    当前状态：<b style="color:#E65100">{"已到账" if order["status"] == "fulfilled" else "待支付"}</b>
    <br>如有疑问，请在插件弹窗中联系客服
  </div>
</div>
</body>
</html>
""")


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
