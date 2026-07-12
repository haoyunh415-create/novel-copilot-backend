# Refresh Token 设计文档

**日期**：2026-07-12
**目标**：实现"记住登录状态"——用户登录后可保持 30 天，无需频繁重收邮箱验证码。

---

## 背景

当前鉴来助手的认证系统：

- 唯一登录方式：邮箱验证码
- JWT access token 有效期：24 小时
- 没有 refresh token 机制
- Token 过期后用户必须重新收邮件验证码登录

**痛点**：用户每天都得重新登录，体验差。需要一个"记住登录"功能。

---

## 方案选择

采用 **Refresh Token + Token 轮转** 方案。

| 方案 | 描述 | 判定 |
|------|------|------|
| A: Refresh Token + 轮转 | 短期 access_token + 长期 refresh_token | ✅ 选用 |
| B: 直接延长 access_token 到 30 天 | 改环境变量 | ❌ 安全风险，无法撤销 |
| C: 服务端 Session | 废弃 JWT，用 Cookie | ❌ Chrome 扩展不适合 Cookie |

---

## 架构设计

### Token 体系

| Token 类型 | 格式 | 有效期 | 用途 |
|------------|------|--------|------|
| Access Token | JWT (HS256) | 24 小时 | 日常 API 鉴权（Bearer header） |
| Refresh Token | 64 字符随机十六进制串 | 30 天 | 换取新的 access_token |

**Refresh Token 为什么不用 JWT？** JWT 是无状态的，签发后无法撤销。随机串存在数据库中，支持随时删除实现撤销（退出登录、检测被盗用）。

### 刷新流程

```
用户使用扩展
    ↓
检查 access_token 是否过期
    ├── 未过期 → 直接调用 API
    └── 已过期 → 用 refresh_token 静默刷新
                    ├── 成功 → 更新本地 token，继续调用 API
                    └── 失败 → 清除登录状态，显示登录表单
```

### Token 轮转

每次调用 refresh 接口时：
1. 验证旧 refresh_token 有效
2. 删除旧 refresh_token
3. 生成新的 refresh_token 并存入数据库
4. 返回新 access_token + 新 refresh_token

**安全意义**：如果 refresh_token 被窃取，合法用户下次刷新时会发现 token 失效（因为旧 token 已被攻击者使用并被轮转掉），攻击面被限制在单次使用窗口内。

---

## 数据库变更

### 新增表：`refresh_tokens`

```sql
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    expires INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0
);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 自增主键 |
| `token` | TEXT UNIQUE | 64 字符随机十六进制串 |
| `username` | TEXT | 关联的用户名 |
| `expires` | INTEGER | 过期时间戳（Unix timestamp） |
| `created_at` | INTEGER | 创建时间戳 |

建表语句在 `init_db()` 中追加，服务启动时自动创建。

---

## 后端 API 变更

### 新增配置项

`.env` 添加：

```
REFRESH_TOKEN_TTL_SECONDS=2592000
```

(30 天 = 30 × 24 × 3600 = 2,592,000 秒)

### 修改：`POST /api/auth/verify-code`（登录）

**新增返回字段**：

```json
{
  "token": "eyJ...（24h access_token）",
  "refresh_token": "a1b2c3...（30天 refresh_token）",
  "username": "test",
  "credits": 10,
  "is_new": false
}
```

**实现要点**：
- 调用 `create_token(username)` 生成 access_token（不变）
- 额外调用 `secrets.token_hex(32)` 生成 64 字符 refresh_token
- 将 refresh_token 存入 `refresh_tokens` 表

### 新增：`POST /api/auth/refresh`

**请求体**：
```json
{ "refresh_token": "a1b2c3..." }
```

**逻辑**：
1. 在 `refresh_tokens` 表中查找该 token
2. 不存在 → 401 `{"detail": "请重新登录"}`
3. 已过期 → 删除记录 → 401 `{"detail": "登录已过期，请重新登录"}`
4. 有效 → 删除旧 token，生成新 access_token + 新 refresh_token，返回

**返回体**：
```json
{
  "token": "eyJ...（新 access_token）",
  "refresh_token": "d4e5f6...（新 refresh_token）",
  "username": "test"
}
```

**附带清理**：每次请求时执行 `DELETE FROM refresh_tokens WHERE expires < ?` 清理过期记录。

**限流**：使用 `refresh` 分类，每 IP 10 次/60 秒。

### 新增：`POST /api/auth/logout`

**认证**：需要 Bearer JWT

**请求体**：
```json
{ "refresh_token": "a1b2c3..." }
```

**逻辑**：从 `refresh_tokens` 表中删除该 token。

**为什么需要**：用户主动退出时，服务端的 refresh_token 需要作废，否则被窃取的旧 token 仍可用来刷新。

---

## Chrome 扩展端变更

### 存储

`chrome.storage.local` 新增一个 key：

| Key | 类型 | 说明 |
|-----|------|------|
| `token` | string | access_token（JWT，24h） |
| `refreshToken` | string | refresh_token（随机串，30天）—— **新增** |
| `username` | string | 用户名 |

### 新增函数

#### `refreshAccessToken()`

```
1. 从 storage 读取 refreshToken
2. 如果没有 refreshToken → 返回 null
3. POST /api/auth/refresh { refresh_token: refreshToken }
4. 成功 → storage.set({ token: data.token, refreshToken: data.refresh_token })，返回 data.token
5. 失败 → storage.remove(["token", "refreshToken", "username"])，返回 null
```

#### `getToken()` 改造

```
现有逻辑：
  检查 token 是否过期 → 过期返回 null → UI 显示登录框

