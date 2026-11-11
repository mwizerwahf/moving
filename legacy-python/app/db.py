"""Connection pool and start-up schema."""
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import settings

pool: AsyncConnectionPool | None = None


async def open_pool() -> AsyncConnectionPool:
    global pool
    pool = AsyncConnectionPool(settings.database_url, min_size=1, max_size=10, open=False,
                               kwargs={"row_factory": dict_row, "autocommit": True})
    await pool.open(wait=True, timeout=30)
    async with pool.connection() as conn:
        await conn.execute((Path(__file__).parent / "schema.sql").read_text())
    return pool


async def close_pool() -> None:
    if pool is not None:
        await pool.close()


def get_pool() -> AsyncConnectionPool:
    assert pool is not None, "database pool not opened"
    return pool
