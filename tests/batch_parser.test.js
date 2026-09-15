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
  it("matches 3-digit and trailing-slash numeric urls", () => {
    expect(P.looksLikeChapterHref("/book/1/101.html")).toBe(true);
    expect(P.looksLikeChapterHref("/12345/")).toBe(true);
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
