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
  $("start").addEventListener("click", startAnalyze);
  $("logout").addEventListener("click", logout);
  $("save-api").addEventListener("click", saveApiUrl);
  $("toggle-advanced").addEventListener("click", function () {
    var box = $("advanced-settings");
    var btn = $("toggle-advanced");
    if (box.style.display === "none") {
      box.style.display = "block";
      btn.textContent = "⚙ 收起设置";
    } else {
      box.style.display = "none";
      btn.textContent = "⚙ 高级设置";
    }
  });
  $("send-code-btn").addEventListener("click", sendEmailCode);
  $("email-login-btn").addEventListener("click", emailLogin);
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
    // 未登录显示红点
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
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

    // 扩展角标显示剩余次数
    updateBadge(me.credits);

    // 显示用户名
    $("display-username").textContent = stored.username || "用户";
    $("user-greeting").style.display = "flex";

    // 低额度提醒
    var lowMsg = $("credit-low-msg");
    if (me.credits <= 5) {
      lowMsg.style.display = "block";
      lowMsg.textContent = me.credits === 0
        ? "额度已用完！每天签到免费领 8 次，现在就去刷新吧"
        : "仅剩 " + me.credits + " 次额度，每天签到免费领 8 次";
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

// ── 邮箱验证码登录（唯一登录方式）──

var _sendCodeCooldown = 0;

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
      showMessage(data.is_new ? "欢迎注册！已领取 10 次额度" : "登录成功", "success");
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
  // 支付功能暂未开放
  showMessage("💳 微信支付接入中，敬请期待！", "info");
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

function updateBadge(credits) {
  var text = credits > 99 ? "99+" : String(credits);
  var color = credits <= 0 ? "#c62828" : credits <= 5 ? "#e65100" : "#2e7d32";
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: color });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}

function logout() {
  chrome.storage.local.remove(["token", "username"], () => {
    $("user-greeting").style.display = "none";
    clearBadge();
    showMessage("已退出登录");
    renderState();
  });
}
