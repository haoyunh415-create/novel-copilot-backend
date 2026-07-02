const $ = (id) => document.getElementById(id);

let isStarting = false;

function getAPI() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["api_url"], ({ api_url }) => {
      resolve(api_url || "https://jianla.xyz:8000");
    });
  });
}

function setAPI(url) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ api_url: url }, resolve);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  $("login").addEventListener("click", login);
  $("register").addEventListener("click", register);
  $("start").addEventListener("click", startAnalyze);
  $("logout").addEventListener("click", logout);
  $("save-api").addEventListener("click", saveApiUrl);
  $("send-code-btn").addEventListener("click", sendEmailCode);
  $("email-login-btn").addEventListener("click", emailLogin);
  $("toggle-pwd-login").addEventListener("click", togglePwdLogin);
  $("forgot-pwd-link").addEventListener("click", showForgotPwd);
  $("back-to-login").addEventListener("click", hideForgotPwd);
  $("send-reset-code-btn").addEventListener("click", sendResetCode);
  $("reset-pwd-btn").addEventListener("click", doResetPassword);
  // 套餐按钮
  document.querySelectorAll(".buy-plan-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { buy(btn.dataset.plan); });
  });
  renderState();
});

function showMessage(text, type) {
  const el = $("message");
  el.textContent = text || "";
  el.className = type || "";
}

function setLoading(buttonId, loading) {
  const button = $(buttonId);
  button.disabled = loading;
}

async function apiFetch(path, options = {}) {
  const API = await getAPI();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(API + path, { ...options, headers });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data) {
    throw new Error("服务暂时不可用，请稍后再试");
  }

  if (!data.success) {
    throw new Error(data.error || "请求失败");
  }

  return data.data;
}

function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["token", "username"], ({ token, username }) => resolve({ token, username }));
  });
}

function isTokenExpired(token) {
  if (!token) return true;
  try {
    var payload = JSON.parse(atob(token.split(".")[1]));
    return (payload.exp || 0) * 1000 < Date.now();
  } catch (_) { return true; }
}

async function renderState() {
  loadApiUrl();
  var stored = await getToken();
  var token = stored.token;

  if (!token || isTokenExpired(token)) {
    if (token) {
      chrome.storage.local.remove(["token", "username"]);
      showMessage("登录已过期，请重新登录", "error");
    }
    $("auth-box").style.display = "block";
    $("user-box").style.display = "none";
    return;
  }

  try {
    var me = await apiFetch("/api/me", {
      headers: { Authorization: "Bearer " + token }
    });

    var creditsEl = $("credits-text");
    creditsEl.textContent = me.credits;
    if (me.credits <= 5) creditsEl.classList.add("low");
    else creditsEl.classList.remove("low");

    // 显示用户名
    $("display-username").textContent = stored.username || "用户";
    $("user-greeting").style.display = "flex";

    // 低额度提醒
    var lowMsg = $("credit-low-msg");
    if (me.credits <= 5) {
      lowMsg.style.display = "block";
      lowMsg.textContent = me.credits === 0
        ? "额度已用完！每天签到免费领 5 次，现在就去刷新吧"
        : "仅剩 " + me.credits + " 次额度，每天签到免费领 5 次";
    } else {
      lowMsg.style.display = "none";
    }

    if (me.daily_bonus > 0) {
      showMessage("✨ " + me.message, "success");
    }
    $("auth-box").style.display = "none";
    $("user-box").style.display = "block";
    showMessage("");
  } catch (error) {
    chrome.storage.local.remove(["token"]);
    $("auth-box").style.display = "block";
    $("user-box").style.display = "none";
    showMessage(error.message);
  }
}

async function login() {
  const username = $("username").value.trim();
  const password = $("password").value;

  if (!username || !password) {
    showMessage("请输入用户名和密码");
    return;
  }

  setLoading("login", true);
  showMessage("正在登录...");

  try {
    const data = await apiFetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    chrome.storage.local.set({ token: data.token, username: username }, function () {
      showPostLoginGuide();
      renderState();
    });
  } catch (error) {
    showMessage(error.message);
  } finally {
    setLoading("login", false);
  }
}

