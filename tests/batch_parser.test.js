import { describe, it, expect } from "vitest";
import "../JianLai_Helper/batch_parser.js";

const P = globalThis.JLBatchParser;

describe("cnToInt", () => {
  it("parses arabic and chinese numerals", () => {
    expect(P.cnToInt("12")).toBe(12);
    expect(P.cnToInt("一百二十三")).toBe(123);
    expect(P.cnToInt("六十五")).toBe(65);
  });
});

describe("extractIndex", () => {
  it("extracts from title", () => {
    expect(P.extractIndex("第65章 大结局", "/12345.html")).toBe(65);
    expect(P.extractIndex("第二部第二章 为君饮", "/x.html")).toBe(2);
  });
  it("falls back to href", () => {
    expect(P.extractIndex("某章", "/88888.html")).toBe(88888);
  });
});

describe("extractIndex 番外排除", () => {
  it("returns null for 番外/外传/后记/尾声 so they don't collide with main chapters", () => {
    expect(P.extractIndex("番外 第一章", "/book/1/101.html")).toBe(null);
    expect(P.extractIndex("外传 第二章", "/book/1/102.html")).toBe(null);
    expect(P.extractIndex("后记", "/book/1/103.html")).toBe(null);
    expect(P.extractIndex("尾声 感言", "/book/1/104.html")).toBe(null);
  });
  it("still extracts normal chapter numbers", () => {
    expect(P.extractIndex("第一章 开端", "/book/1/101.html")).toBe(1);
  });
});

describe("parseCatalog 番外与正文不混排", () => {
  it("番外 chapter_index/sort_index 为 null，保留 DOM 阅读顺序", () => {
    const html = `
      <html><body>
        <a href="/book/1/101.html">第一章 开端</a>
        <a href="/book/1/102.html">第二章 转折</a>
        <a href="/book/1/201.html">番外 第一章</a>
        <a href="/book/1/202.html">番外 第二章</a>
      </body></html>`;
    const list = P.parseCatalog(html, "biquge");
    expect(list.map((c) => c.chapter_title)).toEqual([
      "第一章 开端",
      "第二章 转折",
      "番外 第一章",
      "番外 第二章",
    ]);
    expect(list[2].chapter_index).toBe(null);
    expect(list[2].sort_index).toBe(null);
    expect(list[3].chapter_index).toBe(null);
    expect(list[3].sort_index).toBe(null);
  });
});

describe("parseCatalog", () => {
  it("extracts unique chapter list", () => {
    const html = `
      <html><body>
        <a href="/book/1/101.html">第一章 开端</a>
        <a href="/book/1/102.html">第二章 转折</a>
        <a href="/book/1/101.html">第一章 开端</a>
      </body></html>`;
    const list = P.parseCatalog(html, "biquge");
    expect(list).toHaveLength(2);
    expect(list[0].chapter_index).toBe(1);
    expect(list[1].chapter_title).toBe("第二章 转折");
  });

  it("keeps qidian volume chapters in reading order via monotonic cid", () => {
    const html = `
      <html><body>
        <a href="/chapter/1049996017/100/">第一章 觉醒</a>
        <a href="/chapter/1049996017/101/">第二章 入门</a>
        <a href="/chapter/1049996017/200/">第一章 重逢</a>
        <a href="/chapter/1049996017/201/">第二章 决战</a>
      </body></html>`;
    const list = P.parseCatalog(html, "qidian");
    expect(list).toHaveLength(4);
    // 展示用的章节号仍取标题「第X章」（每卷从第一章重排）
    expect(list.map((c) => c.chapter_index)).toEqual([1, 2, 1, 2]);
    // 排序键用 cid（唯一递增），保证阅读顺序
    expect(list.map((c) => c.sort_index)).toEqual([100, 101, 200, 201]);
    const latest = P.selectLatest(list, 4);
    expect(latest.map((c) => c.chapter_title)).toEqual([
      "第一章 觉醒",
      "第二章 入门",
      "第一章 重逢",
      "第二章 决战",
    ]);
  });
});

