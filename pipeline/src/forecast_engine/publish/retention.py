from __future__ import annotations

import shutil
from pathlib import Path

from forecast_engine.config import MODEL_ID


def prune_published_runs(publish_dir: Path, *, keep: str) -> None:
    """Delete superseded published runs after the replacement has been validated."""
    runs = publish_dir / "models" / MODEL_ID / "runs"
    retained = runs / keep
    if not retained.is_dir():
        raise FileNotFoundError(f"Cannot prune published runs; retained run does not exist: {retained}")
    for candidate in runs.iterdir():
        if candidate.name != keep and candidate.is_dir():
            shutil.rmtree(candidate)
