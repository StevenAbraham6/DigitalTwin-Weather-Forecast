#!/usr/bin/env python3
"""Run one +6h GraphCast Small prediction from prepared ERA5T data."""
from __future__ import annotations

import time

PROCESS_STARTED = time.monotonic()

import argparse
import dataclasses
import functools
import importlib.metadata
import json
import sys
from pathlib import Path

import haiku as hk
import jax
import numpy as np
import xarray as xr
from google.cloud import storage

EVENT_PREFIX = "@@PIPELINE_EVENT@@"


def emit(payload: dict[str, object]) -> None:
    print(EVENT_PREFIX + json.dumps(payload, separators=(",", ":")), flush=True)


def emit_timing(name: str, label: str, started: float) -> None:
    duration_ms = round((time.monotonic() - started) * 1000)
    emit(
        {
            "type": "inference_timing",
            "name": name,
            "label": label,
            "durationMs": duration_ms,
        }
    )
    print(f"Inference timing · {label}: {duration_ms / 1000:.3f} s", flush=True)


def synchronize(dataset: xr.Dataset, xarray_jax: object) -> None:
    """Wait until every forecast field has completed on the selected device."""
    for variable in dataset.data_vars.values():
        device_data = xarray_jax.unwrap_data(variable)
        wait = getattr(device_data, "block_until_ready", None)
        if wait is not None:
            wait()


def transfer_to_host(dataset: xr.Dataset, xarray_jax: object) -> xr.Dataset:
    """Materialize device-backed fields as NumPy arrays before serialization."""
    materialized = dataset.copy()
    for name in materialized.data_vars:
        materialized[name].data = np.asarray(xarray_jax.unwrap_data(materialized[name]))
    return materialized