describe("extractChapterText", () => {
  it("extracts from #content", () => {
    const html = `<html><body><div id="content"><p>第一段正文内容</p><p>第二段正文内容</p></div></body></html>`;
    const text = P.extractChapterText(html, "biquge");
    expect(text).toContain("第一段正文内容");
    expect(text).toContain("第二段正文内容");
  });
});

describe("isChapterTitle", () => {
  it("recognizes chapter titles and rejects nav junk", () => {
    expect(P.isChapterTitle("第一章 开端")).toBe(true);
    expect(P.isChapterTitle("第1234章 大结局")).toBe(true);
    expect(P.isChapterTitle("第五回 风云变")).toBe(true);
    expect(P.isChapterTitle("首页")).toBe(false);
    expect(P.isChapterTitle("登录")).toBe(false);
    expect(P.isChapterTitle("")).toBe(false);
  });
});

describe("looksLikeChapterHref", () => {
  it("matches qidian chapter urls with trailing slash", () => {
    expect(P.looksLikeChapterHref("//www.qidian.com/chapter/1049996017/915654463/")).toBe(true);
    expect(P.looksLikeChapterHref("/chapter/1049996017/915654463/")).toBe(true);
  });
  it("matches 3-digit html urls and rejects bare numeric/book urls", () => {
    expect(P.looksLikeChapterHref("/book/1/101.html")).toBe(true);
    expect(P.looksLikeChapterHref("/12345/")).toBe(false);
    expect(P.looksLikeChapterHref("/book/1049996017/")).toBe(false);
  });
});

describe("parseCatalog filters non-chapter links", () => {
  it("drops nav junk and keeps qidian chapters", () => {
    const html = `
      <html><body>
        <a href="https://www.qidian.com/">首页</a>
        <a href="https://www.qidian.com/login">登录</a>
        <a href="https://www.qidian.com/book/1049996017/">某书名</a>
        <a href="https://www.qidian.com/chapter/1049996017/915654463/">第一章 开端</a>
        <a href="https://www.qidian.com/chapter/1049996017/915654464/">第二章 转折</a>
      </body></html>`;
    const list = P.parseCatalog(html, "qidian");
    expect(list).toHaveLength(2);
    expect(list[0].chapter_title).toBe("第一章 开端");
    expect(list[0].source_url).toContain("915654463");
  });
});

describe("parseCatalog qidian nav-link collision", () => {
  it("keeps 第一章/第二章 despite nav links sharing their URLs", () => {
    // 起点目录页真实 DOM：导航链接「旧版/下一章」的 href 与真实章节相同，
    // 旧版去重逻辑按完整 URL 去重会把真实章节当作重复项丢弃 → 第一章/第二章缺失
    const html = `
      <html><body>
        <a href="https://read.qidian.com/chapter/1050032171/916642635">旧版</a>
        <a href="//www.qidian.com/chapter/1050032171/917568467/">下一章</a>
        <a href="//www.qidian.com/chapter/1050032171/916642635/">第一章 仙府</a>
        <a href="//www.qidian.com/chapter/1050032171/917568467/">第二章 异界</a>
        <a href="//www.qidian.com/chapter/1050032171/917568468/">第三章 觉醒</a>
      </body></html>`;
    const list = P.parseCatalog(html, "qidian");
    const titles = list.map((c) => c.chapter_title);
    // 导航标签「旧版/下一章」应被剔除；第一章/第二章不能被当作重复项丢弃
    expect(titles).toEqual(["第一章 仙府", "第二章 异界", "第三章 觉醒"]);
    expect(list[0].chapter_index).toBe(1);
    expect(list[1].chapter_index).toBe(2);
  });

  it("chapterId treats read.qidian.com / www.qidian.com / trailing slash as one chapter", () => {
    expect(P.chapterId("/chapter/1050032171/916642635/")).toBe("916642635");
    expect(P.chapterId("https://read.qidian.com/chapter/1050032171/916642635")).toBe("916642635");
    expect(P.chapterId("https://www.qidian.com/chapter/1050032171/916642635")).toBe("916642635");
    expect(P.chapterId("/book/1/101.html")).toBe(null);
  });

  it("isNavLabel blocks catalog nav labels", () => {
    expect(P.isNavLabel("旧版")).toBe(true);
    expect(P.isNavLabel("下一章")).toBe(true);
    expect(P.isNavLabel("上一章")).toBe(true);
    expect(P.isNavLabel("第一章 仙府")).toBe(false);
  });
});

