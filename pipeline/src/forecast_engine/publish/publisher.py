from __future__ import annotations

import hashlib
import os
import platform
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Literal, cast

import numpy as np
import xarray as xr

from forecast_engine.config import MODEL_ID, PROVIDER
from forecast_engine.publish.layers import LayerSpec, available_specs, layer_field, ui_values
from forecast_engine.schemas.contract import (
    Catalog,
    CatalogModel,
    ForecastFrame,
    ForecastManifest,
    Grid,
    Layer,
    LatestManifestPointer,
    Model,
    Provenance,
    UiSurfaceFile,
    UiSurfaceProduct,
)
from forecast_engine.transform.grid import canonical_global, latitude_name, longitude_name


def _leads(ds: xr.Dataset) -> list[int]:
    for name in ("prediction_timedelta", "lead_time", "time"):
        if name in ds.coords:
            values = ds[name].values
            if str(values.dtype).startswith("timedelta"):
                return [int(v / np.timedelta64(1, "h")) for v in values]
            if name == "time":
                continue
            return [int(v) for v in values]
    return [6]


def publish(
    native: Path,
    publish_dir: Path,
    initialization_time: datetime | None,
    run_id: str | None = None,
    *,
    initialization_state: Path | None = None,
) -> Path:
    ds = xr.open_dataset(native)
    initialization_time = initialization_time or _infer_initialization_time(ds)
    if initialization_time.tzinfo is None:
        raise ValueError("initialization_time must include a UTC offset")
    initialization_time = initialization_time.astimezone(timezone.utc)
    if initialization_state is None:
        raise ValueError(
            "initialization_state is required so the published run includes a scientifically "
            "identified T+0 analysis frame"
        )
    state_ds = xr.open_dataset(initialization_state)
    state_at_initialization = _state_at_initialization(state_ds, initialization_time)
    specs = available_specs(ds)
    if not specs:
        raise ValueError(
            "No supported GraphCast surface variables found in native output; "
            "refusing to publish invented fields."
        )
    missing_state_variables = [
        spec.variable for spec in specs if spec.variable not in state_at_initialization
    ]
    if missing_state_variables:
        raise ValueError(
            "Prepared initialization state is missing published forecast variables: "
            + ", ".join(missing_state_variables)
        )
    prediction_leads = _leads(ds)
    if not prediction_leads:
        raise ValueError("Native GraphCast output contains no prediction frames")
    if any(lead <= 0 for lead in prediction_leads):
        raise ValueError(
            "Native GraphCast predictions must have positive lead times; "
            "T+0 comes from the initialization state"
        )
    if prediction_leads != sorted(set(prediction_leads)):
        raise ValueError("Native GraphCast prediction lead times must be unique and increasing")
    if prediction_leads != list(range(6, prediction_leads[-1] + 1, 6)):
        raise ValueError(
            "Native GraphCast prediction lead times must remain consecutive six-hour steps from T+6"
        )
    leads = [0, *prediction_leads]
    first = canonical_global(layer_field(state_at_initialization, specs[0], 0))
    lat = latitude_name(first.to_dataset(name="field"))
    lon = longitude_name(first.to_dataset(name="field"))
    run_id = run_id or f"{initialization_time.strftime('%Y-%m-%dT%H-%M-%SZ')}-graphcast-small"
    relative_root = Path("models") / MODEL_ID / "runs" / run_id
    root = publish_dir / relative_root
    if root.exists():
        raise FileExistsError(f"Run already exists: {root}")
    root.mkdir(parents=True)
    native_dir = root / "native"
    native_dir.mkdir()
    shutil.copy2(native, native_dir / "forecast.nc")
    shutil.copy2(initialization_state, native_dir / "initialization.nc")
    layers: list[Layer] = []
    frames = [_analysis_frame(initialization_time, state_ds)]
    frames.extend(_prediction_frame(initialization_time, lead) for lead in prediction_leads)
    width = int(first.sizes[lon])
    height = int(first.sizes[lat])
    run_ranges: dict[str, tuple[float, float] | None] = {
        spec.ui_field: None for spec in specs
    }
    snapshot_files: list[UiSurfaceFile] = []
    snapshot_file, snapshot_ranges = _write_ui_surface(
        root, state_at_initialization, specs, frames[0], width, height
    )
    snapshot_files.append(snapshot_file)
    _merge_ranges(run_ranges, snapshot_ranges)
    for frame in frames[1:]:
        snapshot_file, snapshot_ranges = _write_ui_surface(
            root, ds, specs, frame, width, height
        )
        snapshot_files.append(snapshot_file)
        _merge_ranges(run_ranges, snapshot_ranges)
    for spec in specs:
        values_range = run_ranges[spec.ui_field]
        if values_range is None:
            values_range = (float("nan"), float("nan"))
        layers.append(
            Layer(
                id=spec.id,
                label=spec.ui_label,
                units=spec.ui_units,
                encoding="ui-grid-float32-le",
                dataTemplate="data/ui-surface/t+{leadHours}.bin",
                dataField=spec.ui_field,
                kind=spec.kind,
                sourceVariable=spec.variable,
                valueRange=values_range,
            )
        )
    manifest = ForecastManifest(
        runId=run_id,
        status="complete",
        model=Model(
            id=MODEL_ID,
            provider=PROVIDER,
            family="GraphCast",
            displayName="Google GraphCast Small",
            version=str(
                ds.attrs.get("checkpoint_identity", "official GraphCast Small checkpoint")
            ),
            resolutionDegrees=1,
            verticalPressureLevels=13,
        ),
        initializationTime=initialization_time,
        leadTimesHours=leads,
        frames=frames,
        grid=Grid(
            width=width,
            height=height,
            nativeLongitudeConvention="0..360 or -180..180; exported as -180..180",
            nativeLatitudeOrientation="preserved in native file; exported north-to-south",
        ),
        layers=layers,
        uiSurface=UiSurfaceProduct(
            fields=[spec.ui_field for spec in specs],
            units={spec.ui_field: spec.ui_units for spec in specs},
            files=snapshot_files,
        ),
        provenance=Provenance(
            inputSource=str(
                ds.attrs.get(
                    "input_source",
                    state_ds.attrs.get("input_source", "prepared initialization data"),
                )
            ),
            inputIdentity=str(
                ds.attrs.get(
                    "input_identity",
                    state_ds.attrs.get("input_identity", "prepared initialization state"),
                )
            ),
            checkpointIdentity=str(
                ds.attrs.get("checkpoint_identity", "official GraphCast Small checkpoint")
            ),
            nativeOutputPath="native/forecast.nc",
            initializationStatePath="native/initialization.nc",
            runtime=platform.platform(),
            packageVersions=_package_versions(),
            runKind=_run_kind(ds, state_ds),
        ),
    )
    _atomic_write_text(root / "manifest.json", manifest.model_dump_json(indent=2))
    ds.close()
    state_ds.close()
    from forecast_engine.publish.validate import validate_run

    validate_run(root)
    _update_index(publish_dir, run_id)
    return root


