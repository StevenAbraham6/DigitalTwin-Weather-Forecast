"""Experimental import and structural audit for ECMWF Open Data HRES fields.

This module only tests whether the public HRES feed can supply the fields that
GraphCast Operational needs.  It never publishes a run or changes the stable
sample-data path.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr


PRESSURE_LEVELS = (50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000)
PRESSURE_VARIABLES = ("t", "z", "u", "v", "w", "q")
SURFACE_VARIABLES = ("2t", "msl", "10u", "10v", "z", "lsm")
# cfgrib exposes ECMWF short names using its xarray naming convention.
SURFACE_DATA_VARIABLES = ("t2m", "msl", "u10", "v10", "z", "lsm")


@dataclass(frozen=True)
class HresSnapshot:
    initialization: datetime
    path: Path


def download_step_zero(initialization: datetime, output_dir: Path) -> HresSnapshot:
    """Download one 0-hour HRES state from ECMWF Open Data as two GRIB files.

    This uses the public real-time endpoint.  ECMWF retains only a short
    rolling window there, so callers should choose a currently retained run.
    """
    if initialization.tzinfo is None:
        raise ValueError("initialization must include a UTC offset")
    init = initialization.astimezone(timezone.utc)
    if init.minute or init.second or init.hour not in (0, 6, 12, 18):
        raise ValueError("initialization must be exactly 00, 06, 12, or 18 UTC")
    try:
        from ecmwf.opendata import Client  # type: ignore[import-untyped]
    except ImportError as error:
        raise RuntimeError("Install the optional HRES dependencies: pip install -e '.[hres]'") from error

    root = output_dir / init.strftime("%Y%m%dT%H%MZ")
    root.mkdir(parents=True, exist_ok=True)
    existing = HresSnapshot(initialization=init, path=root)
    if (root / "surface.grib2").is_file() and (root / "pressure.grib2").is_file():
        try:
            if audit_snapshot(existing)["readyForConversion"]:
                return existing
        except Exception:
            # A failed parse causes a clean atomic re-download below.
            pass
    client = Client(source="ecmwf")
    common: dict[str, Any] = {
        "date": init.strftime("%Y-%m-%d"),
        "time": init.strftime("%H"),
        "stream": "oper",
        "type": "fc",
        "step": 0,
    }
    surface = root / "surface.grib2"
    pressure = root / "pressure.grib2"
    _retrieve_atomic(client, **common, param=list(SURFACE_VARIABLES), target=surface)
    _retrieve_atomic(
        client,
        **common,
        levtype="pl",
        levelist=list(PRESSURE_LEVELS),
        param=list(PRESSURE_VARIABLES),
        target=pressure,
    )
    return HresSnapshot(initialization=init, path=root)


def _retrieve_atomic(client: Any, *, target: Path, **request: Any) -> None:
    """Do not expose incomplete network transfers as readable GRIB files."""
    temporary = target.with_suffix(target.suffix + ".partial")
    temporary.unlink(missing_ok=True)
    client.retrieve(**request, target=str(temporary))
    temporary.replace(target)


def audit_snapshot(snapshot: HresSnapshot) -> dict[str, object]:
    """Report whether a downloaded state has the shape required for conversion.

    The audit is deliberately structural.  Passing it means only that the open
    feed delivered candidate fields; GraphCast inference remains a separate
    proof because coordinate and semantic conversion must still be implemented.
    """
    datasets = _read_grib_datasets(snapshot.path)
    variables = {name for dataset in datasets for name in dataset.data_vars}
    levels = {int(level) for dataset in datasets if "isobaricInhPa" in dataset.coords for level in dataset["isobaricInhPa"].values}
    lats = [dataset.sizes.get("latitude", 0) for dataset in datasets]
    lons = [dataset.sizes.get("longitude", 0) for dataset in datasets]
    missing_surface = sorted(set(SURFACE_DATA_VARIABLES) - variables)
    missing_pressure = sorted(set(PRESSURE_VARIABLES) - variables)
    missing_levels = sorted(set(PRESSURE_LEVELS) - levels)
    return {
        "schemaVersion": "1.0",
        "source": "ECMWF Open Data HRES, forecast step 0",
        "initializationTime": snapshot.initialization.isoformat().replace("+00:00", "Z"),
        "files": [str(path) for path in sorted(snapshot.path.glob("*.grib2"))],
        "variablesFound": sorted(variables),  # type: ignore[type-var]
        "pressureLevelsFound": sorted(levels),
        "gridCandidates": {"latitudeCounts": lats, "longitudeCounts": lons},
        "missingSurfaceDataVariables": missing_surface,
        "missingPressureShortNames": missing_pressure,
        "missingPressureLevels": missing_levels,
        "readyForConversion": not (missing_surface or missing_pressure or missing_levels),
        "nextStep": "Convert two passing snapshots six hours apart into GraphCast Operational inputs; this audit does not run inference.",
    }


def prepare_input_pair(initialization: datetime, output_dir: Path) -> Path:
    """Download two HRES-fc0 states and normalize their model-state fields.

    This writes only the physical/static input fields. GraphCast forcing fields
    and model execution are intentionally the next stage of the experiment.
    """
    current = download_step_zero(initialization, output_dir)
    previous = download_step_zero(current.initialization - timedelta(hours=6), output_dir)
    for snapshot in (previous, current):
        audit = audit_snapshot(snapshot)
        if not audit["readyForConversion"]:
            raise ValueError(f"HRES snapshot is incomplete: {snapshot.path}: {audit}")
    states = xr.concat([_canonical_snapshot(previous), _canonical_snapshot(current)], dim="time")
    target_time = states.time.values[-1] + np.timedelta64(6, "h")
    target_template = states.isel(time=-1).expand_dims(time=[target_time])
    merged = xr.concat([states, target_template], dim="time")
    merged["total_precipitation_6hr"] = xr.full_like(merged["2m_temperature"], np.nan)
    merged = merged.assign_coords(datetime=("time", merged.time.values))
    target = output_dir / f"prepared-{current.initialization.strftime('%Y%m%dT%H%MZ')}.nc"
    merged.to_netcdf(target, encoding={name: {"zlib": True, "complevel": 1} for name in merged.data_vars})
    return target


def _canonical_snapshot(snapshot: HresSnapshot) -> xr.Dataset:
    datasets = _read_grib_datasets(snapshot.path)
    arrays = {
        "2m_temperature": _field(datasets, "t2m"),
        "mean_sea_level_pressure": _field(datasets, "msl"),
        "10m_u_component_of_wind": _field(datasets, "u10"),
        "10m_v_component_of_wind": _field(datasets, "v10"),
        "temperature": _field(datasets, "t", pressure=True),
        "geopotential": _field(datasets, "z", pressure=True),
        "u_component_of_wind": _field(datasets, "u", pressure=True),
        "v_component_of_wind": _field(datasets, "v", pressure=True),
        "vertical_velocity": _field(datasets, "w", pressure=True),
        "specific_humidity": _field(datasets, "q", pressure=True),
        "geopotential_at_surface": _field(datasets, "z", pressure=False),
        "land_sea_mask": _field(datasets, "lsm"),
    }
    normalized = []
    for name, array in arrays.items():
        array = array.squeeze(drop=True).reset_coords(drop=True)
        if "isobaricInhPa" in array.dims:
            array = array.rename({"isobaricInhPa": "level"}).sel(level=list(PRESSURE_LEVELS))
        array = array.rename({"latitude": "lat", "longitude": "lon"}).sortby("lat").astype(np.float32)
        normalized.append(array.rename(name))
    return xr.merge(normalized).expand_dims(time=[np.datetime64(snapshot.initialization.replace(tzinfo=None))])


def _field(datasets: list[xr.Dataset], name: str, pressure: bool | None = None) -> xr.DataArray:
    matches = [dataset[name] for dataset in datasets if name in dataset and (pressure is None or ("isobaricInhPa" in dataset[name].dims) == pressure)]
    if pressure and len(matches) > 1:
        combined = xr.concat(matches, dim="isobaricInhPa").sortby("isobaricInhPa")
        return combined.sel(isobaricInhPa=~combined.get_index("isobaricInhPa").duplicated())
    if len(matches) != 1:
        raise ValueError(f"Expected one {'pressure-level ' if pressure else ''}field {name!r}; found {len(matches)}")
    return matches[0]


def _read_grib_datasets(root: Path) -> list[xr.Dataset]:
    try:
        import cfgrib  # type: ignore[import-untyped]
    except ImportError as error:
        raise RuntimeError("Install the optional HRES dependencies: pip install -e '.[hres]'") from error
    paths = sorted(root.glob("*.grib2"))
    if not paths:
        raise FileNotFoundError(f"No downloaded GRIB files in {root}")
    return [dataset for path in paths for dataset in cfgrib.open_datasets(str(path))]
