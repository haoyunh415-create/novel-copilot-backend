# Refresh Token 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Refresh Token 机制，让用户登录一次可保持 30 天，不用频繁重收邮箱验证码。

**Architecture:** 服务端新增 `refresh_tokens` 表存储 30 天有效期的随机串 token，登录时同时返回 access_token + refresh_token；扩展端检测到 access_token 过期时静默调用 `/api/auth/refresh` 换取新 token 对（token 轮转）。

**Tech Stack:** Python 3.10+ / FastAPI / PyJWT / SQLite / Chrome Extension Manifest V3 (Vanilla JS)

## Global Constraints

- ACCESS_TOKEN_TTL_SECONDS 保持 86400（24 小时）不变
- REFRESH_TOKEN_TTL_SECONDS = 2592000（30 天）
- refresh_token 采用 `secrets.token_hex(32)` 生成 64 字符随机串，非 JWT
- Token 轮转：每次 refresh 时旧 token 作废、发放新 token
- 向后兼容：老版本扩展不带 refreshToken 字段不受影响
- 刷新接口限流：每 IP 10 次/60 秒

---

### Task 1: 后端 — 环境配置与数据库

**Files:**
- Modify: `C:\Users\32639\novel-copilot-backend\main.py`
- Modify: `C:\Users\32639\novel-copilot-backend\.env.example`

**Interfaces:**
- Consumes: 无
- Produces: `REFRESH_TOKEN_TTL_SECONDS` 环境变量，`refresh_tokens` 表

- [ ] **Step 1: 在 main.py 添加 REFRESH_TOKEN_TTL_SECONDS 配置**

在 `ACCESS_TOKEN_TTL_SECONDS`（第 67 行）下方添加：

```python
REFRESH_TOKEN_TTL_SECONDS = int(os.getenv("REFRESH_TOKEN_TTL_SECONDS", "2592000"))
```

- [ ] **Step 2: 在 init_db() 中添加 refresh_tokens 建表**

在 `email_logs` 建表语句之后（约第 302 行附近，email_logs 表的 `conn.execute` 闭合后）添加：

```python
        # Refresh Token 表（记住登录状态，30 天有效）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT UNIQUE NOT NULL,
                username TEXT NOT NULL,
                expires INTEGER NOT NULL,
                created_at INTEGER NOT NULL DEFAULT 0
            )
            """
        )
```

- [ ] **Step 3: 添加 refresh 请求限流配置**

在 RATE_LIMITS 字典（第 82-89 行）中添加：

```python
    "refresh": {"per_ip": 10, "window": 60},            # 每IP每分钟最多10次刷新
```

- [ ] **Step 4: 添加 secrets 模块导入**

在文件顶部 import 区域（第 4 行 `import random` 附近）添加：

```python
import secrets
```

- [ ] **Step 5: 更新 .env.example**

在 `ACCESS_TOKEN_TTL_SECONDS=86400` 下方添加：

```
# Refresh Token 有效期（秒），默认 30 天
REFRESH_TOKEN_TTL_SECONDS=2592000
```

- [ ] **Step 6: 验证 — 运行服务确认启动无报错**

```bash
cd C:\Users\32639\novel-copilot-backend && python -c "import main; print('OK')"
```
期望：输出 `OK`，无异常。

- [ ] **Step 7: 提交**

```bash
git add main.py .env.example
git commit -m "feat: 添加 REFRESH_TOKEN_TTL_SECONDS 配置和 refresh_tokens 表

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 后端 — 修改登录接口返回 refresh_token

**Files:**
- Modify: `C:\Users\32639\novel-copilot-backend\main.py:646-657`

**Interfaces:**
- Consumes: `refresh_tokens` 表（Task 1）、`REFRESH_TOKEN_TTL_SECONDS`（Task 1）
- Produces: 登录接口响应新增 `refresh_token` 字段

- [ ] **Step 1: 修改 verify_code_login 的 token 生成部分**

将原代码（约第 646-657 行）：
```python
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
```

替换为：
```python
        token = create_token(username)
        credits = conn.execute(
            "SELECT credits FROM users WHERE username=?",
            (username,),
        ).fetchone()["credits"]

        # 生成 refresh_token（随机串，30 天有效）
        refresh_token = secrets.token_hex(32)
        now = int(time.time())
        conn.execute(
            "INSERT INTO refresh_tokens (token, username, expires, created_at) VALUES (?, ?, ?, ?)",
            (refresh_token, username, now + REFRESH_TOKEN_TTL_SECONDS, now),
        )

    return ok({
        "token": token,
        "refresh_token": refresh_token,
        "username": username,
        "credits": credits,
        "is_new": not bool(existing),
    })