describe("zongheng catalog parsing", () => {
  it("isNavLabel blocks 立即阅读/继续阅读 action buttons", () => {
    expect(P.isNavLabel("立即阅读")).toBe(true);
    expect(P.isNavLabel("继续阅读")).toBe(true);
    expect(P.isNavLabel("第1章 仙门")).toBe(false);
  });

  it("chapterId parses read.zongheng.com /chapter/{book}/{cid}.html", () => {
    expect(P.chapterId("//read.zongheng.com/chapter/1552353/94413899.html")).toBe("94413899");
    expect(P.chapterId("/chapter/1552353/94413899.html")).toBe("94413899");
  });

  it("sorts by monotonic cid even when chapter numbers restart per volume", () => {
    // 纵横目录分卷后「第X章」每卷重排，两个「第1章」标题号相同，但 cid 单调递增；
    // 应按 cid 排序，而不是把标题号相同的章节挤到一起。
    const html = `
      <html><body>
        <a href="//read.zongheng.com/chapter/1552353/110571591.html">第1章 丹药</a>
        <a href="//read.zongheng.com/chapter/1552353/94413899.html">第1章 仙门</a>
        <a href="//read.zongheng.com/chapter/1552353/94413906.html">第2章 考核</a>
      </body></html>`;
    const list = P.parseCatalog(html, "zongheng");
    const sorted = list.slice().sort((a, b) => P.catalogSortKey(a) - P.catalogSortKey(b));
    expect(sorted.map((c) => c.chapter_title)).toEqual(["第1章 仙门", "第2章 考核", "第1章 丹药"]);
    expect(sorted[2].sort_index).toBe(110571591);
  });
});

describe("extractIndex qidian chapter-id fallback", () => {
  it("parses /chapter/{book}/{chap}/ href as index when title has no number", () => {
    expect(P.extractIndex("某章标题", "https://www.qidian.com/chapter/1049996017/915654463/")).toBe(915654463);
    expect(P.extractIndex("序章", "/chapter/1049996017/915654463/")).toBe(915654463);
  });
  it("title number still wins over href", () => {
    expect(P.extractIndex("第65章 大结局", "/chapter/1049996017/915654463/")).toBe(65);
  });
});

describe("isPaywall", () => {
  it("detects lock-screen markers", () => {
    expect(P.isPaywall('<div>本章为付费章节，请订阅后阅读</div>')).toBe(true);
    expect(P.isPaywall('<div>开通VIP即可继续阅读</div>')).toBe(true);
    expect(P.isPaywall('<div>剩余章节需付费，成为会员</div>')).toBe(true);
  });
  it("detects fanqie member-lock markers", () => {
    expect(P.isPaywall('<div>以下内容需会员解锁</div>')).toBe(true);
    expect(P.isPaywall('<div>剩余内容需开通番茄会员</div>')).toBe(true);
    expect(P.isPaywall('<div>成为会员免费阅读</div>')).toBe(true);
    expect(P.isPaywall('<div>购买APP会员还可享受网页畅读权益</div>')).toBe(true);
    expect(P.isPaywall('<div>充会员解锁剩下文章内容</div>')).toBe(true);
    expect(P.isPaywall('<div>本章为VIP抢先看章节</div>')).toBe(true);
  });
  it("rejects normal chapter body and empty", () => {
    expect(P.isPaywall('<div id="content"><p>第一章 正文内容很长很长</p></div>')).toBe(false);
    expect(P.isPaywall("")).toBe(false);
    expect(P.isPaywall(null)).toBe(false);
  });
});

