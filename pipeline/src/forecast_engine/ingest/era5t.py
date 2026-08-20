"""ERA5T retrieval and preparation boundary for the 1-degree GraphCast Small path.

This is deliberately separate from the HRES Operational experiment. ERA5T is a
delayed reanalysis source; every prepared artifact records its source time.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import zipfile

import numpy as np
import xarray as xr


PRESSURE_LEVELS = (50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000)
PRESSURE_VARIABLES = (
    "temperature",
    "geopotential",
    "u_component_of_wind",
    "v_component_of_wind",
    "vertical_velocity",
    "specific_humidity",
)
SURFACE_VARIABLES = (
    "2m_temperature",
    "mean_sea_level_pressure",
    "10m_u_component_of_wind",
    "10m_v_component_of_wind",
    "geopotential",
    "land_sea_mask",
    "total_precipitation",
)


def latest_available() -> datetime:
    """Return the latest ERA5 pressure-level timestamp advertised by CDS."""
    try:
        import cdsapi  # type: ignore[import-untyped]
    except ImportError as error:
        raise RuntimeError("Install ERA5 support: pip install -e '.[era5]'") from error
    payload = cdsapi.Client(quiet=True).client.get_collection("reanalysis-era5-pressure-levels").response.json()
    value = payload["extent"]["temporal"]["interval"][0][1]
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def retrieve_pair(initialization: datetime, output_dir: Path) -> tuple[Path, Path, Path]:
    """Retrieve the two six-hourly ERA5T states needed by GraphCast Small.

    The request is intentionally retrieval-only: precipitation accumulation and
    1-degree coordinate normalization are validated in the next preparation
    stage, rather than guessed during download.
    """
    try:
        import cdsapi
    except ImportError as error:
        raise RuntimeError("Install ERA5 support: pip install -e '.[era5]'") from error
    if initialization.tzinfo is None:
        raise ValueError("initialization must include a UTC offset")
    init = initialization.astimezone(timezone.utc)
    if init.hour not in (0, 6, 12, 18) or init.minute or init.second:
        raise ValueError("initialization must be exactly 00, 06, 12, or 18 UTC")
    available = latest_available()
    if init > available:
        raise ValueError(f"ERA5T is only available through {available.isoformat()}")
    root = output_dir / init.strftime("%Y%m%dT%H%MZ")
    root.mkdir(parents=True, exist_ok=True)
    times = [init - timedelta(hours=6), init]
    precipitation_start = init - timedelta(hours=12)
    precipitation_times = [precipitation_start + timedelta(hours=offset) for offset in range(13)]
    request = {
        "product_type": "reanalysis",
        "year": sorted({str(time.year) for time in times}),
        "month": sorted({f"{time.month:02d}" for time in times}),
        "day": sorted({f"{time.day:02d}" for time in times}),
        "time": [f"{time.hour:02d}:00" for time in times],
        "data_format": "netcdf",
    }
    client = cdsapi.Client(quiet=False)
    pressure = root / "pressure.nc"
    surface = root / "surface.nc"
    precipitation = root / "precipitation-hourly.nc"
    client.retrieve(
        "reanalysis-era5-pressure-levels",
        request | {"variable": list(PRESSURE_VARIABLES), "pressure_level": [str(level) for level in PRESSURE_LEVELS]},
        str(pressure),
    )
    client.retrieve("reanalysis-era5-single-levels", request | {"variable": list(SURFACE_VARIABLES)}, str(surface))
    precipitation_request = {
        "product_type": "reanalysis",
        "year": sorted({str(time.year) for time in precipitation_times}),
        "month": sorted({f"{time.month:02d}" for time in precipitation_times}),
        "day": sorted({f"{time.day:02d}" for time in precipitation_times}),
        "time": [f"{hour:02d}:00" for hour in range(24)],
        "data_format": "netcdf",
        "variable": ["total_precipitation"],
    }
    client.retrieve("reanalysis-era5-single-levels", precipitation_request, str(precipitation))
    return pressure, surface, precipitation


def retrieve_precipitation(initialization: datetime, output_dir: Path) -> Path:
    """Retrieve hourly precipitation independently of the larger state request."""
    try:
        import cdsapi
    except ImportError as error:
        raise RuntimeError("Install ERA5 support: pip install -e '.[era5]'") from error
    init = initialization.astimezone(timezone.utc)
    source_times = [init - timedelta(hours=12) + timedelta(hours=offset) for offset in range(13)]
    target = output_dir / init.strftime("%Y%m%dT%H%MZ") / "precipitation-hourly.nc"
    target.parent.mkdir(parents=True, exist_ok=True)
    request = {
        "product_type": "reanalysis",
        "year": sorted({str(time.year) for time in source_times}),
        "month": sorted({f"{time.month:02d}" for time in source_times}),
        "day": sorted({f"{time.day:02d}" for time in source_times}),
        "time": [f"{hour:02d}:00" for hour in range(24)],
        "data_format": "netcdf",
        "variable": ["total_precipitation"],
    }
    cdsapi.Client(quiet=False).retrieve("reanalysis-era5-single-levels", request, str(target))
    return target


def retrieve_surface_states(initialization: datetime, output_dir: Path) -> Path:
    """Retrieve the two surface-state snapshots separately from precipitation."""
    try:
        import cdsapi
    except ImportError as error:
        raise RuntimeError("Install ERA5 support: pip install -e '.[era5]'") from error
    init = initialization.astimezone(timezone.utc)
    times = [init - timedelta(hours=6), init]
    target = output_dir / init.strftime("%Y%m%dT%H%MZ") / "surface.nc"
    target.parent.mkdir(parents=True, exist_ok=True)
    request = {
        "product_type": "reanalysis",
        "year": sorted({str(time.year) for time in times}),
        "month": sorted({f"{time.month:02d}" for time in times}),
        "day": sorted({f"{time.day:02d}" for time in times}),
        "time": ["00:00", "18:00"],
        "data_format": "netcdf",
        "variable": list(SURFACE_VARIABLES[:-1]),
    }
    cdsapi.Client(quiet=False).retrieve("reanalysis-era5-single-levels", request, str(target))
    return target


def prepare_graphcast_small(initialization: datetime, output_dir: Path) -> Path:
    """Create a 1-degree GraphCast Small state pair from downloaded ERA5T files."""
    init = initialization.astimezone(timezone.utc)
    root = output_dir / init.strftime("%Y%m%dT%H%MZ")
    pressure = _open_cds_dataset(root / "pressure.nc").rename({"valid_time": "time", "pressure_level": "level"})
    surface = _open_cds_dataset(root / "surface.nc").rename({"valid_time": "time"})
    precipitation = _open_cds_dataset(root / "precipitation-hourly.nc").rename({"valid_time": "time"})
    states = np.array([np.datetime64(init.replace(tzinfo=None) - timedelta(hours=6)), np.datetime64(init.replace(tzinfo=None))])
    pressure = pressure.sel(time=states, level=list(PRESSURE_LEVELS))
    surface = surface.sel(time=states)
    target_lat = np.arange(-90.0, 91.0, 1.0)
    target_lon = np.arange(0.0, 360.0, 1.0)

    def grid(dataset: xr.Dataset) -> xr.Dataset:
        return dataset.sortby("latitude").interp(latitude=target_lat, longitude=target_lon).rename({"latitude": "lat", "longitude": "lon"})

    pressure = grid(pressure)
    surface = grid(surface)
    rain = []
    for state in states:
        end = np.datetime64(state)
        begin = end - np.timedelta64(5, "h")
        six_hour = precipitation["tp"].sel(time=slice(begin, end)).sum("time")
        rain.append(grid(six_hour.to_dataset(name="total_precipitation_6hr"))["total_precipitation_6hr"].expand_dims(time=[end]))
    rainfall = xr.concat(rain, dim="time")
    output = xr.Dataset(
        {
            "2m_temperature": surface["t2m"],
            "mean_sea_level_pressure": surface["msl"],
            "10m_u_component_of_wind": surface["u10"],
            "10m_v_component_of_wind": surface["v10"],
            "geopotential_at_surface": surface["z"],
            "land_sea_mask": surface["lsm"],
            "total_precipitation_6hr": rainfall,
            "temperature": pressure["t"],
            "geopotential": pressure["z"],
            "u_component_of_wind": pressure["u"],
            "v_component_of_wind": pressure["v"],
            "vertical_velocity": pressure["w"],
            "specific_humidity": pressure["q"],
        }
    ).astype(np.float32)
    output = output.assign_coords(datetime=("time", output.time.values))
    output.attrs.update(
        {
            "input_source": "ERA5T prepared analysis",
            "input_identity": f"ERA5T analysis initialized {init.isoformat()}",
            "initialization_time": init.isoformat(),
            "run_kind": "historical",
            "total_precipitation_6hr_at_t0": (
                "six-hour observed accumulation ending at initialization time (T-6 through T0)"
            ),
        }
    )
    target = root / "prepared-graphcast-small-1deg.nc"
    output.to_netcdf(target, encoding={name: {"zlib": True, "complevel": 1} for name in output.data_vars})
    return target


def _open_cds_dataset(path: Path) -> xr.Dataset:
    """Open CDS NetCDF output, unpacking its occasional one-file ZIP wrapper."""
    if not zipfile.is_zipfile(path):
        return xr.open_dataset(path)
    with zipfile.ZipFile(path) as archive:
        members = [member for member in archive.namelist() if member.endswith(".nc")]
        if not members:
            raise ValueError(f"No NetCDF member in {path}")
        datasets = []
        for index, member in enumerate(members):
            extracted = path.with_name(f"{path.stem}-extracted-{index}.nc")
            extracted.write_bytes(archive.read(member))
            datasets.append(xr.open_dataset(extracted))
    return xr.merge(datasets, compat="override")