改造后：
  1. 从 storage 读取 token 和 refreshToken
  2. token 未过期 → 直接返回 token
  3. token 已过期 + 有 refreshToken → await refreshAccessToken()
     → 成功：返回新 token
     → 失败：返回 null
  4. 都没有 → 返回 null
```

#### `logout()` 改造

```
现有逻辑：
  storage.remove(["token", "username"]) + 清除 badge

改造后：
  1. 如果有 refreshToken → POST /api/auth/logout（fire-and-forget，不等待）
  2. storage.remove(["token", "refreshToken", "username"])
  3. 清除 badge
```

### 渲染逻辑

`renderState()` 中保持现有的 token 过期检查，但 `getToken()` 现在会自动刷新，所以大部分情况下 token 都是有效的。

`popup.js` 中 `isTokenExpired()` 保持不变，仍用于 UI 判断。

---

## 边缘情况处理

### 并发刷新（竞态）

**场景**：多个标签页同时检测到 token 过期，同时调 refresh。

**处理**：
- 服务端：第一个请求成功（旧 token 被轮转掉），后续请求因旧 token 不存在而返回 401。
- 扩展端：刷新失败时清除本地状态。使用 `isRefreshing` 标记 + Promise 等待队列，让并发的 `getToken()` 调用共享同一次刷新结果，避免重复请求。

### 30 天后期满

refresh_token 过期 → 静默刷新返回 401 → 清除本地状态 → 显示登录表单。用户体验：每 30 天需要重新收一次验证码，而不是每天。

### 网络错误

刷新请求因网络问题失败时，保留本地登录状态不删除。下次请求时自动重试。只有服务端明确返回 401（token 真的失效了）时才清除登录状态。

### 向后兼容

老版本扩展没有 `refreshToken` 字段 → `getToken()` 检测到 `refreshToken` 不存在 → 跳过刷新逻辑 → 走原来的"过期就弹登录框"路径。零影响。

---

## 不涉及的范围

- 不依赖 refresh token 做自动登录（不需要 cookie/session）
- 不需要多设备管理（一个用户可以有多条 refresh_token 记录）
- 不需要记录设备信息
- 不需要强制下线其他设备的功能

---

## 实现文件清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `main.py` | 修改 | 新增 `refresh_tokens` 表、refresh/logout 端点、修改登录返回 |
| `.env` / `.env.example` | 修改 | 新增 `REFRESH_TOKEN_TTL_SECONDS` |
| `JianLai_Helper/popup.js` | 修改 | 存储/刷新/退出逻辑 |
| `JianLai_Helper/content.js` | 修改 | `getToken()` 加入静默刷新 |

---

## 验收标准

1. 登录成功后，`chrome.storage.local` 中存储了 `token` 和 `refreshToken`
2. Access token 过期后，扩展自动静默刷新，用户无感知
3. Refresh token 过期后，扩展显示登录表单
4. 退出登录后，服务端 refresh_token 被删除
5. 重复调用 refresh 使用同一个旧 token 时，第二次返回 401
6. 老版本扩展（不带 refreshToken）不受影响
