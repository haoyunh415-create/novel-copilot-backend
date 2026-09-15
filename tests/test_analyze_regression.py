from datetime import date

import main as m


def _stub_analyze_text(text, chapter_title, *, detail_level, spoiler_free):
    return {"summary": "测试摘要", "characters": [], "foreshadowing": [], "terms": []}


def test_analyze_deducts_credit_and_saves(monkeypatch, client, db):
    monkeypatch.setattr(m, "analyze_text", _stub_analyze_text)
    # 先领取今日签到，使 analyze 路径只扣 1 次额度（隔离每日签到 +8 的副作用）
    with m.get_db() as conn:
        conn.execute(
            "UPDATE users SET daily_bonus_date = ? WHERE username='testuser'",
            (str(date.today()),),
        )
    resp = client.post("/api/analyze", json={
        "text": "第一章正文内容，足够长的一段测试文本。" * 30,
        "chapter_title": "第一章 测试",
        "book_title": "测试书",
        "detail_level": "standard",
        "spoiler_free": True,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["result"]["summary"] == "测试摘要"
    with m.get_db() as conn:
        row = conn.execute("SELECT credits FROM users WHERE username='testuser'").fetchone()
        assert row["credits"] == 99
        n = conn.execute("SELECT COUNT(*) FROM analyses WHERE username='testuser'").fetchone()[0]
        assert n == 1


def test_analyze_refunds_on_garbled(monkeypatch, client, db):
    garbled = "" * 40 + "正常中文" * 5
    resp = client.post("/api/analyze", json={
        "text": garbled,
        "chapter_title": "第一章",
        "detail_level": "standard",
    })
    assert resp.json()["success"] is False
    with m.get_db() as conn:
        row = conn.execute("SELECT credits FROM users WHERE username='testuser'").fetchone()
        assert row["credits"] == 100
