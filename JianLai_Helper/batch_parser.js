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
    // 排除站点级静态/SEO 详情页（如 /book/7599.html、/list/12.html）：它们以「单段/数字.html」结尾却不是章节。
    // 真正的笔趣阁章节是 {目录}/{章节id}.html 两段式（如 /9_9181/123456.html），起点章节是 /book/{书id}/{章id}.html。
    if (/^\/(?:book|info|novel|list|search|author|tag|sort|top|full|quanben|wanben|new|rank|bang|tuijian|fenlei)\/\d+\.html?\/?$/i.test(href)) return false;
    // 纵横/起点打赏榜（粉丝榜）用户名链接 /show/userInfo/{id}.html：不是章节，却以「/数字.html」结尾被误判
    if (/\/userInfo\/\d+\.html?\/?$/i.test(href)) return false;
    // 起点新版章节链接是随机串（如 /chapter/SaT8js…/oQbX6Y…），不是数字，需单独匹配
    return /\/chapter\/\d+\/\d+/i.test(href)
      || /\/chapter\/[A-Za-z0-9_-]{10,}\/[A-Za-z0-9_-]{10,}/i.test(href)
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
    // 起点 /chapter/{book}/{chap}/ 末尾章节 id（单调递增，可作排序键）
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

  // QQ阅读正文在 window.__NUXT__ 的 currentContent 里（Nuxt SSR）。抽取一次，供正文提取与锁章判定共用。
  function getQQContent(html) {
    if (!html) return null;
    var nuxtM = html.match(/window\.__NUXT__\s*=\s*([\s\S]*?);?\s*<\/script>/i);
    if (!nuxtM) return null;
    try {
      var val = (new Function("return (" + nuxtM[1] + ")"))();
      if (typeof val === "function") val = val();
      var d = val && val.data;
      var block = Array.isArray(d) ? d[0] : d;
      return (block && block.currentContent) || null;
    } catch (_) { return null; }
  }

  // QQ阅读锁定章节判定（currentContent 对象）：加密/字体混淆正文、未解锁(authStatus=0)、或正文仅预览片段(长度远小于总字数)
  function isQqbookCcLocked(cc) {
    if (!cc) return false;
    if (cc.encrypt || cc.fontEncrypt) return true;
    if (cc.authStatus === 0) return true;
    var content = cc.content || "";
    return !!(cc.totalWords > 200 && content.length < cc.totalWords * 0.5);
  }

  function isQQBookLocked(html) {
    return isQqbookCcLocked(getQQContent(html));
  }

  function extractChapterText(html, site) {
    if (site === "qqbook") {
      var cc = getQQContent(html);
      if (!cc || isQqbookCcLocked(cc)) return "";
      var qdoc = parseHtml(cc.content || "");
      var qtext = (qdoc.body && (qdoc.body.innerText || qdoc.body.textContent)) || "";
      return qtext.split("\n").map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 3; }).join("\n");
    }
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
      // 回退只在找到更多正文时生效，避免用更严阈值把已有结果清空
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

  globalThis.JLBatchParser = {
    parseHtml: parseHtml,
    parseCatalog: parseCatalog,
    selectLatest: selectLatest,
    extractChapterText: extractChapterText,
    decodeBiqugeBase64: decodeBiqugeBase64,
    extractIndex: extractIndex,
    cnToInt: cnToInt,
    cleanTitle: cleanTitle,
    isChapterTitle: isChapterTitle,
    looksLikeChapterHref: looksLikeChapterHref,
    isNavLabel: isNavLabel,
    chapterId: chapterId,
    catalogSortKey: catalogSortKey,
    isPaywall: isPaywall,
    isQQBookLocked: isQQBookLocked,
    isQqbookCcLocked: isQqbookCcLocked,
    getQQContent: getQQContent,
    biqugeCatalogEntryHref: biqugeCatalogEntryHref,
    biqugeCatalogPageCount: biqugeCatalogPageCount,
    readTzContext: readTzContext,
    biqugeBookId: biqugeBookId,
  };
})();