```

- [ ] **Step 2: 验证 — 模拟登录请求检查返回**

启动服务后执行：
```bash
curl -s -X POST http://localhost:8001/api/auth/verify-code \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","code":"123456"}' | python -c "import sys,json; d=json.load(sys.stdin); print('OK has refresh_token' if 'refresh_token' in d.get('data',{}) else 'FAIL'); print('refresh_token length:', len(d.get('data',{}).get('refresh_token','')))"
```
期望：`OK has refresh_token`，`refresh_token length: 64`。
注：如果验证码无效会返回错误，改为先调用 send-code 获取验证码。

- [ ] **Step 3: 提交**

```bash
git add main.py
git commit -m "feat: 登录接口返回 refresh_token

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 后端 — 新增 /api/auth/refresh 端点

**Files:**
- Modify: `C:\Users\32639\novel-copilot-backend\main.py`

**Interfaces:**
- Consumes: `refresh_tokens` 表（Task 1）、`create_token()`（已有）、`REFRESH_TOKEN_TTL_SECONDS`（Task 1）
- Produces: `POST /api/auth/refresh` — 接受旧 refresh_token，返回新 token 对

- [ ] **Step 1: 添加请求模型和端点**

在 `/api/auth/verify-code` 端点之后、`# ── 密码找回 ──` 注释之前（约第 658 行之前）添加：

```python
# ── Refresh Token ──

class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=64, max_length=64)


@app.post("/api/auth/refresh")
def refresh_token(req: RefreshRequest, http_req: Request):
    """用 refresh_token 换取新的 access_token + refresh_token（轮转）"""
    client_ip = http_req.client.host if http_req.client else "unknown"

    # 限流
    allowed, retry = _check_rate_limit("refresh", ip=client_ip)
    if not allowed:
        return fail(f"请求太频繁，请 {retry} 秒后再试")

    with get_db() as conn:
        # 顺便清理过期 token
        conn.execute("DELETE FROM refresh_tokens WHERE expires < ?", (time.time(),))

        record = conn.execute(
            "SELECT username, expires FROM refresh_tokens WHERE token=?",
            (req.refresh_token,),
        ).fetchone()

        if not record:
            raise HTTPException(status_code=401, detail="请重新登录")

        if record["expires"] < time.time():
            conn.execute("DELETE FROM refresh_tokens WHERE token=?", (req.refresh_token,))
            raise HTTPException(status_code=401, detail="登录已过期，请重新登录")

        username = record["username"]

        # Token 轮转：删除旧 token，生成新 token 对
        conn.execute("DELETE FROM refresh_tokens WHERE token=?", (req.refresh_token,))

        new_refresh_token = secrets.token_hex(32)
        now = int(time.time())
        conn.execute(
            "INSERT INTO refresh_tokens (token, username, expires, created_at) VALUES (?, ?, ?, ?)",
            (new_refresh_token, username, now + REFRESH_TOKEN_TTL_SECONDS, now),
        )

    new_access_token = create_token(username)

    return ok({
        "token": new_access_token,
        "refresh_token": new_refresh_token,
        "username": username,
    })
```

- [ ] **Step 2: 验证 — 完整刷新流程测试**

