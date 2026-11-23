"""Read-only, thread-safe runtime. Only Python's standard library is required."""

import os
import sqlite3
from functools import lru_cache
from pathlib import Path
from threading import RLock
from typing import Literal

from .formatting import format_description
from .fine import lookup as fine_lookup
from .geometry import decode_cell, geohash_key
from .models import Place

SCHEMA_VERSION = "1"


class Gazetteer:
    """One shared read-only connection, serialized SQL, and a bounded LRU.

    Instantiate after a worker process forks. Create one instance per application
    process, close it during shutdown. Cache keys include the requested precision.
    """

    def __init__(self, path: str | Path, cache_size: int = 100_000):
        if not isinstance(cache_size, int) or cache_size < 0:
            raise ValueError("cache_size must be a nonnegative integer")
        self.path = Path(path).resolve(strict=True)
        self._lock = RLock()
        self._pid = os.getpid()
        self._closed = False
        self._db = sqlite3.connect(
            self.path.as_uri() + "?mode=ro", uri=True, check_same_thread=False
        )
        self._db.execute("PRAGMA query_only=ON")
        try:
            version = self._db.execute(
                "SELECT value FROM metadata WHERE key='schema_version'"
            ).fetchone()
            if version != (SCHEMA_VERSION,):
                raise ValueError("unsupported gazetteer schema version")
            self._has_fine_index = (
                self._db.execute(
                    "SELECT 1 FROM sqlite_schema WHERE name='fine_index'"
                ).fetchone()
                is not None
            )
        except BaseException:
            self._db.close()
            raise
        self._cached = lru_cache(maxsize=cache_size)(self._lookup)

    def _lookup(self, prefix: str) -> tuple[Place, str | None]:
        row = self._db.execute(
            """
            SELECT p.id,p.name,p.latitude,p.longitude,p.importance
            FROM room_anchors a JOIN places p ON p.id=a.place_id
            WHERE a.geohash_key=?
        """,
            (geohash_key(prefix),),
        ).fetchone()
        if row:
            return (
                Place(
                    id=row[0],
                    name=row[1],
                    latitude=row[2],
                    longitude=row[3],
                    importance=row[4],
                ),
                None,
            )
        if len(prefix) in (5, 7) and self._has_fine_index:
            match = fine_lookup(
                self._db, *decode_cell(prefix).center, city_only=len(prefix) == 5
            )
            if match:
                return match
        if len(prefix) > 1:
            place, relation = self._cached(prefix[:-1])
            # A parent's center can be inside a boundary while the child's is outside.
            return place, "near" if relation == "in" else relation
        raise LookupError(f"gazetteer has no anchor for {prefix!r}")

    def _resolve(self, geohash_prefix: str) -> tuple[Place, str | None]:
        decode_cell(geohash_prefix)
        with self._lock:
            if self._closed:
                raise RuntimeError("gazetteer is closed")
            if self._pid != os.getpid():
                raise RuntimeError("open a new Gazetteer after forking")
            return self._cached(geohash_prefix)

    def get_geoname(self, geohash_prefix: str) -> Place:
        return self._resolve(geohash_prefix)[0]

    def get_room_description(
        self, geohash_prefix: str, unit: Literal["miles", "meters"] = "miles"
    ) -> str:
        if unit not in ("miles", "meters"):
            raise ValueError("unit must be 'miles' or 'meters'")
        place, relation = self._resolve(geohash_prefix)
        return format_description(
            decode_cell(geohash_prefix), place, unit, spatial_relation=relation
        )

    def cache_info(self):
        return self._cached.cache_info()

    def close(self):
        with self._lock:
            if not self._closed:
                self._cached.cache_clear()
                self._db.close()
                self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


_default = None
_default_lock = RLock()


def configure(path: str | Path, cache_size: int = 100_000) -> None:
    """Configure the module-level API; close an earlier instance if present."""
    global _default
    with _default_lock:
        replacement = Gazetteer(path, cache_size)
        if _default is not None:
            _default.close()
        _default = replacement


def _database() -> Gazetteer:
    if _default is None:
        path = os.environ.get("GEOCHALK_GAZETTEER")
        if not path:
            raise RuntimeError("set GEOCHALK_GAZETTEER or call configure(path)")
        configure(path)
    return _default


def get_geoname(geohash_prefix: str) -> Place:
    with _default_lock:
        return _database().get_geoname(geohash_prefix)


def get_room_description(
    geohash_prefix: str, unit: Literal["miles", "meters"] = "miles"
) -> str:
    with _default_lock:
        return _database().get_room_description(geohash_prefix, unit)
