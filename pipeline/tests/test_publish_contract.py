import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
import xarray as xr

import forecast_engine.publish.publisher as publisher_module
from forecast_engine.publish.publisher import publish
from forecast_engine.publish.validate import validate_run


INITIALIZATION = datetime(2026, 7, 10, tzinfo=UTC)
FIELDS = ["temperature", "rain", "pressure", "windU", "windV"]


def _write_initialization_state(path: Path) -> None:
    lat = np.array([-90.0, 0.0, 90.0])
    lon = np.array([0.0, 120.0, 240.0, 360.0])
    times = np.array(
        [
            np.datetime64((INITIALIZATION - timedelta(hours=6)).replace(tzinfo=None), "ns"),
            np.datetime64(INITIALIZATION.replace(tzinfo=None), "ns"),
        ]
    )
    shape = (2, 3, 4)
    t0_temperature = np.full((3, 4), 290.0)
    t0_temperature[2, 1] = np.nan
    temperature = np.stack([np.full((3, 4), 275.0), t0_temperature])
    ds = xr.Dataset(
        {
            "2m_temperature": (("time", "lat", "lon"), temperature),
            "total_precipitation_6hr": (
                ("time", "lat", "lon"),
                np.stack([np.full((3, 4), 0.001), np.full((3, 4), 0.002)]),
            ),
            "mean_sea_level_pressure": (("time", "lat", "lon"), np.full(shape, 101_000.0)),
            "10m_u_component_of_wind": (("time", "lat", "lon"), np.full(shape, 2.0)),
            "10m_v_component_of_wind": (("time", "lat", "lon"), np.full(shape, -2.0)),
        },
        coords={"time": times, "datetime": ("time", times), "lat": lat, "lon": lon},
        attrs={
            "input_source": "ERA5T prepared analysis",
            "input_identity": "ERA5T test fixture",
            "run_kind": "historical",
        },
    )
    ds.to_netcdf(path)


def _write_predictions(path: Path, steps: int) -> None:
    lat = np.array([-90.0, 0.0, 90.0])
    lon = np.array([0.0, 120.0, 240.0, 360.0])
    leads = (np.arange(1, steps + 1) * np.timedelta64(6, "h")).astype("timedelta64[ns]")
    shape = (steps, 3, 4)
    lead_index = np.arange(steps, dtype=float)[:, None, None]
    ds = xr.Dataset(
        {
            "2m_temperature": (
                ("prediction_timedelta", "lat", "lon"),
                np.broadcast_to(300.0 + lead_index, shape),
            ),
            "total_precipitation_6hr": (
                ("prediction_timedelta", "lat", "lon"),
                np.broadcast_to(0.01 + lead_index / 100.0, shape),
            ),
            "mean_sea_level_pressure": (
                ("prediction_timedelta", "lat", "lon"),
                np.full(shape, 100_000.0),
            ),
            "10m_u_component_of_wind": (
                ("prediction_timedelta", "lat", "lon"),
                np.full(shape, 5.0),
            ),
            "10m_v_component_of_wind": (
                ("prediction_timedelta", "lat", "lon"),
                np.full(shape, -5.0),
            ),
        },
        coords={"prediction_timedelta": leads, "lat": lat, "lon": lon},
        attrs={
            "input_source": "ERA5T prepared analysis",
            "input_identity": "ERA5T test fixture",
            "checkpoint_identity": "GraphCast Small test checkpoint",
            "run_kind": "historical",
        },
    )
    ds.to_netcdf(path)


def _publish_fixture(tmp_path: Path, steps: int, run_id: str | None = None) -> Path:
    native = tmp_path / "forecast.nc"
    initialization_state = tmp_path / "prepared.nc"
    _write_predictions(native, steps)
    _write_initialization_state(initialization_state)
    return publish(
        native,
        tmp_path / "forecasts",
        INITIALIZATION,
        run_id=run_id,
        initialization_state=initialization_state,
    )


def _field_values(path: Path, field: str, values_per_field: int = 9) -> np.ndarray:
    field_index = FIELDS.index(field)
    decoded = np.fromfile(path, dtype="<f4")
    offset = field_index * values_per_field
    return decoded[offset : offset + values_per_field]


