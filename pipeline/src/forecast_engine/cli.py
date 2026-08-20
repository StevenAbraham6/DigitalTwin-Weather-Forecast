from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import overload

import typer
import xarray as xr

from forecast_engine.config import default_cache_dir
from forecast_engine.providers.google_graphcast import run_official_sample
from forecast_engine.publish import publish as publish_run
from forecast_engine.publish import validate_run
from forecast_engine.publish.layers import SPECS
from forecast_engine.transform.grid import latitude_name, longitude_name, select_lead

app = typer.Typer(no_args_is_help=True, help="Digital Twin Earth forecast engine")

_SPEC_BY_VARIABLE = {spec.variable: spec for spec in SPECS}
_KNOWN_UNITS = {
    "temperature": "K",
    "geopotential": "m2 s-2",
    "u_component_of_wind": "m s-1",
    "v_component_of_wind": "m s-1",
    "vertical_velocity": "Pa s-1",
    "specific_humidity": "kg kg-1",
}


@app.command("run-sample")
def run_sample(output_dir: Path = typer.Option(Path("output/sample-run")), cache_dir: Path = typer.Option(default_cache_dir())) -> None:
    """Run upstream GraphCast Small sample demo; not a current forecast."""
    output = run_official_sample(output_dir, cache_dir)
    typer.echo(output)


@app.command()
def publish(
    native: Path = typer.Option(..., exists=True),
    initialization_state: Path = typer.Option(..., exists=True, help="Prepared input containing the exact T0 state."),
    publish_dir: Path = typer.Option(...),
    initialization_time: str | None = typer.Option(None, help="UTC initialization as RFC 3339, e.g. 2022-01-01T06:00:00Z."),
    run_id: str | None = typer.Option(None),
) -> None:
    """Publish a sample GraphCast NetCDF output through the shared contract."""
    typer.echo(
        publish_native(
            native,
            publish_dir,
            _parse_timestamp(initialization_time),
            run_id,
            initialization_state=initialization_state,
        )
    )


def publish_native(
    native: Path,
    publish_dir: Path,
    initialization_time: datetime | None,
    run_id: str | None,
    *,
    initialization_state: Path | None = None,
) -> Path:
    return publish_run(
        native,
        publish_dir,
        initialization_time,
        run_id,
        initialization_state=initialization_state,
    )


@overload
def _parse_timestamp(value: str) -> datetime: ...


@overload
def _parse_timestamp(value: None) -> None: ...


def _parse_timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise typer.BadParameter("must be RFC 3339, for example 2022-01-01T06:00:00Z") from error
    if parsed.tzinfo is None:
        raise typer.BadParameter("must include a UTC offset, for example 2022-01-01T06:00:00Z")
    return parsed.astimezone(timezone.utc)


@app.command("validate-run")
def validate_run_command(run_dir: Path = typer.Option(..., exists=True)) -> None:
    manifest = validate_run(run_dir)
    typer.echo(f"valid: {manifest.runId} ({len(manifest.layers)} layers)")


@app.command("list-variables")
def list_variables(native: Path = typer.Option(..., exists=True)) -> None:
    """List variables available in a native forecast file."""
    dataset = xr.open_dataset(native)
    variables = []
    for name, da in dataset.data_vars.items():
        variables.append(
            {
                "name": name,
                "dims": list(da.dims),
                "shape": list(da.shape),
                "units": _units_for(name, da),
                "publishedLayer": _SPEC_BY_VARIABLE[name].id if name in _SPEC_BY_VARIABLE else None,
                "uiField": _SPEC_BY_VARIABLE[name].ui_field if name in _SPEC_BY_VARIABLE else None,
            }
        )
    typer.echo(json.dumps({"native": str(native), "variables": variables}, indent=2))


@app.command("hres-audit")
def hres_audit(
    initialization_time: str = typer.Option(..., help="UTC HRES run, e.g. 2026-07-10T12:00:00Z."),
    output_dir: Path = typer.Option(Path("output/hres-import-test")),
) -> None:
    """Experimental: download and structurally audit one HRES-fc0 snapshot.

    It is isolated from run-sample/publish and does not claim GraphCast
    compatibility until the subsequent conversion and inference stages pass.
    """
    from forecast_engine.ingest.hres_open_data import audit_snapshot, download_step_zero

    snapshot = download_step_zero(_parse_timestamp(initialization_time), output_dir)
    typer.echo(json.dumps(audit_snapshot(snapshot), indent=2))


@app.command("hres-prepare")
def hres_prepare(
    initialization_time: str = typer.Option(..., help="UTC HRES run, e.g. 2026-07-10T12:00:00Z."),
    output_dir: Path = typer.Option(Path("output/hres-import-test")),
) -> None:
    """Experimental: prepare two 6-hour HRES states for GraphCast Operational."""
    from forecast_engine.ingest.hres_open_data import prepare_input_pair

    typer.echo(prepare_input_pair(_parse_timestamp(initialization_time), output_dir))


