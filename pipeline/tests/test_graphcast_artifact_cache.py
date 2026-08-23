from __future__ import annotations

from pathlib import Path

import pytest

from forecast_engine.providers.google_graphcast.artifact_cache import ensure_cached


class FakeBlob:
    def __init__(self, content: bytes, downloads: list[str], object_name: str) -> None:
        self.content = content
        self.downloads = downloads
        self.object_name = object_name

    def download_to_filename(self, filename: str) -> None:
        self.downloads.append(self.object_name)
        Path(filename).write_bytes(self.content)


class FakeBucket:
    name = "dm_graphcast"

    def __init__(self, content: bytes = b"checkpoint") -> None:
        self.content = content
        self.downloads: list[str] = []

    def blob(self, object_name: str) -> FakeBlob:
        return FakeBlob(self.content, self.downloads, object_name)


def test_artifact_is_downloaded_once_and_reused(tmp_path: Path) -> None:
    bucket = FakeBucket()
    object_name = "graphcast/params/model.npz"

    first = ensure_cached(bucket, object_name, tmp_path)
    second = ensure_cached(bucket, object_name, tmp_path)

    assert first == second
    assert first.read_bytes() == b"checkpoint"
    assert bucket.downloads == [object_name]


def test_corrupt_cached_artifact_is_replaced(tmp_path: Path) -> None:
    bucket = FakeBucket()
    object_name = "graphcast/stats/mean.nc"
    target = ensure_cached(bucket, object_name, tmp_path)
    target.write_bytes(b"corrupt")

    repaired = ensure_cached(bucket, object_name, tmp_path)

    assert repaired.read_bytes() == b"checkpoint"
    assert bucket.downloads == [object_name, object_name]


def test_artifact_name_cannot_escape_cache(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Unsafe GraphCast artifact name"):
        ensure_cached(FakeBucket(), "../model.npz", tmp_path)
