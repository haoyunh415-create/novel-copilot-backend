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
        resolve(api_url || "http://127.0.0.1:8000");
      });
    });
  }

  function getToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["token"], ({ token }) => resolve(token));
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

  // ═══════════ UI 创建 ═══════════

  function createWindow() {
    let win = document.getElementById("jianlai-helper-window");
    if (win) return win;

    const style = document.createElement("style");
    style.id = "jianlai-helper-style";
    style.textContent = "#jianlai-helper-window{position:fixed;top:16px;right:16px;width:min(460px,calc(100vw - 32px));height:min(760px,calc(100vh - 32px));z-index:2147483647;display:flex;flex-direction:column;color:#2f2925;background:#fbfaf6;border:1px solid #cbb9aa;border-radius:8px;box-shadow:0 14px 42px rgba(0,0,0,.26);overflow:hidden;font-family:Arial,'Microsoft YaHei',sans-serif}#jianlai-helper-window button{border:0;border-radius:6px;cursor:pointer;font:inherit}.jl-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;color:#fff;background:#5d4037}.jl-title{min-width:0}.jl-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.jl-title span{display:block;margin-top:2px;opacity:.78;font-size:12px}#jl-close{width:28px;height:28px;color:#fff;background:rgba(255,255,255,.14);font-size:18px}.jl-tabs{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#ddcec0}.jl-tab{padding:10px 6px;color:#5d4037;background:#efe8df;font-size:13px}.jl-tab.is-active{color:#fff;background:#8d6e63}.jl-main{flex:1;min-height:0;overflow:auto;padding:14px}.jl-panel{display:none}.jl-panel.is-active{display:block}.jl-card{margin-bottom:12px;padding:12px;border:1px solid #e2d9d1;border-radius:8px;background:#fff}.jl-card h3{margin:0 0 8px;font-size:14px}.jl-card p,.jl-list-item{margin:0;font-size:13px;line-height:1.65}.jl-list-item{padding:9px 0;border-top:1px solid #eee7df}.jl-list-item:first-child{border-top:0}.jl-empty{color:#8b7c72;font-size:13px}.jl-ask-box{display:grid;gap:8px}#jl-question{width:100%;min-height:76px;padding:10px;resize:vertical;border:1px solid #d7c8bc;border-radius:6px;color:#2f2925;background:#fff;font:inherit;font-size:13px;line-height:1.55}#jl-ask{min-height:36px;color:#fff;background:#6d4c41}#jl-answer{white-space:pre-wrap}#jl-graph{height:560px;border:1px solid #e2d9d1;border-radius:8px;background:#fff}.jl-footer{display:flex;flex-direction:column;gap:8px;padding:10px;border-top:1px solid #e2d9d1;background:#f4eee8}.jl-controls{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}.jl-controls select{width:100%;min-height:34px;padding:6px 8px;border:1px solid #d7c8bc;border-radius:6px;color:#3d332e;background:#fff;font:inherit;font-size:13px}.jl-toggle{display:flex;align-items:center;gap:5px;white-space:nowrap;color:#5f514a;font-size:12px}.jl-actions{display:flex;gap:8px}.jl-footer button{min-height:36px;padding:8px 10px}#jl-run{flex:1;color:#fff;background:#5d4037}#jl-review{flex:1;color:#fff;background:#8d6e63}#jl-export{width:72px;color:#5d4037;background:#e4d6ca}#jl-run:disabled{opacity:.65;cursor:wait}.jl-meta{margin-bottom:8px;color:#8b7c72;font-size:12px}.jl-book-bar{padding:6px 14px;background:#efe8df;font-size:11px;color:#6d4c41;border-bottom:1px solid #ddcec0}.jl-ov-stat{display:inline-flex;align-items:center;gap:4px;margin:4px 12px 4px 0;font-size:12px}.jl-ov-dot{width:8px;height:8px;border-radius:50%}.jl-ov-dot.open{background:#e65100}.jl-ov-dot.progress{background:#1565c0}.jl-ov-dot.payoff{background:#2e7d32}.jl-ov-item{padding:10px 12px;margin-bottom:8px;border-radius:8px;border:1px solid #e2d9d1;background:#fff;cursor:pointer}.jl-ov-item:hover{border-color:#8d6e63}.jl-ov-item .jl-ov-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}.jl-ov-item .jl-ov-clue{font-size:13px;font-weight:600;color:#3e2723}.jl-ov-item .jl-ov-confidence{font-size:11px;padding:2px 8px;border-radius:10px}.jl-ov-item .jl-ov-reason{font-size:12px;color:#6f625b;margin-top:4px}.jl-ov-item .jl-ov-chapter{font-size:11px;color:#8b7c72;margin-top:4px}.jl-ov-empty{text-align:center;padding:40px;color:#8b7c72;font-size:13px}.jl-qa-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.jl-qa-header h3{margin:0}.jl-qa-book-tag{padding:2px 8px;border-radius:10px;background:#efe8df;color:#6d4c41;font-size:11px}.jl-chat-msg{margin-bottom:10px;padding:8px 10px;border-radius:8px;font-size:13px;line-height:1.55}.jl-chat-msg.q{background:#f4eee8;border:1px solid #e2d9d1}.jl-chat-msg.a{background:#e8f5e9;border:1px solid #c8e6c9}.jl-chat-msg .jl-chat-label{font-weight:600;font-size:11px;margin-bottom:4px;display:block}.jl-chat-msg.q .jl-chat-label{color:#5d4037}.jl-chat-msg.a .jl-chat-label{color:#2e7d32}.jl-chat-warning{padding:6px 10px;margin-bottom:8px;border-radius:6px;background:#fff3e0;border:1px solid #ffe0b2;color:#e65100;font-size:12px}.jl-qa-buttons{display:flex;gap:8px}.jl-qa-buttons button{flex:1;min-height:34px;padding:8px 10px;font-size:13px}#jl-ask{color:#fff;background:#5d4037}#jl-suggest-btn{color:#5d4037;background:#efe8df;border:1px solid #d7c8bc}.jl-suggested{margin-bottom:10px}.jl-suggested-label{font-size:11px;color:#8b7c72;margin-bottom:4px}.jl-suggested-item{display:block;width:100%;padding:6px 8px;margin-bottom:3px;border:0;border-radius:4px;background:#fbfaf6;color:#5d4037;font-size:12px;text-align:left;cursor:pointer}.jl-suggested-item:hover{background:#efe8df}.jl-text-btn{display:block;width:100%;margin-top:6px;padding:4px 8px;border:0;background:0 0;color:#8b7c72;font-size:11px;text-align:center;cursor:pointer}.jl-text-btn:hover{color:#c62828}#jl-ask:disabled,#jl-suggest-btn:disabled{opacity:.65;cursor:wait}";
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
    if (panel === "graph" && network) {
      setTimeout(() => network.fit(), 80);
    }
    if (panel === "overview") {
      loadOverview();
    }
    if (panel === "qa") {
      updateQABookTag();
      if (_currentBookId !== _chatBookId) {
        _chatBookId = _currentBookId;
        _chatHistory = [];
        loadChatHistory();
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
    runBtn.textContent = "分析中...";

    try {
      const chapterTitle = getChapterTitle();
      setText("#jl-heading", chapterTitle);
      setText("#jl-summary", "正在分析章节内容...");

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

      // 存内存变量
      if (payload.data.book_id) {
        var prevBookId = _currentBookId;
        _currentBookId = payload.data.book_id;
        _currentBookTitle = bookTitle || chapterTitle || "当前书籍";
        const tag = document.getElementById("jl-book-tag");
        if (tag) tag.textContent = "当前：" + _currentBookTitle;
        updateQABookTag();
        // 切书了 → 换聊天历史
        if (prevBookId !== _currentBookId) {
          _chatBookId = _currentBookId;
          _chatHistory = [];
          loadChatHistory();
          renderChatHistory();
        }
      }

      if (payload.data.cached) {
        const summaryEl = document.getElementById("jl-summary");
        const meta = document.createElement("div");
        meta.className = "jl-meta";
        meta.textContent = "已命中缓存，本次未消耗额度。";
        summaryEl.parentElement.insertBefore(meta, summaryEl);
      }
      localStorage.setItem(storageKey(), JSON.stringify(result));
    } catch (error) {
      setText("#jl-summary", error.message || "分析失败，请稍后再试。");
    } finally {
      isRunning = false;
      runBtn.disabled = false;
      runBtn.textContent = "重新分析";
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
    sendResponse({ ok: true });
  });
})();
