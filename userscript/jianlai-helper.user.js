// ==UserScript==
// @name         鉴来助手 - 小说 AI 伏笔雷达
// @namespace    https://jianla.xyz
// @version      2.3.11
// @description  为长篇小说提供无剧透前情提要、伏笔提示和人物关系图。支持 25+ 主流小说阅读平台，桌面油猴与手机浏览器（Alook/Via/X浏览器）均可使用。
// @author       鉴来助手
// @homepageURL  https://jianla.xyz
// @supportURL   https://novel-copilot-backend.pages.dev/support.html
// @updateURL    https://jianla.xyz/static/jianlai-helper.user.js
// @downloadURL  https://jianla.xyz/static/jianlai-helper.user.js
// @match        *://*.qidian.com/*
// @match        *://*.zongheng.com/*
// @match        *://*.17k.com/*
// @match        *://*.jjwxc.net/*
// @match        *://*.qimao.com/*
// @match        *://*.fanqienovel.com/*
// @match        *://*.biquga.com/*
// @match        *://*.xbiquge.com/*
// @match        *://*.hetushu.com/*
// @match        *://*.soxs.cc/*
// @match        *://*.trxs.cc/*
// @match        *://*.ptwxz.com/*
// @match        *://*.bqgoo.cc/*
// @match        *://*.pinggoua.com/*
// @match        *://*.yckceo.com/*
// @require      https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  if (window.__jianlai_userscript_loaded__) return;
  window.__jianlai_userscript_loaded__ = true;

  // ═══════════ 环境适配层 ═══════════
  // 桌面油猴（Tampermonkey/Violentmonkey，同步 GM_*）：登录态跨小说站共享
  // Alook/Via/X浏览器（无 GM API）及 Greasemonkey 4 / iOS Userscripts（仅异步 GM.*）：
  // 降级 localStorage，登录态按站点隔离
  var store = {
    hasGM: typeof GM_getValue === "function" && typeof GM_setValue === "function",
    get: function (key) {
      try {
        if (store.hasGM) {
          var v = GM_getValue(key);
          return v === undefined || v === null || v === "" ? null : String(v);
        }
        return localStorage.getItem("JLUS_" + key);
      } catch (_) { return null; }
    },
    set: function (key, value) {
      try {
        if (store.hasGM) { GM_setValue(key, String(value)); return; }
        localStorage.setItem("JLUS_" + key, String(value));
      } catch (_) {}
    },
    remove: function (key) {
      try {
        if (store.hasGM) {
          if (typeof GM_deleteValue === "function") GM_deleteValue(key);
          else GM_setValue(key, "");
          return;
        }
        localStorage.removeItem("JLUS_" + key);
      } catch (_) {}
    }
  };

  // ═══════════ CSP 绕过层 ═══════════
  var _nativeFetch = window.fetch;
  function safeFetch(url, options) {
    if (url.indexOf("jianla.xyz") !== -1 && typeof GM_xmlhttpRequest === "function") {
      return new Promise(function(resolve, reject) {
        var headers = (options && options.headers) || {};
        GM_xmlhttpRequest({
          url: url,
          method: (options && options.method) || "GET",
          headers: headers,
          data: (options && options.body) || undefined,
          timeout: 120000,
          onload: function(resp) {
            var text = resp.responseText;
            var isSSE = text.indexOf("data: ") === 0;
            var ct = isSSE ? "text/event-stream" : "";
            var body = null;
            if (typeof ReadableStream !== "undefined" && typeof TextEncoder !== "undefined") {
              try {
                body = new ReadableStream({
                  start: function(controller) {
                    controller.enqueue(new TextEncoder().encode(text));
                    controller.close();
                  }
                });
              } catch (_) {}
            }
            resolve({
              ok: resp.status >= 200 && resp.status < 300,
              status: resp.status,
              headers: { get: function(name) { return name === "content-type" ? ct : null; } },
              body: body,
              json: function() {
                if (isSSE) return Promise.reject(new Error("SSE response"));
                return Promise.resolve(JSON.parse(text));
              },
              text: function() { return Promise.resolve(text); }
            });
          },
          onerror: function() { reject(new Error("网络请求失败，请检查网络连接")); },
          ontimeout: function() { reject(new Error("请求超时，请稍后重试")); }
        });
      });
    }
    return _nativeFetch(url, options);
  }

  const MIN_INTERVAL_MS = 5000;
  let lastCallTime = 0;
  let isRunning = false;
  let network = null;
  let _currentBookId = (function () { try { var v = store.get("currentBookId"); return v ? parseInt(v, 10) : null; } catch (_) { return null; } })();
  let _currentBookTitle = (function () { try { return store.get("currentBookTitle") || null; } catch (_) { return null; } })();
  let _graphMode = "chapter";  // "chapter" | "book"
  let _historySortMode = (function () { try { return localStorage.getItem("JL_HistSort") || "time"; } catch (_) { return "time"; } })();
  let _lastFailedQuestion = null;
  let _serverAnalysisMap = {};  // 章节→服务端分析数据映射

  // ═══════════ 页面信息提取 ═══════════

  function getChapterTitle() {
    // SPA 优先：document.title 在导航后准确更新（如"第2章 劫修 - 起点"）
    var dt = document.title.trim();
    var m = dt.match(/第[0-9零一二三四五六七八九十百千]+[章节回]\s*.*?(?=在线免费阅读|免费阅读|在线阅读|最新章节|_|-|—|$)/);
    if (m && m[0].trim().length >= 2) return m[0].trim().substring(0, 80);
    // 特定选择器
    var specificSelectors = [
      ".muye-reader-title",
      ".j_chapterName", ".chapter-name", ".chaptername",
      ".chapter-title", ".chapterTitle",
      ".article-title", ".post-title", ".entry-title",
      ".title",
    ];
    for (var si = 0; si < specificSelectors.length; si++) {
      var el = document.querySelector(specificSelectors[si]);
      var text = el && el.innerText && el.innerText.trim();
      if (text && text.length >= 2 && text.length < 200) return text;
    }
    // 移动端滚动：找视口内最近的章节标题（用户正在读的章节，而非页面第一个）
    var headings = document.querySelectorAll("h1, h2");
    var chapterPattern = /第[0-9零一二三四五六七八九十百千]+[章节回]/;
    var bestEl = null, bestDist = Infinity;
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      if (!chapterPattern.test(h.textContent.trim())) continue;
      var rect = h.getBoundingClientRect();
      if (rect.top <= 200) {
        var dist = 60 - rect.top;
        if (dist < bestDist) { bestDist = dist; bestEl = h; }
      }
    }
    if (bestEl) return bestEl.innerText.trim();
    // 兜底：取第一个章节标题
    for (var j = 0; j < headings.length; j++) {
      if (chapterPattern.test(headings[j].textContent.trim()))
        return headings[j].innerText.trim();
    }
    var title = document.title.trim();
    var sep = title.lastIndexOf(" - ");
    if (sep > 0) return title.substring(0, sep).trim();
    return title || "未命名章节";
  }


  // 查找章节标题所在 DOM 元素（用于锚定内容范围）
  function findChapterTitleElement() {
    const titleSelectors = [
      ".muye-reader-title",
      ".j_chapterName", ".chapter-name", ".chaptername",
      "h1", "h2", ".title", ".chapter-title", ".chapterTitle",
      "[class*='chapter'] h1", "[class*='chapter'] h2",
      ".article-title", ".post-title", ".entry-title",
      ".reader-title", ".chapter-heading",
    ];
    for (var i = 0; i < titleSelectors.length; i++) {
      var el = document.querySelector(titleSelectors[i]);
      var text = el && el.innerText && el.innerText.trim();
      if (text && text.length >= 2 && text.length < 200) return el;
    }
    return null;
  }


  // 按章节边界提取正文（解决移动端一页多章拼接问题）
  function extractByChapterBoundary() {
    var headings = document.querySelectorAll("h1, h2");
    var chapterPattern = /第[0-9零一二三四五六七八九十百千]+[章节回]/;
    // 找视口内最近的章节标题（用户正在读的章节）
    var startEl = null, bestDist = Infinity;
    for (var i = 0; i < headings.length; i++) {
      if (!chapterPattern.test(headings[i].textContent.trim())) continue;
      var rect = headings[i].getBoundingClientRect();
      if (rect.top <= 200) {
        var dist = 60 - rect.top;
        if (dist < bestDist) { bestDist = dist; startEl = headings[i]; }
      }
    }
    // 兜底：第一个章节标题
    if (!startEl) {
      for (var j = 0; j < headings.length; j++) {
        if (chapterPattern.test(headings[j].textContent.trim())) { startEl = headings[j]; break; }
      }
    }
    if (!startEl) return "";
    var texts = [];
    var el = startEl.nextElementSibling;
    while (el) {
      if ((el.tagName === "H1" || el.tagName === "H2") && chapterPattern.test(el.textContent.trim())) break;
      if (el.tagName === "MAIN" || el.tagName === "SECTION" || el.tagName === "ARTICLE") {
        var paras = el.querySelectorAll("p, div[class*='line'], div[class*='text']");
        for (var j = 0; j < paras.length; j++) {
          var t = (paras[j].innerText || "").trim();
          if (t.length > 3) texts.push(t);
        }
        break;
      }
      el = el.nextElementSibling;
    }
    var result = texts.join("\n");
    var lines = result.split("\n").filter(function(l) { return l.length > 3; });
    return lines.slice(0, 150).join("\n");
  }

  var _cachedText = null;
  var _cachedTextUrl = null;

  function getChapterText() {
    if (_cachedText && _cachedTextUrl === location.href) { return _cachedText; }
    // 移动端多章拼接修复：先尝试按章节边界截断
    var boundaryText = extractByChapterBoundary();
    if (boundaryText && boundaryText.length >= 80) return boundaryText;
    // 回退：选择器方式
    var titleEl = findChapterTitleElement();
    var scopeEl = titleEl ? (titleEl.parentElement || document.body) : document.body;
    const containerSelectors = [
      // 桌面版
      "#content", "#chaptercontent", "#ChapterContent", "#txt",
      ".read-content", ".main-text-wrap", ".chapter-content",
      ".content", ".article-content", ".post-content",
      ".txt", ".text", ".novel-content", ".book-content",
      "article", ".entry-content", "#article", "#text",
      // 手机版 SPA（起点/番茄/晋江/笔趣阁等移动端）
      ".chapter-text", ".reader-content", ".chapter-detail",
      ".read-section", ".chapter-body", ".reader-main",
      ".page-content", ".main-content", "[class*='reader']",
      "[class*='chapter-text']", "[class*='article-text']",
      ".book-content-wrap", ".novel-text", ".read-box",
    ];
    let bestText = "";
    for (const sel of containerSelectors) {
      const container = document.querySelector(sel);
      if (!container) continue;
      const paragraphs = container.querySelectorAll("p, div");
      const text = Array.from(paragraphs)
        .map((p) => p.innerText?.trim() || "")
        .filter((t) => t.length > 5)
        .join("\n");
      if (text.length > bestText.length) bestText = text;
    }
    if (bestText.length < 80) {
      const allP = document.querySelectorAll("p");
      const texts = Array.from(allP)
        .map((p) => p.innerText?.trim() || "")
        .filter((t) => t.length > 8);
      bestText = texts.join("\n");
    }
    _cachedText = bestText.split("\n").filter(function(l){return l.length>3}).slice(0,150).join("\n");
    _cachedTextUrl = location.href;
    return _cachedText;
  }

  function getBookTitle() {
    const selectors = [
      ".book-title", ".book-name", ".novel-title",
      "[class*='bookName']", "[class*='book_name']",
      "h1 a", "h2 a", ".book-info h1",
      ".crumbs a:last-of-type", ".breadcrumb a:last-of-type",
      ".book-detail h1", ".novel-info h1",
    ];
    for (const sel of selectors) {
      const text = document.querySelector(sel)?.innerText?.trim();
      if (text && text.length >= 1 && text.length < 100) return text;
    }
    const meta = document.querySelector("meta[property='og:novel:book_name'], meta[name='book-name']");
    const metaText = meta?.getAttribute("content")?.trim();
    if (metaText) return metaText;
    const m = location.pathname.match(/\/book\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]);
    return "";
  }

  function getAuthor() {
    const selectors = [
      ".author", ".writer", ".book-author",
      "[class*='author']", "[class*='Author']",
      ".book-info .author", ".novel-info .author",
    ];
    for (const sel of selectors) {
      const text = document.querySelector(sel)?.innerText?.trim();
      if (text && text.length >= 1 && text.length < 50) return text;
    }
    const meta = document.querySelector("meta[property='og:novel:author'], meta[name='author']");
    return meta?.getAttribute("content")?.trim() || "";
  }

  function getChapterIndex() {
    const patterns = [
      /chapter[\/\-_]?(\d+)/i,
      /\/(\d+)\.html?/,
      /[?&]id=(\d+)/,
      /\/(\d{3,6})\/?$/,
    ];
    for (const p of patterns) {
      const m = location.pathname.match(p);
      if (m) {
        const idx = parseInt(m[1], 10);
        if (idx > 0 && idx < 100000) return idx;
      }
    }
    const domSelectors = [
      ".chapter-index", ".chapter-num", ".chapter-number",
      "[class*='chapterIdx']", "[class*='chapter_index']",
    ];
    for (const sel of domSelectors) {
      const text = document.querySelector(sel)?.innerText;
      if (text) {
        const idx = parseInt(text.replace(/[^0-9]/g, ""), 10);
        if (idx > 0 && idx < 100000) return idx;
      }
    }
    return null;
  }

  // ═══════════ 工具函数 ═══════════

  function getAPI() {
    return Promise.resolve(store.get("api_url") || "https://jianla.xyz:8000");
  }

  function clearAuth() {
    store.remove("token");
    store.remove("refreshToken");
    store.remove("username");
  }

  var _refreshPromise = null;

  async function refreshAccessToken() {
    var refreshToken = store.get("refreshToken");
    if (!refreshToken) return null;

    // 防止并发刷新：多个调用共享同一个请求
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = (async () => {
      try {
        var api = await getAPI();
        var resp = await safeFetch(api + "/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken })
        });
        if (!resp.ok) {
          if (resp.status === 401) clearAuth();
          return null;
        }
        var data = await resp.json();
        if (!data.data || !data.data.token) return null;
        store.set("token", data.data.token);
        store.set("refreshToken", data.data.refresh_token);
        store.set("username", data.data.username);
        return data.data.token;
      } catch (_) { return null; }
      finally { _refreshPromise = null; }
    })();
    return _refreshPromise;
  }

  async function getToken() {
    var token = store.get("token");
    var refreshToken = store.get("refreshToken");

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

    return token;
  }

  // 自动重试 fetch（最多重试 2 次，指数退避；AbortError 不重试）
  async function fetchWithRetry(url, options, retries) {
    retries = retries || 2;
    var lastError;
    for (var i = 0; i <= retries; i++) {
      try {
        var resp = await safeFetch(url, options);
        if (resp.ok || i === retries) return resp;
        if (resp.status >= 500) { lastError = new Error("服务器错误(" + resp.status + ")，正在重试..."); }
        else return resp;
      } catch (e) {
        if (e.name === "AbortError") throw e; // 用户取消，不重试
        lastError = e;
      }
      if (i < retries) {
        await new Promise(function (r) { return setTimeout(r, Math.pow(2, i) * 1000); });
      }
    }
    throw lastError || new Error("请求失败");
  }

  function setText(selector, text) {
    const node = document.querySelector(selector);
    if (node) node.textContent = text || "";
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function createList(items, formatter) {
    const list = document.createElement("div");
    list.className = "jl-list";
    if (!items?.length) {
      const empty = document.createElement("p");
      empty.className = "jl-empty";
      empty.textContent = "暂无明显线索";
      list.appendChild(empty);
      return list;
    }
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "jl-list-item";
      row.textContent = formatter(item);
      list.appendChild(row);
    });
    return list;
  }

  function escHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str || ""));
    return div.innerHTML;
  }

  // ═══════════ 新手引导 ═══════════

  function showOnboarding() {
    const key = "JL_Onboarding_Done_v2";
    if (localStorage.getItem(key) === "1") return;

    const overlay = document.createElement("div");
    overlay.id = "jl-onboarding";
    overlay.innerHTML =
      '<div style="position:fixed;inset:0;z-index:2147483649;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:Arial,\'Microsoft YaHei\',sans-serif">' +
        '<div style="background:#fffef9;border-radius:12px;padding:24px 28px;max-width:380px;width:90%;box-shadow:0 18px 52px rgba(0,0,0,.32)">' +
          '<div style="text-align:center;font-size:40px;margin-bottom:4px">📖</div>' +
          '<h3 style="margin:0 0 4px;font-size:18px;color:#5d4037;text-align:center">3 步开始使用鉴来助手</h3>' +
          '<p style="margin:0 0 20px;font-size:12px;color:#8b7c72;text-align:center">首次使用，跟着走一遍吧</p>' +
          '<div style="display:flex;flex-direction:column;gap:14px;margin-bottom:22px">' +
            '<div style="display:flex;gap:10px;align-items:flex-start">' +
              '<span style="flex-shrink:0;width:26px;height:26px;border-radius:50%;background:#5d4037;color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">1</span>' +
              '<span style="font-size:13px;line-height:1.6">打开任意小说章节页面<br><small style="color:#8b7c72">起点、番茄、晋江等所有网站均支持</small></span>' +
            '</div>' +
            '<div style="display:flex;gap:10px;align-items:flex-start">' +
              '<span style="flex-shrink:0;width:26px;height:26px;border-radius:50%;background:#f5a623;color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">2</span>' +
              '<span style="font-size:13px;line-height:1.6">点击右下角 <b style="color:#f5a623">"分析当前章节"</b> 按钮<br><small style="color:#8b7c72">AI 会自动提炼摘要、伏笔和人物关系</small></span>' +
            '</div>' +
            '<div style="display:flex;gap:10px;align-items:flex-start">' +
              '<span style="flex-shrink:0;width:26px;height:26px;border-radius:50%;background:#8d6e63;color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">3</span>' +
              '<span style="font-size:13px;line-height:1.6">切换顶部标签探索更多<br><small style="color:#8b7c72"><b>概况</b> · <b>伏笔</b> · <b>问答</b> · <b>总览</b> · <b>关系图</b></small></span>' +
            '</div>' +
          '</div>' +
          '<button id="jl-onboarding-close" style="width:100%;padding:11px;border:0;border-radius:8px;background:#5d4037;color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s">知道了，开始使用 ✨</button>' +
          '<p style="margin:8px 0 0;font-size:10px;color:#b0a395;text-align:center">注册即送 10 次免费额度 · 每日签到 +8 次</p>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    overlay.querySelector("#jl-onboarding-close").addEventListener("click", function () {
      overlay.remove();
      localStorage.setItem(key, "1");
    });
  }

  // ═══════════ UI 创建 ═══════════

  function createWindow() {
    let win = document.getElementById("jianlai-helper-window");
    if (win) return win;

    const style = document.createElement("style");
    style.id = "jianlai-helper-style";
    style.textContent = "#jianlai-helper-window{position:fixed;top:16px;right:16px;width:min(480px,calc(100vw - 32px));height:min(780px,calc(100vh - 32px));z-index:2147483647;display:flex;flex-direction:column;color:#2C2416;background:linear-gradient(180deg,#FBF8F0,#F5EDE0);border:1px solid #D7CCC8;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);overflow:hidden;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;animation:jlFadeIn .25s ease}#jianlai-helper-window button{border:0;border-radius:8px;cursor:pointer;font:inherit;transition:all .18s ease}#jianlai-helper-window button:active{transform:scale(.97)}@keyframes jlFadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}.jl-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;color:#fff;background:linear-gradient(135deg,#3E2723,#5D4037,#6D4C41)}.jl-title{min-width:0}.jl-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:700;letter-spacing:.5px}.jl-title span{display:block;margin-top:3px;opacity:.7;font-size:11px}#jl-close{width:30px;height:30px;color:#fff;background:rgba(255,255,255,.12);border-radius:50%!important;font-size:18px;display:flex;align-items:center;justify-content:center}#jl-close:hover{background:rgba(255,255,255,.22)}.jl-tabs{display:grid;grid-template-columns:repeat(6,1fr);gap:0;background:#D7CCC8;padding:1px 0 0 0}.jl-tab{padding:11px 4px;color:#6D4C41;background:#EFEBE4;font-size:12px;font-weight:500;position:relative}.jl-tab:hover{background:#E8E0D5}.jl-tab.is-active{color:#fff;background:linear-gradient(180deg,#6D4C41,#5D4037);font-weight:600}.jl-tab.is-active::after{content:'';position:absolute;bottom:0;left:30%;right:30%;height:2px;background:#FFCC80;border-radius:2px}.jl-main{flex:1;min-height:0;overflow:auto;padding:16px;scroll-behavior:smooth}.jl-main::-webkit-scrollbar{width:5px}.jl-main::-webkit-scrollbar-thumb{background:#D7CCC8;border-radius:3px}.jl-panel{display:none;animation:jlFadeIn .2s ease}.jl-panel.is-active{display:block}.jl-card{margin-bottom:14px;padding:14px 16px;border:1px solid #E8DDD2;border-radius:10px;background:#FFFDF7;box-shadow:0 1px 4px rgba(44,36,22,.04);transition:box-shadow .2s}.jl-card:hover{box-shadow:0 2px 8px rgba(44,36,22,.08)}.jl-card h3{margin:0 0 10px;font-size:14px;font-weight:700;color:#3E2723}.jl-card p,.jl-list-item{margin:0;font-size:13px;line-height:1.7;color:#4E3E33}.jl-list-item{padding:10px 0;border-top:1px solid #F0E8DE}.jl-list-item:first-child{border-top:0}.jl-empty{color:#A1887F;font-size:13px;text-align:center;padding:20px}.jl-ask-box{display:grid;gap:10px}#jl-question{width:100%;min-height:80px;padding:12px;resize:vertical;border:1.5px solid #DDD0C4;border-radius:8px;color:#2C2416;background:#fff;font:inherit;font-size:13px;line-height:1.6;transition:border-color .2s}#jl-question:focus{outline:none;border-color:#8D6E63;box-shadow:0 0 0 3px rgba(141,110,99,.08)}#jl-ask{min-height:38px;color:#fff;background:linear-gradient(135deg,#5D4037,#6D4C41);font-weight:600}#jl-answer{white-space:pre-wrap}#jl-graph{height:580px;border:1px solid #E8DDD2;border-radius:10px;background:#FFFDF7;overflow:hidden}.jl-footer{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-top:1px solid #E8DDD2;background:#F5EDE0}.jl-controls{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}.jl-controls select{width:100%;min-height:36px;padding:6px 10px;border:1.5px solid #DDD0C4;border-radius:8px;color:#3E2723;background:#fff;font:inherit;font-size:13px;cursor:pointer;transition:border-color .2s}.jl-controls select:focus{outline:none;border-color:#8D6E63}.jl-toggle{display:flex;align-items:center;gap:6px;white-space:nowrap;color:#6D4C41;font-size:12px;cursor:pointer}.jl-actions{display:flex;gap:8px}.jl-footer button{min-height:38px;padding:8px 12px;font-size:13px;font-weight:600}#jl-run{flex:1;color:#fff;background:linear-gradient(135deg,#E65100,#F57C00);box-shadow:0 2px 8px rgba(230,81,0,.2)}#jl-run:hover{box-shadow:0 4px 14px rgba(230,81,0,.3)}#jl-review{flex:1;color:#fff;background:#6D4C41}#jl-full-report{flex:1;color:#fff;background:#8D6E63}#jl-export{width:60px;color:#5D4037;background:#E8DDD2}#jl-run:disabled{opacity:.6;cursor:wait;filter:grayscale(30%)}.jl-meta{margin-bottom:10px;padding:6px 10px;border-radius:6px;background:#F5EDE0;color:#8D6E63;font-size:11px;display:inline-block}.jl-book-bar{padding:8px 16px;background:linear-gradient(90deg,#F5EDE0,#EFEBE4);font-size:11px;color:#6D4C41;border-bottom:1px solid #E8DDD2;display:flex;align-items:center;gap:6px}.jl-book-bar::before{content:'📖';font-size:13px}.jl-ov-stat{display:inline-flex;align-items:center;gap:5px;margin:4px 14px 4px 0;font-size:12px;font-weight:500}.jl-ov-dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.15)}.jl-ov-dot.open{background:#E65100}.jl-ov-dot.progress{background:#1565C0}.jl-ov-dot.payoff{background:#2E7D32}.jl-ov-item{padding:12px 14px;margin-bottom:10px;border-radius:10px;border:1px solid #E8DDD2;background:#FFFDF7;cursor:pointer;transition:all .15s}.jl-ov-item:hover{border-color:#8D6E63;box-shadow:0 2px 8px rgba(44,36,22,.06);transform:translateX(2px)}.jl-ov-item .jl-ov-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.jl-ov-item .jl-ov-clue{font-size:13px;font-weight:600;color:#3E2723}.jl-ov-item .jl-ov-confidence{font-size:10px;padding:2px 10px;border-radius:12px;font-weight:600}.jl-ov-item .jl-ov-reason{font-size:12px;color:#6D4C41;margin-top:6px}.jl-ov-item .jl-ov-chapter{font-size:11px;color:#A1887F;margin-top:4px}.jl-ov-empty{text-align:center;padding:40px 20px;color:#A1887F;font-size:13px}.jl-qa-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.jl-qa-header h3{margin:0}.jl-qa-book-tag{padding:3px 10px;border-radius:12px;background:#EFEBE4;color:#6D4C41;font-size:11px;font-weight:500}.jl-chat-msg{margin-bottom:10px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.6;animation:jlFadeIn .2s ease}.jl-chat-msg.q{background:#F5EDE0;border:1px solid #E8DDD2}.jl-chat-msg.a{background:#E8F5E9;border:1px solid #C8E6C9}.jl-chat-msg .jl-chat-label{font-weight:700;font-size:10px;margin-bottom:4px;display:block;text-transform:uppercase;letter-spacing:.5px}.jl-chat-msg.q .jl-chat-label{color:#5D4037}.jl-chat-msg.a .jl-chat-label{color:#2E7D32}.jl-chat-warning{padding:8px 12px;margin-bottom:10px;border-radius:8px;background:#FFF8E1;border:1px solid #FFE082;color:#E65100;font-size:12px}.jl-suggested{margin-bottom:12px}.jl-suggested-label{font-size:11px;color:#A1887F;margin-bottom:6px}.jl-suggested-item{display:block;width:100%;padding:8px 10px;margin-bottom:4px;border:1px solid #E8DDD2!important;border-radius:8px!important;background:#FFFDF7;color:#5D4037;font-size:12px;text-align:left;cursor:pointer}.jl-suggested-item:hover{background:#F5EDE0;border-color:#8D6E63!important}.jl-text-btn{display:block;width:100%;margin-top:8px;padding:4px 8px;border:0;background:0 0;color:#A1887F;font-size:11px;text-align:center;cursor:pointer}.jl-text-btn:hover{color:#C62828}.jl-qa-buttons{display:flex;gap:8px}.jl-qa-buttons button{flex:1;min-height:36px;padding:8px 12px;font-size:13px}#jl-ask{color:#fff;background:linear-gradient(135deg,#5D4037,#6D4C41)}#jl-suggest-btn{color:#5D4037;background:#EFEBE4;border:1.5px solid #D7CCC8!important}#jl-ask:disabled,#jl-suggest-btn:disabled{opacity:.6;cursor:wait}";
    // 脚本版补充样式：账号面板控件 + 手机小屏全屏化
    style.textContent += "#jianlai-helper-window .jl-input{width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #DDD0C4;border-radius:8px;color:#2C2416;background:#fff;font:inherit;font-size:13px}#jianlai-helper-window .jl-input:focus{outline:none;border-color:#8D6E63}#jianlai-helper-window .jl-btn-main{display:block;width:100%;margin-top:10px;min-height:40px;color:#fff;background:linear-gradient(135deg,#5D4037,#6D4C41);font-weight:600;font-size:14px}#jianlai-helper-window .jl-btn-plain{min-height:38px;padding:8px 12px;color:#5D4037;background:#E8DDD2;font-size:12px;white-space:nowrap}#jianlai-helper-window .jl-btn-main:disabled,#jianlai-helper-window .jl-btn-plain:disabled{opacity:.6;cursor:wait}@media (max-width:520px){#jianlai-helper-window{top:0;right:0;width:100vw;height:100vh;border-radius:0;border:0}.jl-tab{padding:12px 1px;font-size:11px}.jl-footer button{min-height:44px}#jl-graph{height:420px}}";
    document.documentElement.appendChild(style);

    win = document.createElement("div");
    win.id = "jianlai-helper-window";
    win.innerHTML =
      '<div class="jl-header">' +
        '<div class="jl-title">' +
          '<strong id="jl-heading">鉴来助手</strong>' +
          '<span>无剧透前情提要 / 伏笔雷达 / 关系图</span>' +
        '</div>' +
        '<span id="jl-credits-chip" style="display:none;padding:3px 10px;border-radius:12px;background:rgba(255,255,255,.15);font-size:12px;font-weight:600;white-space:nowrap"></span>' +
        '<div style="display:flex;gap:6px;align-items:center"><button id="jl-sidebar-toggle" title="切换侧边/浮动" style="width:30px;height:30px;color:#fff;background:rgba(255,255,255,.12);border-radius:50%!important;font-size:14px;display:flex;align-items:center;justify-content:center">📌</button><button id="jl-close" title="关闭">×</button></div>' +
      '</div>' +
      '<div class="jl-book-bar"><span id="jl-book-tag">当前：未分析章节</span></div>' +
      '<div class="jl-tabs">' +
        '<button class="jl-tab is-active" data-panel="summary">概况</button>' +
        '<button class="jl-tab" data-panel="clues">伏笔</button>' +
        '<button class="jl-tab" data-panel="qa">问答</button>' +
        '<button class="jl-tab" data-panel="overview">总览</button>' +
        '<button class="jl-tab" data-panel="graph">关系图</button><button class="jl-tab" data-panel="weekly">📊 周报</button>' +
        '<button class="jl-tab" data-panel="account">账号</button>' +
      '</div>' +
      '<div class="jl-main">' +
        '<section id="jl-panel-summary" class="jl-panel is-active">' +
          '<div class="jl-card"><h3>本章概况</h3><p id="jl-summary">点击下方按钮开始分析。</p></div>' +
          '<div class="jl-card"><h3>关键人物</h3><div id="jl-characters"><p class="jl-empty">暂无</p></div></div>' +
          '<div class="jl-card"><h3>名词解释</h3><div id="jl-terms"><p class="jl-empty">暂无</p></div></div>' +
          '<div class="jl-card" id="jl-payoff-card" style="display:none"><h3>🏮 伏笔回收</h3><div id="jl-payoff"></div></div>' +
        '</section>' +
        '<section id="jl-panel-clues" class="jl-panel">' +
          '<div class="jl-card"><h3>疑似伏笔</h3><div id="jl-clues"><p class="jl-empty">暂无</p></div></div>' +
        '</section>' +
        '<section id="jl-panel-qa" class="jl-panel">' +
          '<div class="jl-card">' +
            '<div class="jl-qa-header">' +
              '<h3>无剧透问答</h3>' +
              '<span id="jl-qa-book-tag" class="jl-qa-book-tag"></span>' +
            '</div>' +
            '<div id="jl-chat-history"></div>' +
            '<div id="jl-suggested-questions" class="jl-suggested"></div>' +
            '<div class="jl-ask-box">' +
              '<textarea id="jl-question" placeholder="比如：这个人之前做过什么？这件物品是不是伏笔？"></textarea>' +
              '<div class="jl-qa-buttons">' +
                '<button id="jl-ask">询问已读记忆</button>' +
                '<button id="jl-suggest-btn">✨ 智能推荐</button>' +
              '</div>' +
            '</div>' +
            '<button id="jl-clear-chat" class="jl-text-btn">清除聊天记录</button>' +
          '</div>' +
        '</section>' +
        '<section id="jl-panel-overview" class="jl-panel">' +
          '<div class="jl-card"><h3>全书伏笔总览</h3><div id="jl-overview-stats"></div></div>' +
          '<div id="jl-overview-list"></div>' +
        '</section>' +
        '<section id="jl-panel-graph" class="jl-panel">' +
          '<div style="display:flex;justify-content:center;gap:8px;padding:8px 0">' +
            '<button id="jl-graph-chapter" class="jl-graph-toggle" style="background:#5D4037;color:#fff">当前章节</button>' +
            '<button id="jl-graph-book" class="jl-graph-toggle" style="background:#E8DDD2;color:#5D4037">全书累计</button>' +
          '</div>' +
          '<div id="jl-graph"></div></section><section id="jl-panel-weekly" class="jl-panel"><div class="jl-card"><h3>📊 本周阅读概览</h3><div id="jl-weekly-stats"></div></div><div class="jl-card"><h3>👥 最关注角色</h3><div id="jl-weekly-characters"></div></div><div class="jl-card"><h3>🔍 伏笔追踪</h3><div id="jl-weekly-clues"></div></div></section>' +
        '<section id="jl-panel-account" class="jl-panel">' +
          '<p id="jl-acc-msg" style="min-height:14px;font-size:12px;margin:0 0 8px;text-align:center;color:#6D4C41"></p>' +
          '<div class="jl-card" id="jl-auth-box">' +
            '<h3>邮箱验证码登录</h3>' +
            '<p style="font-size:12px;color:#8b7c72;margin:0 0 10px">未注册的邮箱将自动创建账号</p>' +
            '<input id="jl-login-email" class="jl-input" type="email" placeholder="邮箱地址">' +
            '<div style="display:flex;gap:8px;margin-top:8px">' +
              '<input id="jl-login-code" class="jl-input" type="text" maxlength="6" placeholder="6 位验证码" style="flex:1">' +
              '<button id="jl-send-code" class="jl-btn-plain">获取验证码</button>' +
            '</div>' +
            '<button id="jl-login-btn" class="jl-btn-main">登录 / 注册</button>' +
            '<p style="font-size:10px;color:#b0a395;margin:10px 0 0">提示：手机浏览器中登录状态按小说站分别保存，换个网站需再登录一次；桌面油猴环境全站共享。</p>' +
          '</div>' +
          '<div class="jl-card" id="jl-user-box" style="display:none">' +
            '<h3>我的账号</h3>' +
            '<p style="margin:0 0 6px;font-size:13px">👤 <b id="jl-acc-username"></b></p>' +
            '<p style="margin:0 0 6px;font-size:13px">剩余额度：<b id="jl-acc-credits"></b> 次（每天打开本页自动签到）</p>' +
            '<p id="jl-acc-low" style="display:none;color:#E65100;font-size:12px;margin:0 0 6px"></p>' +
            '<button id="jl-logout" class="jl-btn-plain" style="margin-top:6px">退出登录</button>' +
          '</div>' +
          '<div class="jl-card">' +
            '<details><summary style="font-size:12px;color:#8b7c72;cursor:pointer">⚙ 高级设置</summary>' +
              '<div style="display:flex;gap:8px;margin-top:10px">' +
                '<input id="jl-api-url" class="jl-input" type="text" placeholder="服务器地址" style="flex:1">' +
                '<button id="jl-api-save" class="jl-btn-plain">保存</button>' +
              '</div>' +
            '</details>' +
          '</div>' +
        '</section>' +
      '</div>' +
      '<div class="jl-footer">' +
        '<div class="jl-controls">' +
          '<select id="jl-detail">' +
            '<option value="standard">标准概况</option>' +
            '<option value="detailed">详细前情提要</option>' +
            '<option value="brief">快速概况</option>' +
          '</select>' +
          '<label class="jl-toggle"><input id="jl-spoiler-free" type="checkbox" checked> 无剧透</label>' +
        '</div>' +
        '<div class="jl-actions">' +
          '<button id="jl-run">分析当前章节</button>' +
          '<button id="jl-review">最近回顾</button>' +
          '<button id="jl-full-report">全书复盘</button>' +
          '<button id="jl-export">导出</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(win);

    var isSidebar = localStorage.getItem("JL_Sidebar_Mode") === "1";
    if (isSidebar) applySidebarMode(win);
    win.querySelector("#jl-close").addEventListener("click", function () {
      if (localStorage.getItem("JL_Sidebar_Mode") === "1") {
        win.style.display = "none";
        document.body.style.marginRight = "";
      } else {
        win.remove();
      }
    });
    win.querySelector("#jl-sidebar-toggle").addEventListener("click", function () {
      toggleSidebarMode(win);
    });
    win.querySelector("#jl-run").addEventListener("click", runAnalyze);
    win.querySelector("#jl-ask").addEventListener("click", askMemory);
    win.querySelector("#jl-suggest-btn").addEventListener("click", fetchSuggestedQuestions);
    win.querySelector("#jl-clear-chat").addEventListener("click", clearChatHistory);
    win.querySelector("#jl-export").addEventListener("click", exportResult);
    win.querySelector("#jl-review").addEventListener("click", reviewRecent);
    win.querySelector("#jl-full-report").addEventListener("click", fullReport);
    win.querySelector("#jl-graph-chapter").addEventListener("click", function () { setGraphMode("chapter"); });
    win.querySelector("#jl-graph-book").addEventListener("click", function () { setGraphMode("book"); });
    win.querySelector("#jl-send-code").addEventListener("click", sendEmailCode);
    win.querySelector("#jl-login-btn").addEventListener("click", emailLogin);
    win.querySelector("#jl-logout").addEventListener("click", logout);
    win.querySelector("#jl-api-save").addEventListener("click", saveApiUrl);
    win.querySelector("#jl-api-url").value = store.get("api_url") || "https://jianla.xyz:8000";
    win.querySelectorAll(".jl-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchPanel(tab.dataset.panel));
    });

    return win;
  }

  function switchPanel(panel) {
    document.querySelectorAll(".jl-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.panel === panel);
    });
    document.querySelectorAll(".jl-panel").forEach((node) => {
      node.classList.toggle("is-active", node.id === "jl-panel-" + panel);
    });
    if (panel === "graph") {
      setGraphMode(_graphMode);
    }
    if (panel === "account") {
      renderAccountPanel();
    }
    if (panel === "overview") {
      loadOverview();
    }
    if (panel === "summary") {
      loadAnalysisHistory();
    }
    if (panel === "qa") {
      updateQABookTag();
      if (_currentBookId !== _chatBookId) {
        _chatBookId = _currentBookId;
        _chatHistory = [];
        loadChatHistory();
        // 切书后清空推荐问题，强制重新生成
        var sq = document.getElementById("jl-suggested-questions");
        if (sq) sq.innerHTML = "";
      }
      renderChatHistory();
      // 如果还没有推荐问题，尝试生成离线推荐
      if (!document.getElementById("jl-suggested-questions").innerHTML.trim()) {
        var offlineQs = generateOfflineQuestions();
        if (offlineQs.length > 0) renderSuggestedQuestions(offlineQs);
      }
    }
  }

  // ═══════════ 渲染 ═══════════

  function normalizeResult(data) {
    const result = data?.result || data || {};
    return {
      summary: result.summary || "暂无概况",
      characters: Array.isArray(result.characters) ? result.characters : [],
      foreshadowing: Array.isArray(result.foreshadowing) ? result.foreshadowing : [],
      terms: Array.isArray(result.terms) ? result.terms : [],
      graph: result.graph || { nodes: [], edges: [] },
      raw: result.raw || ""
    };
  }

  function renderResult(result) {
    document.querySelectorAll(".jl-meta").forEach((node) => node.remove());
    setText("#jl-summary", result.summary);

    const characters = document.querySelector("#jl-characters");
    const clues = document.querySelector("#jl-clues");
    const terms = document.querySelector("#jl-terms");
    clearNode(characters);
    clearNode(clues);
    clearNode(terms);

    characters.appendChild(createList(result.characters, (item) => {
      const name = item.name || item.label || "未知人物";
      const note = item.note || item.role || "";
      return note ? name + "：" + note : name;
    }));

    clues.appendChild(createList(result.foreshadowing, (item) => {
      const clue = item.clue || item.text || "未命名线索";
      const reason = item.reason || "";
      const conf = Number.isFinite(Number(item.confidence)) ? "可信度 " + item.confidence + "/100" : "";
      const detail = [reason, conf].filter(Boolean).join("｜");
      return detail ? clue + "：" + detail : clue;
    }));

    terms.appendChild(createList(result.terms, (item) => {
      const term = item.term || item.name || "未知名词";
      const meaning = item.meaning || item.note || "";
      return meaning ? term + "：" + meaning : term;
    }));

    drawGraph(result.graph);

    // 添加反馈按钮
    showFeedbackButtons(result);

    // 首次分析引导提示
    if (!localStorage.getItem("JL_First_Analysis_Done")) {
      localStorage.setItem("JL_First_Analysis_Done", "1");
      var tipBanner = document.createElement("div");
      tipBanner.className = "jl-card";
      tipBanner.style.cssText = "border-left:3px solid #F57C00;background:#FFF8E1;margin-bottom:10px";
      tipBanner.innerHTML =
        '<h3 style="color:#E65100">🎉 分析完成！</h3>' +
        '<p style="font-size:12px;color:#5D4037;margin:0">试试上方的标签页：<b>伏笔</b> 看隐藏线索 · <b>关系图</b> 看人物网络 · <b>问答</b> 向AI提问</p>';
      var panel = document.getElementById("jl-panel-summary");
      panel.insertBefore(tipBanner, panel.firstChild);
      // 5 秒后自动淡化
      setTimeout(function () {
        tipBanner.style.transition = "opacity .5s";
        tipBanner.style.opacity = "0";
        setTimeout(function () { if (tipBanner.parentNode) tipBanner.remove(); }, 500);
      }, 8000);
    }

    // 生成离线推荐问题
    var offlineQs = generateOfflineQuestions();
    if (offlineQs.length > 0) {
      renderSuggestedQuestions(offlineQs);
    }
  }

  // ═══════════ 流式响应消费 ═══════════

  function dispatchSSEEvent(line, callbacks) {
    if (line.indexOf("data: ") !== 0) return;
    try {
      var event = JSON.parse(line.substring(6));
      if (event.type === "progress") {
        if (callbacks.onProgress) callbacks.onProgress(event.stage, event.elapsed_s || 0);
      } else if (event.type === "summary") {
        if (callbacks.onSummary) callbacks.onSummary(event.data);
      } else if (event.type === "done") {
        callbacks.onDone(event.data);
      } else if (event.type === "error") {
        callbacks.onError(event.message);
      }
    } catch (_) {}
  }

  function processSSELines(text, callbacks) {
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      dispatchSSEEvent(lines[i], callbacks);
    }
  }

  async function consumeSSE(response, callbacks) {
    if (!response.body || !response.body.getReader) {
      var fullText = await response.text();
      processSSELines(fullText, callbacks);
      return;
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          dispatchSSEEvent(lines[i], callbacks);
        }
      }
      // 流结束：flush 解码器残留字节，处理 buffer 尾部（避免 done 丢失）
      buffer += decoder.decode();
      var tail = buffer.split("\n");
      for (var j = 0; j < tail.length; j++) dispatchSSEEvent(tail[j], callbacks);
    } catch (e) {
      callbacks.onError("网络连接中断，请刷新页面后重试。联系客服 QQ：2313370765");
    }
  }

  async function streamFetch(url, options, callbacks) {
    var response = await safeFetch(url, options);
    var ct = response.headers.get("content-type") || "";

    if (!response.ok) {
      try {
        var errData = await response.json();
        throw new Error(errData.error || errData.detail || "服务器错误(" + response.status + ")");
      } catch (e) {
        if ((e.message || "").indexOf("服务器错误") === 0) throw e;
        throw new Error("服务器错误(" + response.status + ")");
      }
    }

    if (ct.indexOf("text/event-stream") !== -1) {
      await consumeSSE(response, callbacks);
    } else {
      var payload = await response.json();
      if (!payload.success) throw new Error(payload.error || "请求失败");
      callbacks.onDone(payload.data);
    }
  }

  // ═══════════ 免登录试用 ═══════════

  function getGuestId() {
    var id = localStorage.getItem("JL_Guest_Id");
    if (!id) {
      id = "g_" + Math.random().toString(36).substring(2, 12) + Math.random().toString(36).substring(2, 12);
      localStorage.setItem("JL_Guest_Id", id);
    }
    return id;
  }

  function getGuestUsage() {
    return parseInt(localStorage.getItem("JL_Guest_Usage") || "0", 10);
  }

  function incrementGuestUsage() {
    var n = getGuestUsage() + 1;
    localStorage.setItem("JL_Guest_Usage", String(n));
    return n;
  }

  async function runGuestAnalyze(API) {
    if (isRunning) return;

    var usageCount = getGuestUsage();
    if (usageCount >= 3) {
      setText("#jl-summary", "🎯 免费试用次数已用完（3次）！\n\n注册即送 10 次额度，每天签到再领 8 次，点击浏览器工具栏的 📖 图标注册吧！");
      showGuestRegisterPrompt();
      return;
    }

    var text = getChapterText();
    if (text.length < 80) {
      setText("#jl-summary", "没有识别到足够的正文内容。");
      return;
    }

    isRunning = true;
    var runBtn = document.getElementById("jl-run");
    runBtn.disabled = true;
    runBtn.textContent = "⏳ 0s";
    runBtn.style.animation = "pulse 1.5s ease infinite";
    var startTime = Date.now();
    var timer = setInterval(function () {
      var s = Math.floor((Date.now() - startTime) / 1000);
      runBtn.textContent = "⏳ " + s + "s";
      var mode = getModeLabel();
      setText("#jl-summary", "🤖 AI 正在分析…（" + mode + " " + s + "s）");
    }, 1000);

    if (!document.getElementById("jl-pulse-style")) {
      var ps = document.createElement("style");
      ps.id = "jl-pulse-style";
      ps.textContent = "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}";
      document.head.appendChild(ps);
    }

    var chapterTitle = getChapterTitle();
    setText("#jl-heading", chapterTitle);
    setText("#jl-summary", "🤖 AI 正在分析…（" + getModeLabel() + "）");

    // 清空上一章详情，避免分析过程中残留旧内容
    ["#jl-characters", "#jl-terms", "#jl-clues"].forEach(function (sel) {
      var box = document.querySelector(sel);
      if (box) box.innerHTML = '<p class="jl-empty">分析中…</p>';
    });

    // 重置伏笔回收卡片
    var payoffCardGuest = document.getElementById("jl-payoff-card");
    if (payoffCardGuest) payoffCardGuest.style.display = "none";

    try {
      var _summaryFirst = false;
      var _newCount = 0;

      await streamFetch(API + "/api/analyze/guest/progressive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guest_id: getGuestId(),
          text: text,
          chapter_title: chapterTitle,
          source_url: location.href,
          detail_level: document.getElementById("jl-detail").value,
          spoiler_free: document.getElementById("jl-spoiler-free").checked
        })
      }, {
        onProgress: null,
        onSummary: function(data) {
          var s = data.summary || "";
          setText("#jl-summary", s + "\n\n⏳ 正在加载人物和伏笔分析…");
          _summaryFirst = true;
        },
        onDone: function(data) {
          var result = normalizeResult(data);
          _newCount = incrementGuestUsage();
          var remaining = 3 - _newCount;

          var summaryCard = document.querySelector("#jl-panel-summary .jl-card");
          if (summaryCard && _summaryFirst) {
            var trialMeta = document.createElement("div");
            trialMeta.className = "jl-meta";
            trialMeta.style.cssText = "background:#FFF8E1;color:#E65100;display:inline-block;margin-bottom:8px";
            trialMeta.textContent = remaining > 0
              ? "🆓 免登录试用 · 还剩 " + remaining + " 次 · 注册送 10 次 + 每日签到 8 次"
              : "🆓 试用次数已用完 · 注册送 10 次免费额度";
            summaryCard.appendChild(trialMeta);
          }

          renderResult(result);
          localStorage.setItem(storageKey(), JSON.stringify(result));
          if (_newCount === 1) showGuestTrialGuide(remaining);
          if (remaining === 0) setTimeout(function () { showGuestRegisterPrompt(); }, 2000);
        },
        onError: function(message) {
          setText("#jl-summary", message);
        }
      });
    } catch (error) {
      console.error("[鉴来助手] runGuestAnalyze 失败:", error);
      var errMsg = (error && error.message) || "分析失败，请稍后再试。联系客服 QQ：2313370765";
      setText("#jl-summary", errMsg);
      if (errMsg.indexOf("免费试用次数已用完") !== -1) showGuestRegisterPrompt();
    } finally {
      clearInterval(timer);
      isRunning = false;
      runBtn.disabled = false;
      runBtn.textContent = "重新分析";
      runBtn.style.animation = "";
    }
  }

  function showGuestTrialGuide(remaining) {
    var old = document.getElementById("jl-guest-guide");
    if (old) old.remove();
    var panel = document.getElementById("jl-panel-summary");
    var banner = document.createElement("div");
    banner.id = "jl-guest-guide";
    banner.className = "jl-card";
    banner.style.cssText = "border-left:3px solid #F57C00;background:#FFF8E1;margin-bottom:10px";
    banner.innerHTML =
      '<h3 style="color:#E65100">🆓 免登录试用中</h3>' +
      '<p style="font-size:12px;color:#5D4037;margin:4px 0">你还有 <b>' + remaining + ' 次</b> 免费试用机会，用完即止。</p>' +
      '<p style="font-size:11px;color:#8D6E63;margin:4px 0">📖 注册即送 <b>10 次</b> 额度 · 每日签到领 <b>8 次</b></p>' +
      '<p style="font-size:11px;color:#8D6E63;margin:4px 0">点击页面右下角 📖 按钮即可注册</p>';
    panel.insertBefore(banner, panel.firstChild);
  }

  function showGuestRegisterPrompt() {
    var oldGuide = document.getElementById("jl-guest-guide");
    if (oldGuide) oldGuide.remove();
    var oldReg = document.getElementById("jl-guest-register");
    if (oldReg) return;

    var panel = document.getElementById("jl-panel-summary");
    var banner = document.createElement("div");
    banner.id = "jl-guest-register";
    banner.className = "jl-card";
    banner.style.cssText = "border-left:3px solid #2E7D32;background:#E8F5E9;margin-bottom:10px";
    banner.innerHTML =
      '<h3 style="color:#2E7D32">🎉 喜欢鉴来助手？</h3>' +
      '<p style="font-size:12px;color:#5D4037;margin:4px 0">注册账号即可获得 <b>10 次</b> 免费额度，每日签到再领 <b>8 次</b>！</p>' +
      '<p style="font-size:11px;color:#8D6E63;margin:4px 0">📖 点击页面右下角 📖 按钮 → 输入邮箱 → 验证码登录，只需 30 秒</p>' +
      '<p style="font-size:11px;color:#8D6E63;margin:4px 0">🔮 注册后可解锁：伏笔追踪 · 全书复盘 · 人物关系图 · 跨设备同步</p>';
    panel.insertBefore(banner, panel.firstChild);
  }

  // ═══════════ getModeLabel ═══════════

  function getModeLabel() {
    var v = (document.getElementById("jl-detail") || {}).value || "standard";
    return v === "brief" ? "快速概况" : v === "detailed" ? "详细前情提要" : "标准概况";
  }

  function drawGraph(graph) {
    const graphBox = document.getElementById("jl-graph");
    if (!graphBox || !Array.isArray(graph?.nodes) || graph.nodes.length === 0) return;
    if (!window.vis) { renderGraphAsText(graphBox, graph); return; }

    const nodes = graph.nodes.map((node) => ({
      ...node,
      label: String(node.label || node.name || node.id),
      color: {
        background: node.level === "core" ? "#fff176" : "#d7ccc8",
        border: "#8d6e63"
      },
      font: { size: node.level === "core" ? 18 : 14 },
      shape: "dot",
      size: node.level === "core" ? 24 : 16
    }));

    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    if (network) { network.destroy(); network = null; }
    network = new vis.Network(graphBox, { nodes, edges }, {
      edges: { arrows: "to", color: "#9b8a80", font: { align: "middle" } },
      physics: { stabilization: true },
      interaction: { hover: true }
    });
  }

  function renderChapterGraph() {
    // 从最后一次分析结果渲染当前章节关系图
    var graphBox = document.getElementById("jl-graph");
    if (!graphBox) return;

    var key = storageKey();
    var raw;
    try { raw = localStorage.getItem(key); } catch (_) { return; }
    if (!raw) {
      graphBox.innerHTML = '<div class="jl-ov-empty">请先分析当前章节</div>';
      return;
    }
    var data;
    try { data = JSON.parse(raw); } catch (_) {
      graphBox.innerHTML = '<div class="jl-ov-empty">数据解析失败</div>';
      return;
    }
    var graph = data.graph;
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      graphBox.innerHTML = '<div class="jl-ov-empty">本章暂无人物关系数据</div>';
      return;
    }
    if (!window.vis) { renderGraphAsText(graphBox, graph); return; }
    graphBox.innerHTML = "";
    graphBox.style.height = "560px";
    var nodes = graph.nodes.map(function (node) {
      return {
        id: node.id || node.label,
        label: node.label || node.id,
        color: {
          background: node.level === "core" ? "#fff176" : "#d7ccc8",
          border: "#8d6e63"
        },
        font: { size: node.level === "core" ? 18 : 14 },
        shape: "dot",
        size: node.level === "core" ? 28 : 18
      };
    });
    var edges = Array.isArray(graph.edges) ? graph.edges : [];
    if (network) { network.destroy(); network = null; }
    network = new vis.Network(graphBox, { nodes: nodes, edges: edges }, {
      edges: { arrows: "to", color: "#9b8a80", font: { align: "middle" } },
      physics: { stabilization: true, barnesHut: { gravitationalConstant: -2000, springLength: 200 } },
      interaction: { hover: true, tooltipDelay: 200 }
    });
  }

  function setGraphMode(mode) {
    _graphMode = mode;
    var chapBtn = document.getElementById("jl-graph-chapter");
    var bookBtn = document.getElementById("jl-graph-book");
    if (chapBtn && bookBtn) {
      if (mode === "chapter") {
        chapBtn.style.background = "#5D4037"; chapBtn.style.color = "#fff";
        bookBtn.style.background = "#E8DDD2"; bookBtn.style.color = "#5D4037";
        renderChapterGraph();
      } else {
        bookBtn.style.background = "#5D4037"; bookBtn.style.color = "#fff";
        chapBtn.style.background = "#E8DDD2"; chapBtn.style.color = "#5D4037";
        loadBookGraph();
      }
    }
  }

  function storageKey() {
    var detail = (document.getElementById("jl-detail") || {}).value || "standard";
    var spoilerFree = (document.getElementById("jl-spoiler-free") || {}).checked ? "safe" : "open";
    // 用 URL 路径 + 章节标题做唯一键（解决 SPA 导航后缓存混乱）
    var urlSlug = location.pathname.replace(/\//g, "_").replace(/[^a-zA-Z0-9_一-鿿-]/g, "").substring(0, 80);
    var title = getChapterTitle().replace(/[^a-zA-Z0-9_一-鿿-]/g, "").substring(0, 50);
    return "JL_" + urlSlug + "_" + title + "_" + detail + "_" + spoilerFree;
  }

  // ═══════════ 核心操作 ═══════════

  async function runAnalyze() {
    if (isRunning) return;
    const now = Date.now();
    const API = await getAPI();
    const token = await getToken();

    // 免登录试用：跳过冷却时间，服务端已有限流
    if (!token) {
      await runGuestAnalyze(API);
      return;
    }

    if (now - lastCallTime < MIN_INTERVAL_MS) {
      setText("#jl-summary", "操作太频繁了，稍等几秒再试。");
      return;
    }
    lastCallTime = now;

    const text = getChapterText();
    if (text.length < 80) {
      setText("#jl-summary", "没有识别到足够的正文内容。");
      return;
    }

    isRunning = true;
    const runBtn = document.getElementById("jl-run");
    runBtn.disabled = true;
    runBtn.textContent = "⏳ 0s";
    runBtn.style.animation = "pulse 1.5s ease infinite";
    var runStartTime = Date.now();
    var runTimer = setInterval(function () {
      var s = Math.floor((Date.now() - runStartTime) / 1000);
      runBtn.textContent = "⏳ " + s + "s";
      setText("#jl-summary", "🤖 AI 正在分析…（" + getModeLabel() + " " + s + "s）");
    }, 1000);

    if (!document.getElementById("jl-pulse-style")) {
      var pulseStyle = document.createElement("style");
      pulseStyle.id = "jl-pulse-style";
      pulseStyle.textContent = "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}";
      document.head.appendChild(pulseStyle);
    }

    try {
      const chapterTitle = getChapterTitle();
      setText("#jl-heading", chapterTitle);
      setText("#jl-summary", "🤖 AI 正在分析…（" + getModeLabel() + "）");

      // 清空上一章详情，避免分析过程中残留旧内容
      ["#jl-characters", "#jl-terms", "#jl-clues"].forEach(function (sel) {
        var box = document.querySelector(sel);
        if (box) box.innerHTML = '<p class="jl-empty">分析中…</p>';
      });

      // 重置伏笔回收卡片
      var payoffCard = document.getElementById("jl-payoff-card");
      if (payoffCard) payoffCard.style.display = "none";

      const bookTitle = getBookTitle();
      const author = getAuthor();
      const chapterIndex = getChapterIndex();

      await streamFetch(API + "/api/analyze/progressive", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({
          text: text,
          chapter_title: chapterTitle,
          source_url: location.href,
          detail_level: document.getElementById("jl-detail").value,
          spoiler_free: document.getElementById("jl-spoiler-free").checked,
          book_title: bookTitle || undefined,
          author: author || undefined,
          chapter_index: chapterIndex
        })
      }, {
        onProgress: null,
        onSummary: function(data) {
          var s = data.summary || "";
          setText("#jl-summary", s + "\n\n⏳ 正在加载人物和伏笔分析…");
        },
        onDone: function(data) {
          var result = normalizeResult(data);
          renderResult(result);

          if (data.cached) {
            var summaryEl = document.getElementById("jl-summary");
            var meta = document.createElement("div");
            meta.className = "jl-meta";
            meta.textContent = "已命中缓存，本次未消耗额度。";
            if (summaryEl && summaryEl.parentElement) summaryEl.parentElement.insertBefore(meta, summaryEl);
          }

          if (data.book_id) {
            var prevBookId = _currentBookId;
            _currentBookId = data.book_id;
            _currentBookTitle = bookTitle || chapterTitle || "当前书籍";
            try { store.set("currentBookId", String(_currentBookId)); store.set("currentBookTitle", _currentBookTitle); } catch (_) {}
            var tag = document.getElementById("jl-book-tag");
            if (tag) tag.textContent = "当前：" + _currentBookTitle;
            updateQABookTag();
            if (prevBookId !== _currentBookId) {
              _chatBookId = _currentBookId;
              _chatHistory = [];
              loadChatHistory();
              renderChatHistory();
              var oldSection = document.getElementById("jl-history-section");
              if (oldSection) oldSection.remove();
              var qContainer = document.getElementById("jl-suggested-questions");
              if (qContainer) qContainer.innerHTML = "";
              var qaTag = document.getElementById("jl-qa-book-tag");
              if (qaTag) qaTag.textContent = "";
            }
            loadAnalysisHistory();
          }

          if (_currentBookId) checkForeshadowingResult(_currentBookId);
          localStorage.setItem(storageKey(), JSON.stringify(result));
        },
        onError: function(message) {
          setText("#jl-summary", message);
        }
      });
    } catch (error) {
      console.error("[鉴来助手] runAnalyze 失败:", error);
      var errMsg = (error && error.message) || "分析失败，请稍后再试。联系客服 QQ：2313370765";

      if (errMsg.indexOf("额度不足") !== -1) {
        errMsg += "\n\n💡 每天签到免费领 8 次额度，打开「账号」标签即可自动领取";
      }

      setText("#jl-summary", errMsg);

      // 重试按钮
      var summaryCard = document.querySelector("#jl-panel-summary .jl-card");
      if (summaryCard) {
        var oldRetry = document.getElementById("jl-retry-btn");
        if (oldRetry) oldRetry.remove();

        var retryBtn = document.createElement("button");
        retryBtn.id = "jl-retry-btn";
        retryBtn.textContent = "🔄 点击重试";
        retryBtn.style.cssText = "margin-top:10px;padding:8px 16px;border:0;border-radius:6px;background:#5d4037;color:#fff;font-size:13px;cursor:pointer";
        retryBtn.addEventListener("click", function () {
          retryBtn.remove();
          runAnalyze();
        });
        summaryCard.appendChild(retryBtn);
      }
    } finally {
      clearInterval(runTimer);
      isRunning = false;
      runBtn.disabled = false;
      runBtn.textContent = "重新分析";
      runBtn.style.animation = "";
    }
  }

  // ═══════════ 反馈按钮 ═══════════

  var _feedbackGiven = null; // 当前分析反馈状态: 'good'|'bad'|null

  function showFeedbackButtons(_result) {
    var summaryCard = document.querySelector("#jl-panel-summary .jl-card");
    if (!summaryCard) return;

    // 移除旧反馈按钮
    var old = document.getElementById("jl-feedback-row");
    if (old) old.remove();
    _feedbackGiven = null;

    var row = document.createElement("div");
    row.id = "jl-feedback-row";
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid #ede4db";
    row.innerHTML =
      '<span style="font-size:11px;color:#8b7c72">分析质量如何？</span>' +
      '<button id="jl-fb-good" style="padding:4px 10px;border:1px solid #c8e6c9;border-radius:14px;background:#e8f5e9;cursor:pointer;font-size:16px" title="不错">👍</button>' +
      '<button id="jl-fb-bad" style="padding:4px 10px;border:1px solid #ffcdd2;border-radius:14px;background:#ffebee;cursor:pointer;font-size:16px" title="不太好">👎</button>';
    summaryCard.appendChild(row);

    row.querySelector("#jl-fb-good").addEventListener("click", function () { sendFeedback("good"); });
    row.querySelector("#jl-fb-bad").addEventListener("click", function () { sendFeedback("bad"); });
  }

  function sendFeedback(rating) {
    if (_feedbackGiven) return;

    getToken().then(function (token) {
      if (!token) return;
      getAPI().then(function (API) {
        var detail = rating === "bad" ? (prompt("方便告诉我们哪里不满意吗？(可选)") || "") : "";

        _feedbackGiven = rating;
        var row = document.getElementById("jl-feedback-row");
        if (row) {
          row.innerHTML = '<span style="font-size:12px;color:#2e7d32">✅ 感谢反馈！</span>';
        }

        safeFetch(API + "/api/feedback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token
          },
          body: JSON.stringify({
            chapter_title: getChapterTitle(),
            rating: rating,
            detail: detail,
            book_id: _currentBookId || undefined
          })
        }).catch(function () {});
      });
    });
  }

  // ═══════════ 伏笔回收检测 ═══════════

  async function checkForeshadowingResult(bookId) {
    var token = await getToken();
    if (!token) return;

    var API = await getAPI();
    try {
      var res = await safeFetch(API + "/api/foreshadowing/check?book_id=" + bookId, {
        method: "POST", headers: { Authorization: "Bearer " + token }
      });
      var payload = await res.json();
      if (!payload.success || !payload.data) return;

      var matches = payload.data.matches || [];
      if (matches.length === 0) return;

      // 在概况面板底部（名词解释后面）显示伏笔回收卡片
      var card = document.getElementById("jl-payoff-card");
      var container = document.getElementById("jl-payoff");
      if (!card || !container) return;

      card.style.display = "";
      clearNode(container);

      matches.forEach(function (m) {
        var div = document.createElement("div");
        div.className = "jl-list-item";
        div.innerHTML =
          '<span style="font-weight:600">✨ ' + escHtml(m.clue || m.reader_message || "未知线索") + '</span>' +
          (m.note || m.reader_message ? '<br><small style="color:#8d6e63">' + escHtml(m.note || m.reader_message) + '</small>' : '') +
          (m.chapter_title ? '<br><small style="color:#a1887f">📖 来自：' + escHtml(m.chapter_title) + '</small>' : '') +
          (m.match_type && m.match_type !== 'possible' ? '<br><small style="color:#e65100;font-weight:500">🔥 ' + ({echo:'线索重现', progress:'线索推进', payoff:'伏笔回收'}[m.match_type] || m.match_type) + '</small>' : '');
        container.appendChild(div);
      });
    } catch (_) {
      // 静默失败，不打断用户
    }
  }

  // ═══════════ 聊天 & 问答 ═══════════

  let _chatHistory = [];         // {type:'q'|'a', text, timestamp}
  let _chatBookId = null;
  const MAX_CHAT_HISTORY = 20;

  function chatStorageKey() {
    return "JL_Chat_" + (_chatBookId || "unknown");
  }

  function saveChatHistory() {
    if (_chatHistory.length === 0) return;
    const key = chatStorageKey();
    try { localStorage.setItem(key, JSON.stringify(_chatHistory.slice(-MAX_CHAT_HISTORY))); } catch (_) {}
  }

  function loadChatHistory() {
    const key = chatStorageKey();
    try {
      const raw = localStorage.getItem(key);
      if (raw) _chatHistory = JSON.parse(raw);
    } catch (_) { _chatHistory = []; }
  }

  function clearChatHistory() {
    _chatHistory = [];
    const key = chatStorageKey();
    try { localStorage.removeItem(key); } catch (_) {}
    renderChatHistory();
    document.getElementById("jl-suggested-questions").innerHTML = "";
    updateQABookTag();
  }

  function addChatMessage(type, text) {
    _chatHistory.push({ type: type, text: text, timestamp: Date.now() });
    if (_chatHistory.length > MAX_CHAT_HISTORY) _chatHistory = _chatHistory.slice(-MAX_CHAT_HISTORY);
    saveChatHistory();
    renderChatHistory();
  }

  function renderChatHistory() {
    const container = document.getElementById("jl-chat-history");
    if (!container) return;
    if (_chatHistory.length === 0) {
      container.innerHTML = '<p class="jl-empty">还没有对话记录，分析章节后可以在这里向助手提问。</p>';
      return;
    }
    container.innerHTML = _chatHistory.map(function (msg) {
      var label = msg.type === "q" ? "你" : "助手";
      var cls = "jl-chat-msg " + (msg.type === "q" ? "q" : "a");
      return '<div class="' + cls + '"><span class="jl-chat-label">' + label + '</span>' + msg.text + '</div>';
    }).join("");
    container.scrollTop = container.scrollHeight;
  }

  function renderSuggestedQuestions(questions) {
    var container = document.getElementById("jl-suggested-questions");
    if (!container) return;
    if (!questions || questions.length === 0) {
      container.innerHTML = "";
      return;
    }
    var label = document.createElement("div");
    label.className = "jl-suggested-label";
    label.textContent = "💡 你可能想问：";

    container.innerHTML = "";
    container.appendChild(label);
    questions.forEach(function (q) {
      var btn = document.createElement("button");
      btn.className = "jl-suggested-item";
      btn.textContent = (typeof q === "string") ? q : (q.question || q);
      btn.addEventListener("click", function () {
        document.getElementById("jl-question").value = btn.textContent;
        askMemory();
      });
      container.appendChild(btn);
    });
  }

  function generateOfflineQuestions() {
    // 从最后一次分析结果中生成推荐问题（不调 AI）
    var key = storageKey();
    var raw;
    try { raw = localStorage.getItem(key); } catch (_) { return []; }
    if (!raw) return [];
    var data;
    try { data = JSON.parse(raw); } catch (_) { return []; }

    var questions = [];
    var characters = (data.characters || []).slice(0, 3);
    var clues = (data.foreshadowing || []).slice(0, 2);
    var terms = (data.terms || []).slice(0, 2);

    characters.forEach(function (c) {
      var name = c.name || c.label || "";
      if (name) questions.push(name + "在之前的章节中做过什么？");
    });
    clues.forEach(function (c) {
      var clue = c.clue || c.text || "";
      if (clue) questions.push("\"" + clue + "\"这条线索有什么后续发展？");
    });
    terms.forEach(function (t) {
      var term = t.term || t.name || "";
      if (term) questions.push(term + "是什么意思，为什么在故事中重要？");
    });
    if (questions.length < 3) {
      questions.push("最近几章的主线推进是什么？");
      questions.push("有哪些需要记住的关键信息？");
    }
    // 去重截断
    var seen = {};
    return questions.filter(function (q) {
      if (seen[q]) return false;
      seen[q] = true;
      return true;
    }).slice(0, 5);
  }

  function updateQABookTag() {
    var tag = document.getElementById("jl-qa-book-tag");
    if (!tag) return;
    if (_currentBookId && _currentBookTitle) {
      tag.textContent = _currentBookTitle;
      tag.style.display = "inline-block";
    } else {
      tag.style.display = "none";
    }
  }

  async function fetchSuggestedQuestions() {
    var btn = document.getElementById("jl-suggest-btn");
    var API = await getAPI();
    var token = await getToken();
    if (!token || !_currentBookId) {
      if (!_currentBookId) {
        var fallback = generateOfflineQuestions();
        if (fallback.length > 0) {
          renderSuggestedQuestions(fallback);
          return;
        }
      }
      return;
    }

    btn.disabled = true;
    btn.textContent = "生成中...";
    try {
      var response = await fetchWithRetry(API + "/api/ask/suggest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ book_id: _currentBookId })
      });
      var payload = await response.json();
      if (!payload.success) throw new Error(payload.error || "生成失败");
      var questions = payload.data.questions || [];
      if (questions.length === 0) {
        questions = generateOfflineQuestions();
      }
      renderSuggestedQuestions(questions);
    } catch (error) {
      console.error("suggestQuestions error:", error);
      var fallback = generateOfflineQuestions();
      if (fallback.length > 0) renderSuggestedQuestions(fallback);
    } finally {
      btn.disabled = false;
      btn.textContent = "✨ 智能推荐";
    }
  }

  async function askMemory() {
    var askBtn = document.getElementById("jl-ask");
    try {
      var API = await getAPI();
      var token = await getToken();
      if (!token) {
        addChatMessage("a", "请先登录：点击顶部「账号」标签。");
        return;
      }

      var question = document.getElementById("jl-question").value.trim();
      if (question.length < 2) {
        addChatMessage("a", "先输入一个想问的问题。");
        return;
      }

      // ── 书切换检测 ──
      var currentBookTitle = getBookTitle();
      var currentBookId = _currentBookId;
      if (_currentBookId && currentBookTitle && _currentBookTitle !== currentBookTitle) {
        var warning = document.createElement("div");
        warning.className = "jl-chat-warning";
        warning.innerHTML = "⚠️ 检测到切换了书籍：当前页面是《" + currentBookTitle + "》，但之前分析的是《" + _currentBookTitle + "》。<br>将用当前页面书名查询，若不对请分析新章后再问。";
        var historyEl = document.getElementById("jl-chat-history");
        if (historyEl) historyEl.appendChild(warning);
        // 用当前书名但保留旧 bookId 以便后端未匹配到新书时仍有提示
      }

      askBtn.disabled = true;
      askBtn.textContent = "思考中...";

      // 添加用户消息
      addChatMessage("q", question);
      document.getElementById("jl-question").value = "";

      // 添加"思考中"占位
      addChatMessage("a", "⏳ 正在读取已分析章节记忆...");
      var thinkingIdx = _chatHistory.length - 1;

      // ── 构建追问上下文 ──
      var conversationContext = [];
      var recentPairs = _chatHistory.filter(function (m) { return m.type === "q" || m.type === "a"; });
      // 取最近两轮 Q&A（不包括当前这条）
      for (var i = Math.max(0, recentPairs.length - 5); i < recentPairs.length - 1; i++) {
        conversationContext.push(recentPairs[i]);
      }

      var body = {
        question: question,
        source_url: location.href,
        spoiler_free: document.getElementById("jl-spoiler-free").checked,
        book_title: currentBookTitle || undefined
      };
      if (_currentBookId) body.book_id = _currentBookId;

      // 如果有追问上下文，附加到问题中
      if (conversationContext.length > 0) {
        var ctxText = conversationContext.map(function (m) {
          return (m.type === "q" ? "用户问：" : "你回答：") + m.text;
        }).join("\n");
        body.question = "[对话历史]\n" + ctxText + "\n\n[当前问题]\n" + question;
      }

      var response = await fetchWithRetry(API + "/api/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify(body)
      });

      var payload = await response.json();
      if (!payload.success) {
        var msg = payload.error || (payload.detail && JSON.stringify(payload.detail)) || "问答失败";
        throw new Error(msg);
      }

      // 替换"思考中"为真实回答
      var answerText = payload.data.answer;
      if (payload.data.book_title) {
        answerText += "\n\n—— " + payload.data.book_title + " · " + payload.data.chapter_range + " · 参考 " + payload.data.memory_count + " 条记忆";
      }
      _chatHistory[thinkingIdx] = { type: "a", text: answerText, timestamp: Date.now() };
      saveChatHistory();
      renderChatHistory();

      // 如果后端有警告，插入警告条
      if (payload.data.warning) {
        var warnDiv = document.createElement("div");
        warnDiv.className = "jl-chat-warning";
        warnDiv.textContent = "⚠️ " + payload.data.warning;
        var historyContainer = document.getElementById("jl-chat-history");
        if (historyContainer) historyContainer.insertBefore(warnDiv, historyContainer.firstChild);
      }
    } catch (error) {
      console.error("askMemory error:", error);
      // 替换"思考中"为错误
      if (_chatHistory.length > 0 && _chatHistory[_chatHistory.length - 1].type === "a" && _chatHistory[_chatHistory.length - 1].text.indexOf("⏳") === 0) {
        _chatHistory.pop();
      }
      var errMsg = (error && error.message) || "问答失败，请稍后再试。";
      if (errMsg.indexOf("timeout") > -1 || errMsg.indexOf("超时") > -1) {
        errMsg = "AI 响应超时，问题可能太复杂，试试换种问法。";
      }
      // 保存失败问题，供重试用
      _lastFailedQuestion = question;
      addChatMessage("a", "❌ " + errMsg + '\n\n<span style="font-size:11px;opacity:.7">点击输入框旁的 🔄 按钮可重试</span>');
    } finally {
      askBtn.disabled = false;
      askBtn.textContent = "询问已读记忆";
    }
  }

  async function loadOverview() {
    const API = await getAPI();
    const token = await getToken();
    if (!token || !_currentBookId) {
      document.getElementById("jl-overview-list").innerHTML =
        '<div class="jl-ov-empty">请先分析章节，建立书籍上下文</div>';
      return;
    }
    try {
      const resp = await safeFetch(API + "/api/books/" + _currentBookId + "/foreshadowing", {
        headers: { Authorization: "Bearer " + token }
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      const clues = data.data.foreshadowing || [];
      const total = data.data.total || 0;

      // 统计
      const openCount = clues.filter(c => c.status === "open").length;
      const progressCount = clues.filter(c => c.status === "progress").length;
      const payoffCount = clues.filter(c => c.status === "payoff").length;

      document.getElementById("jl-overview-stats").innerHTML =
        '<span class="jl-ov-stat"><span class="jl-ov-dot open"></span> 开放中 ' + openCount + '</span>' +
        '<span class="jl-ov-stat"><span class="jl-ov-dot progress"></span> 推进中 ' + progressCount + '</span>' +
        '<span class="jl-ov-stat"><span class="jl-ov-dot payoff"></span> 已回收 ' + payoffCount + '</span>' +
        '<span class="jl-ov-stat" style="color:#8b7c72">共 ' + total + ' 条</span>';

      // 列表
      if (clues.length === 0) {
        document.getElementById("jl-overview-list").innerHTML =
          '<div class="jl-ov-empty">本书暂未发现伏笔线索，多分析几章后会自动汇总</div>';
        return;
      }
      const confColors = [
        "background:#ffebee;color:#c62828",  // 0-25
        "background:#fff3e0;color:#e65100",  // 25-50
        "background:#fffde7;color:#f9a825",  // 50-70
        "background:#e8f5e9;color:#2e7d32",  // 70-100
      ];
      let html = "";
      clues.forEach(c => {
        const ci = c.confidence < 25 ? 0 : c.confidence < 50 ? 1 : c.confidence < 70 ? 2 : 3;
        html += '<div class="jl-ov-item">' +
          '<div class="jl-ov-header">' +
            '<span class="jl-ov-clue">' + (c.clue || "未命名线索") + '</span>' +
            '<span class="jl-ov-confidence" style="' + confColors[ci] + '">可信度 ' + (c.confidence || 0) + '%</span>' +
          '</div>' +
          (c.reason ? '<div class="jl-ov-reason">' + c.reason + '</div>' : '') +
          '<div class="jl-ov-chapter">📍 ' + (c.chapter_title || "未知章节") + '</div>' +
        '</div>';
      });
      document.getElementById("jl-overview-list").innerHTML = html;
    } catch (e) {
      document.getElementById("jl-overview-list").innerHTML =
        '<div class="jl-ov-empty">加载失败：' + (e.message || "网络错误") + '</div>';
    }
  }

  // ═══════════ P3-1: 分析历史（服务端加载，跨设备同步） ═══════════

  async function loadAnalysisHistory() {
    if (!_currentBookId) return;

    // 避免重复加载
    var panel = document.getElementById("jl-panel-summary");
    if (document.getElementById("jl-history-section")) return;

    var API = await getAPI();
    var token = await getToken();
    if (!token) return;

    try {
      var resp = await safeFetch(API + "/api/books/" + _currentBookId + "/analyses", {
        headers: { Authorization: "Bearer " + token }
      });
      var payload = await resp.json();
      if (!payload.success || !payload.data) return;

      var analyses = payload.data.analyses || [];
      if (analyses.length === 0) return;

      // 构建章节→服务端分析数据的映射（优先于 localStorage）
      _serverAnalysisMap = {};
      analyses.forEach(function (a) {
        var key = a.chapter_title || "";
        if (key && a.result_json) {
          try {
            _serverAnalysisMap[key] = typeof a.result_json === "string" ? JSON.parse(a.result_json) : a.result_json;
          } catch (_) {}
        }
      });

      // 排序逻辑
      // 从章节标题提取序号（支持"第123章"阿拉伯数字和"第十二章"中文数字）
      function extractChapterNumber(title) {
        if (!title) return null;
        var m = title.match(/第\s*(\d+)\s*章/);
        if (m) return parseInt(m[1], 10);
        m = title.match(/第\s*([一二三四五六七八九十百千万零]+)\s*章/);
        if (m) return chineseToNumber(m[1]);
        return null;
      }

      function chineseToNumber(s) {
        var map = {零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,
                   十:10,百:100,千:1000,万:10000};
        var result = 0, temp = 0;
        for (var i = 0; i < s.length; i++) {
          var ch = s[i], val = map[ch];
          if (val == null) return null;
          if (val >= 10) {
            if (temp === 0) temp = 1;
            temp = temp * val;
            if (val >= 10000) { result += temp; temp = 0; }
          } else {
            result += temp;
            temp = val;
          }
        }
        return result + temp;
      }

      function sortAnalyses(list, mode) {
        var sorted = list.slice();
        if (mode === "chapter") {
          sorted.sort(function (a, b) {
            var ai = extractChapterNumber(a.chapter_title);
            var bi = extractChapterNumber(b.chapter_title);
            if (ai == null && bi == null) return b.created_at - a.created_at;
            if (ai == null) return 1;
            if (bi == null) return -1;
            return ai - bi;
          });
        } else {
          sorted.sort(function (a, b) { return b.created_at - a.created_at; });
        }
        return sorted;
      }

      function renderHistList(section, analyses) {
        var listDiv = section.querySelector("#jl-hist-list");
        if (!listDiv) {
          listDiv = document.createElement("div");
          listDiv.id = "jl-hist-list";
          listDiv.style.cssText = "max-height:200px;overflow-y:auto;margin-top:8px";
          section.appendChild(listDiv);
        }
        var display = sortAnalyses(analyses, _historySortMode).slice(0, 50);
        listDiv.innerHTML = display.map(function (a) {
          var date = a.created_at ? new Date(a.created_at * 1000).toLocaleDateString("zh-CN") : "";
          var hasData = !!_serverAnalysisMap[a.chapter_title || ""];
          var icon = hasData ? "📋" : "🔒";
          var num = a.chapter_index != null ? "#" + a.chapter_index + " " : "";
          return '<div class="jl-list-item jl-hist-item" data-chapter="' + (a.chapter_title || "").replace(/"/g, "&quot;") + '" data-id="' + a.id + '" style="font-size:12px;cursor:pointer;transition:background .15s;display:flex;justify-content:space-between;align-items:center" onmouseover="this.style.background=\'#f4eee8\'" onmouseout="this.style.background=\'\'">' +
            '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + icon + ' <b>' + num + (a.chapter_title || "未知章节") + '</b>' +
            (date ? ' <span style="color:#8b7c72;font-size:11px">' + date + '</span>' : '') + '</span>' +
            '<span class="jl-hist-del" data-id="' + a.id + '" style="cursor:pointer;opacity:0.35;font-size:13px;flex-shrink:0;margin-left:6px" title="删除此分析">🗑️</span>' +
          '</div>';
        }).join("");
        // 重新绑定事件
        listDiv.querySelectorAll(".jl-hist-item").forEach(function (item) {
          item.addEventListener("click", function (e) {
            if (e.target.closest(".jl-hist-del")) {
              var id = parseInt(e.target.closest(".jl-hist-del").dataset.id);
              if (id && confirm("确定删除「" + (item.querySelector("b") || {}).textContent + "」的分析记录？")) {
                deleteAnalysis(id, item);
              }
              return;
            }
            loadHistoryChapter(this.dataset.chapter);
            var main = document.querySelector(".jl-main");
            if (main) main.scrollTop = 0;
          });
        });
      }

      function updateSortButtons(section) {
        var timeBtn = section.querySelector("#jl-sort-time");
        var chapBtn = section.querySelector("#jl-sort-chapter");
        if (!timeBtn || !chapBtn) return;
        if (_historySortMode === "chapter") {
          chapBtn.style.background = "#5D4037"; chapBtn.style.color = "#fff";
          timeBtn.style.background = "#E8DDD2"; timeBtn.style.color = "#5D4037";
        } else {
          timeBtn.style.background = "#5D4037"; timeBtn.style.color = "#fff";
          chapBtn.style.background = "#E8DDD2"; chapBtn.style.color = "#5D4037";
        }
      }

      // 在概况面板底部插入历史章节列表
      var section = document.createElement("div");
      section.id = "jl-history-section";
      section.className = "jl-card";
      section.innerHTML =
        '<h3 style="display:flex;justify-content:space-between;align-items:center">' +
          '<span>📚 本书已分析 ' + analyses.length + ' 章</span>' +
          '<span style="font-size:11px;font-weight:normal">' +
            '<button id="jl-sort-time" class="jl-sort-btn" style="cursor:pointer;border:1px solid #a1887f;padding:1px 8px;border-radius:10px;margin:0 2px;font-size:10px">⏱ 按时间</button>' +
            '<button id="jl-sort-chapter" class="jl-sort-btn" style="cursor:pointer;border:1px solid #a1887f;padding:1px 8px;border-radius:10px;margin:0 2px;font-size:10px">📖 按章节</button>' +
          '</span>' +
        '</h3>' +
        '<p style="font-size:10px;color:#8b7c72;margin:2px 0 6px">点击章节查看 · 🗑️ 删除（服务端同步）</p>';

      // 渲染列表
      renderHistList(section, analyses);
      updateSortButtons(section);

      // 排序切换事件
      section.querySelector("#jl-sort-time").addEventListener("click", function () {
        _historySortMode = "time";
        try { localStorage.setItem("JL_HistSort", "time"); } catch (_) {}
        renderHistList(section, analyses);
        updateSortButtons(section);
      });
      section.querySelector("#jl-sort-chapter").addEventListener("click", function () {
        _historySortMode = "chapter";
        try { localStorage.setItem("JL_HistSort", "chapter"); } catch (_) {}
        renderHistList(section, analyses);
        updateSortButtons(section);
      });

      var cards = panel.querySelectorAll(".jl-card");
      var lastCard = cards[cards.length - 1];
      if (lastCard) {
        lastCard.insertAdjacentElement("afterend", section);
      } else {
        panel.appendChild(section);
      }
    } catch (_) {
      // 静默失败，不影响主流程
    }
  }

  async function deleteAnalysis(analysisId, domItem) {
    var API = await getAPI();
    var token = await getToken();
    if (!token) { alert("请先登录"); return; }
    try {
      var resp = await safeFetch(API + "/api/analyses/" + analysisId, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token }
      });
      var payload = await resp.json();
      if (!payload.success) { alert(payload.error || "删除失败"); return; }
      if (domItem) {
        domItem.style.transition = "opacity .3s";
        domItem.style.opacity = "0";
        setTimeout(function () { if (domItem.parentNode) domItem.remove(); }, 300);
      }
      var section = document.getElementById("jl-history-section");
      if (section) {
        var h3 = section.querySelector("h3");
        var remaining = section.querySelectorAll(".jl-hist-item").length;
        if (h3) h3.textContent = "📚 本书已分析 " + remaining + " 章";
      }
    } catch (e) {
      alert("删除失败: " + (e.message || "网络错误"));
    }
  }

  function loadHistoryChapter(chapterTitle) {
    // 优先从服务端数据加载（跨设备同步），其次从 localStorage
    var found = null;

    // 策略 1: 服务端数据（_serverAnalysisMap）
    if (typeof _serverAnalysisMap === "object" && _serverAnalysisMap[chapterTitle]) {
      found = _serverAnalysisMap[chapterTitle];
    }

    // 策略 2: localStorage 兜底
    if (!found) {
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf("JL_Archive_") === 0 && k.indexOf(chapterTitle) !== -1) {
          try {
            var data = JSON.parse(localStorage.getItem(k));
            if (data && data.summary) { found = data; break; }
          } catch (_) {}
        }
      }
    }

    if (found) {
      renderResult(found);
      var meta = document.createElement("div");
      meta.className = "jl-meta";
      meta.textContent = "📋 正在查看历史分析：" + chapterTitle;
      document.getElementById("jl-summary").parentElement.insertBefore(meta, document.getElementById("jl-summary"));
      switchPanel("summary");
      // 滚动到面板顶部，确保用户能看到结果
      var mainEl = document.querySelector(".jl-main");
      if (mainEl) mainEl.scrollTop = 0;
    } else {
      alert("未找到该章节的分析数据，请重新分析当前章节");
    }
  }

  // ═══════════ P3-2: 全书累计人物关系图 ═══════════

  async function loadBookGraph() {
    var graphBox = document.getElementById("jl-graph");
    if (!graphBox) return;

    // 先显示加载状态
    if (!_currentBookId) {
      graphBox.innerHTML = '<div class="jl-ov-empty">请先分析当前章节，建立书籍上下文后再查看关系图</div>';
      return;
    }

    graphBox.innerHTML = '<div class="jl-ov-empty">正在加载全书人物关系...</div>';

    var API = await getAPI();
    var token = await getToken();
    if (!token) {
      graphBox.innerHTML = '<div class="jl-ov-empty">请先登录</div>';
      return;
    }

    try {
      var resp = await safeFetch(API + "/api/books/" + _currentBookId + "/characters", {
        headers: { Authorization: "Bearer " + token }
      });
      var payload = await resp.json();
      if (!payload.success || !payload.data) {
        graphBox.innerHTML = '<div class="jl-ov-empty">暂无人物数据</div>';
        return;
      }

      var characters = payload.data.characters || [];
      if (characters.length === 0) {
        graphBox.innerHTML = '<div class="jl-ov-empty">分析更多章节后，这里将展示全书人物关系网</div>';
        return;
      }

      // 构建累计关系图
      var nodes = [];
      var edges = [];
      var seenNodes = {};
      var seenEdges = {};

      characters.forEach(function (char, idx) {
        var id = "c" + idx;
        if (seenNodes[char.name]) return;
        seenNodes[char.name] = true;

        var appearanceCount = (char.appearances || []).length;
        var isCore = appearanceCount >= 3;
        nodes.push({
          id: id,
          label: char.name,
          level: isCore ? "core" : "normal",
          color: {
            background: isCore ? "#fff176" : "#d7ccc8",
            border: "#8d6e63"
          },
          font: { size: isCore ? 18 : 14 },
          shape: "dot",
          size: isCore ? 28 : 18,
          title: char.name + "（出场 " + appearanceCount + " 章）"
        });

        // 处理关系
        var relationships = char.relationships || [];
        relationships.forEach(function (rel) {
          if (typeof rel === "string") {
            // 简单的字符串关系
            var parts = rel.split(/[：:与和、，,]+/);
            parts.forEach(function (target) {
              target = target.trim();
              if (target && target !== char.name) {
                var edgeKey = [char.name, target].sort().join("--");
                if (!seenEdges[edgeKey]) {
                  seenEdges[edgeKey] = true;
                  edges.push({ from: id, to: target, label: "" });
                }
              }
            });
          }
        });
      });

      // 给 edges 中的 to 字段匹配 node id
      var nameToId = {};
      nodes.forEach(function (n) { nameToId[n.label] = n.id; });
      edges = edges.filter(function (e) {
        if (nameToId[e.to]) { e.to = nameToId[e.to]; return true; }
        return false;
      });

      // 用 vis-network 渲染（当前环境不支持时降级为文字列表）
      if (!window.vis) {
        renderGraphAsText(graphBox, { nodes: nodes, edges: edges });
        return;
      }

      graphBox.innerHTML = "";
      graphBox.style.height = "560px";
      if (network) { network.destroy(); network = null; }
    network = new vis.Network(graphBox, { nodes: nodes, edges: edges }, {
        edges: { arrows: "to", color: "#9b8a80", font: { align: "middle" } },
        physics: { stabilization: true, barnesHut: { gravitationalConstant: -2000, springLength: 200 } },
        interaction: { hover: true, tooltipDelay: 200 }
      });

      // 添加统计文字
      var stats = document.createElement("div");
      stats.style.cssText = "text-align:center;padding:4px;font-size:11px;color:#8b7c72";
      stats.textContent = "全书 " + nodes.length + " 个人物 · " + edges.length + " 条关系";
      graphBox.parentElement.appendChild(stats);

    } catch (e) {
      graphBox.innerHTML = '<div class="jl-ov-empty">加载失败：' + (e.message || "网络错误") + '</div>';
    }
  }

  async function reviewRecent() {
    const API = await getAPI();
    const token = await getToken();
    if (!token) {
      setText("#jl-summary", "请先登录后使用。");
      switchPanel("account");
      return;
    }

    if (!_currentBookId) {
      setText("#jl-summary", "请先分析当前章节，建立书籍上下文后再使用回顾功能。");
      return;
    }

    const reviewBtn = document.getElementById("jl-review");
    reviewBtn.disabled = true;
    reviewBtn.textContent = "生成中...";
    setText("#jl-summary", "正在生成最近 10 章追更回顾...");

    try {
      const response = await fetchWithRetry(API + "/api/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ book_id: _currentBookId, chapter_count: 10 })
      });

      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error || "回顾生成失败");

      setText("#jl-summary", payload.data.review);

      const meta = document.createElement("div");
      meta.className = "jl-meta";
      meta.textContent = "已回顾 " + payload.data.book_title + " 最近 " + payload.data.chapters_covered + " 章";
      const summaryEl = document.getElementById("jl-summary");
      summaryEl.parentElement.insertBefore(meta, summaryEl);
    } catch (error) {
      setText("#jl-summary", error.message || "回顾生成失败，请稍后再试。");
    } finally {
      reviewBtn.disabled = false;
      reviewBtn.textContent = "最近回顾";
    }
  }

  var _reportAbortController = null;

  async function fullReport() {
    const API = await getAPI();
    const token = await getToken();
    if (!token) {
      setText("#jl-summary", "请先登录后使用。");
      switchPanel("account");
      return;
    }

    if (!_currentBookId) {
      setText("#jl-summary", "请先分析当前章节，建立书籍上下文后再使用全书复盘功能。");
      return;
    }

    // 扣分确认提示
    if (!confirm("📊 全书复盘将消耗 20 积分，生成一份包含主线梳理、人物谱系、伏笔追踪等内容的深度报告。\n\n适合章节较多的长篇书籍。如果只读了一两章，建议直接逐章分析（每章仅 1 积分）。\n\n确定要继续吗？")) {
      return;
    }

    const reportBtn = document.getElementById("jl-full-report");
    const reviewBtn = document.getElementById("jl-review");
    reportBtn.disabled = true;
    reportBtn.textContent = "生成中…";
    if (reviewBtn) reviewBtn.disabled = true;

    // 切换到摘要面板
    switchPanel("summary");

    // 取消按钮
    var cancelBtn = document.createElement("button");
    cancelBtn.id = "jl-cancel-report";
    cancelBtn.textContent = "取消生成";
    cancelBtn.style.cssText = "margin:8px 0;padding:4px 16px;background:#ffebee;color:#c62828;border:1px solid #ef9a9a;border-radius:6px;cursor:pointer;font-size:12px";
    var summaryCard = document.querySelector("#jl-panel-summary .jl-card");
    if (summaryCard) summaryCard.prepend(cancelBtn);

    // 阶段提示轮播
    var stages = ["📖 正在梳理主线剧情…", "👥 正在分析人物关系…", "🔍 正在追踪伏笔线索…", "📝 正在生成最终报告…"];
    var stageIdx = 0;
    var startTime = Date.now();
    setText("#jl-summary", stages[0] + "\n\n⏱ 已耗时 0 秒");
    var stageTimer = setInterval(function () {
      stageIdx = (stageIdx + 1) % stages.length;
      var elapsed = Math.floor((Date.now() - startTime) / 1000);
      setText("#jl-summary", stages[stageIdx] + "\n\n⏱ 已耗时 " + elapsed + " 秒");
    }, 3000);

    // AbortController 支持取消
    _reportAbortController = new AbortController();
    cancelBtn.addEventListener("click", function () {
      if (_reportAbortController) _reportAbortController.abort();
      clearInterval(stageTimer);
    });

    try {
      const response = await fetchWithRetry(API + "/api/report/full", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ book_id: _currentBookId }),
        signal: _reportAbortController.signal
      });

      clearInterval(stageTimer);

      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error || "报告生成失败");

      setText("#jl-summary", payload.data.report);

      // 显示报告元信息
      const container = document.getElementById("jl-summary").parentElement;
      const existingMeta = container.querySelector(".jl-report-meta");
      if (existingMeta) existingMeta.remove();

      const meta = document.createElement("div");
      meta.className = "jl-report-meta";
      meta.innerHTML =
        '<span style="color:#5d4037">📊 全书复盘 · ' + payload.data.book_title +
        ' · 覆盖 ' + payload.data.chapters_covered + ' 章 · 消耗 ' + payload.data.credits_cost + ' 积分</span>' +
        ' <button id="jl-download-report" class="jl-text-btn">📥 下载报告</button>';
      const summaryEl = document.getElementById("jl-summary");
      container.insertBefore(meta, summaryEl);

      // 下载按钮
      document.getElementById("jl-download-report").addEventListener("click", function () {
        const blob = new Blob(
          ["# " + payload.data.book_title + " 全书复盘报告\n\n" + payload.data.report],
          { type: "text/markdown;charset=utf-8" }
        );
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = payload.data.book_title + "_全书复盘.md";
        link.click();
        URL.revokeObjectURL(url);
      });
    } catch (error) {
      clearInterval(stageTimer);
      if (error.name === "AbortError") {
        setText("#jl-summary", "已取消全书复盘，积分已返还。");
      } else {
        setText("#jl-summary", error.message || "报告生成失败，请稍后再试。");
      }
    } finally {
      _reportAbortController = null;
      if (cancelBtn.parentNode) cancelBtn.remove();
      reportBtn.disabled = false;
      reportBtn.textContent = "全书复盘";
      if (reviewBtn) reviewBtn.disabled = false;
    }
  }

  function exportResult() {
    const data = JSON.parse(localStorage.getItem(storageKey()) || "{}");
    const title = getChapterTitle();
    const content = [
      "# " + title,
      "",
      "## 本章概况",
      data.summary || "",
      "",
      "## 关键人物",
      ...(data.characters || []).map((item) => "- " + (item.name || item.label) + ": " + (item.note || item.role || "")),
      "",
      "## 疑似伏笔",
      ...(data.foreshadowing || []).map((item) => "- " + (item.clue || item.text) + ": " + (item.reason || "")),
      "",
      "## 名词解释",
      ...(data.terms || []).map((item) => "- " + (item.term || item.name) + ": " + (item.meaning || item.note || ""))
    ].join("\n");

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = title + ".txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  // ═══════════ 关系图文字降级（无 vis-network 环境，如 Alook） ═══════════

  function renderGraphAsText(box, graph) {
    if (!box) return;
    var nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
    var edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
    clearNode(box);
    box.style.height = "auto";
    if (nodes.length === 0) {
      box.innerHTML = '<div class="jl-ov-empty">暂无人物关系数据</div>';
      return;
    }

    var nameById = {};
    nodes.forEach(function (n) { nameById[n.id] = String(n.label || n.name || n.id); });

    var wrap = document.createElement("div");
    wrap.style.cssText = "padding:12px";

    var hint = document.createElement("p");
    hint.style.cssText = "font-size:11px;color:#A1887F;margin:0 0 10px";
    hint.textContent = "当前浏览器不支持图形渲染，以下为文字版人物关系（⭐ 为核心人物）：";
    wrap.appendChild(hint);

    var peopleCard = document.createElement("div");
    peopleCard.className = "jl-card";
    var peopleTitle = document.createElement("h3");
    peopleTitle.textContent = "人物（" + nodes.length + "）";
    peopleCard.appendChild(peopleTitle);
    var names = document.createElement("p");
    names.textContent = nodes.map(function (n) {
      var name = String(n.label || n.name || n.id);
      return n.level === "core" ? "⭐" + name : name;
    }).join("、");
    peopleCard.appendChild(names);
    wrap.appendChild(peopleCard);

    var relCard = document.createElement("div");
    relCard.className = "jl-card";
    var relTitle = document.createElement("h3");
    relTitle.textContent = "关系（" + edges.length + "）";
    relCard.appendChild(relTitle);
    if (edges.length === 0) {
      var none = document.createElement("p");
      none.className = "jl-empty";
      none.textContent = "暂无明确关系";
      relCard.appendChild(none);
    } else {
      edges.forEach(function (e) {
        var row = document.createElement("div");
        row.className = "jl-list-item";
        var from = nameById[e.from] || String(e.from);
        var to = nameById[e.to] || String(e.to);
        row.textContent = e.label ? (from + " —" + e.label + "→ " + to) : (from + " → " + to);
        relCard.appendChild(row);
      });
    }
    wrap.appendChild(relCard);
    box.appendChild(wrap);
  }

  // ═══════════ 账号面板（移植自扩展 popup.js） ═══════════

  function accMessage(text, type) {
    var el = document.getElementById("jl-acc-msg");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = type === "error" ? "#c62828" : type === "success" ? "#2e7d32" : "#6D4C41";
  }

  function updateCreditsChip(credits) {
    var chip = document.getElementById("jl-credits-chip");
    if (!chip) return;
    if (credits === null || credits === undefined) {
      chip.style.display = "none";
      return;
    }
    chip.textContent = "⚡ " + (credits > 99 ? "99+" : credits);
    chip.style.background = credits <= 0 ? "#c62828" : credits <= 5 ? "#e65100" : "rgba(255,255,255,.15)";
    chip.style.display = "inline-block";
  }

  async function renderAccountPanel() {
    var authBox = document.getElementById("jl-auth-box");
    var userBox = document.getElementById("jl-user-box");
    if (!authBox || !userBox) return;

    var token = await getToken(); // 内部已处理过期检测与静默刷新
    if (!token) {
      authBox.style.display = "block";
      userBox.style.display = "none";
      updateCreditsChip(null);
      return;
    }

    try {
      var API = await getAPI();
      var resp = await safeFetch(API + "/api/me", { headers: { Authorization: "Bearer " + token } });
      if (resp.status === 401) {
        clearAuth();
        authBox.style.display = "block";
        userBox.style.display = "none";
        updateCreditsChip(null);
        accMessage("登录已过期，请重新登录", "error");
        return;
      }
      var payload = await resp.json();
      if (!payload || !payload.success) throw new Error((payload && payload.error) || "获取账号信息失败");
      var me = payload.data;

      document.getElementById("jl-acc-username").textContent = store.get("username") || "用户";
      document.getElementById("jl-acc-credits").textContent = me.credits;

      var lowMsg = document.getElementById("jl-acc-low");
      if (me.credits <= 5) {
        lowMsg.style.display = "block";
        lowMsg.textContent = me.credits === 0
          ? "额度已用完！每天打开本页自动签到领取免费额度"
          : "仅剩 " + me.credits + " 次额度，每天打开本页自动签到领取";
      } else {
        lowMsg.style.display = "none";
      }

      if (me.daily_bonus > 0) accMessage("✨ " + me.message, "success");

      authBox.style.display = "none";
      userBox.style.display = "block";
      updateCreditsChip(me.credits);
    } catch (error) {
      // 网络错误不清除登录态，仅提示（区别于 401）
      accMessage(error.message || "网络错误，稍后重试", "error");
    }
  }

  var _sendCodeCooldown = 0;

  async function sendEmailCode() {
    var email = (document.getElementById("jl-login-email").value || "").trim();
    if (!email || email.indexOf("@") === -1) {
      accMessage("请输入有效的邮箱地址", "error");
      return;
    }
    if (Date.now() - _sendCodeCooldown < 60000) {
      accMessage("请等待 60 秒后再发送", "error");
      return;
    }

    var btn = document.getElementById("jl-send-code");
    btn.disabled = true;
    btn.textContent = "发送中...";

    try {
      var API = await getAPI();
      var resp = await safeFetch(API + "/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email })
      });
      var payload = await resp.json().catch(function () { return null; });
      if (!resp.ok || !payload || !payload.success) {
        throw new Error((payload && payload.error) || "发送失败，请稍后再试");
      }
      _sendCodeCooldown = Date.now();
      accMessage("验证码已发送，请查收邮件", "success");

      var sec = 60;
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
      accMessage(error.message, "error");
      btn.textContent = "获取验证码";
      btn.disabled = false;
    }
  }

  async function emailLogin() {
    var email = (document.getElementById("jl-login-email").value || "").trim();
    var code = (document.getElementById("jl-login-code").value || "").trim();

    if (!email || email.indexOf("@") === -1) {
      accMessage("请输入有效的邮箱地址", "error");
      return;
    }
    if (code.length !== 6) {
      accMessage("请输入 6 位验证码", "error");
      return;
    }

    var btn = document.getElementById("jl-login-btn");
    btn.disabled = true;
    accMessage("正在验证...");

    try {
      var API = await getAPI();
      var resp = await safeFetch(API + "/api/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, code: code })
      });
      var payload = await resp.json().catch(function () { return null; });
      if (!resp.ok || !payload || !payload.success) {
        throw new Error((payload && payload.error) || "验证失败，请检查验证码");
      }
      var data = payload.data;
      store.set("token", data.token);
      store.set("refreshToken", data.refresh_token);
      store.set("username", data.username);

      document.getElementById("jl-login-code").value = "";
      accMessage(data.is_new ? "欢迎注册！已领取免费额度" : "登录成功", "success");
      renderAccountPanel();
      setTimeout(function () {
        switchPanel("summary");
        setText("#jl-summary", "登录成功！点击下方「分析当前章节」开始使用。");
      }, 900);
    } catch (error) {
      accMessage(error.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function logout() {
    var token = store.get("token");
    var refreshToken = store.get("refreshToken");
    // 通知服务端作废 refresh_token（fire-and-forget）
    if (token && refreshToken) {
      try {
        var API = await getAPI();
        safeFetch(API + "/api/auth/logout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token
          },
          body: JSON.stringify({ refresh_token: refreshToken })
        }).catch(function () {});
      } catch (_) {}
    }
    clearAuth();
    accMessage("已退出登录");
    renderAccountPanel();
  }

  function saveApiUrl() {
    var input = document.getElementById("jl-api-url");
    var url = (input.value || "").trim().replace(/\/+$/, "");
    if (!url) {
      accMessage("请输入服务器地址", "error");
      return;
    }
    store.set("api_url", url);
    accMessage("服务器地址已保存", "success");
    renderAccountPanel();
  }

  // ═══════════ 入口：右下角悬浮球（替代扩展 popup 触发） ═══════════

  async function openHelper() {
    var win = createWindow();
    var heading = win.querySelector("#jl-heading");
    if (heading) heading.textContent = getChapterTitle();
    showOnboarding();
    renderAccountPanel();
    var token = await getToken();
    if (!token) switchPanel("account");
  }

  function createLauncher() {
    if (document.getElementById("jl-launcher")) return;
    var ball = document.createElement("div");
    ball.id = "jl-launcher";
    ball.title = "鉴来助手 - 点击打开";
    ball.textContent = "📖";
    ball.style.cssText = "position:fixed;right:14px;bottom:90px;width:48px;height:48px;z-index:2147483646;display:flex;align-items:center;justify-content:center;font-size:24px;border-radius:50%;background:linear-gradient(135deg,#3E2723,#6D4C41);box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .15s";
    ball.addEventListener("mouseenter", function () { ball.style.transform = "scale(1.08)"; });
    ball.addEventListener("mouseleave", function () { ball.style.transform = ""; });
    ball.addEventListener("click", openHelper);
    document.body.appendChild(ball);
  }

  function init() {
    if (!document.body) { setTimeout(init, 300); return; }
    createLauncher();
  }
  init();
    // ═══════════ 划词查询人物 ═══════════
  var _characterIndex = {};  // 人物名 → {notes, chapters, foreshadowing}

  function buildCharacterIndex() {
    var index = {};
    // 从服务端数据收集所有人物
    if (typeof _serverAnalysisMap === "object") {
      Object.keys(_serverAnalysisMap).forEach(function (chTitle) {
        var analysis = _serverAnalysisMap[chTitle];
        var chars = analysis.characters || [];
        chars.forEach(function (c) {
          var name = (c.name || c.label || "").trim();
          if (!name || name.length < 1 || name.length > 20) return;
          if (!index[name]) {
            index[name] = { notes: [], chapters: [], foreshadowing: [], terms: [] };
          }
          if (c.note && index[name].notes.indexOf(c.note) === -1) {
            index[name].notes.push(c.note);
          }
          if (index[name].chapters.indexOf(chTitle) === -1) {
            index[name].chapters.push(chTitle);
          }
        });
        // 收集术语
        (analysis.terms || []).forEach(function (t) {
          var term = (t.term || t.name || "").trim();
          if (!term || term.length < 1 || term.length > 20) return;
          if (!index[term]) {
            index[term] = { notes: [], chapters: [], foreshadowing: [], terms: [t.meaning || ""] };
          }
        });
      });
    }
    _characterIndex = index;
  }

  function showCharacterTooltip(name, info, x, y) {
    dismissTooltip();
    var tip = document.createElement("div");
    tip.id = "jl-char-tooltip";
    var notesHTML = info.notes.slice(0, 3).map(function (n) {
      return '<span class="jl-ct-note">' + escHtml(n) + '</span>';
    }).join("");
    var chaptersHTML = info.chapters.slice(-3).map(function (c) {
      return '<span class="jl-ct-chapter">📖 ' + escHtml(c) + '</span>';
    }).join("");
    var clueHTML = info.foreshadowing.slice(0, 2).map(function (f) {
      return '<span class="jl-ct-clue">🔍 ' + escHtml(f) + '</span>';
    }).join("");
    tip.innerHTML =
      '<div class="jl-ct-header">' +
        '<span class="jl-ct-name">' + escHtml(name) + '</span>' +
        '<button class="jl-ct-close" onclick="dismissTooltip()">×</button>' +
      '</div>' +
      (notesHTML ? '<div class="jl-ct-section"><div class="jl-ct-label">角色定位</div>' + notesHTML + '</div>' : '') +
      (chaptersHTML ? '<div class="jl-ct-section"><div class="jl-ct-label">近期出场</div>' + chaptersHTML + '</div>' : '') +
      (clueHTML ? '<div class="jl-ct-section"><div class="jl-ct-label">关联线索</div>' + clueHTML + '</div>' : '') +
      (info.terms.length ? '<div class="jl-ct-section"><div class="jl-ct-label">名词解释</div><span class="jl-ct-note">' + escHtml(info.terms[0]) + '</span></div>' : '') +
      '<div class="jl-ct-footer">共 ' + info.chapters.length + ' 章出场 · 点击外部关闭</div>';
    tip.style.cssText = 'position:fixed;z-index:2147483650;width:min(340px,90vw);max-height:420px;overflow-y:auto;background:#fffef9;border:1px solid #D7CCC8;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.16);padding:16px;font-size:13px;animation:jlFadeIn .2s ease';
    document.body.appendChild(tip);
    // 定位在选中文字附近
    var tipW = tip.offsetWidth;
    var tipH = Math.min(tip.offsetHeight, 420);
    var left = Math.min(x + 10, window.innerWidth - tipW - 16);
    var top = y + 20;
    if (top + tipH > window.innerHeight - 80) top = y - tipH - 10;
    if (top < 16) top = 16;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  window.dismissTooltip = function () {
    var el = document.getElementById("jl-char-tooltip");
    if (el) el.remove();
  };

  document.addEventListener("mouseup", function (e) {
    setTimeout(function () {
      var sel = window.getSelection();
      var text = (sel.toString() || "").trim();
      // 只匹配 1-10 个字符的人名/术语
      if (!text || text.length < 1 || text.length > 10) return;
      if (/[\x00-\x1f<>]/.test(text)) return;
      // 查找匹配
      var info = _characterIndex[text];
      if (!info) {
        // 模糊匹配（包含关系）
        var keys = Object.keys(_characterIndex);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf(text) !== -1 || text.indexOf(keys[i]) !== -1) {
            info = _characterIndex[keys[i]];
            text = keys[i];
            break;
          }
        }
      }
      if (!info) return;
      showCharacterTooltip(text, info, e.clientX, e.clientY);
    }, 50);
  });

  // 点击其他地方关闭
  document.addEventListener("mousedown", function (e) {
    var tip = document.getElementById("jl-char-tooltip");
    if (!tip) return;
    if (!tip.contains(e.target)) dismissTooltip();
  });

  // ═══════════ 侧边栏模式切换 ═══════════

  function applySidebarMode(win) {
    win.style.cssText = 'position:fixed;top:0;right:0;width:420px;height:100vh;z-index:2147483647;display:flex;flex-direction:column;color:#2C2416;background:linear-gradient(180deg,#FBF8F0,#F5EDE0);border-left:1px solid #D7CCC8;box-shadow:-4px 0 24px rgba(0,0,0,.1);overflow:hidden;font-family:\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif;transition:transform .3s ease';
    document.body.style.marginRight = '420px';
    document.body.style.transition = 'margin-right .3s ease';
    var toggle = document.getElementById("jl-sidebar-toggle");
    if (toggle) { toggle.textContent = "📌"; toggle.title = "切换为浮动窗模式"; }
    localStorage.setItem("JL_Sidebar_Mode", "1");
  }

  function removeSidebarMode(win) {
    win.style.cssText = 'position:fixed;top:16px;right:16px;width:min(480px,calc(100vw - 32px));height:min(780px,calc(100vh - 32px));z-index:2147483647;display:flex;flex-direction:column;color:#2C2416;background:linear-gradient(180deg,#FBF8F0,#F5EDE0);border:1px solid #D7CCC8;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);overflow:hidden;font-family:\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif;animation:jlFadeIn .25s ease';
    document.body.style.marginRight = '';
    var toggle = document.getElementById("jl-sidebar-toggle");
    if (toggle) { toggle.textContent = "📌"; toggle.title = "切换为侧边栏模式"; }
    localStorage.setItem("JL_Sidebar_Mode", "0");
  }

  function toggleSidebarMode(win) {
    if (localStorage.getItem("JL_Sidebar_Mode") === "1") {
      removeSidebarMode(win);
    } else {
      applySidebarMode(win);
    }
  }

  // ═══════════ 阅读周报 ═══════════

  function renderWeeklyReport() {
    if (!_currentBookId) {
      document.getElementById("jl-weekly-stats").innerHTML = '<p class="jl-empty">请先分析当前书籍的章节</p>';
      return;
    }

    // 只统计当前书籍（_serverAnalysisMap 已经是按当前书筛选的）
    var allAnalyses = [];
    if (typeof _serverAnalysisMap === "object") {
      Object.keys(_serverAnalysisMap).forEach(function (k) {
        if (k.indexOf("_local_") === 0) return;
        allAnalyses.push(_serverAnalysisMap[k]);
      });
    }

    if (allAnalyses.length === 0) {
      document.getElementById("jl-weekly-stats").innerHTML = '<p class="jl-empty">分析当前书籍的章节后，这里将显示阅读统计</p>';
      return;
    }

    var totalChapters = allAnalyses.length;

    // 收集人物和伏笔
    var charCount = {};
    var allClues = [];

    allAnalyses.forEach(function (a) {
      (a.characters || []).forEach(function (c) {
        var name = c.name || c.label || "";
        if (name) charCount[name] = (charCount[name] || 0) + 1;
      });
      (a.foreshadowing || []).forEach(function (f) {
        if (f.clue) allClues.push({ clue: f.clue, confidence: f.confidence || 0, reason: f.reason || "" });
      });
    });

    // Top 5 人物
    var topChars = Object.entries(charCount).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
    // Top 5 伏笔
    var topClues = allClues.sort(function (a, b) { return b.confidence - a.confidence; }).slice(0, 5);

    // 渲染统计卡片（当前书籍）
    var bookName = _currentBookTitle || "当前书籍";
    var statsHTML =
      '<div style="font-size:11px;color:#8D6E63;margin-bottom:8px">📖 ' + bookName + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px">' +
        '<div style="background:#FFF8E1;border-radius:8px;padding:12px;text-align:center">' +
          '<div style="font-size:28px;font-weight:800;color:#E65100">' + totalChapters + '</div>' +
          '<div style="font-size:11px;color:#8D6E63">已分析章节</div>' +
        '</div>' +
        '<div style="background:#E3F2FD;border-radius:8px;padding:12px;text-align:center">' +
          '<div style="font-size:28px;font-weight:800;color:#1565C0">' + Object.keys(charCount).length + '</div>' +
          '<div style="font-size:11px;color:#8D6E63">出场人物</div>' +
        '</div>' +
        '<div style="background:#F3E5F5;border-radius:8px;padding:12px;text-align:center">' +
          '<div style="font-size:28px;font-weight:800;color:#7B1FA2">' + allClues.length + '</div>' +
          '<div style="font-size:11px;color:#8D6E63">伏笔线索</div>' +
        '</div>' +
        '<div style="background:#E8F5E9;border-radius:8px;padding:12px;text-align:center">' +
          '<div style="font-size:28px;font-weight:800;color:#2E7D32">' + allAnalyses.reduce(function(s, a) { return s + ((a.foreshadowing || []).filter(function(f) { return (f.confidence || 0) >= 70; }).length); }, 0) + '</div>' +
          '<div style="font-size:11px;color:#8D6E63">高可信度伏笔</div>' +
        '</div>' +
      '</div>';

    var el = document.getElementById("jl-weekly-stats");
    if (el) el.innerHTML = statsHTML;

    // 人物
    var charHTML = topChars.length ? topChars.map(function (pair) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f0e8de">' +
        '<span style="font-weight:600">' + escHtml(pair[0]) + '</span>' +
        '<span style="font-size:11px;color:#8D6E63">出现 ' + pair[1] + ' 次</span></div>';
    }).join("") : '<p class="jl-empty">分析更多章节后将显示</p>';
    el = document.getElementById("jl-weekly-characters");
    if (el) el.innerHTML = charHTML;

    // 伏笔
    var clueHTML = topClues.length ? topClues.map(function (c) {
      var pct = Math.min(100, Math.max(0, parseInt(c.confidence) || 0));
      return '<div style="padding:8px 0;border-bottom:1px solid #f0e8de">' +
        '<div style="font-weight:600;margin-bottom:2px">' + escHtml(c.clue) + '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#8D6E63">' +
          '<span style="color:#5D4037">可信度 ' + pct + '%</span>' +
          '<span style="flex:1;height:4px;background:#E8DDD2;border-radius:2px"><span style="display:block;height:100%;width:' + pct + '%;background:#F57C00;border-radius:2px"></span></span>' +
        '</div>' +
        (c.reason ? '<div style="font-size:11px;color:#A1887F;margin-top:2px">' + escHtml(c.reason) + '</div>' : '') +
      '</div>';
    }).join("") : '<p class="jl-empty">分析更多章节后将显示</p>';
    el = document.getElementById("jl-weekly-clues");
    if (el) el.innerHTML = clueHTML;
  }

  // 切换到周报标签时自动刷新
  var _origSwitchPanel = switchPanel;
  switchPanel = function (panel) {
    _origSwitchPanel(panel);
    if (panel === "weekly") renderWeeklyReport();
  };

})();
