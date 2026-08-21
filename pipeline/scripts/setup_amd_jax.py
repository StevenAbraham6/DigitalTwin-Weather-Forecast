#!/usr/bin/env python3
"""Install and verify the matched ROCm 7 JAX stack used by the admin pipeline."""
from __future__ import annotations

import importlib.metadata
import os
import platform
import subprocess
import sys

JAX_VERSION = "0.8.2"
ROCM_PACKAGES = ("jax-rocm7-pjrt", "jax-rocm7-plugin")


def run_pip(*arguments: str) -> None:
    subprocess.run([sys.executable, "-m", "pip", *arguments], check=True)


def main() -> None:
    if sys.platform != "linux" or platform.machine() not in {"x86_64", "AMD64"}:
        raise SystemExit("AMD JAX setup requires x86_64 Linux with ROCm already installed.")
    python_tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    if python_tag not in {"cp311", "cp312"}:
        raise SystemExit("AMD JAX setup supports Python 3.11 or 3.12.")

    jaxlib_wheel = (
        "https://github.com/ROCm/rocm-jax/releases/download/rocm-jax-v0.8.2/"
        f"jaxlib-0.8.2%2Brocm7-{python_tag}-{python_tag}-"
        "manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl"
    )
    print("Replacing JAX packages with the matched ROCm 7 / JAX 0.8.2 stack...", flush=True)
    run_pip(
        "uninstall",
        "-y",
        "jax",
        "jaxlib",
        "jax-rocm7-plugin",
        "jax-rocm7-pjrt",
    )
    for package in ROCM_PACKAGES:
        run_pip("install", "--no-deps", f"{package}=={JAX_VERSION}")
    run_pip("install", "--no-deps", jaxlib_wheel)
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
        [sys.executable, "-c", "import jax; print('ROCm devices:', jax.devices())"],
        check=True,
        env=environment,
    )
    print("AMD ROCm JAX setup and device verification passed.")


if __name__ == "__main__":
    main()
