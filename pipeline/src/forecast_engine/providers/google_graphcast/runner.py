from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from forecast_engine.config import default_cache_dir

UPSTREAM = "https://github.com/google-deepmind/weathernext.git"


def run_official_sample(output_dir: Path, cache_dir: Path | None = None) -> Path:
    """Execute the upstream demo and export its predictions plus initialization state.

    This intentionally delegates inference/input preparation to Google's supplied demo.
    It is a smoke-test path, never an operational adapter.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir or default_cache_dir()
    script = Path(__file__).resolve().parents[4] / "scripts" / "run_official_graphcast_demo.py"
    command = [sys.executable, str(script), "--repository", UPSTREAM, "--cache-dir", str(cache), "--output", str(output_dir / "forecast.nc")]
    subprocess.run(command, check=True)
    return output_dir / "forecast.nc"
