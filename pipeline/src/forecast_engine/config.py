from __future__ import annotations

from pathlib import Path

from platformdirs import user_cache_dir

MODEL_ID = "google-graphcast-small"
PROVIDER = "Google DeepMind"


def default_cache_dir() -> Path:
    return Path(user_cache_dir("forecast-engine"))
