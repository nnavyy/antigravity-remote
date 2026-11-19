"""Check Windows publication of a first, identical and changed image in a disposable directory."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]


def main():
    with tempfile.TemporaryDirectory(prefix="agy-publish-test-") as folder:
        case = Path(folder)
        tool = case / "publish_build.ps1"
        shutil.copy2(ROOT / tool.name, tool)
        release = case / "target/release/antigravity-bridge.exe"
        release.parent.mkdir(parents=True)
        system = Path(os.environ["SystemRoot"]) / "System32"
        shutil.copy2(system / "ping.exe", release)
        dest = case / release.name
        publish = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(tool)]
        subprocess.run(publish, check=True, capture_output=True)
        assert dest.read_bytes() == release.read_bytes()
        os.utime(dest, (1700000000, 1700000000))
        stamp = dest.stat().st_mtime_ns
        proc = subprocess.Popen([str(dest), "-n", "60", "127.0.0.1"], stdout=subprocess.DEVNULL,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            subprocess.run(publish, check=True, capture_output=True)
            assert dest.stat().st_mtime_ns == stamp and not list(case.glob("*.bak"))
            shutil.copy2(system / "where.exe", release)
            subprocess.run(publish, check=True, capture_output=True)
            assert dest.read_bytes() == release.read_bytes() and proc.poll() is None
        finally:
            proc.terminate()
            proc.wait(timeout=10)
        release.unlink()
        missing = subprocess.run(publish, capture_output=True, text=True)
        assert missing.returncode and "Release executable missing" in missing.stderr
        emitter = case / "fixture.cmd"
        emitter.write_text("@echo off\n" + "".join(f"echo fixture line {n:02}\n" for n in range(30)) + "exit /b 7\n")
        log = case / "bridge.log"
        logger = subprocess.run(["powershell","-NoProfile","-ExecutionPolicy","Bypass","-File",
            str(ROOT / "run_background_log.ps1"),"-Binary",str(emitter),"-LogPath",str(log),"-LimitBytes","80"],
            capture_output=True)
        assert logger.returncode == 7, logger.stderr
        assert max(log.stat().st_size, (case / "bridge.log.1").stat().st_size) <= 80
        assert "fixture line 29" in log.read_text()
    print("First publish, live replacement, missing build, log rotation and exit-code propagation passed.")


if __name__ == "__main__":
    main()