describe("selectLatest", () => {
  const ch = (title, idx) => ({ chapter_title: title, chapter_index: idx, source_url: "u" + idx });
  it("takes last N when all indices numeric (ascending DOM)", () => {
    const list = [ch("第一章", 1), ch("第二章", 2), ch("第三章", 3), ch("第四章", 4), ch("第五章", 5)];
    const out = P.selectLatest(list, 2);
    expect(out.map((c) => c.chapter_index)).toEqual([4, 5]);
  });
  it("sorts before taking last N (reversed catalog)", () => {
    const list = [ch("第五章", 5), ch("第四章", 4), ch("第三章", 3), ch("第二章", 2), ch("第一章", 1)];
    const out = P.selectLatest(list, 2);
    expect(out.map((c) => c.chapter_index)).toEqual([4, 5]);
  });
  it("falls back to DOM order when any index is null", () => {
    const list = [ch("甲", null), ch("乙", 2), ch("丙", 3)];
    const out = P.selectLatest(list, 2);
    expect(out.map((c) => c.chapter_title)).toEqual(["乙", "丙"]);
  });
  it("clamps n to list length", () => {
    const list = [ch("第一章", 1), ch("第二章", 2)];
    expect(P.selectLatest(list, 99)).toHaveLength(2);
  });
});

describe("biquga 目录/正文修复", () => {
  it("looksLikeChapterHref 排除单段 SEO 详情页，保留笔趣阁两段式章节", () => {
    expect(P.looksLikeChapterHref("/book/7599.html")).toBe(false);
    expect(P.looksLikeChapterHref("/list/12.html")).toBe(false);
    expect(P.looksLikeChapterHref("/search/12345.html")).toBe(false);
    expect(P.looksLikeChapterHref("/9_9181/123456.html")).toBe(true);
    // 起点两段式 /book/{书id}/{章id}.html 不受影响
    expect(P.looksLikeChapterHref("/book/1/101.html")).toBe(true);
  });

  it("parseCatalog 过滤 SEO 链接并提取真实章节", () => {
    const html = `
      <html><body>
        <a href="/book/7599.html">大符篆师</a>
        <a href="/9_9181/">返回目录</a>
        <a href="/9_9181/123456.html">第一章 精神力二十的天才</a>
        <a href="/9_9181/123457.html">第二章 启灵</a>
      </body></html>`;
    const list = P.parseCatalog(html, "biquge");
    const titles = list.map((c) => c.chapter_title);
    expect(titles).toEqual(["第一章 精神力二十的天才", "第二章 启灵"]);
  });

  it("decodeBiqugeBase64 解码 qsbs.bb 正文并可用 extractChapterText 提取", () => {
    const b64 = Buffer.from("<p>这是第一章的正文内容，用于测试笔趣阁解密后的段落提取效果。</p><p>这是第二章的正文内容，同样足够长以通过段落过滤阈值。</p>", "utf8").toString("base64");
    const html = `<script>function qsbs(){}; document.writeln(qsbs.bb('${b64}'));</script>`;
    const decoded = P.decodeBiqugeBase64(html);
    expect(decoded).toContain("这是第一章的正文内容");
    const text = P.extractChapterText(decoded, "biquge");
    expect(text).toContain("这是第一章的正文内容");
    expect(text).toContain("这是第二章的正文内容");
  });
});

