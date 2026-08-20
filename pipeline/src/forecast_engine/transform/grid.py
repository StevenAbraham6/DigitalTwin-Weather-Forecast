from __future__ import annotations

import numpy as np
import xarray as xr


def longitude_name(dataset: xr.Dataset) -> str:
    for name in ("longitude", "lon"):
        if name in dataset.coords:
            return name
    return _missing("longitude")


def latitude_name(dataset: xr.Dataset) -> str:
    for name in ("latitude", "lat"):
        if name in dataset.coords:
            return name
    return _missing("latitude")


def _missing(name: str) -> str:
    raise ValueError(f"Native dataset must have a {name}/lon coordinate")


def canonical_global(da: xr.DataArray) -> xr.DataArray:
    """Return latitude north-to-south and longitude -180..179, with duplicate seam removed."""
    lat, lon = latitude_name(da.to_dataset(name="field")), longitude_name(da.to_dataset(name="field"))
    out = da.assign_coords({lon: ((da[lon] + 180) % 360) - 180}).sortby(lon)
    values = out[lon].values
    _, unique_index = np.unique(np.round(values, decimals=8), return_index=True)
    if len(unique_index) != len(values):
        out = out.isel({lon: np.sort(unique_index)})
    if float(out[lat].values[0]) < float(out[lat].values[-1]):
        out = out.sortby(lat, ascending=False)
    return out


def select_lead(da: xr.DataArray, lead_hours: int) -> xr.DataArray:
    for name in ("prediction_timedelta", "lead_time", "time"):
        if name not in da.dims and name not in da.coords:
            continue
        values = da[name]
        if np.issubdtype(values.dtype, np.timedelta64):
            desired = np.timedelta64(lead_hours, "h")
            return da.sel({name: desired}, method="nearest")
        if name == "lead_time":
            return da.sel({name: lead_hours}, method="nearest")
    if "time" in da.dims:
        return da.isel(time=min(lead_hours // 6, da.sizes["time"] - 1))
    return da