def _write_ui_surface(
    root: Path,
    ds: xr.Dataset,
    specs: list[LayerSpec],
    frame: ForecastFrame,
    width: int,
    height: int,
) -> tuple[UiSurfaceFile, dict[str, tuple[float, float] | None]]:
    lead = frame.leadHours
    ranges: dict[str, tuple[float, float] | None] = {}
    target = root / "data" / "ui-surface" / f"t+{lead}.bin"
    target.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=target.parent,
        prefix=f".{target.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "wb") as output:
            for spec in specs:
                field = canonical_global(layer_field(ds, spec, lead))
                values = ui_values(field, spec)
                if values.shape != (height, width):
                    raise ValueError(
                        f"UI field {spec.ui_field} at T+{lead} has shape {values.shape}; "
                        f"expected {(height, width)}"
                    )
                finite = np.isfinite(values)
                if np.any(finite):
                    ranges[spec.ui_field] = (
                        float(np.min(values, where=finite, initial=np.inf)),
                        float(np.max(values, where=finite, initial=-np.inf)),
                    )
                else:
                    ranges[spec.ui_field] = None
                little_endian = values.astype("<f4", copy=False)
                little_endian.reshape(-1, order="C").tofile(output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise

    byte_length = target.stat().st_size
    expected_byte_length = len(specs) * width * height * np.dtype("<f4").itemsize
    if byte_length != expected_byte_length:
        raise ValueError(
            f"UI snapshot T+{lead} is {byte_length} bytes; expected {expected_byte_length}"
        )
    relative_path = target.relative_to(root).as_posix()
    return (
        UiSurfaceFile(
            leadHours=lead,
            path=relative_path,
            byteLength=byte_length,
            sha256=_sha256(target),
        ),
        ranges,
    )


def _state_at_initialization(ds: xr.Dataset, initialization_time: datetime) -> xr.Dataset:
    desired = np.datetime64(initialization_time.astimezone(timezone.utc).replace(tzinfo=None))
    for coordinate in ("datetime", "valid_time", "time"):
        if coordinate not in ds.coords or not np.issubdtype(ds[coordinate].dtype, np.datetime64):
            continue
        values = np.asarray(ds[coordinate].values)
        matches = np.argwhere(values == desired)
        if not matches.size:
            continue
        dimensions = ds[coordinate].dims
        indexers = {dimension: int(index) for dimension, index in zip(dimensions, matches[0])}
        return ds.isel(indexers, drop=True)
    raise ValueError(
        "Prepared initialization state has no exact state at "
        f"{initialization_time.astimezone(timezone.utc).isoformat()}"
    )


def _analysis_frame(initialization_time: datetime, ds: xr.Dataset) -> ForecastFrame:
    return ForecastFrame(
        leadHours=0,
        frameType="analysis",
        source=str(ds.attrs.get("input_source", "prepared initialization state")),
        validTime=initialization_time,
        precipitationMeaning="six-hour analysis accumulation ending at T0 (T-6 through T0)",
    )


def _prediction_frame(initialization_time: datetime, lead: int) -> ForecastFrame:
    return ForecastFrame(
        leadHours=lead,
        frameType="prediction",
        source="GraphCast prediction",
        validTime=initialization_time + timedelta(hours=lead),
        precipitationMeaning=(
            f"six-hour forecast accumulation ending at T+{lead} "
            f"(T+{lead - 6} through T+{lead})"
        ),
    )


def _run_kind(ds: xr.Dataset, state_ds: xr.Dataset) -> Literal["sample_demo", "historical", "operational"]:
    value = str(ds.attrs.get("run_kind", state_ds.attrs.get("run_kind", "sample_demo")))
    if value not in {"sample_demo", "historical", "operational"}:
        raise ValueError(f"Unsupported run_kind provenance: {value}")
    return cast(Literal["sample_demo", "historical", "operational"], value)


def _merge_ranges(
    run_ranges: dict[str, tuple[float, float] | None],
    snapshot_ranges: dict[str, tuple[float, float] | None],
) -> None:
    for field, snapshot_range in snapshot_ranges.items():
        if snapshot_range is None:
            continue
        run_range = run_ranges[field]
        if run_range is None:
            run_ranges[field] = snapshot_range
        else:
            run_ranges[field] = (
                min(run_range[0], snapshot_range[0]),
                max(run_range[1], snapshot_range[1]),
            )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _infer_initialization_time(ds: xr.Dataset) -> datetime:
    """Infer from a valid-time coordinate when upstream sample data provides one."""
    if "time" not in ds.coords:
        raise ValueError("initialization time is required when native output has no time coordinate")
    value = np.asarray(ds["time"].values).reshape(-1)[0]
    valid = datetime.fromisoformat(
        np.datetime_as_string(value, unit="s").replace("Z", "+00:00")
    ).replace(tzinfo=timezone.utc)
    leads = _leads(ds)
    return valid - timedelta(hours=leads[0])


def _package_versions() -> dict[str, str]:
    versions = {"python": sys.version.split()[0], "xarray": xr.__version__}
    for package in ("jax", "dm-haiku", "graphcast", "numpy", "netCDF4"):
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            continue
    return versions


def _update_index(publish_dir: Path, run_id: str) -> None:
    latest = publish_dir / "models" / MODEL_ID / "latest"
    latest.mkdir(parents=True, exist_ok=True)
    pointer = LatestManifestPointer(
        runId=run_id,
        manifestPath=f"../runs/{run_id}/manifest.json",
    )
    catalog_path = publish_dir / "catalog.json"
    catalog = Catalog(
        models=[
            CatalogModel(
                id=MODEL_ID,
                provider=PROVIDER,
                displayName="Google GraphCast Small",
                latestManifestPath=f"models/{MODEL_ID}/latest/manifest.json",
            )
        ],
    )
    _atomic_write_text(catalog_path, catalog.model_dump_json(indent=2))
    _atomic_write_text(latest / "manifest.json", pointer.model_dump_json(indent=2))