describe("biquga 分页目录", () => {
  it("biqugeCatalogEntryHref 旧格式书页换算为新格式分页入口（绕开反爬）", () => {
    const doc = P.parseHtml('<a href="/55_55383/index_1.html">查看更多章节</a>');
    const entry = P.biqugeCatalogEntryHref(doc, "https://www.biquga.com/55_55383/");
    expect(entry).toBe("https://www.biquga.com/book/55383/index_1.html");
  });

  it("biqugeCatalogEntryHref 旧格式 index_N 页也换算为新格式 index_1", () => {
    const entry = P.biqugeCatalogEntryHref(null, "https://www.biquga.com/46_46911/index_5.html");
    expect(entry).toBe("https://www.biquga.com/book/46911/index_1.html");
  });

  it("biqugeCatalogEntryHref 新格式书页保持新格式 index_1 不变", () => {
    const doc = P.parseHtml('<a href="/book/11763279/index_1.html">查看更多章节</a>');
    const entry = P.biqugeCatalogEntryHref(doc, "https://www.biquga.com/book/11763279.html");
    expect(entry).toBe("https://www.biquga.com/book/11763279/index_1.html");
  });

  it("biqugeCatalogEntryHref 新格式书页无目录入口时返回 null", () => {
    const doc = P.parseHtml('<a href="/book/11763279/123456.html">第一章 开端</a>');
    expect(P.biqugeCatalogEntryHref(doc, "https://www.biquga.com/book/11763279.html")).toBe(null);
  });

  it("biqugeCatalogPageCount 扫描分页链接取最大页码", () => {
    const html = `<html><body>
      <a href="index_1.html">1</a>
      <a href="index_2.html">2</a>
      <a href="index_36.html">36</a>
    </body></html>`;
    expect(P.biqugeCatalogPageCount(html)).toBe(36);
  });

  it("biqugeCatalogPageCount 无分页链接回退 1，支持「共 N 页」文字", () => {
    expect(P.biqugeCatalogPageCount("<html><body>单页目录</body></html>")).toBe(1);
    expect(P.biqugeCatalogPageCount('<html><body>共 36 页</body></html>')).toBe(36);
  });

  it("biqugeCatalogPageCount 扫描 <option value> 下拉分页", () => {
    const html = `<html><body>
      <select>
        <option value="/263_263537/index_1.html">第1-100章</option>
        <option value="/263_263537/index_7.html">第601-635章</option>
      </select>
    </body></html>`;
    expect(P.biqugeCatalogPageCount(html)).toBe(7);
  });
});

describe("biquga read_tz 渲染目录", () => {
  it("readTzContext 提取模板并拼装章节 URL", () => {
    const html = `<script>var read_aid='11763279';var read_bid='11763';var read_rewrite='/book/{aid}/{cid}.html';</script>`;
    const ctx = P.readTzContext(html);
    expect(ctx.buildUrl("137677333")).toBe("/book/11763279/137677333.html");
  });

  it("readTzContext 旧格式 /{bid}_{aid}/{cid}.html", () => {
    const html = `<script>read_aid='263537';read_bid='263';read_rewrite='/{bid}_{aid}/{cid}.html';</script>`;
    const ctx = P.readTzContext(html);
    expect(ctx.buildUrl("130923665")).toBe("/263_263537/130923665.html");
  });

  it("parseCatalog 解析 onclick=read_tz 章节（无 href）", () => {
    const html = `<html><body>
      <script>var read_aid='11763279';var read_bid='11763';var read_rewrite='/book/{aid}/{cid}.html';</script>
      <a onclick="read_tz(137677333)">第81章 女儿国女王</a>
      <a onclick="read_tz(137677332)">第80章 四圣争辩</a>
      <a onclick="read_tz('137677331')">第79章 通天</a>
    </body></html>`;
    const list = P.parseCatalog(html, "biquge", "https://www.biquga.com/book/11763279/index_1.html");
    expect(list).toHaveLength(3);
    expect(list[0].source_url).toBe("https://www.biquga.com/book/11763279/137677333.html");
    expect(list[0].chapter_index).toBe(81);
    expect(list[2].chapter_index).toBe(79);
  });

  it("parseCatalog 合并 href 与 read_tz 并去重", () => {
    const html = `<html><body>
      <script>read_aid='11763279';read_bid='11763';read_rewrite='/book/{aid}/{cid}.html';</script>
      <a href="/book/11763279/137677333.html">第81章 女儿国女王</a>
      <a onclick="read_tz(137677333)">第81章 女儿国女王</a>
      <a onclick="read_tz(137677332)">第80章 四圣争辩</a>
    </body></html>`;
    const list = P.parseCatalog(html, "biquge", "https://www.biquga.com/book/11763279/index_1.html");
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.chapter_index).sort()).toEqual([80, 81]);
  });

  it("biqugeBookId 识别新旧两种格式", () => {
    expect(P.biqugeBookId("https://www.biquga.com/book/11763279.html")).toBe("11763279");
    expect(P.biqugeBookId("https://www.biquga.com/book/11763279/index_1.html")).toBe("11763279");
    expect(P.biqugeBookId("https://www.biquga.com/263_263537/")).toBe("263537");
    expect(P.biqugeBookId("https://www.biquga.com/263_263537/index_2.html")).toBe("263537");
  });
});
