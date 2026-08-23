#!/usr/bin/env python3
"""Run one +6h GraphCast Operational prediction from a prepared HRES pair."""
from __future__ import annotations

import argparse
import dataclasses
import functools
import sys
from pathlib import Path

import haiku as hk
import jax
import numpy as np
import xarray as xr
from google.cloud import storage

from forecast_engine.providers.google_graphcast.artifact_cache import (
    default_artifact_cache_dir,
    ensure_cached,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--artifact-cache", type=Path, default=default_artifact_cache_dir())
    args = parser.parse_args()
    sys.path.insert(0, str(args.upstream))
    from graphcast import autoregressive, casting, checkpoint, data_utils, graphcast, normalization

    dataset = xr.load_dataset(args.input).expand_dims(batch=[0])
    datetimes = dataset["datetime"].values
    dataset = dataset.assign_coords(time=np.array([np.timedelta64(-6, "h"), np.timedelta64(0, "h"), np.timedelta64(6, "h")]))

    bucket = storage.Client.create_anonymous_client().bucket("dm_graphcast")
    prefix = "graphcast/"
    checkpoint_name = "GraphCast_operational - ERA5-HRES 1979-2021 - resolution 0.25 - pressure levels 13 - mesh 2to6 - precipitation output only.npz"
    checkpoint_path = ensure_cached(
        bucket, prefix + "params/" + checkpoint_name, args.artifact_cache
    )
    with checkpoint_path.open("rb") as file:
        loaded = checkpoint.load(file, graphcast.CheckPoint)
    stats = {}
    for name in ("diffs_stddev_by_level", "mean_by_level", "stddev_by_level"):
        stat_path = ensure_cached(bucket, prefix + f"stats/{name}.nc", args.artifact_cache)
        with stat_path.open("rb") as file:
            stats[name] = xr.load_dataset(file).compute()

    dataset = dataset.assign_coords(datetime=(("batch", "time"), datetimes[None, :]))
    inputs, targets, forcings = data_utils.extract_inputs_targets_forcings(
        dataset,
        target_lead_times="6h",
        **dataclasses.asdict(loaded.task_config),
    )
    for name in ("geopotential_at_surface", "land_sea_mask"):
        inputs[name] = inputs[name].isel(time=0, drop=True)

    def wrapped(inputs: xr.Dataset, targets_template: xr.Dataset, forcings: xr.Dataset) -> xr.Dataset:
        predictor = graphcast.GraphCast(loaded.model_config, loaded.task_config)
        predictor = casting.Bfloat16Cast(predictor)
        predictor = normalization.InputsAndResiduals(predictor, **stats)
        predictor = autoregressive.Predictor(predictor, gradient_checkpointing=True)
        return predictor(inputs, targets_template=targets_template, forcings=forcings)

    @hk.transform_with_state
    def forward(inputs: xr.Dataset, targets_template: xr.Dataset, forcings: xr.Dataset) -> xr.Dataset:
        return wrapped(inputs, targets_template, forcings)

    run = jax.jit(functools.partial(forward.apply, loaded.params, {}))
    prediction, _ = run(jax.random.PRNGKey(0), inputs, targets * np.nan, forcings)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    prediction.to_netcdf(args.output)
    print(args.output)


if __name__ == "__main__":
    main()
