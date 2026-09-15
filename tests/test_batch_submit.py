from datetime import date

import main as m


def _stub_analyze_text(text, chapter_title, *, detail_level, spoiler_free):
    return {"summary": "批量摘要", "characters": [], "foreshadowing": [], "terms": []}


def _make_job(client):
    resp = client.post("/api/analyze/batch/create", json={
        "book_title": "测试书",
        "chapter_list": [
            {"chapter_title": "第一章", "chapter_index": 1, "source_url": "https://biquge.example/1.html"},
            {"chapter_title": "第二章", "chapter_index": 2, "source_url": "https://biquge.example/2.html"},
        ],
    })
    return resp.json()["data"]


def test_submit_analyzes_and_updates_progress(monkeypatch, client, db):
    monkeypatch.setattr(m, "analyze_text", _stub_analyze_text)
    job = _make_job(client)
    with m.get_db() as conn:
        item = conn.execute(
            "SELECT id FROM batch_items WHERE job_id=? AND status='pending' ORDER BY id LIMIT 1",
            (job["job_id"],),
        ).fetchone()
    resp = client.post(f"/api/analyze/batch/{job['job_id']}/submit", json={
        "item_id": item["id"],
        "text": "第二章正文内容，足够长的一段测试文本。" * 30,
    })
    assert resp.status_code == 200
    assert resp.json()["success"] is True
    with m.get_db() as conn:
        row = conn.execute("SELECT status FROM batch_items WHERE id=?", (item["id"],)).fetchone()
        assert row["status"] == "done"
        j = conn.execute("SELECT done, status FROM batch_jobs WHERE id=?", (job["job_id"],)).fetchone()
        assert j["done"] == 1
        assert j["status"] == "running"


def test_submit_pauses_on_insufficient_credits(monkeypatch, client, db):
    monkeypatch.setattr(m, "analyze_text", _stub_analyze_text)
    with m.get_db() as conn:
        # 隔离每日签到 +8，使 credits 停在 0，触发额度不足
        conn.execute("UPDATE users SET daily_bonus_date = ? WHERE username='testuser'", (str(date.today()),))
        conn.execute("UPDATE users SET credits=0 WHERE username='testuser'")
    job = _make_job(client)
    with m.get_db() as conn:
        item = conn.execute(
            "SELECT id FROM batch_items WHERE job_id=? AND status='pending' ORDER BY id LIMIT 1",
            (job["job_id"],),
        ).fetchone()
    resp = client.post(f"/api/analyze/batch/{job['job_id']}/submit", json={
        "item_id": item["id"],
        "text": "正文内容，足够长的一段测试文本。" * 30,
    })
    assert resp.json()["success"] is False
    with m.get_db() as conn:
        j = conn.execute("SELECT status FROM batch_jobs WHERE id=?", (job["job_id"],)).fetchone()
        assert j["status"] == "paused"