@pytest.mark.parametrize(("steps", "expected_leads"), [(1, [0, 6]), (3, [0, 6, 12, 18])])
def test_publish_and_validate_one_and_multi_step(
    tmp_path: Path, steps: int, expected_leads: list[int]
) -> None:
    root = _publish_fixture(tmp_path, steps)
    manifest = validate_run(root)

    assert manifest.schemaVersion == "2.0"
    assert manifest.leadTimesHours == expected_leads
    assert [frame.frameType for frame in manifest.frames] == ["analysis"] + [
        "prediction"
    ] * steps
    assert manifest.grid.width == 3
    assert manifest.grid.height == 3
    assert [layer.dataField for layer in manifest.layers] == FIELDS
    assert all(layer.encoding == "ui-grid-float32-le" for layer in manifest.layers)
    assert manifest.uiSurface.model_dump(exclude={"files"}) == {
        "id": "ui-surface",
        "encoding": "float32-le",
        "pathTemplate": "data/ui-surface/t+{leadHours}.bin",
        "layout": "field-major",
        "fields": FIELDS,
        "bytesPerValue": 4,
        "gridOrder": "row-major: north-to-south, west-to-east",
        "noData": "IEEE-754 NaN",
        "units": {
            "temperature": "C",
            "rain": "mm per 6 h",
            "pressure": "hPa",
            "windU": "m s-1",
            "windV": "m s-1",
        },
    }
    assert manifest.provenance.nativeOutputPath == "native/forecast.nc"
    assert manifest.provenance.initializationStatePath == "native/initialization.nc"
    assert (root / "native" / "forecast.nc").is_file()
    assert (root / "native" / "initialization.nc").is_file()
    with xr.open_dataset(root / "native" / "forecast.nc") as retained_forecast:
        retained_leads = [
            int(value / np.timedelta64(1, "h"))
            for value in retained_forecast.prediction_timedelta.values
        ]
    assert retained_leads == expected_leads[1:]
    catalog_path = tmp_path / "forecasts" / "catalog.json"
    latest_path = (
        tmp_path
        / "forecasts"
        / "models"
        / "google-graphcast-small"
        / "latest"
        / "manifest.json"
    )
    assert json.loads(catalog_path.read_text())["schemaVersion"] == "2.0"
    assert json.loads(latest_path.read_text())["schemaVersion"] == "2.0"

    expected_byte_length = 3 * 3 * len(FIELDS) * 4
    assert [file.leadHours for file in manifest.uiSurface.files] == expected_leads
    for file in manifest.uiSurface.files:
        snapshot = root / file.path
        raw = snapshot.read_bytes()
        assert file.path == f"data/ui-surface/t+{file.leadHours}.bin"
        assert snapshot.is_file()
        assert len(raw) == file.byteLength == expected_byte_length
        assert file.sha256 == hashlib.sha256(raw).hexdigest()
        assert np.frombuffer(raw, dtype="<f4").size == 3 * 3 * len(FIELDS)
        for field_index, field in enumerate(FIELDS):
            byte_offset = field_index * 3 * 3 * 4
            values = np.frombuffer(raw, dtype="<f4", count=9, offset=byte_offset)
            assert values.size == 9, field

    surface_dir = root / "data" / "ui-surface"
    assert sorted(path.suffix for path in surface_dir.iterdir()) == [".bin"] * len(
        expected_leads
    )
    assert not list(surface_dir.glob("*.json"))


def test_binary_values_offsets_endianness_and_nan_preservation(tmp_path: Path) -> None:
    root = _publish_fixture(tmp_path, 2)
    t0_path = root / "data" / "ui-surface" / "t+0.bin"
    t6_path = root / "data" / "ui-surface" / "t+6.bin"
    t12_path = root / "data" / "ui-surface" / "t+12.bin"

    expected_t0_temperature = np.full(9, np.float32(290.0) - np.float32(273.15))
    expected_t0_temperature[2] = np.nan
    np.testing.assert_allclose(
        _field_values(t0_path, "temperature"), expected_t0_temperature, equal_nan=True
    )
    np.testing.assert_array_equal(_field_values(t0_path, "rain"), np.full(9, 2.0))
    np.testing.assert_array_equal(_field_values(t0_path, "pressure"), np.full(9, 1010.0))
    np.testing.assert_array_equal(_field_values(t0_path, "windU"), np.full(9, 2.0))
    np.testing.assert_array_equal(_field_values(t0_path, "windV"), np.full(9, -2.0))
    assert np.isnan(_field_values(t0_path, "temperature")).sum() == 1

    expected_first_value = np.asarray([expected_t0_temperature[0]], dtype="<f4").tobytes()
    assert t0_path.read_bytes()[:4] == expected_first_value
    assert _field_values(t6_path, "temperature")[0] == pytest.approx(
        np.float32(300.0) - np.float32(273.15)
    )
    assert _field_values(t6_path, "rain")[0] == pytest.approx(10.0)
    assert _field_values(t6_path, "pressure")[0] == pytest.approx(1000.0)
    assert _field_values(t6_path, "windU")[0] == pytest.approx(5.0)
    assert _field_values(t6_path, "windV")[0] == pytest.approx(-5.0)
    assert _field_values(t12_path, "temperature")[0] == pytest.approx(
        np.float32(301.0) - np.float32(273.15)
    )
    assert _field_values(t12_path, "rain")[0] == pytest.approx(20.0)


