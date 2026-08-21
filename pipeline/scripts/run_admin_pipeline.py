"""Instrumented ERA5T -> GraphCast Small -> UI publication for the admin API."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

EVENT_PREFIX = "@@PIPELINE_EVENT@@"
UPSTREAM_REPOSITORY = "https://github.com/google-deepmind/weathernext.git"
UPSTREAM_REVISION = "08cf73625c9d12bd9aaa038868bcb2fe488f2a22"


def emit(payload: dict[str, object]) -> None:
    print(EVENT_PREFIX + json.dumps(payload, separators=(",", ":")), flush=True)


@contextmanager
def stage(name: str) -> Iterator[None]:
    started = time.monotonic()
    emit({"type": "stage", "stage": name, "status": "running"})
    try:
        yield
    except BaseException:
        emit(
            {
                "type": "stage",
                "stage": name,
                "status": "failed",
                "durationMs": round((time.monotonic() - started) * 1000),
            }
        )
        raise
    emit(
        {
            "type": "stage",
            "stage": name,
            "status": "complete",
            "durationMs": round((time.monotonic() - started) * 1000),
        }
    )


def ensure_upstream(upstream: Path) -> None:
    """Populate the tested GraphCast source cache without installing WeatherNext."""
    if (upstream / "graphcast").is_dir():
        return
    if upstream.exists():
        raise RuntimeError(
            f"GraphCast cache exists but is incomplete: {upstream}. "
            "Move it aside and retry so the pinned source can be downloaded."
        )
    upstream.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "clone", "--filter=blob:none", UPSTREAM_REPOSITORY, str(upstream)],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(upstream), "checkout", "--detach", UPSTREAM_REVISION],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("full", "inference"), default="full")
    parser.add_argument(
        "--compute-device",
        choices=("cpu", "gpu_l4", "gpu_amd"),
        default="cpu",
    )
    parser.add_argument("--execution-id", required=True)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--publish-dir", type=Path, required=True)
    parser.add_argument("--base-data", type=Path)
    parser.add_argument("--initialization-time")
    parser.add_argument(
        "--upstream",
        type=Path,
        default=Path.home() / "Library/Caches/forecast-engine/weathernext",
    )
    args = parser.parse_args()
    if not 1 <= args.steps <= 40:
        raise SystemExit("--steps must be between 1 and 40")
    execution_id = re.sub(r"[^A-Za-z0-9-]", "", args.execution_id)[:8]
    if not execution_id:
        raise SystemExit("--execution-id must contain letters or numbers")

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from forecast_engine.ingest.era5t import (
        latest_available,
        prepare_graphcast_small,
        retrieve_pair,
    )
    from forecast_engine.publish import prune_published_runs, publish, validate_run

    if args.mode == "full":
        with stage("download"):
            ensure_upstream(args.upstream)
            initialization = latest_available().astimezone(UTC)
            emit(
                {
                    "type": "metadata",
                    "initializationTime": initialization.isoformat().replace("+00:00", "Z"),
                }
            )
            print(f"ERA5T source initialization: {initialization.isoformat()}", flush=True)
            retrieve_pair(initialization, args.work_dir)

        with stage("preparation"):
            prepared = prepare_graphcast_small(initialization, args.work_dir)
        emit(
            {
                "type": "metadata",
                "initializationTime": initialization.isoformat().replace("+00:00", "Z"),
                "baseDataPath": str(prepared.resolve()),
            }
        )
    else:
        if args.base_data is None or args.initialization_time is None:
            raise SystemExit("Inference-only mode requires --base-data and --initialization-time")
        prepared = args.base_data.resolve()
        if not prepared.is_file():
            raise SystemExit(f"Reusable base data does not exist: {prepared}")
        initialization = datetime.fromisoformat(args.initialization_time.replace("Z", "+00:00")).astimezone(UTC)
        emit({"type": "stage", "stage": "download", "status": "skipped"})
        emit({"type": "stage", "stage": "preparation", "status": "skipped"})
        emit(
            {
                "type": "metadata",
                "initializationTime": initialization.isoformat().replace("+00:00", "Z"),
                "baseDataPath": str(prepared),
            }
        )
        print(f"Reusing prepared ERA5T base data: {prepared}", flush=True)

    native = prepared.parent / f"forecast-{args.steps}-intervals.nc"
    inference_runner = Path(__file__).with_name("run_era5t_graphcast_small_smoke.py")
    inference_environment = os.environ.copy()
    jax_platform = {
        "cpu": "cpu",
        "gpu_l4": "cuda",
        "gpu_amd": "rocm",
    }[args.compute_device]
    inference_environment["JAX_PLATFORMS"] = jax_platform
    print(
        f"Requested compute target: {args.compute_device} · JAX platform: {jax_platform}",
        flush=True,
    )
    with stage("inference"):
        subprocess.run(
            [
                sys.executable,
                str(inference_runner),
                "--steps",
                str(args.steps),
                "--compute-device",
                args.compute_device,
                "--input",
                str(prepared),
                "--output",
                str(native),
                "--upstream",
                str(args.upstream),
            ],
            check=True,
            env=inference_environment,
        )

    run_id = (
        f"{initialization.strftime('%Y-%m-%dT%H-%M-%SZ')}"
        f"-era5t-graphcast-small-{args.steps}frame-{execution_id}"
    )
    with stage("publish"):
        run_dir = publish(
            native,
            args.publish_dir,
            initialization,
            run_id,
            initialization_state=prepared,
        )
        validate_run(run_dir)
        prune_published_runs(args.publish_dir, keep=run_dir.name)

    emit(
        {
            "type": "metadata",
            "runId": run_id,
            "runDir": str(run_dir.resolve()),
        }
    )
    print(f"Published UI run: {run_dir}", flush=True)


if __name__ == "__main__":
    main()