def jax_package_versions() -> str:
    packages = ("jax", "jaxlib", "jax-rocm7-plugin", "jax-rocm7-pjrt")
    versions = []
    for package in packages:
        try:
            version = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            version = "not installed"
        versions.append(f"{package}={version}")
    return ", ".join(versions)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=1, help="Number of six-hour forecast intervals.")
    parser.add_argument(
        "--compute-device",
        choices=("auto", "cpu", "gpu_l4", "gpu_amd"),
        default="auto",
    )
    args = parser.parse_args()
    sys.path.insert(0, str(args.upstream))
    from graphcast import (
        autoregressive,
        casting,
        checkpoint,
        data_utils,
        graphcast,
        normalization,
        xarray_jax,
    )

    if args.steps < 1:
        raise ValueError("--steps must be positive")
    print(f"Installed JAX packages: {jax_package_versions()}", flush=True)
    try:
        actual_backend = jax.default_backend()
    except Exception as error:
        if args.compute_device == "gpu_amd":
            raise RuntimeError(
                "ROCm JAX could not initialize. The JAX, jaxlib, ROCm plugin, and PJRT "
                "versions must match. Run `npm run pipeline:setup:amd`, then retry. "
                f"Backend error: {error}"
            ) from None
        raise
    expected_backends = {
        "cpu": {"cpu"},
        "gpu_l4": {"gpu", "cuda"},
        "gpu_amd": {"gpu", "rocm"},
    }
    if (
        args.compute_device != "auto"
        and actual_backend not in expected_backends[args.compute_device]
    ):
        raise RuntimeError(
            f"Requested {args.compute_device.upper()} inference but JAX selected "
            f"{actual_backend.upper()}. Check the installed JAX backend."
        )
    devices = ", ".join(getattr(device, "device_kind", str(device)) for device in jax.devices())
    requested_target = {
        "auto": "Automatic",
        "cpu": "CPU",
        "gpu_l4": "NVIDIA L4 (CUDA)",
        "gpu_amd": "AMD Radeon AI PRO R9700 (ROCm)",
    }[args.compute_device]
    print(f"Requested compute target: {requested_target}", flush=True)
    print(f"JAX inference backend: {actual_backend.upper()} · {devices}", flush=True)
    emit({"type": "metadata", "inferenceBackend": actual_backend, "inferenceDevice": devices})
    emit_timing("processSetup", "Process and device setup", PROCESS_STARTED)

    input_started = time.monotonic()
    state = xr.load_dataset(args.input)
    emit_timing("inputLoad", "Load prepared input", input_started)

    preparation_started = time.monotonic()
    target_times = state.time.values[-1] + np.arange(1, args.steps + 1) * np.timedelta64(6, "h")
    target = xr.concat([state.isel(time=-1).expand_dims(time=[time]) for time in target_times], dim="time")
    target = target.assign_coords(datetime=("time", target_times))
    dataset = xr.concat([state, target], dim="time").expand_dims(batch=[0])
    datetimes = dataset["datetime"].values
    lead_times = np.concatenate((np.array([np.timedelta64(-6, "h"), np.timedelta64(0, "h")]), np.arange(1, args.steps + 1) * np.timedelta64(6, "h")))
    dataset = dataset.assign_coords(time=lead_times)
    dataset = dataset.assign_coords(datetime=(("batch", "time"), datetimes[None, :]))
    emit_timing("targetPreparation", "Prepare forecast tensors", preparation_started)

    checkpoint_started = time.monotonic()
    bucket = storage.Client.create_anonymous_client().bucket("dm_graphcast")
    prefix = "graphcast/"
    name = "GraphCast_small - ERA5 1979-2015 - resolution 1.0 - pressure levels 13 - mesh 2to5 - precipitation input and output.npz"
    with bucket.blob(prefix + "params/" + name).open("rb") as file:
        loaded = checkpoint.load(file, graphcast.CheckPoint)
    stats = {}
    for stat in ("diffs_stddev_by_level", "mean_by_level", "stddev_by_level"):
        with bucket.blob(prefix + f"stats/{stat}.nc").open("rb") as file:
            stats[stat] = xr.load_dataset(file).compute()
    emit_timing("checkpointLoad", "Load checkpoint and statistics", checkpoint_started)

    extraction_started = time.monotonic()
    inputs, targets, forcings = data_utils.extract_inputs_targets_forcings(dataset, target_lead_times=slice("6h", f"{args.steps * 6}h"), **dataclasses.asdict(loaded.task_config))
    for variable in ("geopotential_at_surface", "land_sea_mask"):
        inputs[variable] = inputs[variable].isel(time=0, drop=True)
    target_template = targets * np.nan
    emit_timing("inputExtraction", "Extract model inputs and forcings", extraction_started)

    @hk.transform_with_state
    def forward(inputs: xr.Dataset, targets_template: xr.Dataset, forcings: xr.Dataset) -> xr.Dataset:
        predictor = graphcast.GraphCast(loaded.model_config, loaded.task_config)
        predictor = casting.Bfloat16Cast(predictor)
        predictor = normalization.InputsAndResiduals(predictor, **stats)
        predictor = autoregressive.Predictor(predictor, gradient_checkpointing=True)
        return predictor(inputs, targets_template=targets_template, forcings=forcings)

    run = jax.jit(functools.partial(forward.apply, loaded.params, {}))
    random_key = jax.random.PRNGKey(0)

    compilation_started = time.monotonic()
    compiled_run = run.lower(random_key, inputs, target_template, forcings).compile()
    emit_timing("jaxCompilation", "JAX lower and compile", compilation_started)

    rollout_started = time.monotonic()
    prediction, _ = compiled_run(random_key, inputs, target_template, forcings)
    synchronize(prediction, xarray_jax)
    emit_timing("modelRollout", f"GraphCast rollout ({args.steps} steps)", rollout_started)

    transfer_started = time.monotonic()
    prediction = transfer_to_host(prediction, xarray_jax)
    emit_timing("deviceToHost", "Transfer forecast to host", transfer_started)
    prediction.attrs.update(
        {
            "input_source": state.attrs.get("input_source", "ERA5T prepared analysis"),
            "input_identity": state.attrs.get("input_identity", str(args.input)),
            "checkpoint_identity": name,
            "run_kind": state.attrs.get("run_kind", "historical"),
        }
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)

    write_started = time.monotonic()
    prediction.to_netcdf(args.output)
    emit_timing("netcdfWrite", "Write native NetCDF", write_started)
    emit_timing("runnerTotal", "Inference runner total", PROCESS_STARTED)
    print(args.output)


if __name__ == "__main__":
    main()
