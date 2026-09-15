import main as m


def test_batch_tables_exist(db):
    with m.get_db() as conn:
        jobs = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='batch_jobs'"
        ).fetchall()
        items = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='batch_items'"
        ).fetchall()
    assert len(jobs) == 1
    assert len(items) == 1
