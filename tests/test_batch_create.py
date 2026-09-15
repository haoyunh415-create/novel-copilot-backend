import main as m


def test_create_batch_marks_already_analyzed_as_skipped(client, db):
    # 预建书 + 已分析的"第一章"，让判重按 (book_id, chapter_index) 命中
    with m.get_db() as conn:
        cur = conn.execute(
            "INSERT INTO books (username, title, author, source_url_pattern, created_at) VALUES (?, ?, ?, ?, ?)",
            ("testuser", "测试书", "", "https://biquge.example/", 0),
        )
        book_id = cur.lastrowid
        conn.execute(
            "INSERT INTO analyses (username, book_id, chapter_title, chapter_index, source_url, text_hash, detail_level, spoiler_free, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("testuser", book_id, "第一章", 1, "https://biquge.example/1.html", "h1", "standard", 1, "{}", 0),
        )
    resp = client.post("/api/analyze/batch/create", json={
        "book_title": "测试书",
        "chapter_list": [
            {"chapter_title": "第一章", "chapter_index": 1, "source_url": "https://biquge.example/1.html"},
            {"chapter_title": "第二章", "chapter_index": 2, "source_url": "https://biquge.example/2.html"},
            {"chapter_title": "第三章", "chapter_index": 3, "source_url": "https://biquge.example/3.html"},
        ],
    })
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["total"] == 3
    assert data["pending"] == 2
    assert data["skipped"] == 1
    job_id = data["job_id"]
    with m.get_db() as conn:
        items = conn.execute(
            "SELECT chapter_index, status FROM batch_items WHERE job_id=? ORDER BY chapter_index",
            (job_id,),
        ).fetchall()
    assert items[0]["status"] == "skipped"
    assert items[1]["status"] == "pending"
    assert items[2]["status"] == "pending"
