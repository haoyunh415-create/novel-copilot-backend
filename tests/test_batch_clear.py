def _make_job(client):
    resp = client.post("/api/analyze/batch/create", json={
        "book_title": "测试书",
        "chapter_list": [
            {"chapter_title": "第一章", "chapter_index": 1, "source_url": "https://biquge.example/1.html"},
            {"chapter_title": "第二章", "chapter_index": 2, "source_url": "https://biquge.example/2.html"},
        ],
    })
    return resp.json()["data"]


def test_clear_removes_all_jobs_and_items(client, db):
    _make_job(client)
    resp = client.post("/api/analyze/batch/clear")
    assert resp.status_code == 200
    assert resp.json()["data"]["deleted"] == 1

    g = client.get("/api/analyze/batch")
    assert g.json()["data"]["jobs"] == []


def test_clear_is_scoped_to_current_user(client, db):
    import main as m

    _make_job(client)
    # 另一个用户的任务不应被清除
    with m.get_db() as conn:
        conn.execute(
            "INSERT INTO batch_jobs (username, book_id, book_title, total, status, created_at) "
            "VALUES ('otheruser', NULL, '别人的书', 1, 'pending', 0)"
        )
    client.post("/api/analyze/batch/clear")
    with m.get_db() as conn:
        remaining = conn.execute(
            "SELECT COUNT(*) FROM batch_jobs WHERE username='otheruser'"
        ).fetchone()[0]
    assert remaining == 1