async function register() {
  const username = $("username").value.trim();
  const password = $("password").value;

  if (!username || !password) {
    showMessage("请输入用户名和密码");
    return;
  }

  setLoading("register", true);
  showMessage("正在注册...");

  try {
    await apiFetch("/api/register", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    showMessage("注册成功，现在可以登录");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setLoading("register", false);
  }
}

// ── 邮箱验证码登录 ──

var _sendCodeCooldown = 0;

function togglePwdLogin() {
  var pwd = $("pwd-login");
  var btn = $("toggle-pwd-login");
  if (pwd.style.display === "none") {
    pwd.style.display = "block";
    btn.textContent = "收起用户名密码登录";
  } else {
    pwd.style.display = "none";
    btn.textContent = "使用用户名密码登录";
  }
}

async function sendEmailCode() {
  var email = $("login-email").value.trim();
  if (!email || email.indexOf("@") === -1) {
    showMessage("请输入有效的邮箱地址", "error");
    return;
  }

  var now = Date.now();
  if (now - _sendCodeCooldown < 60000) {
    showMessage("请等待 60 秒后再发送", "error");
    return;
  }

  setLoading("send-code-btn", true);
  var btn = $("send-code-btn");
  btn.textContent = "发送中...";

  try {
    await apiFetch("/api/auth/send-code", {
      method: "POST",
      body: JSON.stringify({ email: email })
    });
    _sendCodeCooldown = Date.now();
    showMessage("验证码已发送，请查收邮件", "success");

    // 倒计时
    var sec = 60;
    btn.disabled = true;
    var timer = setInterval(function () {
      sec--;
      btn.textContent = sec + "s 后重发";
      if (sec <= 0) {
        clearInterval(timer);
        btn.textContent = "获取验证码";
        btn.disabled = false;
      }
    }, 1000);
  } catch (error) {
    showMessage(error.message, "error");
    btn.textContent = "获取验证码";
    setLoading("send-code-btn", false);
  }
}

async function emailLogin() {
  var email = $("login-email").value.trim();
  var code = $("login-code").value.trim();

  if (!email || email.indexOf("@") === -1) {
    showMessage("请输入有效的邮箱地址", "error");
    return;
  }
  if (code.length !== 6) {
    showMessage("请输入 6 位验证码", "error");
    return;
  }

  setLoading("email-login-btn", true);
  showMessage("正在验证...");

  try {
    var data = await apiFetch("/api/auth/verify-code", {
      method: "POST",
      body: JSON.stringify({ email: email, code: code })
    });

    chrome.storage.local.set({
      token: data.token,
      username: data.username
    }, function () {
      showMessage(data.is_new ? "欢迎注册！已领取 30 次额度" : "登录成功", "success");
      $("login-code").value = "";
      // 登录后引导
      showPostLoginGuide();
      renderState();
    });
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setLoading("email-login-btn", false);
  }
}

function showPostLoginGuide() {
  var msg = $("message");
  msg.className = "success";
  msg.innerHTML = '登录成功！<br><span style="font-size:10px;opacity:.8">📖 打开任意小说页面 → 点"分析当前章节"即可开始</span>';
  setTimeout(function () { msg.innerHTML = ""; msg.className = ""; }, 5000);
}

// ── 忘记密码 ──

function showForgotPwd() {
  $("email-login").style.display = "none";
  $("forgot-pwd-box").style.display = "block";
  document.querySelector("#auth-box .btn-ghost").style.display = "none";
  showMessage("");
}

function hideForgotPwd() {
  $("email-login").style.display = "block";
  $("forgot-pwd-box").style.display = "none";
  document.querySelector("#auth-box .btn-ghost").style.display = "";
  showMessage("");
}

async function sendResetCode() {
  var identifier = $("reset-identifier").value.trim();
  if (!identifier) {
    showMessage("请输入用户名或邮箱", "error");
    return;
  }
  setLoading("send-reset-code-btn", true);
  try {
    await apiFetch("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ username_or_email: identifier })
    });
    showMessage("如果账号存在且绑定了邮箱，验证码已发送", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setLoading("send-reset-code-btn", false);
  }
}

async function doResetPassword() {
  var identifier = $("reset-identifier").value.trim();
  var code = $("reset-code").value.trim();
  var newPwd = $("new-password").value;

  if (!identifier || code.length !== 6 || newPwd.length < 6) {
    showMessage("请填写所有字段（密码至少6位）", "error");
    return;
  }
  setLoading("reset-pwd-btn", true);
  try {
    await apiFetch("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ username_or_email: identifier, code: code, new_password: newPwd })
    });
    showMessage("密码已重置，请返回登录", "success");
    setTimeout(hideForgotPwd, 1500);
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setLoading("reset-pwd-btn", false);
  }
}

