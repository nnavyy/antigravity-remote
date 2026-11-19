"""Check Windows publication of a first, identical and changed image in a disposable directory."""
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from zipfile import ZipFile

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
        launcher = case / "run_background.bat"
        shutil.copy2(ROOT / launcher.name, launcher)
        (case / "start_background_bridge.vbs").write_text("WScript.Quit 0\n")
        for port in (None, "9137"):
            env = os.environ.copy()
            env.pop("BRIDGE_PORT", None)
            if port:
                env["BRIDGE_PORT"] = port
            run = subprocess.run(["cmd.exe","/d","/c",launcher.name], cwd=case, env=env,
                                 check=True, capture_output=True, text=True, timeout=10)
            assert f"http://127.0.0.1:{port or '8000'}/#connect" in run.stdout
        class HealthFixture(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/healthz":
                    self.server.probes += 1
                    body = {"ok":True, "engine":"rust-axum" if self.server.probes > 1 else "other"}
                else:
                    body = {"settings":{"remote_mode":"lan"}}
                self.send_response(200)
                self.send_header("Content-Type","application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def log_message(self, *_):
                pass

        shutil.copy2(ROOT / "Cek_Link_HP.bat", case)
        with HTTPServer(("127.0.0.1",0), HealthFixture) as service:
            service.probes = 0
            worker = threading.Thread(target=service.serve_forever, daemon=True)
            worker.start()
            try:
                subprocess.run(["cmd.exe","/d","/c","Cek_Link_HP.bat"], cwd=case,
                               env=dict(os.environ, BRIDGE_PORT=str(service.server_port)),
                               input="4\n", text=True, capture_output=True, check=True, timeout=30)
                assert service.probes == 2, service.probes
            finally:
                service.shutdown()
                worker.join()
        source_zip = case / "source.zip"
        pack = [sys.executable, str(ROOT / "docs/review/repro/package_development.py"), "--output", str(source_zip)]
        subprocess.run(pack, check=True, capture_output=True)
        original = source_zip.read_bytes()
        with ZipFile(source_zip) as archive:
            assert all(item.date_time == (1980, 1, 1, 0, 0, 0) for item in archive.infolist())
        subprocess.run(pack, check=True, capture_output=True)
        assert source_zip.read_bytes() == original, "Identical source must produce identical release bytes"
    print("Publish, log rotation, exit codes, background ports, phone-link detection and reproducible source ZIP passed.")


if __name__ == "__main__":
    main()
