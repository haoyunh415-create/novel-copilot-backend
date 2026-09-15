import sqlite3
from contextlib import contextmanager

import pytest

import main as m


@pytest.fixture(autouse=True)
def _reset_limits():
    """每个用例前清空内存限流，避免 2s 节流跨用例残留。"""
    m.user_last_request.clear()
    if hasattr(m, "_rate_limits"):
        m._rate_limits.clear()
    yield


@pytest.fixture()
def db(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"

    @contextmanager
    def _get_db():
        conn = sqlite3.connect(str(db_file), check_same_thread=False, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    monkeypatch.setattr(m, "get_db", _get_db)
    m.init_db()
    return db_file


@pytest.fixture()
def user_token(db):
    with m.get_db() as conn:
        conn.execute(
            "INSERT INTO users (username, password, credits) VALUES ('testuser', 'x', 100)"
        )
    return m.create_token("testuser")


@pytest.fixture()
def client(db, user_token):
    from fastapi.testclient import TestClient
    c = TestClient(m.app)
    c.headers = {"Authorization": "Bearer " + user_token}
    return c
