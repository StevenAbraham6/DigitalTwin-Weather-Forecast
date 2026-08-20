from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from forecast_engine.config import MODEL_ID
from forecast_engine.publish.layers import LayerSpec, available_specs, layer_field, ui_values
from forecast_engine.schemas.contract import ForecastManifest, UiSurfaceFile
from forecast_engine.transform.grid import canonical_global


def validate_run(run_dir: Path) -> ForecastManifest:
    manifest_path = run_dir / "manifest.json"
    if not manifest_path.exists():
        raise ValueError(f"Missing manifest: {manifest_path}")
    manifest = ForecastManifest.model_validate(json.loads(manifest_path.read_text()))
    if manifest.schemaVersion != "2.0":
        raise ValueError(f"Unexpected manifest schema: {manifest.schemaVersion}")
    if manifest.uiSurface.encoding != "float32-le":
        raise ValueError(f"Unexpected UI surface encoding: {manifest.uiSurface.encoding}")
    if manifest.model.id != MODEL_ID:
        raise ValueError(f"Unexpected model id: {manifest.model.id}")
    if manifest.initializationTime.tzinfo is None:
        raise ValueError("initializationTime must include a UTC offset")
    if not manifest.leadTimesHours or manifest.leadTimesHours[0] != 0:
        raise ValueError("Lead times must begin with 0")
    if manifest.grid.latitudeRange != (90.0, -90.0):
        raise ValueError("Export latitude orientation must be +90 to -90")
    if manifest.grid.longitudeRange != (-180.0, 180.0):
        raise ValueError("Export longitude range must be -180 to +180")

    native_path = run_dir / manifest.provenance.nativeOutputPath
    initialization_path = run_dir / manifest.provenance.initializationStatePath
    if not native_path.is_file():
        raise ValueError("Native output path missing")
    if not initialization_path.is_file():
        raise ValueError("Initialization state path missing")

    surface_dir = run_dir / "data" / "ui-surface"
    json_snapshots = sorted(surface_dir.glob("*.json"))
    if json_snapshots:
        raise ValueError(f"JSON UI surface snapshots are forbidden: {json_snapshots[0]}")
    expected_paths = {run_dir / file.path for file in manifest.uiSurface.files}
    actual_paths = set(surface_dir.glob("*.bin"))
    if actual_paths != expected_paths:
        missing = sorted(str(path) for path in expected_paths - actual_paths)
        extra = sorted(str(path) for path in actual_paths - expected_paths)
        raise ValueError(f"UI surface binary set mismatch; missing={missing}, extra={extra}")

    values_per_field = manifest.grid.width * manifest.grid.height
    expected_byte_length = (
        values_per_field * len(manifest.uiSurface.fields) * manifest.uiSurface.bytesPerValue
    )
    for file in manifest.uiSurface.files:
        _validate_file_metadata(run_dir, file, expected_byte_length)

    with xr.open_dataset(native_path) as predictions, xr.open_dataset(
        initialization_path
    ) as initialization:
        specs = available_specs(predictions)
        expected_fields = [spec.ui_field for spec in specs]
        if not specs:
            raise ValueError("Native output contains no supported UI surface fields")
        if manifest.uiSurface.fields != expected_fields:
            raise ValueError(
                "uiSurface.fields do not match all available native fields in deterministic order"
            )
        if [layer.sourceVariable for layer in manifest.layers] != [
            spec.variable for spec in specs
        ]:
            raise ValueError("Layer source variables do not match available native fields")
        expected_units = {spec.ui_field: spec.ui_units for spec in specs}
        if manifest.uiSurface.units != expected_units:
            raise ValueError("UI surface units do not match unit-converted source fields")
        missing_initialization_fields = [
            spec.variable for spec in specs if spec.variable not in initialization
        ]
        if missing_initialization_fields:
            raise ValueError(
                "Initialization state is missing UI surface fields: "
                + ", ".join(missing_initialization_fields)
            )
        prediction_leads = _leads(predictions)
        if prediction_leads != manifest.leadTimesHours[1:]:
            raise ValueError("Manifest prediction leads do not match native NetCDF leads")
        state = _state_at_initialization(initialization, manifest.initializationTime)
        files_by_lead = {file.leadHours: file for file in manifest.uiSurface.files}
        for lead in manifest.leadTimesHours:
            source = state if lead == 0 else predictions
            _validate_snapshot_values(
                run_dir / files_by_lead[lead].path,
                source,
                specs,
                lead,
                manifest.grid.width,
                manifest.grid.height,
            )
    return manifest


