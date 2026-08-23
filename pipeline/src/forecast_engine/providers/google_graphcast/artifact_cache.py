from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

from forecast_engine.config import default_cache_dir


def default_artifact_cache_dir() -> Path:
    """Return the persistent cache used for public GraphCast bucket objects."""
    return default_cache_dir() / "artifacts" / "dm_graphcast"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_target(cache_dir: Path, object_name: str) -> Path:
    relative = PurePosixPath(object_name)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise ValueError(f"Unsafe GraphCast artifact name: {object_name!r}")
    return cache_dir.joinpath(*relative.parts)


def _cache_is_valid(target: Path, metadata_path: Path, object_name: str) -> bool:
    if not target.is_file() or not metadata_path.is_file():
        return False
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        return (
            metadata["object"] == object_name
            and metadata["size"] == target.stat().st_size
            and metadata["sha256"] == _sha256(target)
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def ensure_cached(bucket: Any, object_name: str, cache_dir: Path) -> Path:
    """Download a bucket object once and return an integrity-checked local path."""
    target = _safe_target(cache_dir, object_name)
    metadata_path = target.with_name(target.name + ".cache.json")
    if _cache_is_valid(target, metadata_path, object_name):
        print(f"Using cached GraphCast artifact: {target}", flush=True)
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading GraphCast artifact once: gs://{bucket.name}/{object_name}", flush=True)
    temporary_fd, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".download", dir=target.parent
    )
    os.close(temporary_fd)
    temporary = Path(temporary_name)
    try:
        bucket.blob(object_name).download_to_filename(str(temporary))
        metadata = {
            "bucket": bucket.name,
            "object": object_name,
            "size": temporary.stat().st_size,
            "sha256": _sha256(temporary),
        }
        os.replace(temporary, target)
        metadata_path.write_text(json.dumps(metadata, sort_keys=True) + "\n", encoding="utf-8")
    finally:
        temporary.unlink(missing_ok=True)
    return target
