// ==UserScript==
// @name         鉴来助手 - 小说 AI 伏笔雷达
// @namespace    https://jianla.xyz
// @version      2.3.28
// @description  为长篇小说提供无剧透前情提要、伏笔提示和人物关系图。支持 25+ 主流小说阅读平台，桌面油猴与手机浏览器（Alook/Via/X浏览器）均可使用。
// @author       鉴来助手
// @homepageURL  https://jianla.xyz
// @supportURL   https://novel-copilot-backend.pages.dev/support.html
// @updateURL    https://jianla.xyz/static/jianlai-helper-alook.user.js
// @downloadURL  https://jianla.xyz/static/jianlai-helper-alook.user.js
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
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  if (window.__jianlai_userscript_loaded__) return;
  window.__jianlai_userscript_loaded__ = true;
  // CSP 兜底：部分网站阻止外部脚本加载，此时用 fetch 拉取后内联注入
  if (!window.vis && !document.getElementById("jl-vis-loader")) {
    var s = document.createElement("script");
    s.id = "jl-vis-loader";
    s.src = "https://jianla.xyz/static/vis-network.min.js";
    s.onload = function() { window.__jl_vis_ready__ = true; };
    s.onerror = function() {
      fetch("https://jianla.xyz/static/vis-network.min.js")
        .then(function(r) { return r.text(); })
        .then(function(code) {
          if (code && code.length > 1000) {
            var inline = document.createElement("script");
            inline.id = "jl-vis-loader-inline";
            inline.textContent = code;
            document.head.appendChild(inline);
            window.__jl_vis_ready__ = true;
          }
        })
        .catch(function(){});
    };
    document.head.appendChild(s);
  }

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

  const MIN_INTERVAL_MS = 5000;
  let lastCallTime = 0;
  let isRunning = false;
  let network = null;
  let _currentBookId = (function () { try { var v = store.get("currentBookId"); return v ? parseInt(v, 10) : null; } catch (_) { return null; } })();
  let _currentBookTitle = (function () { try { return store.get("currentBookTitle") || null; } catch (_) { return null; } })();
  let _graphMode = "chapter";  // "chapter" | "book" | "batch"
  let _batchGraph = null;  // 批量分析合并后的全书关系图（切换「关系图」标签时优先展示）
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

  // 人机验证/反爬拦截页检测（Cloudflare「Attention Required!」/「Just a moment…」等）
  function isChallengePage() {
    try {
      var t = (document.title || "").toLowerCase();
      if (/cloudflare|attention required|just a moment|checking your browser|人机验证|安全验证|ddos/.test(t)) return true;
      var head = ((document.body && document.body.innerText) || "").slice(0, 300).toLowerCase();
      if (/attention required!\s*\|?\s*cloudflare|just a moment\.\.\.|checking your browser before accessing/.test(head)) return true;
      if (document.querySelector("#challenge-form, .cf-challenge, #cf_chl_captcha, #cf-browser-verification, iframe[src*='challenges.cloudflare.com']")) return true;
    } catch (_) {}
    return false;
  }

  function getChapterText() {
    if (_cachedText && _cachedTextUrl === location.href) { return _cachedText; }
    // 人机验证/反爬拦截页：正文容器不存在，抓到的只是英文拦截文案，直接返回空避免误报「乱码」
    if (isChallengePage()) {
      console.warn("[鉴来助手] 站点正在人机验证(Cloudflare 拦截)，暂无法抓取正文");
      _cachedText = "";
      _cachedTextUrl = location.href;
      return "";
    }
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
        .map((p) => (p.innerText ? p.innerText.trim() : ""))
        .filter((t) => t.length > 5)
        .join("\n");
      if (text.length > bestText.length) bestText = text;
    }
    if (bestText.length < 80) {
      const allP = document.querySelectorAll("p");
      const texts = Array.from(allP)
        .map((p) => (p.innerText ? p.innerText.trim() : ""))
        .filter((t) => t.length > 8);
      bestText = texts.join("\n");
    }
    // 番茄小说字体解密：把 PUA 私用区码点还原成真实汉字（解密成功则后续质量检测正常通过）
    bestText = decodeFanqieText(bestText);
    // 质量检测 1：字体加密乱码（番茄小说把汉字映射到 Unicode 私用区 PUA 字符）
    var puaCount = 0;
    for (var i = 0; i < bestText.length; i++) {
      var cp = bestText.codePointAt(i);
      if ((cp >= 0xE000 && cp <= 0xF8FF) || (cp >= 0xF0000 && cp <= 0xFFFFD)) {
        puaCount++;
        if (cp > 0xFFFF) i++;
      }
    }
    if (bestText.length > 0 && puaCount / bestText.length > 0.15) {
      _cachedText = "";
      _cachedTextUrl = location.href;
      return "";
    }
    // 质量检测 2：中文占比太低说明是乱码/混淆
    var chineseChars = (bestText.match(/[一-鿿㐀-䶿]/g) || []).length;
    var ratio = bestText.length > 0 ? chineseChars / bestText.length : 0;
    if (ratio < 0.15 && bestText.length > 50) {
      _cachedText = "";
      _cachedTextUrl = location.href;
      return "";
    }
    _cachedText = bestText.split("\n").filter(function(l){return l.length>3}).slice(0,150).join("\n");
    _cachedTextUrl = location.href;
    return _cachedText;
  }

  function isFanqieSite() {
    try {
      return /fanqienovel\.com/i.test(location.hostname);
    } catch (_) {
      return false;
    }
  }

  // ═══════════ 番茄小说字体解密 ═══════════
  // 番茄把正文汉字映射到 Unicode 私用区（PUA）码点，通过 @font-face 渲染。
  // 每套字体对应一张 372 字符码表：真实汉字 = 码表[码点 - 58344]。
  var FANQIE_CODE_ST = 58344;
  var FANQIE_CODE_ED = 58715;
  var FANQIE_NO_GLYPH = "?";

  var FANQIE_TABLES = {
    "DNMrHsV173Pd4pgy": "D在主特家军然表场4要只v和?6别还g现儿岁??此象月3出战工相" +
      "o男直失世F都平文什VO将真T那当?会立些u是十张学气大爱两命全" +
      "后东性通被1它乐接而感车山公了常以何可话先pi叫轻M士w着变尔快" +
      "l个说少色里安花远7难师放t报认面道S?克地度I好机U民写把万同" +
      "水新没书电吃像斯5为y白几日教看但第加候作上拉住有法r事应位利你" +
      "声身国问马女他Y比父xAHNsX边美对所金活回意到z从j知又内因" +
      "点Q三定8Rb正或夫向德听更?得告并本q过记L让打f人就者去原满" +
      "体做经K走如孩cG给使物?最笑部?员等受k行一条果动光门头见往自" +
      "解成处天能于名其发总母的死手入路进心来h时力多开已许d至由很界n" +
      "小与Z想代么分生口再妈望次西风种带J?实情才这?E我神格长觉间年" +
      "眼无不亲关结0友信下却重己老2音字m呢明之前高PB目太e9起稜她" +
      "也W用方子英每理便四数期中C外样a海们任",
    "fKts9tCXDjS49UhH": "体y十现快使话却月物水的放知爱方?表风理O老也p常克平几最主她s" +
      "将法情o光a我呢J员太每望受教w利军已U人如变得要少斯门电m男没" +
      "AK国时中走么何口小向问轻Td神下间车fG度D又大面远就写j给通" +
      "起实E?它去S到道数吃们加P是无把事西多界?发新外活解孩只作前Y" +
      "尔经?u心告父等Q民全这9果安?i母8r说任先和地C张战场g像c" +
      "q你使?样总目x性处音头?应乐关能花I当名手4重字声力友然生代内" +
      "里本回真入师象?0点R亲V种动英命ZhX做特边高有B为期自年马认" +
      "出接至H正方感所明者棱F住学还分意更其n但比觉以由死家让失士L2" +
      "I金叫身报听W再原山海白很见5直位第工个开岁好用都于可同3次四?" +
      "日信与女笑满并部什不从或机此?了记三e些bN夫会才几眼两美被一公" +
      "来立z长对己看k许因相色后往打结格过世气7子条在书之定v拉成进带" +
      "着东上想天他妈1文而路那别德6Mt行候难",
    "_search": "?s?作口在他能并B士4U克才正们字声高全尔活者动其主报多望放h" +
      "w次年?中3特于十入要男同G面分方K什再教本己结1等世N?说gu" +
      "期Z外美M行给9文将两许张友0英应向像此白安少何打气常定间花见孩" +
      "它直风数使道第水已女山解dP的通关性叫几L妈问回神来S?四里前国" +
      "些OvIA心平自无车光代是好却c得种就意先立z子过Yj表?么所接" +
      "了名金受J满眼没部那m每车度可R斯经现门明V如走命y6E战很上f" +
      "月西7长夫想话变海机x到W一成生信笑但父开内东马日小而后带以三几" +
      "为认X死员目位之学远入音呢我q乐象重对个被别F也书棱D写还因家发" +
      "时i或住德当oI比觉然吃去公a老亲情体太b方C电理?失力更拉物着" +
      "原她工实色感记看出相路大你候2和?与p样新只便最不进Tr做格母总" +
      "爱身师轻知往加从?天eH?听场由快边让把任8条头事至起点真手这难" +
      "都界用法n处下文Q告地5kt岁有会果利民",
  };

  var _fanqieFlatCache = {};

  function _fanqieTable(fontId) {
    if (Object.prototype.hasOwnProperty.call(_fanqieFlatCache, fontId)) return _fanqieFlatCache[fontId];
    var s = FANQIE_TABLES[fontId];
    if (!s) { _fanqieFlatCache[fontId] = null; return null; }
    var flat = Array.from(s);
    if (flat.length !== FANQIE_CODE_ED - FANQIE_CODE_ST + 1) { _fanqieFlatCache[fontId] = []; return []; }
    _fanqieFlatCache[fontId] = flat;
    return flat;
  }

  function _fanqieCountPua(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      var cp = text.codePointAt(i);
      if (cp > 0xFFFF) i++;
      if (cp >= FANQIE_CODE_ST && cp <= FANQIE_CODE_ED) n++;
    }
    return n;
  }

  function _fanqieDecodeWith(text, fontId) {
    var table = _fanqieTable(fontId);
    if (!table || table.length === 0) return null;
    var out = "";
    for (var i = 0; i < text.length; i++) {
      var cp = text.codePointAt(i);
      if (cp > 0xFFFF) i++;
      if (cp < FANQIE_CODE_ST || cp > FANQIE_CODE_ED) {
        out += String.fromCodePoint(cp);
        continue;
      }
      var m = table[cp - FANQIE_CODE_ST];
      out += (m && m !== FANQIE_NO_GLYPH) ? m : String.fromCodePoint(cp);
    }
    return out;
  }

  // 番茄正文解密：多套码表都试，选残留 PUA 最少的一套（decode_best 策略）
  function decodeFanqieText(text) {
    if (!text) return text;
    var puaTotal = _fanqieCountPua(text);
    if (puaTotal === 0) return text;
    var best = text, bestLeft = puaTotal;
    for (var id in FANQIE_TABLES) {
      if (!Object.prototype.hasOwnProperty.call(FANQIE_TABLES, id)) continue;
      var decoded = _fanqieDecodeWith(text, id);
      if (decoded === null) continue;
      var left = _fanqieCountPua(decoded);
      if (left < bestLeft) { best = decoded; bestLeft = left; }
    }
    return best;
  }


  function getBookTitle() {
    const selectors = [
      ".muye-reader-nav-title",
      ".book-title", ".book-name", ".novel-title",
      "[class*='bookName']", "[class*='book_name']",
      "h1 a", "h2 a", ".book-info h1",
      ".crumbs a:last-of-type", ".breadcrumb a:last-of-type",
      ".book-detail h1", ".novel-info h1",
      // 笔趣阁镜像目录页/章节页的书名容器
      ".info h1", ".top h1", "#info h1", ".bookinfo h1", ".info h1 a",
    ];
    for (const sel of selectors) {
      const text = ((document.querySelector(sel) || {}).innerText || "").trim();
      if (text && text.length >= 1 && text.length < 100) return text;
    }
    const meta = document.querySelector("meta[property='og:novel:book_name'], meta[name='book-name']");
    const metaText = (meta ? (meta.getAttribute("content") || "") : "").trim();
    if (metaText) return metaText;
    // 番茄小说兜底：document.title 格式 "{书名}第X章 {章节名}_番茄小说官网"
    if (/fanqienovel\.com/i.test(location.hostname)) {
      const t = (document.title || "").replace(/[_-]番茄小说官网.*$/, "");
      const tm = t.match(/^(.*?)(第\s*[0-9一二三四五六七八九十百千万零]+\s*[章节卷])/);
      if (tm) { const bt = tm[1].trim(); if (bt) return bt; }
      if (t && t.length < 100) return t;
    }
    // 笔趣阁（biquge/biquga 等镜像）兜底：目录页 "{书名}_笔趣阁" / "{书名}最新章节_笔趣阁"，章节页 "{章节}_{书名}-笔趣阁"
    if (/biqu/i.test(location.hostname)) {
      let t = (document.title || "")
        .replace(/[-_]\s*(笔趣阁|笔趣阁无弹窗|笔趣阁手机版|無彈窗|无弹窗).*$/, "")
        .replace(/(最新章节列表|最新章节|全部章节|章节目录|章节列表|全文阅读|无弹窗|在线阅读|免费阅读)\s*$/, "")
        .trim();
      // 章节页标题形如 "{章节}_{书名}"：取 "_" 之后的书名段
      const segs = t.split("_");
      if (segs.length > 1 && segs[segs.length - 1].trim()) t = segs[segs.length - 1].trim();
      if (t && t.length >= 1 && t.length < 100) return t;
    }
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
      const text = ((document.querySelector(sel) || {}).innerText || "").trim();
      if (text && text.length >= 1 && text.length < 50) return text;
    }
    const meta = document.querySelector("meta[property='og:novel:author'], meta[name='author']");
    return (meta ? (meta.getAttribute("content") || "") : "").trim();
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
      const text = (document.querySelector(sel) || {}).innerText;
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
        var resp = await fetch(api + "/api/auth/refresh", {
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
  async function fetchWithRetry(url, options, retries, timeoutMs) {
    retries = retries || 2;
    options = options || {};
    var lastError;
    var callerSignal = options.signal;
    for (var i = 0; i <= retries; i++) {
      var ctrl = null, to = null, fetchOptions = options;
      // 单次请求超时保护：站点卡死/无响应时快速失败重试，而不是无限等待（后端 AI 接口不传 timeoutMs）
      if (timeoutMs > 0 && !callerSignal) {
        ctrl = new AbortController();
        to = setTimeout(function () { ctrl.abort(); }, timeoutMs);
        fetchOptions = Object.assign({}, options, { signal: ctrl.signal });
      }
      try {
        var resp = await fetch(url, fetchOptions);
        if (resp.ok || i === retries) return resp;
        if (resp.status >= 500) { lastError = new Error("服务器错误(" + resp.status + ")，正在重试..."); }
        else return resp;
      } catch (e) {
        if (e.name === "AbortError") {
          if (callerSignal && callerSignal.aborted) throw e; // 用户取消，不重试
          lastError = new Error("请求超时，请稍后重试");
        } else {
          lastError = e;
        }
      } finally {
        if (to) clearTimeout(to);
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

  function createList(items, formatter, emptyText) {
    const list = document.createElement("div");
    list.className = "jl-list";
    if (!items || !items.length) {
      const empty = document.createElement("p");
      empty.className = "jl-empty";
      empty.textContent = emptyText || "暂无明显线索";
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
              '<span style="font-size:13px;line-height:1.6">点击右上角面板底部的 <b style="color:#f5a623">"分析当前章节"</b> 按钮（或右下角 <b style="color:#f5a623">⚡分析本章</b>）<br><small style="color:#8b7c72">AI 会自动提炼摘要、伏笔和人物关系</small></span>' +
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

  // ═══════════ 悬浮入口按钮 ═══════════

  function injectFloatingButton() {
    if (document.getElementById("jl-floating-btn")) return;
    // 仅当能提取到正文时才显示入口，避免在列表页/首页出现无意义按钮
    try {
      if (getChapterText().length < 80) return;
    } catch (_) { return; }

    const btn = document.createElement("button");
    btn.id = "jl-floating-btn";
    btn.type = "button";
    btn.textContent = "⚡ 分析本章";
    btn.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:2147483646;padding:12px 18px;" +
      "border:0;border-radius:24px;background:linear-gradient(135deg,#E65100,#F57C00);" +
      "color:#fff;font-size:14px;font-weight:600;cursor:pointer;" +
      "box-shadow:0 4px 16px rgba(230,81,0,.35);" +
      "font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;" +
      "transition:transform .15s ease,box-shadow .15s ease";
    btn.addEventListener("mouseenter", function () { btn.style.transform = "translateY(-2px)"; btn.style.boxShadow = "0 6px 20px rgba(230,81,0,.45)"; });
    btn.addEventListener("mouseleave", function () { btn.style.transform = ""; btn.style.boxShadow = "0 4px 16px rgba(230,81,0,.35)"; });
    btn.addEventListener("click", function () {
      const win = createWindow();
      win.querySelector("#jl-heading").textContent = getChapterTitle();
      runAnalyze();
    });
    document.body.appendChild(btn);
  }

  // ═══════════ UI 创建 ═══════════

  function createWindow() {
    let win = document.getElementById("jianlai-helper-window");
    if (win) return win;

    const style = document.createElement("style");
    style.id = "jianlai-helper-style";
    style.textContent = "#jianlai-helper-window{position:fixed;top:16px;right:16px;width:min(480px,calc(100vw - 32px));height:min(780px,calc(100vh - 32px));z-index:2147483647;display:flex;flex-direction:column;color:#2C2416;background:linear-gradient(180deg,#FBF8F0,#F5EDE0);border:1px solid #D7CCC8;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);overflow:hidden;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;animation:jlFadeIn .25s ease}#jianlai-helper-window button{border:0;border-radius:8px;cursor:pointer;font:inherit;transition:all .18s ease}#jianlai-helper-window button:active{transform:scale(.97)}@keyframes jlFadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}.jl-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;color:#fff;background:linear-gradient(135deg,#3E2723,#5D4037,#6D4C41)}.jl-title{min-width:0}.jl-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:700;letter-spacing:.5px}.jl-title span{display:block;margin-top:3px;opacity:.7;font-size:11px}#jl-close{width:30px;height:30px;color:#fff;background:rgba(255,255,255,.12);border-radius:50%!important;font-size:18px;display:flex;align-items:center;justify-content:center}#jl-close:hover{background:rgba(255,255,255,.22)}.jl-tabs{display:grid;grid-template-columns:repeat(6,1fr);gap:0;background:#D7CCC8;padding:1px 0 0 0}.jl-tab{padding:11px 4px;color:#6D4C41;background:#EFEBE4;font-size:12px;font-weight:500;position:relative}.jl-tab:hover{background:#E8E0D5}.jl-tab.is-active{color:#fff;background:linear-gradient(180deg,#6D4C41,#5D4037);font-weight:600}.jl-tab.is-active::after{content:'';position:absolute;bottom:0;left:30%;right:30%;height:2px;background:#FFCC80;border-radius:2px}.jl-main{flex:1;min-height:0;overflow:auto;padding:16px;scroll-behavior:smooth}.jl-main::-webkit-scrollbar{width:5px}.jl-main::-webkit-scrollbar-thumb{background:#D7CCC8;border-radius:3px}.jl-panel{display:none;animation:jlFadeIn .2s ease}.jl-panel.is-active{display:block}.jl-card{margin-bottom:14px;padding:14px 16px;border:1px solid #E8DDD2;border-radius:10px;background:#FFFDF7;box-shadow:0 1px 4px rgba(44,36,22,.04);transition:box-shadow .2s}.jl-card:hover{box-shadow:0 2px 8px rgba(44,36,22,.08)}.jl-card h3{margin:0 0 10px;font-size:14px;font-weight:700;color:#3E2723}.jl-card p,.jl-list-item{margin:0;font-size:13px;line-height:1.7;color:#4E3E33}.jl-list-item{padding:10px 0;border-top:1px solid #F0E8DE}.jl-list-item:first-child{border-top:0}.jl-empty{color:#A1887F;font-size:13px;text-align:center;padding:20px}.jl-ask-box{display:grid;gap:10px}#jl-question{width:100%;min-height:80px;padding:12px;resize:vertical;border:1.5px solid #DDD0C4;border-radius:8px;color:#2C2416;background:#fff;font:inherit;font-size:13px;line-height:1.6;transition:border-color .2s}#jl-question:focus{outline:none;border-color:#8D6E63;box-shadow:0 0 0 3px rgba(141,110,99,.08)}#jl-ask{min-height:38px;color:#fff;background:linear-gradient(135deg,#5D4037,#6D4C41);font-weight:600}#jl-answer{white-space:pre-wrap}#jl-graph{height:580px;border:1px solid #E8DDD2;border-radius:10px;background:#FFFDF7;overflow:hidden}.jl-footer{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-top:1px solid #E8DDD2;background:#F5EDE0}.jl-controls{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}.jl-controls select{width:100%;min-height:36px;padding:6px 10px;border:1.5px solid #DDD0C4;border-radius:8px;color:#3E2723;background:#fff;font:inherit;font-size:13px;cursor:pointer;transition:border-color .2s}.jl-controls select:focus{outline:none;border-color:#8D6E63}.jl-toggle{display:flex;align-items:center;gap:6px;white-space:nowrap;color:#6D4C41;font-size:12px;cursor:pointer}#jl-spoiler-free{-webkit-appearance:none!important;appearance:none!important;display:block!important;width:16px!important;height:16px!important;margin:0!important;padding:0!important;flex:0 0 auto!important;box-sizing:border-box!important;border:1.5px solid #B08968!important;border-radius:4px!important;background-color:#fff!important;background-size:12px 12px!important;background-position:center!important;background-repeat:no-repeat!important;opacity:1!important;visibility:visible!important;cursor:pointer!important}#jl-spoiler-free:hover{border-color:#E65100!important}#jl-spoiler-free:checked{background-color:#E65100!important;border-color:#E65100!important;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E\")!important}.jl-actions{display:flex;gap:8px}.jl-footer button{min-height:38px;padding:8px 12px;font-size:13px;font-weight:600}#jl-run{flex:1;color:#fff;background:linear-gradient(135deg,#E65100,#F57C00);box-shadow:0 2px 8px rgba(230,81,0,.2)}#jl-run:hover{box-shadow:0 4px 14px rgba(230,81,0,.3)}#jl-review{flex:1;color:#fff;background:#6D4C41}#jl-full-report{flex:1;color:#fff;background:#8D6E63}#jl-export{width:60px;color:#5D4037;background:#E8DDD2}#jl-run:disabled{opacity:.6;cursor:wait;filter:grayscale(30%)}.jl-meta{margin-bottom:10px;padding:6px 10px;border-radius:6px;background:#F5EDE0;color:#8D6E63;font-size:11px;display:inline-block}.jl-book-bar{padding:8px 16px;background:linear-gradient(90deg,#F5EDE0,#EFEBE4);font-size:11px;color:#6D4C41;border-bottom:1px solid #E8DDD2;display:flex;align-items:center;gap:6px}.jl-book-bar::before{content:'📖';font-size:13px}.jl-ov-stat{display:inline-flex;align-items:center;gap:5px;margin:4px 14px 4px 0;font-size:12px;font-weight:500}.jl-ov-dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.15)}.jl-ov-dot.open{background:#E65100}.jl-ov-dot.progress{background:#1565C0}.jl-ov-dot.payoff{background:#2E7D32}.jl-ov-item{padding:12px 14px;margin-bottom:10px;border-radius:10px;border:1px solid #E8DDD2;background:#FFFDF7;cursor:pointer;transition:all .15s}.jl-ov-item:hover{border-color:#8D6E63;box-shadow:0 2px 8px rgba(44,36,22,.06);transform:translateX(2px)}.jl-ov-item .jl-ov-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.jl-ov-item .jl-ov-clue{font-size:13px;font-weight:600;color:#3E2723}.jl-ov-item .jl-ov-confidence{font-size:10px;padding:2px 10px;border-radius:12px;font-weight:600}.jl-ov-item .jl-ov-reason{font-size:12px;color:#6D4C41;margin-top:6px}.jl-ov-item .jl-ov-chapter{font-size:11px;color:#A1887F;margin-top:4px}.jl-ov-empty{text-align:center;padding:40px 20px;color:#A1887F;font-size:13px}.jl-qa-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.jl-qa-header h3{margin:0}.jl-qa-book-tag{padding:3px 10px;border-radius:12px;background:#EFEBE4;color:#6D4C41;font-size:11px;font-weight:500}.jl-chat-msg{margin-bottom:10px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.6;animation:jlFadeIn .2s ease}.jl-chat-msg.q{background:#F5EDE0;border:1px solid #E8DDD2}.jl-chat-msg.a{background:#E8F5E9;border:1px solid #C8E6C9}.jl-chat-msg .jl-chat-label{font-weight:700;font-size:10px;margin-bottom:4px;display:block;text-transform:uppercase;letter-spacing:.5px}.jl-chat-msg.q .jl-chat-label{color:#5D4037}.jl-chat-msg.a .jl-chat-label{color:#2E7D32}.jl-chat-warning{padding:8px 12px;margin-bottom:10px;border-radius:8px;background:#FFF8E1;border:1px solid #FFE082;color:#E65100;font-size:12px}.jl-suggested{margin-bottom:12px}.jl-suggested-label{font-size:11px;color:#A1887F;margin-bottom:6px}.jl-suggested-item{display:block;width:100%;padding:8px 10px;margin-bottom:4px;border:1px solid #E8DDD2!important;border-radius:8px!important;background:#FFFDF7;color:#5D4037;font-size:12px;text-align:left;cursor:pointer}.jl-suggested-item:hover{background:#F5EDE0;border-color:#8D6E63!important}.jl-text-btn{display:block;width:100%;margin-top:8px;padding:4px 8px;border:0;background:0 0;color:#A1887F;font-size:11px;text-align:center;cursor:pointer}.jl-text-btn:hover{color:#C62828}.jl-qa-buttons{display:flex;gap:8px}.jl-qa-buttons button{flex:1;min-height:36px;padding:8px 12px;font-size:13px}#jl-ask{color:#fff;background:linear-gradient(135deg,#5D4037,#6D4C41)}#jl-suggest-btn{color:#5D4037;background:#EFEBE4;border:1.5px solid #D7CCC8!important}#jl-ask:disabled,#jl-suggest-btn:disabled{opacity:.6;cursor:wait}#jl-clear-batch:hover{background:#F5EDE0!important;border-color:#E65100!important;color:#E65100!important}";
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
          '<button id="jl-clear-batch" style="display:block;width:100%;margin-top:14px;padding:10px 12px;border:1.5px dashed #D7CCC8!important;border-radius:9px;background:#FFF8F2;color:#8D6E63;font-size:12px;font-weight:600;text-align:center;cursor:pointer;transition:all .18s ease">🗑 清空批量历史任务</button>' +
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
            '<button id="jl-graph-batch" class="jl-graph-toggle" style="background:#E8DDD2;color:#5D4037">本次批量</button>' +
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
            '<div style="display:flex;gap:6px;margin:8px 0">' +
              '<input id="jl-redeem-code" class="jl-input" type="text" placeholder="激活码" style="flex:1;text-transform:uppercase">' +
              '<button id="jl-redeem-btn" class="jl-btn-plain">兑换</button>' +
            '</div>' +
            '<p style="margin:4px 0 0;font-size:11px;color:#A1887F">咨询 / 购码请加 QQ 群：660517237</p>' +
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
          '<button id="jl-batch" style="flex:0 0 auto;background:#6D4C41;color:#fff">📚 批量分析</button>' +
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
    win.querySelector("#jl-batch").addEventListener("click", startBatchFromWindow);
    win.querySelector("#jl-clear-batch").addEventListener("click", function () {
      jlModal({
        title: "清空批量任务",
        message: "确定清空所有批量分析历史任务吗？已生成的分析结果不受影响。",
        confirmText: "清空",
        cancelText: "取消"
      }).then(function (ok) {
        if (!ok) return;
        clearBatchTasks().then(function (n) {
          jlModal({ title: "清空批量任务", message: n > 0 ? "已清空 " + n + " 个历史任务" : "暂无历史任务" });
        });
      });
    });
    win.querySelector("#jl-ask").addEventListener("click", askMemory);
    win.querySelector("#jl-suggest-btn").addEventListener("click", fetchSuggestedQuestions);
    win.querySelector("#jl-clear-chat").addEventListener("click", clearChatHistory);
    win.querySelector("#jl-export").addEventListener("click", exportResult);
    win.querySelector("#jl-review").addEventListener("click", reviewRecent);
    win.querySelector("#jl-full-report").addEventListener("click", fullReport);
    win.querySelector("#jl-graph-chapter").addEventListener("click", function () { setGraphMode("chapter"); });
    win.querySelector("#jl-graph-book").addEventListener("click", function () { setGraphMode("book"); });
    win.querySelector("#jl-graph-batch").addEventListener("click", function () { setGraphMode("batch"); });
    win.querySelector("#jl-send-code").addEventListener("click", sendEmailCode);
    win.querySelector("#jl-login-btn").addEventListener("click", emailLogin);
    win.querySelector("#jl-logout").addEventListener("click", logout);
    win.querySelector("#jl-redeem-btn").addEventListener("click", redeemAccount);
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
    const result = (data && data.result) || data || {};
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
    }, "人物分析未完成，可重新分析"));

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

  async function consumeSSE(response, callbacks) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    function handleLine(line) {
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

    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) handleLine(lines[i]);
      }
      // 流结束：flush 解码器残留字节，处理 buffer 尾部（避免 done 丢失）
      buffer += decoder.decode();
      var tail = buffer.split("\n");
      for (var j = 0; j < tail.length; j++) handleLine(tail[j]);
    } catch (e) {
      callbacks.onError("网络连接中断，请刷新页面后重试。联系客服 QQ：2313370765");
    }
  }

  async function streamFetch(url, options, callbacks) {
    var response = await fetch(url, options);
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
    if (isPaywall(document.body.innerText || "")) {
      setText("#jl-summary", "🔒 疑似付费/会员章节，已跳过（未扣额度）。开通会员后可继续阅读，或换其它免费章节分析。");
      return;
    }
    if (text.length < 80) {
      setText("#jl-summary", isFanqieSite()
        ? "⚠️ 番茄小说正文已加密，暂无法自动分析。\n\n请手动复制本章正文后粘贴重试，或换起点等其它网站。"
        : "没有识别到足够的正文内容。");
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
    if (!graphBox) return;
    if (!window.vis) {
      graphBox.innerHTML = '<div class="jl-ov-empty">图表库加载中，请稍后再试</div>';
      return;
    }
    if (!Array.isArray(graph && graph.nodes) || (graph && graph.nodes && graph.nodes.length === 0)) {
      graphBox.innerHTML = '<div class="jl-ov-empty">本章暂无人物关系数据</div>';
      return;
    }

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

  function renderBatchGraph() {
    var graphBox = document.getElementById("jl-graph");
    if (!graphBox) return;
    if (!_batchGraph || !Array.isArray(_batchGraph.nodes) || _batchGraph.nodes.length === 0) {
      graphBox.innerHTML = '<div class="jl-ov-empty">本次批量暂无人物关系数据</div>';
      return;
    }
    drawGraph(_batchGraph);
  }

  function setGraphMode(mode) {
    _graphMode = mode;
    var chapBtn = document.getElementById("jl-graph-chapter");
    var bookBtn = document.getElementById("jl-graph-book");
    var batchBtn = document.getElementById("jl-graph-batch");
    function mark(active) {
      [chapBtn, bookBtn, batchBtn].forEach(function (b) {
        if (!b) return;
        b.style.background = (b === active) ? "#5D4037" : "#E8DDD2";
        b.style.color = (b === active) ? "#fff" : "#5D4037";
      });
    }
    if (mode === "chapter") { mark(chapBtn); renderChapterGraph(); }
    else if (mode === "book") { mark(bookBtn); loadBookGraph(); }
    else { mark(batchBtn); renderBatchGraph(); }
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
    if (isPaywall(document.body.innerText || "")) {
      setText("#jl-summary", "🔒 疑似付费/会员章节，已跳过（未扣额度）。开通会员后可继续阅读，或换其它免费章节分析。");
      return;
    }
    if (text.length < 80) {
      setText("#jl-summary", isFanqieSite()
        ? "⚠️ 番茄小说正文已加密，暂无法自动分析。\n\n请手动复制本章正文后粘贴重试，或换起点等其它网站。"
        : "没有识别到足够的正文内容。");
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
      var errMsg = error.message || "分析失败，请稍后再试。联系客服 QQ：2313370765";

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

    // 移除旧的历史面板，确保每次重新加载最新数据（否则翻页分析新章节后历史不刷新）
    var panel = document.getElementById("jl-panel-summary");
    var oldSection = document.getElementById("jl-history-section");
    if (oldSection) oldSection.remove();

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
      var resp = await fetch(API + "/api/analyses/" + analysisId, {
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
      var resp = await fetch(API + "/api/me", { headers: { Authorization: "Bearer " + token } });
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

  async function redeemAccount() {
    var token = await getToken();
    if (!token) {
      accMessage("请先登录后再兑换", "error");
      return;
    }
    var codeInput = document.getElementById("jl-redeem-code");
    var code = (codeInput.value || "").trim().toUpperCase();
    if (!code) {
      accMessage("请输入激活码", "error");
      return;
    }
    var btn = document.getElementById("jl-redeem-btn");
    btn.disabled = true;
    btn.textContent = "兑换中...";
    try {
      var API = await getAPI();
      var resp = await fetch(API + "/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ code: code })
      });
      var payload = await resp.json().catch(function () { return null; });
      if (!resp.ok || !payload || !payload.success) {
        throw new Error((payload && payload.error) || "兑换失败，请检查激活码");
      }
      accMessage(payload.data.message || "兑换成功", "success");
      codeInput.value = "";
      renderAccountPanel();
    } catch (error) {
      accMessage(error.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "兑换";
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
      var resp = await fetch(API + "/api/auth/send-code", {
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
      var resp = await fetch(API + "/api/auth/verify-code", {
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
        fetch(API + "/api/auth/logout", {
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
    // 章节页显示悬浮入口按钮（一键分析，免去点插件弹窗的步骤）
    injectFloatingButton();
    // 从章节页跳转到目录页后，自动弹出批量分析
    autoOpenBatchIfFlagged();
  }
  init();

  // SPA 站点（番茄等）翻页不整页刷新、正文异步加载，浮按钮需按需补注入；
  // injectFloatingButton 内部有「已存在 / 正文不足 80 字」守卫，轮询调用安全幂等
  setInterval(function () {
    if (!document.getElementById("jl-floating-btn")) {
      injectFloatingButton();
    }
  }, 1500);
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

  // ═══════════ 目录解析 + 章节正文提取（纯函数，浏览器通用）═══════════
  (function () {
    "use strict";

    function parseHtml(html) {
      return new DOMParser().parseFromString(html, "text/html");
    }

    function cleanTitle(t) {
      return (t || "").replace(/\s+/g, " ").trim();
    }

    function isChapterTitle(t) {
      return /第\s*[0-9一二三四五六七八九十百千万零]+\s*[章节卷回]/.test(t || "");
    }

    function looksLikeChapterHref(href) {
      if (!href) return false;
      // 排除站点级静态/SEO 详情页（如 /book/7599.html、/list/12.html）：它们以「单段/数字.html」结尾却不是章节。
      // 真正的笔趣阁章节是 {目录}/{章节id}.html 两段式（如 /9_9181/123456.html），起点章节是 /book/{书id}/{章id}.html。
      if (/^\/(?:book|info|novel|list|search|author|tag|sort|top|full|quanben|wanben|new|rank|bang|tuijian|fenlei)\/\d+\.html?\/?$/i.test(href)) return false;
      // 纵横/起点打赏榜（粉丝榜）用户名链接 /show/userInfo/{id}.html：不是章节，却以「/数字.html」结尾被误判
      if (/\/userInfo\/\d+\.html?\/?$/i.test(href)) return false;
      return /\/chapter\/\d+\/\d+/i.test(href)
        || /\/(\d{3,})\.html?\/?$/i.test(href)
        || /[?&](?:id|chapterId|item_id)=(\d{4,})/i.test(href);
    }

    // 付费/会员章节的锁定页特征（正文抓取为空时再结合判定，避免误跳可读章节）
    function isPaywall(html) {
      if (!html) return false;
      return /(本章为付费|付费章节|付费内容|会员专享|会员解锁|番茄会员|成为会员|需会员|充会员|购买会员|订阅后|订阅本章|订阅解锁|请先订阅|开通VIP|开通会员|购买本章|VIP章节|VIP用户|剩余章节|剩余内容|解锁本章|解锁全文|解锁剩下|免费试读|畅读|抢先看|需付费|充值阅读|阅读券|阅币)/i.test(html);
    }

    function cnToInt(s) {
      if (!s) return null;
      if (/^\d+$/.test(s)) return parseInt(s, 10);
      var map = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
      var units = { "十": 10, "百": 100, "千": 1000, "万": 10000 };
      var total = 0, section = 0, num = 0;
      for (var i = 0; i < s.length; i++) {
        var ch = s[i];
        if (map[ch] !== undefined) { num = map[ch]; }
        else if (units[ch] !== undefined) {
          var u = units[ch];
          if (u === 10000) { section = (section + num) * u; total += section; section = 0; num = 0; }
          else { section += (num || 1) * u; num = 0; }
        } else { return null; }
      }
      return total + section + num;
    }

    function extractIndex(title, href) {
      // 番外/外传/后记/尾声 等非正文章节的「第X章」会与正文撞号，返回 null 交由上层信任 DOM 阅读顺序
      if (/(番外|外传|后记|尾声|感言)/.test(title || "")) return null;
      var m = title.match(/第\s*([0-9一二三四五六七八九十百千万零]+)\s*[章节卷回]/);
      if (m) return cnToInt(m[1]);
      var m2 = href.match(/[?&](?:id|chapterId)=(\d+)/i);
      if (m2) return parseInt(m2[1], 10);
      var m3 = href.match(/\/(\d{4,})\.html?/i);
      if (m3) return parseInt(m3[1], 10);
      var m4 = href.match(/\/chapter\/\d+\/(\d+)/i);
      if (m4) return parseInt(m4[1], 10);
      return null;
    }

    function absoluteUrl(doc, href, baseUrl) {
      var base = doc.querySelector("base[href]");
      var baseHref = base ? base.getAttribute("href") : (baseUrl || doc.baseURI);
      try { return new URL(href, baseHref || "http://x/").href; } catch (_) { return null; }
    }

    // 导航/操作类链接标题（起点目录页常混入「旧版/下一章/上一章」等跳转链接，其 href 与真实章节相同）
    function isNavLabel(t) {
      return /^(旧版|新版|下一章|上一章|下一节|上一节|下一页|上一页|目录|章节目录|章节列表|返回目录|返回书页|立即阅读|继续阅读|开始阅读|免费试读|试读|全文阅读|阅读全文|加入书架|书架|点击阅读|展开全部|收起)$/.test(t || "");
    }

    // 笔趣阁 biquga 分页目录（index_N.html / 「查看更多章节」）里章节链接是 JS 渲染：
    //   <a onclick="read_tz(123456)">第N章…</a>（无 href）
    // 站点脚本给出拼装模板：
    //   read_aid='…'; read_bid='…'; read_rewrite='/book/{aid}/{cid}.html' 或 '/{bid}_{aid}/{cid}.html'
    // 此处抽取模板与参数，供 parseCatalog 把 onclick 还原成真实章节 URL。
    function readTzContext(html) {
      if (!html) return null;
      var aid = (html.match(/read_aid\s*=\s*['"](\d+)['"]/i) || [])[1] || "";
      var bid = (html.match(/read_bid\s*=\s*['"](\d+)['"]/i) || [])[1] || "";
      var rewrite = (html.match(/read_rewrite\s*=\s*['"]([^'"]+)['"]/i) || [])[1];
      if (!rewrite) return null;
      return {
        aid: aid,
        bid: bid,
        rewrite: rewrite,
        buildUrl: function (id) {
          return rewrite.replace(/\{aid\}/g, aid).replace(/\{bid\}/g, bid).replace(/\{cid\}/g, String(id));
        },
      };
    }

    // 从当前 URL 推导笔趣阁书的唯一 ID：新格式 /book/{id}.html，旧格式 /{bid}_{aid}/。
    // 用于校验分页抓取页是否被反爬换成别的书（read_aid 与书 ID 不符即丢弃）。
    function biqugeBookId(href) {
      var m = (href || "").match(/\/book\/(\d+)(?:\/|\.html?)/i);
      if (m) return m[1];
      var m2 = (href || "").match(/\/(\d+)_(\d+)(?:\/|\.html?)/i);
      if (m2) return m2[2];
      return null;
    }

    // 起点章节唯一 ID：/chapter/{book}/{cid}/ 中的 cid（read.qidian.com / www.qidian.com / 尾斜杠 视为同一章）
    function chapterId(href) {
      var m = (href || "").match(/\/chapter\/\d+\/(\d+)\/?/i);
      return m ? m[1] : null;
    }

    function parseCatalog(html, site, baseUrl) {
      var doc = parseHtml(html);
      var anchors = Array.from(doc.querySelectorAll("a[href]"));
      var indexByKey = {};   // 去重键 → out 下标（保留 DOM 阅读顺序）
      var out = [];
      anchors.forEach(function (a) {
        var href = a.getAttribute("href");
        if (!href) return;
        var title = cleanTitle(a.textContent || a.getAttribute("title"));
        if (!title || title.length < 1 || title.length > 120) return;
        if (isNavLabel(title)) return;
        if (!isChapterTitle(title) && !looksLikeChapterHref(href)) return;
        var abs = absoluteUrl(doc, href, baseUrl);
        if (!abs) return;
        var cid = chapterId(href) || chapterId(abs);
        var key = cid ? ("cid:" + cid) : ("url:" + abs);
        var chIdx = extractIndex(title, href);
        var entry = { chapter_title: title, chapter_index: chIdx, sort_index: cid ? parseInt(cid, 10) : chIdx, source_url: abs };
        var idx = indexByKey[key];
        if (idx !== undefined) {
          // 同一章重复出现（导航链接撞真实章节）：优先保留带「第X章」标题的条目
          var prev = out[idx];
          if (isChapterTitle(title) && !isChapterTitle(prev.chapter_title)) out[idx] = entry;
          return;
        }
        indexByKey[key] = out.length;
        out.push(entry);
      });

      // 第二遍：read_tz(onclick) 渲染的章节链接（无 href）——笔趣阁分页目录/「查看更多章节」用 JS 拼装 URL
      var tz = readTzContext(html);
      if (tz) {
        Array.from(doc.querySelectorAll("[onclick]")).forEach(function (a) {
          var oc = a.getAttribute("onclick") || "";
          var mm = oc.match(/read_tz\s*\(\s*['"]?(\d+)['"]?\s*\)/i);
          if (!mm) return;
          var title = cleanTitle(a.textContent || a.getAttribute("title"));
          if (!title || title.length < 1 || title.length > 120) return;
          if (isNavLabel(title)) return;
          if (!isChapterTitle(title) && !looksLikeChapterHref(oc)) return;
          var rel = tz.buildUrl(mm[1]);
          var abs = absoluteUrl(doc, rel, baseUrl);
          if (!abs) return;
          var cid = chapterId(rel) || chapterId(abs);
          var key = cid ? ("cid:" + cid) : ("url:" + abs);
          var chIdx = extractIndex(title, rel);
          var entry = { chapter_title: title, chapter_index: chIdx, sort_index: cid ? parseInt(cid, 10) : chIdx, source_url: abs };
          var idx = indexByKey[key];
          if (idx !== undefined) {
            var prev = out[idx];
            if (isChapterTitle(title) && !isChapterTitle(prev.chapter_title)) out[idx] = entry;
            return;
          }
          indexByKey[key] = out.length;
          out.push(entry);
        });
      }
      return out;
    }

    // 目录条目排序键：优先用单调递增的 sort_index（起点卷内章节号每卷从第一章重排，cid 才是唯一递增的阅读顺序）
    function catalogSortKey(c) {
      if (typeof c.sort_index === "number") return c.sort_index;
      if (typeof c.chapter_index === "number") return c.chapter_index;
      return null;
    }

    // 取「最新 N 章」：全为数字序号时升序排序再取末尾（兼容目录倒序站点）；
    // 任一序号缺失则信任 DOM 顺序（默认目录按阅读顺序正序排列）。
    function selectLatest(list, n) {
      if (!list || !list.length) return [];
      var arr = list.slice();
      var allNumeric = arr.every(function (c) { return catalogSortKey(c) !== null; });
      if (allNumeric && arr.length > 1) {
        arr.sort(function (a, b) { return catalogSortKey(a) - catalogSortKey(b); });
      }
      var count = Math.max(1, Math.min(n || 1, arr.length));
      return arr.slice(arr.length - count);
    }

    function extractChapterText(html, site) {
      var doc = parseHtml(html);
      var selectors = [
        "#content", "#chaptercontent", "#ChapterContent", "#txt",
        ".read-content", ".word_read", ".main-text-wrap", ".chapter-content",
        ".content", ".article-content", ".post-content",
        ".txt", ".text", ".novel-content", ".book-content",
        "article", ".entry-content", "#article", "#text",
      ];
      var best = "";
      selectors.forEach(function (sel) {
        var c = doc.querySelector(sel);
        if (!c) return;
        var ps = c.querySelectorAll("p, div");
        var text = Array.from(ps).map(function (p) { return (p.textContent || "").trim(); }).filter(function (t) { return t.length > 5; }).join("\n");
        if (text.length > best.length) best = text;
      });
      if (best.length < 80) {
        var all = doc.querySelectorAll("p");
        var alt = Array.from(all).map(function (p) { return (p.textContent || "").trim(); }).filter(function (t) { return t.length > 8; }).join("\n");
        if (alt.length > best.length) best = alt;
      }
      return best;
    }

    // 笔趣阁 biquga 章节正文为 document.writeln(qsbs.bb('BASE64'))，qsbs.bb 即标准 base64 + UTF-8。
    // 解码所有块并返回拼接后的 HTML（含 <p> 段落），供 extractChapterText 提取正文。
    function decodeBiqugeBase64(html) {
      if (!html) return "";
      var re = /document\.writeln\(\s*qsbs\.bb\(\s*(['"])([^'"]+)\1\s*\)\s*\)/gi;
      var m, chunks = [];
      while ((m = re.exec(html)) !== null) {
        var b64 = m[2].replace(/\s+/g, "");
        if (!b64) continue;
        try {
          var bin = atob(b64);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          chunks.push(new TextDecoder("utf-8").decode(bytes));
        } catch (_) { /* 忽略无法解码的块 */ }
      }
      return chunks.join("\n");
    }

    // 笔趣阁（biquga）目录分页入口：书页只显示「最新章节」，完整目录在 index_1.html…index_N.html。
    // biquga 旧格式 /{bid}_{aid}/ 的分页目录被服务端反爬（返回别的书），
    // 但同书新格式 /book/{aid}/index_N.html 正常，故旧格式统一换算为新格式。返回绝对 URL 或 null。
    function biqugeCatalogEntryHref(doc, currentHref) {
      var origin = ((currentHref || "").match(/^(https?:\/\/[^\/]+)/i) || [])[1] || "";
      // 已在 index_N 页：直接派生 index_1（旧格式换算为新格式）
      var m = (currentHref || "").match(/^(.*?)\/index(?:_\d+)?\.html?$/i);
      if (m) {
        var base = m[1];
        var ob = base.match(/\/(\d+)_(\d+)$/i);
        if (ob && origin) return origin + "/book/" + ob[2] + "/index_1.html";
        return base + "/index_1.html";
      }
      // 旧格式书页 /{bid}_{aid}/ → 新格式分页入口，绕开反爬
      var old = (currentHref || "").match(/\/(\d+)_(\d+)\/?$/i);
      if (old && origin) return origin + "/book/" + old[2] + "/index_1.html";
      var anchors = doc.querySelectorAll("a[href]");
      for (var i = 0; i < anchors.length; i++) {
        var href = anchors[i].getAttribute("href");
        if (!href || !/index(?:_\d+)?\.html?$/i.test(href)) continue;
        var abs = absoluteUrl(doc, href, currentHref);
        if (!abs) continue;
        var ob2 = abs.match(/\/(\d+)_(\d+)\/index(?:_\d+)?\.html?$/i);
        if (ob2 && origin) return origin + "/book/" + ob2[2] + "/index_1.html";
        return abs.replace(/index(?:_\d+)?\.html?$/i, "index_1.html");
      }
      return null;
    }

    // 笔趣阁目录分页总数：扫描 index_N.html 分页链接（含 <option value="…index_N.html"> 下拉分页）取最大页码；兜底解析「共 N 页」文字。
    function biqugeCatalogPageCount(html) {
      var doc = parseHtml(html);
      var max = 0;
      Array.from(doc.querySelectorAll("a[href], option[value]")).forEach(function (el) {
        var href = el.getAttribute("href") || el.getAttribute("value") || "";
        var mm = href.match(/index_(\d+)\.html?$/i);
        if (mm) { var n = parseInt(mm[1], 10); if (n > max) max = n; }
      });
      if (!max) {
        var txt = (doc.body && doc.body.textContent) || "";
        var tm = txt.match(/共\s*(\d+)\s*页/);
        if (tm) max = parseInt(tm[1], 10);
      }
      return max > 0 ? max : 1;
    }

    window.JLBatchParser = {
      parseHtml: parseHtml,
      parseCatalog: parseCatalog,
      selectLatest: selectLatest,
      catalogSortKey: catalogSortKey,
      extractChapterText: extractChapterText,
      decodeBiqugeBase64: decodeBiqugeBase64,
      extractIndex: extractIndex,
      cnToInt: cnToInt,
      cleanTitle: cleanTitle,
      isChapterTitle: isChapterTitle,
      looksLikeChapterHref: looksLikeChapterHref,
      isPaywall: isPaywall,
      biqugeCatalogEntryHref: biqugeCatalogEntryHref,
      biqugeCatalogPageCount: biqugeCatalogPageCount,
      readTzContext: readTzContext,
      biqugeBookId: biqugeBookId,
    };
  })();

  // ═══════════ 批量分析（目录页） ═══════════

  // 统计当前 DOM 里可判为章节的链接数量（与 detectCatalogPage 同口径，全量计数供等待渲染用）
  function countChapterLinks() {
    var links = document.querySelectorAll("a[href]");
    var n = 0;
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var title = window.JLBatchParser.cleanTitle(a.textContent || a.getAttribute("title"));
      var href = a.getAttribute("href");
      if (window.JLBatchParser.isChapterTitle(title) || window.JLBatchParser.looksLikeChapterHref(href)) n++;
    }
    return n;
  }

  function detectCatalogPage() {
    return countChapterLinks() >= 5;
  }

  function confirmBatchStart(selectedList) {
    startBatchJob(selectedList).then(function (job) {
      if (job) runBatchJob(job);
    });
  }

  // 注入章节勾选面板样式（幂等）
  function ensureBatchPickerStyle() {
    if (document.getElementById("jl-batch-picker-style")) return;
    var st = document.createElement("style");
    st.id = "jl-batch-picker-style";
    st.textContent =
      "#jl-batch-picker-mask{position:fixed;inset:0;z-index:2147483646;background:rgba(30,20,15,.45);display:flex;align-items:center;justify-content:center;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;animation:jlFadeIn .2s ease}" +
      "#jl-batch-picker-mask .jlbp-panel{display:flex;flex-direction:column;width:min(560px,calc(100vw - 32px));height:min(720px,calc(100vh - 32px));background:linear-gradient(180deg,#FBF8F0,#F5EDE0);border:1px solid #D7CCC8;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.3);overflow:hidden}" +
      "#jl-batch-picker-mask .jlbp-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;color:#fff;background:linear-gradient(135deg,#3E2723,#5D4037,#6D4C41)}" +
      "#jl-batch-picker-mask .jlbp-title strong{display:block;font-size:16px;font-weight:700;letter-spacing:.5px}" +
      "#jl-batch-picker-mask .jlbp-title span{display:block;margin-top:4px;font-size:12px;opacity:.75;line-height:1.5}" +
      "#jl-batch-picker-mask .jlbp-close{width:32px;height:32px;flex:0 0 auto;color:#fff;background:rgba(255,255,255,.14);border:0;border-radius:50%!important;font-size:20px;line-height:1;cursor:pointer}" +
      "#jl-batch-picker-mask .jlbp-close:hover{background:rgba(255,255,255,.26)}" +
      "#jl-batch-picker-mask .jlbp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;background:#EFEBE4;border-bottom:1px solid #E8DDD2}" +
      "#jl-batch-picker-mask .jlbp-count{font-size:12px;color:#6D4C41}" +
      "#jl-batch-picker-mask .jlbp-count b{color:#E65100;font-size:14px}" +
      "#jl-batch-picker-mask .jlbp-actions{display:flex;gap:6px}" +
      "#jl-batch-picker-mask .jlbp-btn{padding:6px 12px;border:1px solid #D7CCC8;border-radius:8px;background:#FFFDF7;color:#5D4037;font-size:12px;font-weight:500;cursor:pointer;transition:all .15s ease}" +
      "#jl-batch-picker-mask .jlbp-btn:hover{border-color:#8D6E63;background:#F5EDE0}" +
      "#jl-batch-picker-mask .jlbp-list{flex:1;min-height:0;overflow-y:auto;padding:8px 12px}" +
      "#jl-batch-picker-mask .jlbp-list::-webkit-scrollbar{width:6px}" +
      "#jl-batch-picker-mask .jlbp-list::-webkit-scrollbar-thumb{background:#D7CCC8;border-radius:3px}" +
      "#jl-batch-picker-mask .jlbp-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;transition:background .12s ease}" +
      "#jl-batch-picker-mask .jlbp-item:hover{background:#FFF3E0}" +
      "#jl-batch-picker-mask .jlbp-check{-webkit-appearance:none!important;appearance:none!important;display:block!important;width:18px!important;height:18px!important;margin:0!important;padding:0!important;flex:0 0 auto!important;box-sizing:border-box!important;border:1.5px solid #B08968!important;border-radius:5px!important;background-color:#fff!important;background-size:14px 14px!important;background-position:center!important;background-repeat:no-repeat!important;opacity:1!important;visibility:visible!important;cursor:pointer!important}" +
      "#jl-batch-picker-mask .jlbp-check:hover{border-color:#E65100!important}" +
      "#jl-batch-picker-mask .jlbp-check:checked{background-color:#E65100!important;border-color:#E65100!important;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E\")!important}" +
      "#jl-batch-picker-mask .jlbp-idx{flex:0 0 auto;min-width:52px;padding:2px 8px;border-radius:10px;background:#EFEBE4;color:#8D6E63;font-size:11px;text-align:center}" +
      "#jl-batch-picker-mask .jlbp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3E2723;font-size:13px}" +
      "#jl-batch-picker-mask .jlbp-footer{display:flex;gap:10px;padding:12px 16px;border-top:1px solid #E8DDD2;background:#F5EDE0}" +
      "#jl-batch-picker-mask .jlbp-cancel{flex:0 0 auto}" +
      "#jl-batch-picker-mask .jlbp-start{flex:1;color:#fff;background:linear-gradient(135deg,#E65100,#F57C00);border:0;font-weight:600;box-shadow:0 2px 8px rgba(230,81,0,.25)}" +
      "#jl-batch-picker-mask .jlbp-start:hover{box-shadow:0 4px 14px rgba(230,81,0,.35)}" +
      "#jl-batch-picker-mask .jlbp-start:disabled{opacity:.5;cursor:not-allowed;box-shadow:none}";
    document.documentElement.appendChild(st);
  }

  // 弹出章节勾选面板：解析目录 → 排序 → 用户勾选 → 确认后建任务
  function showBatchChapterPicker(all) {
    var oldMask = document.getElementById("jl-batch-picker-mask");
    if (oldMask) oldMask.remove();

    // 排序：与 selectLatest 一致 —— 全数字序号则升序，否则信任 DOM 阅读顺序
    var sorted = all.slice();
    var catKey = (window.JLBatchParser && window.JLBatchParser.catalogSortKey) || function (c) { return (typeof c.sort_index === "number") ? c.sort_index : c.chapter_index; };
    var allNumeric = sorted.every(function (c) { return typeof catKey(c) === "number"; });
    if (allNumeric && sorted.length > 1) {
      sorted.sort(function (a, b) { return catKey(a) - catKey(b); });
    }

    var savedN = parseInt(localStorage.getItem("JL_Batch_Count") || "10", 10);
    if (!savedN || savedN < 1) savedN = 10;
    var defaultCount = Math.max(1, Math.min(savedN, sorted.length));
    var defaultSet = {};
    for (var i = sorted.length - defaultCount; i < sorted.length; i++) {
      defaultSet[sorted[i].source_url] = true;
    }
    // 勾选状态以 source_url 为键维护，切换正序/倒序不丢勾选；默认不勾选，由用户自行勾选
    var checkedSet = {};
    var desc = localStorage.getItem("JL_Batch_Order") === "desc"; // 默认正序（第一章在前，符合阅读顺序）

    ensureBatchPickerStyle();

    var mask = document.createElement("div");
    mask.id = "jl-batch-picker-mask";
    mask.innerHTML =
      '<div class="jlbp-panel">' +
        '<div class="jlbp-header">' +
          '<div class="jlbp-title"><strong>📚 批量分析 · 选择章节</strong><span>勾选要分析的章节；付费/会员章节自动跳过，不扣额度</span></div>' +
          '<button class="jlbp-close" title="关闭">×</button>' +
        '</div>' +
        '<div class="jlbp-toolbar">' +
          '<span class="jlbp-count">已选 <b id="jlbp-count">0</b> / ' + sorted.length + ' 章</span>' +
          '<div class="jlbp-actions">' +
            '<button class="jlbp-btn" data-act="all">全选</button>' +
            '<button class="jlbp-btn" data-act="none">全不选</button>' +
            '<button class="jlbp-btn" data-act="latest">选最新 ' + savedN + ' 章</button>' +
            '<button class="jlbp-btn" id="jlbp-order" title="切换章节列表正序/倒序">' + (desc ? "倒序 ⇅" : "正序 ⇅") + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="jlbp-list" id="jlbp-list"></div>' +
        '<div class="jlbp-footer">' +
          '<button class="jlbp-btn jlbp-cancel">取消</button>' +
          '<button class="jlbp-btn jlbp-start">开始分析 <b id="jlbp-start-n">0</b> 章</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);

    var listEl = mask.querySelector("#jlbp-list");

    function renderList() {
      listEl.innerHTML = "";
      var items = desc ? sorted.slice().reverse() : sorted;
      items.forEach(function (c) {
        var checked = checkedSet[c.source_url] ? "checked" : "";
        var idxLabel = (typeof c.chapter_index === "number") ? ("第 " + c.chapter_index + " 章") : "";
        var label = document.createElement("label");
        label.className = "jlbp-item";
        label.innerHTML =
          '<input type="checkbox" class="jlbp-check" data-url="' + escHtml(c.source_url) + '" ' + checked + '>' +
          '<span class="jlbp-idx">' + escHtml(idxLabel) + '</span>' +
          '<span class="jlbp-name">' + escHtml(c.chapter_title) + '</span>';
        listEl.appendChild(label);
      });
      refreshCount();
    }

    function refreshCount() {
      var n = 0;
      for (var k in checkedSet) n++;
      mask.querySelector("#jlbp-count").textContent = String(n);
      mask.querySelector("#jlbp-start-n").textContent = String(n);
      mask.querySelector(".jlbp-start").disabled = n === 0;
    }

    renderList();

    listEl.addEventListener("change", function (e) {
      var box = e.target;
      if (!box || !box.classList || !box.classList.contains("jlbp-check")) return;
      var url = box.getAttribute("data-url");
      if (box.checked) checkedSet[url] = true; else delete checkedSet[url];
      refreshCount();
    });

    mask.querySelector(".jlbp-close").addEventListener("click", function () { mask.remove(); });
    mask.querySelector(".jlbp-cancel").addEventListener("click", function () { mask.remove(); });

    var orderBtn = mask.querySelector("#jlbp-order");
    orderBtn.addEventListener("click", function () {
      desc = !desc;
      try { localStorage.setItem("JL_Batch_Order", desc ? "desc" : "asc"); } catch (_) {}
      orderBtn.textContent = desc ? "倒序 ⇅" : "正序 ⇅";
      renderList();
    });

    mask.querySelectorAll(".jlbp-btn[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var act = btn.getAttribute("data-act");
        if (act === "all") {
          sorted.forEach(function (c) { checkedSet[c.source_url] = true; });
        } else if (act === "none") {
          checkedSet = {};
        } else if (act === "latest") {
          checkedSet = {};
          for (var k in defaultSet) checkedSet[k] = true;
        }
        renderList();
      });
    });

    mask.querySelector(".jlbp-start").addEventListener("click", function () {
      // 提交顺序按章节号倒序（最新在前），保持既有批量分析顺序
      var selected = [];
      sorted.slice().reverse().forEach(function (c) {
        if (checkedSet[c.source_url]) selected.push(c);
      });
      if (!selected.length) return;
      try { localStorage.setItem("JL_Batch_Count", String(selected.length)); } catch (_) {}
      mask.remove();
      resumeOrStart(selected);
    });
  }

  // ── 批量分析入口（主窗口 footer「📚 批量分析」按钮）──
  function startBatchFromWindow() {
    var site = detectSite();
    // 七猫中文网：目录是 SPA 异步渲染，章节以非 <a> 元素呈现，DOM 链接解析拿不到；
    // 直接从章节列表接口取全书目录（无需跳转目录页，避免白白导航一次）。
    if (/qimao\.com/i.test(location.hostname)) {
      collectQimaoCatalog().then(function (all) {
        if (all && all.length) { showBatchChapterPicker(all); return; }
        jlModal({ title: "批量分析", message: "未解析到七猫目录，请刷新后重试。" });
      });
      return;
    }
    // 起点/纵横的「详情页」只展示部分章节（试读/最新章节），并非完整目录；
    // 先跳转到真正的目录页再解析，避免目录不全、排序错乱。
    var onCatalogPage = (site === "qidian" && /\/book\/\d+\/catalog\/?$/i.test(location.pathname)) ||
                        (site === "zongheng" && /tabsName=catalogue/i.test(location.search));
    if ((site === "qidian" || site === "zongheng") && !onCatalogPage) {
      var catUrl = guessCatalogUrl();
      if (catUrl) {
        try { sessionStorage.setItem("jl_auto_batch", "1"); } catch (_) {}
        location.href = catUrl;
        return;
      }
    }
    if (detectCatalogPage()) {
      if (site === "biquge") {
        var onDone = function (all) {
          if (all && all.length) { showBatchChapterPicker(all); return; }
          var html = document.documentElement.outerHTML;
          var cur = window.JLBatchParser.parseCatalog(html, site);
          if (!cur.length) {
            jlModal({ title: "批量分析", message: "未在目录页解析到章节列表，请刷新后重试。" });
            return;
          }
          showBatchChapterPicker(cur);
        };
        collectBiqugeCatalog().then(onDone, function () { onDone(null); });
        return;
      }
      var html = document.documentElement.outerHTML;
      var all = window.JLBatchParser.parseCatalog(html, site);
      if (!all.length) {
        jlModal({ title: "批量分析", message: "未在目录页解析到章节列表，请刷新后重试。" });
        return;
      }
      showBatchChapterPicker(all);
      return;
    }
    var catalogUrl = guessCatalogUrl();
    if (catalogUrl) {
      try { sessionStorage.setItem("jl_auto_batch", "1"); } catch (_) {}
      location.href = catalogUrl;
    } else {
      jlModal({ title: "批量分析", message: "请先打开小说的目录页（章节列表页），再点批量分析。" });
    }
  }

  // 七猫中文网全书目录：走章节列表接口 /qimaoapi/api/book/chapter-list?book_id={bookId}。
  // 章节 URL 为 /shuku/{bookId}-{chapterId}/，chapterId 即接口返回的章节 id 字段。
  async function collectQimaoCatalog() {
    var loading = showCatalogLoading();
    try {
      var m = location.pathname.match(/\/shuku\/(\d+)(?:-\d+)?\//);
      if (!m) return null;
      var bookId = m[1];
      var resp = await fetchWithRetry(
        "https://www.qimao.com/qimaoapi/api/book/chapter-list?book_id=" + bookId,
        { credentials: "include" }, 2, 15000
      );
      var body = await resp.json();
      var chapters = (body && body.data && body.data.chapters) || [];
      var list = chapters.map(function (c) {
        var idx = parseInt(c.index, 10);
        return {
          chapter_title: c.title || ("第" + c.index + "章"),
          chapter_index: isNaN(idx) ? null : idx,
          sort_index: isNaN(idx) ? null : idx,
          source_url: "https://www.qimao.com/shuku/" + bookId + "-" + c.id + "/",
        };
      });
      return list.length ? list : null;
    } catch (_) {
      return null;
    } finally {
      if (loading) loading.remove();
    }
  }

  // 读取笔趣阁完整目录。核心：先直接解析当前页（书页本身就是完整目录，绝不能丢），
  // 再若存在「查看更多章节 / index_N」分页入口则逐页抓取补充（read_tz 渲染的其余章节），
  // 并校验抓取页 read_aid 与当前书 ID 一致，防止反爬返回别本书污染目录。
  async function collectBiqugeCatalog() {
    var P = window.JLBatchParser;
    var site = "biquge";
    var loading = showCatalogLoading();
    var partial = false; // 是否因反爬只读到部分目录（书页之外的章节缺失）
    try {
      var seen = {};
      var all = [];
      function add(list) {
        (list || []).forEach(function (c) {
          if (!c || !c.source_url) return;
          if (!seen[c.source_url]) { seen[c.source_url] = true; all.push(c); }
        });
      }

      // 1) 当前页直接解析 —— 这是基础目录，绝对保留
      add(P.parseCatalog(document.documentElement.outerHTML, site, location.href));

      // 2) 分页补充：仅当书页目录不完整时才抓取（小书直接返回，避免无谓等待）
      if (!isCatalogComplete(all)) {
        var bookId = P.biqugeBookId(location.href);
        var entry = P.biqugeCatalogEntryHref(document, location.href);
        if (entry) {
          var firstHtml = await fetchTextQuiet(entry);
          if (firstHtml) {
            if (bookId && isAntiScrape(firstHtml, bookId)) {
              partial = true; // 分页页被反爬换成别的书，放弃补充
            } else {
              var pageCount = P.biqugeCatalogPageCount(firstHtml);
              if (!pageCount || pageCount < 1) pageCount = 1;
              if (pageCount > 60) pageCount = 60; // 防御：异常站点不无限抓取
              add(P.parseCatalog(firstHtml, site, entry));
              // 并行抓取其余分页，避免串行等待（大书提速明显）
              var urls = [];
              for (var p = 2; p <= pageCount; p++) {
                urls.push(entry.replace(/index(?:_\d+)?\.html?$/i, "index_" + p + ".html"));
              }
              var pages = await Promise.all(urls.map(function (u) {
                return fetchTextQuiet(u).then(function (html) {
                  if (!html) return null;
                  if (bookId && isAntiScrape(html, bookId)) { partial = true; return null; }
                  return P.parseCatalog(html, site, u);
                });
              }));
              pages.forEach(add);
            }
          }
        }
      }
      if (partial && all.length) showCatalogPartialToast(all.length);
      return all.length ? all : null;
    } finally {
      if (loading) loading.remove();
    }
  }

  // 抓取页是否被反爬换成别的书：read_aid 与当前书 ID 不符即视为污染
  function isAntiScrape(html, bookId) {
    var aid = (html.match(/read_aid\s*=\s*['"](\d+)['"]/i) || [])[1];
    return !!aid && aid !== bookId;
  }

  // 判断书页目录是否已完整（章节号 1..max 连续无缺口），是则跳过慢速分页抓取
  function isCatalogComplete(list) {
    if (!list || list.length < 2) return false;
    var uniq = {};
    var count = 0, max = 0, indexed = 0;
    list.forEach(function (c) {
      var n = c.chapter_index;
      if (typeof n === "number" && n > 0) {
        indexed++;
        if (!uniq[n]) { uniq[n] = true; count++; }
        if (n > max) max = n;
      }
    });
    if (max < 2 || indexed < list.length * 0.8) return false;
    return count === max;
  }

  // 目录被反爬截断时的轻量提示（非阻塞，自动消失，不遮挡后续的选章面板）
  function showCatalogPartialToast(count) {
    var old = document.getElementById("jl-catalog-toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.id = "jl-catalog-toast";
    el.style.cssText = "position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:2147483647;background:#5D4037;color:#FFF8E1;padding:11px 16px;border-radius:8px;font-size:13px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:88vw;text-align:center;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif";
    el.textContent = "⚠️ 目录可能不完整：已读取 " + count + " 章；本站对本书的分页目录做了反爬限制，书页之外的章节未能读取。";
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 6000);
  }

  async function fetchTextQuiet(url) {
    try {
      var r = await fetchWithRetry(url, { credentials: "include" }, 2, 15000);
      return await r.text();
    } catch (_) { return null; }
  }

  // 临时加载遮罩：多页目录抓取需数秒，给用户明确反馈
  function showCatalogLoading() {
    var old = document.getElementById("jl-catalog-loading");
    if (old) old.remove();
    var el = document.createElement("div");
    el.id = "jl-catalog-loading";
    el.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(30,20,15,.45);display:flex;align-items:center;justify-content:center;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif";
    el.innerHTML = '<div style="background:#FFFDF7;border-radius:12px;padding:22px 30px;color:#5D4037;font-size:14px;box-shadow:0 16px 48px rgba(0,0,0,.3)">📚 正在读取完整章节目录…</div>';
    document.body.appendChild(el);
    return el;
  }

  // 有未完成任务时让用户选择「续跑」或「新建」；否则直接开始
  function resumeOrStart(selectedList) {
    getAPI().then(function (API) {
      return getToken().then(function (token) {
        if (!token) return null;
        return fetchWithRetry(API + "/api/analyze/batch", {
          headers: { "Authorization": "Bearer " + token },
        }, 2);
      });
    }).then(function (resp) {
      if (!resp) return null;
      return resp.json();
    }).then(function (body) {
      var jobs = (body && body.data && body.data.jobs) || [];
      if (!jobs.length) { confirmBatchStart(selectedList); return; }
      jlModal({
        title: "续跑批量任务",
        message: "检测到 " + jobs.length + " 个未完成批量任务，是否续跑最近一个？",
        confirmText: "续跑",
        cancelText: "新建任务"
      }).then(function (ok) {
        if (ok) runBatchJob(jobs[0]);
        else confirmBatchStart(selectedList);
      });
    }).catch(function () {
      confirmBatchStart(selectedList);
    });
  }

  function clearBatchTasks() {
    return getAPI().then(function (API) {
      return getToken().then(function (token) {
        if (!token) return 0;
        return fetchWithRetry(API + "/api/analyze/batch/clear", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        }, 2).then(function (r) { return r.json(); }).then(function (b) {
          return (b && b.data && b.data.deleted) || 0;
        });
      });
    }).catch(function () { return 0; });
  }

  // 弹窗入口：统一走主窗口内的批量分析
  function startBatchFlow() {
    startBatchFromWindow();
  }

  // 显眼的自定义弹窗（替代原生 alert/confirm 的白色小弹窗）：深色遮罩 + 橙色主按钮，居中高对比
  function ensureModalStyle() {
    if (document.getElementById("jl-modal-style")) return;
    var st = document.createElement("style");
    st.id = "jl-modal-style";
    st.textContent =
      "#jl-modal-mask{position:fixed;inset:0;z-index:2147483647;background:rgba(18,12,8,.62);display:flex;align-items:center;justify-content:center;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;animation:jlFadeIn .18s ease}" +
      "#jl-modal-mask .jl-modal-card{width:min(420px,calc(100vw - 36px));background:#FFFDF7;border:2px solid #E65100;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden}" +
      "#jl-modal-mask .jl-modal-title{display:flex;align-items:center;gap:8px;padding:16px 20px;color:#fff;background:linear-gradient(135deg,#3E2723,#5D4037,#6D4C41);font-size:17px;font-weight:700;letter-spacing:.5px}" +
      "#jl-modal-mask .jl-modal-msg{color:#3E2723;padding:20px;font-size:14.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word}" +
      "#jl-modal-mask .jl-modal-btns{display:flex;gap:10px;padding:0 20px 18px}" +
      "#jl-modal-mask .jl-modal-btn{flex:1;padding:12px 10px;border:1px solid #D7CCC8;border-radius:10px;background:#FFF;color:#5D4037;font-size:15px;font-weight:600;cursor:pointer;transition:all .15s ease}" +
      "#jl-modal-mask .jl-modal-btn:hover{background:#F5EDE0;border-color:#8D6E63}" +
      "#jl-modal-mask .jl-modal-ok{color:#fff;background:linear-gradient(135deg,#E65100,#F57C00);border:0;box-shadow:0 3px 10px rgba(230,81,0,.35)}" +
      "#jl-modal-mask .jl-modal-ok:hover{box-shadow:0 5px 16px rgba(230,81,0,.5)}";
    document.documentElement.appendChild(st);
  }

  function jlModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var old = document.getElementById("jl-modal-mask");
      if (old) old.remove();
      ensureModalStyle();
      var mask = document.createElement("div");
      mask.id = "jl-modal-mask";
      mask.innerHTML =
        '<div class="jl-modal-card">' +
          '<div class="jl-modal-title">' + escHtml(opts.title || "提示") + '</div>' +
          '<div class="jl-modal-msg">' + escHtml(opts.message || "") + '</div>' +
          '<div class="jl-modal-btns">' +
            (opts.confirmText ? '<button class="jl-modal-btn jl-modal-cancel">' + escHtml(opts.cancelText || "取消") + '</button>' : '') +
            '<button class="jl-modal-btn jl-modal-ok">' + escHtml(opts.confirmText || "知道了") + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);
      var close = function (val) { mask.remove(); resolve(val); };
      mask.querySelector(".jl-modal-ok").addEventListener("click", function () { close(true); });
      var cancelBtn = mask.querySelector(".jl-modal-cancel");
      if (cancelBtn) cancelBtn.addEventListener("click", function () { close(false); });
      mask.addEventListener("click", function (e) { if (e.target === mask) close(false); });
    });
  }

  function getFanqieBookId() {
    try {
      var s = window.__INITIAL_STATE__;
      var cd = s && s.reader && s.reader.chapterData;
      if (cd) {
        if (cd.bookId) return String(cd.bookId);
        if (cd.book_id) return String(cd.book_id);
        if (cd.novelId) return String(cd.novelId);
      }
    } catch (_) {}
    var m = (document.documentElement.outerHTML || "").match(/"bookId"\s*:\s*"(\d+)"/);
    return m ? m[1] : null;
  }

  function guessCatalogUrl() {
    var h = location.hostname;
    var path = location.pathname;
    var m;
    if (/qidian\.com/i.test(h)) {
      m = path.match(/\/chapter\/(\d+)/) || path.match(/\/book\/(\d+)/);
      if (m) return "https://www.qidian.com/book/" + m[1] + "/catalog/";
      return null;
    }
    // 纵横：详情页 /detail/{id} 默认只展示最新章节，完整目录在 ?tabsName=catalogue
    if (/zongheng\.com/i.test(h)) {
      m = path.match(/\/detail\/(\d+)/) || path.match(/\/book\/(\d+)/) || path.match(/\/chapter\/(\d+)\/(\d+)/);
      if (m) return "https://www.zongheng.com/detail/" + m[1] + "?tabsName=catalogue";
      return null;
    }
    // 番茄：阅读页没有目录页链接，需从 __INITIAL_STATE__.reader.chapterData.bookId 取书 ID 拼接 /page/{book_id}
    if (/fanqienovel\.com/i.test(h)) {
      var bookId = getFanqieBookId();
      if (bookId) return "https://fanqienovel.com/page/" + bookId;
    }
    // 通用：优先按 href 目录页特征，再按文本「目录」入口
    var links = document.querySelectorAll("a[href]");
    var i, href, t;
    for (i = 0; i < links.length; i++) {
      href = links[i].getAttribute("href");
      if (href && /\/(page|book|catalog|mulu)\/\d+/i.test(href)) return links[i].href;
    }
    for (i = 0; i < links.length; i++) {
      t = (links[i].textContent || "").trim();
      if (/(目录|章节列表|章节目录|全部章节)/.test(t) && links[i].href) {
        return links[i].href;
      }
    }
    return null;
  }

  // 从章节页跳转到目录页后，自动弹出配置面板
  // 等待目录页章节异步渲染完成再解析。纵横等 SPA 站点的目录是 XHR 异步渲染的：
  // 详情页自带少量「最新章节」预览（会被 detectCatalogPage 误判为目录已就绪），
  // 完整目录要等 XHR 返回后一次性渲染。这里轮询等待「章节数明显增长并稳定」再回调。
  function waitCatalogSettled(onReady) {
    var MIN = 20;   // 完整目录下限：低于此值视为详情页预览，不采信
    var GROW = 3;   // 相比初始预览数量的增长幅度：超过即视为目录开始渲染
    var deadline = Date.now() + 15000;
    var n0 = countChapterLinks();
    // 注入时目录已渲染完成（章节数已足够多）→ 直接解析，避免多余等待
    if (n0 >= MIN) { onReady(); return; }
    var last = n0;
    var stable = 0;
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      if (onReady) onReady();
    }
    function tick() {
      var n = countChapterLinks();
      if (n >= MIN && n >= n0 + GROW) {   // 目录已渲染：数量明显超过初始预览
        if (n === last) stable++; else stable = 0;
        last = n;
        if (stable >= 2) { finish(); return; }
      } else {
        last = n;
        stable = 0;
      }
      if (Date.now() >= deadline) { finish(); return; }  // 超时兜底：避免无响应
      setTimeout(tick, 400);
    }
    tick();
  }

  // 从章节页跳转到目录页后，自动弹出配置面板
  function autoOpenBatchIfFlagged() {
    var flagged = false;
    try { flagged = sessionStorage.getItem("jl_auto_batch") === "1"; } catch (_) {}
    if (!flagged) return;
    try { sessionStorage.removeItem("jl_auto_batch"); } catch (_) {}
    // 目录可能是异步渲染（纵横），直接 detectCatalogPage 会误把详情页预览当目录就绪；
    // 先等章节数增长并稳定，再解析，避免第一下只抓到「最新章节」的几章。
    waitCatalogSettled(function () {
      if (detectCatalogPage()) startBatchFromWindow();
    });
  }

  async function startBatchJob(list) {
    var API = await getAPI();
    var token = await getToken();
    if (!token) { jlModal({ title: "批量分析", message: "请先登录后再批量分析。" }); return null; }
    var resp = await fetchWithRetry(API + "/api/analyze/batch/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({
        book_title: getBookTitle(),
        author: getAuthor(),
        chapter_list: list,
        detail_level: localStorage.getItem("JL_Detail_Level") || "standard",
        spoiler_free: true,
      }),
    }, 2);
    var data = await resp.json();
    if (!data.success) { jlModal({ title: "批量分析", message: data.error || "创建任务失败" }); return null; }
    var d = data.data;
    jlModal({ title: "批量分析", message: "任务已创建：共 " + d.total + " 章，需分析 " + d.pending + " 章，已跳过 " + d.skipped + " 章" });
    return d;
  }

  // ═══════════ 批量抓取循环 + 进度面板 ═══════════

  function detectSite() {
    var h = location.hostname;
    if (/fanqienovel\.com/i.test(h)) return "fanqie";
    if (/qidian\.com/i.test(h)) return "qidian";
    if (/zongheng\.com/i.test(h)) return "zongheng";
    return "biquge";
  }

  async function fetchChapterText(source_url) {
    var site = detectSite();
    if (site === "qidian") {
      return fetchChapterViaIframe(source_url, site);
    }
    // 油猴脚本跨域抓正文：GM_xmlhttpRequest（@connect * 已声明）优先，失败回退 native fetch
    var html = "";
    try {
      html = await fetchChapterViaGM(source_url);
    } catch (e) {
      try {
        var r = await fetchWithRetry(source_url, { credentials: "include" }, 2, 15000);
        html = await r.text();
      } catch (e2) {
        throw e2;
      }
    }
    if (site === "biquge") {
      // 笔趣阁 biquga 正文是 document.writeln(qsbs.bb('BASE64'))，先解码再提正文
      var decoded = window.JLBatchParser.decodeBiqugeBase64(html);
      if (decoded) html = decoded;
    }
    var text = window.JLBatchParser.extractChapterText(html, site);
    if (site === "fanqie") text = decodeFanqieText(text);
    // JS 动态渲染站点（七猫/番茄等）：raw HTML 拿不到正文（<300 字），同域改走 iframe 让浏览器渲染后再提
    if (!text || text.length < 300) {
      return fetchChapterViaIframe(source_url, site);
    }
    return { text: text, paywall: window.JLBatchParser.isPaywall(html) };
  }

  function fetchChapterViaIframe(source_url, site) {
    site = site || "qidian";
    return new Promise(function (resolve) {
      var iframe = document.createElement("iframe");
      iframe.style.cssText = "position:absolute;left:-9999px;width:900px;height:900px;";
      iframe.src = source_url;
      document.body.appendChild(iframe);
      var finished = false;
      var deadline = Date.now() + 12000;
      function done(text, paywall) {
        if (finished) return;
        finished = true;
        try { iframe.remove(); } catch (_) {}
        resolve({ text: text || "", paywall: !!paywall });
      }
      // JS 动态渲染站点（七猫/番茄等）正文经 XHR 异步注入，需轮询等正文渲染完成再提取
      function read() {
        try {
          var doc = iframe.contentDocument;
          if (!doc) { done("", false); return; }
          var bt = (doc.body && doc.body.innerText) || "";
          if (bt.length >= 300 || Date.now() >= deadline) {
            var html = doc.documentElement.outerHTML;
            var text = window.JLBatchParser.extractChapterText(html, site);
            done(text, window.JLBatchParser.isPaywall(html));
            return;
          }
          setTimeout(read, 400);
        } catch (_) { done("", false); }
      }
      iframe.addEventListener("load", function () { read(); });
      setTimeout(function () { done("", false); }, 16000);
    });
  }

  // 章节正文跨域抓取：用 GM_xmlhttpRequest 带 cookie 拉取（可跨任意站点）
  function fetchChapterViaGM(source_url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== "function") { reject(new Error("GM_xmlhttpRequest 不可用")); return; }
      GM_xmlhttpRequest({
        url: source_url,
        method: "GET",
        headers: { "Referer": location.href },
        timeout: 30000,
        onload: function (resp) {
          if (resp.status >= 200 && resp.status < 300 && resp.responseText) {
            resolve(resp.responseText);
          } else {
            reject(new Error("抓取章节失败 HTTP " + resp.status));
          }
        },
        onerror: function () { reject(new Error("抓取章节失败")); },
        ontimeout: function () { reject(new Error("抓取章节超时")); }
      });
    });
  }

  var __jlBatchPaused = false;

  // ── 批量结果聚合：把多章结果合并成一份「全书总览」（复用主窗口渲染管线）──
  var _batchMerged = { summaries: [], characters: {}, clues: {}, terms: {}, nodes: {}, edges: {} };

  function resetBatchMerge() {
    _batchMerged = { summaries: [], characters: {}, clues: {}, terms: {}, nodes: {}, edges: {} };
    var prog = document.getElementById("jl-batch-progress");
    if (prog) prog.remove();
    var chapters = document.getElementById("jl-batch-chapters");
    if (chapters) chapters.remove();
  }

  function mergeBatchAnalysis(title, analysis, index, sortIndex) {
    if (!analysis) return;
    if (analysis.summary) _batchMerged.summaries.push({ title: title || "", index: index, sort_index: sortIndex, summary: analysis.summary });

    (analysis.characters || []).forEach(function (c) {
      var name = (c.name || c.label || "").trim();
      if (!name) return;
      if (!_batchMerged.characters[name]) _batchMerged.characters[name] = [];
      var note = c.note || c.role || "";
      if (note && _batchMerged.characters[name].indexOf(note) === -1) _batchMerged.characters[name].push(note);
    });

    (analysis.foreshadowing || []).forEach(function (f) {
      var clue = (f.clue || f.text || "").trim();
      if (!clue) return;
      if (!_batchMerged.clues[clue]) _batchMerged.clues[clue] = [];
      var reason = f.reason || "";
      if (reason && _batchMerged.clues[clue].indexOf(reason) === -1) _batchMerged.clues[clue].push(reason);
    });

    (analysis.terms || []).forEach(function (t) {
      var term = (t.term || t.name || "").trim();
      if (!term) return;
      var meaning = t.meaning || t.note || "";
      if (meaning) _batchMerged.terms[term] = meaning;
    });

    var g = analysis.graph || { nodes: [], edges: [] };
    var idToLabel = {};
    (g.nodes || []).forEach(function (n) {
      var label = String(n.label || n.name || n.id || "").trim();
      if (!label) return;
      idToLabel[n.id] = label;
      if (!_batchMerged.nodes[label]) _batchMerged.nodes[label] = { level: n.level || "normal", count: 0 };
      _batchMerged.nodes[label].count++;
      if (n.level === "core") _batchMerged.nodes[label].level = "core";
    });
    (g.edges || []).forEach(function (e) {
      var from = idToLabel[e.from] || e.from;
      var to = idToLabel[e.to] || e.to;
      if (!from || !to) return;
      var key = from + "" + to + "" + (e.label || "");
      if (!_batchMerged.edges[key]) _batchMerged.edges[key] = { from: from, to: to, label: e.label || "" };
    });
  }

  function mergedToResult() {
    var charNames = Object.keys(_batchMerged.characters);
    var clueKeys = Object.keys(_batchMerged.clues);
    var termKeys = Object.keys(_batchMerged.terms);
    var chapterCount = _batchMerged.summaries.length;

    var overview = "📖 全书批量分析完成：共 " + chapterCount + " 章，涉及人物 " + charNames.length +
      " 位、疑似伏笔 " + clueKeys.length + " 条、名词 " + termKeys.length +
      " 个。切换上方「伏笔」「关系图」标签查看全书累计线索与人物网络。";

    var characters = charNames.map(function (n) {
      return { name: n, note: _batchMerged.characters[n][0] || "" };
    });
    var foreshadowing = clueKeys.map(function (k) {
      return { clue: k, reason: _batchMerged.clues[k][0] || "" };
    });
    var terms = termKeys.map(function (t) {
      return { term: t, meaning: _batchMerged.terms[t] || "" };
    });

    var nodeLabels = Object.keys(_batchMerged.nodes);
    if (!nodeLabels.length) nodeLabels = Object.keys(_batchMerged.characters);
    var nodes = nodeLabels.map(function (label, i) {
      var n = _batchMerged.nodes[label] || { level: "normal" };
      return { id: "b" + i, label: label, level: n.level };
    });
    var labelToId = {};
    nodes.forEach(function (n) { labelToId[n.label] = n.id; });
    var edges = Object.keys(_batchMerged.edges).map(function (k) {
      var e = _batchMerged.edges[k];
      var f = labelToId[e.from], t = labelToId[e.to];
      if (!f || !t) return null;
      return { from: f, to: t, label: e.label };
    }).filter(Boolean);

    return {
      summary: overview,
      characters: characters,
      foreshadowing: foreshadowing,
      terms: terms,
      graph: { nodes: nodes, edges: edges },
      raw: ""
    };
  }

  // 注入各章摘要卡片样式（幂等）
  function ensureBatchRenderStyle() {
    if (document.getElementById("jl-batch-render-style")) return;
    var st = document.createElement("style");
    st.id = "jl-batch-render-style";
    st.textContent =
      "#jl-batch-chapters .jl-bc-item{padding:15px 16px;margin-bottom:10px;border:1px solid #E8DDD2;border-radius:10px;background:#FFFDF7;box-shadow:0 1px 3px rgba(44,36,22,.03);transition:box-shadow .18s,border-color .18s}" +
      "#jl-batch-chapters .jl-bc-item:last-child{margin-bottom:0}" +
      "#jl-batch-chapters .jl-bc-item:hover{border-color:#D7CCC8;box-shadow:0 2px 8px rgba(44,36,22,.06)}" +
      "#jl-batch-chapters .jl-bc-head{display:flex;align-items:center;gap:10px;margin-bottom:9px;padding-bottom:8px;border-bottom:1px dashed #EDE3D8}" +
      "#jl-batch-chapters .jl-bc-idx{flex:0 0 auto;padding:3px 11px;border-radius:999px;background:linear-gradient(135deg,#E65100,#F57C00);color:#fff;font-size:12px;font-weight:700;letter-spacing:.3px;box-shadow:0 1px 3px rgba(230,81,0,.22)}" +
      "#jl-batch-chapters .jl-bc-title{flex:1;min-width:0;font-size:15px;font-weight:700;color:#3E2723;line-height:1.4}" +
      "#jl-batch-chapters .jl-bc-body{font-size:13px;line-height:1.8;color:#4E3E33;white-space:pre-wrap;word-break:break-word}";
    document.documentElement.appendChild(st);
  }

  function renderBatchChapterList() {
    var panel = document.getElementById("jl-panel-summary");
    if (!panel) return;
    var old = document.getElementById("jl-batch-chapters");
    if (old) old.remove();
    if (!_batchMerged.summaries.length) return;

    ensureBatchRenderStyle();

    var card = document.createElement("div");
    card.id = "jl-batch-chapters";
    card.className = "jl-card";
    var html = '<h3>📖 各章摘要 <span style="font-weight:400;font-size:12px;color:#A1887F">共 ' +
      _batchMerged.summaries.length + ' 章</span></h3>';
    var sortedSummaries = _batchMerged.summaries.slice().sort(function (a, b) {
      var ai = (typeof a.sort_index === "number") ? a.sort_index : ((typeof a.index === "number") ? a.index : null);
      var bi = (typeof b.sort_index === "number") ? b.sort_index : ((typeof b.index === "number") ? b.index : null);
      if (ai == null && bi == null) return 0;
      if (ai == null) return 1;
      if (bi == null) return -1;
      return ai - bi;
    });
    sortedSummaries.forEach(function (s) {
      var idx = (typeof s.index === "number") ? ('<span class="jl-bc-idx">第 ' + s.index + ' 章</span>') : "";
      html +=
        '<div class="jl-bc-item">' +
          '<div class="jl-bc-head">' + idx + '<span class="jl-bc-title">' + escHtml(s.title) + '</span></div>' +
          '<div class="jl-bc-body">' + escHtml(s.summary) + '</div>' +
        '</div>';
    });
    card.innerHTML = html;
    var summaryCard = panel.querySelector(".jl-card");
    if (summaryCard && summaryCard.nextSibling) {
      panel.insertBefore(card, summaryCard.nextSibling);
    } else {
      panel.appendChild(card);
    }
  }

  function renderBatchSkipNote(analyzedCount, skippedAlready, skippedPaywall, skippedFetch, skippedError, failedChapters) {
    var panel = document.getElementById("jl-panel-summary");
    if (!panel) return;
    var old = document.getElementById("jl-batch-skip-note");
    if (old) old.remove();

    var skippedTotal = skippedAlready + skippedPaywall + skippedFetch + skippedError;
    if (skippedTotal === 0) return;

    var parts = [];
    if (analyzedCount > 0) parts.push("✅ 成功分析 " + analyzedCount + " 章");
    if (skippedAlready > 0) parts.push("⏭ 已分析过（不重复扣额度）" + skippedAlready + " 章");
    if (skippedPaywall > 0) parts.push("🔒 付费章节跳过 " + skippedPaywall + " 章");
    if (skippedFetch > 0) parts.push("⚠️ 正文抓取失败 " + skippedFetch + " 章");
    if (skippedError > 0) {
      parts.push("❌ 分析失败 " + skippedError + " 章");
      (failedChapters || []).forEach(function (t) { parts.push("　· " + escHtml(t)); });
    }

    var note = document.createElement("div");
    note.id = "jl-batch-skip-note";
    note.className = "jl-card";
    note.style.borderLeft = "4px solid #FFB300";
    note.style.background = "#FFFDF5";
    note.innerHTML =
      '<h3 style="margin:0 0 8px;color:#8D6E63">📋 本次批量小结</h3>' +
      '<div style="font-size:13px;line-height:1.9;color:#5D4037">' +
        parts.map(function (p) { return '<div style="padding:1px 0">' + p + '</div>'; }).join("") +
      '</div>';
    var first = panel.querySelector(".jl-card");
    if (first) first.insertAdjacentElement("afterend", note);
    else panel.appendChild(note);
  }

  // 进度 UI：写入概况面板（主窗口内），不另开浮层
  function batchProgressUI(done, total, text) {
    var panel = document.getElementById("jl-panel-summary");
    if (!panel) return;
    var box = document.getElementById("jl-batch-progress");
    if (!box) {
      box = document.createElement("div");
      box.id = "jl-batch-progress";
      box.className = "jl-card";
      box.style.borderLeft = "3px solid #E65100";
      panel.insertBefore(box, panel.firstChild);
    }
    var pct = total ? Math.round((done / total) * 100) : 0;
    box.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
        '<h3 style="margin:0;color:#E65100">📚 批量分析进行中</h3>' +
        '<span style="font-size:12px;font-weight:700;color:#fff;background:linear-gradient(135deg,#E65100,#F57C00);padding:2px 11px;border-radius:999px;box-shadow:0 1px 3px rgba(230,81,0,.25)">' + pct + '%</span>' +
      '</div>' +
      '<div style="height:12px;background:#F0E8DE;border-radius:999px;overflow:hidden">' +
        '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#E65100,#F57C00);border-radius:999px;transition:width .3s;box-shadow:0 0 8px rgba(230,81,0,.35)"></div></div>' +
      '<p style="font-size:12px;color:#5D4037;margin:10px 0 0">' + escHtml(text || (done + " / " + total + " 章")) + '</p>';
  }

  async function runBatchJob(jobData) {
    var jobId = jobData.job_id || jobData.id;
    var total = jobData.total || 0;

    createWindow();
    var heading = document.getElementById("jl-heading");
    if (heading) heading.textContent = getBookTitle() || "批量分析";
    document.querySelectorAll(".jl-tab").forEach(function (t) {
      t.classList.toggle("is-active", t.dataset.panel === "summary");
    });
    document.querySelectorAll(".jl-panel").forEach(function (p) {
      p.classList.toggle("is-active", p.id === "jl-panel-summary");
    });
    resetBatchMerge();
    batchProgressUI(0, total, "准备中…");

    var API = await getAPI();
    var token = await getToken();
    var jobResp = await fetchWithRetry(API + "/api/analyze/batch/" + jobId, {
      headers: { "Authorization": "Bearer " + token },
    }, 2);
    var jobBody = await jobResp.json();
    var items = (jobBody.data && jobBody.data.items) || [];
    var jobInfo = (jobBody.data && jobBody.data.job) || {};
    if (jobInfo.book_id) {
      _currentBookId = jobInfo.book_id;
      _currentBookTitle = jobInfo.book_title || getBookTitle() || "当前书籍";
      var btag = document.getElementById("jl-book-tag");
      if (btag) btag.textContent = "当前：" + _currentBookTitle;
      updateQABookTag();
    }
    if (!total) total = items.length;
    var pending = items.filter(function (i) { return i.status === "pending" || i.status === "failed"; });
    var done = total - pending.length;
    var skippedAlready = items.filter(function (i) { return i.status === "skipped"; }).length;
    var skippedPaywall = 0, skippedFetch = 0, skippedError = 0, analyzedCount = 0;
    var failedChapters = [];
    batchProgressUI(done, total);

    function skipItem(item) {
      return fetchWithRetry(API + "/api/analyze/batch/" + jobId + "/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ item_id: item.id }),
      }, 2).then(function (r) { return r.json(); });
    }
    function submitItem(item, text) {
      return fetchWithRetry(API + "/api/analyze/batch/" + jobId + "/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ item_id: item.id, text: text }),
      }, 2).then(function (r) { return r.json(); });
    }

    var FETCH_POOL = 4;
    var fetched = new Array(pending.length);
    var fi = 0;
    var fetchWorkers = [];
    for (var w = 0; w < Math.min(FETCH_POOL, pending.length); w++) {
      fetchWorkers.push((async function () {
        while (true) {
          if (__jlBatchPaused) return;
          var idx = fi++;
          if (idx >= pending.length) return;
          var item = pending[idx];
          try {
            var f = await fetchChapterText(item.source_url);
            fetched[idx] = { item: item, text: (f && f.text) || "", paywall: !!(f && f.paywall) };
          } catch (e) {
            fetched[idx] = { item: item, text: "", paywall: false, error: true };
          }
        }
      })());
    }
    await Promise.all(fetchWorkers);

    var SUBMIT_POOL = 2;
    var si = 0;
    var submitWorkers = [];
    for (var w2 = 0; w2 < Math.min(SUBMIT_POOL, pending.length); w2++) {
      submitWorkers.push((async function () {
        while (true) {
          if (__jlBatchPaused) return;
          var idx = si++;
          if (idx >= pending.length) return;
          var f = fetched[idx];
          var item = f.item;
          if (f.error) {
            skippedFetch++;
            batchProgressUI(done, total, "抓取失败：" + item.chapter_title);
            continue;
          }
          // 有正文（>=300 字）就分析——isPaywall 是启发式，可能误判站点 chrome 的「畅读/会员」等字样，无正文时才信它
          var hasText = !!(f.text && f.text.length >= 300);
          if (!hasText && f.paywall) {
            var sb = await skipItem(item);
            if (sb && sb.success) {
              skippedPaywall++;
              done++;
              batchProgressUI(done, total, "已跳过付费章节：" + item.chapter_title);
            } else {
              batchProgressUI(done, total, "跳过失败：" + item.chapter_title);
            }
            continue;
          }
          if (!hasText) {
            skippedFetch++;
            batchProgressUI(done, total, "抓取失败：" + item.chapter_title);
            continue;
          }
          var body = await submitItem(item, f.text);
          if (!(body && body.success)) {
            var err = (body && body.error) || "";
            if (/额度不足/.test(err)) {
              batchProgressUI(done, total, "额度不足，任务已暂停，攒够后点「📚 批量分析」续跑");
              __jlBatchPaused = true;
              return;
            }
            if (/请求太频繁/.test(err)) {
              await new Promise(function (res) { setTimeout(res, 3000); });
              body = await submitItem(item, f.text);
            }
          }
          if (body && body.success) {
            done++;
            analyzedCount++;
            mergeBatchAnalysis(item.chapter_title, body.data && body.data.result && body.data.result.result, item.chapter_index, item.sort_index);
            batchProgressUI(done, total, "已分析 " + done + " / " + total + " 章");
          } else {
            skippedError++;
            done++;
            var failMsg = (body && body.error) || "";
            failedChapters.push(item.chapter_title + (failMsg ? "：" + failMsg : ""));
            batchProgressUI(done, total, "分析失败：" + item.chapter_title + (failMsg ? "（" + failMsg + "）" : ""));
          }
        }
      })());
    }
    await Promise.all(submitWorkers);

    __jlBatchPaused = false;
    var prog = document.getElementById("jl-batch-progress");
    if (prog) prog.remove();
    // 复用单章渲染管线：概况/伏笔/关系图都展示全书合并结果
    var mergedResult = mergedToResult();
    _batchGraph = mergedResult.graph;
    _graphMode = "batch";  // 关系图标签默认展示本次批量合并图，避免被「当前章节」覆盖
    renderResult(mergedResult);
    renderBatchChapterList();
    renderBatchSkipNote(analyzedCount, skippedAlready, skippedPaywall, skippedFetch, skippedError, failedChapters);
    // 建立书籍上下文后刷新「历史分析」列表，批量分析过的章节即可在下拉/历史里看到
    loadAnalysisHistory();
  }


})();