def _validate_file_metadata(
    run_dir: Path, file: UiSurfaceFile, expected_byte_length: int
) -> None:
    data_path = run_dir / file.path
    if not data_path.is_file():
        raise ValueError(f"Missing UI surface data: {data_path}")
    actual_byte_length = data_path.stat().st_size
    if actual_byte_length != expected_byte_length:
        raise ValueError(
            f"Wrong byte length for {data_path}: {actual_byte_length}; "
            f"expected {expected_byte_length}"
        )
    if file.byteLength != actual_byte_length:
        raise ValueError(f"Manifest byte length does not match {data_path}")
    actual_sha256 = _sha256(data_path)
    if file.sha256 != actual_sha256:
        raise ValueError(f"SHA-256 mismatch for {data_path}")


def _validate_snapshot_values(
    data_path: Path,
    source: xr.Dataset,
    specs: list[LayerSpec],
    lead: int,
    width: int,
    height: int,
) -> None:
    values_per_field = width * height
    decoded = np.memmap(data_path, dtype="<f4", mode="r")
    expected_value_count = values_per_field * len(specs)
    if decoded.size != expected_value_count:
        raise ValueError(
            f"Wrong Float32 value count in {data_path}: {decoded.size}; "
            f"expected {expected_value_count}"
        )
    for field_index, spec in enumerate(specs):
        field = canonical_global(layer_field(source, spec, lead))
        expected_values = ui_values(field, spec)
        if expected_values.shape != (height, width):
            raise ValueError(
                f"Source field {spec.ui_field} at T+{lead} has shape {expected_values.shape}; "
                f"expected {(height, width)}"
            )
        expected = expected_values.astype("<f4", copy=False).reshape(-1, order="C")
        offset = field_index * values_per_field
        actual = decoded[offset : offset + values_per_field]
        if actual.size != values_per_field:
            raise ValueError(f"Wrong value count for {spec.ui_field} in {data_path}")
        if not np.array_equal(np.isnan(actual), np.isnan(expected)):
            raise ValueError(f"NaN locations differ for {spec.ui_field} in {data_path}")
        finite = np.isfinite(expected)
        if not np.array_equal(np.isfinite(actual), finite):
            raise ValueError(f"Finite-value locations differ for {spec.ui_field} in {data_path}")
        if not np.allclose(actual[finite], expected[finite], rtol=5e-7, atol=1e-6):
            raise ValueError(f"Float32 values differ for {spec.ui_field} in {data_path}")
        infinite = np.isinf(expected)
        if not np.array_equal(actual[infinite], expected[infinite]):
            raise ValueError(f"Infinite values differ for {spec.ui_field} in {data_path}")


def _leads(ds: xr.Dataset) -> list[int]:
    for name in ("prediction_timedelta", "lead_time", "time"):
        if name in ds.coords:
            values = ds[name].values
            if str(values.dtype).startswith("timedelta"):
                return [int(value / np.timedelta64(1, "h")) for value in values]
            if name == "time":
                continue
            return [int(value) for value in values]
    return [6]


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
        indexers = {
            dimension: int(index) for dimension, index in zip(dimensions, matches[0])
        }
        return ds.isel(indexers, drop=True)
    raise ValueError(
        "Initialization state has no exact source frame at "
        f"{initialization_time.astimezone(timezone.utc).isoformat()}"
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