```bash
# 1. 先发验证码（开发模式会返回 dev_code）
CODE_RESP=$(curl -s -X POST http://localhost:8001/api/auth/send-code -H "Content-Type: application/json" -d '{"email":"test@test.com"}')
DEV_CODE=$(echo $CODE_RESP | python -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('dev_code',''))")
echo "Dev code: $DEV_CODE"

# 2. 验证码登录
LOGIN_RESP=$(curl -s -X POST http://localhost:8001/api/auth/verify-code -H "Content-Type: application/json" -d "{\"email\":\"test@test.com\",\"code\":\"$DEV_CODE\"}")
echo "Login: $LOGIN_RESP"
REFRESH_TOKEN=$(echo $LOGIN_RESP | python -c "import sys,json; print(json.load(sys.stdin)['data']['refresh_token'])")

# 3. 用 refresh_token 刷新
REFRESH_RESP=$(curl -s -X POST http://localhost:8001/api/auth/refresh -H "Content-Type: application/json" -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}")
echo "Refresh: $REFRESH_RESP"
NEW_TOKEN=$(echo $REFRESH_RESP | python -c "import sys,json; print(json.load(sys.stdin)['data']['token'])")
NEW_REFRESH=$(echo $REFRESH_RESP | python -c "import sys,json; print(json.load(sys.stdin)['data']['refresh_token'])")

# 4. 用新 access_token 调 /api/me 确认有效
ME_RESP=$(curl -s http://localhost:8001/api/me -H "Authorization: Bearer $NEW_TOKEN")
echo "Me: $ME_RESP"

# 5. 用旧 refresh_token 再次刷新应返回 401（轮转验证）
OLD_REFRESH_RESP=$(curl -s -X POST http://localhost:8001/api/auth/refresh -H "Content-Type: application/json" -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}")
echo "Old refresh (should be 401): $OLD_REFRESH_RESP"
```

期望：第 5 步返回 401 "请重新登录"。

- [ ] **Step 3: 提交**

```bash
git add main.py
git commit -m "feat: 新增 /api/auth/refresh 端点（token 轮转）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 后端 — 新增 /api/auth/logout 端点

**Files:**
- Modify: `C:\Users\32639\novel-copilot-backend\main.py`

**Interfaces:**
- Consumes: `refresh_tokens` 表（Task 1）、`get_user`（已有）
- Produces: `POST /api/auth/logout` — 删除 refresh_token

- [ ] **Step 1: 添加请求模型和端点**

在 `/api/auth/refresh` 端点之后添加：

```python

class LogoutRequest(BaseModel):
    refresh_token: str = Field(min_length=64, max_length=64)


@app.post("/api/auth/logout")
def logout(req: LogoutRequest, user=Depends(get_user)):
    """退出登录：作废 refresh_token"""
    with get_db() as conn:
        conn.execute("DELETE FROM refresh_tokens WHERE token=?", (req.refresh_token,))
    return ok({"message": "已退出登录"})
```

- [ ] **Step 2: 验证**

```bash
# 继续用 Task 3 的 token 测试
curl -s -X POST http://localhost:8001/api/auth/logout \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NEW_TOKEN" \
  -d "{\"refresh_token\":\"$NEW_REFRESH\"}"

# 然后用同样的 refresh_token 刷新应返回 401
curl -s -X POST http://localhost:8001/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refresh_token\":\"$NEW_REFRESH\"}"
```

期望：logout 返回成功，refresh 返回 401。

- [ ] **Step 3: 提交**

```bash
git add main.py
git commit -m "feat: 新增 /api/auth/logout 端点

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 扩展端 — popup.js 加入静默刷新

**Files:**
- Modify: `C:\Users\32639\novel-copilot-backend\JianLai_Helper\popup.js`

**Interfaces:**
- Consumes: 服务端 `/api/auth/refresh`、`/api/auth/logout`
- Produces: `getToken()` 返回带自动刷新的 token，`emailLogin()` 存储 refreshToken，`logout()` 调用服务端退出

- [ ] **Step 1: 改造 getToken() — 返回 token 并读 refreshToken**

替换原 `getToken()` 函数（第 75-79 行）：

```javascript
function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["token", "refreshToken", "username"], ({ token, refreshToken, username }) => resolve({ token, refreshToken, username }));
  });
}
```

- [ ] **Step 2: 新增 refreshAccessToken() 函数**

在 `getToken()` 之后、`isTokenExpired()` 之前添加：

