from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class Model(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)+$")
    provider: str
    family: str
    displayName: str
    version: str
    resolutionDegrees: float
    verticalPressureLevels: int | None = None


class Grid(BaseModel):
    width: int = Field(gt=1)
    height: int = Field(gt=1)
    longitudeRange: tuple[float, float] = (-180.0, 180.0)
    latitudeRange: tuple[float, float] = (90.0, -90.0)
    nativeLongitudeConvention: str
    nativeLatitudeOrientation: str


class ColorScale(BaseModel):
    name: str
    stops: list[tuple[float, str]]


class Layer(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9_]+$")
    label: str
    units: str
    encoding: Literal["ui-grid-float32-le"]
    dataTemplate: str
    dataField: str
    kind: Literal["scalar", "vector_component", "derived_display"] = "scalar"
    sourceVariable: str
    valueRange: tuple[float, float]
    noData: Literal["IEEE-754 NaN"] = "IEEE-754 NaN"
    colorScale: ColorScale | None = None


class UiSurfaceFile(BaseModel):
    leadHours: int = Field(ge=0)
    path: str
    byteLength: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class UiSurfaceProduct(BaseModel):
    id: Literal["ui-surface"] = "ui-surface"
    encoding: Literal["float32-le"] = "float32-le"
    pathTemplate: Literal["data/ui-surface/t+{leadHours}.bin"] = (
        "data/ui-surface/t+{leadHours}.bin"
    )
    layout: Literal["field-major"] = "field-major"
    fields: list[str] = Field(min_length=1)
    bytesPerValue: Literal[4] = 4
    gridOrder: Literal["row-major: north-to-south, west-to-east"] = (
        "row-major: north-to-south, west-to-east"
    )
    noData: Literal["IEEE-754 NaN"] = "IEEE-754 NaN"
    units: dict[str, str]
    files: list[UiSurfaceFile] = Field(min_length=1)


class ForecastFrame(BaseModel):
    leadHours: int = Field(ge=0)
    frameType: Literal["analysis", "prediction"]
    source: str
    validTime: datetime
    precipitationMeaning: str


class Provenance(BaseModel):
    inputSource: str
    inputIdentity: str
    checkpointIdentity: str
    nativeOutputPath: str
    initializationStatePath: str
    runtime: str
    packageVersions: dict[str, str]
    runKind: Literal["sample_demo", "historical", "operational"]


class ForecastManifest(BaseModel):
    schemaVersion: Literal["2.0"] = "2.0"
    runId: str
    status: Literal["complete"]
    model: Model
    initializationTime: datetime
    leadTimesHours: list[int]
    frames: list[ForecastFrame]
    grid: Grid
    layers: list[Layer]
    uiSurface: UiSurfaceProduct
    provenance: Provenance

    @model_validator(mode="after")
    def validate_frame_sequence(self) -> "ForecastManifest":
        if not self.leadTimesHours or self.leadTimesHours[0] != 0:
            raise ValueError("leadTimesHours must begin with the initialization frame at 0")
        if self.leadTimesHours != sorted(set(self.leadTimesHours)):
            raise ValueError("leadTimesHours must be unique and increasing")
        if [frame.leadHours for frame in self.frames] != self.leadTimesHours:
            raise ValueError("frames must describe every lead time in manifest order")
        if self.frames[0].frameType != "analysis":
            raise ValueError("the T+0 frame must be an analysis")
        if any(frame.frameType != "prediction" for frame in self.frames[1:]):
            raise ValueError("positive lead frames must be predictions")
        for frame in self.frames:
            expected_valid_time = self.initializationTime + timedelta(hours=frame.leadHours)
            if frame.validTime != expected_valid_time:
                raise ValueError(f"frame validTime does not match lead T+{frame.leadHours}")
        fields = self.uiSurface.fields
        if fields != list(dict.fromkeys(fields)):
            raise ValueError("uiSurface.fields must be unique and ordered")
        if set(self.uiSurface.units) != set(fields):
            raise ValueError("uiSurface.units must describe every and only declared field")
        if [layer.dataField for layer in self.layers] != fields:
            raise ValueError("layers must describe uiSurface.fields in binary field order")
        for layer in self.layers:
            if layer.dataTemplate != self.uiSurface.pathTemplate:
                raise ValueError("layer dataTemplate must reference the shared binary snapshot")
            if layer.units != self.uiSurface.units[layer.dataField]:
                raise ValueError(f"layer units do not match uiSurface units for {layer.dataField}")
        files = self.uiSurface.files
        if [file.leadHours for file in files] != self.leadTimesHours:
            raise ValueError("uiSurface.files must describe every lead time in manifest order")
        expected_byte_length = (
            self.grid.width
            * self.grid.height
            * len(fields)
            * self.uiSurface.bytesPerValue
        )
        for file in files:
            expected_path = self.uiSurface.pathTemplate.format(leadHours=file.leadHours)
            if file.path != expected_path:
                raise ValueError(f"UI surface path does not match template for T+{file.leadHours}")
            if file.byteLength != expected_byte_length:
                raise ValueError(f"UI surface byte length is wrong for T+{file.leadHours}")
        return self


class CatalogModel(BaseModel):
    id: str
    provider: str
    displayName: str
    latestManifestPath: str


class Catalog(BaseModel):
    schemaVersion: Literal["2.0"] = "2.0"
    models: list[CatalogModel]


class LatestManifestPointer(BaseModel):
    schemaVersion: Literal["2.0"] = "2.0"
    runId: str
    manifestPath: str