async function startAnalyze() {
  if (isStarting) return;

  isStarting = true;
  setLoading("start", true);
  showMessage("正在打开章节助手...");

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) {
      showMessage("没有找到当前标签页");
      isStarting = false;
      setLoading("start", false);
      return;
    }

    // 尝试直接发消息
    chrome.tabs.sendMessage(tab.id, { action: "START_ANALYZE" }, (response) => {
      const error = chrome.runtime.lastError;
      if (response?.ok || !error) {
        showMessage("已打开章节助手");
        setTimeout(() => {
          isStarting = false;
          setLoading("start", false);
        }, 1200);
        return;
      }
      // 发消息失败 → 用 scripting API 主动注入
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          files: ["vis-network.min.js", "content.js"]
        },
        () => {
          const injectError = chrome.runtime.lastError;
          if (injectError) {
            showMessage("请在浏览器打开的网页上使用（不是系统页面）");
            isStarting = false;
            setLoading("start", false);
            return;
          }
          // 注入成功后等一小会再发消息
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { action: "START_ANALYZE" }, () => {
              showMessage("已打开章节助手");
              isStarting = false;
              setLoading("start", false);
            });
          }, 400);
        }
      );
    });
  });
}

async function buy(plan) {
  var token = await getToken();
  if (!token) {
    showMessage("请先登录", "error");
    return;
  }

  var planInfo = {
    basic:   { name: "100 次额度包", amount: "9.9", credits: 100 },
    pro:     { name: "300 次额度包", amount: "19.9", credits: 300 },
    monthly: { name: "月卡（30天无限）", amount: "19.9", credits: 0 },
    earlybird: { name: "早鸟高级版", amount: "49.0", credits: 2000 },
    lifetime: { name: "早鸟永久版", amount: "99.0", credits: 9999 },
  };
  var info = planInfo[plan] || { name: plan, amount: "?", credits: 0 };

  // 高亮选中按钮
  document.querySelectorAll(".buy-plan-btn").forEach(function (b) {
    b.classList.toggle("selected", b.dataset.plan === plan);
  });

  showMessage("正在处理...");

  try {
    var data = await apiFetch("/api/buy", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: JSON.stringify({ plan: plan })
    });

    var resultDiv = $("buy-result");
    resultDiv.style.display = "block";

    if (data.added) {
      // Mock 模式：直接到账
      resultDiv.innerHTML =
        '<div class="buy-result-card success">' +
          '<div class="big">✅ 购买成功！</div>' +
          '<div>' + info.name + ' · ¥' + info.amount + '</div>' +
          '<div>额度已到账：<b>+' + data.added + ' 次</b></div>' +
        '</div>';
      showMessage("", "");
    } else {
      // 真实支付模式
      var apiBase = await getAPI();
      var payUrl = apiBase + (data.pay_url || "/pay/" + (data.order_id || ""));
      resultDiv.innerHTML =
        '<div class="buy-result-card pending">' +
          '<div class="big">📦 ' + info.name + '</div>' +
          '<div style="margin:4px 0">金额：<b>¥' + info.amount + '</b></div>' +
          '<a href="' + payUrl + '" target="_blank" style="display:block;margin:8px 0;padding:8px;border-radius:6px;background:#fff;color:#1565C0;text-align:center;text-decoration:none;font-weight:600;font-size:12px;border:1px solid #BBDEFB">📱 打开支付页面</a>' +
          '<div style="font-size:10px;color:#6D6D6D">支付完成后联系客服确认到账</div>' +
          '<div style="margin-top:4px;font-size:10px;opacity:.6">订单号：#' + (data.order_id || "?") + '</div>' +
        '</div>';
    }
    renderState();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function saveApiUrl() {
  const url = $("api-url").value.trim();
  if (!url) {
    showMessage("请输入服务器地址");
    return;
  }
  await setAPI(url);
  showMessage("服务器地址已保存");
  // 刷新状态
  renderState();
}

async function loadApiUrl() {
  const api = await getAPI();
  $("api-url").value = api;
}

function logout() {
  chrome.storage.local.remove(["token", "username"], () => {
    $("user-greeting").style.display = "none";
    showMessage("已退出登录");
    renderState();
  });
}
