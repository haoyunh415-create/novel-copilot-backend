def test_get_job_returns_progress(client):
    resp = client.post("/api/analyze/batch/create", json={
        "book_title": "测试书",
        "chapter_list": [{"chapter_title": "第一章", "chapter_index": 1, "source_url": "https://biquge.example/1.html"}],
    })
    job_id = resp.json()["data"]["job_id"]
    g = client.get(f"/api/analyze/batch/{job_id}")
    assert g.status_code == 200
    data = g.json()["data"]
    assert data["job"]["id"] == job_id
    assert len(data["items"]) == 1
    assert data["items"][0]["status"] == "pending"


def test_list_jobs_only_returns_unfinished(client):
    client.post("/api/analyze/batch/create", json={
        "book_title": "测试书",
        "chapter_list": [{"chapter_title": "第一章", "chapter_index": 1, "source_url": "https://biquge.example/1.html"}],
    })
    g = client.get("/api/analyze/batch")
    assert g.status_code == 200
    assert len(g.json()["data"]["jobs"]) == 1
