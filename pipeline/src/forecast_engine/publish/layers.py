from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
import numpy.typing as npt
import xarray as xr

from forecast_engine.transform.grid import select_lead


@dataclass(frozen=True)
class LayerSpec:
    id: str
    variable: str
    label: str
    units: str
    ui_field: str
    ui_units: str
    ui_label: str
    kind: Literal["scalar", "vector_component", "derived_display"] = "scalar"


SPECS = (
    LayerSpec("temperature", "2m_temperature", "2 m temperature", "K", "temperature", "C", "Temperature"),
    LayerSpec("rain", "total_precipitation_6hr", "Total precipitation (6 h)", "m", "rain", "mm per 6 h", "Rain"),
    LayerSpec("pressure", "mean_sea_level_pressure", "Mean sea-level pressure", "Pa", "pressure", "hPa", "Pressure"),
    LayerSpec("wind_u", "10m_u_component_of_wind", "10 m eastward wind", "m s-1", "windU", "m s-1", "Eastward wind", "vector_component"),
    LayerSpec("wind_v", "10m_v_component_of_wind", "10 m northward wind", "m s-1", "windV", "m s-1", "Northward wind", "vector_component"),
)


def available_specs(dataset: xr.Dataset) -> list[LayerSpec]:
    return [spec for spec in SPECS if spec.variable in dataset.data_vars]


def layer_field(dataset: xr.Dataset, spec: LayerSpec, lead: int) -> xr.DataArray:
    return select_lead(dataset[spec.variable], lead).squeeze(drop=True)


def ui_values(da: xr.DataArray, spec: LayerSpec) -> npt.NDArray[np.float32]:
    values = np.asarray(da.values, dtype=np.float32)
    if spec.ui_field == "temperature":
        return values - np.float32(273.15)
    if spec.ui_field == "rain":
        return np.maximum(values * np.float32(1000.0), np.float32(0.0))
    if spec.ui_field == "pressure":
        return values / np.float32(100.0)
    return values
