"""Use a disposable Chrome profile and the smoke suite's fake AGY. No provider calls."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

import psutil
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
import smoke


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    smoke.ARGS = args
    smoke.AcpFlow.setUpClass()
    fixture = smoke.AcpFlow()
    fixture.setUp()
    try:
        address = f"http://127.0.0.1:{fixture.server.port}/"
        with tempfile.TemporaryDirectory(prefix="bridge-consent-chrome-", ignore_cleanup_errors=True) as profile:
            chrome = os.environ.get("BRIDGE_CHROME_EXE", r"C:\Program Files\Google\Chrome\Application\chrome.exe")
            proc = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--no-first-run",
                "--remote-debugging-port=0", "--disable-background-networking", "--user-data-dir=" + profile,
                "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                port_file = Path(profile) / "DevToolsActivePort"
                for _ in range(100):
                    if port_file.exists() and port_file.read_text().splitlines(): break
                    time.sleep(.1)
                port = port_file.read_text().splitlines()[0]
                with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10) as res:
                    target = next(t for t in json.load(res) if t["type"] == "page")
                with connect(target["webSocketDebuggerUrl"], open_timeout=10) as ws:
                    seq = 0
                    def command(method, params):
                        nonlocal seq
                        seq += 1
                        ws.send(json.dumps({"method":method,"id":seq,"params":params}))
                        while True:
                            reply = json.loads(ws.recv(timeout=15))
                            if reply.get("id") == seq:
                                assert "error" not in reply, reply
                                return reply["result"]
                    def evaluate(js):
                        result = command("Runtime.evaluate", {"expression":js,"returnByValue":True})
                        assert "exceptionDetails" not in result, result
                        return result["result"].get("value")
                    def wait_for(js):
                        for _ in range(100):
                            if evaluate(js): return
                            time.sleep(.15)
                        raise AssertionError(js)

                    command("Emulation.setDeviceMetricsOverride", {"width":390,"height":844,"deviceScaleFactor":1,"mobile":True})
                    command("Emulation.setTouchEmulationEnabled", {"enabled":True})
                    command("Page.navigate", {"url":address})
                    wait_for('typeof state !== "undefined" && state.wsConnected')
                    evaluate('document.getElementById("tabBtnChat").focus()')
                    navigation = []
                    for expected in ("Chat", "Changes", "Usage", "Projects", "Connect", "Chat"):
                        tab = evaluate('''(() => {
                            const selected = document.querySelector('[role=tab][aria-selected=true]');
                            const panel = document.getElementById(selected.getAttribute('aria-controls'));
                            return {name:selected.querySelector('span').textContent,
                                focused:document.activeElement === selected,visible:panel.offsetHeight > 0,
                                overflow:document.documentElement.scrollWidth > innerWidth};
                        })()''')
                        assert tab == {"name":expected,"focused":True,"visible":True,"overflow":False}, tab
                        navigation.append(expected)
                        if len(navigation) < 6:
                            command("Input.dispatchKeyEvent", {"type":"keyDown","key":"ArrowRight","code":"ArrowRight","windowsVirtualKeyCode":39})
                            command("Input.dispatchKeyEvent", {"type":"keyUp","key":"ArrowRight","code":"ArrowRight","windowsVirtualKeyCode":39})
                    # Only the connection-status request is substituted. Exercise the shipped controls.
                    evaluate('''window.originalFetch = window.fetch;
                        window.fetch = (input, ...opts) => input === "/api/connection"
                            ? Promise.reject(new Error("Offline fixture")) : originalFetch(input, ...opts);
                        document.getElementById("tabBtnConnect").click()''')
                    wait_for('document.getElementById("cxRetry").offsetHeight > 0 && document.getElementById("cxUrl").disabled')
                    evaluate('''window.fetch = (input,...opts) => input === "/api/connection"
                        ? Promise.resolve(new Response(JSON.stringify({owner:false,settings:{remote_mode:"lan"}})))
                        : originalFetch(input,...opts);
                        document.getElementById("cxRetry").click()''')
                    wait_for('document.getElementById("cxChat").offsetHeight > 0 && !document.getElementById("cxRetry").offsetHeight')
                    evaluate('window.fetch = originalFetch; document.getElementById("cxChat").click()')
                    wait_for('document.activeElement.id === "tabBtnChat" && document.getElementById("tabContentChat").offsetHeight > 0')
                    first = fixture.permission()
                    selector = 'document.querySelector("#toolPermissionRequests")'
                    visible = f'{selector}?.offsetHeight > 0 && {selector}.textContent.includes("Read fixture.txt")'
                    wait_for(visible)
                    command("Page.reload", {"ignoreCache":True})
                    wait_for(visible)
                    focus_preserved = evaluate(f'''(() => {{
                        const button = {selector}.querySelector("button");
                        button.focus();
                        renderToolPermissions(structuredClone(state.toolPermissions));
                        return document.activeElement === button;
                    }})()''')
                    assert focus_preserved, "An unchanged permission refresh removed the focused button"
                    for name, option in (("Allow once","read-once"), ("Deny once","deny")):
                        if option == "deny":
                            next_request = fixture.permission()
                            assert next_request["request_id"] != first["request_id"]
                            wait_for(visible)
                        button = f'Array.from({selector}.querySelectorAll("button")).find(b=>b.textContent==={json.dumps(name)})'
                        evaluate(f'{button}.scrollIntoView({{block:"center", behavior:"instant"}})')
                        hit_point = f'''(() => {{
                            const b = {button}, r = b.getBoundingClientRect();
                            const x = r.left + r.width / 2, y = r.top + r.height / 2;
                            return b.contains(document.elementFromPoint(x,y)) ? {{x,y}} : null;
                        }})()'''
                        # Layout and compositor scrolling can settle on different frames after a reload.
                        point = None
                        for _ in range(30):
                            measured = evaluate(hit_point)
                            time.sleep(.25)
                            if measured and measured == evaluate(hit_point):
                                point = measured
                                break
                        assert point, f"{name} is covered or outside the phone viewport"
                        evaluate('''window.testTouches = [];
                            for (const type of ["touchstart","touchend","pointerdown","pointerup","click"]) {
                                document.addEventListener(type, e => testTouches.push([type, e.target.tagName,
                                    e.target.closest("button")?.textContent, e.clientX, e.clientY,
                                    e.target.getBoundingClientRect().top]), {once:true,capture:true});
                            }''')
                        command("Input.dispatchTouchEvent", {"type":"touchStart","touchPoints":[point]})
                        command("Input.dispatchTouchEvent", {"type":"touchEnd","touchPoints":[]})
                        try:
                            fixture.completed()
                        except AssertionError as exc:
                            info = evaluate('[visualViewport.scale,visualViewport.offsetTop,scrollY,innerWidth,innerHeight]')
                            raise AssertionError(f"{name} at {point}, currently {evaluate(hit_point)}, viewport {info}, input {evaluate('testTouches')}") from exc
                        wait_for('document.querySelector("#toolPermissions").classList.contains("hidden")')
                        replies = [e["result"]["outcome"] for e in fixture.events() if e.get("id") == 9000]
                        assert replies[-1] == {"outcome":"selected","optionId":option}
                    result = {"viewport":[390,844],"visible_before_reload":True,"visible_after_reload":True,
                              "native_choices":["read-once","deny"],"touch_hit_test_passed":True,
                              "refresh_preserved_focus":focus_preserved,"keyboard_tabs":navigation,
                              "connection_retry_opens_paired_chat":True,"resolved_cards_hidden":True}
                    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
                    print(json.dumps(result))
                    ws.send(json.dumps({"id":seq+1,"method":"Browser.close","params":{}}))
            finally:
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    tree = [psutil.Process(proc.pid)]
                    tree.extend(tree[0].children(recursive=True))
                    for child in reversed(tree):
                        try:
                            child.kill()
                        except psutil.NoSuchProcess:
                            pass
                    proc.wait(timeout=30)
    finally:
        fixture.tearDown()


if __name__ == "__main__":
    main()
