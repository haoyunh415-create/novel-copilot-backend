const $ = (id) => document.getElementById(id);

let isStarting = false;

function getAPI() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["api_url"], ({ api_url }) => {
      resolve(api_url || "http://127.0.0.1:8000");
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
  $("buy").addEventListener("click", buy);
  $("logout").addEventListener("click", logout);
  $("save-api").addEventListener("click", saveApiUrl);
  renderState();
});

function showMessage(text) {
  $("message").textContent = text || "";
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
    chrome.storage.local.get(["token"], ({ token }) => resolve(token));
  });
}

async function renderState() {
  loadApiUrl();
  const token = await getToken();

  if (!token) {
    $("auth-box").style.display = "block";
    $("user-box").style.display = "none";
    return;
  }

  try {
    const me = await apiFetch("/api/me", {
      headers: { Authorization: `Bearer ${token}` }
    });

    $("credits").textContent = me.credits;
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

    chrome.storage.local.set({ token: data.token }, renderState);
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
    showMessage(error.message);
  } finally {
    setLoading("register", false);
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

async function buy() {
  const token = await getToken();
  if (!token) {
    showMessage("请先登录");
    return;
  }

  const plan = document.getElementById("plan-select").value;
  setLoading("buy", true);
  showMessage("正在创建购买请求...");

  try {
    const data = await apiFetch("/api/buy", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan })
    });

    showMessage(data.message || "已创建购买请求");
    renderState();
  } catch (error) {
    showMessage(error.message);
  } finally {
    setLoading("buy", false);
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
  chrome.storage.local.remove(["token"], () => {
    showMessage("已退出登录");
    renderState();
  });
}
