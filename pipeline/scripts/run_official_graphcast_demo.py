#!/usr/bin/env python3
"""Cache and execute Google's GraphCast demo with an appended NetCDF export cell."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import nbformat
from nbclient import NotebookClient


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo = args.cache_dir / "weathernext"
    # `python3` normally resolves to a globally registered Jupyter kernel,
    # which may not be this virtual environment. Keep a private kernelspec in
    # the artifact cache and make the notebook use the exact interpreter that
    # launched this script.
    kernel_name = "forecast-engine-venv"
    kernel_dir = args.cache_dir / "jupyter" / "kernels" / kernel_name
    kernel_dir.mkdir(parents=True, exist_ok=True)
    (kernel_dir / "kernel.json").write_text(json.dumps({
        "argv": [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        "display_name": "Forecast Engine (.venv)",
        "language": "python",
    }), encoding="utf-8")
    os.environ["JUPYTER_PATH"] = str(args.cache_dir / "jupyter")
    if not repo.exists():
        repo.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--depth", "1", args.repository, str(repo)], check=True)
    revision = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    notebook_path = repo / "graphcast_demo.ipynb"
    if not notebook_path.exists():
        raise SystemExit(f"Official demo not found: {notebook_path}")
    output = args.output.resolve()
    initialization_output = output.with_name("initialization.nc")
    output.parent.mkdir(parents=True, exist_ok=True)
    notebook = nbformat.read(notebook_path, as_version=4)
    # The supplied notebook is an interactive teaching document. Execute only
    # the inference path: skip Colab installation, Cartopy/Matplotlib plotting,
    # and expensive training/gradient cells. This keeps the official model,
    # data extraction, normalization, and rollout cells unchanged.
    required_titles = (
        "# @title Imports",
        "# @title Authenticate with Google Cloud Storage",
        "# @title Choose the model",
        "# @title Load the model",
        "# @title Get and filter the list of available example datasets",
        "# @title Load weather data",
        "# @title Choose training and eval data to extract",
        "# @title Extract training and eval data",
        "# @title Load normalization data",
        "# @title Build jitted functions",
        "# @title Autoregressive rollout (loop in python)",
    )
    notebook.cells = [
        cell for cell in notebook.cells
        if any(cell.source.lstrip().startswith(title) for title in required_titles)
    ]
    imports = notebook.cells[0]
    imports.source = imports.source.replace("import cartopy.crs as ccrs\n", "")
    imports.source = imports.source.replace("import matplotlib\n", "")
    imports.source = imports.source.replace("import matplotlib.pyplot as plt\n", "")
    imports.source = imports.source.replace("from matplotlib import animation\n", "")
    # The upstream notebook defaults to its random-model tab. Set its existing
    # widgets before its "Load the model" cell so this is specifically the
    # supplied GraphCast_small checkpoint, not a synthetic random smoke test.
    chooser = next(
        (cell for cell in notebook.cells if "source_tab = widgets.Tab" in cell.source),
        None,
    )
    if chooser is None:
        raise SystemExit("Official notebook model chooser changed; refusing to run an unspecified model.")
    chooser.source += (
        "\n# Selected by forecast-engine: supplied GraphCast_small checkpoint.\n"
        "source_tab.selected_index = 1\n"
        "_small = [x for x in params_file_options if 'graphcast_small' in x.lower()]\n"
        "if not _small: raise RuntimeError('GraphCast_small checkpoint is unavailable in the official bucket')\n"
        "params_file.value = _small[0]\n"
    )
    notebook.cells.append(nbformat.v4.new_code_cell(
        "# Added by forecast-engine; all inference above remains the official demo.\n"
        "if 'predictions' not in globals():\n    raise RuntimeError('Official demo did not define predictions')\n"
        "if 'eval_inputs' not in globals():\n    raise RuntimeError('Official demo did not define eval_inputs')\n"
        f"predictions.attrs.update({{'input_source': 'official GraphCast example data', 'input_identity': 'weathernext:{revision}', 'checkpoint_identity': str(params_file.value), 'run_kind': 'sample_demo'}})\n"
        "initialization_state = eval_inputs.isel(batch=0, drop=True) if 'batch' in eval_inputs.dims else eval_inputs\n"
        f"initialization_state.attrs.update({{'input_source': 'official GraphCast example data', 'input_identity': 'weathernext:{revision}', 'run_kind': 'sample_demo'}})\n"
        f"initialization_state.to_netcdf({str(initialization_output)!r})\n"
        f"predictions.to_netcdf({str(output)!r})\n"
    ))
    client = NotebookClient(notebook, timeout=None, kernel_name=kernel_name, resources={"metadata": {"path": str(repo)}})
    client.execute()
    executed = args.cache_dir / "executed-graphcast-demo.ipynb"
    nbformat.write(notebook, executed)
    print(json.dumps({"nativeOutput": str(output), "initializationState": str(initialization_output), "upstreamRevision": revision, "executedNotebook": str(executed)}))


if __name__ == "__main__":
    main()
