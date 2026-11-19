"""Exercise the compiled Rust server with disposable data and a mock IDE.

Usage: python tests/smoke.py [--binary target/debug/antigravity-bridge.exe]
       python tests/smoke.py --serve 8765 (isolated browser fixture)
"""
import argparse
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import threading
import unittest
from urllib.parse import quote
import uuid

import psutil

ROOT = Path(__file__).resolve().parents[1]


class Server:
    def __init__(self, binary, port=0, keep=False, agent=False):
        self.temp = tempfile.TemporaryDirectory(prefix="antigravity-audit-") if not keep else None
        self.root = Path(self.temp.name) if self.temp else ROOT / "scratch" / "phone-ui-fixture"
        self.root.mkdir(parents=True, exist_ok=True)
        shutil.copytree(ROOT / "static", self.root / "static", dirs_exist_ok=True)
        if not port:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
        self.port = port
        (self.root / "home").mkdir(exist_ok=True)
        if agent:
            helper = self.root / "home" / "AppData/Local/Programs/antigravity/resources/bin/language_server.exe"
            helper.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / "target/test-agentapi.exe", helper)
        env = dict(os.environ, BRIDGE_PORT=str(port), BRIDGE_HOST="127.0.0.1",
                   USERPROFILE=str(self.root / "home"), HOME=str(self.root / "home"))
        for key in ["BRIDGE_TOKEN", "BRIDGE_ALLOW_TUNNEL", "BRIDGE_ALLOW_SHELL",
                    "ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN", "BRIDGE_AGENTAPI_EXE"]:
            env.pop(key, None)
        # Explicitly select a closed mock address so the fixture never discovers the real IDE.
        env["ANTIGRAVITY_LS_ADDRESS"] = "http://127.0.0.1:1"
        env["ANTIGRAVITY_CSRF_TOKEN"] = "audit-only"
        env["BRIDGE_AGY_EXE"] = str(self.root / "missing-agy.exe")
        self.log = (self.root / "server.log").open("w", encoding="utf-8")
        self.proc = subprocess.Popen([str(Path(binary).resolve())], cwd=self.root, env=env,
                                     stdout=self.log, stderr=subprocess.STDOUT)
        self.binary = str(Path(binary).resolve())
        self.env = env
        for _ in range(100):
            try:
                if self.request("GET", "/healthz")[0] == 200:
                    break
            except OSError:
                pass
            if self.proc.poll() is not None:
                raise RuntimeError("Server failed to start")
            time.sleep(.1)
        else:
            raise RuntimeError("Server startup timed out")

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=12)
        hdr = dict(headers or {})
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
            hdr["Content-Type"] = "application/json"
        conn.request(method, path, body=body, headers=hdr)
        resp = conn.getresponse()
        data = resp.read()
        result = (resp.status, dict(resp.getheaders()), data)
        conn.close()
        return result

    def json(self, method, path, body=None, headers=None):
        status, hdr, data = self.request(method, path, body, headers)
        return status, json.loads(data), hdr

    def stop_process(self):
        children = psutil.Process(self.proc.pid).children(recursive=True) if self.proc.poll() is None else []
        self.proc.terminate()
        self.proc.wait(timeout=10)
        for child in children:
            try:
                child.terminate()
            except psutil.NoSuchProcess:
                pass
        _, alive = psutil.wait_procs(children, timeout=5)
        for child in alive:
            child.kill()
        psutil.wait_procs(alive, timeout=5)

    def close(self):
        self.stop_process()
        self.log.close()
        if self.temp:
            self.temp.cleanup()

    def restart(self):
        self.stop_process()
        self.proc = subprocess.Popen([self.binary], cwd=self.root, env=self.env, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                if self.request("GET", "/healthz")[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(.1)
        raise RuntimeError("Restart timed out")


class AgentFlow(unittest.TestCase):
    def test_redirected_startup_output_keeps_the_pairing_pin_out_of_logs(self):
        server = Server(ARGS.binary)
        try:
            status, connection, _ = server.json("GET", "/api/connection")
            self.assertEqual(status, 200)
            self.assertRegex(connection["pin"], r"^\d{6}$")
            leaked = connection["pin"] in (server.root / "server.log").read_text()
            self.assertFalse(leaked, "Owner PIN was written to redirected output")
        finally:
            server.close()

    def test_second_bridge_cannot_recover_a_running_instances_turn(self):
        server = Server(ARGS.binary)
        try:
            self.assertEqual((server.root / "data/.bridge.lock").read_bytes(), b"")
            meta = server.root / "conversations/live-turn_meta.json"
            before = b'{"native_transport":"acp","acp_turn_pending":true,"acp_turn_id":"in-progress"}'
            meta.write_bytes(before)
            with socket.socket() as spare:
                spare.bind(("127.0.0.1", 0))
                other_port = spare.getsockname()[1]
            for port, diagnostic in [(server.port, str(server.port)), (other_port, "data directory")]:
                with self.subTest(port=port):
                    result = subprocess.run([server.binary], cwd=server.root,
                                            env=dict(server.env, BRIDGE_PORT=str(port)),
                                            capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(meta.read_bytes(), before)
                    self.assertIn(diagnostic, result.stderr.decode(errors="replace"))
            self.assertEqual(server.json("GET", "/healthz")[0], 200)
            for port in ("0", "65536", "invalid"):
                result = subprocess.run([server.binary], cwd=server.root, env=dict(server.env, BRIDGE_PORT=port),
                                        capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"BRIDGE_PORT", result.stderr)
        finally:
            server.close()

    def test_unverified_default_never_starts_legacy_native_helper(self):
        subprocess.run(["rustc", str(ROOT / "tests/fake_agentapi.rs"), "-o", str(ROOT / "target/test-agentapi.exe")], check=True, capture_output=True)
        server = Server(ARGS.binary, agent=True)
        try:
            project = server.root / "project-a"
            project.mkdir()
            server.json("POST", "/api/workspaces/select", {"path":str(project)})
            cid = server.json("POST", "/api/conversations", {"title":"Mobile task"})[1]["id"]
            payload = {"request_id":str(uuid.uuid4()), "prompt":"Synthetic protocol fixture", "conversation_id":cid}
            first = server.json("POST", "/api/tasks/submit", payload)
            self.assertEqual(first[0], 409, first[1])
            self.assertEqual(first[1]["code"], "model_unavailable")
            server.restart()
            replay = server.json("POST", "/api/tasks/submit", payload)
            self.assertEqual(replay[0], 409, replay[1])
            self.assertFalse((project / "agentapi_calls.log").exists())
            conv = server.json("GET", f"/api/conversations/{cid}")[1]
            self.assertFalse(conv["is_processing"])
        finally:
            server.close()


class ModelFlow(unittest.TestCase):
    def test_native_only_chat_stays_listed_and_cached_activity_expires(self):
        root = self.server.root
        cid = "native-review"
        transcript = root / "home/.gemini/antigravity/brain" / cid / ".system_generated/logs/transcript.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text(json.dumps({"type":"USER_INPUT","content":"Fixture question"}) + "\n")
        stamp = time.time() - 11
        os.utime(transcript, (stamp, stamp))
        metadata = root / "conversations" / f"{cid}_meta.json"
        metadata.parent.mkdir(exist_ok=True)
        metadata.write_text(json.dumps({"ide_conversation_id":cid}))
        api = self.server.json
        self.assertIn(cid, [c["id"] for c in api("GET","/api/conversations")[1]["conversations"]])
        self.assertTrue(api("GET",f"/api/conversations/{cid}")[1]["is_processing"])
        time.sleep(max(0, stamp + 17 - time.time()))
        self.assertFalse(api("GET",f"/api/conversations/{cid}")[1]["is_processing"])

    def test_busy_queue_retries_after_the_original_turn_finishes(self):
        api = self.server.json
        cid = api("POST", "/api/conversations", {"title":"Busy fixture"})[1]["id"]
        task = {"conversation_id":cid,"model":"future-v99","prompt":"Fixture"}
        self.trajectory_status = "CASCADE_RUN_STATUS_RUNNING"
        self.assertEqual(api("POST","/api/tasks/submit",task)[0],200)
        ticket = api("POST","/api/tasks/submit",dict(task,queue_mode="queue"))[1]["task_id"]
        url = f"/api/queue/{ticket}/dispatch"
        self.assertEqual(api("POST",url)[1]["code"],"workspace_busy")
        self.trajectory_status = "CASCADE_RUN_STATUS_IDLE"
        api("GET",f"/api/conversations/{cid}")
        result = api("POST",url)
        self.assertEqual(result[0],200,result[1])
        self.assertEqual(sum(m=="SendUserCascadeMessage" for m,_ in self.events),2)

    def test_offline_conversation_replay_and_metadata_cleanup(self):
        api = self.server.json
        draft = {"offline_draft_id":str(uuid.uuid4()),"title":"Offline fixture","workspace_path":str(self.server.root)}
        cid = api("POST","/api/conversations",draft)[1]["id"]
        self.assertEqual(api("POST","/api/conversations",draft)[1]["id"],cid)
        self.assertEqual(api("DELETE",f"/api/conversations/{cid}")[0],200)
        self.assertFalse((self.server.root/"conversations"/f"{cid}_meta.json").exists())
        self.assertFalse(api("POST","/api/conversations",draft)[1].get("id"))

    def test_embedded_repository_without_commit_has_a_stable_parent_review(self):
        repo = self.server.root
        for path in (repo,repo/"nested"):
            subprocess.run(["git","init","-q",str(path)],check=True,capture_output=True)
        (repo/"nested"/"marker.txt").write_text("fixture")
        api = self.server.json
        route = "/api/changes?workspace_path="+quote(str(repo),safe="")
        status, review, _ = api("GET",route)
        self.assertEqual(status,200)
        self.assertEqual(review["availability"],"ready")
        self.assertEqual(api("GET",route)[1]["revision"],review["revision"])

    def test_ide_attachment_uses_the_uploaded_file_on_the_laptop(self):
        data = b'--audit\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n\x1a\nfixture\r\n--audit--\r\n'
        status, _, raw = self.server.request("POST", "/api/upload", data, {"Content-Type":"multipart/form-data; boundary=audit"})
        self.assertEqual(status, 200)
        image = json.loads(raw)
        cid = self.server.json("POST", "/api/conversations", {"title":"Image fixture"})[1]["id"]
        status, out, _ = self.server.json("POST", "/api/tasks/submit", {"conversation_id":cid,"model":"future-v99",
            "execution_target":"ide","prompt":"Describe fixture","images":[image["file_url"]]})
        self.assertEqual(status, 200, out)
        self.assertIn(image["file_path"], str(self.events[-1][1]["items"][0]["text"]))

    def setUp(self):
        self.models = {"future-v99":{"displayName":"Future model","model":"MODEL_FUTURE"}, "paid-v2":{"displayName":"Paid model","model":"MODEL_PAID","disabled":True}, "internal":{"displayName":"Hidden completion model"}}
        self.events = []
        self.catalog_failure = False
        self.catalog_body = None
        self.default_model = None
        self.trajectory_status = "CASCADE_RUN_STATUS_IDLE"
        fixture = self

        class Runtime(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                method = self.path.rsplit("/", 1)[-1]
                if self.headers.get("X-Codeium-Csrf-Token") != "audit-only":
                    self.send_error(401)
                    return
                if method == "GetAvailableModels":
                    if fixture.catalog_failure:
                        self.send_error(503 if fixture.catalog_failure is True else fixture.catalog_failure)
                        return
                    assert payload["forceRefresh"] is True
                    result = fixture.catalog_body if fixture.catalog_body is not None else {"response":{"models":fixture.models,"agentModelSorts":[{"groups":[{"modelIds":["future-v99","paid-v2"]}]}]}}
                    if fixture.default_model is not None:
                        result["response"]["defaultAgentModelId"] = fixture.default_model
                elif method == "GetUserStatus":
                    result = {"userStatus":{"email":"test@example.invalid","userTier":{"name":"Runtime plan"}}}
                elif method == "StartCascade":
                    assert payload["source"] == "CORTEX_TRAJECTORY_SOURCE_AGENT_API"
                    assert payload["trajectoryType"] == "CORTEX_TRAJECTORY_TYPE_CASCADE"
                    fixture.events.append((method, payload))
                    result = {"cascadeId":"11111111-2222-4333-8444-555555555555"}
                elif method == "SendUserCascadeMessage":
                    assert payload["cascadeConfig"]["plannerConfig"].get("planModel") in (None, "MODEL_FUTURE", "MODEL_PAID")
                    fixture.events.append((method, payload))
                    result = {}
                elif method == "GetCascadeTrajectory":
                    result = {"status":fixture.trajectory_status,"trajectory":{"steps":[
                        {"type":"CORTEX_STEP_TYPE_USER_INPUT","userInput":{"userResponse":"Synthetic test only"}},
                        {"type":"CORTEX_STEP_TYPE_PLANNER_RESPONSE","plannerResponse":{"response":"Native fixture response"}}]}}
                else:
                    result = {}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

            def log_message(self, *_args):
                pass

        self.runtime = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Runtime)
        threading.Thread(target=self.runtime.serve_forever, daemon=True).start()
        self.server = Server(ARGS.binary)
        self.server.env["ANTIGRAVITY_LS_ADDRESS"] = f"http://127.0.0.1:{self.runtime.server_port}"
        self.server.restart()

    def tearDown(self):
        self.server.close()
        self.runtime.shutdown()
        self.runtime.server_close()

    def test_catalog_tracks_account_entitlements_and_runtime_updates(self):
        first = self.server.json("GET", "/api/models")[1]
        self.assertTrue(first["connected"])
        self.assertEqual([m["id"] for m in first["models"]], ["future-v99","paid-v2"])
        self.assertTrue(first["models"][1]["disabled"])
        self.models["paid-v2"]["disabled"] = False
        self.models["future-v99"]["displayName"] = "Updated runtime model"
        second = self.server.json("GET", "/api/models?refresh=true")[1]
        self.assertFalse(second["models"][1]["disabled"])
        self.assertEqual(second["models"][0]["name"], "Updated runtime model")
        self.catalog_failure = True
        unavailable = self.server.json("GET", "/api/models?refresh=true")[1]
        self.assertFalse(unavailable["connected"])
        self.assertEqual(unavailable["models"], [])

    def test_exact_native_model_id_is_used_for_new_and_existing_sessions(self):
        cid = self.server.json("POST", "/api/conversations", {"title":"Model fixture"})[1]["id"]
        payload = {"prompt":"Synthetic test only", "conversation_id":cid, "model":"paid-v2"}
        self.assertEqual(self.server.json("POST", "/api/tasks/submit", payload)[0], 409)
        self.assertEqual(self.events, [])
        payload["model"] = "future-v99"
        result = self.server.json("POST", "/api/tasks/submit", payload)
        self.assertEqual(result[0], 200, result[1])
        self.assertTrue(self.events[0][1]["workspaceUris"][0].startswith("file:"))
        self.assertEqual(self.events[1][1]["cascadeConfig"]["plannerConfig"]["modelName"], "future-v99")
        self.assertEqual(self.events[1][1]["cascadeConfig"]["plannerConfig"]["planModel"], "MODEL_FUTURE")
        conv = self.server.json("GET", f"/api/conversations/{cid}")[1]
        self.assertIn("Native fixture response", [m["text"] for m in conv["messages"]])
        self.assertFalse(conv["is_processing"])
        self.server.restart()
        self.models["paid-v2"]["disabled"] = False
        payload["model"] = "paid-v2"
        result = self.server.json("POST", "/api/tasks/submit", payload)
        self.assertEqual(result[0], 200, result[1])
        self.assertEqual([m for m, _p in self.events], ["StartCascade","SendUserCascadeMessage","SendUserCascadeMessage"])
        self.assertEqual(self.events[-1][1]["cascadeConfig"]["plannerConfig"]["modelName"], "paid-v2")
        self.assertEqual(self.events[-1][1]["cascadeId"], "11111111-2222-4333-8444-555555555555")

    def test_queued_model_is_revalidated_before_delivery(self):
        cid = self.server.json("POST", "/api/conversations", {"title":"Queued model"})[1]["id"]
        task = self.server.json("POST", "/api/tasks/submit", {"prompt":"Fixture", "model":"future-v99","conversation_id":cid,"queue_mode":"queue"})[1]["task_id"]
        self.models["future-v99"]["disabled"] = True
        rejected = self.server.json("POST", f"/api/queue/{task}/dispatch")
        self.assertEqual(rejected[0], 409, rejected[1])
        self.assertEqual(self.events, [])
        self.assertIn(task, [t["id"] for t in self.server.json("GET", "/api/queue")[1]["queue"]])
        self.models["future-v99"]["disabled"] = False
        delivered = self.server.json("POST", f"/api/queue/{task}/dispatch")
        self.assertEqual(delivered[0], 200, delivered[1])

    def test_ide_answer_refreshes_access_and_resumes_a_waiting_native_turn(self):
        cid = self.server.json("POST", "/api/conversations", {"title":"Waiting for an answer"})[1]["id"]
        answer = {"conversation_id":cid,"answer":"Continue the fixture"}
        self.catalog_failure = True
        rejected = self.server.json("POST", "/api/conversations/answer", answer)
        self.assertEqual(rejected[0], 409, rejected[1])
        self.assertEqual(rejected[1]["code"], "model_unavailable")
        self.assertEqual(self.events, [])

        self.catalog_failure = False
        self.trajectory_status = "CASCADE_RUN_STATUS_WAITING_FOR_USER"
        sent = self.server.json("POST", "/api/tasks/submit", {"conversation_id":cid,"prompt":"Fixture","model":"future-v99"})
        self.assertEqual(sent[0], 200, sent[1])
        self.assertIn(cid, self.server.json("GET", "/api/conversations/active-tasks")[1]["active_tasks"])
        self.models["future-v99"]["disabled"] = True
        self.assertEqual(self.server.json("POST", "/api/conversations/answer", answer)[0], 409)
        self.assertEqual(len(self.events), 2)
        self.models["future-v99"]["disabled"] = False
        accepted = self.server.json("POST", "/api/conversations/answer", answer)
        self.assertEqual(accepted[0], 200, accepted[1])
        self.assertEqual([event[0] for event in self.events], ["StartCascade", "SendUserCascadeMessage", "SendUserCascadeMessage"])
        self.assertEqual(self.events[-1][1]["cascadeId"], self.events[1][1]["cascadeId"])
        self.assertEqual(self.events[-1][1]["cascadeConfig"]["plannerConfig"]["modelName"], "future-v99")
        self.models["future-v99"]["disabled"] = True
        self.assertEqual(self.server.json("POST", "/api/conversations/answer", answer)[0], 409)
        self.assertEqual(len(self.events), 3)

    def test_account_downgrade_is_checked_again_even_after_picker_was_loaded(self):
        self.server.json("GET", "/api/models")
        cid = self.server.json("POST", "/api/conversations", {"title":"Downgrade"})[1]["id"]
        self.models["future-v99"]["disabled"] = True
        for model in ("future-v99", ""):
            result = self.server.json("POST", "/api/tasks/submit", {"conversation_id":cid,"prompt":"Fixture","model":model})
            self.assertEqual(result[0], 409, result[1])
        self.assertEqual(self.events, [])

    def test_default_retains_native_choice_and_rejects_restricted_native_default(self):
        cid = self.server.json("POST", "/api/conversations", {"title":"Native default"})[1]["id"]
        payload = {"conversation_id":cid,"prompt":"Fixture","model":None}
        self.default_model = "paid-v2"
        self.assertEqual(self.server.json("POST", "/api/tasks/submit", payload)[0], 409)
        self.assertEqual(self.events, [])
        self.default_model = "future-v99"
        result = self.server.json("POST", "/api/tasks/submit", payload)
        self.assertEqual(result[0], 200, result[1])
        planner = self.events[-1][1]["cascadeConfig"]["plannerConfig"]
        self.assertNotIn("modelName", planner)
        self.assertNotIn("planModel", planner)

    def test_default_followup_retains_and_revalidates_the_known_ide_model(self):
        cid = self.server.json("POST", "/api/conversations", {"title":"Preserve session selection"})[1]["id"]
        payload = {"conversation_id":cid,"prompt":"Fixture","model":"future-v99"}
        self.assertEqual(self.server.json("POST", "/api/tasks/submit", payload)[0], 200)
        self.server.json("GET", f"/api/conversations/{cid}")
        self.server.restart()
        payload["model"] = None
        result = self.server.json("POST", "/api/tasks/submit", payload)
        self.assertEqual(result[0], 200, result[1])
        self.assertEqual(self.events[-1][1]["cascadeConfig"]["plannerConfig"]["modelName"], "future-v99")
        self.models["future-v99"]["disabled"] = True
        self.models["paid-v2"]["disabled"] = False
        self.assertEqual(self.server.json("POST", "/api/tasks/submit", payload)[0], 409)
        self.assertEqual(len(self.events), 3)

    def test_auto_never_uses_cli_to_hide_a_responding_desktop_catalog_error(self):
        library = max((ROOT / "target/debug/deps").glob("libserde_json-*.rlib"), key=lambda p: p.stat().st_mtime)
        helper = ROOT / "target/test-agy.exe"
        subprocess.run(["rustc", "--edition=2021", str(ROOT / "tests/fake_acp.rs"), "--extern", f"serde_json={library}",
                        "-L", f"dependency={ROOT / 'target/debug/deps'}", "-o", str(helper)], check=True)
        catalog = self.server.root / "cli-catalog.json"
        log = self.server.root / "cli-calls.jsonl"
        catalog.write_text('[{"id":"future-v99","name":"Different account"}]', encoding="utf8")
        self.server.env.update(BRIDGE_AGY_EXE=str(helper), AGY_FIXTURE_CATALOG=str(catalog), AGY_FIXTURE_LOG=str(log))
        self.server.restart()
        cid = self.server.json("POST", "/api/conversations", {"title":"No implicit account switch"})[1]["id"]
        for failure in (403, 503, False):
            with self.subTest(failure=failure):
                self.catalog_failure = failure
                self.catalog_body = {"response":{"models":{},"agentModelSorts":[{"groups":{}}]}}
                result = self.server.json("GET", "/api/models?refresh=true")[1]
                self.assertFalse(result["connected"])
                self.assertEqual(result["target"], "ide")
                self.assertEqual(result["models"], [])
                sent = self.server.json("POST", "/api/tasks/submit", {"conversation_id":cid,"prompt":"Fixture","model":"future-v99"})
                self.assertEqual(sent[0], 409, sent[1])
        self.assertFalse(log.exists(), "CLI must not be queried after a desktop denial or incompatible response")
        self.assertEqual(self.events, [])

    def test_malformed_entitlements_never_execute_and_bound_target_cannot_change(self):
        cid = self.server.json("POST", "/api/conversations", {"title":"Strict access"})[1]["id"]
        payload = {"conversation_id":cid,"prompt":"Fixture","model":"future-v99"}
        self.models["future-v99"]["disabled"] = "false"
        self.assertEqual(self.server.json("POST", "/api/tasks/submit", payload)[0], 409)
        self.assertEqual(self.events, [])
        self.models["future-v99"]["disabled"] = False
        self.assertEqual(self.server.json("POST", "/api/tasks/submit", payload)[0], 200)
        result = self.server.json("POST", "/api/tasks/submit", dict(payload, execution_target="cli"))
        self.assertEqual(result[0], 409, result[1])
        self.assertEqual(result[1]["code"], "target_mismatch")
        self.assertEqual(len(self.events), 2)


class AcpFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        library = max((ROOT / "target/debug/deps").glob("libserde_json-*.rlib"), key=lambda p: p.stat().st_mtime)
        cls.helper = ROOT / "target/test-agy.exe"
        subprocess.run(["rustc", "--edition=2021", str(ROOT / "tests/fake_acp.rs"), "--extern", f"serde_json={library}",
                        "-L", f"dependency={ROOT / 'target/debug/deps'}", "-o", str(cls.helper)], check=True)

    def setUp(self):
        self.server = Server(ARGS.binary)
        self.catalog = self.server.root / "catalog.json"
        self.log = self.server.root / "acp_calls.jsonl"
        self.catalog.write_text(json.dumps([{"id":"future-high","name":"Future (High)"},
                                           {"id":"future-xhigh","name":"Future (XHigh)"}]), encoding="utf8")
        self.server.env.update(BRIDGE_AGY_EXE=str(self.helper), AGY_FIXTURE_CATALOG=str(self.catalog), AGY_FIXTURE_LOG=str(self.log))
        self.server.restart()
        self.cid = self.server.json("POST", "/api/conversations", {"title":"ACP fixture"})[1]["id"]

    def tearDown(self):
        self.server.close()

    def events(self):
        return [json.loads(line) for line in self.log.read_text(encoding="utf8").splitlines(keepends=True) if line.endswith("\n")]

    def send(self, prompt="Fixture", model="future-high"):
        return self.server.json("POST", "/api/tasks/submit", {"conversation_id":self.cid,"prompt":prompt,"model":model,"execution_target":"auto"})

    def completed(self):
        for _ in range(100):
            conv = self.server.json("GET", f"/api/conversations/{self.cid}")[1]
            active = self.server.json("GET", "/api/conversations/active-tasks")[1]
            if any(m["sender"] == "antigravity" for m in conv["messages"]) and not active["active_tasks"]:
                return self.server.json("GET", f"/api/conversations/{self.cid}")[1]
            time.sleep(.05)
        self.fail("ACP turn did not complete")

    def test_exact_cli_models_stream_follow_up_and_resume_after_restart(self):
        catalog = self.server.json("GET", "/api/models")[1]
        self.assertEqual(catalog["target"], "cli")
        self.assertEqual([m["id"] for m in catalog["models"]], ["future-high","future-xhigh"])
        self.assertEqual(self.send()[0], 200)
        conv = self.completed()
        self.assertIn("ACP_OK future-high", [m["text"] for m in conv["messages"]])
        session = conv["acp_session_id"]
        self.assertEqual(self.send(model="future-xhigh")[0], 200)
        self.completed()
        self.server.restart()
        self.assertEqual(self.send()[0], 200)
        self.assertEqual(self.completed()["acp_session_id"], session)
        calls = self.events()
        self.assertEqual(sum(e["method"] == "session/new" for e in calls), 1)
        self.assertEqual(sum(e["method"] == "session/load" for e in calls), 2)
        self.assertEqual(sum(e["method"] == "session/prompt" for e in calls), 3)

    def test_stop_cancels_the_running_session(self):
        self.assertEqual(self.send(prompt="wait")[0], 200)
        for _ in range(100):
            if any(e["method"] == "session/prompt" for e in self.events()): break
            time.sleep(.02)
        stopped = self.server.json("POST", "/api/tasks/active/stop", {"conversation_id":self.cid})
        self.assertEqual(stopped[0], 200, stopped[1])
        self.assertEqual(self.completed()["messages"][-1]["status"], "cancelled")

    def test_queue_recovers_from_a_session_setup_failure_without_double_sending(self):
        session_file = self.server.root / "session-bootstrap.json"
        self.server.env["AGY_FIXTURE_SESSION_CATALOG"] = str(session_file)
        self.server.restart()
        api = self.server.json
        status, ticket, _ = api("POST","/api/tasks/submit",{"conversation_id":self.cid,
            "prompt":"One fixture turn","model":"future-high","execution_target":"cli","queue_mode":"queue"})
        self.assertEqual(status,200,ticket)
        route = f"/api/queue/{ticket['task_id']}/dispatch"
        status, failed, _ = api("POST",route)
        self.assertEqual((status,failed.get("code")),(502,"delivery_not_started"),failed)
        self.assertFalse(any(e["method"] == "session/prompt" for e in self.events()))
        session_file.write_text(json.dumps({"models":{"currentModelId":"future-high",
            "availableModels":[{"modelId":"future-high","name":"Future (High)"}]}}))
        status, sent, _ = api("POST",route)
        self.assertEqual(status,200,sent)
        self.completed()
        self.assertEqual(sum(e["method"] == "session/prompt" for e in self.events()),1)

    def test_queue_revalidates_cli_catalog_without_switching_transport(self):
        payload = {"conversation_id":self.cid,"prompt":"Fixture","model":"future-xhigh","queue_mode":"queue"}
        queued = self.server.json("POST", "/api/tasks/submit", payload)[1]
        self.catalog.write_text('[{"id":"future-high","name":"Future (High)"}]', encoding="utf8")
        result = self.server.json("POST", f"/api/queue/{queued['task_id']}/dispatch")
        self.assertEqual(result[0], 409, result[1])
        self.assertFalse(any(e["method"] == "session/prompt" for e in self.events()))
        self.assertEqual(len(self.server.json("GET", "/api/queue")[1]["queue"]), 1)

    def test_session_specific_policy_and_revoked_default_never_send_a_prompt(self):
        session_catalog = self.server.root / "session-catalog.json"
        self.server.env["AGY_FIXTURE_SESSION_CATALOG"] = str(session_catalog)
        for model, current in (("future-xhigh", "future-high"), ("", "revoked-model")):
            with self.subTest(model=model):
                session_catalog.write_text(json.dumps({"models":{"currentModelId":current,
                    "availableModels":[{"modelId":"future-high","name":"Future (High)"}]}}), encoding="utf8")
                self.server.restart()
                result = self.send(model=model)
                self.assertEqual(result[0], 409, result[1])
                self.assertFalse(any(e["method"] == "session/prompt" for e in self.events()))

    def test_disconnect_preserves_partial_reply_and_marks_uncertain_delivery(self):
        self.assertEqual(self.send(prompt="disconnect")[0], 200)
        conv = self.completed()
        self.assertTrue(conv["delivery_uncertain"])
        self.assertIn("ACP_OK", conv["messages"][-1]["text"])
        self.assertEqual(conv["messages"][-1]["status"], "error")
        self.assertEqual(sum(e["method"] == "session/prompt" for e in self.events()), 1)

    def test_oversize_stream_is_bounded_and_recorded_as_an_error(self):
        self.assertEqual(self.send(prompt="oversize")[0], 200)
        conv = self.completed()
        reply = conv["messages"][-1]
        self.assertEqual(reply["status"], "error")
        self.assertIn("reply exceeded the supported size", reply["text"])
        self.assertLessEqual(len(reply["text"].encode("utf8")), 4 * 1024 * 1024 + 128)
        self.assertTrue(conv["delivery_uncertain"])

    def permission(self):
        assert self.send(prompt="permission")[0] == 200
        for _ in range(30):
            tasks = self.server.json("GET", "/api/tasks/pending")[1]["tasks"]
            if tasks:
                return tasks[0]
            time.sleep(.1)
        self.fail("native permission never became visible")

    def test_tool_permission_uses_exact_offered_choice_and_rejects_stale_decisions(self):
        for path, option in (("approve", "read-once"), ("reject", "deny")):
            task = self.permission()
            self.assertEqual(task["title"], "Read fixture.txt")
            body = {"conversation_id": self.cid, "request_id": task["request_id"], "option_id": option}
            endpoint = "/api/tasks/" + path
            self.assertEqual(self.server.json("POST", endpoint, dict(body, conversation_id="other"))[0], 409)
            self.assertEqual(self.server.json("POST", endpoint, dict(body, option_id="invented"))[0], 400)
            opposite = "/api/tasks/" + ("reject" if path == "approve" else "approve")
            self.assertEqual(self.server.json("POST", opposite, body)[0], 400)
            self.assertEqual(self.server.json("GET", "/api/tasks/pending")[1]["tasks"][0], task)
            self.assertEqual(self.server.json("POST", endpoint, body)[0], 200)
            self.completed()
            self.assertEqual(self.server.json("POST", endpoint, body)[0], 409)
            self.assertEqual(self.server.json("GET", "/api/tasks/pending")[1]["tasks"], [])
            replies = [e["result"]["outcome"] for e in self.events() if e.get("id") == 9000]
            self.assertEqual(replies[-1], {"outcome":"selected","optionId":option})

    def test_stop_cancels_pending_permission_and_restart_invalidates_it(self):
        task = self.permission()
        self.assertEqual(self.server.json("POST", "/api/tasks/active/stop", {"conversation_id":self.cid})[0], 200)
        self.completed()
        self.assertIn({"outcome":"cancelled"}, [e["result"]["outcome"] for e in self.events() if e.get("id") == 9000])
        task = self.permission()
        self.server.restart()
        self.assertEqual(self.server.json("GET", "/api/tasks/pending")[1]["tasks"], [])
        body = {"request_id":task["request_id"],"conversation_id":self.cid,"option_id":"read-once"}
        self.assertEqual(self.server.json("POST", "/api/tasks/approve", body)[0], 409)

    def test_restart_marks_an_unfinished_turn_uncertain_without_resending_it(self):
        self.assertEqual(self.send(prompt="wait")[0], 200)
        for _ in range(100):
            if any(e.get("method") == "session/prompt" for e in self.events()): break
            time.sleep(.02)
        self.server.restart()
        conv = self.server.json("GET", f"/api/conversations/{self.cid}")[1]
        self.assertTrue(conv["delivery_uncertain"])
        self.assertFalse(conv["is_processing"])
        self.assertIn("restarted before AGY confirmed completion", conv["messages"][-1]["text"])
        self.assertEqual(sum(e.get("method") == "session/prompt" for e in self.events()), 1)

    def test_images_use_acp_content_and_answer_reuses_the_bound_session(self):
        body = b'--audit\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n\x1a\nfixture\r\n--audit--\r\n'
        image = self.server.json("POST", "/api/upload", body, {"Content-Type":"multipart/form-data; boundary=audit"})[1]
        sent = self.server.json("POST", "/api/tasks/submit", {"conversation_id":self.cid,"prompt":"Fixture image",
            "execution_target":"cli","model":"future-high","images":[image["file_path"]]})
        self.assertEqual(sent[0], 200, sent[1])
        self.completed()
        prompt = next(e for e in self.events() if e.get("method") == "session/prompt")
        self.assertEqual(prompt["params"]["prompt"][1]["type"], "image")
        self.assertEqual(prompt["params"]["prompt"][1]["mimeType"], "image/png")
        answered = self.server.json("POST", "/api/conversations/answer", {"conversation_id":self.cid,"answer":"Follow-up answer"})
        self.assertEqual(answered[0], 200, answered[1])
        for _ in range(100):
            if sum(e.get("method") == "session/prompt" for e in self.events()) == 2: break
            time.sleep(.03)
        self.completed()
        self.assertEqual(sum(e.get("method") == "session/new" for e in self.events()), 1)


class Smoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(ARGS.binary)

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def create(self):
        status, conv, _ = self.server.json("POST", "/api/conversations", {"title": "Audit fixture"})
        self.assertEqual(status, 200)
        return conv["id"]

    def test_disconnected_models_never_return_a_demo_catalog(self):
        status, catalog, _ = self.server.json("GET", "/api/models")
        self.assertEqual(status, 200)
        self.assertFalse(catalog["connected"])
        self.assertEqual(catalog["models"], [])

    def test_launch_overrides_expire_after_restart(self):
        server = Server(ARGS.binary)
        try:
            server.env.update(BRIDGE_ALLOW_TUNNEL="1", BRIDGE_ALLOW_SHELL="1")
            server.restart()
            status, current, _ = server.json("POST", "/api/settings", {"require_lan_pin":True})
            self.assertEqual(status, 200)
            self.assertEqual((current["remote_mode"], current["allow_shell"]), ("tunnel", True))
            saved = json.loads((server.root / "data/.bridge_settings.json").read_text())
            self.assertEqual(saved, {"remote_mode":"lan", "allow_shell":False, "require_lan_pin":True})
            del server.env["BRIDGE_ALLOW_TUNNEL"], server.env["BRIDGE_ALLOW_SHELL"]
            server.restart()
            self.assertEqual(server.json("GET", "/api/connection")[1]["settings"], saved)
        finally:
            server.close()

    def test_pairing_storage_errors_leave_the_previous_token_intact(self):
        server = Server(ARGS.binary)
        try:
            data = server.root / "data"
            token = data / ".bridge_token"
            previous = token.read_bytes()
            (data / ".bridge_settings.json").mkdir()
            self.assertEqual(server.json("POST", "/api/pairing/reset")[0], 500)
            self.assertTrue(token.read_bytes() == previous)
            backup = data / "saved-token"
            token.rename(backup)
            token.mkdir()
            self.assertEqual(server.json("GET", "/api/connection")[0], 503)
            self.assertEqual(server.json("GET", "/healthz")[0], 200)
            token.rmdir()
            backup.rename(token)
            self.assertEqual(server.json("GET", "/api/connection")[0], 200)
        finally:
            server.close()

    def test_session_workspace_is_bound_at_creation(self):
        cid = self.create()
        conv = self.server.json("GET", f"/api/conversations/{cid}")[1]
        self.assertEqual(Path(conv["workspace_path"]).resolve(), self.server.root.resolve())

    def test_queue_retry_is_idempotent_after_restart(self):
        payload = {"request_id":str(uuid.uuid4()), "prompt":"send only once", "conversation_id":self.create(), "queue_mode":"queue"}
        first = self.server.json("POST", "/api/tasks/submit", payload)
        self.server.restart()
        second = self.server.json("POST", "/api/tasks/submit", payload)
        try:
            self.assertEqual(first[0], 200)
            self.assertEqual(first[1]["task_id"], second[1]["task_id"])
            conflicting = dict(payload, prompt="different task")
            self.assertEqual(self.server.json("POST", "/api/tasks/submit", conflicting)[0], 409)
        finally:
            self.server.request("POST", "/api/queue/clear")

    def test_read_routes(self):
        for path in ["/api/status", "/api/tokens", "/api/account", "/api/models", "/api/skills",
                     "/api/workspaces", "/api/workspaces/browse", "/api/changes", "/api/conversations",
                     "/api/tasks/active", "/api/tasks/pending", "/api/queue", "/api/connection"]:
            with self.subTest(path=path):
                status, data, _ = self.server.json("GET", path)
                self.assertEqual(status, 200)
                self.assertIsInstance(data, dict)

    def test_unknown_quota_is_not_full(self):
        data = self.server.json("GET", "/api/tokens")[1]
        self.assertFalse(data["is_live"])
        for model in data["models_quota"].values():
            for bucket in ["weekly", "five_hour"]:
                self.assertIsNone(model[bucket]["remaining_pct"])

    def test_security_headers_and_rebinding(self):
        status, headers, _ = self.server.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(self.server.request("GET", "/api/status", headers={"Host":"evil.example"})[0], 403)

    def test_legacy_stubs_fail_explicitly(self):
        for method, path in [("GET", "/api/clipboard"), ("POST", "/api/clipboard"),
                             ("POST", "/api/sound/test"), ("POST", "/api/account/switch"),
                             ("POST", "/api/account/logout"), ("POST", "/api/account/login")]:
            with self.subTest(path=path):
                self.assertEqual(self.server.json(method, path, {} if method == "POST" else None)[0], 501)

    def test_stop_failure_is_not_success(self):
        status, _, _ = self.server.json("POST", "/api/tasks/active/stop", {"conversation_id":self.create()})
        self.assertEqual(status, 502)

    def test_queue_persists(self):
        cid = self.create()
        _, data, _ = self.server.json("POST", "/api/tasks/submit", {
            "prompt":"saved task", "conversation_id":cid, "queue_mode":"queue"})
        try:
            saved = json.loads((self.server.root / "data" / "task_queue.json").read_text())
            self.assertIn(data["task_id"], [t["id"] for t in saved])
            self.assertEqual(next(t for t in saved if t["id"] == data["task_id"])["execution_target"], "auto")
            self.server.restart()
            queue = self.server.json("GET", "/api/queue")[1]["queue"]
            self.assertIn(data["task_id"], [t["id"] for t in queue])
        finally:
            self.server.request("DELETE", f'/api/queue/{data["task_id"]}')

    def test_tunnel_auth_owner_boundary_and_rotation(self):
        self.server.json("POST", "/api/settings", {"remote_mode":"tunnel"})
        token = (self.server.root / "data" / ".bridge_token").read_text().strip()
        pin = f'{int.from_bytes(hashlib.sha256(token.encode()).digest()[:4], "big") % 1000000:06}'
        proxy = {"X-Forwarded-For":"203.0.113.1"}
        try:
            self.assertEqual(self.server.json("GET", "/api/status", headers=proxy)[0], 401)
            status, hdr, _ = self.server.request("GET", f"/?t={pin}", headers=proxy)
            self.assertEqual(status, 200)
            cookie = next(value for key, value in hdr.items() if key.lower() == "set-cookie")
            self.assertIn("HttpOnly", cookie)
            self.assertIn("Secure", cookie)
            authed = dict(proxy, Cookie=f"ag_session={token}")
            self.assertEqual(self.server.json("GET", "/api/status", headers=authed)[0], 200)
            self.assertEqual(self.server.json("GET", "/api/qr", headers=authed)[0], 403)
            self.assertEqual(self.server.json("POST", "/api/settings", {}, authed)[0], 403)
            self.assertEqual(self.server.json("GET", "/api/status", headers=dict(proxy, Cookie=f"ag_session={pin}"))[0], 401)
            self.assertEqual(self.server.json("POST", "/api/pairing/reset")[0], 200)
            self.assertEqual(self.server.json("GET", "/api/status", headers=authed)[0], 401)
        finally:
            self.server.json("POST", "/api/settings", {"remote_mode":"lan", "require_lan_pin":False})

    def test_pairing_reset_closes_an_established_phone_session_promptly(self):
        from websockets.exceptions import ConnectionClosed
        from websockets.sync.client import connect
        api = self.server.json
        api("POST","/api/settings",{"remote_mode":"tunnel"})
        token = (self.server.root / "data/.bridge_token").read_text().strip()
        try:
            with connect(f"ws://127.0.0.1:{self.server.port}/ws", additional_headers={
                "CF-Connecting-IP":"192.0.2.55","Cookie":f"ag_session={token}"}, open_timeout=5) as phone:
                self.assertEqual(json.loads(phone.recv(timeout=10))["type"],"INITIAL_STATE")
                self.assertEqual(api("POST","/api/pairing/reset")[0],200)
                deadline = time.monotonic() + 3
                with self.assertRaises(ConnectionClosed):
                    while time.monotonic() < deadline:
                        phone.recv(timeout=max(.05,deadline-time.monotonic()))
        finally:
            api("POST","/api/settings",{"remote_mode":"lan","require_lan_pin":False})

    def test_websocket_initial_state_and_ping(self):
        with socket.create_connection(("127.0.0.1", self.server.port), timeout=12) as sock:
            sock.sendall((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{self.server.port}\r\n"
                          f"Origin: http://127.0.0.1:{self.server.port}\r\nUpgrade: websocket\r\n"
                          "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").encode())
            stream = sock.makefile("rb")
            self.assertIn(b"101", stream.readline())
            while stream.readline() != b"\r\n":
                pass

            def read_message():
                for _ in range(5):
                    first, second = stream.read(2)
                    length = second & 127
                    if length == 126:
                        length = int.from_bytes(stream.read(2), "big")
                    elif length == 127:
                        length = int.from_bytes(stream.read(8), "big")
                    data = stream.read(length)
                    if first & 15 == 9:
                        sock.sendall(bytes([0x8A, 0x80 | len(data)]) + b"\0" * 4 + data)
                    elif first & 15 == 1:
                        return json.loads(data)
                self.fail("No JSON WebSocket frame received")

            self.assertEqual(read_message()["type"], "INITIAL_STATE")
            message = b'{"type":"PING"}'
            sock.sendall(bytes([0x81, 0x80 | len(message)]) + b"\0" * 4 + message)
            self.assertEqual(read_message()["type"], "PONG")
            sock.sendall(b"\x88\x80" + b"\0" * 4)

    def test_static_app_and_worker(self):
        for path in ["/", "/static/app.js", "/static/app.css", "/static/ux.css", "/static/connect.js",
                     "/static/manifest.json", "/sw.js", "/static/icon-192.png"]:
            with self.subTest(path=path):
                status, _, body = self.server.request("GET", path)
                self.assertEqual(status, 200)
                self.assertTrue(body)

    def test_conversation_lifecycle(self):
        cid = self.create()
        self.assertEqual(self.server.json("GET", f"/api/conversations/{cid}")[1]["id"], cid)
        self.assertEqual(self.server.json("POST", "/api/conversations/select", {"conversation_id": cid})[0], 200)
        self.assertEqual(self.server.json("DELETE", f"/api/conversations/{cid}")[0], 200)
        self.assertEqual(self.server.json("GET", f"/api/conversations/{cid}")[0], 404)

    def test_dispatch_failure_is_not_success(self):
        cid = self.create()
        status, data, _ = self.server.json("POST", "/api/tasks/submit", {"prompt": "audit only", "conversation_id": cid})
        self.assertEqual(status, 409, data)
        self.assertEqual(data["code"], "model_unavailable")
        self.assertIsNone(self.server.json("GET", "/api/tasks/active")[1]["active_task"])

    def test_review_mode_cannot_bypass_approval(self):
        status, data, _ = self.server.json("POST", "/api/tasks/submit", {
            "prompt": "audit only", "conversation_id": self.create(), "auto_execute": False})
        self.assertEqual(status, 501, data)

    def test_unbound_approval_requests_are_rejected(self):
        for path in ["/api/tasks/approve", "/api/tasks/reject"]:
            with self.subTest(path=path):
                self.assertEqual(self.server.json("POST", path, {"task_id":"missing"})[0], 400)

    def test_bad_origin_is_blocked(self):
        for origin in ["https://evil.example", "null", "not-a-url"]:
            with self.subTest(origin=origin):
                self.assertEqual(self.server.json("POST", "/api/settings", {}, {"Origin":origin})[0], 403)

    def test_cross_origin_websocket_is_blocked(self):
        status, _, _ = self.server.request("GET", "/ws", headers={
            "Origin":"https://evil.example", "Upgrade":"websocket", "Connection":"Upgrade",
            "Sec-WebSocket-Version":"13", "Sec-WebSocket-Key":"dGhlIHNhbXBsZSBub25jZQ=="})
        self.assertEqual(status, 403)

    def test_shell_disabled(self):
        self.assertEqual(self.server.json("POST", "/api/command/exec", {"command":"echo audit"})[0], 403)

    def test_queue_failure_keeps_task(self):
        cid = self.create()
        status, data, _ = self.server.json("POST", "/api/tasks/submit", {
            "prompt":"audit queued task", "conversation_id":cid, "queue_mode":"queue"})
        self.assertEqual(status, 200)
        task = data["task_id"]
        try:
            self.assertEqual(self.server.json("POST", f"/api/queue/{task}/dispatch")[0], 409)
            self.assertIn(task, [q["id"] for q in self.server.json("GET", "/api/queue")[1]["queue"]])
        finally:
            self.server.request("DELETE", f"/api/queue/{task}")

    def test_invalid_image_is_rejected(self):
        body = b'--audit\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\nnot an image\r\n--audit--\r\n'
        self.assertEqual(self.server.request("POST", "/api/upload", body, {"Content-Type":"multipart/form-data; boundary=audit"})[0], 400)

    def test_upload_extension_cannot_serve_html(self):
        body = b'--audit\r\nContent-Disposition: form-data; name="file"; filename="x.html"\r\nContent-Type: text/html\r\n\r\n\x89PNG\r\n\x1a\n<script>alert(1)</script>\r\n--audit--\r\n'
        status, data, _ = self.server.json("POST", "/api/upload", body, {"Content-Type":"multipart/form-data; boundary=audit"})
        self.assertEqual(status, 200)
        self.assertTrue(data["filename"].endswith(".png"), data)

    def test_browse_directory_contract_and_desktop_alias(self):
        server = Server(ARGS.binary)
        try:
            for name in ("Desktop", "Documents", "Projects"):
                (server.root / "home" / name).mkdir(parents=True, exist_ok=True)
            sample = server.root / "sample"
            (sample / "sub-alpha" / ".git").mkdir(parents=True)
            (sample / "sub-alpha" / "src").mkdir(parents=True)
            (sample / "sub-empty").mkdir()
            (sample / "node_modules" / "pkg").mkdir(parents=True)
            (sample / ".hidden").mkdir()
            server.restart()

            status, data, _ = server.json("GET", f"/api/workspaces/browse?target_dir={quote(str(sample), safe='')}")
            self.assertEqual(status, 200, data)
            self.assertEqual(data["status"], "ok")
            self.assertIsInstance(data.get("entries"), list)
            subfolders = {sf["name"]: sf for sf in data["subfolders"]}
            self.assertEqual(sorted(subfolders), ["sub-alpha", "sub-empty"])
            self.assertTrue(subfolders["sub-alpha"]["is_git"])
            self.assertEqual(subfolders["sub-alpha"]["subfolder_count"], 1)
            self.assertTrue(subfolders["sub-alpha"]["has_children"])
            self.assertFalse(subfolders["sub-empty"]["is_git"])
            self.assertEqual(subfolders["sub-empty"]["subfolder_count"], 0)
            self.assertFalse(subfolders["sub-empty"]["has_children"])
            self.assertEqual(Path(data["parent_path"]).resolve(), server.root.resolve())
            self.assertEqual(
                [Path(b["path"]).resolve() for b in data["breadcrumbs"][-2:]],
                [server.root.resolve(), sample.resolve()],
            )
            shortcut_names = {s["name"] for s in data["shortcuts"]}
            self.assertTrue({"Desktop", "Documents", "Projects"}.issubset(shortcut_names), data["shortcuts"])

            status, desktop, _ = server.json("GET", "/api/workspaces/browse?target_dir=desktop")
            self.assertEqual(status, 200, desktop)
            self.assertEqual(desktop["status"], "ok")
            self.assertEqual(Path(desktop["current_path"]).resolve(), (server.root / "home" / "Desktop").resolve())
        finally:
            server.close()

    def reviewed_action(self, endpoint, payload):
        workspace = quote(payload["workspace_path"], safe="")
        _, snapshot, _ = self.server.json("GET", "/api/changes?workspace_path=" + workspace)
        return self.server.json("POST", endpoint, {**payload, "revision": snapshot.get("revision")})

    def test_reject_untracked_single_file_and_return_changes(self):
        repo = self.server.root / "git-reject-fixture"
        (repo / "sub").mkdir(parents=True)
        try:
            for args in (
                ["init"],
                ["config", "core.autocrlf", "false"],
                ["config", "user.name", "Audit"],
                ["config", "user.email", "audit@example.invalid"],
            ):
                subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
            (repo / "tracked.txt").write_text("v1\n", encoding="utf8")
            subprocess.run(["git", "add", "--", "."], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "commit", "-m", "Initial"], cwd=repo, check=True, capture_output=True)

            (repo / "tracked.txt").write_text("v2\n", encoding="utf8")
            (repo / "sub" / "untracked.txt").write_text("temp\n", encoding="utf8")
            (repo / "keep.txt").write_text("keep\n", encoding="utf8")

            status, data, _ = self.reviewed_action("/api/changes/reject",
                {"file_path": "sub/untracked.txt", "workspace_path": str(repo)},
            )
            self.assertEqual(status, 200, data)
            self.assertEqual(data["status"], "ok", data)
            self.assertEqual(data["message"], "Changes to sub/untracked.txt were reverted.")
            self.assertFalse((repo / "sub" / "untracked.txt").exists())
            self.assertTrue((repo / "keep.txt").exists())
            paths = {f["path"] for f in data["changes"]["files"]}
            self.assertEqual(paths, {"tracked.txt", "keep.txt"})

            status, data2, _ = self.reviewed_action("/api/changes/reject",
                {"file_path": "tracked.txt", "workspace_path": str(repo)},
            )
            self.assertEqual(status, 200, data2)
            self.assertEqual((repo / "tracked.txt").read_text(encoding="utf8"), "v1\n")
            self.assertTrue((repo / "keep.txt").exists())
            self.assertEqual([f["path"] for f in data2["changes"]["files"]], ["keep.txt"])
        finally:
            shutil.rmtree(repo, ignore_errors=True)

    def test_command_exec_returns_command_and_duration_when_enabled(self):
        status, settings, _ = self.server.json("POST", "/api/settings", {"allow_shell": True})
        self.assertEqual(status, 200, settings)
        try:
            status, data, _ = self.server.json(
                "POST",
                "/api/command/exec",
                {"command": "Write-Output 'smoke-cmd-ok'"},
            )
            self.assertEqual(status, 200, data)
            self.assertEqual(data["status"], "ok")
            self.assertEqual(data["command"], "Write-Output 'smoke-cmd-ok'")
            self.assertEqual(data["returncode"], 0)
            self.assertIsInstance(data["duration_seconds"], (int, float))
            self.assertGreaterEqual(data["duration_seconds"], 0)
            self.assertIn("smoke-cmd-ok", data["stdout"])
        finally:
            self.server.json("POST", "/api/settings", {"allow_shell": False})
        self.assertEqual(self.server.json("POST", "/api/command/exec", {"command": "echo off"})[0], 403)

    def test_literal_file_named_all_is_accepted_and_rejected_individually(self):
        repo = self.server.root / "git-literal-all-fixture"
        repo.mkdir(parents=True)
        try:
            for args in (
                ["init"],
                ["config", "core.autocrlf", "false"],
                ["config", "user.name", "Audit"],
                ["config", "user.email", "audit@example.invalid"],
            ):
                subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
            (repo / "existing.txt").write_text("v1\n", encoding="utf8")
            subprocess.run(["git", "add", "--", "."], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "commit", "-m", "Initial"], cwd=repo, check=True, capture_output=True)

            (repo / "existing.txt").write_text("v2\n", encoding="utf8")
            (repo / "all").write_text("untracked all\n", encoding="utf8")

            status, data, _ = self.reviewed_action("/api/changes/reject",
                {"file_path": "all", "scope": "file", "workspace_path": str(repo)},
            )
            self.assertEqual(status, 200, data)
            self.assertEqual(data["status"], "ok", data)
            self.assertFalse((repo / "all").exists())
            self.assertEqual((repo / "existing.txt").read_text(encoding="utf8"), "v2\n")
            self.assertEqual([f["path"] for f in data["changes"]["files"]], ["existing.txt"])

            (repo / "all").write_text("accepted all\n", encoding="utf8")
            status, accepted, _ = self.reviewed_action("/api/changes/accept",
                {"file_path": "all", "workspace_path": str(repo)},
            )
            self.assertEqual(status, 200, accepted)
            self.assertEqual(accepted["status"], "ok", accepted)
            self.assertEqual((repo / "existing.txt").read_text(encoding="utf8"), "v2\n")
            self.assertEqual([f["path"] for f in accepted["changes"]["files"]], ["existing.txt"])

            (repo / "all").write_text("modified all\n", encoding="utf8")
            status, rejected_tracked, _ = self.reviewed_action("/api/changes/reject",
                {"file_path": "all", "workspace_path": str(repo)},
            )
            self.assertEqual(status, 200, rejected_tracked)
            self.assertEqual((repo / "all").read_text(encoding="utf8"), "accepted all\n")
            self.assertEqual((repo / "existing.txt").read_text(encoding="utf8"), "v2\n")
        finally:
            shutil.rmtree(repo, ignore_errors=True)

    def test_file_actions_handle_rename_and_refuse_directory_scope(self):
        repo = self.server.root / "git-rename-fixture"
        (repo / "src").mkdir(parents=True)

        def git(*args):
            return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout

        def act(action, path, workspace=repo):
            return self.reviewed_action(f"/api/changes/{action}", {
                "scope": "file", "file_path": path, "workspace_path": str(workspace),
            })[:2]

        git("init")
        git("config", "core.autocrlf", "false")
        git("config", "user.name", "Audit")
        git("config", "user.email", "audit@example.invalid")
        for name in ("old.txt", "src/one.txt", "src/[two].txt"):
            (repo / name).write_text("original\n", encoding="utf8")
        git("add", ".")
        git("commit", "-m", "Initial")
        for name in ("src/one.txt", "src/[two].txt"):
            (repo / name).write_text("unrelated\n", encoding="utf8")
        git("add", "src/one.txt")
        before = git("status", "--porcelain=v1")
        head = git("rev-parse", "HEAD")
        for action in ("accept", "reject"):
            with self.subTest(action=action, case="directory"):
                status, data = act(action, "src")
                self.assertEqual(status, 400, data)
                self.assertEqual(git("status", "--porcelain=v1"), before)
                self.assertEqual(git("rev-parse", "HEAD"), head)
                self.assertEqual((repo / "src/one.txt").read_text(), "unrelated\n")
                self.assertEqual((repo / "src/[two].txt").read_text(), "unrelated\n")

        git("mv", "old.txt", "new.txt")
        (repo / "new.txt").write_text("edited after move\n", encoding="utf8")
        (repo / "old.txt").write_text("new work at the old path\n", encoding="utf8")
        for action in ("accept", "reject"):
            status, data = act(action, "new.txt")
            self.assertEqual((status, data["status"]), (400, "error"), data)
        self.assertEqual((repo / "old.txt").read_text(), "new work at the old path\n")
        self.assertEqual((repo / "new.txt").read_text(), "edited after move\n")
        self.assertEqual(git("rev-parse", "HEAD"), head)
        (repo / "old.txt").unlink()

        listed = self.server.json("GET", "/api/changes?workspace_path=" + quote(str(repo)))[1]
        rename = next(file for file in listed["files"] if file["path"] == "new.txt")
        self.assertEqual((rename["status"], rename["original_path"]), ("renamed", "old.txt"))
        status, data = act("reject", "new.txt")
        self.assertEqual((status, data["status"]), (200, "ok"), data)
        self.assertEqual((repo / "old.txt").read_text(), "original\n")
        self.assertFalse((repo / "new.txt").exists())
        self.assertEqual(git("status", "--porcelain=v1"), before)

        git("mv", "old.txt", "new.txt")
        (repo / "new.txt").write_text("edited after move\n", encoding="utf8")
        status, data = act("accept", "new.txt")
        self.assertEqual((status, data["status"]), (200, "ok"), data)
        self.assertEqual(git("ls-tree", "-r", "--name-only", "HEAD").splitlines(),
                         ["new.txt", "src/[two].txt", "src/one.txt"])
        self.assertEqual(git("show", "HEAD:new.txt"), "edited after move\n")
        self.assertEqual(git("status", "--porcelain=v1"), before)

        # A deleted file has no worktree entry, and brackets are literal.
        (repo / "src/[two].txt").unlink()
        status, data = act("reject", "src/[two].txt")
        self.assertEqual((status, data["status"]), (200, "ok"), data)
        self.assertEqual((repo / "src/[two].txt").read_text(), "original\n")
        self.assertEqual(git("diff", "--cached", "--name-only").strip(), "src/one.txt")

        if os.name == "nt" and (repo / "NEW.txt").exists():
            head = git("rev-parse", "HEAD")
            git("mv", "new.txt", "NEW.txt")
            before = git("status", "--porcelain=v1")
            status, data = act("accept", "NEW.txt")
            self.assertEqual((status, data["status"]), (400, "error"), data)
            self.assertEqual(git("rev-parse", "HEAD"), head)
            self.assertEqual(git("status", "--porcelain=v1"), before)
            status, data = act("reject", "NEW.txt")
            self.assertEqual((status, data["status"]), (200, "ok"), data)
            self.assertIn("new.txt", [file.name for file in repo.iterdir()])
            self.assertEqual(git("diff", "--cached", "--name-only").strip(), "src/one.txt")

        nested = repo / "nested"
        nested_file = nested / "src/one.txt"
        nested_file.parent.mkdir(parents=True)
        nested_file.write_text("tracked nested file\n", encoding="utf8")
        git("add", "nested/src/one.txt")
        git("commit", "--only", "-m", "Add nested fixture", "--", "nested/src/one.txt")
        head = git("rev-parse", "HEAD")
        nested_file.write_text("unrelated nested file\n", encoding="utf8")
        for action in ("accept", "reject"):
            status, data = act(action, "src/one.txt", workspace=nested)
            self.assertEqual((status, data["status"]), (400, "error"), data)
        self.assertEqual(git("rev-parse", "HEAD"), head)
        self.assertEqual(nested_file.read_text(), "unrelated nested file\n")
        self.assertEqual(git("diff", "--cached", "--name-only").strip(), "src/one.txt")

    def test_bulk_actions_require_repo_root_and_preserve_obstructing_files(self):
        for case in ("nested", "replacement", "ignored", "directory", "ancestor", "rename"):
            with self.subTest(case=case):
                repo = self.server.root / ("bulk-protection-" + case)
                nested = repo / "folder"
                nested.mkdir(parents=True)
                def git(*args):
                    return subprocess.run(["git", *args], cwd=repo, check=True,
                                          capture_output=True, text=True).stdout
                git("init")
                git("config", "user.name", "Fixture")
                git("config", "user.email", "fixture@example.invalid")
                original = repo / "original"
                original.write_text("committed")
                (nested / "inside").write_text("baseline")
                (repo / "other").write_text("baseline")
                git("add", ".")
                git("commit", "-m", "baseline")
                (repo / "other").write_text("keep pending")
                protected = original
                if case == "directory":
                    original.unlink()
                    original.mkdir()
                    protected = original / "notes"
                elif case == "ancestor":
                    git("rm", "-r", "folder")
                    protected = nested
                elif case == "rename":
                    git("mv", "original", "renamed")
                elif case in ("replacement", "ignored"):
                    git("rm", "--cached", "original")
                    if case == "ignored":
                        (repo / ".gitignore").write_text("original\n")
                protected.write_text("user work")
                before = git("status", "--porcelain=v1"), git("rev-parse", "HEAD"), git("write-tree")
                actions = ("accept", "reject") if case == "nested" else ("reject",)
                for action in actions:
                    status, body, _ = self.reviewed_action("/api/changes/" + action, {
                        "workspace_path": str(nested if case == "nested" else repo), "scope": "all",
                    })
                    self.assertEqual(status, 400 if case == "nested" else 409, body)
                    self.assertEqual(protected.read_text(), "user work")
                    self.assertEqual((repo / "other").read_text(), "keep pending")
                    self.assertEqual((git("status", "--porcelain=v1"), git("rev-parse", "HEAD"), git("write-tree")), before)

    def test_revert_before_first_commit_keeps_staged_file(self):
        repo = self.server.root / "git-first-commit"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
        note = repo / "notes.txt"
        note.write_text("initial work")
        subprocess.run(["git", "add", "notes.txt"], cwd=repo, check=True, capture_output=True)
        for scope in ({"scope": "file", "file_path": "notes.txt"}, {"scope": "all"}):
            status, data, _ = self.reviewed_action("/api/changes/reject", {**scope, "workspace_path": str(repo)})
            self.assertEqual((status, data.get("code")), (409, "missing_head"), data)
            self.assertEqual(note.read_text(), "initial work")
            staged = subprocess.check_output(["git", "show", ":notes.txt"], cwd=repo, text=True)
            self.assertEqual(staged, "initial work")

    def test_changes_scope_validation_and_bulk_behavior(self):
        repo = self.server.root / "git-scope-fixture"
        repo.mkdir(parents=True)
        try:
            for args in (
                ["init"],
                ["config", "core.autocrlf", "false"],
                ["config", "user.name", "Audit"],
                ["config", "user.email", "audit@example.invalid"],
            ):
                subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
            (repo / "tracked.txt").write_text("v1\n", encoding="utf8")
            subprocess.run(["git", "add", "--", "."], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "commit", "-m", "Initial"], cwd=repo, check=True, capture_output=True)

            (repo / "tracked.txt").write_text("v2\n", encoding="utf8")
            (repo / "keep.txt").write_text("keep untracked\n", encoding="utf8")

            invalid_payloads = [
                {"scope": "all", "workspace_path": None},
                {"scope": "all", "workspace_path": ""},
                {"scope": "all", "workspace_path": 7},
                {"workspace_path": str(repo)},
                {"file_path": None, "workspace_path": str(repo)},
                {"file_path": "", "workspace_path": str(repo)},
                {"scope": "bogus", "file_path": "tracked.txt", "workspace_path": str(repo)},
                {"scope": "all", "file_path": "tracked.txt", "workspace_path": str(repo)},
            ]
            for path in ("/api/changes/reject", "/api/changes/accept"):
                for payload in invalid_payloads:
                    with self.subTest(path=path, payload=payload):
                        status, err, _ = self.server.json("POST", path, payload)
                        self.assertEqual(status, 400, err)
                        self.assertEqual(err["status"], "error")

            status, bulk_reject, _ = self.reviewed_action("/api/changes/reject",
                {"scope": "all", "workspace_path": str(repo)},
            )
            self.assertEqual(status, 200, bulk_reject)
            self.assertEqual(bulk_reject["status"], "ok", bulk_reject)
            self.assertEqual((repo / "tracked.txt").read_text(encoding="utf8"), "v1\n")
            self.assertTrue((repo / "keep.txt").exists())
            self.assertEqual([f["path"] for f in bulk_reject["changes"]["files"]], ["keep.txt"])

            status, bulk_accept, _ = self.reviewed_action("/api/changes/accept",
                {"scope": "all", "workspace_path": str(repo)},
            )
            self.assertEqual(status, 200, bulk_accept)
            self.assertEqual(bulk_accept["status"], "ok", bulk_accept)
            self.assertEqual(bulk_accept["changes"]["files"], [])
        finally:
            shutil.rmtree(repo, ignore_errors=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default="target/debug/antigravity-bridge.exe")
    parser.add_argument("--serve", type=int)
    parser.add_argument("--fixture-agent", action="store_true", help="Use the synthetic agent executable in the disposable browser fixture only")
    ARGS = parser.parse_args()
    if ARGS.serve:
        server = Server(ARGS.binary, ARGS.serve, keep=True, agent=ARGS.fixture_agent)
        print(f"Isolated UI fixture: http://127.0.0.1:{server.port}", flush=True)
        try:
            server.proc.wait()
        except KeyboardInterrupt:
            pass
        finally:
            server.close()
    else:
        unittest.main(argv=[__file__], verbosity=2)
