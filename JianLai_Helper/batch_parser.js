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
    return /\/chapter\/\d+\/\d+/i.test(href)
      || /\/(\d{3,})\.html?\/?$/i.test(href)
      || /[?&](?:id|chapterId|item_id)=(\d{4,})/i.test(href);
  }

  // 付费/会员章节的锁定页特征（正文抓取为空时再结合判定，避免误跳可读章节）
  function isPaywall(html) {
    if (!html) return false;
    return /(本章为付费|付费章节|付费内容|会员专享|订阅后|订阅本章|订阅解锁|请先订阅|开通VIP|开通会员|购买本章|VIP章节|VIP用户|剩余章节|需付费|充值阅读|阅读券|阅币)/i.test(html);
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
    // 起点 /chapter/{book}/{chap}/ 末尾章节 id（单调递增，可作排序键）
    var m4 = href.match(/\/chapter\/\d+\/(\d+)/i);
    if (m4) return parseInt(m4[1], 10);
    return null;
  }

  function absoluteUrl(doc, href) {
    var base = doc.querySelector("base[href]");
    var baseHref = base ? base.getAttribute("href") : doc.baseURI;
    try { return new URL(href, baseHref || "http://x/").href; } catch (_) { return null; }
  }

  // 导航/操作类链接标题（起点目录页常混入「旧版/下一章/上一章」等跳转链接，其 href 与真实章节相同）
  function isNavLabel(t) {
    return /^(旧版|新版|下一章|上一章|下一节|上一节|下一页|上一页|目录|章节目录|章节列表|返回目录|返回书页|立即阅读|开始阅读|免费试读|试读|全文阅读|阅读全文|加入书架|书架|点击阅读|展开全部|收起)$/.test(t || "");
  }

  // 起点章节唯一 ID：/chapter/{book}/{cid}/ 中的 cid（read.qidian.com / www.qidian.com / 尾斜杠 视为同一章）
  function chapterId(href) {
    var m = (href || "").match(/\/chapter\/\d+\/(\d+)\/?/i);
    return m ? m[1] : null;
  }

  function parseCatalog(html, site) {
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
      var abs = absoluteUrl(doc, href);
      if (!abs) return;
      var cid = chapterId(href) || chapterId(abs);
      var key = cid ? ("cid:" + cid) : ("url:" + abs);
      var entry = { chapter_title: title, chapter_index: extractIndex(title, href), source_url: abs };
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
    return out;
  }

  // 取「最新 N 章」：全为数字序号时升序排序再取末尾（兼容目录倒序站点）；
  // 任一序号缺失则信任 DOM 顺序（默认目录按阅读顺序正序排列）。
  function selectLatest(list, n) {
    if (!list || !list.length) return [];
    var arr = list.slice();
    var allNumeric = arr.every(function (c) { return typeof c.chapter_index === "number"; });
    if (allNumeric && arr.length > 1) {
      arr.sort(function (a, b) { return a.chapter_index - b.chapter_index; });
    }
    var count = Math.max(1, Math.min(n || 1, arr.length));
    return arr.slice(arr.length - count);
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
    selectLatest: selectLatest,
    extractChapterText: extractChapterText,
    extractIndex: extractIndex,
    cnToInt: cnToInt,
    cleanTitle: cleanTitle,
    isChapterTitle: isChapterTitle,
    looksLikeChapterHref: looksLikeChapterHref,
    isNavLabel: isNavLabel,
    chapterId: chapterId,
    isPaywall: isPaywall,
  };
})();
