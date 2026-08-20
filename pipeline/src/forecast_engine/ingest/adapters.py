from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PreparedInput:
    path: Path
    source_identity: str
    run_kind: str


class InputAdapter(ABC):
    """Provider input boundary; validation precedes GraphCast-specific preparation."""

    @abstractmethod
    def prepare(self, initialization_time: str) -> PreparedInput: ...


class SampleAdapter(InputAdapter):
    def prepare(self, initialization_time: str) -> PreparedInput:
        raise NotImplementedError("Sample input is acquired by the official demo runner.")


class Era5Adapter(InputAdapter):
    def prepare(self, initialization_time: str) -> PreparedInput:
        raise NotImplementedError("ERA5 adapter design is documented; acquisition/regridding is not implemented.")


class HresOperationalAdapter(InputAdapter):
    def prepare(self, initialization_time: str) -> PreparedInput:
        raise NotImplementedError(
            "Operational HRES is intentionally unavailable until its checklist and validation suite are complete."
        )
