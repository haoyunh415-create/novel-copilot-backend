(() => {
  if (window.__jianlai_helper_loaded__) return;
  window.__jianlai_helper_loaded__ = true;

  const MIN_INTERVAL_MS = 5000;
  let lastCallTime = 0;
  let isRunning = false;
  let network = null;
  let _currentBookId = null;
  let _currentBookTitle = null;

  // ═══════════ 页面信息提取 ═══════════

  function getChapterTitle() {
    const selectors = [
      ".j_chapterName", ".chapter-name", ".chaptername",
      "h1", "h2", ".title", ".chapter-title", ".chapterTitle",
      "[class*='chapter'] h1", "[class*='chapter'] h2",
      ".article-title", ".post-title", ".entry-title",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length >= 2 && text.length < 200) return text;
    }
    const title = document.title.trim();
    const sep = title.lastIndexOf(" - ");
    if (sep > 0) return title.substring(0, sep).trim();
    return title || "未命名章节";
  }

  function getChapterText() {
    const containerSelectors = [
      "#content", "#chaptercontent", "#ChapterContent", "#txt",
      ".read-content", ".main-text-wrap", ".chapter-content",
      ".content", ".article-content", ".post-content",
      ".txt", ".text", ".novel-content", ".book-content",
      "article", ".entry-content", "#article", "#text",
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
    const lines = bestText.split("\n").filter((l) => l.length > 3);
    return lines.slice(0, 150).join("\n");
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
    return new Promise((resolve) => {
      chrome.storage.local.get(["api_url"], ({ api_url }) => {
        resolve(api_url || "https://jianla.xyz:8000");
      });
    });
  }

  function getToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["token"], function (result) {
        var token = result.token;
        // 检测过期
        if (token) {
          try {
            var payload = JSON.parse(atob(token.split(".")[1]));
            if ((payload.exp || 0) * 1000 < Date.now()) {
              token = null;
            }
          } catch (_) { token = null; }
        }
        resolve(token);
      });
    });
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
          '<p style="margin:8px 0 0;font-size:10px;color:#b0a395;text-align:center">注册即送 30 次免费额度 · 每日签到 +5 次</p>' +
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
    style.textContent = "#jianlai-helper-window{position:fixed;top:16px;right:16px;width:min(480px,calc(100vw - 32px));height:min(780px,calc(100vh - 32px));z-index:2147483647;display:flex;flex-direction:column;color:#2C2416;background:linear-gradient(180deg,#FBF8F0,#F5EDE0);border:1px solid #D7CCC8;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);overflow:hidden;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;animation:jlFadeIn .25s ease}#jianlai-helper-window button{border:0;border-radius:8px;cursor:pointer;font:inherit;transition:all .18s ease}#jianlai-helper-window button:active{transform:scale(.97)}@keyframes jlFadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}.jl-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;color:#fff;background:linear-gradient(135deg,#3E2723,#5D4037,#6D4C41)}.jl-title{min-width:0}.jl-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:700;letter-spacing:.5px}.jl-title span{display:block;margin-top:3px;opacity:.7;font-size:11px}#jl-close{width:30px;height:30px;color:#fff;background:rgba(255,255,255,.12);border-radius:50%!important;font-size:18px;display:flex;align-items:center;justify-content:center}#jl-close:hover{background:rgba(255,255,255,.22)}.jl-tabs{display:grid;grid-template-columns:repeat(5,1fr);gap:0;background:#D7CCC8;padding:1px 0 0 0}.jl-tab{padding:11px 4px;color:#6D4C41;background:#EFEBE4;font-size:12px;font-weight:500;position:relative}.jl-tab:hover{background:#E8E0D5}.jl-tab.is-active{color:#fff;background:linear-gradient(180deg,#6D4C41,#5D4037);font-weight:600}.jl-tab.is-active::after{content:'';position:absolute;bottom:0;left:30%;right:30%;height:2px;background:#FFCC80;border-radius:2px}.jl-main{flex:1;min-height:0;overflow:auto;padding:16px;scroll-behavior:smooth}.jl-main::-webkit-scrollbar{width:5px}.jl-main::-webkit-scrollbar-thumb{background:#D7CCC8;border-radius:3px}.jl-panel{display:none;animation:jlFadeIn .2s ease}.jl-panel.is-active{display:block}.jl-card{margin-bottom:14px;padding:14px 16px;border:1px solid #E8DDD2;border-radius:10px;background:#FFFDF7;box-shadow:0 1px 4px rgba(44,36,22,.04);transition:box-shadow .2s}.jl-card:hover{box-shadow:0 2px 8px rgba(44,36,22,.08)}.jl-card h3{margin:0 0 10px;font-size:14px;font-weight:700;color:#3E2723}.jl-card p,.jl-list-item{margin:0;font-size:13px;line-height:1.7;color:#4E3E33}.jl-list-item{padding:10px 0;border-top:1px solid #F0E8DE}.jl-list-item:first-child{border-top:0}.jl-empty{color:#A1887F;font-size:13px;text-align:center;padding:20px}.jl-ask-box{display:grid;gap:10px}#jl-question{width:100%;min-height:80px;padding:12px;resize:vertical;border:1.5px solid #DDD0C4;border-radius:8px;color:#2C2416;background:#fff;font:inherit;font-size:13px;line-height:1.6;transition:border-color .2s}#jl-question:focus{outline:none;border-color:#8D6E63;box-shadow:0 0 0 3px rgba(141,110,99,.08)}#jl-ask{min-height:38px;color:#fff;background:linear-gradient(135deg,#5D4037,#6D4C41);font-weight:600}#jl-answer{white-space:pre-wrap}#jl-graph{height:580px;border:1px solid #E8DDD2;border-radius:10px;background:#FFFDF7;overflow:hidden}.jl-footer{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-top:1px solid #E8DDD2;background:#F5EDE0}.jl-controls{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}.jl-controls select{width:100%;min-height:36px;padding:6px 10px;border:1.5px solid #DDD0C4;border-radius:8px;color:#3E2723;background:#fff;font:inherit;font-size:13px;cursor:pointer;transition:border-color .2s}.jl-controls select:focus{outline:none;border-color:#8D6E63}.jl-toggle{display:flex;align-items:center;gap:6px;white-space:nowrap;color:#6D4C41;font-size:12px;cursor:pointer}.jl-actions{display:flex;gap:8px}.jl-footer button{min-height:38px;padding:8px 12px;font-size:13px;font-weight:600}#jl-run{flex:1;color:#fff;background:linear-gradient(135deg,#E65100,#F57C00);box-shadow:0 2px 8px rgba(230,81,0,.2)}#jl-run:hover{box-shadow:0 4px 14px rgba(230,81,0,.3)}#jl-review{flex:1;color:#fff;background:#6D4C41}#jl-full-report{flex:1;color:#fff;background:#8D6E63}#jl-export{width:60px;color:#5D4037;background:#E8DDD2}#jl-run:disabled{opacity:.6;cursor:wait;filter:grayscale(30%)}.jl-meta{margin-bottom:10px;padding:6px 10px;border-radius:6px;background:#F5EDE0;color:#8D6E63;font-size:11px;display:inline-block}.jl-book-bar{padding:8px 16px;background:linear-gradient(90deg,#F5EDE0,#EFEBE4);font-size:11px;color:#6D4C41;border-bottom:1px solid #E8DDD2;display:flex;align-items:center;gap:6px}.jl-book-bar::before{content:'📖';font-size:13px}.jl-ov-stat{display:inline-flex;align-items:center;gap:5px;margin:4px 14px 4px 0;font-size:12px;font-weight:500}.jl-ov-dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.15)}.jl-ov-dot.open{background:#E65100}.jl-ov-dot.progress{background:#1565C0}.jl-ov-dot.payoff{background:#2E7D32}.jl-ov-item{padding:12px 14px;margin-bottom:10px;border-radius:10px;border:1px solid #E8DDD2;background:#FFFDF7;cursor:pointer;transition:all .15s}.jl-ov-item:hover{border-color:#8D6E63;box-shadow:0 2px 8px rgba(44,36,22,.06);transform:translateX(2px)}.jl-ov-item .jl-ov-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.jl-ov-item .jl-ov-clue{font-size:13px;font-weight:600;color:#3E2723}.jl-ov-item .jl-ov-confidence{font-size:10px;padding:2px 10px;border-radius:12px;font-weight:600}.jl-ov-item .jl-ov-reason{font-size:12px;color:#6D4C41;margin-top:6px}.jl-ov-item .jl-ov-chapter{font-size:11px;color:#A1887F;margin-top:4px}.jl-ov-empty{text-align:center;padding:40px 20px;color:#A1887F;font-size:13px}.jl-qa-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.jl-qa-header h3{margin:0}.jl-qa-book-tag{padding:3px 10px;border-radius:12px;background:#EFEBE4;color:#6D4C41;font-size:11px;font-weight:500}.jl-chat-msg{margin-bottom:10px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.6;animation:jlFadeIn .2s ease}.jl-chat-msg.q{background:#F5EDE0;border:1px solid #E8DDD2}.jl-chat-msg.a{background:#E8F5E9;border:1px solid #C8E6C9}.jl-chat-msg .jl-chat-label{font-weight:700;font-size:10px;margin-bottom:4px;display:block;text-transform:uppercase;letter-spacing:.5px}.jl-chat-msg.q .jl-chat-label{color:#5D4037}.jl-chat-msg.a .jl-chat-label{color:#2E7D32}.jl-chat-warning{padding:8px 12px;margin-bottom:10px;border-radius:8px;background:#FFF8E1;border:1px solid #FFE082;color:#E65100;font-size:12px}.jl-suggested{margin-bottom:12px}.jl-suggested-label{font-size:11px;color:#A1887F;margin-bottom:6px}.jl-suggested-item{display:block;width:100%;padding:8px 10px;margin-bottom:4px;border:1px solid #E8DDD2!important;border-radius:8px!important;background:#FFFDF7;color:#5D4037;font-size:12px;text-align:left;cursor:pointer}.jl-suggested-item:hover{background:#F5EDE0;border-color:#8D6E63!important}.jl-text-btn{display:block;width:100%;margin-top:8px;padding:4px 8px;border:0;background:0 0;color:#A1887F;font-size:11px;text-align:center;cursor:pointer}.jl-text-btn:hover{color:#C62828}.jl-qa-buttons{display:flex;gap:8px}.jl-qa-buttons button{flex:1;min-height:36px;padding:8px 12px;font-size:13px}#jl-ask{color:#fff;background:linear-gradient(135deg,#5D4037,#6D4C41)}#jl-suggest-btn{color:#5D4037;background:#EFEBE4;border:1.5px solid #D7CCC8!important}#jl-ask:disabled,#jl-suggest-btn:disabled{opacity:.6;cursor:wait}";
    document.documentElement.appendChild(style);

    win = document.createElement("div");
    win.id = "jianlai-helper-window";
    win.innerHTML =
      '<div class="jl-header">' +
        '<div class="jl-title">' +
          '<strong id="jl-heading">鉴来助手</strong>' +
          '<span>无剧透前情提要 / 伏笔雷达 / 关系图</span>' +
        '</div>' +
        '<button id="jl-close" title="关闭">×</button>' +
      '</div>' +
      '<div class="jl-book-bar"><span id="jl-book-tag">当前：未分析章节</span></div>' +
      '<div class="jl-tabs">' +
        '<button class="jl-tab is-active" data-panel="summary">概况</button>' +
        '<button class="jl-tab" data-panel="clues">伏笔</button>' +
        '<button class="jl-tab" data-panel="qa">问答</button>' +
        '<button class="jl-tab" data-panel="overview">总览</button>' +
        '<button class="jl-tab" data-panel="graph">关系图</button>' +
      '</div>' +
      '<div class="jl-main">' +
        '<section id="jl-panel-summary" class="jl-panel is-active">' +
          '<div class="jl-card"><h3>本章概况</h3><p id="jl-summary">点击下方按钮开始分析。</p></div>' +
          '<div class="jl-card"><h3>关键人物</h3><div id="jl-characters"><p class="jl-empty">暂无</p></div></div>' +
          '<div class="jl-card"><h3>名词解释</h3><div id="jl-terms"><p class="jl-empty">暂无</p></div></div>' +
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
        '<section id="jl-panel-graph" class="jl-panel"><div id="jl-graph"></div></section>' +
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

    win.querySelector("#jl-close").addEventListener("click", () => win.remove());
    win.querySelector("#jl-run").addEventListener("click", runAnalyze);
    win.querySelector("#jl-ask").addEventListener("click", askMemory);
    win.querySelector("#jl-suggest-btn").addEventListener("click", fetchSuggestedQuestions);
    win.querySelector("#jl-clear-chat").addEventListener("click", clearChatHistory);
    win.querySelector("#jl-export").addEventListener("click", exportResult);
    win.querySelector("#jl-review").addEventListener("click", reviewRecent);
    win.querySelector("#jl-full-report").addEventListener("click", fullReport);
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
      loadBookGraph();
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

  function drawGraph(graph) {
    const graphBox = document.getElementById("jl-graph");
    if (!graphBox || !window.vis || !Array.isArray(graph?.nodes)) return;

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
    network = new vis.Network(graphBox, { nodes, edges }, {
      edges: { arrows: "to", color: "#9b8a80", font: { align: "middle" } },
      physics: { stabilization: true },
      interaction: { hover: true }
    });
  }

  function storageKey() {
    const detail = document.getElementById("jl-detail")?.value || "standard";
    const spoilerFree = document.getElementById("jl-spoiler-free")?.checked ? "safe" : "open";
    return "JL_Archive_" + location.host + "_" + getChapterTitle() + "_" + detail + "_" + spoilerFree;
  }

  // ═══════════ 核心操作 ═══════════

  async function runAnalyze() {
    if (isRunning) return;
    const now = Date.now();
    if (now - lastCallTime < MIN_INTERVAL_MS) {
      setText("#jl-summary", "操作太频繁了，稍等几秒再试。");
      return;
    }
    lastCallTime = now;

    const API = await getAPI();
    const token = await getToken();
    if (!token) {
      setText("#jl-summary", "请先在插件弹窗中登录。");
      return;
    }

    const text = getChapterText();
    if (text.length < 80) {
      setText("#jl-summary", "没有识别到足够的正文内容。");
      return;
    }

    isRunning = true;
    const runBtn = document.getElementById("jl-run");
    runBtn.disabled = true;
    runBtn.textContent = "⚡ 正在提取页面内容...";
    runBtn.style.animation = "pulse 1.5s ease infinite";

    // 添加脉冲动画
    if (!document.getElementById("jl-pulse-style")) {
      var pulseStyle = document.createElement("style");
      pulseStyle.id = "jl-pulse-style";
      pulseStyle.textContent = "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}";
      document.head.appendChild(pulseStyle);
    }

    try {
      const chapterTitle = getChapterTitle();
      setText("#jl-heading", chapterTitle);
      setText("#jl-summary", "🤖 正在连接 AI 服务...");
      // 1.5 秒后更新状态（模拟阶段变化）
      var statusTimer = setTimeout(function () {
        setText("#jl-summary", "📝 正在分析章节内容和人物关系...");
      }, 1500);

      const bookTitle = getBookTitle();
      const author = getAuthor();
      const chapterIndex = getChapterIndex();

      const response = await fetch(API + "/api/analyze", {
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
      });

      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error || "分析失败");

      const result = normalizeResult(payload.data);
      renderResult(result);

      // 长文本截断提醒
      if (payload.data.truncated) {
        var truncMeta = document.createElement("div");
        truncMeta.className = "jl-meta";
        truncMeta.style.cssText = "background:#FFF8E1;color:#E65100";
        truncMeta.textContent = payload.data.warning || "章节过长，内容已截断";
        var summaryCard = document.querySelector("#jl-panel-summary .jl-card");
        if (summaryCard) summaryCard.appendChild(truncMeta);
      }

      // 存内存变量
      if (payload.data.book_id) {
        var prevBookId = _currentBookId;
        _currentBookId = payload.data.book_id;
        _currentBookTitle = bookTitle || chapterTitle || "当前书籍";
        const tag = document.getElementById("jl-book-tag");
        if (tag) tag.textContent = "当前：" + _currentBookTitle;
        updateQABookTag();
        // 切书了 → 换聊天历史 + 清除旧历史列表
        if (prevBookId !== _currentBookId) {
          _chatBookId = _currentBookId;
          _chatHistory = [];
          loadChatHistory();
          renderChatHistory();
          var oldSection = document.getElementById("jl-history-section");
          if (oldSection) oldSection.remove();
          // 切书后清空推荐问题和记忆标签，强制重新生成
          var qContainer = document.getElementById("jl-suggested-questions");
          if (qContainer) qContainer.innerHTML = "";
          var qaTag = document.getElementById("jl-qa-book-tag");
          if (qaTag) qaTag.textContent = "";
        }

        // 加载分析历史（服务端数据，跨设备同步）
        loadAnalysisHistory();
      }

      if (payload.data.cached) {
        const summaryEl = document.getElementById("jl-summary");
        const meta = document.createElement("div");
        meta.className = "jl-meta";
        meta.textContent = "已命中缓存，本次未消耗额度。";
        summaryEl.parentElement.insertBefore(meta, summaryEl);
      }

      // 自动检测伏笔回收
      if (_currentBookId) {
        checkForeshadowingResult(_currentBookId);
      }

      localStorage.setItem(storageKey(), JSON.stringify(result));
    } catch (error) {
      var errMsg = error.message || "分析失败，请稍后再试。";

      // 额度不足 → 签到提醒
      if (errMsg.indexOf("额度不足") !== -1) {
        errMsg += "\n\n💡 每天签到免费领 5 次额度，打开插件弹窗即可自动领取";
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
      clearTimeout(statusTimer);
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

        fetch(API + "/api/feedback", {
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
      var res = await fetch(API + "/api/foreshadowing/check?book_id=" + bookId, {
        headers: { Authorization: "Bearer " + token }
      });
      var payload = await res.json();
      if (!payload.success || !payload.data) return;

      var matches = payload.data.matches || [];
      if (matches.length === 0) return;

      // 在概况面板顶部显示伏笔回收通知
      var panel = document.getElementById("jl-panel-summary");
      var banner = document.createElement("div");
      banner.className = "jl-card";
      banner.style.cssText = "border-left:3px solid #2e7d32;background:#e8f5e9";
      banner.innerHTML =
        '<h3 style="color:#2e7d32">🔔 伏笔回收提醒</h3>' +
        '<p style="font-size:12px;color:#4a7c59;margin-bottom:6px">本章可能回收了以下历史伏笔：</p>' +
        matches.map(function (m) {
          return '<div class="jl-list-item" style="border-color:#c8e6c9">' +
            '<span style="color:#2e7d32;font-weight:600">💡 ' + (m.clue || "未知线索") + '</span>' +
            (m.note ? '<br><small style="color:#6f8f7c">' + m.note + '</small>' : '') +
            (m.chapter_title ? '<br><small style="color:#8b7c72">来自：' + m.chapter_title + '</small>' : '') +
          '</div>';
        }).join("");

      // 插入到面板最前面
      var firstCard = panel.querySelector(".jl-card");
      if (firstCard) {
        panel.insertBefore(banner, firstCard);
      } else {
        panel.appendChild(banner);
      }
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
      var response = await fetch(API + "/api/ask/suggest", {
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
        addChatMessage("a", "请先在插件弹窗中登录。");
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

      var response = await fetch(API + "/api/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify(body)
      });

      var payload = await response.json();
      if (!payload.success) throw new Error(payload.error || "问答失败");

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
      addChatMessage("a", (error && error.message) || "问答失败，请稍后再试。");
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
      const resp = await fetch(API + "/api/books/" + _currentBookId + "/foreshadowing", {
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
      var resp = await fetch(API + "/api/books/" + _currentBookId + "/analyses", {
        headers: { Authorization: "Bearer " + token }
      });
      var payload = await resp.json();
      if (!payload.success || !payload.data) return;

      var analyses = payload.data.analyses || [];
      if (analyses.length === 0) return;

      // 在概况面板底部插入历史章节列表
      var section = document.createElement("div");
      section.id = "jl-history-section";
      section.className = "jl-card";
      section.innerHTML =
        '<h3>📚 本书已分析 ' + analyses.length + ' 章</h3>' +
        '<p style="font-size:10px;color:#8b7c72;margin:2px 0 6px">点击章节可查看分析结果（已缓存内容）</p>' +
        '<div style="max-height:200px;overflow-y:auto;margin-top:8px">' +
        analyses.slice(-20).reverse().map(function (a) {
          var date = a.created_at ? new Date(a.created_at * 1000).toLocaleDateString("zh-CN") : "";
          return '<div class="jl-list-item jl-hist-item" data-chapter="' + (a.chapter_title || "") + '" style="font-size:12px;cursor:pointer;transition:background .15s" onmouseover="this.style.background=\'#f4eee8\'" onmouseout="this.style.background=\'\'">' +
            '🔒 <b>' + (a.chapter_title || "未知章节") + '</b>' +
            (date ? ' <span style="color:#8b7c72;font-size:11px">' + date + '</span>' : '') +
          '</div>';
        }).join("") +
        '</div>';

      // 绑定点击事件
      section.querySelectorAll(".jl-hist-item").forEach(function (item) {
        item.addEventListener("click", function () {
          loadHistoryChapter(this.dataset.chapter);
        });
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

  function loadHistoryChapter(chapterTitle) {
    // 从 localStorage 找缓存的该章节分析结果
    var found = null;
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

    if (found) {
      renderResult(found);
      var meta = document.createElement("div");
      meta.className = "jl-meta";
      meta.textContent = "📋 正在查看历史分析：" + chapterTitle;
      document.getElementById("jl-summary").parentElement.insertBefore(meta, document.getElementById("jl-summary"));
      // 切换到概况标签
      switchPanel("summary");
    } else {
      alert("该章节的缓存已过期，请重新打开对应章节页面进行分析");
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
      var resp = await fetch(API + "/api/books/" + _currentBookId + "/characters", {
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

      // 用 vis-network 渲染
      if (!window.vis) {
        graphBox.innerHTML = '<div class="jl-ov-empty">图表库加载失败</div>';
        return;
      }

      graphBox.innerHTML = "";
      graphBox.style.height = "560px";
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
      setText("#jl-summary", "请先在插件弹窗中登录。");
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
      const response = await fetch(API + "/api/review", {
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

  async function fullReport() {
    const API = await getAPI();
    const token = await getToken();
    if (!token) {
      setText("#jl-summary", "请先在插件弹窗中登录。");
      return;
    }

    if (!_currentBookId) {
      setText("#jl-summary", "请先分析当前章节，建立书籍上下文后再使用全书复盘功能。");
      return;
    }

    const reportBtn = document.getElementById("jl-full-report");
    const reviewBtn = document.getElementById("jl-review");
    reportBtn.disabled = true;
    reportBtn.textContent = "生成中...";
    if (reviewBtn) reviewBtn.disabled = true;

    // 切换到摘要面板
    switchPanel("summary");
    setText("#jl-summary", "正在生成全书复盘报告...\n\n这需要一些时间，已分析章节越多耗时越长，请耐心等待。");

    try {
      const response = await fetch(API + "/api/report/full", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ book_id: _currentBookId })
      });

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
      setText("#jl-summary", error.message || "报告生成失败，请稍后再试。");
    } finally {
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

  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (req.action !== "START_ANALYZE") return;
    const win = createWindow();
    win.querySelector("#jl-heading").textContent = getChapterTitle();
    showOnboarding();
    sendResponse({ ok: true });
  });
})();
