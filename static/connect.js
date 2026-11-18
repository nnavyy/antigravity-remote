/* Connect tab: access mode, pairing, safety switches. Talks to /api/connection and /api/settings. */
(function () {
  const $ = (id) => document.getElementById(id);
  let info = null;
  let loadNumber = 0;

  // Clean ?t= or ?pin= query parameter from address bar after cookie is set
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has("t") || u.searchParams.has("pin")) {
      u.searchParams.delete("t");
      u.searchParams.delete("pin");
      const clean = u.pathname + (u.search ? u.search : "") + u.hash;
      window.history.replaceState({}, document.title, clean);
    }
  } catch (_) {}

  async function api(url, opts) {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || body.error || body.message || r.statusText);
    return body;
  }

  function toast(msg) {
    const el = $("cxToast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 3200);
  }

  function modeLabel(mode) {
    return { lan: "This Wi-Fi only", tailscale: "Anywhere (Tailscale)", tunnel: "Public link" }[mode] || mode;
  }

  function render() {
    if (!info) return;
    const s = info.settings || {};
    const ts = info.tailscale || {};
    if ($("cxMode")) $("cxMode").textContent = modeLabel(s.remote_mode) || "";
    if ($("cxUrl")) {
      $("cxUrl").textContent = info.primary_url || "Address unavailable";
      $("cxUrl").disabled = !info.primary_url;
    }
    if ($("cxPin")) $("cxPin").textContent = info.pin || "-";
    if ($("cxPinRow")) $("cxPinRow").classList.toggle("hidden", !info.owner || !info.primary_url);
    if ($("cxQrSurface")) $("cxQrSurface").classList.toggle("hidden", !info.owner);
    if ($("cxHeading")) $("cxHeading").textContent = info.loadFailed ? "Connection unavailable" : info.owner ? "Connect your phone" : "You're connected";
    if ($("cxIntro")) $("cxIntro").textContent = info.loadFailed
      ? "Check that the bridge is running on your laptop, then try again."
      : !info.owner
      ? "Open Chat to continue working with Antigravity on your laptop."
      : !info.primary_url ? (info.unavailable_reason || "Refresh to get a phone address.")
      : s.remote_mode === "tailscale"
        ? "Connect your phone and laptop to the same Tailscale account, then scan this code."
        : s.remote_mode === "tunnel"
          ? "Scan this code with your phone camera to open your configured public link."
          : "Keep your phone and laptop on the same Wi-Fi, then scan this code with your phone camera.";

    document.querySelectorAll("input[name=cxAccess]").forEach((r) => {
      r.checked = r.value === s.remote_mode;
      r.disabled = !info.owner;
    });

    let tsMsg;
    if (!ts.installed) tsMsg = "Tailscale is not installed on this laptop. Install it from tailscale.com/download, sign in, then reload this page.";
    else if (!ts.ip) tsMsg = "Tailscale is installed but not signed in. Open the Tailscale app and sign in.";
    else tsMsg = "Tailscale is ready. Laptop address: " + ts.ip + ". Install Tailscale on your phone and sign in with the same account.";
    if ($("cxTsStatus")) {
      $("cxTsStatus").textContent = tsMsg;
      $("cxTsStatus").classList.toggle("hidden", s.remote_mode !== "tailscale");
    }

    if ($("cxLanPin")) {
      $("cxLanPin").checked = !!s.require_lan_pin;
      $("cxLanPin").disabled = !info.owner;
    }
    if ($("cxShell")) {
      $("cxShell").checked = !!info.shell_enabled;
      $("cxShell").disabled = !info.owner;
    }
    if ($("cxOwnerOnly")) $("cxOwnerOnly").classList.toggle("hidden", !!info.owner || !!info.loadFailed);
    if ($("cxRetry")) $("cxRetry").classList.toggle("hidden", !info.loadFailed);
    if ($("cxChat")) $("cxChat").classList.toggle("hidden", !!info.owner || !!info.loadFailed);
    if ($("cxQrNote")) $("cxQrNote").classList.toggle("hidden", !info.owner);
    document.querySelectorAll(".cx-owner-action").forEach((b) => (b.disabled = !info.owner));

    const qr = $("cxQr");
    if (qr && info.qr_data_url) {
      qr.src = info.qr_data_url;
      qr.classList.remove("hidden");
      if ($("cxQrLoading")) $("cxQrLoading").classList.add("hidden");
    } else if (qr) {
      qr.removeAttribute("src");
      qr.classList.add("hidden");
      if ($("cxQrLoading")) {
        $("cxQrLoading").textContent = info.primary_url ? "QR code unavailable. Use the phone address instead." : "QR code unavailable.";
        $("cxQrLoading").classList.remove("hidden");
      }
    }
  }

  async function load() {
    const current = ++loadNumber;
    try {
      const next = await api("/api/connection");
      if (current !== loadNumber) return;
      if (typeof next?.owner !== "boolean") throw new Error("The bridge did not return connection details.");
      info = next;
      render();
    } catch (e) {
      if (current !== loadNumber) return;
      info = {loadFailed:true};
      render();
      toast(e.message);
    }
  }

  async function save(change) {
    try {
      await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
      toast("Saved");
      await load();
    } catch (e) { toast(e.message); await load(); }
  }

  window.cxRefresh = load;
  window.cxSetMode = (v) => save({ remote_mode: v });
  window.cxToggleLanPin = (el) => save({ require_lan_pin: el.checked });
  window.cxToggleShell = (el) => {
    if (el.checked && !confirm("Allow running terminal commands on this laptop from a paired phone?")) { el.checked = false; return; }
    save({ allow_shell: el.checked });
  };
  window.cxUnpair = async () => {
    if (!confirm("Rotate the pairing code and sign out remote devices?")) return;
    try { const r = await api("/api/pairing/reset", { method: "POST" }); toast(r.message); await load(); } catch (e) { toast(e.message); }
  };
  window.cxCopy = async () => {
    if (!info?.primary_url) return;
    try {
      if (!navigator.clipboard) throw new Error("Select and copy the address manually on this HTTP connection.");
      await navigator.clipboard.writeText(info.primary_url);
      toast("Address copied");
    } catch (e) { toast(e.message || "Could not copy address"); }
  };

  window.addEventListener("DOMContentLoaded", () => {
    const btn = $("tabBtnConnect");
    if (btn) btn.addEventListener("click", load);
    load();
    if (location.hash === "#connect" && window.switchViewTab) window.switchViewTab("tab-connect");
  });
})();