def test_t0_and_prediction_frame_semantics_remain_in_manifest(tmp_path: Path) -> None:
    root = _publish_fixture(tmp_path, 2)
    manifest = validate_run(root)

    t0, t6, t12 = manifest.frames
    assert t0.frameType == "analysis"
    assert t0.source == "ERA5T prepared analysis"
    assert (
        t0.precipitationMeaning
        == "six-hour analysis accumulation ending at T0 (T-6 through T0)"
    )
    assert t6.frameType == t12.frameType == "prediction"
    assert (
        t6.precipitationMeaning
        == "six-hour forecast accumulation ending at T+6 (T+0 through T+6)"
    )


def test_only_available_fields_are_written_to_every_snapshot(tmp_path: Path) -> None:
    all_predictions = tmp_path / "all-predictions.nc"
    all_initialization = tmp_path / "all-initialization.nc"
    native = tmp_path / "forecast.nc"
    initialization_state = tmp_path / "prepared.nc"
    selected_variables = ["2m_temperature", "10m_u_component_of_wind"]
    _write_predictions(all_predictions, 2)
    _write_initialization_state(all_initialization)
    with xr.open_dataset(all_predictions) as dataset:
        dataset[selected_variables].load().to_netcdf(native)
    with xr.open_dataset(all_initialization) as dataset:
        dataset[selected_variables].load().to_netcdf(initialization_state)

    root = publish(
        native,
        tmp_path / "forecasts",
        INITIALIZATION,
        initialization_state=initialization_state,
    )
    manifest = validate_run(root)

    assert manifest.uiSurface.fields == ["temperature", "windU"]
    assert [layer.dataField for layer in manifest.layers] == ["temperature", "windU"]
    for file in manifest.uiSurface.files:
        assert file.byteLength == 2 * 3 * 3 * 4
        assert np.fromfile(root / file.path, dtype="<f4").size == 2 * 3 * 3


def test_checksum_corruption_is_rejected(tmp_path: Path) -> None:
    root = _publish_fixture(tmp_path, 1)
    snapshot = root / "data" / "ui-surface" / "t+6.bin"
    raw = bytearray(snapshot.read_bytes())
    raw[0] ^= 1
    snapshot.write_bytes(raw)

    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        validate_run(root)


def test_schema_1_forecast_manifest_is_rejected(tmp_path: Path) -> None:
    root = _publish_fixture(tmp_path, 1)
    manifest_path = root / "manifest.json"
    payload = json.loads(manifest_path.read_text())
    payload["schemaVersion"] = "1.0"
    manifest_path.write_text(json.dumps(payload))

    with pytest.raises(ValueError, match="schemaVersion"):
        validate_run(root)


def test_incomplete_publication_does_not_update_latest_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    complete_root = _publish_fixture(tmp_path, 1, run_id="complete-run")
    publish_dir = tmp_path / "forecasts"
    latest_path = publish_dir / "models" / "google-graphcast-small" / "latest" / "manifest.json"
    latest_before = json.loads(latest_path.read_text())
    assert latest_before["runId"] == "complete-run"
    assert complete_root.is_dir()

    original_writer = publisher_module._write_ui_surface

    def fail_after_first_snapshot(*args: object, **kwargs: object) -> object:
        frame = args[3]
        if getattr(frame, "leadHours") == 6:
            raise RuntimeError("synthetic snapshot failure")
        return original_writer(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(publisher_module, "_write_ui_surface", fail_after_first_snapshot)
    with pytest.raises(RuntimeError, match="synthetic snapshot failure"):
        publish(
            tmp_path / "forecast.nc",
            publish_dir,
            INITIALIZATION,
            run_id="failed-run",
            initialization_state=tmp_path / "prepared.nc",
        )

    assert json.loads(latest_path.read_text()) == latest_before
    failed_root = publish_dir / "models" / "google-graphcast-small" / "runs" / "failed-run"
    assert (failed_root / "data" / "ui-surface" / "t+0.bin").is_file()
    assert not (failed_root / "manifest.json").exists()


def test_publish_requires_initialization_state(tmp_path: Path) -> None:
    native = tmp_path / "forecast.nc"
    _write_predictions(native, 1)

    with pytest.raises(ValueError, match="initialization_state is required"):
        publish(native, tmp_path / "forecasts", INITIALIZATION)


def test_publish_requires_exact_initialization_time(tmp_path: Path) -> None:
    native = tmp_path / "forecast.nc"
    initialization_state = tmp_path / "prepared.nc"
    _write_predictions(native, 1)
    _write_initialization_state(initialization_state)

    with pytest.raises(ValueError, match="no exact state"):
        publish(
            native,
            tmp_path / "forecasts",
            INITIALIZATION + timedelta(hours=1),
            initialization_state=initialization_state,
        )
