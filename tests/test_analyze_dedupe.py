from datetime import date

import main as m


def _stub_analyze_text(text, chapter_title, *, detail_level, spoiler_free):
    return {"summary": "测试摘要", "characters": [], "foreshadowing": [], "terms": []}


def _claim_daily_bonus():
    """把签到日期设成今天，隔离每日签到 +8 额度的副作用。"""
    with m.get_db() as conn:
        conn.execute(
            "UPDATE users SET daily_bonus_date = ? WHERE username='testuser'",
            (str(date.today()),),
        )


def _post_analyze(client, payload):
    """发一次分析请求，先清空 2 秒单章节流（测试内快速连续请求会触发节流）。"""
    m.user_last_request.clear()
    return client.post("/api/analyze", json=payload)


def test_same_chapter_different_text_keeps_one_record(monkeypatch, client, db):
    """同一章用不同正文（text_hash 不同）分析两次，只保留一条记录。

    复现「批量分析 + 逐章分析同一章、正文抓取略有差异」导致重复章节的问题。
    """
    monkeypatch.setattr(m, "analyze_text", _stub_analyze_text)
    _claim_daily_bonus()
    payload = {
        "chapter_title": "第一章 测试",
        "book_title": "测试书",
        "detail_level": "standard",
        "spoiler_free": True,
    }
    assert _post_analyze(client, {**payload, "text": "第一次分析正文内容。" * 40}).json()["success"] is True
    assert _post_analyze(client, {**payload, "text": "第二次分析正文，文字完全不同。" * 40}).json()["success"] is True

    with m.get_db() as conn:
        rows = conn.execute(
            "SELECT id, text_hash FROM analyses WHERE username='testuser' AND chapter_title='第一章 测试'"
        ).fetchall()
        assert len(rows) == 1  # 彻底去重后只剩最新一条


def test_different_chapters_kept(monkeypatch, client, db):
    """不同章节各自保留，去重不误删。"""
    monkeypatch.setattr(m, "analyze_text", _stub_analyze_text)
    _claim_daily_bonus()
    base = {"book_title": "测试书", "detail_level": "standard", "spoiler_free": True}
    _post_analyze(client, {**base, "chapter_title": "第一章 测试", "text": "第一章正文。" * 40})
    _post_analyze(client, {**base, "chapter_title": "第二章 测试", "text": "第二章正文。" * 40})

    with m.get_db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM analyses WHERE username='testuser'").fetchone()[0]
        assert n == 2


def test_same_chapter_same_text_hits_cache_no_duplicate(monkeypatch, client, db):
    """同章同正文分析两次：第二次命中缓存，不扣第二次额度，仍只一条记录。"""
    monkeypatch.setattr(m, "analyze_text", _stub_analyze_text)
    _claim_daily_bonus()
    payload = {
        "chapter_title": "第一章 测试",
        "book_title": "测试书",
        "detail_level": "standard",
        "spoiler_free": True,
        "text": "同一段正文内容。" * 40,
    }
    assert _post_analyze(client, payload).json()["success"] is True
    assert _post_analyze(client, payload).json()["success"] is True

    with m.get_db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM analyses WHERE username='testuser'").fetchone()[0]
        assert n == 1
        row = conn.execute("SELECT credits FROM users WHERE username='testuser'").fetchone()
        assert row["credits"] == 99  # 第二次命中缓存，不扣额度