```javascript
var _refreshPromise = null;

async function refreshAccessToken() {
  var stored = await getToken();
  var refreshToken = stored.refreshToken;
  if (!refreshToken) return null;

  // 防止并发刷新：多个调用共享同一个请求
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      var api = await getAPI();
      var resp = await fetch(api + "/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      if (!resp.ok) {
        // 服务端明确拒绝 → 清除本地状态
        if (resp.status === 401) {
          chrome.storage.local.remove(["token", "refreshToken", "username"]);
        }
        return null;
      }
      var data = await resp.json();
      if (!data.data || !data.data.token) return null;
      // 更新存储
      await new Promise((resolve) => {
        chrome.storage.local.set({
          token: data.data.token,
          refreshToken: data.data.refresh_token,
          username: data.data.username
        }, resolve);
      });
      return data.data.token;
    } catch (_) {
      // 网络错误不清除状态，下次重试
      return null;
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}
```

- [ ] **Step 3: 改造 renderState() 加入静默刷新**

将 `renderState()` 函数（第 89-147 行）中的开头部分：

```javascript
async function renderState() {
  loadApiUrl();
  var stored = await getToken();
  var token = stored.token;

  if (!token || isTokenExpired(token)) {
    if (token) {
      chrome.storage.local.remove(["token", "username"]);
      showMessage("登录已过期，请重新登录", "error");
    }
    // ...
```

替换为：

```javascript
async function renderState() {
  loadApiUrl();
  var stored = await getToken();
  var token = stored.token;

  // 如果 access_token 过期，尝试静默刷新
  if (!token && stored.refreshToken) {
    showMessage("正在恢复登录...");
    token = await refreshAccessToken();
    if (token) {
      showMessage("已恢复登录", "success");
    }
  }

  if (!token || isTokenExpired(token)) {
    if (token) {
      chrome.storage.local.remove(["token", "refreshToken", "username"]);
    }
    if (stored.refreshToken) {
      showMessage("登录已过期，请重新登录", "error");
    }
    // 未登录显示红点
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
    $("auth-box").style.display = "block";
    $("user-box").style.display = "none";
    return;
  }

  // 如果有 access_token 但即将过期（5分钟内），也主动刷新
  if (token && stored.refreshToken) {
    try {
      var payload = JSON.parse(atob(token.split(".")[1]));
      var expiresIn = (payload.exp || 0) * 1000 - Date.now();
      if (expiresIn < 300000) {  // 5 分钟
        var newToken = await refreshAccessToken();
        if (newToken) token = newToken;
      }
    } catch (_) {}
  }

  // ... 后续 /api/me 调用保持不变
```

注意：`renderState()` 函数后面调用 `/api/me` 的部分保持不变，直接衔接。

- [ ] **Step 4: 改造 emailLogin() 存储 refreshToken**

将 `emailLogin()` 中的 `chrome.storage.local.set` 调用（第 219-222 行）：

```javascript
    chrome.storage.local.set({
      token: data.token,
      username: data.username
    }, function () {
```

替换为：

```javascript
    chrome.storage.local.set({
      token: data.token,
      refreshToken: data.refresh_token,
      username: data.username
    }, function () {
```

- [ ] **Step 5: 改造 logout() 调用服务端并清除 refreshToken**

替换 `logout()` 函数（第 331-338 行）：

```javascript
async function logout() {
  var stored = await getToken();
  // 通知服务端作废 refresh_token（fire-and-forget）
  if (stored.refreshToken && stored.token) {
    try {
      var api = await getAPI();
      fetch(api + "/api/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + stored.token
        },
        body: JSON.stringify({ refresh_token: stored.refreshToken })
      });
    } catch (_) {}
  }
  chrome.storage.local.remove(["token", "refreshToken", "username"], () => {
    $("user-greeting").style.display = "none";
    clearBadge();
    showMessage("已退出登录");
    renderState();
  });
}
```

- [ ] **Step 6: 验证 — 手动测试刷新流程**

