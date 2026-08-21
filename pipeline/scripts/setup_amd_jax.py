#!/usr/bin/env python3
"""Install and verify the matched ROCm 7 JAX stack used by the admin pipeline."""
from __future__ import annotations

import ctypes
import importlib.metadata
import os
import platform
import re
import subprocess
import sys
from pathlib import Path

JAX_VERSION = "0.8.2"
ROCM_PACKAGES = ("jaxlib", "jax-rocm7-pjrt", "jax-rocm7-plugin")


def run_pip(*arguments: str) -> None:
    subprocess.run([sys.executable, "-m", "pip", *arguments], check=True)


def rocm_release() -> str:
    override = os.environ.get("ROCM_JAX_RELEASE")
    if override:
        return override
    for version_file in (Path("/opt/rocm/.info/version"), Path("/opt/rocm/.info/version-dev")):
        try:
            installed = version_file.read_text(encoding="utf-8")
        except OSError:
            continue
        match = re.search(r"\b(7\.2\.\d+)\b", installed)
        if match:
            return match.group(1)
    print(
        "Could not detect the ROCm patch release; using ROCm 7.2.4 wheels. "
        "Set ROCM_JAX_RELEASE if the installed 7.2 release differs.",
        flush=True,
    )
    return "7.2.4"


def verify_rocm_runtime() -> None:
    if not Path("/dev/kfd").exists():
        raise SystemExit(
            "ROCm cannot access the AMD GPU because /dev/kfd is missing. Install the full "
            "ROCm 7.2 runtime and ensure the user belongs to the render and video groups."
        )
    try:
        ctypes.CDLL("libamdhip64.so.7")
    except OSError as error:
        raise SystemExit(
            "The ROCm 7 HIP runtime (libamdhip64.so.7) is not loadable. Installing the AMD "
            "display driver alone is not sufficient; install the full ROCm 7.2 runtime and "
            f"verify /opt/rocm before retrying. Loader error: {error}"
        ) from None


def main() -> None:
    if sys.platform != "linux" or platform.machine() not in {"x86_64", "AMD64"}:
        raise SystemExit("AMD JAX setup requires x86_64 Linux with ROCm already installed.")
    python_tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    if python_tag not in {"cp311", "cp312"}:
        raise SystemExit("AMD JAX setup supports Python 3.11 or 3.12.")
    verify_rocm_runtime()

    rocm_version = rocm_release()
    if not re.fullmatch(r"7\.2\.\d+", rocm_version):
        raise SystemExit(
            f"ROCm {rocm_version} is not supported by this installer; install ROCm 7.2.x first."
        )
    amd_wheelhouse = (
        f"https://repo.radeon.com/rocm/manylinux/rocm-rel-{rocm_version}/"
    )
    print(
        f"Replacing JAX packages with ROCm {rocm_version} / JAX {JAX_VERSION}...",
        flush=True,
    )
    run_pip(
        "uninstall",
        "-y",
        "jax",
        "jaxlib",
        "jax-rocm7-plugin",
        "jax-rocm7-pjrt",
    )
    run_pip(
        "install",
        "--no-deps",
        "--no-index",
        "--find-links",
        amd_wheelhouse,
        *(f"{package}=={JAX_VERSION}" for package in ROCM_PACKAGES),
    )
    run_pip("install", "--no-deps", f"jax=={JAX_VERSION}")

    installed = {
        package: importlib.metadata.version(package)
        for package in ("jax", "jaxlib", *ROCM_PACKAGES)
    }
    print("Installed: " + ", ".join(f"{key}={value}" for key, value in installed.items()))
    environment = os.environ.copy()
    environment["JAX_PLATFORMS"] = "rocm"
    environment.setdefault("LLVM_PATH", "/opt/rocm/llvm")
    subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import jax_rocm7_plugin.rocm_plugin_extension; "
                "import jax; print('ROCm devices:', jax.devices())"
            ),
        ],
        check=True,
        env=environment,
    )
    print("AMD ROCm JAX setup and device verification passed.")


if __name__ == "__main__":
    main()
