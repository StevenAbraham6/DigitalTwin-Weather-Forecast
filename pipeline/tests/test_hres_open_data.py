from datetime import UTC, datetime
from pathlib import Path

import pytest

from forecast_engine.ingest.hres_open_data import download_step_zero


def test_hres_download_rejects_non_cycle_time(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="00, 06, 12, or 18"):
        download_step_zero(datetime(2026, 7, 10, 3, tzinfo=UTC), tmp_path)


def test_hres_download_requires_timezone(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="UTC offset"):
        download_step_zero(datetime(2026, 7, 10, 0), tmp_path)
