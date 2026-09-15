// 目录解析 + 章节正文提取（纯函数，浏览器与测试环境通用）
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
    return /\/(\d{3,})(\.html?)?\/?$/i.test(href) || /[?&](?:id|chapterId)=(\d{4,})/i.test(href);
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
    var m = title.match(/第\s*([0-9一二三四五六七八九十百千万零]+)\s*[章节卷回]/);
    if (m) return cnToInt(m[1]);
    var m2 = href.match(/[?&](?:id|chapterId)=(\d+)/i);
    if (m2) return parseInt(m2[1], 10);
    var m3 = href.match(/\/(\d{4,})\.html?/i);
    if (m3) return parseInt(m3[1], 10);
    return null;
  }

  function absoluteUrl(doc, href) {
    var base = doc.querySelector("base[href]");
    var baseHref = base ? base.getAttribute("href") : doc.baseURI;
    try { return new URL(href, baseHref || "http://x/").href; } catch (_) { return null; }
  }

  function parseCatalog(html, site) {
    var doc = parseHtml(html);
    var anchors = Array.from(doc.querySelectorAll("a[href]"));
    var seen = new Set();
    var out = [];
    anchors.forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href) return;
      var title = cleanTitle(a.textContent || a.getAttribute("title"));
      if (!title || title.length < 1 || title.length > 120) return;
      if (!isChapterTitle(title)) return;
      var abs = absoluteUrl(doc, href);
      if (!abs) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push({ chapter_title: title, chapter_index: extractIndex(title, href), source_url: abs });
    });
    return out;
  }

  function extractChapterText(html, site) {
    var doc = parseHtml(html);
    var selectors = [
      "#content", "#chaptercontent", "#ChapterContent", "#txt",
      ".read-content", ".main-text-wrap", ".chapter-content",
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
      // 回退只在找到更多正文时生效，避免用更严阈值把已有结果清空
      if (alt.length > best.length) best = alt;
    }
    return best;
  }

  globalThis.JLBatchParser = {
    parseHtml: parseHtml,
    parseCatalog: parseCatalog,
    extractChapterText: extractChapterText,
    extractIndex: extractIndex,
    cnToInt: cnToInt,
    cleanTitle: cleanTitle,
    isChapterTitle: isChapterTitle,
    looksLikeChapterHref: looksLikeChapterHref,
  };
})();