在 Chrome 中加载扩展：
1. 邮箱验证码登录 → 确认 `chrome.storage.local` 中有 `refreshToken`
2. 退出登录 → 确认 storage 被清除
3. 修改本地 token 的 exp 为过去时间 → 打开 popup → 确认自动恢复登录
4. 删除 refreshToken → 打开 popup → 确认显示登录表单

- [ ] **Step 7: 提交**

```bash
git add JianLai_Helper/popup.js
git commit -m "feat: popup.js 加入 refresh token 静默刷新逻辑

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 扩展端 — content.js 加入静默刷新

**Files:**
- Modify: `C:\Users\32639\novel-copilot-backend\JianLai_Helper\content.js`

**Interfaces:**
- Consumes: 服务端 `/api/auth/refresh`
- Produces: `getToken()` 返回带自动刷新的 token

- [ ] **Step 1: 添加 refreshAccessToken() 到 content.js**

在 `getToken()` 函数（第 136-152 行）之前添加：

```javascript
  var _refreshPromise = null;

  async function refreshAccessToken() {
    return new Promise(async (resolve) => {
      chrome.storage.local.get(["refreshToken"], async ({ refreshToken }) => {
        if (!refreshToken) { resolve(null); return; }

        if (_refreshPromise) { resolve(await _refreshPromise); return; }
        _refreshPromise = (async () => {
          try {
            var api = await getAPI();
            var resp = await fetch(api + "/api/auth/refresh", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refresh_token: refreshToken })
            });
            if (!resp.ok) {
              if (resp.status === 401) {
                chrome.storage.local.remove(["token", "refreshToken", "username"]);
              }
              return null;
            }
            var data = await resp.json();
            if (!data.data || !data.data.token) return null;
            await new Promise((r) => {
              chrome.storage.local.set({
                token: data.data.token,
                refreshToken: data.data.refresh_token,
                username: data.data.username
              }, r);
            });
            return data.data.token;
          } catch (_) { return null; }
          finally { _refreshPromise = null; }
        })();
        resolve(await _refreshPromise);
      });
    });
  }
```

- [ ] **Step 2: 改造 content.js 的 getToken() 加入自动刷新**

替换 `getToken()` 函数（第 136-152 行）：

```javascript
  function getToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["token", "refreshToken"], async function (result) {
        var token = result.token;
        var refreshToken = result.refreshToken;

        // 检测 access_token 是否过期
        if (token) {
          try {
            var payload = JSON.parse(atob(token.split(".")[1]));
            if ((payload.exp || 0) * 1000 < Date.now()) {
              token = null;
            }
          } catch (_) { token = null; }
        }

        // 过期但有 refreshToken → 尝试静默刷新
        if (!token && refreshToken) {
          token = await refreshAccessToken();
        }

        resolve(token);
      });
    });
  }
```

- [ ] **Step 3: 验证**

在 Chrome 中：
1. 登录后打开小说页面 → 确认分析功能正常
2. 修改 storage 中 token 的 exp 为过去时间 → 刷新页面 → 点分析 → 确认自动恢复并正常工作

- [ ] **Step 4: 提交**

```bash
git add JianLai_Helper/content.js
git commit -m "feat: content.js 加入 refresh token 静默刷新

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 服务器部署

**Files:**
- Modify: 服务器 `C:\Users\32639\novel-copilot-backend\.env`（服务器 `/opt/novel-copilot-backend/.env`）

- [ ] **Step 1: 推送代码到 GitHub**

```bash
cd C:\Users\32639\novel-copilot-backend && git push origin main
```

- [ ] **Step 2: 更新服务器代码并重启**

```bash
ssh root@8.134.8.50 "cd /opt/novel-copilot-backend && git pull && systemctl restart novel-copilot"
```

- [ ] **Step 3: 验证服务器端点**

```bash
curl -s https://jianla.xyz:8000/api/health
```

期望：`{"status":"ok"}`。

- [ ] **Step 4: 更新 Chrome 扩展**

重新打包扩展并在 Chrome 中更新（或通过 CWS 更新）。

- [ ] **Step 5: 提交（如有文档更新）**

```bash
git add . && git commit -m "docs: 添加 refresh token 实现计划

Co-Authored-By: Claude <noreply@anthropic.com>"
```
