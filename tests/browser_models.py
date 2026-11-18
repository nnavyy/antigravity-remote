"""Check the model picker in disposable Chrome/bridge state using native discovery.

No model prompts are sent. Requires Node with WebSocket and a local Chromium
binary; BRIDGE_CHROME_EXE can override the default installed test-browser path.
"""
import argparse
import os
from pathlib import Path
import subprocess

from smoke import Server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default="target/release/antigravity-bridge.exe")
    parser.add_argument("--output-dir", type=Path, default=Path("docs/review"))
    args = parser.parse_args()
    server = Server(args.binary)
    try:
        server.env["USERPROFILE"] = os.environ["USERPROFILE"]
        server.env["HOME"] = os.environ.get("HOME", os.environ["USERPROFILE"])
        server.env["BRIDGE_AGY_EXE"] = os.environ.get("BRIDGE_AGY_EXE", str(Path(os.environ["USERPROFILE"]) / ".gemini/bin/agy.exe"))
        server.restart()
        args.output_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(["node", "tests/browser_models.cjs", f"http://127.0.0.1:{server.port}/", str(args.output_dir)], check=True, timeout=180)
    finally:
        server.close()


if __name__ == "__main__":
    main()
