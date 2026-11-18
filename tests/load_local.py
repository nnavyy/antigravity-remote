"""Bounded local load experiment against a disposable bridge and fake AGY.

Uses no provider requests. See docs/review/RELIABILITY_EXPERIMENT_PLAN.md.
"""
import argparse
from datetime import date
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import http.server
import json
from pathlib import Path
import platform
import shutil
import statistics
import tempfile
import threading
import time

import psutil

from smoke import Server


class Runtime(http.server.BaseHTTPRequestHandler):
    calls = 0
    failure = False
    delay = 0
    lock = threading.Lock()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        method = self.path.rsplit("/", 1)[-1]
        if self.headers.get("X-Codeium-Csrf-Token") != "audit-only":
            self.send_error(401)
            return
        if method == "GetAvailableModels":
            with self.lock:
                Runtime.calls += 1
            time.sleep(self.delay)
            if self.failure:
                self.send_error(503)
                return
            result = {"response": {"models": {
                "fixture-low": {"displayName": "Fixture (Low)", "model": "MODEL_FIXTURE_LOW"},
                "fixture-high": {"displayName": "Fixture (High)", "model": "MODEL_FIXTURE_HIGH"}},
                "agentModelSorts": [{"groups": [{"modelIds": ["fixture-low", "fixture-high"]}]}]}}
        elif method == "GetUserStatus":
            result = {"userStatus": {"email": "load-test@example.invalid"}}
        else:
            result = {}
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


class RuntimeServer(http.server.ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


def percentile(values, percent):
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int((len(ordered) - 1) * percent))], 3)


def run_stage(port, route, concurrency, requests, expected, barrier=False):
    gate = threading.Barrier(concurrency) if barrier else None

    def worker(count):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=12)
        latencies = []
        errors = []
        if gate:
            gate.wait(timeout=15)
        try:
            for _ in range(count):
                started = time.perf_counter()
                try:
                    conn.request("GET", route)
                    response = conn.getresponse()
                    data = json.loads(response.read())
                    if response.status != 200 or not expected(data):
                        errors.append(f"Unexpected HTTP {response.status}")
                except Exception as error:
                    errors.append(type(error).__name__)
                    conn.close()
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=12)
                latencies.append((time.perf_counter() - started) * 1000)
        finally:
            conn.close()
        return latencies, errors

    counts = [requests // concurrency + int(i < requests % concurrency) for i in range(concurrency)]
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        runs = list(pool.map(worker, counts))
    elapsed = time.perf_counter() - started
    latencies = [value for values, _ in runs for value in values]
    errors = [error for _, errors in runs for error in errors]
    return {"route": route, "concurrency": concurrency, "requests": requests,
            "errors": dict(Counter(errors)), "error_count": len(errors),
            "duration_seconds": round(elapsed, 3), "requests_per_second": round(requests / elapsed, 2),
            "latency_ms": {"p50": percentile(latencies, .5), "p95": percentile(latencies, .95),
                           "p99": percentile(latencies, .99), "max": round(max(latencies), 3)}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default="target/release/antigravity-bridge.exe")
    parser.add_argument("--output", default=f"docs/review/reliability-local-{date.today()}.json")
    args = parser.parse_args()
    binary = Path(args.binary).resolve()
    evidence = {"date": date.today().isoformat(),
                "environment": {"os": platform.system(), "logical_cpus": psutil.cpu_count(),
                                "total_memory_bytes": psutil.virtual_memory().total},
                "scope": "Synthetic loopback HTTP model reads. Inference, WAN and long-lived sessions excluded."}
    runtime = RuntimeServer(("127.0.0.1", 0), Runtime)
    thread = threading.Thread(target=runtime.serve_forever, daemon=True)
    thread.start()
    with tempfile.TemporaryDirectory(prefix="agy-load-binary-") as directory:
        copy = Path(directory) / "antigravity-bridge.exe"
        shutil.copy2(binary, copy)
        evidence["binary_sha256"] = hashlib.sha256(copy.read_bytes()).hexdigest()
        server = Server(copy)
        stop_sampling = threading.Event()
        samples = []
        try:
            server.env["ANTIGRAVITY_LS_ADDRESS"] = f"http://127.0.0.1:{runtime.server_port}"
            server.restart()
            process = psutil.Process(server.proc.pid)

            def sample():
                while not stop_sampling.wait(.1):
                    try:
                        samples.append({"rss_bytes": process.memory_info().rss, "cpu_percent": process.cpu_percent(None)})
                    except psutil.NoSuchProcess:
                        return

            sampler = threading.Thread(target=sample, daemon=True)
            sampler.start()
            assert server.json("GET", "/api/models?target=ide&refresh=true")[1]["connected"]
            stages = []
            for concurrency in (1, 8, 32, 64):
                for route, expected in (("/healthz", lambda value: value.get("ok") is True),
                                        ("/api/models?target=ide", lambda value: value.get("connected") is True and len(value["models"]) == 2)):
                    stage = run_stage(server.port, route, concurrency, 200, expected)
                    stages.append(stage)
                    print(json.dumps(stage), flush=True)
            evidence["stages"] = stages
            Runtime.delay = .3
            before = Runtime.calls
            burst = run_stage(server.port, "/api/models?target=ide&refresh=true", 32, 32,
                              lambda value: value.get("connected") is True, barrier=True)
            burst["native_catalog_calls"] = Runtime.calls - before
            burst["fixture_delay_ms"] = 300
            evidence["forced_refresh_burst"] = burst
            print(json.dumps(burst), flush=True)
            Runtime.delay = 0
            Runtime.failure = True
            failed = server.json("GET", "/api/models?target=ide&refresh=true")[1]
            Runtime.failure = False
            restored = server.json("GET", "/api/models?target=ide&refresh=true")[1]
            evidence["upstream_recovery"] = {"failure_connected": failed["connected"],
                "failure_model_count": len(failed["models"]), "restored_connected": restored["connected"],
                "restored_model_count": len(restored["models"])}
            conv = server.json("POST", "/api/conversations", {"title":"Load fixture persisted draft"})[1]
            stop_sampling.set()
            sampler.join(timeout=2)
            server.restart()
            evidence["restart"] = {"health_ok": server.json("GET", "/healthz")[1]["ok"],
                "draft_preserved": server.json("GET", f"/api/conversations/{conv['id']}")[1]["id"] == conv["id"]}
            evidence["resource_samples"] = {"sample_count":len(samples),
                "peak_rss_bytes":max((sample["rss_bytes"] for sample in samples), default=0),
                "median_cpu_percent":round(statistics.median([sample["cpu_percent"] for sample in samples]),2) if samples else None,
                "peak_cpu_percent":max((sample["cpu_percent"] for sample in samples),default=0)}
            evidence["targets_passed"] = (all(stage["error_count"] == 0 for stage in stages)
                and burst["error_count"] == 0 and burst["native_catalog_calls"] == 1
                and not failed["connected"] and not failed["models"] and restored["connected"]
                and all(evidence["restart"].values()))
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf8")
            print(json.dumps({"targets_passed":evidence["targets_passed"],"evidence":str(output)}),flush=True)
            if not evidence["targets_passed"]:
                raise SystemExit(1)
        finally:
            stop_sampling.set()
            server.close()
            runtime.shutdown()
            runtime.server_close()


if __name__ == "__main__":
    main()
