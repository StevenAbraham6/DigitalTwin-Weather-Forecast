#!/usr/bin/env python3
"""Manually trigger the complete ERA5T -> GraphCast Small -> UI publish flow."""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from datetime import UTC
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=8, help="Six-hour forecast frames (default: 8 = +48h).")
    parser.add_argument("--work-dir", type=Path, default=Path("output/era5t-graphcast-small"))
    parser.add_argument("--publish-dir", type=Path, default=Path("output/era5t-graphcast-small/published"))
    parser.add_argument("--upstream", type=Path, default=Path.home() / "Library/Caches/forecast-engine/weathernext")
    args = parser.parse_args()
    if args.steps < 1:
        raise SystemExit("--steps must be positive")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from forecast_engine.ingest.era5t import latest_available, prepare_graphcast_small, retrieve_pair
    from forecast_engine.publish import publish, validate_run

    initialization = latest_available().astimezone(UTC)
    print(f"ERA5T source initialization: {initialization.isoformat()}", flush=True)
    retrieve_pair(initialization, args.work_dir)
    prepared = prepare_graphcast_small(initialization, args.work_dir)
    native = prepared.parent / f"forecast-{args.steps}-intervals.nc"
    runner = Path(__file__).with_name("run_era5t_graphcast_small_smoke.py")
    subprocess.run(
        [
            sys.executable,
            str(runner),
            "--steps", str(args.steps),
            "--input", str(prepared),
            "--output", str(native),
            "--upstream", str(args.upstream),
        ],
        check=True,
    )
    run_id = f"{initialization.strftime('%Y-%m-%dT%H-%M-%SZ')}-era5t-graphcast-small-{args.steps}frame"
    run_dir = publish(native, args.publish_dir, initialization, run_id, initialization_state=prepared)
    validate_run(run_dir)
    _prune_published_runs(args.publish_dir, keep=run_dir.name)
    print(f"Published UI run: {run_dir}", flush=True)


def _prune_published_runs(publish_dir: Path, *, keep: str) -> None:
    """Retain only the just-validated GraphCast Small published run."""
    runs = publish_dir / "models" / "google-graphcast-small" / "runs"
    for candidate in runs.iterdir():
        if candidate.name != keep and candidate.is_dir():
            shutil.rmtree(candidate)


if __name__ == "__main__":
    main()
