#!/usr/bin/env python3
"""Run one +6h GraphCast Small prediction from prepared ERA5T data."""
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=1, help="Number of six-hour forecast intervals.")
    args = parser.parse_args()
    sys.path.insert(0, str(args.upstream))
    from graphcast import autoregressive, casting, checkpoint, data_utils, graphcast, normalization

    if args.steps < 1:
        raise ValueError("--steps must be positive")
    state = xr.load_dataset(args.input)
    target_times = state.time.values[-1] + np.arange(1, args.steps + 1) * np.timedelta64(6, "h")
    target = xr.concat([state.isel(time=-1).expand_dims(time=[time]) for time in target_times], dim="time")
    target = target.assign_coords(datetime=("time", target_times))
    dataset = xr.concat([state, target], dim="time").expand_dims(batch=[0])
    datetimes = dataset["datetime"].values
    lead_times = np.concatenate((np.array([np.timedelta64(-6, "h"), np.timedelta64(0, "h")]), np.arange(1, args.steps + 1) * np.timedelta64(6, "h")))
    dataset = dataset.assign_coords(time=lead_times)
    dataset = dataset.assign_coords(datetime=(("batch", "time"), datetimes[None, :]))

    bucket = storage.Client.create_anonymous_client().bucket("dm_graphcast")
    prefix = "graphcast/"
    name = "GraphCast_small - ERA5 1979-2015 - resolution 1.0 - pressure levels 13 - mesh 2to5 - precipitation input and output.npz"
    with bucket.blob(prefix + "params/" + name).open("rb") as file:
        loaded = checkpoint.load(file, graphcast.CheckPoint)
    stats = {}
    for stat in ("diffs_stddev_by_level", "mean_by_level", "stddev_by_level"):
        with bucket.blob(prefix + f"stats/{stat}.nc").open("rb") as file:
            stats[stat] = xr.load_dataset(file).compute()
    inputs, targets, forcings = data_utils.extract_inputs_targets_forcings(dataset, target_lead_times=slice("6h", f"{args.steps * 6}h"), **dataclasses.asdict(loaded.task_config))
    for variable in ("geopotential_at_surface", "land_sea_mask"):
        inputs[variable] = inputs[variable].isel(time=0, drop=True)

    @hk.transform_with_state
    def forward(inputs: xr.Dataset, targets_template: xr.Dataset, forcings: xr.Dataset) -> xr.Dataset:
        predictor = graphcast.GraphCast(loaded.model_config, loaded.task_config)
        predictor = casting.Bfloat16Cast(predictor)
        predictor = normalization.InputsAndResiduals(predictor, **stats)
        predictor = autoregressive.Predictor(predictor, gradient_checkpointing=True)
        return predictor(inputs, targets_template=targets_template, forcings=forcings)

    run = jax.jit(functools.partial(forward.apply, loaded.params, {}))
    prediction, _ = run(jax.random.PRNGKey(0), inputs, targets * np.nan, forcings)
    prediction.attrs.update(
        {
            "input_source": state.attrs.get("input_source", "ERA5T prepared analysis"),
            "input_identity": state.attrs.get("input_identity", str(args.input)),
            "checkpoint_identity": name,
            "run_kind": state.attrs.get("run_kind", "historical"),
        }
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    prediction.to_netcdf(args.output)
    print(args.output)


if __name__ == "__main__":
    main()