@app.command("era5t-status")
def era5t_status() -> None:
    """Report the latest ERA5T timestamp advertised by the authenticated CDS."""
    from forecast_engine.ingest.era5t import latest_available

    typer.echo(latest_available().isoformat().replace("+00:00", "Z"))


@app.command("era5t-retrieve")
def era5t_retrieve(
    initialization_time: str = typer.Option(..., help="UTC ERA5T analysis, e.g. 2026-07-04T00:00:00Z."),
    output_dir: Path = typer.Option(Path("output/era5t-graphcast-small")),
) -> None:
    """Experimental: retrieve the two ERA5T states for GraphCast Small preparation."""
    from forecast_engine.ingest.era5t import retrieve_pair

    pressure, surface, precipitation = retrieve_pair(_parse_timestamp(initialization_time), output_dir)
    typer.echo(json.dumps({"pressure": str(pressure), "surface": str(surface), "precipitation": str(precipitation)}, indent=2))


@app.command("era5t-retrieve-precipitation")
def era5t_retrieve_precipitation(
    initialization_time: str = typer.Option(..., help="UTC ERA5T analysis, e.g. 2026-07-04T00:00:00Z."),
    output_dir: Path = typer.Option(Path("output/era5t-graphcast-small")),
) -> None:
    """Retrieve the hourly total-precipitation source needed for GraphCast Small."""
    from forecast_engine.ingest.era5t import retrieve_precipitation

    typer.echo(retrieve_precipitation(_parse_timestamp(initialization_time), output_dir))


@app.command("era5t-retrieve-surface")
def era5t_retrieve_surface(
    initialization_time: str = typer.Option(..., help="UTC ERA5T analysis, e.g. 2026-07-04T00:00:00Z."),
    output_dir: Path = typer.Option(Path("output/era5t-graphcast-small")),
) -> None:
    """Retrieve the two ERA5T surface states for GraphCast Small."""
    from forecast_engine.ingest.era5t import retrieve_surface_states

    typer.echo(retrieve_surface_states(_parse_timestamp(initialization_time), output_dir))


@app.command("era5t-prepare")
def era5t_prepare(
    initialization_time: str = typer.Option(..., help="UTC ERA5T analysis, e.g. 2026-07-04T00:00:00Z."),
    output_dir: Path = typer.Option(Path("output/era5t-graphcast-small")),
) -> None:
    """Prepare downloaded ERA5T data for the 1-degree GraphCast Small checkpoint."""
    from forecast_engine.ingest.era5t import prepare_graphcast_small

    typer.echo(prepare_graphcast_small(_parse_timestamp(initialization_time), output_dir))


@app.command("sample-city")
def sample_city(native: Path = typer.Option(..., exists=True), latitude: float = typer.Option(..., min=-90, max=90), longitude: float = typer.Option(..., min=-180, max=180), lead_hours: int = typer.Option(..., min=0), variable: str = typer.Option("2m_temperature")) -> None:
    """Bilinearly sample a native field from NetCDF."""
    dataset = xr.open_dataset(native)
    if variable not in dataset:
        available = ", ".join(str(name) for name in dataset.data_vars)
        raise typer.BadParameter(f"{variable!r} is not in native output. Available: {available}")
    da = select_lead(dataset[variable], lead_hours)
    spatial_dims = {latitude_name(dataset), longitude_name(dataset), "batch"}
    remaining_dims = [str(dim) for dim in da.dims if dim not in spatial_dims]
    if remaining_dims:
        raise typer.BadParameter(f"{variable!r} still has non-surface dimensions after lead selection: {', '.join(remaining_dims)}. Choose a 2D surface variable for city sampling.")
    lat_name, lon_name = latitude_name(dataset), longitude_name(dataset)
    wrapped_lon = longitude % 360 if float(da[lon_name].max()) > 180 else longitude
    result = da.interp({lat_name: latitude, lon_name: wrapped_lon}, method="linear")
    typer.echo(json.dumps({"variable": variable, "value": float(result.squeeze(drop=True).values), "units": _units_for(variable, da), "latitude": latitude, "longitude": longitude, "leadHours": lead_hours}))


def _units_for(variable: str, da: xr.DataArray) -> str:
    if "units" in da.attrs:
        return str(da.attrs["units"])
    if variable in _SPEC_BY_VARIABLE:
        return _SPEC_BY_VARIABLE[variable].units
    return _KNOWN_UNITS.get(variable, "unknown")


if __name__ == "__main__":
    app()
