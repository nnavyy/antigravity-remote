/**
 * Antigravity Mobile Command Bridge — Client Logic
 * Strictly complies with clean-aesthetic-no-emoji, apple-design, and Anti-Badge Minimalism.
 */

// ─── State Management ──────────────────────────────────────────

const state = {
  ws: null,
  wsConnected: false,
  bridgeUnavailable: false,
  selectedSkills: new Set(),
  allSkills: [],
  currentPendingTask: null,
  toolPermissions: [],
  permissionFetchSeq: 0,
  permissionDecisions: new Set(),
  currentWorkspace: null,
  availableFolders: [],
  browseCurrentPath: "",
  browseRequestSeq: 0,
  conversationLoadSeq: 0,
  browseAbortController: null,
  activeConversationId: null,
  renderedConversationId: null,
  conversations: [],
  sessionToDelete: null,
  selectedModel: localStorage.getItem("antigravity_selected_model") || null,
  selectedModelTarget: localStorage.getItem("antigravity_selected_model_target") || null,
  selectedModelTier: null,
  availableModels: [],
  modelCatalogConnected: false,
  modelCatalogMessage: "Connecting to Antigravity...",
  modelCatalogLoading: false,
  modelCatalogKey: null,
  modelCatalogRequest: null,
  modelCatalogBoundTarget: null,
  selectedPerformance: localStorage.getItem("antigravity_performance") || "High",
  executionTarget: localStorage.getItem("antigravity_execution_target") || "auto",
  connectedTarget: null,
  eventCount: 0,
  pendingImages: [],
  taskQueue: [],
  soundEnabled: localStorage.getItem("antigravity_sound_enabled") !== "false",
  expandedHistory: {},
  changes: null,
  isSubmittingTask: false,
  pendingAgreementData: null,
  account: null,
  openConvoIds: [],
  splitView: false,
  secondaryConversationId: null,
  secondaryConversationData: null,
  activeTasks: {},
  isFlushingOfflineQueue: false,
};

// ─── Apple Physical Haptic Engine (FR-02) ─────────────────────────

function triggerHaptic(type = "light") {
  if (!navigator.vibrate) return;
  try {
    switch (type) {
      case "light":
        navigator.vibrate(10);
        break;
      case "medium":
        navigator.vibrate(22);
        break;
      case "heavy":
        navigator.vibrate(38);
        break;
      case "success":
        navigator.vibrate([15, 35, 25]);
        break;
      case "warning":
        navigator.vibrate([25, 45, 25]);
        break;
      case "error":
        navigator.vibrate([40, 50, 40]);
        break;
      default:
        navigator.vibrate(12);
    }
  } catch (e) {
    // Ignore if unsupported by device
  }
}

// ─── Offline State & Offline Task Queue (FR-04) ─────────────────

function saveToOfflineQueue(taskPayload) {
  try {
    taskPayload.request_id ||= createRequestId();
    const queue = JSON.parse(localStorage.getItem("antigravity_offline_queue") || "[]");
    queue.push({
      ...taskPayload,
      offline_id: taskPayload.offline_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      queued_at: new Date().toISOString()
    });
    localStorage.setItem("antigravity_offline_queue", JSON.stringify(queue));
    showToast(`Disconnected. Your message is saved offline (${queue.length} messages) and will send when you reconnect.`, "warning");
    triggerHaptic("warning");
    return true;
  } catch (err) {
    console.error("Could not save offline queue:", err);
    showToast("Could not save the offline queue. Your message remains in the input.", "error");
    return false;
  }
}

const offlineQueueKey = "antigravity_offline_queue";

function updateOfflineItem(id, patch) {
  const latest = JSON.parse(localStorage.getItem(offlineQueueKey) || "[]");
  const remaining = latest.flatMap(entry => entry.offline_id !== id ? [entry] : patch ? [{...entry,...patch}] : []);
  if (remaining.length) localStorage.setItem(offlineQueueKey, JSON.stringify(remaining));
  else localStorage.removeItem(offlineQueueKey);
}

function renderUnsentDrafts() {
  const panel = document.getElementById("unsentDrafts");
  if (!panel) return;
  let failed;
  try { failed = JSON.parse(localStorage.getItem(offlineQueueKey) || "[]").filter(item => item?.delivery_error); }
  catch { return; }
  panel.classList.toggle("hidden", !failed.length);
  const list = panel.querySelector("div");
  list.replaceChildren();
  for (const item of failed) {
    const reason = document.createElement("p");
    reason.textContent = item.delivery_error;
    const copy = document.createElement("textarea");
    copy.readOnly = true;
    copy.setAttribute("aria-label","Saved message to copy");
    copy.value = [item.prompt,...(item.images || [])].join("\n");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Dismiss saved copy";
    remove.onclick = () => {updateOfflineItem(item.offline_id,null);renderUnsentDrafts();};
    list.append(reason,copy,remove);
  }
}

async function flushOfflineQueue() {
  if (state.isFlushingOfflineQueue || navigator.onLine === false) return;
  state.isFlushingOfflineQueue = true;
  try {
    const queue = JSON.parse(localStorage.getItem(offlineQueueKey) || "[]");
    if (!queue.length) return;
    for (const item of queue) {
      item.offline_id ||= createRequestId();
      item.request_id ||= createRequestId();
    }
    localStorage.setItem(offlineQueueKey,JSON.stringify(queue));
    for (const item of queue) {
      if (item.delivery_error) continue;
      let res;
      if (!item.conversation_id) {
        res = await safeFetchJson("/api/conversations", {method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({offline_draft_id:item.request_id, title:item.prompt.slice(0,60),skills:item.skills,workspace_path:item.workspace_path})});
        if (res.ok && res.data?.id) {
          item.conversation_id = res.data.id;
          updateOfflineItem(item.offline_id,{conversation_id:item.conversation_id});
        }
      }
      if (item.conversation_id) {
        res = await safeFetchJson("/api/tasks/submit", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(item)});
      }
      if (!res?.ok || !item.conversation_id) {
        const message = res?.error || "The saved message could not be delivered.";
        const rejected = (res?.status >= 400 && res.status < 500 && ![401,403,408,429].includes(res.status)) ||
          res?.code === "delivery_uncertain" || res?.code === "delivery_not_started" || res?.status === 200;
        if (rejected) {
          updateOfflineItem(item.offline_id,{delivery_error:message});
          showToast("Review unsent drafts in Chat.","warning");
          continue;
        }
        showToast(message,"warning");
        break;
      }
      updateOfflineItem(item.offline_id,null);
      showToast("Offline message sent to the laptop.","success");
    }
  } catch (err) {
    showToast("The offline queue has not synced. Saved messages are retained.","error");
  } finally {
    state.isFlushingOfflineQueue = false;
    renderUnsentDrafts();
  }
}

function initOfflineQueue() {
  renderUnsentDrafts();
  window.addEventListener("online", () => {
    setOfflineState(false);
    flushOfflineQueue();
  });
  window.addEventListener("offline", () => {
    setOfflineState(true);
  });
}

function setOfflineState(isOffline) {
  state.bridgeUnavailable = isOffline;
  const banner = document.getElementById("offlineBanner");
  if (banner) {
    if (isOffline) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }
  updateConnectionUI(!isOffline);
}

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "apple-toast";
  toast.innerHTML = `
    <span class="toast-dot ${type}"></span>
    <span class="toast-msg">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-fadeout");
    setTimeout(() => toast.remove(), 260);
  }, 3500);
}

// ─── Safe Fetch Wrapper (No raw <!DOCTYPE unhandled crashes) ───

async function safeFetchJson(url, options = {}) {
  if (url !== "/api/tasks/submit" || typeof options.body !== "string") return fetchJsonResponse(url, options);
  let payload;
  try { payload = JSON.parse(options.body); } catch (_) { return fetchJsonResponse(url, options); }
  if (payload.request_id) return fetchJsonResponse(url, options);
  const key = `antigravity_delivery_${payload.conversation_id || 'new'}`;
  const fingerprint = JSON.stringify(payload);
  let id;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    id = saved?.fingerprint === fingerprint ? saved.id : createRequestId();
    localStorage.setItem(key, JSON.stringify({ id, fingerprint }));
  } catch (_) {
    return {ok:false,status:0,error:"Could not save the delivery receipt. Your message has not been sent."};
  }
  const result = await fetchJsonResponse(url, {...options, body:JSON.stringify({...payload,request_id:id})});
  if (result.ok || (result.status > 0 && result.code !== 'delivery_uncertain')) {
    try { if (JSON.parse(localStorage.getItem(key) || 'null')?.id === id) localStorage.removeItem(key); } catch (_) {}
  }
  return result;
}

function createRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16));
}

async function fetchJsonResponse(url, options = {}) {
  let removeAbortListeners;
  let signal;
  try {
    const timeout = AbortSignal.timeout(url.startsWith('/api/models') || url === '/api/tasks/submit' ? 90000 : 35000);
    signal = timeout;
    if (options.signal) {
      if (typeof AbortSignal.any === "function") {
        signal = AbortSignal.any([options.signal, timeout]);
      } else {
        const controller = new AbortController();
        const forwardAbort = event => controller.abort(event.target.reason);
        if (options.signal.aborted) controller.abort(options.signal.reason);
        else {
          options.signal.addEventListener("abort", forwardAbort, { once: true });
          timeout.addEventListener("abort", forwardAbort, { once: true });
          removeAbortListeners = () => {
            options.signal.removeEventListener("abort", forwardAbort);
            timeout.removeEventListener("abort", forwardAbort);
          };
        }
        signal = controller.signal;
      }
    }
    const res = await fetch(url, { ...options, signal });
    const contentType = res.headers.get("content-type") || "";

    if (!res.ok) {
      if ((res.status === 502 || res.status === 504) && !contentType.includes("application/json")) {
        setOfflineState(true);
        return {
          ok: false,
          status: res.status,
          error: "The laptop bridge is not responding (502). Make sure the laptop is awake and the bridge is running.",
        };
      }
      if (contentType.includes("application/json")) {
        const errData = await res.json();
        return {
          ok: false,
          status: res.status,
          error: errData.detail || errData.error || errData.message || `Error status ${res.status}`,
          code: errData.code,
        };
      }
      return {
        ok: false,
        status: res.status,
        error: `Server responded with status ${res.status}. Make sure the bridge is running.`,
      };
    }

    if (!contentType.includes("application/json")) {
      return {
        ok: false,
        status: res.status,
        error: "Server response is not valid JSON.",
      };
    }

    const data = await res.json();
    if (data.status === "error" || data.success === false) {
      return { ok: false, status: res.status, error: data.detail || data.error || data.message || "The operation failed.", data };
    }
    setOfflineState(false);
    return { ok: true, status: res.status, data };
  } catch (err) {
    // Response-body reads can throw AbortError even when the deadline caused it.
    if (err?.name === "TimeoutError" || (signal?.aborted && signal.reason?.name === "TimeoutError")) {
      return { ok: false, status: 0, error: "The request timed out. Please try again." };
    }
    if (err && err.name === "AbortError" && options.signal && options.signal.aborted) {
      return {
        ok: false,
        status: 0,
        aborted: true,
        error: "Request aborted.",
      };
    }
    setOfflineState(true);
    return {
      ok: false,
      status: 0,
      error: "Disconnected from the laptop. Make sure it is awake and the bridge is running.",
    };
  } finally {
    removeAbortListeners?.();
  }
}

// ─── Web Audio API Notification Synthesizers ───────────────────

let sharedAudioCtx = null;

function getAudioContext() {
  if (!sharedAudioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      sharedAudioCtx = new AudioContextClass();
    }
  }
  if (sharedAudioCtx && sharedAudioCtx.state === "suspended") {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

function playNotificationChime() {
  try {
    const isSoundActive = state.soundEnabled && localStorage.getItem("antigravity_sound_enabled") !== "false";
    if (!isSoundActive) return;

    // Prevent consecutive sound overlap
    const nowTimestamp = Date.now();
    if (state._lastChimeTime && (nowTimestamp - state._lastChimeTime < 400)) {
      return;
    }
    state._lastChimeTime = nowTimestamp;

    const audioCtx = getAudioContext() || new (window.AudioContext || window.webkitAudioContext)();
    if (!audioCtx) return;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sine";
    // First tone 587.33Hz (D5), then 880Hz (A5)
    osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.12);

    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);

    if (navigator.vibrate) {
      navigator.vibrate([40, 60, 40]);
    }
  } catch (e) {
    console.debug("playNotificationChime error:", e);
  }
}

function playIncomingSound() {
  playNotificationChime();
}

function playFinishSound() {
  playNotificationChime();
}

// ─── Native Notifications & Service Worker Integration ───────

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
    console.debug("ServiceWorker registration skipped:", err);
  });
}

function updateNotificationButtonUI() {
  const btn = document.getElementById("btnEnableNotifications");
  const label = document.getElementById("notifBtnLabel");
  if (!btn) return;

  const isSoundActive = state.soundEnabled && localStorage.getItem("antigravity_sound_enabled") !== "false";
  const hasBrowserPerm = ("Notification" in window) && Notification.permission === "granted";

  if (isSoundActive) {
    btn.className = "btn-sound-toggle active";
    if (label) {
      label.textContent = hasBrowserPerm ? "Sounds and notifications on" : "Sounds on";
    }
    btn.title = "Mute sounds and notifications.";
  } else {
    btn.className = "btn-sound-toggle muted";
    if (label) label.textContent = "Sounds off";
    btn.title = "Enable notification sounds.";
  }
}

function updateNotificationPermissionUI() {
  const banner = document.getElementById("notifPermissionBanner");
  const titleEl = document.getElementById("notifPermTitle");
  const descEl = document.getElementById("notifPermDesc");
  const btnEl = document.getElementById("btnRequestNotifPerm");
  if (!banner) return;

  const isInsecure = location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1";
  if (isInsecure) {
    banner.classList.remove("hidden");
    banner.classList.remove("denied");
    if (titleEl) titleEl.textContent = "Notifications need HTTPS";
    if (descEl) descEl.textContent = "Browser notifications require a secure HTTPS connection.";
    if (btnEl) btnEl.textContent = "Open HTTPS";
    return;
  }

  if (!("Notification" in window)) {
    banner.classList.add("hidden");
    return;
  }

  const perm = Notification.permission;
  if (perm === "granted") {
    banner.classList.add("hidden");
  } else if (perm === "denied") {
    banner.classList.remove("hidden");
    banner.classList.add("denied");
    if (titleEl) titleEl.textContent = "Notifications are blocked";
    if (descEl) descEl.textContent = "Allow notifications in this site's browser settings, then refresh.";
    if (btnEl) btnEl.textContent = "Guide";
  } else {
    // default
    banner.classList.remove("hidden");
    banner.classList.remove("denied");
    if (titleEl) titleEl.textContent = "Notifications are off";
    if (descEl) descEl.textContent = "Tap 'Allow' to show the browser notification permission prompt.";
    if (btnEl) btnEl.textContent = "Allow";
  }
}

async function requestPhoneNotificationPermission() {
  const isInsecure = location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1";
  if (isInsecure) {
    showToast("Notifications require HTTPS. Opening the configured secure link...", "warning");
    await switchToHttpsTunnel();
    return;
  }

  if (!("Notification" in window)) {
    showToast("This browser does not support system notifications.", "warning");
    return;
  }

  if (Notification.permission === "denied") {
    alert("Notifications are blocked. Open this site's browser settings, allow Notifications, then reload.");
    return;
  }

  try {
    const perm = await Notification.requestPermission();
    updateNotificationPermissionUI();
    updateNotificationButtonUI();
    if (perm === "granted") {
      showToast("Notifications enabled.", "success");
      playNotificationChime();
      showNativeNotification("[ANTIGRAVITY]", "Notifications are ready for task updates.");
    } else if (perm === "denied") {
      showToast("Notifications were denied. Change this site's permission in browser settings.", "warning");
    }
  } catch (err) {
    showToast("Could not request permission: " + err.message, "error");
  }
}

async function testSoundBoth() {
  getAudioContext();
  // 1. Play chime on phone speaker
  playNotificationChime();

  // 2. Request laptop speaker chime via server endpoint
  const laptop = await safeFetchJson("/api/sound/laptop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "finish" }),
  });

  // 3. Show a test notification if browser permission is granted
  if ("Notification" in window && Notification.permission === "granted") {
    showNativeNotification("[ANTIGRAVITY]", "Test: sounds and notifications are enabled.");
  } else if ("Notification" in window && Notification.permission === "default") {
    requestPhoneNotificationPermission();
  }

  const message = laptop.ok ? "Phone and laptop sound test requested." : "Phone sound test requested. Laptop sound is unavailable.";
  showToast(message,"info");
  addLogEvent(message);
}

async function handleNotificationButtonClick() {
  getAudioContext();

  const isCurrentlyActive = state.soundEnabled && localStorage.getItem("antigravity_sound_enabled") !== "false";

  if (isCurrentlyActive) {
    // Mute notifications (Toggle OFF)
    state.soundEnabled = false;
    try {
      localStorage.setItem("antigravity_sound_enabled", "false");
    } catch (e) {}

    updateNotificationButtonUI();
    showToast("Notifications muted (quiet mode active).", "info");
    addLogEvent("Notification sounds muted.");
  } else {
    // Enable notifications (Toggle ON)
    state.soundEnabled = true;
    try {
      localStorage.setItem("antigravity_sound_enabled", "true");
    } catch (e) {}

    updateNotificationButtonUI();
    playNotificationChime();

    // Also play confirmation sound on laptop
    safeFetchJson("/api/sound/laptop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "incoming" }),
    }).catch(() => {});

    // Request browser permission if not yet granted
    if ("Notification" in window && Notification.permission !== "granted") {
      await requestPhoneNotificationPermission();
    } else {
      showToast("Sounds enabled on both devices.", "success");
      addLogEvent("Browser notifications and sounds enabled.");
      showNativeNotification("[ANTIGRAVITY]", "Ready to receive task updates.");
    }
  }
}

async function showNativeNotification(title, body) {
  const isSoundActive = state.soundEnabled && localStorage.getItem("antigravity_sound_enabled") !== "false";
  if (!isSoundActive) return;

  // Play chime on phone
  playNotificationChime();

  // Play chime on laptop as well
  safeFetchJson("/api/sound/laptop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "finish" }),
  }).catch(() => {});

  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const notifOptions = {
    body: body,
    tag: "antigravity-bridge",
    renotify: true,
    icon: "/static/icon-192.png",
    badge: "/static/icon-192.png",
    vibrate: [80, 50, 80],
  };

  // 1. Try via ServiceWorker (required for Android Chrome)
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.showNotification) {
        await reg.showNotification(title, notifOptions);
        return;
      }
    } catch (err) {
      console.debug("ServiceWorker showNotification fallback:", err);
    }
  }

  // 2. Fallback for desktop browsers
  try {
    new Notification(title, notifOptions);
  } catch (err) {
    console.debug("new Notification failed:", err);
  }
}

// ─── Image Lightbox Fullscreen Preview (Apple Physical Design) ──
function openImageLightbox(src, title = "Image attachment") {
  if (!src) return;
  const modal = document.getElementById("imageLightboxModal");
  const imgEl = document.getElementById("lightboxImage");
  const titleEl = document.getElementById("lightboxTitle");
  const downloadBtn = document.getElementById("lightboxDownloadBtn");
  if (!modal || !imgEl) return;

  imgEl.src = src;
  if (titleEl) titleEl.textContent = title;
  if (downloadBtn) downloadBtn.href = src;

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeImageLightbox() {
  const modal = document.getElementById("imageLightboxModal");
  if (modal) {
    modal.classList.add("hidden");
  }
  document.body.style.overflow = "";
}

function handleLightboxBackdropClick(e) {
  if (e.target && (e.target.id === "imageLightboxModal" || e.target.classList.contains("lightbox-body"))) {
    closeImageLightbox();
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeImageLightbox();
  }
});

// ─── Insecure HTTP Detection & HTTPS Tunnel Switcher ────────────
async function checkInsecureHttpConnection() {
  const isInsecure = location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1";
  const banner = document.getElementById("insecureHttpBanner");
  if (banner) {
    banner.classList.toggle("hidden", !isInsecure);
  }
}

async function switchToHttpsTunnel() {
  try {
    const res = await safeFetchJson("/api/status");
    if (res.ok && res.data && res.data.access_url) {
      window.location.href = res.data.access_url;
    } else {
      showToast("No configured HTTPS link is available yet.", "info");
    }
  } catch (e) {
    showToast("Could not open HTTPS: " + e.message, "error");
  }
}

// ─── Active Background Task UI Management ──────────────────────

let activeTaskTimerInterval = null;

function renderActiveTaskUI(task) {
  state.activeTask = task || null;
  const banner = document.getElementById("activeTaskBanner");
  const promptEl = document.getElementById("activeTaskPrompt");
  const actionEl = document.getElementById("activeTaskActionText");
  const targetEl = document.getElementById("activeTaskTargetBadge");
  const timerEl = document.getElementById("activeTaskElapsed");

  const isBusy = !!(state.activeTask || state.isProcessing || (state.taskQueue && state.taskQueue.length > 0));

  // Update send button toggle (idle vs busy)
  const singleRow = document.getElementById("sendActionSingle");
  const busyRow = document.getElementById("sendActionBusy");
  if (singleRow && busyRow) {
    if (isBusy) {
      singleRow.classList.add("hidden");
      busyRow.classList.remove("hidden");
    } else {
      singleRow.classList.remove("hidden");
      busyRow.classList.add("hidden");
    }
  }

  if (!banner) return;

  if (!state.activeTask) {
    banner.classList.add("hidden");
    if (activeTaskTimerInterval) {
      clearInterval(activeTaskTimerInterval);
      activeTaskTimerInterval = null;
    }
    return;
  }

  banner.classList.remove("hidden");
  if (promptEl) promptEl.textContent = state.activeTask.prompt || "Processing your instructions...";
  if (actionEl) actionEl.textContent = state.activeTask.current_action || state.currentAction || "Evaluating the next step...";
  if (targetEl) {
    const tgt = (state.activeTask.execution_target || "ide").toUpperCase();
    targetEl.textContent = `${tgt} (${tgt === "CLI" ? "HEADLESS" : "GUI"})`;
  }

  // Live timer update
  if (!activeTaskTimerInterval) {
    function updateTimer() {
      if (!state.activeTask || !timerEl) return;
      const start = state.activeTask.started_timestamp ? state.activeTask.started_timestamp * 1000 : Date.now();
      const elapsedSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const m = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
      const s = String(elapsedSec % 60).padStart(2, "0");
      timerEl.textContent = `${m}:${s}`;
    }
    updateTimer();
    activeTaskTimerInterval = setInterval(updateTimer, 1000);
  }
}

async function stopActiveBackgroundProcess(fromModal = false) {
  try {
    showToast("Stopping the running task...", "info");
    const res = await safeFetchJson("/api/tasks/active/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: state.activeConversationId }),
    });
    if (res.ok) {
      showToast(res.data?.message || "Task stopped.", "success");
      addLogEvent("Task stopped from the phone.");
      state.activeTask = null;
      renderActiveTaskUI(null);
      updateProcessingStateUI(false, "");
      if (fromModal) {
        closeQueueChoiceSheet();
      }
    } else {
      showToast(res.error || "Could not stop the task.", "error");
    }
  } catch (e) {
    showToast("Could not stop the task.", "error");
  }
}

// ─── Task Queue UI Management ──────────────────────────────────

function renderQueueUI(queue) {
  state.taskQueue = queue || [];
  const banner = document.getElementById("queueBanner");
  const countEl = document.getElementById("queueCount");
  const container = document.getElementById("queueListContainer");

  // Update send button toggle (idle vs busy)
  const isBusy = !!(state.activeTask || state.isProcessing || state.taskQueue.length > 0);
  const singleRow = document.getElementById("sendActionSingle");
  const busyRow = document.getElementById("sendActionBusy");
  if (singleRow && busyRow) {
    if (isBusy) {
      singleRow.classList.add("hidden");
      busyRow.classList.remove("hidden");
    } else {
      singleRow.classList.remove("hidden");
      busyRow.classList.add("hidden");
    }
  }

  if (!banner || !container) return;

  if (state.taskQueue.length === 0) {
    banner.classList.add("hidden");
    container.innerHTML = "";
    if (countEl) countEl.textContent = "0";
    return;
  }

  banner.classList.remove("hidden");
  if (countEl) countEl.textContent = String(state.taskQueue.length);

  container.innerHTML = "";
  state.taskQueue.forEach((t, idx) => {
    const row = document.createElement("div");
    row.className = "queue-item-row";
    row.innerHTML = `
      <div class="queue-item-meta">
        <div class="queue-item-text">
          <span class="queue-item-index">#${idx + 1}</span>
          ${escapeHtml(t.prompt || 'Task')}
        </div>
        <div class="queue-item-sub">[Queued] · ${escapeHtml(t.created_at || '')} · ${escapeHtml(t.model || 'Session model')}</div>
      </div>
      <div class="queue-item-actions">
        <button class="btn-queue-dispatch" type="button" title="Send to Antigravity now" onclick="dispatchQueuedTask('${escapeQuotes(t.id)}')">Send now</button>
        <button class="btn-cancel-queue" type="button" title="Remove this message from the queue" onclick="cancelQueuedTask('${escapeQuotes(t.id)}')">Cancel</button>
      </div>
    `;
    container.appendChild(row);
  });
}

async function dispatchQueuedTask(taskId) {
  try {
    const res = await safeFetchJson(`/api/queue/${taskId}/dispatch`, { method: "POST" });
    if (res.ok) {
      showToast("Queued message sent to Antigravity.", "success");
      addLogEvent(`Queued task #${taskId} sent to laptop.`);
    } else {
      showToast(res.error || "Could not send the queued message.", "error");
    }
  } catch (e) {
    showToast("Could not send the queued message.", "error");
  }
}

async function cancelQueuedTask(taskId) {
  try {
    const res = await safeFetchJson(`/api/queue/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    if (!res.ok) {
      showToast(res.error || "Could not remove the queued message.", "error");
      return;
    }
    showToast("Queued message removed.", "info");
    addLogEvent(`Task #${taskId} removed from the queue.`);
  } catch (e) {
    showToast("Could not remove the queued message.", "error");
  }
}

async function clearTaskQueue() {
  try {
    const res = await safeFetchJson("/api/queue/clear", { method: "POST" });
    if (!res.ok) {
      showToast(res.error || "Could not clear the queue.", "error");
      return;
    }
    showToast("Task queue cleared.", "info");
    addLogEvent("Task queue cleared.");
  } catch (e) {
    showToast("Could not clear the queue.", "error");
  }
}

// ─── WebSocket Engine ──────────────────────────────────────────

function initWebSocket() {
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) {
    return;
  }
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      state.wsConnected = true;
      setOfflineState(false);
      addLogEvent("Connected to the laptop.");
      triggerHaptic("light");
      flushOfflineQueue();
    };

    state.ws.onclose = () => {
      state.wsConnected = false;
      if (navigator.onLine === false) setOfflineState(true);
      if (!state.wsReconnectTimer) {
        state.wsReconnectTimer = setTimeout(() => {
          state.wsReconnectTimer = null;
          initWebSocket();
        }, 3000);
      }
    };

    state.ws.onerror = () => {
      state.wsConnected = false;
      if (navigator.onLine === false) setOfflineState(true);
    };

    state.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleSocketMessage(data);
      } catch (e) {
        console.error("Could not parse WebSocket message:", e);
      }
    };
  } catch (err) {
    state.wsConnected = false;
    if (navigator.onLine === false) setOfflineState(true);
  }
}

function updateConnectionUI(isOnline) {
  const dot = document.getElementById("navConnectionIndicator");
  if (dot) {
    dot.classList.toggle("offline", !isOnline);
  }
}

function handleSocketMessage(msg) {
  switch (msg.type) {
    case "PERMISSIONS_CHANGED":
      fetchToolPermissions();
      break;

    case "INITIAL_STATE":
      if (Array.isArray(msg.permissions)) {
        state.permissionFetchSeq++;
        renderToolPermissions(msg.permissions);
      }
      if (msg.active_tasks) state.activeTasks = msg.active_tasks;
      if (msg.telemetry) updateTelemetryUI(msg.telemetry);
      if (msg.token_quota) updateTokenQuotaUI(msg.token_quota);
      if (msg.account) renderAccountUI(msg.account);
      if (msg.skills) renderSkillsCatalog(msg.skills);
      if (msg.active_task !== undefined) renderActiveTaskUI(msg.active_task);
      if (msg.conversations && Array.isArray(msg.conversations)) {
        state.conversations = msg.conversations;
        state.activeConversationId = msg.active_id;
        renderConversationsListModal();
        if (typeof initConvoTabs === "function") initConvoTabs();
      }
      if (msg.queue) renderQueueUI(msg.queue);
      if (msg.changes && (!changesWorkspacePath() || msg.changes.workspace === changesWorkspacePath())) {
        renderChangesUI(msg.changes);
      } else {
        fetchChanges();
      }
      if (msg.active_conversation) {
        renderActiveConversation(msg.active_conversation);
      } else {
        fetchConversations();
      }
      break;

    case "CHANGES_UPDATED":
      if (msg.changes) {
        if (!changesWorkspacePath() || msg.changes.workspace === changesWorkspacePath()) {
          renderChangesUI(msg.changes);
        }
      } else {
        fetchChanges();
      }
      break;

    case "PONG":
    case "TELEMETRY_UPDATED":
      if (msg.telemetry) updateTelemetryUI(msg.telemetry);
      if (msg.token_quota) updateTokenQuotaUI(msg.token_quota);
      if (msg.account) renderAccountUI(msg.account);
      if (msg.active_task !== undefined) renderActiveTaskUI(msg.active_task);
      if (msg.queue) renderQueueUI(msg.queue);
      break;

    case "ACCOUNT_UPDATED":
    case "ACCOUNT_CHANGED":
      if (msg.account) renderAccountUI(msg.account);
      if (msg.token_quota) updateTokenQuotaUI(msg.token_quota);
      if (msg.message) showToast(msg.message, "success");
      fetchTokenQuota();
      break;

    case "ACCOUNT_LOGGED_OUT":
      if (msg.account) renderAccountUI(msg.account);
      if (msg.token_quota) updateTokenQuotaUI(msg.token_quota);
      showToast(msg.message || "Signed out of Antigravity.", "info");
      fetchTokenQuota();
      break;

    case "LOGIN_FLOW_STARTED":
      if (msg.result) {
        if (msg.result.mode === "laptop") {
          showToast(msg.result.message || "Sign-in opened on the laptop.", "info");
        } else if (msg.result.auth_url) {
          window.open(msg.result.auth_url, "_blank");
          showToast("Opening Google sign-in page...", "info");
        }
      }
      break;

    case "WORKSPACE_CHANGED":
      if (msg.workspace) {
        updateWorkspaceUI(msg.workspace);
      }
      addLogEvent(`Active project changed to: ${msg.workspace ? msg.workspace.name : ''}`);
      fetchWorkspaces();
      break;

    case "USER_ANSWER_SUBMITTED":
      const agCard = document.getElementById("userAgreementCard");
      if (agCard) agCard.classList.add("hidden");
      const agInput = document.getElementById("userAgreementCustomInput");
      if (agInput) agInput.value = "";
      state.pendingAgreementData = null;
      if (msg.conversation && msg.conversation.id === state.activeConversationId) {
        renderActiveConversation(msg.conversation);
      }
      addLogEvent(msg.message || "Reply sent to Antigravity.");
      break;

    case "TASK_SENT_TO_IDE":
      const optB = document.querySelector('.msg-bubble[data-optimistic="true"]');
      if (optB) optB.remove();
      addLogEvent("Instruction sent directly to Antigravity.");
      if (msg.conversation_id) {
        state.activeTasks[msg.conversation_id] = msg.active_task || { prompt: msg.prompt, status: "running" };
      }
      if (msg.active_tasks) state.activeTasks = msg.active_tasks;
      if (typeof renderConvoTabs === "function") renderConvoTabs();
      if (msg.active_task !== undefined) renderActiveTaskUI(msg.active_task);
      if (msg.conversation) {
        if (msg.conversation.id === state.activeConversationId) {
          renderActiveConversation(msg.conversation);
        } else if (state.splitView && msg.conversation.id === state.secondaryConversationId) {
          state.secondaryConversationData = msg.conversation;
          if (typeof renderSecondaryConversationTimeline === "function") {
            renderSecondaryConversationTimeline(msg.conversation.messages || []);
          }
        }
      } else if (msg.new_message) {
        appendSingleMessageToTimeline(msg.new_message);
      }
      if (state.splitView && state.secondaryConversationId && typeof updateSecondaryActiveTaskUI === "function") {
        updateSecondaryActiveTaskUI(state.secondaryConversationId);
      }
      if (msg.queue) renderQueueUI(msg.queue);
      break;

    case "TASK_DISPATCH_FAILED":
      if (msg.conversation_id) delete state.activeTasks[msg.conversation_id];
      if (msg.conversation_id === state.activeConversationId) {
        updateProcessingStateUI(false);
        document.querySelectorAll('.msg-bubble[data-optimistic="true"]').forEach(el => el.remove());
      }
      renderConvoTabs();
      break;

    case "TASK_QUEUED":
      const optQ = document.querySelector('.msg-bubble[data-optimistic="true"]');
      if (optQ) optQ.remove();
      showToast(msg.message || "Message added to the queue.", "info");
      addLogEvent(`Message queued (#${msg.queue_count || 1}).`);
      if (msg.active_task !== undefined) renderActiveTaskUI(msg.active_task);
      if (msg.queue) renderQueueUI(msg.queue);
      if (msg.conversation) {
        renderActiveConversation(msg.conversation);
      } else if (msg.new_message) {
        appendSingleMessageToTimeline(msg.new_message);
      }
      break;

    case "QUEUE_UPDATED":
      if (msg.active_task !== undefined) renderActiveTaskUI(msg.active_task);
      renderQueueUI(msg.queue || []);
      break;

    case "QUEUE_DISPATCHED":
      showToast(msg.message || "A queued task has started on the laptop.", "info");
      addLogEvent("Queued message sent to Antigravity.");
      if (msg.active_task !== undefined) renderActiveTaskUI(msg.active_task);
      if (msg.queue) renderQueueUI(msg.queue);
      break;

    case "TASK_FINISHED":
      if (msg.conversation_id && state.activeTasks) {
        delete state.activeTasks[msg.conversation_id];
      }
      if (msg.active_tasks) state.activeTasks = msg.active_tasks;
      if (typeof renderConvoTabs === "function") renderConvoTabs();
      if (!msg.conversation_id || msg.conversation_id === state.activeConversationId) {
        renderActiveTaskUI(null);
        updateProcessingStateUI(false);
      }
      if (state.splitView && state.secondaryConversationId === msg.conversation_id) {
        if (typeof updateSecondaryActiveTaskUI === "function") {
          updateSecondaryActiveTaskUI(state.secondaryConversationId);
        }
        if (typeof loadSecondaryConversation === "function") {
          loadSecondaryConversation(state.secondaryConversationId);
        }
      }
      fetchTokenQuota();
      fetchChanges();
      showNativeNotification(
        "[ANTIGRAVITY] Task complete",
        msg.message || "Antigravity has finished responding."
      );
      addLogEvent("Antigravity has finished the instruction.");
      break;

    case "TASK_STOPPED":
      renderActiveTaskUI(null);
      updateProcessingStateUI(false, "");
      if (msg.queue) renderQueueUI(msg.queue);
      showToast(msg.message || "Background task stopped.", "info");
      addLogEvent("Task stopped from the phone.");
      break;

    case "CONVERSATION_UPDATED":
      if (msg.active_tasks) {
        state.activeTasks = msg.active_tasks;
        if (typeof renderConvoTabs === "function") renderConvoTabs();
      }
      if (msg.active_task !== undefined) renderActiveTaskUI(msg.active_task);
      if (msg.queue) renderQueueUI(msg.queue);
      if (msg.conversation) {
        if (msg.conversation.id === state.activeConversationId) {
          renderActiveConversation(msg.conversation);
          if (msg.latest_message && msg.latest_message.sender === "antigravity") {
            const replyText = msg.latest_message.text || "New response received.";
            showNativeNotification(
              "[ANTIGRAVITY] Autonomous Agent",
              replyText.slice(0, 90)
            );
            addLogEvent("Antigravity replied.");
          }
        } else if (state.splitView && msg.conversation.id === state.secondaryConversationId) {
          state.secondaryConversationData = msg.conversation;
          if (typeof renderSecondaryConversationTimeline === "function") {
            renderSecondaryConversationTimeline(msg.conversation.messages || []);
          }
          if (typeof updateSecondaryActiveTaskUI === "function") {
            updateSecondaryActiveTaskUI(state.secondaryConversationId);
          }
        }
      }
      break;

    case "CONVERSATION_SELECTED":
      if (msg.conversation_id === state.activeConversationId && msg.conversation) {
        renderActiveConversation(msg.conversation);
      }
      break;

    case "TASK_ANALYZING":
      if (msg.new_message) {
        appendSingleMessageToTimeline(msg.new_message);
      } else if (msg.prompt) {
        addOptimisticUserMessage(msg.prompt, msg.images || []);
      }
      addLogEvent("Analyzing the task on your laptop...");
      break;

    case "APPROVAL_REQUIRED":
      renderPendingTask(msg.task);
      showNativeNotification(
        "[ANTIGRAVITY] Approval required",
        `Task #${msg.task.task_id} needs your approval.`
      );
      addLogEvent(`Task #${msg.task.task_id} needs approval.`);
      if (msg.conversation) {
        renderActiveConversation(msg.conversation);
      }
      break;

    case "TASK_APPROVED":
      hidePendingTask();
      const optBubble = document.querySelector('.msg-bubble[data-optimistic="true"]');
      if (optBubble) optBubble.remove();

      const notifBody = (msg.new_message && msg.new_message.text) ? msg.new_message.text.slice(0, 90) : (msg.message || `Task #${msg.task_id} completed on the laptop.`);
      showNativeNotification(
        "[ANTIGRAVITY] Autonomous AI Agent",
        notifBody
      );
      addLogEvent(`Task #${msg.task_id} synced to Antigravity.`);
      if (msg.conversation) {
        renderActiveConversation(msg.conversation);
      } else if (msg.new_message) {
        appendSingleMessageToTimeline(msg.new_message);
      }
      break;

    case "TASK_REJECTED":
      hidePendingTask();
      addLogEvent(`Task #${msg.task_id} rejected.`);
      break;

    case "CONVERSATION_CREATED":
      if (msg.conversation && msg.conversation.id) {
        state.activeConversationId = msg.conversation.id;
        state.renderedConversationId = null;
        renderActiveConversation(msg.conversation);
      }
      if (msg.conversations) {
        state.conversations = msg.conversations;
        renderConversationsListModal();
      } else {
        fetchConversations();
      }
      updateActiveConvHeaderMeta();
      if (typeof initConvoTabs === "function") initConvoTabs();
      break;

    case "CONVERSATION_DELETED":
      if (msg.conversations) state.conversations = msg.conversations;
      if (msg.active_id) {
        state.activeConversationId = msg.active_id;
        state.renderedConversationId = null;
        loadConversation(msg.active_id);
      }
      renderConversationsListModal();
      updateActiveConvHeaderMeta();
      if (typeof initConvoTabs === "function") initConvoTabs();
      break;

    case "CONVERSATIONS_LIST_UPDATED":
      if (msg.active_tasks) state.activeTasks = msg.active_tasks;
      if (msg.conversations && Array.isArray(msg.conversations)) {
        state.conversations = msg.conversations;
        if (msg.active_id && (!state.activeConversationId || !state.conversations.some(c => c.id === state.activeConversationId))) {
          state.activeConversationId = msg.active_id;
          state.renderedConversationId = null;
          loadConversation(msg.active_id);
        }
        renderConversationsListModal();
        updateActiveConvHeaderMeta();
        if (typeof initConvoTabs === "function") initConvoTabs();
      }
      break;

    case "ACTIVE_SESSION_CHANGED":
      if (msg.conversations && Array.isArray(msg.conversations)) {
        state.conversations = msg.conversations;
      }
      if (msg.active_id) {
        state.activeConversationId = msg.active_id;
        state.renderedConversationId = null;
        loadConversation(msg.active_id);
        addLogEvent(`Active conversation changed to: ${msg.active_id.slice(0, 8)}`);
      }
      renderConversationsListModal();
      updateActiveConvHeaderMeta();
      if (typeof initConvoTabs === "function") initConvoTabs();
      break;

    case "COMMAND_RESULT":
      renderCommandResult(msg.result, msg.command || "");
      break;

    case "NOTIFICATION":
      addLogEvent(msg.message);
      break;

    default:
      break;
  }
}

// Helper to update active conversation metadata in the header
function updateActiveConvHeaderMeta() {
  if (!state.activeConversationId || !state.conversations) return;
  const target = state.conversations.find(c => c.id === state.activeConversationId);
  if (target) {
    const titleEl = document.getElementById("activeConvTitle");
    const timeEl = document.getElementById("activeConvTime");
    const countEl = document.getElementById("activeConvCount");
    renderChatWorkspace(target);
    if (titleEl) {
      titleEl.textContent = target.title || "Antigravity conversation";
    }
    if (timeEl) timeEl.textContent = target.updated_at || target.created_at || "New conversation";
    if (countEl) countEl.textContent = `· ${target.message_count} messages`;

  }
}

// ─── Conversation Management (Antigravity conversation) ────────────────

async function fetchConversations(forceRefresh = true) {
  const url = forceRefresh ? "/api/conversations?force_refresh=true" : "/api/conversations";
  const res = await safeFetchJson(url);
  if (!res.ok) {
    console.error("Could not fetch conversations:", res.error);
    return;
  }
  state.conversations = res.data.conversations || [];
  
  // Keep activeConversationId if the ID is still valid in the list
  const currentActiveExists = state.conversations.some(c => c.id === state.activeConversationId);
  if (!currentActiveExists) {
    state.activeConversationId = res.data.active_id || (state.conversations[0] ? state.conversations[0].id : null);
  }

  // If the conversation list modal is open, refresh it immediately
  renderConversationsListModal();
  updateActiveConvHeaderMeta();
  initConvoTabs();

  if (state.activeConversationId && state.activeConversationId !== state.renderedConversationId) {
    loadConversation(state.activeConversationId);
  }
}

async function refreshActiveConversation() {
  const convId = state.activeConversationId;
  if (!convId) return;
  const seq = ++state.conversationLoadSeq;
  const res = await safeFetchJson(`/api/conversations/${convId}`);
  if (seq === state.conversationLoadSeq && convId === state.activeConversationId && res.ok && res.data) {
    renderActiveConversation(res.data);
  }
}

async function loadConversation(convId) {
  if (!convId) return;
  const seq = ++state.conversationLoadSeq;
  state.activeConversationId = convId;
  fetchModels();
  ensureConvoTabOpen(convId);

  const res = await safeFetchJson(`/api/conversations/${convId}`);
  if (seq === state.conversationLoadSeq && convId === state.activeConversationId && res.ok && res.data) {
    renderActiveConversation(res.data);
  }
}

// ─── Multi-Conversation Tabs & Split-View Controller ──────────

function getOpenTabsFromStorage() {
  try {
    const raw = localStorage.getItem("antigravity_open_tabs");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveOpenTabsToStorage() {
  try {
    localStorage.setItem("antigravity_open_tabs", JSON.stringify(state.openConvoIds || []));
  } catch (e) {}
}

function ensureConvoTabOpen(convId) {
  if (!convId) return;
  if (!state.openConvoIds) state.openConvoIds = [];
  if (!state.openConvoIds.includes(convId)) {
    state.openConvoIds.push(convId);
    if (state.openConvoIds.length > 8) {
      state.openConvoIds = state.openConvoIds.slice(-8);
    }
    saveOpenTabsToStorage();
  }
  renderConvoTabs();
}

function initConvoTabs() {
  const savedTabs = getOpenTabsFromStorage();
  state.openConvoIds = savedTabs.length > 0 ? savedTabs : (state.openConvoIds || []);

  // Filter out invalid IDs if conversation list is already loaded
  if (state.conversations && state.conversations.length > 0) {
    const validIds = new Set(state.conversations.map(c => c.id));
    state.openConvoIds = state.openConvoIds.filter(id => validIds.has(id));
  }

  // Ensure activeConversationId is always present in openConvoIds
  if (state.activeConversationId && !state.openConvoIds.includes(state.activeConversationId)) {
    state.openConvoIds.push(state.activeConversationId);
  }

  // If openConvoIds is still empty and conversations exist, open the first one
  if (state.openConvoIds.length === 0 && state.conversations && state.conversations.length > 0) {
    state.openConvoIds.push(state.conversations[0].id);
    if (!state.activeConversationId) {
      state.activeConversationId = state.conversations[0].id;
    }
  }

  // Keep at most 8 tabs so the bar stays tidy
  if (state.openConvoIds.length > 8) {
    state.openConvoIds = state.openConvoIds.slice(-8);
  }

  saveOpenTabsToStorage();
  renderConvoTabs();

  if (state.splitView) {
    populateSecondaryPicker();
    if (!state.secondaryConversationId || state.secondaryConversationId === state.activeConversationId) {
      const candidate = state.openConvoIds.find(id => id !== state.activeConversationId) ||
                        (state.conversations.find(c => c.id !== state.activeConversationId)?.id);
      if (candidate) {
        state.secondaryConversationId = candidate;
        loadSecondaryConversation(candidate);
      }
    }
  }
}

function renderConvoTabs() {
  const container = document.getElementById("convoTabsList");
  if (!container) return;

  if (!state.openConvoIds || state.openConvoIds.length === 0) {
    if (state.activeConversationId) state.openConvoIds = [state.activeConversationId];
    else return;
  }

  container.closest(".multi-convo-tabs-bar")?.classList.toggle("single-session", state.openConvoIds.length <= 1);
  container.innerHTML = state.openConvoIds.map((cid) => {
    const conv = (state.conversations || []).find(c => c.id === cid);
    const rawTitle = conv?.title || (cid ? `Conversation ${cid.slice(0, 8)}` : "Antigravity conversation");
    const displayTitle = rawTitle.length > 36 ? rawTitle.slice(0, 34) + "…" : rawTitle;
    const isActive = cid === state.activeConversationId;
    const isRunning = !!(state.activeTasks && state.activeTasks[cid]);

    return `
      <div class="convo-tab ${isActive ? 'active' : ''} ${isRunning ? 'is-running' : ''}">
        <button type="button" class="convo-tab-select" onclick="switchConvoTab('${escapeQuotes(cid)}')" title="${escapeQuotes(rawTitle)}" aria-pressed="${isActive}">
          <span class="convo-tab-dot ${isRunning ? 'is-running' : ''}"></span>
          <span class="convo-tab-title">${escapeHtml(displayTitle)}</span>
        </button>
        <button type="button" class="convo-tab-close" title="Close tab" onclick="closeConversationTab(event, '${escapeQuotes(cid)}')">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `;
  }).join("");

  setTimeout(() => {
    const activeEl = container.querySelector(".convo-tab.active");
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, 40);
}

function quickCreateNewConvoTab() { openNewSessionModal(); }

function closeConversationTab(event, convId) {
  if (event) event.stopPropagation();

  // Keep at least 1 tab open
  if (state.openConvoIds.length <= 1) {
    showToast("Keep at least one conversation tab open.", "info");
    return;
  }

  const idx = state.openConvoIds.indexOf(convId);
  if (idx !== -1) {
    state.openConvoIds.splice(idx, 1);
  }
  saveOpenTabsToStorage();

  // If the closed tab is activeConversationId, switch to a neighbor tab
  if (state.activeConversationId === convId) {
    const nextId = state.openConvoIds[Math.max(0, idx - 1)] || state.openConvoIds[0];
    if (nextId) {
      state.activeConversationId = nextId;
      state.renderedConversationId = null;
      loadConversation(nextId);
      safeFetchJson("/api/conversations/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: nextId }),
      });
    }
  }

  // If the closed tab is secondaryConversationId, switch to another session
  if (state.secondaryConversationId === convId) {
    const otherCandidate = state.openConvoIds.find(id => id !== state.activeConversationId);
    if (otherCandidate) {
      switchSecondaryConversation(otherCandidate);
    } else {
      toggleConvoSplitView(false);
    }
  }

  renderConvoTabs();
}

function switchConvoTab(convId) {
  if (!convId || convId === state.activeConversationId) return;
  state.activeConversationId = convId;
  state.renderedConversationId = null;
  ensureConvoTabOpen(convId);
  loadConversation(convId);
  safeFetchJson("/api/conversations/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: convId }),
  });
}

// ─── Dual-View (Split Conversation) Controller ─────────────────

function toggleConvoSplitView(forceState) {
  state.splitView = (typeof forceState === "boolean") ? forceState : !state.splitView;

  const grid = document.getElementById("convoSplitGrid");
  const secondaryPanel = document.getElementById("secondaryConvoPanel");
  const btnToggle = document.getElementById("btnToggleSplitView");
  const btnText = document.getElementById("splitViewBtnText");
  const mobileSwitcher = document.getElementById("mobileSplitSwitcher");

  if (!grid || !secondaryPanel) return;

  if (state.splitView) {
    grid.classList.remove("single-mode");
    grid.classList.add("split-mode", "pane-1-active");
    grid.classList.remove("pane-2-active");
    secondaryPanel.classList.remove("hidden");
    if (mobileSwitcher) mobileSwitcher.classList.remove("hidden");
    const btn1 = document.getElementById("btnSplitPane1");
    const btn2 = document.getElementById("btnSplitPane2");
    if (btn1) btn1.classList.add("active");
    if (btn2) btn2.classList.remove("active");
    if (btnToggle) btnToggle.classList.add("active");
    if (btnText) btnText.textContent = "Close split";

    // Choose a second conversation different from the primary one
    if (!state.secondaryConversationId || state.secondaryConversationId === state.activeConversationId) {
      const alt = state.openConvoIds.find(id => id !== state.activeConversationId) ||
                  (state.conversations.find(c => c.id !== state.activeConversationId)?.id);
      if (alt) {
        state.secondaryConversationId = alt;
      }
    }

    populateSecondaryPicker();
    if (state.secondaryConversationId) {
      loadSecondaryConversation(state.secondaryConversationId);
    }
    showToast("Split view enabled — Two conversations can run concurrently", "info");
    addLogEvent("Split view enabled.");
  } else {
    grid.classList.add("single-mode");
    grid.classList.remove("split-mode", "pane-1-active", "pane-2-active");
    secondaryPanel.classList.add("hidden");
    if (mobileSwitcher) mobileSwitcher.classList.add("hidden");
    if (btnToggle) btnToggle.classList.remove("active");
    if (btnText) btnText.textContent = "Split view";
  }
}

function populateSecondaryPicker() {
  const select = document.getElementById("secondaryConvoSelect");
  if (!select) return;

  const options = (state.conversations || []).map(c => {
    const isCur = c.id === state.secondaryConversationId;
    const isPrimary = c.id === state.activeConversationId;
    const rawTitle = c.title || `Conversation ${c.id.slice(0, 8)}`;
    const label = `${isPrimary ? '[Pane 1] ' : ''}${rawTitle} (${c.message_count || 0} msg)`;
    return `<option value="${escapeQuotes(c.id)}" ${isCur ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join("");

  select.innerHTML = options || `<option value="">No other conversations</option>`;
}

function switchSecondaryConversation(convId) {
  if (!convId) return;
  state.secondaryConversationId = convId;
  if (!state.openConvoIds.includes(convId)) {
    state.openConvoIds.push(convId);
    renderConvoTabs();
  }
  loadSecondaryConversation(convId);
}

async function loadSecondaryConversation(convId) {
  if (!convId) return;
  const titleEl = document.getElementById("secondaryConvTitle");
  const targetConv = (state.conversations || []).find(c => c.id === convId);
  if (titleEl) {
    titleEl.textContent = targetConv?.title || `Conversation ${convId.slice(0, 8)}`;
  }

  const res = await safeFetchJson(`/api/conversations/${convId}`);
  if (res.ok && res.data) {
    state.secondaryConversationData = res.data;
    renderSecondaryConversationTimeline(res.data.messages || []);
    updateSecondaryActiveTaskUI(convId);
  }
}

function renderSecondaryConversationTimeline(messages) {
  const timeline = document.getElementById("secondaryConversationTimeline");
  if (!timeline) return;

  if (!messages || messages.length === 0) {
    timeline.innerHTML = `
      <div style="padding: 24px 16px; text-align: center; color: var(--text-muted); font-size: 12px;">
        No messages in the second conversation. Write a message below to work in parallel.
      </div>
    `;
    return;
  }

  timeline.innerHTML = "";
  messages.forEach(msg => {
    const bubble = createMessageBubble(msg, false);
    timeline.appendChild(bubble);
  });
  timeline.scrollTop = timeline.scrollHeight;
}

function updateSecondaryActiveTaskUI(convId) {
  const banner = document.getElementById("secondaryActiveTaskBanner");
  const promptEl = document.getElementById("secondaryTaskPrompt");
  const actionEl = document.getElementById("secondaryTaskAction");
  if (!banner) return;

  const activeT = state.activeTasks ? state.activeTasks[convId] : null;
  if (activeT) {
    banner.classList.remove("hidden");
    if (promptEl) promptEl.textContent = activeT.prompt || "Processing your instructions...";
    if (actionEl) actionEl.textContent = activeT.current_action || "Evaluating the next step...";
  } else {
    banner.classList.add("hidden");
  }
}

async function submitSecondaryTask() {
  const input = document.getElementById("secondaryTaskInput");
  const text = input ? input.value.trim() : "";
  if (!text) {
    showToast("Enter a message for the second conversation first.", "info");
    return;
  }

  const targetCid = state.secondaryConversationId;
  if (!targetCid) {
    showToast("Choose a second conversation.", "error");
    return;
  }

  const btn = document.getElementById("btnSubmitSecondaryTask");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending...";
  }

  try {
    showToast("Sending to the second conversation...", "info");
    const res = await safeFetchJson("/api/tasks/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        conversation_id: targetCid,
        // This pane has no model picker: retain this conversation's native model.
        model: null,
        performance: "Default",
        execution_target: "auto",
        auto_open_ide: true,
        auto_execute: true,
        queue_mode: "auto",
      }),
    });

    if (res.ok) {
      if (input) input.value = "";
      showToast("Message sent to the second conversation.", "success");
      addLogEvent(`Second conversation (${targetCid.slice(0, 8)}) started concurrently.`);
      if (res.data && res.data.active_task) {
        state.activeTasks[targetCid] = res.data.active_task;
        renderConvoTabs();
        updateSecondaryActiveTaskUI(targetCid);
      }
      setTimeout(() => loadSecondaryConversation(targetCid), 800);
    } else {
      showToast(res.error || "Could not send to the second conversation.", "error");
    }
  } catch (err) {
    showToast(`Could not send the message: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
        <span>Send to second conversation</span>
      `;
    }
  }
}

// ─── Mobile Split-Pane Switcher (Adaptive Dual-View) ───────────

function setMobileSplitPane(paneNum) {
  triggerHaptic("light");
  const grid = document.getElementById("convoSplitGrid");
  const btn1 = document.getElementById("btnSplitPane1");
  const btn2 = document.getElementById("btnSplitPane2");
  if (!grid) return;

  if (paneNum === 1) {
    grid.classList.add("pane-1-active");
    grid.classList.remove("pane-2-active");
    if (btn1) btn1.classList.add("active");
    if (btn2) btn2.classList.remove("active");
  } else {
    grid.classList.remove("pane-1-active");
    grid.classList.add("pane-2-active");
    if (btn1) btn1.classList.remove("active");
    if (btn2) btn2.classList.add("active");
  }
}

// ─── Quick Command Chips & Dual-Way Clipboard (FR-03 & FR-08) ───

function handleQuickCommand(cmd) {
  triggerHaptic("light");
  const taskInput = document.getElementById("taskInput");
  if (!taskInput) return;
  taskInput.value = cmd;
  taskInput.focus();
  showToast(`${cmd} selected. Tap Send message to run it.`, "info");
}

async function handleQuickClipboardPaste() {
  triggerHaptic("light");
  const taskInput = document.getElementById("taskInput");
  if (!taskInput) return;

  try {
    const res = await safeFetchJson("/api/clipboard");
    if (!res.ok) {
      showToast("Could not read the laptop clipboard: " + (res.error || "Server not responding"), "error");
      return;
    }
    const text = (res.data && res.data.text) ? res.data.text : (res.text || "");
    if (!text || !text.trim()) {
      showToast("The laptop clipboard is empty.", "warning");
      return;
    }

    if (taskInput.value.trim()) {
      taskInput.value += "\n" + text;
    } else {
      taskInput.value = text;
    }
    taskInput.focus();
    triggerHaptic("success");
    showToast("Pasted from the laptop clipboard.", "success");
  } catch (err) {
    showToast("Could not read the laptop clipboard.", "error");
  }
}

async function handleQuickClipboardCopy() {
  triggerHaptic("light");
  const taskInput = document.getElementById("taskInput");
  if (!taskInput) return;
  const text = taskInput.value.trim();
  if (!text) {
    showToast("Message input is empty.", "warning");
    return;
  }

  try {
    const res = await safeFetchJson("/api/clipboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      showToast("Could not copy text to the laptop: " + (res.error || "Server not responding"), "error");
      return;
    }
    triggerHaptic("success");
    showToast("Copied to the laptop clipboard.", "success");
  } catch (err) {
    showToast("Could not copy to the laptop clipboard.", "error");
  }
}

// ─── Web Speech API Voice Dictation (FR-01) ──────────────────────

let speechRecognitionInstance = null;
let isDictating = false;

function toggleVoiceDictation() {
  triggerHaptic("medium");
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast("Speech recognition is unavailable in this browser.", "warning");
    return;
  }

  const btn = document.getElementById("btnVoiceDictation");
  const pulse = document.getElementById("voiceDictationPulse");
  const statusContainer = document.getElementById("voiceDictationStatus");
  const statusText = document.getElementById("voiceStatusText");
  const taskInput = document.getElementById("taskInput");

  if (isDictating && speechRecognitionInstance) {
    speechRecognitionInstance.stop();
    return;
  }

  try {
    const recognition = new SpeechRecognition();
    recognition.lang = getDictationLanguage();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let baseText = taskInput ? taskInput.value : "";
    if (baseText && !baseText.endsWith(" ")) {
      baseText += " ";
    }

    recognition.onstart = () => {
      isDictating = true;
      if (btn) { btn.classList.add("listening"); btn.setAttribute("aria-pressed", "true"); }
      if (pulse) pulse.classList.remove("hidden");
      if (statusContainer) statusContainer.classList.remove("hidden");
      if (statusText) statusText.textContent = `Listening (${recognition.lang})...`;
      triggerHaptic("light");
    };

    recognition.onresult = (event) => {
      let interimTranscript = "";
      let finalTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      if (taskInput) {
        taskInput.value = baseText + finalTranscript + interimTranscript;
        taskInput.scrollTop = taskInput.scrollHeight;
      }
      if (finalTranscript) {
        baseText += finalTranscript + " ";
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed") {
        showToast("Microphone access was denied. Allow it in this site's browser settings.", "error");
      } else if (event.error !== "no-speech") {
        showToast("Dictation: " + event.error, "warning");
      }
      stopDictationUI();
    };

    recognition.onend = () => {
      stopDictationUI();
    };

    speechRecognitionInstance = recognition;
    recognition.start();
  } catch (err) {
    console.error("Speech recognition error:", err);
    showToast("Could not start dictation.", "error");
    stopDictationUI();
  }

  function stopDictationUI() {
    isDictating = false;
    speechRecognitionInstance = null;
    if (btn) { btn.classList.remove("listening"); btn.setAttribute("aria-pressed", "false"); }
    if (pulse) pulse.classList.add("hidden");
    if (statusContainer) statusContainer.classList.add("hidden");
  }
}

function getDictationLanguage() {
  const override = localStorage.getItem("antigravity_dictation_language");
  const language = override || navigator.languages?.[0] || navigator.language || "en-US";
  try { return Intl.getCanonicalLocales(language)[0] || "en-US"; } catch { return "en-US"; }
}

function setDictationLanguage(value) {
  try {
    const language = value.trim() ? Intl.getCanonicalLocales(value.trim())[0] : "";
    if (language) localStorage.setItem("antigravity_dictation_language", language);
    else localStorage.removeItem("antigravity_dictation_language");
  } catch { showToast("Enter a language code such as en-US, id-ID, or ja-JP.", "error"); }
}

// ─── Physical Pull-to-Refresh (Apple Physical Design) ──────────

function initPullToRefresh() {
  const timeline = document.getElementById("conversationTimeline");
  const indicator = document.getElementById("ptrIndicator");
  const ptrText = document.getElementById("ptrText");
  if (!timeline || !indicator) return;

  let startY = 0;
  let isPTR = false;
  let isRefreshing = false;
  const PTR_THRESHOLD = 64;

  timeline.addEventListener("touchstart", (e) => {
    if (timeline.scrollTop > 5 || isRefreshing) return;
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    isPTR = true;
  }, { passive: true });

  timeline.addEventListener("touchmove", (e) => {
    if (!isPTR || isRefreshing) return;
    const currentY = e.touches[0].clientY;
    const pullDistance = currentY - startY;

    if (pullDistance > 0 && timeline.scrollTop <= 2) {
      const damped = Math.min(pullDistance * 0.42, 85);
      indicator.style.height = `${damped}px`;
      indicator.classList.add("visible");
      if (damped >= PTR_THRESHOLD) {
        indicator.classList.add("ready");
        if (ptrText) ptrText.textContent = "Release to refresh";
      } else {
        indicator.classList.remove("ready");
        if (ptrText) ptrText.textContent = "Pull to refresh";
      }
    } else {
      indicator.style.height = "0px";
      indicator.classList.remove("visible", "ready");
    }
  }, { passive: true });

  const finishPTR = async () => {
    if (!isPTR || isRefreshing) return;
    isPTR = false;
    const isReady = indicator.classList.contains("ready");

    if (isReady) {
      isRefreshing = true;
      triggerHaptic("medium");
      indicator.classList.add("refreshing");
      if (ptrText) ptrText.textContent = "Syncing conversation...";
      indicator.style.height = "44px";

      try {
        if (state.activeConversationId) {
          await loadConversationMessages(state.activeConversationId, true);
        } else {
          await refreshConversationsList();
        }
        triggerHaptic("success");
      } catch (err) {
        // Ignore transient sync error
      } finally {
        setTimeout(() => {
          indicator.style.height = "0px";
          indicator.classList.remove("visible", "ready", "refreshing");
          if (ptrText) ptrText.textContent = "Pull to refresh";
          isRefreshing = false;
        }, 320);
      }
    } else {
      indicator.style.height = "0px";
      indicator.classList.remove("visible", "ready");
    }
  };

  timeline.addEventListener("touchend", finishPTR, { passive: true });
  timeline.addEventListener("touchcancel", finishPTR, { passive: true });
}

// ─── Swipe-Down to Dismiss Modal Sheets (Apple Physical Physics) ───

function makeSheetSwipeDismissable(backdropEl, cardEl, closeCallback) {
  if (!backdropEl || !cardEl) return;
  const handle = cardEl.querySelector(".sheet-drag-handle") || cardEl;
  
  let startY = 0;
  let currentY = 0;
  let isDragging = false;
  let startTime = 0;

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    
    // Do not intercept if the user is scrolling inside modal content
    const scrollContainer = cardEl.querySelector(".sheet-body") || cardEl.querySelector(".account-popup-body");
    if (scrollContainer && scrollContainer.scrollTop > 5 && e.target !== handle) {
      return;
    }
    
    startY = touch.clientY;
    currentY = touch.clientY;
    startTime = Date.now();
    isDragging = true;
    cardEl.style.transition = "none";
  };

  const onTouchMove = (e) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    currentY = touch.clientY;
    const deltaY = currentY - startY;

    if (deltaY > 0) {
      cardEl.style.transform = `translateY(${deltaY}px)`;
      const opacity = Math.max(0.1, 1 - (deltaY / 380));
      backdropEl.style.backgroundColor = `rgba(0, 0, 0, ${0.65 * opacity})`;
      if (e.cancelable) e.preventDefault();
    } else {
      const damped = deltaY * 0.15;
      cardEl.style.transform = `translateY(${damped}px)`;
    }
  };

  const onTouchEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    cardEl.style.transition = "transform 0.26s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease";
    backdropEl.style.transition = "background-color 0.26s ease";

    const deltaY = currentY - startY;
    const elapsed = Date.now() - startTime;
    const velocity = deltaY / Math.max(1, elapsed);

    if (deltaY > 80 || (velocity > 0.42 && deltaY > 35)) {
      triggerHaptic("light");
      cardEl.style.transform = "translateY(100%)";
      backdropEl.style.backgroundColor = "rgba(0, 0, 0, 0)";
      setTimeout(() => {
        cardEl.style.transform = "";
        cardEl.style.transition = "";
        backdropEl.style.backgroundColor = "";
        backdropEl.style.transition = "";
        if (typeof closeCallback === "function") {
          closeCallback();
        }
      }, 220);
    } else {
      cardEl.style.transform = "translateY(0)";
      backdropEl.style.backgroundColor = "";
      setTimeout(() => {
        cardEl.style.transform = "";
        cardEl.style.transition = "";
        backdropEl.style.transition = "";
      }, 260);
    }
  };

  handle.addEventListener("touchstart", onTouchStart, { passive: false });
  handle.addEventListener("touchmove", onTouchMove, { passive: false });
  handle.addEventListener("touchend", onTouchEnd, { passive: true });
  handle.addEventListener("touchcancel", onTouchEnd, { passive: true });
}

function initSwipeDismissableSheets() {
  const accountBackdrop = document.getElementById("accountModalSheet");
  const accountCard = accountBackdrop?.querySelector(".account-popup-card");
  if (accountBackdrop && accountCard) {
    makeSheetSwipeDismissable(accountBackdrop, accountCard, closeAccountModal);
  }

  const modelBackdrop = document.getElementById("modelSheetBackdrop");
  const modelCard = modelBackdrop?.querySelector(".sheet-card");
  if (modelBackdrop && modelCard) {
    makeSheetSwipeDismissable(modelBackdrop, modelCard, closeModelSheet);
  }

  const quotaBackdrop = document.getElementById("quotaSheetBackdrop");
  const quotaCard = quotaBackdrop?.querySelector(".sheet-card");
  if (quotaBackdrop && quotaCard) {
    makeSheetSwipeDismissable(quotaBackdrop, quotaCard, () => closeQuotaSheet({ target: quotaBackdrop, currentTarget: quotaBackdrop }));
  }

  const queueBackdrop = document.getElementById("queueChoiceBackdrop");
  const queueCard = queueBackdrop?.querySelector(".sheet-card");
  if (queueBackdrop && queueCard) {
    makeSheetSwipeDismissable(queueBackdrop, queueCard, () => closeQueueChoiceSheet({ target: queueBackdrop, currentTarget: queueBackdrop }));
  }
}

// Add user message directly to the timeline before server response (optimistic update)
function addOptimisticUserMessage(text, images) {
  const timeline = document.getElementById("conversationTimeline");
  if (!timeline) return;

  // Remove "no messages" placeholder if present
  const placeholder = timeline.querySelector("[data-placeholder]");
  if (placeholder) placeholder.remove();

  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble user animate-in";
  bubble.dataset.optimistic = "true";

  let imgHtml = "";
  if (images && images.length > 0) {
    imgHtml = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        ${images.map(img => {
          const url = getImageUrl(img);
          return `
            <div class="msg-img-cache-wrapper" style="position:relative;display:inline-block;">
              <img class="msg-attached-img" src="${escapeHtml(url)}" alt="Attachment"
                   onerror="this.onerror=null;this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='inline-flex';">
              <span class="cache-chip-badge" style="display:none;font-size:11px;color:var(--text-muted);background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 8px;align-items:center;gap:4px;">
                Image attachment (cached)
              </span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  bubble.innerHTML = `
    <div class="msg-header-row">
      <span class="sender-tag user">You</span>
      <span><span class="status-clean-text" style="font-size:10px;">[Sending...]</span> ${now}</span>
    </div>
    <div class="msg-content-body">${renderMarkdown(text)}</div>
    ${imgHtml}
  `;

  const procBubble = document.getElementById("agentProcessingBubble");
  if (procBubble) {
    timeline.insertBefore(bubble, procBubble);
  } else {
    timeline.appendChild(bubble);
  }
  timeline.scrollTop = timeline.scrollHeight;
}

function hydrateInitialData() {
  // 1. Try reading __INITIAL_DATA__ embedded directly by the server
  const scriptTag = document.getElementById("__INITIAL_DATA__");
  if (scriptTag) {
    try {
      const data = JSON.parse(scriptTag.textContent);
      if (data) {
        if (data.conversations && Array.isArray(data.conversations)) {
          state.conversations = data.conversations;
          renderConversationsListModal();
        }
        if (data.active_id) {
          state.activeConversationId = data.active_id;
        }
        if (data.token_quota) {
          updateTokenQuotaUI(data.token_quota);
        }
        if (data.active_conversation) {
          renderActiveConversation(data.active_conversation);
          return true;
        }
      }
    } catch (e) {
      console.debug("Could not parse initial state:", e);
    }
  }

  // 2. Fallback: read from localStorage on browser reload
  try {
    const cached = localStorage.getItem("antigravity_cached_conv");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.id) {
        state.activeConversationId = parsed.id;
        renderActiveConversation(parsed);
        return true;
      }
    }
  } catch (e) {}
  return false;
}

function renderActiveConversation(conv) {
  if (!conv) return;

  const titleElem = document.getElementById("activeConvTitle");
  const timeElem = document.getElementById("activeConvTime");
  const countElem = document.getElementById("activeConvCount");
  renderChatWorkspace(conv);
  const timelineCount = document.getElementById("timelineMessageCount");

  const msgCount = (conv.messages || []).length;

  if (titleElem) titleElem.textContent = conv.title || "Antigravity conversation";
  if (timeElem) timeElem.textContent = conv.updated_at || conv.created_at || "New conversation";
  if (countElem) countElem.textContent = `· ${msgCount} messages`;

  if (timelineCount) timelineCount.textContent = `${msgCount} messages`;

  renderTimelineMessages(conv.messages || [], conv.id);
  renderPendingInputUI(conv.pending_input, conv.pending_agreement);
  updateProcessingStateUI(conv.is_processing, conv.current_action, conv.active_tool);

  try {
    localStorage.setItem("antigravity_cached_conv", JSON.stringify(conv));
  } catch (e) {}
}

// ─── Interactive User Agreement & Input from Phone (ask_question & consent) ─

function renderPendingInputUI(pendingInput, pendingAgreement) {
  const card = document.getElementById("userAgreementCard");
  const actionTitle = document.getElementById("userAgreementActionTitle");
  const summaryElem = document.getElementById("userAgreementSummary");
  const promptElem = document.getElementById("userAgreementPrompt");
  const optionsList = document.getElementById("userAgreementOptionsList");
  const customRow = document.getElementById("userAgreementCustomRow");
  const customInput = document.getElementById("userAgreementCustomInput");

  if (!card) return;

  if (!pendingInput && !pendingAgreement) {
    card.classList.add("hidden");
    state.pendingAgreementData = null;
    return;
  }

  card.classList.remove("hidden");
  state.pendingAgreementData = {
    pendingInput: pendingInput || null,
    pendingAgreement: pendingAgreement || null,
    selected: [],
  };

  if (customRow) customRow.classList.remove("hidden");
  if (customInput) {
    customInput.value = "";
    customInput.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitUserAgreementAnswer();
      }
    };
  }

  if (pendingInput) {
    if (actionTitle) actionTitle.textContent = (pendingInput.toolAction || "INPUT REQUIRED").toUpperCase();
    if (summaryElem) summaryElem.textContent = pendingInput.toolSummary || "Antigravity IDE";

    const questions = pendingInput.questions || [];
    if (questions.length > 0) {
      const q = questions[0];
      if (promptElem) promptElem.textContent = q.question || "Choose an option to continue:";

      const isMulti = !!q.is_multi_select;
      const options = q.options || [];

      if (optionsList) {
        optionsList.innerHTML = options.map((opt) => `
          <button type="button" class="user-agreement-opt-btn" onclick="selectAgreementOption(this, '${escapeQuotes(opt)}', ${isMulti})">
            <span class="user-agreement-opt-dot"></span>
            <span>${escapeHtml(opt)}</span>
          </button>
        `).join("");
      }
    } else {
      if (promptElem) promptElem.textContent = "Antigravity needs your input:";
      if (optionsList) optionsList.innerHTML = "";
    }
  } else if (pendingAgreement) {
    if (actionTitle) actionTitle.textContent = "Confirmation needed";
    if (summaryElem) summaryElem.textContent = "Antigravity IDE";
    if (promptElem) promptElem.textContent = pendingAgreement.prompt || "Antigravity needs confirmation to continue:";

    const options = pendingAgreement.options || ["Approve and continue", "Revise or cancel"];
    if (optionsList) {
      optionsList.innerHTML = options.map((opt) => `
        <button type="button" class="user-agreement-opt-btn" onclick="selectAgreementOption(this, '${escapeQuotes(opt)}', false)">
          <span class="user-agreement-opt-dot"></span>
          <span>${escapeHtml(opt)}</span>
        </button>
      `).join("");
    }
  }
}

function selectAgreementOption(btn, optText, isMultiSelect) {
  if (!state.pendingAgreementData) {
    state.pendingAgreementData = { selected: [] };
  }

  if (isMultiSelect) {
    const isSelected = btn.classList.toggle("selected");
    if (isSelected) {
      if (!state.pendingAgreementData.selected.includes(optText)) {
        state.pendingAgreementData.selected.push(optText);
      }
    } else {
      state.pendingAgreementData.selected = state.pendingAgreementData.selected.filter(o => o !== optText);
    }
  } else {
    // Single select
    const container = document.getElementById("userAgreementOptionsList");
    if (container) {
      container.querySelectorAll(".user-agreement-opt-btn").forEach(b => b.classList.remove("selected"));
    }
    btn.classList.add("selected");
    state.pendingAgreementData.selected = [optText];
  }
}

async function submitUserAgreementAnswer(overrideText) {
  const card = document.getElementById("userAgreementCard");
  const customInput = document.getElementById("userAgreementCustomInput");
  const submitBtn = document.getElementById("btnSubmitAgreement");

  let selectedOptions = (state.pendingAgreementData && state.pendingAgreementData.selected) ? state.pendingAgreementData.selected : [];
  let writeInText = customInput ? customInput.value.trim() : "";

  let finalAnswer = "";
  if (overrideText) {
    finalAnswer = overrideText.trim();
  } else if (writeInText && selectedOptions.length > 0) {
    finalAnswer = `${selectedOptions.join(", ")} (${writeInText})`;
  } else if (selectedOptions.length > 0) {
    finalAnswer = selectedOptions.join(", ");
  } else if (writeInText) {
    finalAnswer = writeInText;
  }

  if (!finalAnswer) {
    showToast("Choose an option or enter an answer first.", "warning");
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.style.opacity = "0.5";
  }

  try {
    showToast("Sending reply to Antigravity...", "info");
    const res = await safeFetchJson("/api/conversations/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: state.activeConversationId,
        answer: finalAnswer,
        selected_options: selectedOptions,
      }),
    });

    if (res.ok) {
      showToast("Reply sent to Antigravity.", "success");
      addLogEvent(`Reply sent: ${finalAnswer}`);
      if (card) card.classList.add("hidden");
      if (customInput) customInput.value = "";
      state.pendingAgreementData = null;

      if (res.data && res.data.conversation) {
        renderActiveConversation(res.data.conversation);
      }
    } else {
      showToast(res.error || "Could not send the reply.", "error");
    }
  } catch (err) {
    showToast(`Could not send the reply: ${err.message}`, "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.style.opacity = "1";
    }
  }
}

function updateProcessingStateUI(isProcessing, currentAction, activeTool) {
  state.isProcessing = !!isProcessing;

  // Sync send button toggle: only show queue mode when actually executing
  const isExecuting = !!isProcessing;
  const singleRow = document.getElementById("sendActionSingle");
  const busyRow = document.getElementById("sendActionBusy");
  if (singleRow && busyRow) {
    if (isExecuting) {
      singleRow.classList.add("hidden");
      busyRow.classList.remove("hidden");
    } else {
      singleRow.classList.remove("hidden");
      busyRow.classList.add("hidden");
    }
  }

  const timeline = document.getElementById("conversationTimeline");
  if (!timeline) return;

  let procBubble = document.getElementById("agentProcessingBubble");

  if (isProcessing) {
    const actionText = currentAction || "Antigravity is working...";
    if (!procBubble) {
      procBubble = document.createElement("div");
      procBubble.id = "agentProcessingBubble";
      procBubble.className = "msg-bubble antigravity processing-bubble animate-in";
      procBubble.innerHTML = `
        <div class="msg-header-row">
          <span class="sender-tag agent">ANTIGRAVITY ENGINE</span>
          <span class="status-clean-text processing-tag">[ON PROCESSING]</span>
        </div>
        <div class="processing-content-row">
          <div class="apple-spring-dot"></div>
          <span id="agentProcessingText" class="processing-action-text">${escapeHtml(actionText)}</span>
        </div>
      `;
      timeline.appendChild(procBubble);
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
    } else {
      const textEl = document.getElementById("agentProcessingText");
      if (textEl && textEl.textContent !== actionText) {
        textEl.textContent = actionText;
      }
      if (timeline.lastElementChild !== procBubble) {
        timeline.appendChild(procBubble);
      }
    }
  } else {
    if (procBubble) {
      procBubble.remove();
    }
  }
}

function createMessageBubble(msg, animate = false) {
  const bubble = document.createElement("div");
  bubble.className = `msg-bubble ${msg.sender === "user" ? "user" : "antigravity"}${animate ? " animate-in" : ""}`;
  bubble.dataset.id = msg.id || "";
  bubble.dataset.messageSnapshot = JSON.stringify(msg);

  const isUser = msg.sender === "user";
  const senderTag = isUser ? `<span class="sender-tag user">You</span>` : `<span class="sender-tag agent">ANTIGRAVITY</span>`;
  
  const getStatusLabel = (status) => {
    if (!status) return "";
    const clean = status.toLowerCase();
    if (clean === "sent_to_ide") return "Sent";
    if (clean === "submitted") return "Queued";
    if (clean === "processing") return "In progress";
    if (clean === "completed") return "Complete";
    if (clean === "failed") return "Not sent";
    if (clean === "error") return "Task failed";
    return status.toUpperCase();
  };
  const statusTag = msg.status && !['completed', 'sent_to_ide'].includes(msg.status) ? `<span class="status-clean-text" style="font-size:10px;">${escapeHtml(getStatusLabel(msg.status))}</span>` : "";
  const parsedTime = new Date(String(msg.timestamp || '').replace(' ', 'T'));
  const displayTime = Number.isNaN(parsedTime.getTime()) ? '' : parsedTime.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const activeModelDisplay = msg.model || "";
  const modelTag = activeModelDisplay ? `<span class="model-badge-tag">${escapeHtml(activeModelDisplay)}</span>` : "";

  let innerHtml = `
    <div class="msg-header-row">
      <span>${senderTag}${modelTag}</span>
      <span>${statusTag} ${escapeHtml(displayTime)}</span>
    </div>
    <div class="msg-content-body">${renderMarkdown(msg.text)}</div>
  `;

  // Attached images from mobile (transient cache)
  if (msg.images && msg.images.length > 0) {
    innerHtml += `
      <div class="msg-images-container" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        ${msg.images.map(img => {
          const cleanUrl = getImageUrl(img);
          return `
            <div class="msg-img-cache-wrapper" style="position:relative;display:inline-block;">
              <img class="msg-attached-img" src="${escapeHtml(cleanUrl)}" alt="Attachment (tap to enlarge)" 
                   onerror="this.onerror=null;this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='inline-flex';" 
                   onload="onTimelineImageLoaded()"
                   onclick="openImageLightbox('${escapeQuotes(cleanUrl)}', 'Image attachment')">
              <span class="cache-chip-badge" style="display:none;font-size:11px;color:var(--text-muted);background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 8px;align-items:center;gap:4px;">
                Image attachment (cached)
              </span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // Bugs detected list
  if (msg.bugs_detected && msg.bugs_detected.length > 0) {
    innerHtml += `
      <div style="margin-top:10px;padding:10px 12px;border-left:3px solid var(--accent-red);background:rgba(239,68,68,0.08);border-radius:6px;">
        <div style="font-size:11px;font-weight:600;color:var(--accent-red);margin-bottom:6px;">
          Issues detected (${msg.bugs_detected.length}):
        </div>
        ${msg.bugs_detected.map(b => `<div style="font-size:12px;color:#fca5a5;margin-bottom:3px;">• ${escapeHtml(b.file)}:${b.line} — ${escapeHtml(b.message)}</div>`).join("")}
      </div>
    `;
  }

  // Fixes applied
  if (msg.fixes_applied && msg.fixes_applied.length > 0) {
    innerHtml += `
      <div style="margin-top:10px;padding:10px 12px;border-left:3px solid var(--accent-green);background:rgba(34,197,94,0.08);border-radius:6px;">
        <div style="font-size:11px;font-weight:600;color:var(--accent-green);margin-bottom:6px;">
          Fixes applied:
        </div>
        ${msg.fixes_applied.map(f => `<div style="font-size:12px;color:#86efac;margin-bottom:3px;">• ${escapeHtml(f)}</div>`).join("")}
      </div>
    `;
  }

  // Files modified & open in IDE button
  if (msg.files_modified && msg.files_modified.length > 0) {
    innerHtml += `
      <div class="msg-actions" style="margin-top:10px;">
        ${msg.files_modified.map(f => `
          <button class="btn-open-ide-file" type="button" onclick="openFileInLaptop('${escapeQuotes(f)}')">
            Open on laptop: ${escapeHtml(f.split(/[\\/]/).pop())}
          </button>
        `).join("")}
      </div>
    `;
  }

  // Single clean execution steps accordion (no triple repetition)
  if (msg.logs && msg.logs.length > 0) {
    innerHtml += `
      <details class="tech-logs-accordion" style="margin-top:10px;">
        <summary>Execution steps (${msg.logs.length} ${msg.logs.length === 1 ? 'step' : 'steps'})</summary>
        <div class="execution-steps-card" style="margin-top:6px;">
          ${msg.logs.map(logLine => `
            <div class="step-row-item">
              <span class="step-indicator-dot"></span>
              <span class="step-text-content">${escapeHtml(logLine)}</span>
            </div>
          `).join("")}
        </div>
      </details>
    `;
  }

  bubble.innerHTML = innerHtml;
  return bubble;
}

function isUserNearBottom(el, threshold = 220) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function onTimelineImageLoaded() {
  const timeline = document.getElementById("conversationTimeline");
  if (timeline && isUserNearBottom(timeline, 260)) {
    scrollTimelineToBottom(false);
  }
}

function scrollTimelineToBottom(smooth = false) {
  const timeline = document.getElementById("conversationTimeline");
  if (!timeline) return;

  const btnLatest = document.getElementById("btnScrollToLatest");
  if (btnLatest) btnLatest.classList.add("hidden");

  const anchor = document.getElementById("timelineScrollAnchor");

  const performScroll = () => {
    if (anchor && anchor.scrollIntoView) {
      try {
        anchor.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "end" });
      } catch (e) {
        timeline.scrollTop = timeline.scrollHeight + 10000;
      }
    } else {
      timeline.scrollTop = timeline.scrollHeight + 10000;
    }
  };

  performScroll();
  requestAnimationFrame(performScroll);
  setTimeout(performScroll, 50);
  setTimeout(performScroll, 140);
  setTimeout(performScroll, 320);
}

function ensureTimelineScrollAnchor(timeline) {
  if (!timeline) return null;
  let anchor = document.getElementById("timelineScrollAnchor");
  if (!anchor) {
    anchor = document.createElement("div");
    anchor.id = "timelineScrollAnchor";
    anchor.className = "timeline-scroll-anchor";
    timeline.appendChild(anchor);
  } else {
    timeline.appendChild(anchor);
  }
  return anchor;
}

function appendSingleMessageToTimeline(msg) {
  const timeline = document.getElementById("conversationTimeline");
  if (!timeline) return;

  const placeholder = timeline.querySelector("[data-placeholder]");
  if (placeholder) placeholder.remove();

  if (msg.id && timeline.querySelector(`.msg-bubble[data-id="${msg.id}"]`)) {
    return;
  }

  if (msg.sender === "user") {
    const optBubble = timeline.querySelector('.msg-bubble[data-optimistic="true"]');
    if (optBubble) optBubble.remove();
  }

  const bubble = createMessageBubble(msg, true);
  const procBubble = document.getElementById("agentProcessingBubble");
  const anchor = ensureTimelineScrollAnchor(timeline);

  if (procBubble) {
    timeline.insertBefore(bubble, procBubble);
  } else if (anchor) {
    timeline.insertBefore(bubble, anchor);
  } else {
    timeline.appendChild(bubble);
  }
  ensureTimelineScrollAnchor(timeline);

  scrollTimelineToBottom(true);
}

function renderTimelineMessages(messages, convId, forceScroll = false) {
  const timeline = document.getElementById("conversationTimeline");
  if (!timeline) return;

  const isSwitchingConv = convId && (convId !== state.renderedConversationId);

  if (!messages || messages.length === 0) {
    if (isSwitchingConv || !timeline.hasChildNodes()) {
      timeline.innerHTML = `
        <div data-placeholder="true" style="font-size:13px;color:var(--text-muted);text-align:center;padding:32px 12px;line-height:1.6;">
          No messages yet.<br>Write a message below to get started.
        </div>
      `;
      state.renderedConversationId = convId;
      ensureTimelineScrollAnchor(timeline);
    }
    return;
  }

  // Switching to a different conversation / initial load after refresh
  if (isSwitchingConv) {
    state.renderedConversationId = convId;
    timeline.innerHTML = "";
    const fragment = document.createDocumentFragment();

    const isExpanded = !!state.expandedHistory[convId];
    const maxInitial = 35;
    const shouldPaginate = messages.length > maxInitial && !isExpanded;
    const visibleMessages = shouldPaginate ? messages.slice(-maxInitial) : messages;
    const hiddenCount = messages.length - visibleMessages.length;

    if (shouldPaginate && hiddenCount > 0) {
      const loadMoreDiv = document.createElement("div");
      loadMoreDiv.className = "timeline-load-more";
      loadMoreDiv.style.cssText = "text-align:center;padding:12px 0 16px;";
      loadMoreDiv.innerHTML = `
        <button id="btnLoadMoreHistory" class="apple-btn-secondary" style="font-size:12px;padding:6px 16px;border-radius:20px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:var(--text-secondary);cursor:pointer;">
          Load ${hiddenCount} earlier ${hiddenCount === 1 ? "message" : "messages"}
        </button>
      `;
      const btn = loadMoreDiv.querySelector("button");
      if (btn) {
        btn.onclick = () => {
          state.expandedHistory[convId] = true;
          state.renderedConversationId = null;
          renderTimelineMessages(messages, convId, false);
        };
      }
      fragment.appendChild(loadMoreDiv);
    }

    visibleMessages.forEach((msg) => {
      try {
        fragment.appendChild(createMessageBubble(msg, false));
      } catch (err) {
        console.error("Error creating message bubble:", err, msg);
        try {
          const fallback = document.createElement("div");
          fallback.className = `msg-bubble ${msg.sender === "user" ? "user" : "antigravity"}`;
          fallback.dataset.id = msg.id || "";
          fallback.innerHTML = `
            <div class="msg-header-row">
              <span class="sender-tag ${msg.sender === "user" ? "user" : "agent"}">${msg.sender === "user" ? "You" : "ANTIGRAVITY ENGINE"}</span>
              <span class="status-clean-text" style="font-size:10px;">[Complete] ${msg.timestamp || ""}</span>
            </div>
            <div class="msg-content-body">${escapeHtml(msg.text || "")}</div>
          `;
          fragment.appendChild(fallback);
        } catch (e2) {}
      }
    });
    timeline.appendChild(fragment);
    ensureTimelineScrollAnchor(timeline);
    scrollTimelineToBottom(false);
    return;
  }

  // Same conversation: non-destructive reconciliation without flicker
  const wasNearBottom = isUserNearBottom(timeline, 240);
  const existingBubbles = Array.from(timeline.querySelectorAll(".msg-bubble[data-id]"));
  const currentMessages = new Map(messages.map(message => [message.id, message]));
  existingBubbles.forEach(bubble => {
    const message = currentMessages.get(bubble.dataset.id);
    if (!message) bubble.remove();
    else if (bubble.dataset.messageSnapshot !== JSON.stringify(message)) bubble.replaceWith(createMessageBubble(message, false));
  });
  const existingIdSet = new Set(existingBubbles.map(b => b.dataset.id).filter(Boolean));

  const missingMessages = messages.filter(m => !existingIdSet.has(m.id));

  // Remove placeholder if present
  const placeholder = timeline.querySelector("[data-placeholder]");
  if (placeholder && messages.length > 0) placeholder.remove();

  if (missingMessages.length === 0) {
    ensureTimelineScrollAnchor(timeline);
    if (forceScroll || wasNearBottom) scrollTimelineToBottom(false);
    return;
  }

  // Remove optimistic bubble once the user message arrives from the server
  if (missingMessages.some(m => m.sender === "user")) {
    const optBubble = timeline.querySelector('.msg-bubble[data-optimistic="true"]');
    if (optBubble) optBubble.remove();
  }

  // Append only new messages to the timeline
  const fragment = document.createDocumentFragment();
  for (const msg of missingMessages) {
    try {
      fragment.appendChild(createMessageBubble(msg, true));
    } catch (err) {
      console.error("Error creating incremental bubble:", err, msg);
      try {
        const fallback = document.createElement("div");
        fallback.className = `msg-bubble ${msg.sender === "user" ? "user" : "antigravity"} animate-in`;
        fallback.dataset.id = msg.id || "";
        fallback.innerHTML = `
          <div class="msg-header-row">
            <span class="sender-tag ${msg.sender === "user" ? "user" : "agent"}">${msg.sender === "user" ? "You" : "ANTIGRAVITY ENGINE"}</span>
            <span class="status-clean-text" style="font-size:10px;">[Complete] ${msg.timestamp || ""}</span>
          </div>
          <div class="msg-content-body">${escapeHtml(msg.text || "")}</div>
        `;
        fragment.appendChild(fallback);
      } catch (e2) {}
    }
  }
  const procBubble = document.getElementById("agentProcessingBubble");
  const anchor = ensureTimelineScrollAnchor(timeline);
  if (procBubble) {
    timeline.insertBefore(fragment, procBubble);
  } else if (anchor) {
    timeline.insertBefore(fragment, anchor);
  } else {
    timeline.appendChild(fragment);
  }
  ensureTimelineScrollAnchor(timeline);

  // Scroll to bottom when a new reply arrives or user was already near the bottom
  if (wasNearBottom || forceScroll || missingMessages.some(m => m.sender === "user")) {
    scrollTimelineToBottom(true);
  }
}

function renderConversationsListModal() {
  const container = document.getElementById("conversationsListContainer");
  const summaryEl = document.getElementById("convListSummary");
  if (!container) return;
  container.innerHTML = "";

  if (summaryEl) {
    summaryEl.textContent = `${state.conversations.length} conversations`;
  }

  if (state.conversations.length === 0) {
    container.innerHTML = `<span style="font-size:12px;color:var(--text-muted);padding:14px;text-align:center;display:block;">No conversations yet. Use New in Chat to begin.</span>`;
    return;
  }

  state.conversations.forEach((conv) => {
    const row = document.createElement("div");
    const isActive = conv.id === state.activeConversationId;
    row.className = `conv-item-row ${isActive ? "active" : ""}`;

    row.innerHTML = `
      <div style="flex:1;min-width:0;padding-right:8px;">
        <div class="conv-item-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${isActive ? '<span style="color:var(--accent-blue);font-size:10px;font-weight:700;margin-right:6px;">Active</span>' : ''}
          ${escapeHtml(conv.title)}
        </div>
        <div class="conv-item-meta">${conv.message_count} messages · ${conv.updated_at || conv.created_at}</div>
      </div>
      <button class="btn-del-conv" type="button" title="Delete conversation" onclick="promptDeleteConversation('${conv.id}', event)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;

    row.onclick = (e) => {
      if (e.target.closest(".btn-del-conv")) return;
      switchConversation(conv.id);
    };

    container.appendChild(row);
  });
}

function openConversationModal() {
  const modal = document.getElementById("conversationModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  renderConversationsListModal();
  fetchConversations();
}

function closeConversationModal() {
  const modal = document.getElementById("conversationModal");
  if (modal) modal.classList.add("hidden");
}

function switchConversation(convId) {
  closeConversationModal();
  selectConversation(convId);
}

async function selectConversation(convId) {
  if (!convId) return;
  const seq = ++state.conversationLoadSeq;
  state.activeConversationId = convId;
  state.renderedConversationId = null;
  ensureConvoTabOpen(convId);

  const res = await safeFetchJson("/api/conversations/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: convId }),
  });
  if (seq !== state.conversationLoadSeq || state.activeConversationId !== convId) return;
  if (res.ok && res.data && res.data.conversation) {
    renderActiveConversation(res.data.conversation);
    addLogEvent(`Switched to conversation: ${res.data.conversation.title || convId}`);
  } else {
    loadConversation(convId);
  }
}

// ─── Popup Modal New conversation ─────────────────────────────────────

function openNewSessionModal() {
  const modal = document.getElementById("newSessionModal");
  if (!modal) return;
  modal.classList.remove("hidden");

  const titleInput = document.getElementById("modalSessionTitleInput");
  const promptInput = document.getElementById("newSessionPromptInput");
  if (titleInput) {
    titleInput.value = "";
    setTimeout(() => titleInput.focus(), 80);
  }
  if (promptInput) promptInput.value = "";
  const projectLabel = document.getElementById("newSessionProject");
  if (projectLabel) projectLabel.textContent = `Project: ${state.currentWorkspace?.name || state.activeWorkspaceName || "selected project"}`;


}

function closeNewSessionModal() {
  const modal = document.getElementById("newSessionModal");
  if (modal) modal.classList.add("hidden");
}

async function submitNewSession() {
  const titleInput = document.getElementById("modalSessionTitleInput");
  const promptInput = document.getElementById("newSessionPromptInput");
  const submitBtn = document.getElementById("btnSubmitNewSession");

  let title = titleInput ? titleInput.value.trim() : "";
  const initialPrompt = promptInput ? promptInput.value.trim() : "";

  if (!title) {
    title = initialPrompt ? initialPrompt.split("\n")[0].slice(0, 60) : "New conversation";
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating conversation...";
  }

  try {
    const res = await safeFetchJson("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title,
        skills: Array.from(state.selectedSkills),
        initial_prompt: null,
        model: state.selectedModel || null,
      }),
    });

    if (!res.ok) {
      showToast(res.error, "error");
      return;
    }

    const newConv = res.data;
    closeNewSessionModal();
    state.activeConversationId = newConv.id;
    state.renderedConversationId = null;

    // Add directly to state.conversations so it appears immediately in the modal
    const newConvMeta = {
      id: newConv.id,
      title: newConv.title || title,
      created_at: newConv.created_at,
      updated_at: newConv.updated_at,
      message_count: (newConv.messages || []).length,
      workspace: newConv.workspace || "",
      workspace_path: newConv.workspace_path,
      is_active: true,
      is_antigravity_native: true,
    };
    state.conversations = [newConvMeta, ...state.conversations.filter(c => c.id !== newConv.id)];
    renderConversationsListModal();

    addLogEvent(`Conversation created: ${newConv.title || newConv.id}`);
    showToast(`Conversation '${newConv.title}' saved.`, "success");

    renderActiveConversation(newConv);
    ensureConvoTabOpen(newConv.id);
    updateActiveConvHeaderMeta();
    await fetchConversations(true);
    if (initialPrompt) {
      const composer = document.getElementById("taskInput");
      if (composer) composer.value = initialPrompt;
      await executeSubmitTask("auto");
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Start conversation";
    }
  }
}

// ─── Delete Conversation Confirmation Modal ────────────────────

function promptDeleteConversation(convId, e) {
  if (e) e.stopPropagation();
  if (!convId) return;

  const target = state.conversations.find(c => c.id === convId);
  state.sessionToDelete = convId;

  const titleEl = document.getElementById("deleteConvTargetTitle");
  if (titleEl) {
    titleEl.textContent = target ? target.title : `Conversation (${convId.slice(0, 8)})`;
  }

  const modal = document.getElementById("deleteConfirmModal");
  if (modal) modal.classList.remove("hidden");
}

function closeDeleteModal() {
  const modal = document.getElementById("deleteConfirmModal");
  if (modal) modal.classList.add("hidden");
  state.sessionToDelete = null;
}

async function confirmDeleteConversation() {
  const convId = state.sessionToDelete;
  if (!convId) return;

  const btn = document.getElementById("btnConfirmDeleteConv");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Deleting...";
  }

  try {
    const res = await safeFetchJson(`/api/conversations/${convId}`, { method: "DELETE" });
    closeDeleteModal();

    if (!res.ok) {
      showToast(res.error, "error");
      return;
    }

    showToast("Conversation deleted", "success");
    addLogEvent(`Conversation ${convId.slice(0, 8)} deleted.`);

    // 1. Update local state immediately
    state.conversations = state.conversations.filter(c => c.id !== convId);
    if (res.data && res.data.conversations) {
      state.conversations = res.data.conversations;
    }

    // Remove from openConvoIds and save to localStorage
    state.openConvoIds = (state.openConvoIds || []).filter(id => id !== convId);
    saveOpenTabsToStorage();
    renderConvoTabs();

    // 2. Re-render conversation list inside the modal
    renderConversationsListModal();

    // 3. If the deleted conversation was active, switch to another one
    if (state.activeConversationId === convId) {
      const nextActiveId = res.data?.active_id || (state.openConvoIds.length > 0 ? state.openConvoIds[0] : (state.conversations.length > 0 ? state.conversations[0].id : null));
      if (nextActiveId) {
        state.activeConversationId = nextActiveId;
        state.renderedConversationId = null;
        ensureConvoTabOpen(nextActiveId);
        loadConversation(nextActiveId);
      } else {
        state.activeConversationId = null;
        state.renderedConversationId = null;
        const titleElem = document.getElementById("activeConvTitle");
        if (titleElem) titleElem.textContent = "No conversation selected";
        const timeElem = document.getElementById("activeConvTime");
        if (timeElem) timeElem.textContent = "--";
        const countElem = document.getElementById("activeConvCount");
        if (countElem) countElem.textContent = "· 0 messages";
        const timeline = document.getElementById("conversationTimeline");
        if (timeline) {
          timeline.innerHTML = `
            <div data-placeholder="true" style="font-size:13px;color:var(--text-muted);text-align:center;padding:32px 12px;line-height:1.6;">
              No messages yet.<br>Write a message below to get started.
            </div>
          `;
        }
      }
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Delete conversation";
    }
  }
}

async function openFileInLaptop(filepath, line = 1) {
  try {
    const res = await safeFetchJson("/api/antigravity/open-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath, line }),
    });
    if (!res.ok) {
      showToast(res.error || "Could not open file on laptop.", "error");
      return;
    }
    const msg = res.data?.message || `Opened ${filepath} in Antigravity.`;
    showToast(msg, "info");
    addLogEvent(msg);
  } catch (e) {
    showToast(`Could not open file on laptop: ${e.message}`, "error");
  }
}

// ─── Workspace & Nested Folder Management ──────────────────────

async function fetchWorkspaces() {
  try {
    const res = await safeFetchJson("/api/workspaces");
    if (!res.ok || !res.data) return;
    const data = res.data;
    state.currentWorkspace = data.active;
    state.availableFolders = data.folders || [];

    updateWorkspaceUI(data.active);
    populateWorkspaceDropdown(data.folders || [], data.active?.path || "");
  } catch (e) {
    console.error("Could not fetch project:", e);
  }
}

function renderWorkspaceHierarchyBreadcrumb(wsPath) {
  const container = document.getElementById("workspaceHierarchyBreadcrumb");
  if (!container) return;
  if (!wsPath) {
    container.innerHTML = "";
    return;
  }

  // Parse path segments
  const normalized = wsPath.replace(/\\/g, "/");
  const desktopPrefix = "/__no_desktop_prefix__/";
  let parts = [];
  if (normalized.toLowerCase().startsWith(desktopPrefix.toLowerCase())) {
    const rel = normalized.slice(desktopPrefix.length);
    parts = rel.split("/").filter(Boolean);
  } else {
    parts = normalized.split("/").filter(Boolean).slice(-3);
  }

  if (parts.length === 0) {
    container.innerHTML = `<span class="hierarchy-pill root">[ROOT PROJECT]</span> <span class="hierarchy-pill-name">Desktop</span>`;
    return;
  }

  const pillsHtml = parts.map((part, idx) => {
    let lvlClass = "root";
    let lvlLabel = "ROOT PROJECT";
    if (idx === 1) {
      lvlClass = "lv1";
      lvlLabel = "SUB LV.1";
    } else if (idx === 2) {
      lvlClass = "lv2";
      lvlLabel = "SUB LV.2 · CHILD";
    } else if (idx >= 3) {
      lvlClass = "lv3";
      lvlLabel = `SUB LV.${idx} · NESTED`;
    }
    return `
      <div style="display:inline-flex;align-items:center;gap:4px;">
        <span class="hierarchy-pill ${lvlClass}">[${lvlLabel}]</span>
        <span class="hierarchy-pill-name">${escapeHtml(part)}</span>
        ${idx < parts.length - 1 ? '<span class="hierarchy-sep">›</span>' : ''}
      </div>
    `;
  }).join("");

  container.innerHTML = pillsHtml;
}

function renderChatWorkspace(conversation = state.conversations.find(c => c.id === state.activeConversationId)) {
  const el = document.getElementById("activeConvWorkspace");
  if (!el) return;
  const bound = conversation?.workspace_path;
  const path = bound || state.currentWorkspace?.path || "";
  const name = (bound && bound.split(/[\\/]/).filter(Boolean).pop()) || state.currentWorkspace?.name || conversation?.workspace || "Workspace";
  el.textContent = `· target: ${name}`;
  el.title = path || name;
}

function updateWorkspaceUI(ws) {
  if (!ws) return;
  state.currentWorkspace = ws;
  state.activeWorkspaceName = ws.name;
  renderChatWorkspace();
  const nameEl = document.getElementById("currentWorkspaceName");
  const pathEl = document.getElementById("workspacePathText");
  const branchEl = document.getElementById("workspaceBranchText");
  if (nameEl) nameEl.textContent = ws.name || "Workspace";
  if (pathEl) pathEl.textContent = ws.path || "";
  if (branchEl) branchEl.textContent = ws.is_git ? `· branch: ${ws.branch}` : "· non-git";
  renderWorkspaceHierarchyBreadcrumb(ws.path);
}

function populateWorkspaceDropdown(folders, activePath) {
  const select = document.getElementById("workspaceSelect");
  if (!select) return;

  select.innerHTML = "";

  // Group by root project (root_group)
  const groups = {};
  folders.forEach((f) => {
    const groupName = f.root_group || "Other Projects";
    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push(f);
  });

  Object.entries(groups).forEach(([groupName, items]) => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = `PROJECT: ${groupName.toUpperCase()}`;

    items.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.path;

      // Use non-breaking spaces (\u00A0) so mobile browsers preserve tree indentation
      let prefix = "";
      if (f.depth === 0) {
        prefix = f.is_active ? "Active " : "[PROJECT] ";
      } else if (f.depth === 1) {
        prefix = "\u00A0\u00A0├── [SUB LV.1] ";
      } else if (f.depth === 2) {
        prefix = "\u00A0\u00A0│\u00A0\u00A0└── [SUB LV.2 · CHILD] ";
      } else {
        prefix = `\u00A0\u00A0│\u00A0\u00A0│\u00A0\u00A0└── [SUB LV.${f.depth}] `;
      }

      const cleanName = f.name.includes(" / ") ? f.name.split(" / ").pop() : f.name;
      opt.textContent = `${prefix}${cleanName}`;

      if (activePath && f.path.toLowerCase() === activePath.toLowerCase()) {
        opt.selected = true;
      }
      optgroup.appendChild(opt);
    });

    select.appendChild(optgroup);
  });
}

async function selectWorkspaceByPath(targetPath) {
  if (!targetPath) return;
  try {
    const res = await safeFetchJson("/api/workspaces/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: targetPath }),
    });
    if (res.ok && res.data && res.data.workspace) {
      const data = res.data;
      updateWorkspaceUI(data.workspace);
      const modal = document.getElementById("browseModal");
      if (modal) modal.classList.add("hidden");
      addLogEvent(`Active workspace: ${data.workspace.name}`);
      showToast(`Active project changed to: ${data.workspace.name}`, "success");
      fetchWorkspaces();
    } else {
      showToast(res.error || "Could not select the project.", "error");
    }
  } catch (e) {
    showToast(`Could not select project: ${e.message}`, "error");
  }
}

async function setTargetWorkspace() {
  const select = document.getElementById("workspaceSelect");
  const chosenPath = select ? select.value : "";
  if (!chosenPath) return;
  selectWorkspaceByPath(chosenPath);
}

async function openWorkspaceInIde() {
  const select = document.getElementById("workspaceSelect");
  const targetPath = (select && select.value) || (state.currentWorkspace ? state.currentWorkspace.path : "");

  try {
    const res = await safeFetchJson("/api/workspaces/open-in-ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: targetPath }),
    });
    if (!res.ok) {
      showToast(res.error || "Could not open project in Antigravity.", "error");
      return;
    }
    const msg = res.data?.message || "Opened project in Antigravity on the laptop.";
    showToast(msg, "success");
    addLogEvent(msg);
  } catch (e) {
    showToast(`Could not open in Antigravity: ${e.message}`, "error");
  }
}

// Interactive Breadcrumb Drill-Down Folder Explorer (Apple macOS Finder / iOS Files style)
function closeFolderBrowser() {
  state.browseRequestSeq += 1;
  state.browseAbortController?.abort();
  state.browseAbortController = null;
  state.browseCurrentPath = "";
  const selectBtn = document.getElementById("btnSelectThisFolder");
  if (selectBtn) selectBtn.disabled = true;
  document.getElementById("browseModal")?.classList.add("hidden");
}

async function openFolderBrowser(targetDir = "") {
  const modal = document.getElementById("browseModal");
  if (!modal) return;
  modal.classList.remove("hidden");

  const reqSeq = (state.browseRequestSeq = (state.browseRequestSeq || 0) + 1);
  if (state.browseAbortController) {
    try { state.browseAbortController.abort(); } catch (_) {}
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  state.browseAbortController = controller;
  state.browseCurrentPath = "";

  const parentBtn = document.getElementById("btnBrowseParent");
  const selectBtn = document.getElementById("btnSelectThisFolder");
  const breadcrumbsContainer = document.getElementById("browseBreadcrumbs");
  const countText = document.getElementById("subfolderCountText");
  const list = document.getElementById("browseFoldersList");

  if (breadcrumbsContainer) breadcrumbsContainer.innerHTML = "";
  if (countText) countText.textContent = "Loading…";
  if (list) list.innerHTML = '<div class="browse-empty-state" role="status">Loading folders…</div>';

  if (parentBtn) {
    parentBtn.disabled = true;
    parentBtn.style.opacity = "0.4";
    parentBtn.onclick = null;
  }
  if (selectBtn) {
    selectBtn.disabled = true;
    selectBtn.onclick = () => {
      if (!state.browseCurrentPath) return;
      selectWorkspaceByPath(state.browseCurrentPath);
    };
  }

  const showBrowseError = (message) => {
    state.browseCurrentPath = "";
    if (selectBtn) selectBtn.disabled = true;
    if (parentBtn) {
      parentBtn.disabled = true;
      parentBtn.style.opacity = "0.4";
      parentBtn.onclick = null;
    }
    if (breadcrumbsContainer) breadcrumbsContainer.innerHTML = "";
    if (countText) countText.textContent = "Unavailable";
    if (list) {
      list.innerHTML = `<div class="browse-empty-state"><span style="font-size:12px;color:var(--text-muted);">${escapeHtml(message || "Could not load folders.")}</span></div>`;
    }
    showToast(message || "Could not browse directory.", "error");
  };

  const url = targetDir ? `/api/workspaces/browse?target_dir=${encodeURIComponent(targetDir)}` : "/api/workspaces/browse";
  try {
    const res = await safeFetchJson(url, controller ? { signal: controller.signal } : {});
    if (reqSeq !== state.browseRequestSeq || res.aborted) return;
    if (state.browseAbortController === controller) {
      state.browseAbortController = null;
    }

    if (!res.ok || !res.data) {
      showBrowseError(res.error || "Could not browse directory.");
      return;
    }
    const data = res.data;
    state.browseCurrentPath = data.current_path || "";

    // Render dynamic quick jump shortcuts when returned by the server
    const shortcutsList = modal.querySelector ? modal.querySelector(".modal-shortcuts-list") : null;
    if (shortcutsList && Array.isArray(data.shortcuts) && data.shortcuts.length > 0) {
      const currentLower = String(data.current_path || "").toLowerCase();
      shortcutsList.innerHTML = data.shortcuts.map((s) => {
        const isCurrent = s.path && String(s.path).toLowerCase() === currentLower;
        return `<button class="shortcut-pill${isCurrent ? " active" : ""}" type="button" onclick="openFolderBrowser('${escapeQuotes(s.path)}')">${escapeHtml(s.name)}</button>`;
      }).join("");
    }

    // Render Clickable Breadcrumbs
    if (breadcrumbsContainer) {
      const crumbs = Array.isArray(data.breadcrumbs) && data.breadcrumbs.length > 0
        ? data.breadcrumbs
        : (data.current_path ? [{ name: data.current_path, path: data.current_path }] : []);
      breadcrumbsContainer.innerHTML = crumbs.map((b, idx) => {
        const isLast = idx === crumbs.length - 1;
        if (isLast) {
          return `
            <div class="breadcrumb-item current">
              <span class="breadcrumb-crumb current">${escapeHtml(b.name)}</span>
            </div>
          `;
        }
        return `
          <div class="breadcrumb-item">
            <span class="breadcrumb-crumb" onclick="openFolderBrowser('${escapeQuotes(b.path)}')">${escapeHtml(b.name)}</span>
            <span class="breadcrumb-sep">/</span>
          </div>
        `;
      }).join("");
    }

    const subfolders = Array.isArray(data.subfolders)
      ? data.subfolders
      : (Array.isArray(data.entries) ? data.entries.filter((e) => e && e.type === "dir") : []);

    // Subfolder Counter
    if (countText) {
      const len = subfolders.length;
      countText.textContent = `${len} ${len === 1 ? "subfolder" : "subfolders"}`;
    }

    if (list) {
      list.innerHTML = "";

      if (subfolders.length === 0) {
        list.innerHTML = `
          <div class="browse-empty-state">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--text-muted);margin-bottom:6px;">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            <span style="font-size:12px;color:var(--text-muted);">No subfolders here. You can use this folder as your project.</span>
          </div>
        `;
      } else {
        subfolders.forEach((sf) => {
          const row = document.createElement("div");
          row.className = "apple-folder-item";

          const gitBadge = sf.is_git ? `<span class="apple-folder-badge git">GIT</span>` : "";
          const hasSubCount = typeof sf.subfolder_count === "number";
          const hasChildren = typeof sf.has_children === "boolean" ? sf.has_children : true;
          const childText = hasSubCount
            ? (sf.subfolder_count > 0 ? `${sf.subfolder_count} ${sf.subfolder_count === 1 ? "folder" : "folders"}` : "Empty")
            : "Folder";

          row.innerHTML = `
            <div class="apple-folder-main" onclick="openFolderBrowser('${escapeQuotes(sf.path)}')">
              <div class="apple-folder-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="1.75">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
              </div>
              <div class="apple-folder-details">
                <div class="apple-folder-name-row">
                  <span class="apple-folder-title">${escapeHtml(sf.name)}</span>
                  ${gitBadge}
                </div>
                <span class="apple-folder-subtext">${childText}</span>
              </div>
            </div>
            <div class="apple-folder-actions">
              <button class="btn-select-folder-pill" type="button" title="Use ${escapeHtml(sf.name)} as the project folder" onclick="selectWorkspaceByPath('${escapeQuotes(sf.path)}')">
                Select
              </button>
              ${hasChildren ? `
                <button class="btn-folder-chevron" type="button" title="Open ${escapeHtml(sf.name)}" onclick="openFolderBrowser('${escapeQuotes(sf.path)}')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                </button>
              ` : ''}
            </div>
          `;
          list.appendChild(row);
        });
      }
    }

    if (parentBtn) {
      parentBtn.onclick = () => {
        if (data.parent_path) openFolderBrowser(data.parent_path);
      };
      parentBtn.disabled = !data.parent_path;
      parentBtn.style.opacity = data.parent_path ? "1" : "0.4";
    }

    if (selectBtn) {
      selectBtn.disabled = !state.browseCurrentPath;
    }
  } catch (e) {
    if (reqSeq !== state.browseRequestSeq || (e && e.name === "AbortError")) return;
    if (state.browseAbortController === controller) {
      state.browseAbortController = null;
    }
    console.error("Could not browse directory:", e);
    showBrowseError(`Could not browse directory: ${e.message}`);
  }
}

// ─── Telemetry Renderer (Anti-Badge Typography) ───────────────

function updateTelemetryUI(telemetry) {
  if (!telemetry) return;

  // Hostname
  const hostElem = document.getElementById("deviceHostname");
  if (hostElem) hostElem.textContent = `${telemetry.hostname} — LAPTOP`;

  // Battery
  const batt = telemetry.battery;
  if (batt) {
    const battText = document.getElementById("batteryPercent");
    const battBar = document.getElementById("batteryBar");
    const battState = document.getElementById("batteryPowerState");

    if (battText) battText.textContent = Number.isFinite(batt.percent) ? `${batt.percent}%` : "--";
    if (battBar) battBar.style.width = `${batt.percent ?? 0}%`;
    if (battState) battState.textContent = Number.isFinite(batt.percent) ? (batt.is_plugged ? "Plugged in" : "On battery") : "Power status unavailable";
  }

  // CPU & RAM
  const cpuText = document.getElementById("cpuUsage");
  const cpuBar = document.getElementById("cpuBar");
  const ramText = document.getElementById("ramUsage");

  if (cpuText) cpuText.textContent = Number.isFinite(telemetry.cpu_percent) ? `${telemetry.cpu_percent.toFixed(1)}%` : "--";
  if (cpuBar) cpuBar.style.width = `${Math.min(100, telemetry.cpu_percent)}%`;
  if (ramText && telemetry.memory) {
    ramText.textContent = `${telemetry.memory.percent}% RAM`;
  }

  // Antigravity IDE Engine
  const ag = telemetry.antigravity;
  const agText = document.getElementById("agStatusText");
  const agPid = document.getElementById("agPidBadge");

  if (ag && ag.is_running) {
    if (agText) {
      agText.textContent = "RUNNING ACTIVE";
      agText.style.color = "var(--accent-green)";
    }
    if (agPid) agPid.textContent = `PID: ${ag.primary_pid || "--"}`;
  } else {
    if (agText) {
      agText.textContent = "NOT RUNNING";
      agText.style.color = "var(--accent-amber)";
    }
    if (agPid) agPid.textContent = "IDLE";
  }

  if (telemetry.token_quota) {
    updateTokenQuotaUI(telemetry.token_quota);
  }
}

// ─── Token Limit & Quota Monitor UI ──────────────────────────

function renderQuotaGroups(tokenData) {
  const container = document.getElementById("quotaGroups");
  if (!container) return;
  const groups = Array.isArray(tokenData.quota_groups) ? tokenData.quota_groups : [];
  if (!tokenData.is_live || groups.length === 0) {
    container.innerHTML = '<p class="quota-row-subtext" role="status">Quota unavailable. Open the standalone Antigravity App on the laptop to sync usage.</p>';
    return;
  }
  container.innerHTML = groups.map(group => `
    <div class="quota-group-header" style="margin-top:18px"><h3 class="quota-group-title">${escapeHtml(group.title || 'Model usage')}</h3></div>
    ${group.description ? `<p class="quota-row-subtext">${escapeHtml(group.description)}</p>` : ''}
    <div class="quota-box">${(Array.isArray(group.buckets) ? group.buckets : []).map(bucket => {
      const pct = !bucket.disabled && Number.isFinite(bucket.remaining_pct) ? Math.min(100, Math.max(0, bucket.remaining_pct)) : null;
      const window = { weekly: 'Weekly limit remaining', '5h': 'Five-hour limit remaining', daily: 'Daily limit remaining', monthly: 'Monthly limit remaining' }[bucket.window];
      const title = bucket.title || window || bucket.window || 'Limit remaining';
      const reset = bucket.reset_time ? new Date(bucket.reset_time) : null;
      const note = bucket.disabled ? 'This limit does not currently apply.' : reset && Number.isFinite(reset.getTime())
        ? `Resets ${new Intl.DateTimeFormat('en', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(reset)}`
        : bucket.description || 'Not reported by Antigravity.';
      const color = pct === null ? '#71717a' : pct <= 10 ? '#ef4444' : pct <= 40 ? '#f59e0b' : '#4ade80';
      return `<div class="quota-row"><div class="quota-info-col"><div class="quota-row-label">${escapeHtml(title)}</div><div class="quota-row-subtext">${escapeHtml(note)}</div></div>
        <div class="quota-metric-col"><span class="quota-pct-text">${bucket.disabled ? 'N/A' : pct === null ? '--' : `${pct}%`}</span>
          <svg width="34" height="34" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.9155" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="3.5"/><circle cx="18" cy="18" r="15.9155" fill="none" stroke="${color}" stroke-width="3.5" stroke-dasharray="100,100" stroke-dashoffset="${100 - (pct ?? 0)}" stroke-linecap="round" transform="rotate(-90 18 18)"/></svg>
        </div></div>`;
    }).join('') || '<p class="quota-row-subtext">No limits reported for this group.</p>'}</div>`).join('');
}

function updateTokenQuotaUI(tokenData) {
  if (!tokenData) return;
  const f5 = tokenData.five_hours || {};
  const f7 = tokenData.weekly || {};
  const mq = tokenData.models_quota || {};
  const gModels = mq.gemini_models || {};
  const cModels = mq.claude_gpt_models || {};

  function fmtNum(n) {
    if (n === undefined || n === null) return "--";
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(n);
  }

  function quotaLabel(pct) { return Number.isFinite(pct) ? `${pct}%` : "--"; }

  function getRingColor(pct) {
    if (pct === null) return "#71717a";
    if (pct <= 10) return "#ef4444";
    if (pct <= 40) return "#f59e0b";
    return "#4ade80";
  }

  state.tokenQuota = tokenData;
  renderQuotaGroups(tokenData);
  for (const [prefix, model] of [["gemini", gModels], ["claude", cModels], ["argon", mq.argon_models || {}]]) {
    for (const [suffix, period] of [["Weekly", "weekly"], ["5h", "five_hour"]]) {
      const quota = model[period] || {};
      const pct = !quota.disabled && Number.isFinite(quota.remaining_pct) ? quota.remaining_pct : null;
      const value = document.getElementById(prefix + suffix + "Pct");
      if (value) value.textContent = quota.disabled ? "N/A" : quotaLabel(pct);
      const note = document.getElementById(prefix + suffix + "Subtext");
      if (note) {
        const reset = quota.reset_time ? new Date(quota.reset_time) : null;
        note.textContent = quota.disabled ? "This limit does not currently apply."
          : reset && Number.isFinite(reset.getTime())
            ? `Resets ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(reset)}`
            : quota.refresh_text || "Not reported by Antigravity.";
      }
      const ring = document.getElementById(prefix + suffix + "Ring");
      if (ring) {
        ring.setAttribute("stroke-dashoffset", String(100 - (pct ?? 0)));
        ring.style.stroke = getRingColor(pct);
      }
      const row = document.getElementById(prefix + suffix + "Row");
      if (prefix === "argon" && suffix === "5h" && row) row.classList.toggle("hidden", quota.available !== true);
    }
  }
  const gWeeklyPct = Number.isFinite(gModels.weekly?.remaining_pct) ? gModels.weekly.remaining_pct : null;
  const cWeeklyPct = Number.isFinite(cModels.weekly?.remaining_pct) ? cModels.weekly.remaining_pct : null;

  // 3. Sync Header Pill, Tab Badge & Quick Strip
  const navToken = document.getElementById("navTokenText");
  if (navToken) navToken.textContent = `${quotaLabel(gWeeklyPct)} GEMINI`;

  const tabBadge = document.getElementById("tabTokenBadge");
  if (tabBadge) tabBadge.textContent = `${quotaLabel(gWeeklyPct)}`;

  const stripG = document.getElementById("stripGeminiWeekly");
  if (stripG) stripG.textContent = `${quotaLabel(gWeeklyPct)}`;
  const stripGRing = document.getElementById("stripGeminiRing");
  if (stripGRing) {
    stripGRing.setAttribute("stroke-dashoffset", String(Math.max(0, 100 - (gWeeklyPct ?? 0))));
    stripGRing.style.stroke = getRingColor(gWeeklyPct);
  }

  const stripC = document.getElementById("stripClaudeWeekly");
  if (stripC) stripC.textContent = `${quotaLabel(cWeeklyPct)}`;
  const stripCRing = document.getElementById("stripClaudeRing");
  if (stripCRing) {
    stripCRing.setAttribute("stroke-dashoffset", String(Math.max(0, 100 - (cWeeklyPct ?? 0))));
    stripCRing.style.stroke = getRingColor(cWeeklyPct);
  }

  const mGVal = document.getElementById("modalGeminiWeeklyVal");
  if (mGVal) mGVal.textContent = `${quotaLabel(gWeeklyPct)} Gemini`;
  const mCVal = document.getElementById("modalClaudeWeeklyVal");
  if (mCVal) mCVal.textContent = `${quotaLabel(cWeeklyPct)} Claude`;

  // 4. Compact Cumulative Stats
  const el5Total = document.getElementById("token5hTotal");
  if (el5Total) el5Total.textContent = f5.formatted_total || fmtNum(f5.total_tokens);

  const el5Status = document.getElementById("token5hStatus");
  if (el5Status) el5Status.textContent = f5.status || "Optimal";

  const el7Total = document.getElementById("token7dTotal");
  if (el7Total) el7Total.textContent = f7.formatted_total || fmtNum(f7.total_tokens);

  const elModel = document.getElementById("tokenModelBadge");
  if (elModel) {
    elModel.textContent = tokenData.active_model || "Use session model";
  }

  const elSync = document.getElementById("tokenLastSync");
  if (elSync) elSync.textContent = tokenData.is_live && tokenData.last_sync ? `Synced ${tokenData.last_sync}` : 'Quota unavailable';

  if (tokenData.account) {
    renderAccountUI(tokenData.account);
  }
}

// ─── Segmented Navigation Switcher ───────────────────────────

function switchViewTab(tabId) {
  const tabBtns = document.querySelectorAll(".view-tab-btn");
  tabBtns.forEach((btn) => {
    const isTarget = btn.dataset.tab === tabId;
    btn.classList.toggle("active", isTarget);
    btn.setAttribute("aria-selected", isTarget ? "true" : "false");
    btn.tabIndex = isTarget ? 0 : -1;
  });

  const tabContents = {
    "tab-chat": document.getElementById("tabContentChat"),
    "tab-changes": document.getElementById("tabContentChanges"),
    "tab-token": document.getElementById("tabContentToken"),
    "tab-workspace": document.getElementById("tabContentWorkspace"),
    "tab-connect": document.getElementById("tabContentConnect"),
  };

  Object.entries(tabContents).forEach(([id, elem]) => {
    if (!elem) return;
    if (id === tabId) {
      elem.classList.remove("hidden");
      elem.classList.add("active");
    } else {
      elem.classList.add("hidden");
      elem.classList.remove("active");
    }
  });

  if (tabId === "tab-changes") {
    if (state.changes) {
      renderChangesUI(state.changes);
    }
    fetchChanges();
  }

  if (tabId === "tab-token") {
    fetchTokenQuota();
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ─── Quota Information Modal Sheet ───────────────────────────

function showQuotaModal(modelType) {
  const modal = document.getElementById("quotaSheetBackdrop");
  const title = document.getElementById("quotaSheetTitle");
  const desc = document.getElementById("quotaSheetDesc");
  const body = document.getElementById("quotaSheetBody");
  if (!modal || !body) return;

  const key = { gemini: "gemini_models", claude: "claude_gpt_models", argon: "argon_models" }[modelType];
  const quota = state.tokenQuota?.models_quota?.[key] || {};
  if (title) title.textContent = quota.title || "Model quota";
  if (desc) desc.textContent = quota.description || "Limits reported by your connected Antigravity account.";
  body.innerHTML = ["weekly", "five_hour"].filter(period => quota[period]?.available).map(period => `
    <div class="quota-info-card">
      <div class="quota-info-title">${period === 'weekly' ? 'Weekly limit' : 'Five-hour limit'}</div>
      <div class="quota-info-desc">${escapeHtml(quota[period].refresh_text || 'Not reported by Antigravity.')}</div>
    </div>`).join("") || '<p class="quota-info-desc">Quota details are unavailable. Open Antigravity on the laptop to sync.</p>';

  modal.classList.remove("hidden");
}

function closeQuotaSheet(event) {
  if (event && event.target !== event.currentTarget && event.currentTarget.id !== "btnCloseQuotaSheet") {
    return;
  }
  const modal = document.getElementById("quotaSheetBackdrop");
  if (modal) modal.classList.add("hidden");
}


async function fetchTokenQuota() {
  const res = await safeFetchJson("/api/tokens");
  if (res.ok && res.data) {
    updateTokenQuotaUI(res.data);
    return true;
  }
  return false;
}

// ─── Account Management & Google Antigravity IDE Integration ──

async function fetchAccount() {
  try {
    const res = await safeFetchJson("/api/account");
    if (res.ok && res.data && res.data.account) {
      state.account = res.data.account;
      renderAccountUI(state.account);
      if (res.data.token_quota) {
        updateTokenQuotaUI(res.data.token_quota);
      }
      return true;
    }
  } catch (err) {
    console.debug("Could not fetch account:", err);
  }
  return false;
}

function renderAccountUI(acc) {
  if (!acc) return;
  state.account = acc;

  const isConnected = !!acc.connected && !!acc.is_logged_in;
  const displayName = acc.name || "Antigravity account";
  const displayEmail = acc.email || "Not signed in";
  const displayPlan = acc.plan || "Plan unknown";
  const initial = (acc.name || acc.email || "U").charAt(0).toUpperCase();

  // 1. Top Nav Capsule
  const navName = document.getElementById("navAccountName");
  const navPlan = document.getElementById("navAccountPlan");
  const navDot = document.getElementById("navAccountDot");
  const navAvatar = document.getElementById("navAccountAvatar");
  const navInitial = document.getElementById("navAccountInitial");

  if (navName) navName.textContent = acc.name ? acc.name.split(" ")[0] : (acc.email ? acc.email.split("@")[0] : "Account");
  if (navPlan) navPlan.textContent = isConnected ? displayPlan : "Not connected";
  if (navDot) navDot.className = `nav-account-dot ${isConnected ? "online" : "offline"}`;

  if (navAvatar && navInitial) {
    if (acc.avatar_url) {
      navAvatar.src = acc.avatar_url;
      navAvatar.classList.remove("hidden");
      navInitial.classList.add("hidden");
    } else {
      navAvatar.classList.add("hidden");
      navInitial.textContent = initial;
      navInitial.classList.remove("hidden");
    }
  }

  // 2. Quota Card Account Banner
  const qBannerName = document.getElementById("quotaBannerName");
  const qBannerEmail = document.getElementById("quotaBannerEmail");
  const qBannerPlan = document.getElementById("quotaBannerPlan");
  const qBannerDot = document.getElementById("quotaBannerDot");
  const qBannerAvatar = document.getElementById("quotaBannerAvatar");
  const qBannerInitial = document.getElementById("quotaBannerInitial");

  if (qBannerName) qBannerName.textContent = displayName;
  if (qBannerEmail) qBannerEmail.textContent = displayEmail;
  if (qBannerPlan) qBannerPlan.textContent = displayPlan;
  if (qBannerDot) qBannerDot.className = `quota-banner-dot ${isConnected ? "online" : "offline"}`;

  if (qBannerAvatar && qBannerInitial) {
    if (acc.avatar_url) {
      qBannerAvatar.src = acc.avatar_url;
      qBannerAvatar.classList.remove("hidden");
      qBannerInitial.classList.add("hidden");
    } else {
      qBannerAvatar.classList.add("hidden");
      qBannerInitial.textContent = initial;
      qBannerInitial.classList.remove("hidden");
    }
  }

  // 3. Modal Sheet Profile Box
  const modalName = document.getElementById("modalAccountName");
  const modalEmail = document.getElementById("modalAccountEmail");
  const modalTier = document.getElementById("modalAccountTierBadge");
  const modalIde = document.getElementById("modalAccountIdeStatus");
  const modalDot = document.getElementById("modalAccountDot");
  const modalAvatar = document.getElementById("modalAccountAvatar");
  const modalInitial = document.getElementById("modalAccountInitial");

  if (modalName) modalName.textContent = displayName;
  if (modalEmail) modalEmail.textContent = displayEmail;
  if (modalTier) modalTier.textContent = displayPlan;
  if (modalIde) {
    modalIde.textContent = isConnected
      ? `Connected to Antigravity (Port ${acc.port || "Active"})`
      : "Not connected to Antigravity";
  }
  if (modalDot) modalDot.className = `account-status-dot ${isConnected ? "online" : "offline"}`;

  if (modalAvatar && modalInitial) {
    if (acc.avatar_url) {
      modalAvatar.src = acc.avatar_url;
      modalAvatar.classList.remove("hidden");
      modalInitial.classList.add("hidden");
    } else {
      modalAvatar.classList.add("hidden");
      modalInitial.textContent = initial;
      modalInitial.classList.remove("hidden");
    }
  }

  // 4. Update Quick Quota Strip inside Modal
  const mq = state.tokenQuota?.models_quota || {};
  const gWeeklyPct = mq.gemini_models?.weekly?.remaining_pct;
  const cWeeklyPct = mq.claude_gpt_models?.weekly?.remaining_pct;
  const gWeeklyEl = document.getElementById("geminiWeeklyPct") || document.getElementById("stripGeminiWeekly");
  const cWeeklyEl = document.getElementById("claudeWeeklyPct") || document.getElementById("stripClaudeWeekly");
  const mGVal = document.getElementById("modalGeminiWeeklyVal");
  const mCVal = document.getElementById("modalClaudeWeeklyVal");
  if (mGVal) mGVal.textContent = `${Number.isFinite(gWeeklyPct) ? `${gWeeklyPct}%` : (gWeeklyEl?.textContent || "--")} Gemini`;
  if (mCVal) mCVal.textContent = `${Number.isFinite(cWeeklyPct) ? `${cWeeklyPct}%` : (cWeeklyEl?.textContent || "--")} Claude`;
}

function openAccountModal() {
  const sheet = document.getElementById("accountModalSheet");
  if (!sheet) return;
  sheet.classList.remove("closing");
  sheet.classList.remove("hidden");
  fetchAccount();
  fetchTokenQuota();
}

function closeAccountModal() {
  const sheet = document.getElementById("accountModalSheet");
  if (!sheet || sheet.classList.contains("hidden")) return;
  sheet.classList.add("closing");
  setTimeout(() => {
    sheet.classList.add("hidden");
    sheet.classList.remove("closing");
  }, 220);
}

function handleAccountModalBackdrop(event) {
  if (event && event.target && event.target.id === "accountModalSheet") {
    closeAccountModal();
  }
}

async function openAntigravityOnLaptop() {
  try {
    const res = await safeFetchJson("/api/antigravity/launch", { method: "POST" });
    if (!res.ok) {
      showToast(res.error || "Could not open Antigravity on the laptop.", "error");
      return false;
    }
    const msg = res.data?.message || "Antigravity opened on the laptop.";
    showToast(msg, "success");
    addLogEvent(msg);
    return true;
  } catch (err) {
    showToast(`Could not open Antigravity on the laptop: ${err.message}`, "error");
    return false;
  }
}

async function syncAccountTokenQuota() {
  const btn = document.getElementById("btnSyncAccountQuota");
  if (btn) btn.classList.add("rotating");
  showToast("Syncing quota from Antigravity...", "info");
  const [quotaOk, accountOk] = await Promise.all([fetchTokenQuota(), fetchAccount()]);
  setTimeout(() => {
    if (btn) btn.classList.remove("rotating");
    if (quotaOk || accountOk) {
      showToast("Quota synced.", "success");
    } else {
      showToast("Could not sync quota from Antigravity.", "error");
    }
  }, 350);
}

// ─── File Changes Review & Diff Engine (Apple Physical Design) ────

function changesWorkspacePath() {
  const conversation = state.conversations.find(conv => conv.id === state.activeConversationId);
  return conversation?.workspace_path || state.currentWorkspace?.path || "";
}

async function fetchChanges() {
  const workspace = changesWorkspacePath();
  const conversationId = state.activeConversationId;
  const requestSeq = state.changesRequestSeq = (state.changesRequestSeq || 0) + 1;
  const res = await safeFetchJson(`/api/changes${workspace ? `?workspace_path=${encodeURIComponent(workspace)}` : ""}`);
  if (requestSeq !== state.changesRequestSeq || conversationId !== state.activeConversationId ||
      workspace !== changesWorkspacePath()) return;
  renderChangesUI(res.ok && res.data ? res.data : {
    workspace, availability: "unavailable", message: res.error || "Could not read changes from the laptop.",
  });
}

function renderChangesUI(changesData) {
  if (!changesData) return;
  state.changes = changesData;
  // A rendered update supersedes any older HTTP snapshot still in flight.
  state.changesRequestSeq = (state.changesRequestSeq || 0) + 1;
  const unavailable = changesData.availability === "unavailable";
  const nonGit = changesData.is_git === false;
  const summary = unavailable ? "Changes unavailable" : nonGit ? "Outside a Git repository" : "";
  const files = changesData.files || [];
  const totalChanged = changesData.total_changed || files.length || 0;
  const insertions = changesData.total_insertions || 0;
  const deletions = changesData.total_deletions || 0;
  const workspaceName = changesData.workspace_name || (changesData.workspace ? changesData.workspace.split(/[\\/]/).pop() : "Current project");

  // 1. Update Badges & Counters
  const navBadge = document.getElementById("navChangesBadge");
  if (navBadge) {
    navBadge.textContent = String(totalChanged);
    navBadge.classList.toggle("hidden", totalChanged === 0);
  }

  const toolbarCount = document.getElementById("toolbarChangesCount");
  if (toolbarCount) {
    toolbarCount.textContent = String(totalChanged);
    toolbarCount.classList.toggle("hidden", totalChanged === 0);
  }

  // 2. Update Alert Banner in Chat Tab
  const alertBanner = document.getElementById("changesAlertBanner");
  const alertText = document.getElementById("changesAlertText");
  if (alertBanner) {
    alertBanner.classList.toggle("hidden", totalChanged === 0);
    if (alertText) {
      alertText.textContent = `${totalChanged} ${totalChanged === 1 ? "changed file" : "changed files"}`;
    }
  }

  // 3. Update Summary Bar in Changes Tab
  const summaryFiles = document.getElementById("changesSummaryFiles");
  if (summaryFiles) summaryFiles.textContent = summary || `${totalChanged} ${totalChanged === 1 ? "changed file" : "changed files"}`;

  const summaryAdd = document.getElementById("changesSummaryInsertions");
  if (summaryAdd) summaryAdd.textContent = summary ? "" : `+${insertions}`;

  const summaryDel = document.getElementById("changesSummaryDeletions");
  if (summaryDel) summaryDel.textContent = summary ? "" : `-${deletions}`;

  const summaryWs = document.getElementById("changesSummaryWorkspace");
  if (summaryWs) summaryWs.textContent = workspaceName;

  // 4. Update Summary Bar in Bottom Sheet Modal
  const modalSummaryFiles = document.getElementById("modalChangesSummaryFiles");
  if (modalSummaryFiles) modalSummaryFiles.textContent = summary || `${totalChanged} ${totalChanged === 1 ? "file" : "files"}`;

  const modalSummaryAdd = document.getElementById("modalChangesSummaryAdd");
  if (modalSummaryAdd) modalSummaryAdd.textContent = summary ? "" : `+${insertions}`;

  const modalSummaryDel = document.getElementById("modalChangesSummaryDel");
  if (modalSummaryDel) modalSummaryDel.textContent = summary ? "" : `-${deletions}`;

  // 5. Reject All & Accept All Buttons
  const btnRejectAllTab = document.getElementById("btnRejectAllChanges");
  if (btnRejectAllTab) btnRejectAllTab.classList.toggle("hidden", totalChanged === 0);

  const btnRejectAllModal = document.getElementById("btnModalRejectAll");
  if (btnRejectAllModal) btnRejectAllModal.classList.toggle("hidden", totalChanged === 0);

  const btnAcceptAllTab = document.getElementById("btnAcceptAllChanges");
  if (btnAcceptAllTab) btnAcceptAllTab.classList.toggle("hidden", totalChanged === 0);

  const btnAcceptAllCard = document.getElementById("btnAcceptAllCard");
  if (btnAcceptAllCard) btnAcceptAllCard.classList.toggle("hidden", totalChanged === 0);

  const btnAcceptAllModal = document.getElementById("btnModalAcceptAll");
  if (btnAcceptAllModal) btnAcceptAllModal.classList.toggle("hidden", totalChanged === 0);

  // 6. Render File Cards (in Tab and Modal)
  const tabList = document.getElementById("changesFilesList");
  const modalList = document.getElementById("changesModalFilesList");

  const buildCardsHtml = (prefix = "tab") => {
    if (unavailable || nonGit) {
      const detail = unavailable ? changesData.message || "Could not read Git status." : "Choose a Git project to review its changes.";
      return `<div class="changes-empty-state"><span class="empty-title">${summary}</span>
        <span class="empty-desc">${escapeHtml(detail)}</span>
        ${unavailable ? '<button type="button" class="btn-toggle-diff" onclick="fetchChanges()">Retry</button>' : ""}</div>`;
    }
    if (totalChanged === 0) {
      return `
        <div class="changes-empty-state">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span class="empty-title">No changed files</span>
          <span class="empty-desc">There are no pending file changes in this project.</span>
        </div>
      `;
    }

    return files.map((f, idx) => {
      const statusClass = (f.status || "modified").toLowerCase();
      const statusLabel = (f.status || "modified").toUpperCase();
      const fileLabel = f.original_path ? `${f.original_path} → ${f.path}` : f.path;
      const diffId = `${prefix}-diff-box-${idx}`;
      const diffLines = f.diff ? f.diff.split("\n") : [];

      let formattedDiffLines = "";
      if (diffLines.length > 0) {
        formattedDiffLines = diffLines.map(line => {
          let lineClass = "";
          if (line.startsWith("+") && !line.startsWith("+++")) {
            lineClass = "add";
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            lineClass = "del";
          } else if (line.startsWith("@@")) {
            lineClass = "info";
          }
          return `<span class="diff-line ${lineClass}">${escapeHtml(line)}</span>`;
        }).join("");
      } else {
        formattedDiffLines = `<span class="diff-line info">// New file or no text diff available</span>`;
      }

      return `
        <div class="change-file-card" id="${prefix}-changeCard-${idx}">
          <div class="change-file-header">
            <div class="change-file-top">
              <span class="change-status-pill ${statusClass}">${escapeHtml(statusLabel)}</span>
              <span class="change-file-name" title="${escapeHtml(fileLabel)}">${escapeHtml(fileLabel)}</span>
            </div>
            <div class="change-file-bottom">
              <div class="change-file-stats">
                <span class="changes-stat-add">+${f.insertions || 0}</span>
                <span class="changes-stat-del">-${f.deletions || 0}</span>
              </div>
              <div class="change-file-btns">
                <button type="button" class="btn-toggle-diff" onclick="toggleFileDiff('${diffId}', this)">Diff</button>
                <button type="button" class="btn-accept-file" onclick="acceptFileChange('${escapeQuotes(f.path)}')">Accept</button>
                <button type="button" class="btn-reject-file" onclick="rejectFileChange('${escapeQuotes(f.path)}', '${escapeQuotes(f.status || "")}')">Revert</button>
              </div>
            </div>
          </div>
          <div class="diff-container hidden" id="${diffId}">
            <div class="diff-box">
              ${formattedDiffLines}
              ${f.diff_truncated ? '<span class="diff-line info">Preview truncated. Totals include the full diff.</span>' : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");
  };

  if (tabList) tabList.innerHTML = buildCardsHtml("tab");
  if (modalList) modalList.innerHTML = buildCardsHtml("modal");
}

function toggleFileDiff(diffId, btn) {
  const diffEl = document.getElementById(diffId);
  if (!diffEl) return;
  const isHidden = diffEl.classList.toggle("hidden");
  if (btn) {
    btn.textContent = isHidden ? "Diff" : "Close";
  }
}

function openChangesModal() {
  const modal = document.getElementById("changesReviewModal");
  if (modal) {
    modal.classList.remove("hidden");
    fetchChanges();
  }
}

function closeChangesModal() {
  const modal = document.getElementById("changesReviewModal");
  if (modal) {
    modal.classList.add("hidden");
  }
}

function handleChangesModalBackdropClick(e) {
  if (e && e.target && e.target.id === "changesReviewModal") {
    closeChangesModal();
  }
}

async function applyGitChangeAction({ url, filePath, scope = "file", confirmMsg, pendingToast, defaultSuccessToast, defaultErrorToast, logMessage }) {
  const reviewedChanges = state.changes;
  const workspace = reviewedChanges?.workspace;
  if (typeof workspace !== "string" || !workspace.trim() || !reviewedChanges.revision) {
    showToast("Refresh Changes before reviewing this project.", "error");
    return;
  }
  if (typeof window !== "undefined" && typeof window.confirm === "function" &&
      !window.confirm(`${confirmMsg}\n\nProject: ${workspace}`)) {
    return;
  }

  const requestBody = scope === "all"
    ? { scope: "all", workspace_path: workspace }
    : { file_path: filePath, scope: "file", workspace_path: workspace };

  requestBody.revision = reviewedChanges.revision;

  try {
    showToast(pendingToast, "info");
    const res = await safeFetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (res.ok) {
      showToast(res.data?.message || defaultSuccessToast, "success");
      addLogEvent(logMessage);
      const nextChanges = res.data?.changes || (res.data && Array.isArray(res.data.files) ? res.data : null);
      const selectedWorkspace = changesWorkspacePath();
      if (state.changes === reviewedChanges && (!selectedWorkspace || workspace === selectedWorkspace)) {
        if (nextChanges) {
          renderChangesUI(nextChanges);
        } else {
          await fetchChanges();
        }
      }
    } else {
      showToast(res.error || defaultErrorToast, "error");
      if (["stale_review", "review_required", "git_unavailable"].includes(res.code) && state.changes === reviewedChanges) await fetchChanges();
    }
  } catch (err) {
    showToast(`${defaultErrorToast}: ${err.message}`, "error");
  }
}

async function rejectFileChange(filePath, fileStatus = "") {
  if (!filePath) return;
  const matched = (state.changes?.files || []).find((f) => f && f.path === filePath);
  const status = String(fileStatus || matched?.status || "").toLowerCase();
  const isUntracked = status === "untracked";
  let confirmMsg = `Revert changes to:\n${filePath}\n\nThe file will be restored to HEAD.`;
  if (isUntracked) {
    confirmMsg = `Delete untracked file:\n${filePath}\n\nThis new untracked file will be permanently removed from disk.`;
  } else if (status === "added" || status === "copied") {
    confirmMsg = `Revert new file:\n${filePath}\n\nThis file will be removed from the working tree and staging area.`;
  } else if (status === "renamed" && matched?.original_path) {
    confirmMsg = `Revert rename:\n${matched.original_path} → ${filePath}\n\nThe original file will be restored to HEAD and the renamed file removed.`;
  }
  await applyGitChangeAction({
    url: "/api/changes/reject",
    filePath,
    scope: "file",
    confirmMsg,
    pendingToast: isUntracked ? `Deleting untracked file ${filePath}...` : `Reverting changes to ${filePath}...`,
    defaultSuccessToast: isUntracked ? `Untracked file ${filePath} deleted.` : `Changes to ${filePath} reverted.`,
    defaultErrorToast: isUntracked ? "Could not delete untracked file." : "Could not revert file changes.",
    logMessage: isUntracked ? `Untracked file '${filePath}' deleted.` : `Changes to '${filePath}' reverted.`,
  });
}

async function acceptFileChange(filePath) {
  if (!filePath) return;
  const change = state.changes?.files?.find(f => f.path === filePath);
  const label = change?.status === "renamed" && change.original_path ? `${change.original_path} → ${filePath}` : filePath;
  await applyGitChangeAction({
    url: "/api/changes/accept",
    filePath,
    scope: "file",
    confirmMsg: `Accept changes to:\n${label}\n\nThe file changes will be committed to Git.`,
    pendingToast: `Accepting changes to ${filePath}...`,
    defaultSuccessToast: `Changes to ${filePath} accepted.`,
    defaultErrorToast: "Could not accept file changes.",
    logMessage: `Changes to '${filePath}' committed to Git.`,
  });
}

async function confirmAcceptAllChanges() {
  await applyGitChangeAction({
    url: "/api/changes/accept",
    scope: "all",
    confirmMsg: "Accept all changes in this project?\n\nAll file changes will be committed to Git.",
    pendingToast: "Committing all file changes...",
    defaultSuccessToast: "All file changes accepted.",
    defaultErrorToast: "Could not accept all changes.",
    logMessage: "All project changes accepted.",
  });
}

async function confirmRejectAllChanges() {
  await applyGitChangeAction({
    url: "/api/changes/reject",
    scope: "all",
    confirmMsg: "Revert all tracked changes in this project?\n\nTracked files will be restored to HEAD. Newly staged files will be removed from the working tree and staging area. Untracked new files are preserved. This cannot be undone.",
    pendingToast: "Reverting tracked project changes...",
    defaultSuccessToast: "Tracked project changes reverted (untracked files preserved).",
    defaultErrorToast: "Could not revert tracked changes.",
    logMessage: "Tracked project changes reverted (untracked files preserved).",
  });
}


// ─── Apple Action Sheet: Model Selection ─────────────────────

function openModelSheet() {
  const sheet = document.getElementById("modelSheetBackdrop");
  if (sheet) {
    updateModelSheetSelectionUI();
    sheet.classList.remove("hidden");
    fetchModels(true);
  }
}

function closeModelSheet() {
  const sheet = document.getElementById("modelSheetBackdrop");
  if (sheet) {
    sheet.classList.add("hidden");
  }
}

function modelCatalogKey() {
  return JSON.stringify([state.executionTarget || "auto", state.activeConversationId || null]);
}

function currentModelSelection() {
  if (!state.modelCatalogConnected || state.modelCatalogKey !== modelCatalogKey() || state.selectedModelTarget !== state.connectedTarget) return null;
  return state.availableModels.find(model => model.id === state.selectedModel && !model.disabled) || null;
}

function taskModelOptions(offline = false) {
  if (offline) {
    return {model:state.selectedModel || null, performance:state.selectedModel ? state.selectedPerformance : "Default",
      execution_target:(state.modelCatalogKey === modelCatalogKey() && state.modelCatalogBoundTarget) || (state.selectedModel && state.selectedModelTarget) || state.executionTarget || "auto"};

  }
  if (!state.modelCatalogConnected || state.modelCatalogKey !== modelCatalogKey()) {
    throw new Error("Models unavailable. Open the model picker to reconnect before sending.");
  }
  if (!state.availableModels.some(model => !model.disabled)) {
    throw new Error("No models are available for this account. Check Antigravity on the laptop.");
  }
  if (state.selectedModel && !currentModelSelection()) {
    throw new Error("Select a model again before sending. Your saved choice is unavailable on this connection.");
  }
  return {
    model: state.selectedModel || null,
    performance: state.selectedModel ? modelVariant(currentModelSelection()).performance : "Default",
    execution_target: state.modelCatalogBoundTarget || (state.selectedModel ? state.selectedModelTarget : state.executionTarget) || "auto",
  };
}

function fetchModels(refresh = false) {
  const key = modelCatalogKey();
  if (state.modelCatalogRequest?.key === key) {
    const pending = state.modelCatalogRequest;
    return refresh && !pending.refresh
      ? pending.promise.then(() => key === modelCatalogKey() ? fetchModels(true) : undefined)
      : pending.promise;
  }
  state.modelCatalogLoading = true;
  if (state.modelCatalogKey !== key) {
    state.modelCatalogKey = key;
    state.availableModels = [];
    state.modelCatalogConnected = false;
    state.connectedTarget = null;
    state.modelCatalogBoundTarget = null;
    state.modelCatalogMessage = "Loading models for this conversation...";
    updateModelSheetSelectionUI();
    updateExecutionTargetUI();
  }
  // A new context starts immediately; a slow response from another chat cannot replace it.
  const request = { key, refresh };
  state.modelCatalogRequest = request;
  request.promise = (async () => {
    try {
      const conversation = state.activeConversationId ? `&conversation_id=${encodeURIComponent(state.activeConversationId)}` : "";
      const result = await safeFetchJson(`/api/models?target=${encodeURIComponent(state.executionTarget || 'auto')}${conversation}&refresh=${refresh}`);
      if (state.modelCatalogRequest !== request || key !== modelCatalogKey()) return;
      const data = result.data;
      const validTarget = ["ide", "cli"].includes(data?.target);
      const valid = result.ok && data?.connected === true && validTarget && Array.isArray(data.models) && data.models.every(model =>
        model && typeof model.id === "string" && model.id.trim().length > 0 && typeof model.name === "string" && model.name.trim().length > 0 && typeof model.disabled === "boolean")
        && new Set(data.models.map(model => model.id)).size === data.models.length;
      state.modelCatalogConnected = !!valid;
      state.availableModels = valid ? data.models : [];
      state.connectedTarget = valid ? data.target : null;
      state.modelCatalogBoundTarget = result.ok && data?.session_bound === true && validTarget ? data.target : null;
      const source = data?.target === "cli" ? "AGY CLI" : "Antigravity App";
      state.modelCatalogMessage = valid ? `Connected to ${source}. Models update automatically.` : (data?.message || result.error || "Models unavailable. Open Antigravity on the laptop.");
      if (valid && !state.availableModels.some(model => !model.disabled)) {
        state.modelCatalogMessage = "No models are available for this account. Check Antigravity on the laptop.";
      }
      updateModelSheetSelectionUI();
      updateExecutionTargetUI();
    } finally {
      if (state.modelCatalogRequest === request) {
        state.modelCatalogLoading = false;
        state.modelCatalogRequest = null;
        if (key !== modelCatalogKey()) fetchModels();
      }
    }
  })();
  return request.promise;
}

function selectModel(modelId) {
  if (modelId && (!state.modelCatalogConnected || state.modelCatalogKey !== modelCatalogKey() || !state.availableModels.some(model => model.id === modelId && !model.disabled))) return;
  state.selectedModel = modelId || null;
  state.selectedModelTarget = modelId ? state.connectedTarget : null;
  state.selectedModelTier = state.selectedModel;
  const selected = state.availableModels.find(model => model.id === state.selectedModel);
  if (selected) state.selectedPerformance = modelVariant(selected).performance;
  if (modelId) {
    localStorage.setItem("antigravity_selected_model", modelId);
    localStorage.setItem("antigravity_selected_model_target", state.selectedModelTarget);
  } else {
    localStorage.removeItem("antigravity_selected_model");
    localStorage.removeItem("antigravity_selected_model_target");
  }
  updateModelSheetSelectionUI();
  closeModelSheet();
}

function modelVariant(model) {
  const match = model.name.match(/^(.*?)\s*\((Low|Medium|High|XHigh|Extra High|Max|Thinking|Fast)\)$/i);
  const suffix = match?.[2].toLowerCase().replace(/\s+/g, '-');
  const exact = suffix && model.id.toLowerCase().endsWith(`-${suffix}`);
  if (typeof model.family_name === "string" && typeof model.performance === "string") {
    return { name: model.family_name, performance: model.performance, familyKey: model.family_id || (exact ? model.id.slice(0, -suffix.length - 1) : model.family_name) };
  }
  return { name: exact ? match[1].trim() : model.name, performance: exact ? match[2] : "Default", familyKey: exact ? model.id.slice(0, -suffix.length - 1) : model.id };
}

function getModelFamilies(models) {
  const families = new Map();
  for (const model of models) {
    const variant = modelVariant(model);
    const key = JSON.stringify([model.category || "", variant.name, variant.familyKey]);
    if (!families.has(key)) families.set(key, { name: variant.name, variants: [] });
    families.get(key).variants.push({ ...model, performance: variant.performance });
  }
  // Ambiguous performance metadata must not hide another native model ID.
  return [...families.values()].flatMap(family => new Set(family.variants.map(model => model.performance)).size === family.variants.length
    ? [family] : family.variants.map(model => ({ name: model.name, variants: [model] })));
}

function updateModelSheetSelectionUI() {
  const selected = currentModelSelection();
  const label = document.getElementById("selectedModelLabel");
  if (label) label.textContent = selected ? modelVariant(selected).name : (state.selectedModel ? "Select a model again" : "Use session model");
  const status = document.getElementById("modelCatalogStatus");
  if (status) status.textContent = state.modelCatalogConnected && state.selectedModel && !selected
    ? "Your selected model is unavailable on this connection. Select a model again before sending."
    : state.modelCatalogMessage;
  const options = document.getElementById("modelOptions");
  updatePerformanceUI();
  if (!options) return;
  const focusedId = options.contains(document.activeElement) ? document.activeElement.dataset.model : null;
  const families = getModelFamilies(state.availableModels).map(family => {
    const choice = family.variants.find(variant => variant.id === state.selectedModel && !variant.disabled)
      || family.variants.find(variant => variant.performance === state.selectedPerformance && !variant.disabled)
      || family.variants.find(variant => !variant.disabled)
      || family.variants[0];
    return { ...choice, name: family.name, disabled: family.variants.every(variant => variant.disabled), selected: !!selected && family.variants.some(variant => variant.id === selected.id) };
  });
  const items = [{
    id: "", name: "Use session model", disabled: false, selected: !state.selectedModel,
    description: state.modelCatalogConnected && state.availableModels.some(model => !model.disabled)
      ? "Use the model and performance set in Antigravity." : "Model availability will be checked before sending.",
  }, ...families.map(model => ({
    ...model,
    description: families.filter(other => other.name === model.name).length > 1
      ? [model.category, model.id].filter(Boolean).join(" · ") : model.description,
  }))];
  options.innerHTML = items.map(model => `<button type="button" class="sheet-option-item${model.selected ? ' active' : ''}" data-model="${escapeHtml(model.id)}" aria-pressed="${model.selected}" ${model.disabled ? 'disabled' : ''}>
    <span class="sheet-option-info"><span class="sheet-option-name">${escapeHtml(model.name)}</span>${model.disabled || model.description || model.category ? `<span class="sheet-option-desc">${escapeHtml(model.disabled ? 'Unavailable for this account' : model.description || model.category)}</span>` : ''}</span>
  </button>`).join("");
  options.querySelectorAll("[data-model]").forEach(button => {
    button.onclick = () => selectModel(button.dataset.model);
    if (focusedId !== null && button.dataset.model === focusedId && !button.disabled) button.focus();
  });
}

// ─── Apple Segmented Execution Target Controller ─────────────

function selectExecutionTarget(target) {
  if (!["auto", "ide", "cli"].includes(target) || (state.modelCatalogKey === modelCatalogKey() && state.modelCatalogBoundTarget)) return;
  state.executionTarget = target;
  localStorage.setItem("antigravity_execution_target", target);
  updateExecutionTargetUI();
  fetchModels();
}

function updateExecutionTargetUI() {
  const bound = state.modelCatalogKey === modelCatalogKey() ? state.modelCatalogBoundTarget : null;
  const target = bound || state.executionTarget || "auto";
  const hint = document.getElementById("executionTargetHint");
  if (hint) {
    hint.classList.toggle("hidden", !bound);
    hint.textContent = bound ? "This conversation stays on its original connection. Start a new conversation to change it." : "";
  }
  document.querySelectorAll("#executionTargetSelector .segment-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.target === target);
    btn.setAttribute("aria-pressed", String(btn.dataset.target === target));
    btn.disabled = !!bound && btn.dataset.target !== bound;
    btn.title = bound ? "This conversation stays on its original connection. Start a new conversation to change it." : (btn.dataset.target === "auto" ? "Use the available AGY connection" : `Use ${btn.dataset.target === "cli" ? "AGY CLI" : "the Antigravity app"}`);
  });
}

// ─── Apple Segmented Performance Tier Controller ─────────────

function selectPerformance(perf, modelId = null) {
  const family = getModelFamilies(state.availableModels).find(group => group.variants.some(variant => variant.id === state.selectedModel));
  const matches = family?.variants.filter(model => model.performance === perf && !model.disabled && (!modelId || model.id === modelId)) || [];
  const variant = matches.length === 1 ? matches[0] : null;
  if (!variant) return;
  localStorage.setItem("antigravity_performance", perf);
  selectModel(variant.id);
}

function updatePerformanceUI() {
  const control = document.getElementById("mainPerformanceSelector");
  if (!control) return;
  const family = getModelFamilies(state.availableModels).find(group => group.variants.some(variant => variant.id === state.selectedModel));
  const variants = state.modelCatalogKey === modelCatalogKey() && state.selectedModelTarget === state.connectedTarget ? family?.variants.slice() || [] : [];
  const rank = ["Low", "Fast", "Medium", "High", "XHigh", "Extra High", "Max", "Thinking", "Default"];
  variants.sort((a, b) => rank.indexOf(a.performance) - rank.indexOf(b.performance));
  control.innerHTML = variants.length ? variants.map(variant => `<button type="button" class="segment-btn${variant.id === state.selectedModel ? ' active' : ''}" data-perf="${escapeHtml(variant.performance)}" data-model="${escapeHtml(variant.id)}" aria-pressed="${variant.id === state.selectedModel}" ${variant.disabled ? 'disabled' : ''}>${escapeHtml(variant.performance)}</button>`).join("") : `<span class="performance-hint">${state.selectedModel ? 'Select an available model' : state.modelCatalogConnected ? 'Use session performance' : 'Waiting for Antigravity'}</span>`;
  control.querySelectorAll("[data-perf]").forEach(button => { button.onclick = () => selectPerformance(button.dataset.perf, button.dataset.model); });
}

// ─── Skills Management ────────────────────────────────────────

function renderSkillsCatalog(skills) {
  state.allSkills = skills;
  const catalog = document.getElementById("skillsCatalog");
  if (!catalog) return;

  catalog.innerHTML = "";

  skills.forEach((skill) => {
    const item = document.createElement("div");
    item.className = "skill-item";
    item.dataset.skillId = skill.id;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "skill-checkbox";
    checkbox.checked = state.selectedSkills.has(skill.id);

    // Prevent double event bubbling on the checkbox
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      toggleSkill(skill.id, checkbox.checked);
      item.classList.toggle("selected", checkbox.checked);
    });

    const meta = document.createElement("div");
    meta.className = "skill-meta";

    const title = document.createElement("span");
    title.className = "skill-name";
    title.textContent = skill.name;

    const desc = document.createElement("span");
    desc.className = "skill-desc";
    desc.textContent = skill.description.slice(0, 120);

    meta.appendChild(title);
    meta.appendChild(desc);

    item.appendChild(checkbox);
    item.appendChild(meta);

    item.onclick = (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
        toggleSkill(skill.id, checkbox.checked);
        item.classList.toggle("selected", checkbox.checked);
      }
    };

    catalog.appendChild(item);
  });
}

function toggleSkill(skillId, isSelected) {
  if (isSelected) {
    state.selectedSkills.add(skillId);
  } else {
    state.selectedSkills.delete(skillId);
  }
  updateSelectedCountUI();
  renderSelectedSkillsChips();
  if (state.latestRecommendations) {
    renderRecommendedChips(state.latestRecommendations);
  }
}

function updateSelectedCountUI() {
  const badge = document.getElementById("activeSkillsCount");
  if (badge) {
    badge.textContent = `${state.selectedSkills.size} ${state.selectedSkills.size === 1 ? "skill" : "skills"} selected`;
  }
}

function renderSelectedSkillsChips() {
  const container = document.getElementById("selectedSkillsContainer");
  const chipsWrapper = document.getElementById("selectedSkillsChips");
  const numElem = document.getElementById("selectedSkillsNum");
  if (!container || !chipsWrapper) return;

  const count = state.selectedSkills.size;
  if (numElem) numElem.textContent = String(count);

  if (count === 0) {
    container.classList.add("hidden");
    chipsWrapper.innerHTML = "";
    return;
  }

  container.classList.remove("hidden");
  chipsWrapper.innerHTML = Array.from(state.selectedSkills).map((skillId) => {
    const sObj = (state.allSkills || []).find((s) => s.id === skillId);
    const displayName = sObj ? sObj.name : skillId;
    return `
      <div class="selected-skill-chip" data-skill-id="${escapeQuotes(skillId)}">
        <span>${escapeHtml(displayName)}</span>
        <button type="button" class="btn-chip-remove" title="Remove ${escapeHtml(displayName)}" onclick="removeSelectedSkill('${escapeQuotes(skillId)}')">×</button>
      </div>
    `;
  }).join("");
}

function removeSelectedSkill(skillId) {
  state.selectedSkills.delete(skillId);
  updateSelectedCountUI();
  renderSelectedSkillsChips();

  const item = document.querySelector(`.skill-item[data-skill-id="${skillId}"]`);
  if (item) {
    const cb = item.querySelector(".skill-checkbox");
    if (cb) cb.checked = false;
    item.classList.remove("selected");
  }

  if (state.latestRecommendations) {
    renderRecommendedChips(state.latestRecommendations);
  }
}

function clearAllSelectedSkills() {
  state.selectedSkills.clear();
  updateSelectedCountUI();
  renderSelectedSkillsChips();

  document.querySelectorAll(".skill-item").forEach((item) => {
    item.classList.remove("selected");
    const cb = item.querySelector(".skill-checkbox");
    if (cb) cb.checked = false;
  });

  if (state.latestRecommendations) {
    renderRecommendedChips(state.latestRecommendations);
  }
}

function filterSkills(query) {
  const q = query.toLowerCase().trim();
  const items = document.querySelectorAll(".skill-item");

  items.forEach((el) => {
    const text = el.textContent.toLowerCase();
    el.style.display = text.includes(q) ? "flex" : "none";
  });
}

// ─── AI Skill Recommender ─────────────────────────────────────

async function recommendSkillsForText(prompt, autoSelect = false) {
  if (!prompt || prompt.length < 5) return;
  try {
    const res = await safeFetchJson("/api/skills/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt }),
    });

    if (res.ok && res.data && res.data.recommended_skills) {
      state.latestRecommendations = res.data.recommended_skills;
      renderRecommendedChips(res.data.recommended_skills);
      if (autoSelect) {
        res.data.recommended_skills.forEach(rec => {
          if (rec.score >= 8 && !state.selectedSkills.has(rec.skill_id)) {
            toggleSkill(rec.skill_id, true);
            const catalogItem = document.querySelector(`.skill-item[data-skill-id="${rec.skill_id}"]`);
            if (catalogItem) {
              const cb = catalogItem.querySelector(".skill-checkbox");
              if (cb) cb.checked = true;
              catalogItem.classList.add("selected");
            }
          }
        });
      }
    }
  } catch (e) {
    console.debug("Could not suggest skills:", e);
  }
}

async function recommendSkillsForCurrentTask() {
  const promptInput = document.getElementById("taskInput");
  const prompt = promptInput ? promptInput.value.trim() : "";

  if (!prompt) {
    showToast("Enter a message before requesting skill suggestions.", "info");
    return;
  }

  const btn = document.getElementById("btnRecommendSkills");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Analyzing...";
  }

  try {
    await recommendSkillsForText(prompt, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
        </svg>
        <span>Suggest skills</span>
      `;
    }
  }
}

function renderRecommendedChips(recommendations) {
  const container = document.getElementById("recChipsContainer");
  if (!container) return;

  container.innerHTML = "";

  const recList = recommendations || state.latestRecommendations;
  if (!recList || recList.length === 0) {
    container.classList.add("hidden");
    return;
  }

  // Filter out any skills that are ALREADY selected (non-redundant-ui-ux)
  const unselectedRecs = recList.filter(rec => !state.selectedSkills.has(rec.skill_id));

  if (unselectedRecs.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");

  unselectedRecs.forEach((rec) => {
    const chip = document.createElement("button");
    chip.className = "rec-chip";
    chip.textContent = `+ ${rec.name}`;
    chip.title = `${rec.reason} — ${rec.description}`;

    chip.onclick = () => {
      toggleSkill(rec.skill_id, true);

      const catalogItem = document.querySelector(`.skill-item[data-skill-id="${rec.skill_id}"]`);
      if (catalogItem) {
        const cb = catalogItem.querySelector(".skill-checkbox");
        if (cb) cb.checked = true;
        catalogItem.classList.add("selected");
      }
    };

    container.appendChild(chip);
  });
}

// ─── Human-in-the-Loop Approval UI ─────────────────────────────

function renderPendingTask(task) {
  state.currentPendingTask = task;
  const section = document.getElementById("approvalSection");
  if (!section) return;

  section.classList.remove("hidden");

  document.getElementById("approvalTaskId").textContent = `#${task.task_id}`;
  document.getElementById("approvalPrompt").textContent = task.prompt;

  // Bugs List
  const bugBadge = document.getElementById("bugCountBadge");
  const bugList = document.getElementById("bugListContainer");
  if (bugBadge) bugBadge.textContent = `${task.bug_count} ${task.bug_count === 1 ? "finding" : "findings"}`;
  if (bugList) bugList.innerHTML = "";

  if (task.bugs_found && task.bugs_found.length > 0) {
    task.bugs_found.forEach((b) => {
      const card = document.createElement("div");
      card.className = "bug-card";
      card.innerHTML = `
        <div class="bug-card-top">
          <span class="bug-file">${b.file}:${b.line}</span>
          <span class="clean-subtext" style="color:var(--accent-red);">${b.severity}</span>
        </div>
        <div class="bug-msg">${b.message}</div>
      `;
      bugList.appendChild(card);
    });
  } else {
    bugList.innerHTML = `<span style="font-size:12px;color:var(--text-secondary);">No critical bugs or syntax errors detected.</span>`;
  }

  // Fixes List
  const fixesList = document.getElementById("fixesListContainer");
  fixesList.innerHTML = "";
  if (task.proposed_fixes && task.proposed_fixes.length > 0) {
    task.proposed_fixes.forEach((fix) => {
      const li = document.createElement("li");
      li.textContent = fix;
      fixesList.appendChild(li);
    });
  }

  // Diff
  const diffElem = document.getElementById("diffViewer");
  if (diffElem) {
    diffElem.querySelector("code").textContent = task.diff || "// No file changes yet";
  }
}



function hidePendingTask() {
  state.currentPendingTask = null;
  const section = document.getElementById("approvalSection");
  if (section) section.classList.add("hidden");
}

// ─── Image Upload & Attachment Management ─────────────────────

function getImageUrl(imgPath) {
  if (!imgPath) return "";
  if (typeof imgPath !== "string") {
    if (imgPath.file_url) return imgPath.file_url;
    if (imgPath.url) return imgPath.url;
    return "";
  }
  if (imgPath.startsWith("http://") || imgPath.startsWith("https://") || imgPath.startsWith("/uploads/") || imgPath.startsWith("data:")) {
    return imgPath;
  }
  const filename = imgPath.split(/[\\/]/).pop();
  return `/uploads/${filename}`;
}

async function uploadSingleImageFile(file) {
  if (!file) return null;
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.file_path) {
      return {
        filename: data.filename || file.name || "screenshot.png",
        file_path: data.file_path,
        file_url: data.file_url,
      };
    }
  } catch (err) {
    console.error("Could not upload image:", file.name, err);
  }
  return null;
}

async function uploadMultipleImageFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList).filter((f) => f && f.type && f.type.startsWith("image/"));
  if (files.length === 0) {
    showToast("Choose an image file (PNG, JPG, WebP, or GIF).", "warning");
    return;
  }

  const btnLabel = document.querySelector(".btn-attach-image span");
  const oldText = btnLabel ? btnLabel.textContent : "Attach images";

  let successCount = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (btnLabel) {
      btnLabel.textContent = files.length > 1 ? `Uploading (${i + 1}/${files.length})...` : "Uploading...";
    }
    const uploaded = await uploadSingleImageFile(file);
    if (uploaded) {
      state.pendingImages.push(uploaded);
      successCount++;
      renderImagePreviews();
      addLogEvent(`Image '${uploaded.filename}' uploaded.`);
    }
  }

  if (btnLabel) btnLabel.textContent = oldText;

  if (successCount > 0) {
    showToast(`${successCount} ${successCount === 1 ? "image" : "images"} attached to your message.`, "success");
  } else {
    showToast("Could not upload the selected images.", "error");
  }
}

async function handleImageUpload(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  await uploadMultipleImageFiles(files);
  e.target.value = "";
}

function handleClipboardImagePaste(e) {
  const clipboardData = e.clipboardData || window.clipboardData;
  if (!clipboardData || !clipboardData.items) return;

  const items = clipboardData.items;
  const imageFiles = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        imageFiles.push(file);
      }
    }
  }

  if (imageFiles.length > 0) {
    e.preventDefault();
    uploadMultipleImageFiles(imageFiles);
    showToast(`Processing ${imageFiles.length} clipboard ${imageFiles.length === 1 ? "image" : "images"}...`, "info");
  }
}

function renderImagePreviews() {
  const container = document.getElementById("imagePreviewContainer");
  if (!container) return;

  container.innerHTML = "";
  if (state.pendingImages.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  state.pendingImages.forEach((img, idx) => {
    const item = document.createElement("div");
    item.className = "preview-thumb-item";
    item.innerHTML = `
      <img src="${escapeHtml(img.file_url)}" class="preview-thumb-img" alt="Preview (tap to enlarge)" onclick="openImageLightbox('${escapeQuotes(img.file_url)}', '${escapeQuotes(img.filename || 'Image attachment')}')">
      <button type="button" class="btn-remove-thumb" title="Remove image" onclick="removePendingImage(${idx})">×</button>
    `;
    container.appendChild(item);
  });
}

async function removePendingImage(idx) {
  const removed = state.pendingImages.splice(idx, 1)[0];
  renderImagePreviews();
  if (removed) {
    const fn = removed.filename || (removed.file_url ? removed.file_url.split("/").pop() : "");
    if (fn) {
      try {
        await fetch(`/api/upload/${encodeURIComponent(fn)}`, { method: "DELETE" });
        addLogEvent(`Image '${fn}' removed from the upload cache.`);
      } catch (e) {
        console.debug("Could not remove upload cache:", e);
      }
    }
  }
}

// ─── Action Handlers ──────────────────────────────────────────

// ─── Action Handlers: Dual-Choice Queue System ───────────────────

function openQueueChoiceSheet() {
  const modal = document.getElementById("queueChoiceBackdrop");
  if (!modal) return;
  const promptEl = document.getElementById("queueChoiceActivePrompt");
  const stepEl = document.getElementById("queueChoiceActiveStep");
  if (promptEl) {
    promptEl.textContent = state.activeTask ? state.activeTask.prompt : "A task is running on your laptop";
  }
  if (stepEl) {
    const act = state.activeTask ? (state.activeTask.current_action || "Evaluating instructions...") : (state.currentAction || "Working...");
    stepEl.textContent = "Step: " + act;
  }
  modal.classList.remove("hidden");
}

function closeQueueChoiceSheet(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById("queueChoiceBackdrop");
  if (modal) modal.classList.add("hidden");
}

function confirmTaskSend(mode) {
  const modal = document.getElementById("queueChoiceBackdrop");
  if (modal) modal.classList.add("hidden");
  executeSubmitTask(mode);
}

function handleTaskSendClick(mode = "auto") {
  const promptInput = document.getElementById("taskInput");
  const prompt = promptInput ? promptInput.value.trim() : "";

  if (!prompt && state.pendingImages.length === 0) {
    showToast("Write a message or attach an image first.", "error");
    return;
  }

  // Open queue choice dialog if agent is actively processing a task
  const isExecuting = !!(state.activeTask || state.isProcessing);
  if (mode === "auto" && isExecuting) {
    openQueueChoiceSheet();
    return;
  }

  executeSubmitTask(mode);
}

// Backwards compatibility
function submitTask() {
  handleTaskSendClick("auto");
}

async function executeSubmitTask(queueMode = "auto") {
  if (state.isSubmittingTask) return;

  const promptInput = document.getElementById("taskInput");
  const prompt = promptInput ? promptInput.value.trim() : "";

  if (!prompt && state.pendingImages.length === 0) {
    showToast("Write a message or attach an image first.", "error");
    return;
  }

  state.isSubmittingTask = true;
  let targetConversationId = state.activeConversationId;

  const autoExecChecked = document.getElementById("chkAutoExecute")?.checked ?? true;
  const btnSingle = document.getElementById("btnSubmitTask");
  const btnNow = document.getElementById("btnSendNow");
  const btnQueue = document.getElementById("btnEnqueueTask");

  if (btnSingle) {
    btnSingle.disabled = true;
    btnSingle.textContent = autoExecChecked ? "Running on laptop..." : "Analyzing on laptop...";
  }
  if (btnNow) {
    btnNow.disabled = true;
    btnNow.textContent = "Sending now...";
  }
  if (btnQueue) {
    btnQueue.disabled = true;
    btnQueue.textContent = "Queuing...";
  }

  try {
    let offline = navigator.onLine === false || state.bridgeUnavailable;
    if (!offline && (!state.modelCatalogConnected || state.modelCatalogKey !== modelCatalogKey() || state.modelCatalogRequest?.key === modelCatalogKey())) {
      await fetchModels();
      offline = navigator.onLine === false || state.bridgeUnavailable;
    }
    if (targetConversationId !== state.activeConversationId) throw new Error("The conversation changed. Review your message before sending again.");
    const modelOptions = taskModelOptions(offline);
    const attachedImageUrls = state.pendingImages.map(img => img.file_url || img.file_path);
    const attachedImagePaths = state.pendingImages.map(img => img.file_path || img.file_url);
    if (!offline && !state.activeConversationId) {
      const created = await safeFetchJson("/api/conversations", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({title:prompt.split("\n")[0].slice(0,60) || "Review attachments", skills:Array.from(state.selectedSkills)}) });
      if (!created.ok || !created.data?.id) throw new Error(created.error || "Could not create a conversation.");
      if (state.activeConversationId && state.activeConversationId !== created.data.id) throw new Error("The conversation changed. Review your message before sending again.");
      state.activeConversationId = created.data.id;
      targetConversationId = created.data.id;
      ensureConvoTabOpen(created.data.id);
      renderActiveConversation(created.data);
      await fetchConversations(false);
    }
    if (targetConversationId !== state.activeConversationId) throw new Error("The conversation changed. Review your message before sending again.");

    // Display the user message optimistically
    addOptimisticUserMessage(prompt || "Review the attached image.", attachedImageUrls);
    if (queueMode !== "queue") {
      updateProcessingStateUI(true, "Sending to Antigravity...", "thinking");
    }

    const taskPayload = {
      prompt: prompt || "Review the attached image.",
      conversation_id: targetConversationId,
      skills: Array.from(state.selectedSkills),
      images: attachedImagePaths,
      ...modelOptions,
      auto_open_ide: modelOptions.execution_target !== "cli",
      auto_execute: autoExecChecked,
      queue_mode: queueMode,
    };

    // Offline Guard Mode (FR-04)
    if (offline) {
      if (!targetConversationId && state.currentWorkspace?.path) taskPayload.workspace_path = state.currentWorkspace.path;
      const saved = saveToOfflineQueue(taskPayload);
      updateProcessingStateUI(false);
      const pendingStatus = document.querySelector('#conversationTimeline [data-optimistic="true"] .status-clean-text');
      if (pendingStatus) pendingStatus.textContent = saved ? "[Saved offline]" : "[Not sent]";
      if (!saved) return;
      if (promptInput) {
        promptInput.value = "";
        promptInput.style.height = "auto";
      }
      state.pendingImages = [];
      renderImagePreviews();
      return;
    }

    const res = await safeFetchJson("/api/tasks/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(taskPayload),
    });

    if (!res.ok) {
      document.querySelectorAll('#conversationTimeline .msg-bubble[data-optimistic="true"]').forEach(el => el.remove());
      showToast(res.status ? res.error : "Delivery is unconfirmed. Check the conversation before retrying. Your message remains in the input.", "error");
      updateProcessingStateUI(false);
      return;
    }

    triggerHaptic("medium");

    const task = res.data;
    if (task.active_task || task.replayed) {
      renderActiveTaskUI(task.active_task || null);
      if (task.replayed && !task.active_task) {
        delete state.activeTasks[state.activeConversationId];
        updateProcessingStateUI(false);
        refreshActiveConversation();
      }
    }
    if (task.status === "queued") {
      addLogEvent(`Message queued (#${task.queue_position}).`);
      showToast(task.message || `Message queued at position #${task.queue_position}`, "info");
    } else if (autoExecChecked) {
      addLogEvent(`Message sent to laptop.`);
      showToast("Message sent to Antigravity.", "success");
    } else {
      renderPendingTask(task);
      addLogEvent(`Task #${task.task_id} is ready for review.`);
      showToast("Task ready for review.", "info");
    }

    if (promptInput) {
      promptInput.value = "";
      promptInput.style.height = "auto";
    }
    state.pendingImages = [];
    renderImagePreviews();
  } catch (e) {
    showToast(`Could not send the message: ${e.message}`, "error");
    updateProcessingStateUI(false);
  } finally {
    if (btnSingle) {
      btnSingle.disabled = false;
      btnSingle.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
        <span>Send message</span>
      `;
    }
    if (btnNow) {
      btnNow.disabled = false;
      btnNow.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        <span>Send now</span>
      `;
    }
    if (btnQueue) {
      btnQueue.disabled = false;
      btnQueue.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="8" y1="6" x2="21" y2="6"></line>
          <line x1="8" y1="12" x2="21" y2="12"></line>
          <line x1="8" y1="18" x2="21" y2="18"></line>
          <line x1="3" y1="6" x2="3.01" y2="6"></line>
          <line x1="3" y1="12" x2="3.01" y2="12"></line>
          <line x1="3" y1="18" x2="3.01" y2="18"></line>
        </svg>
        <span>Add to queue</span>
      `;
    }
    state.isSubmittingTask = false;
  }
}

async function fetchToolPermissions() {
  const seq = ++state.permissionFetchSeq;
  const res = await safeFetchJson("/api/tasks/pending");
  if (seq === state.permissionFetchSeq && res.ok && Array.isArray(res.data?.tasks)) {
    renderToolPermissions(res.data.tasks.filter(task => task.request_id && task.conversation_id));
  }
  return res.ok;
}

function renderToolPermissions(requests) {
  state.toolPermissions = requests;
  const section = document.getElementById("toolPermissions");
  const list = document.getElementById("toolPermissionRequests");
  if (!section || !list) return;
  section.classList.toggle("hidden", requests.length === 0);
  const pending = new Set(requests.map(request => request.request_id));
  const cards = new Map();
  for (const card of Array.from(list.children)) {
    if (pending.has(card.dataset.requestId)) cards.set(card.dataset.requestId, card);
    else card.remove();
  }
  for (const request of requests) {
    const label = [request.conversation_title || "Conversation", request.workspace].filter(Boolean).join(" · ");
    const existing = cards.get(request.request_id);
    const deciding = state.permissionDecisions.has(request.request_id);
    if (existing) {
      existing.querySelector("small").textContent = label;
      for (const button of existing.querySelectorAll("button")) button.disabled = deciding;
      continue;
    }
    const card = document.createElement("article");
    card.dataset.requestId = request.request_id;
    const project = document.createElement("small");
    project.textContent = label;
    const title = document.createElement("strong");
    title.textContent = request.title;
    card.append(project, title);
    const {rawInput, locations, content} = request.tool || {};
    for (const detail of [rawInput, locations, content]) {
      if (detail == null || (Array.isArray(detail) && !detail.length)) continue;
      const pre = document.createElement("pre");
      pre.textContent = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
      card.append(pre);
    }
    const controls = document.createElement("div");
    controls.className = "tool-permission-options";
    const options = [...request.options];
    if (!options.some(o => o.kind.startsWith("reject_"))) options.push({kind:"cancel", name:"Decline request"});
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn-toggle-diff";
      button.textContent = option.name;
      button.disabled = deciding;
      button.onclick = () => decideToolPermission(request, option);
      controls.append(button);
    }
    card.append(controls);
    list.append(card);
  }
}

async function decideToolPermission(request, option) {
  if (state.permissionDecisions.has(request.request_id) ||
      !state.toolPermissions.some(p => p.request_id === request.request_id && p.conversation_id === request.conversation_id)) return;
  if (option.kind.endsWith("_always") &&
      !window.confirm(`Let Antigravity remember this decision?\n\n${request.title}\n${option.name}`)) return;
  state.permissionDecisions.add(request.request_id);
  renderToolPermissions(state.toolPermissions);
  try {
    const endpoint = option.kind.startsWith("allow_") ? "approve" : "reject";
    const res = await safeFetchJson(`/api/tasks/${endpoint}`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({conversation_id:request.conversation_id, request_id:request.request_id, option_id:option.optionId}),
    });
    if (res.ok || res.status === 409) {
      state.permissionFetchSeq++;
      renderToolPermissions(state.toolPermissions.filter(p => p.request_id !== request.request_id));
    }
    showToast(res.ok ? "Decision sent to Antigravity." : res.error || "Permission decision failed.", res.ok ? "success" : "error");
  } finally {
    state.permissionDecisions.delete(request.request_id);
    renderToolPermissions(state.toolPermissions);
    await fetchToolPermissions();
  }
}

async function approveCurrentTask() {
  if (!state.currentPendingTask) return;
  const taskId = state.currentPendingTask.task_id;

  const btn = document.getElementById("btnApproveTask");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Executing...";
  }

  try {
    const res = await safeFetchJson("/api/tasks/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId }),
    });

    if (!res.ok) {
      showToast(res.error || "Approval failed.", "error");
      return;
    }

    hidePendingTask();
    showToast(res.data?.message || `Task #${taskId} approved and started.`, "success");
    addLogEvent(`Task #${taskId} approved and started.`);
    fetchConversations();
  } catch (e) {
    showToast(`Approval failed: ${e.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>APPROVE & EXECUTE</span>
      `;
    }
  }
}

async function executeTerminalCommand() {
  const input = document.getElementById("terminalCmdInput");
  const cmd = input ? input.value.trim() : "";
  if (!cmd) return;

  const pre = document.getElementById("terminalOutput");
  const codeEl = pre?.querySelector("code") || pre;
  if (codeEl) codeEl.textContent = `[EXECUTING] > ${cmd} ...`;

  try {
    const res = await safeFetchJson("/api/command/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: cmd }),
    });

    if (!res.ok) {
      if (
        res.status === 200 &&
        res.data &&
        (res.data.returncode !== undefined || res.data.stdout !== undefined || res.data.stderr !== undefined)
      ) {
        renderCommandResult(res.data, cmd);
        if (input) input.value = "";
        return;
      }
      const errMsg = res.error || "Command execution failed.";
      if (codeEl) codeEl.textContent = `[ERROR] ${errMsg}`;
      showToast(errMsg, "error");
      return;
    }

    renderCommandResult(res.data, cmd);
    if (input) input.value = "";
  } catch (e) {
    const errMsg = `Execution failed: ${e.message}`;
    if (codeEl) codeEl.textContent = `[ERROR] ${errMsg}`;
    showToast(errMsg, "error");
  }
}

function renderCommandResult(result, fallbackCommand = "") {
  const pre = document.getElementById("terminalOutput");
  const codeEl = pre?.querySelector("code") || pre;
  if (!codeEl || !result) return;

  const commandText = result.command || fallbackCommand || "(command)";
  const exitPart = result.returncode !== undefined && result.returncode !== null ? `Exit: ${result.returncode}` : null;
  const durationPart = typeof result.duration_seconds === "number" && Number.isFinite(result.duration_seconds)
    ? `${result.duration_seconds}s`
    : null;
  const metaParts = [exitPart, durationPart].filter(Boolean).join(", ");
  const metaSuffix = metaParts ? ` (${metaParts})` : "";
  const hasStdout = result.stdout !== undefined && result.stdout !== null && String(result.stdout).length > 0;
  const hasStderr = result.stderr !== undefined && result.stderr !== null && String(result.stderr).length > 0;
  let text;
  if (hasStdout && hasStderr) {
    text = `${String(result.stdout).replace(/\r?\n+$/, "")}\n\n[stderr]\n${result.stderr}`;
  } else if (hasStdout) {
    text = String(result.stdout);
  } else if (hasStderr) {
    text = String(result.stderr);
  } else {
    text = "[Completed without output]";
  }
  const header = `> Command: ${commandText}${metaSuffix}\n\n`;
  codeEl.textContent = header + text;
}

function addLogEvent(text) {
  state.eventCount++;
  const stream = document.getElementById("activityStream");
  const counter = document.getElementById("logCounter");
  if (counter) counter.textContent = `${state.eventCount} events`;

  if (!stream) return;

  const item = document.createElement("div");
  item.className = "activity-item";

  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.innerHTML = `
    <span class="time-stamp">[${time}]</span>
    <span class="activity-text">${escapeHtml(text)}</span>
  `;

  stream.insertBefore(item, stream.firstChild);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeQuotes(str) {
  if (!str) return "";
  return escapeHtml(String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n"));
}

// ─── Markdown Renderer (Rich, Clean, Anti-Clutter) ─────────────

document.addEventListener("click", event => {
  const link = event.target.closest?.("a[data-open-file]");
  if (link) { event.preventDefault(); openFileInLaptop(link.dataset.openFile); }
});

function renderMarkdown(rawText) {
  if (!rawText) return "";
  try {
    let text = String(rawText).replace(/\u0001/g, "");

    // Strip technical metadata headers so the chat stays clean (non-redundant-ui-ux)
    text = text
      .replace(/\[EXECUTION TARGET:[^\]]+\]\s*/gi, "")
      .replace(/\[ACTIVE MODEL:[^\]]+\]\s*/gi, "")
      .replace(/\[PERFORMANCE:[^\]]+\]\s*/gi, "")
      .replace(/\[ACTIVE SKILLS:[^\]]+\]\s*/gi, "")
      .replace(/\[LAMPIRAN GAMBAR DARI USER:[\s\S]*?\]/gi, "")
      .trim();

    // 1. Preserve fenced code blocks before running other regex replacements
    const codeBlocks = [];
    text = text.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (match, lang, code) => {
      const placeholder = `___CODE_BLOCK_${codeBlocks.length}___`;
      const escapedCode = escapeHtml(code.trim());
      const displayLang = (lang || "CODE").toUpperCase();
      codeBlocks.push(
        `<div class="md-code-wrapper">` +
          `<div class="md-code-header">` +
            `<span class="md-code-lang">${escapeHtml(displayLang)}</span>` +
            `<button type="button" class="btn-copy-code" onclick="copyCodeBlock(this)">Copy</button>` +
          `</div>` +
          `<pre class="md-pre"><code class="md-code-content">${escapedCode}</code></pre>` +
        `</div>`
      );
      return placeholder;
    });

    // 2. Escape raw HTML to prevent XSS injection
    text = escapeHtml(text);

    // 3. Horizontal rules (--- or ***)
    text = text.replace(/^---$/gm, '<hr class="md-hr">');
    text = text.replace(/^\*\*\*$/gm, '<hr class="md-hr">');

    // 4. Headings (#, ##, ###, ####)
    text = text.replace(/^####\s+(.*?)$/gm, '<h6 class="md-h6">$1</h6>');
    text = text.replace(/^###\s+(.*?)$/gm, '<h5 class="md-h5">$1</h5>');
    text = text.replace(/^##\s+(.*?)$/gm, '<h4 class="md-h4">$1</h4>');
    text = text.replace(/^#\s+(.*?)$/gm, '<h3 class="md-h3">$1</h3>');

    // 5. Blockquote (> ...)
    text = text.replace(/^>\s+(.*?)$/gm, '<blockquote class="md-quote">$1</blockquote>');

    // 6. Inline code (`code`)
    text = text.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

    // 7. Bold & Italic
    // **bold**
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong class="md-bold">$1</strong>');
    // *italic*
    text = text.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em class="md-italic">$2</em>$3');

    const links = [];
    const storeLink = html => { links.push(html); return iLink + (links.length - 1) + "\u0001"; };
    const iLink = "\u0001link";
    // 8. Markdown links: [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
      const cleanUrl = url.trim();
      if (cleanUrl.startsWith("file:///")) {
        let decodedPath = cleanUrl.replace("file:///", "");
        try {
          decodedPath = decodeURIComponent(decodedPath);
        } catch (e) {
          // Safe fallback if the URL path is invalid or truncated
        }
        return storeLink(`<a href="#" data-open-file="${escapeHtml(decodedPath)}" class="md-link md-file-link" title="Open this file in Antigravity">${linkText}</a>`);
      }
      if (!/^https?:\/\//i.test(cleanUrl) && !/^mailto:/i.test(cleanUrl)) return linkText;
      return storeLink(`<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="md-link">${linkText}</a>`);
    });

    // 9. Auto-link bare URLs not already inside tags
    text = text.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$2</a>');

    text = text.replace(/\u0001link(\d+)\u0001/g, (token, i) => links[i] || "");
    // 10. Unordered lists (- or *)
    text = text.replace(/(?:^[-*]\s+(?:.*?)(?:\r?\n|$))+/gm, (listBlock) => {
      const items = listBlock.trim().split(/\r?\n/).map(line => {
        const clean = line.replace(/^[-*]\s+/, '').trim();
        return clean ? `<li>${clean}</li>` : '';
      }).filter(Boolean).join('');
      return `<ul class="md-ul">${items}</ul>`;
    });

    // 11. Ordered lists (1. 2.)
    text = text.replace(/(?:^\d+\.\s+(?:.*?)(?:\r?\n|$))+/gm, (listBlock) => {
      const items = listBlock.trim().split(/\r?\n/).map(line => {
        const clean = line.replace(/^\d+\.\s+/, '').trim();
        return clean ? `<li>${clean}</li>` : '';
      }).filter(Boolean).join('');
      return `<ol class="md-ol">${items}</ol>`;
    });

    // 12. Paragraphs and line breaks
    const parts = text.split(/\r?\n\r?\n/);
    const formattedParts = parts.map(part => {
      part = part.trim();
      if (!part) return "";
      if (/^<(ul|ol|blockquote|h[3-6]|hr|div)/i.test(part)) {
        return part;
      }
      return `<p class="md-p">${part.replace(/\r?\n/g, '<br>')}</p>`;
    });
    text = formattedParts.filter(Boolean).join('\n');

    // 13. Restore preserved code blocks
    codeBlocks.forEach((block, idx) => {
      text = text.replace(`___CODE_BLOCK_${idx}___`, block);
    });

    return text;
  } catch (err) {
    console.error("renderMarkdown error:", err);
    return escapeHtml(rawText);
  }
}

function copyCodeBlock(btn) {
  const codeEl = btn.closest(".md-code-wrapper")?.querySelector(".md-code-content");
  if (!codeEl) return;
  const text = codeEl.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  }).catch(() => {
    showToast("Could not copy code", "error");
  });
}

// ─── Initialization & Event Listeners ─────────────────────────

function initDialogAccessibility() {
  const closeActions = {
    conversationModal: closeConversationModal, newSessionModal: closeNewSessionModal,
    deleteConfirmModal: closeDeleteModal, modelSheetBackdrop: closeModelSheet,
    quotaSheetBackdrop: closeQuotaSheet, queueChoiceBackdrop: closeQueueChoiceSheet,
    accountModalSheet: closeAccountModal, changesReviewModal: closeChangesModal,
    imageLightboxModal: closeImageLightbox, browseModal: closeFolderBrowser,
  };
  document.querySelectorAll('.modal-backdrop, .sheet-backdrop, .account-popup-backdrop, .image-lightbox-modal').forEach(backdrop => {
    const dialog = backdrop.firstElementChild;
    if (!dialog) return;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;
    const heading = dialog.querySelector('h2, h3');
    if (heading) {
      heading.id ||= `${backdrop.id}Title`;
      dialog.setAttribute('aria-labelledby', heading.id);
    } else dialog.setAttribute('aria-label', 'Detail');
    dialog.querySelectorAll('button').forEach(button => {
      if (button.textContent.trim() === '×') button.setAttribute('aria-label', 'Close dialog');
    });
    const focusable = () => [...dialog.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length);
    let opener = null;
    new MutationObserver(() => {
      if (!backdrop.classList.contains('hidden')) {
        if (!dialog.contains(document.activeElement)) { opener = document.activeElement; (focusable()[0] || dialog).focus(); }
      } else if (opener?.isConnected) { opener.focus(); opener = null; }
    }).observe(backdrop, { attributes: true, attributeFilter: ['class'] });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (closeActions[backdrop.id]) closeActions[backdrop.id]();
        else backdrop.classList.add('hidden');
      } else if (event.key === 'Tab') {
        const items = focusable();
        const first = items[0] || dialog;
        const last = items[items.length - 1] || dialog;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initDialogAccessibility();
  const dictationLanguage = document.getElementById("dictationLanguage");
  if (dictationLanguage) dictationLanguage.value = localStorage.getItem("antigravity_dictation_language") || "";
  const viewTabs = [...document.querySelectorAll('.view-tab-btn')];
  viewTabs.forEach((button, index) => {
    const panelId = 'tabContent' + button.dataset.tab.slice(4).replace(/^./, c => c.toUpperCase());
    button.tabIndex = button.classList.contains('active') ? 0 : -1;
    button.setAttribute('aria-controls', panelId);
    const panel = document.getElementById(panelId);
    if (panel) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); }
    button.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % viewTabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + viewTabs.length) % viewTabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = viewTabs.length - 1;
      else return;
      event.preventDefault();
      switchViewTab(viewTabs[next].dataset.tab);
      viewTabs[next].focus();
    });
  });
  // 1. Hydrate initial data immediately (0ms delay, no empty screen)
  hydrateInitialData();
  checkInsecureHttpConnection();

  // Scroll timeline to latest message and toggle floating pill
  const timeline = document.getElementById("conversationTimeline");
  const btnLatest = document.getElementById("btnScrollToLatest");
  if (timeline) {
    timeline.addEventListener("scroll", () => {
      const nearBottom = isUserNearBottom(timeline, 180);
      if (btnLatest) {
        btnLatest.classList.toggle("hidden", nearBottom);
      }
    }, { passive: true });
    setTimeout(() => scrollTimelineToBottom(false), 80);
    setTimeout(() => scrollTimelineToBottom(false), 300);
  }

  // 2. Open WebSocket, fetch workspaces, conversations, and token quota
  initWebSocket();
  fetchToolPermissions();
  fetchWorkspaces();
  fetchConversations();
  fetchAccount();
  fetchModels();
  fetchTokenQuota();
  fetchChanges();

  setInterval(() => { if (document.visibilityState === "visible") fetchModels(); }, 30000);

  // Heartbeat via WebSocket
  setInterval(() => {
    if (state.wsConnected && state.ws) {
      state.ws.send(JSON.stringify({ type: "PING" }));
    }
  }, 5000);

  // Periodically sync conversations (~8s) so sessions started on laptop appear promptly
  setInterval(() => {
    fetchConversations(false);
  }, 8000);

  // Instant refresh when returning to the browser tab or unlocking the phone
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      fetchToolPermissions();
      fetchConversations(true);
      refreshActiveConversation();
      fetchAccount();
      fetchModels();
      fetchTokenQuota();
      fetchChanges();
    }
  });

  // Quiet fallback polling: only runs while WebSocket is disconnected
  setInterval(() => {
    if (!state.wsConnected) {
      fetchToolPermissions().then(reachable => { if (reachable) flushOfflineQueue(); });
      refreshActiveConversation();
      fetchTokenQuota();
    }
  }, 12000);

  // Conversation Session Modals & Buttons
  const btnOpenConv = document.getElementById("btnOpenConvModal");
  if (btnOpenConv) btnOpenConv.onclick = openConversationModal;

  const btnCloseConv = document.getElementById("btnCloseConvModal");
  if (btnCloseConv) btnCloseConv.onclick = closeConversationModal;

  // "+ New" button -> open new conversation modal
  const btnNewConv = document.getElementById("btnNewConv");
  if (btnNewConv) btnNewConv.onclick = openNewSessionModal;

  // Modal New conversation handlers
  const btnCloseNewModal = document.getElementById("btnCloseNewSessionModal");
  if (btnCloseNewModal) btnCloseNewModal.onclick = closeNewSessionModal;

  const btnCancelNew = document.getElementById("btnCancelNewSession");
  if (btnCancelNew) btnCancelNew.onclick = closeNewSessionModal;

  const btnSubmitNew = document.getElementById("btnSubmitNewSession");
  if (btnSubmitNew) btnSubmitNew.onclick = submitNewSession;

  const modalTitleInput = document.getElementById("modalSessionTitleInput");
  if (modalTitleInput) {
    modalTitleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitNewSession();
      }
    });
  }

  // Template chips in the new conversation modal
  document.querySelectorAll(".template-chip").forEach((chip) => {
    chip.onclick = () => {
      const tmpl = chip.dataset.template || chip.textContent.trim();
      const input = document.getElementById("modalSessionTitleInput");
      if (input) {
        input.value = tmpl;
        input.focus();
      }
    };
  });

  // Apple Action Sheet: Model AI Selector
  const btnOpenModel = document.getElementById("btnOpenModelSheet");
  if (btnOpenModel) btnOpenModel.onclick = openModelSheet;

  const btnCloseModel = document.getElementById("btnCloseModelSheet");
  if (btnCloseModel) btnCloseModel.onclick = closeModelSheet;

  const modelBackdrop = document.getElementById("modelSheetBackdrop");
  if (modelBackdrop) {
    modelBackdrop.onclick = (e) => {
      if (e.target === modelBackdrop) closeModelSheet();
    };
  }

  document.querySelectorAll(".sheet-option-item[data-model]").forEach((item) => {
    item.onclick = () => {
      const model = item.dataset.model;
      selectModel(model);
    };
  });

  // Performance selector listeners
  document.querySelectorAll(".sheet-perf-item").forEach((item) => {
    item.onclick = () => {
      selectPerformance(item.dataset.perf);
      closeModelSheet();
    };
  });

  // Execution Target listeners (IDE GUI vs CLI Headless)
  document.querySelectorAll("#executionTargetSelector .segment-btn").forEach((btn) => {
    btn.onclick = () => {
      selectExecutionTarget(btn.dataset.target);
    };
  });

  // Performance selector listeners
  document.querySelectorAll("#mainPerformanceSelector .segment-btn").forEach((btn) => {
    btn.onclick = () => {
      selectPerformance(btn.dataset.perf);
    };
  });

  updateModelSheetSelectionUI();
  updatePerformanceUI();
  updateExecutionTargetUI();

  // Delete Conversation Confirmation Modal handlers
  const btnCloseDel = document.getElementById("btnCloseDeleteModal");
  if (btnCloseDel) btnCloseDel.onclick = closeDeleteModal;

  const btnCancelDel = document.getElementById("btnCancelDeleteConv");
  if (btnCancelDel) btnCancelDel.onclick = closeDeleteModal;

  const btnConfirmDel = document.getElementById("btnConfirmDeleteConv");
  if (btnConfirmDel) btnConfirmDel.onclick = confirmDeleteConversation;

  // Reconnect button in offline banner
  const btnRetry = document.getElementById("btnRetryConnection");
  if (btnRetry) {
    btnRetry.onclick = () => {
      showToast("Reconnecting to the laptop...", "info");
      initWebSocket();
      fetchConversations();
      fetchWorkspaces();
    };
  }

  // Workspace Actions
  document.getElementById("btnSetTargetWorkspace").onclick = setTargetWorkspace;
  document.getElementById("btnOpenInIde").onclick = openWorkspaceInIde;
  document.getElementById("btnBrowseFolders").onclick = () => openFolderBrowser();
  document.getElementById("btnCloseBrowseModal").onclick = closeFolderBrowser;

  // Quick Workspace Browse Button
  const btnBrowseSub = document.getElementById("btnBrowseSubfolders");
  if (btnBrowseSub) {
    btnBrowseSub.onclick = () => openFolderBrowser();
  }

  // Manual status refresh
  const btnRefreshStatus = document.getElementById("btnRefreshStatus");
  if (btnRefreshStatus) {
    btnRefreshStatus.onclick = async () => {
      const res = await safeFetchJson("/api/status");
      if (res.ok && res.data) {
        updateTelemetryUI(res.data);
      } else {
        showToast(res.error || "Could not refresh laptop status.", "error");
      }
    };
  }

  // Focus IDE
  const btnLaunchIde = document.getElementById("btnLaunchIde");
  if (btnLaunchIde) {
    btnLaunchIde.onclick = openAntigravityOnLaptop;
  }

  // Submit Task & Real-time Skill Recommendation
  const taskInputEl = document.getElementById("taskInput");
  let skillDebounceTimer = null;

  if (taskInputEl) {
    taskInputEl.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitTask();
      }
    };

    taskInputEl.oninput = (e) => {
      // Auto-grow textarea height as text wraps
      taskInputEl.style.height = "auto";
      taskInputEl.style.height = Math.min(taskInputEl.scrollHeight, 240) + "px";

      clearTimeout(skillDebounceTimer);
      const val = e.target.value.trim();
      if (val.length >= 6) {
        skillDebounceTimer = setTimeout(() => {
          recommendSkillsForText(val, false);
        }, 400);
      }
    };
  }
  document.getElementById("btnSubmitTask").onclick = submitTask;

  const secInputEl = document.getElementById("secondaryTaskInput");
  if (secInputEl) {
    secInputEl.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitSecondaryTask();
      }
    };
  }

  // AI Recommend Skills
  document.getElementById("btnRecommendSkills").onclick = recommendSkillsForCurrentTask;

  // Toggle Accordion Skills
  document.getElementById("toggleSkillsAccordion").onclick = () => {
    const drawer = document.getElementById("skillsListDrawer");
    const arrow = document.querySelector(".accordion-arrow");
    drawer.classList.toggle("hidden");
    arrow.style.transform = drawer.classList.contains("hidden") ? "rotate(0deg)" : "rotate(90deg)";
  };

  // Skill Search Input
  document.getElementById("skillSearchInput").oninput = (e) => {
    filterSkills(e.target.value);
  };

  // Toggle Diff
  document.getElementById("btnToggleDiff").onclick = () => {
    const diffViewer = document.getElementById("diffViewer");
    const btn = document.getElementById("btnToggleDiff");
    diffViewer.classList.toggle("hidden");
    btn.textContent = diffViewer.classList.contains("hidden") ? "Show diff" : "Hide diff";
  };

  // Approval Buttons
  document.getElementById("btnApproveTask").onclick = approveCurrentTask;

  document.getElementById("btnRejectTask").onclick = () => {
    document.getElementById("rejectModal").classList.remove("hidden");
  };

  document.getElementById("btnCloseModal").onclick = () => {
    document.getElementById("rejectModal").classList.add("hidden");
  };

  document.getElementById("btnCancelReject").onclick = () => {
    document.getElementById("rejectModal").classList.add("hidden");
  };

  const btnConfirmReject = document.getElementById("btnConfirmReject");
  if (btnConfirmReject) {
    btnConfirmReject.onclick = async () => {
      if (!state.currentPendingTask) return;
      const feedbackEl = document.getElementById("rejectFeedbackText");
      const feedback = feedbackEl ? feedbackEl.value.trim() : "";

      const res = await safeFetchJson("/api/tasks/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: state.currentPendingTask.task_id,
          feedback: feedback,
        }),
      });

      if (!res.ok) {
        showToast(res.error || "Could not reject the task.", "error");
        return;
      }

      const rejectModal = document.getElementById("rejectModal");
      if (rejectModal) rejectModal.classList.add("hidden");
      hidePendingTask();
      addLogEvent(`Task rejected with feedback: "${feedback || 'None'}"`);
    };
  }

  // Terminal Runner
  document.getElementById("btnExecCmd").onclick = executeTerminalCommand;
  document.getElementById("terminalCmdInput").onkeydown = (e) => {
    if (e.key === "Enter") executeTerminalCommand();
  };

  document.getElementById("btnClearTerminal").onclick = () => {
    document.getElementById("terminalOutput").querySelector("code").textContent = "[CLEARED] Waiting for a command...";
  };

  // Image file attachment input & Clipboard Paste (Ctrl+V)
  const fileInput = document.getElementById("imageFileInput");
  if (fileInput) {
    fileInput.onchange = handleImageUpload;
  }

  const mainTaskInput = document.getElementById("taskInput");
  if (mainTaskInput) {
    mainTaskInput.addEventListener("paste", handleClipboardImagePaste);
  }

  // The secondary composer sends text only. Leave its clipboard handling native.

  // Global image paste support (Ctrl+V across chat window)
  document.addEventListener("paste", (e) => {
    const active = document.activeElement;
    if (active && (active.id === "taskInput" || active.id === "secondaryTaskInput")) {
      return; // Already handled by the textarea paste listeners above
    }
    const ignoredIds = ["modalSessionTitleInput", "terminalCmdInput", "filterSkillsInput", "skillSearchInput"];
    if (active && ignoredIds.includes(active.id)) {
      return;
    }
    handleClipboardImagePaste(e);
  });

  // Notification Toggle Button & Initial State
  const notifBtn = document.getElementById("btnEnableNotifications");
  if (notifBtn) {
    notifBtn.onclick = handleNotificationButtonClick;
    updateNotificationButtonUI();
  }

  // Clear Queue Button
  const btnClearQ = document.getElementById("btnClearQueue");
  if (btnClearQ) {
    btnClearQ.onclick = clearTaskQueue;
  }

  // PWA Install Prompt Handlers
  let deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const dismissed = localStorage.getItem("antigravity_pwa_dismissed");
    if (!dismissed) {
      const banner = document.getElementById("pwaInstallBanner");
      if (banner) banner.classList.remove("hidden");
    }
  });

  const btnInstallPwa = document.getElementById("btnInstallPwa");
  if (btnInstallPwa) {
    btnInstallPwa.onclick = async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        try {
          const { outcome } = await deferredInstallPrompt.userChoice;
          if (outcome === "accepted") {
            showToast("Antigravity added to your home screen.", "success");
          }
        } catch (err) {}
        deferredInstallPrompt = null;
      }
      const banner = document.getElementById("pwaInstallBanner");
      if (banner) banner.classList.add("hidden");
    };
  }

  const btnDismissPwa = document.getElementById("btnDismissPwa");
  if (btnDismissPwa) {
    btnDismissPwa.onclick = () => {
      const banner = document.getElementById("pwaInstallBanner");
      if (banner) banner.classList.add("hidden");
      localStorage.setItem("antigravity_pwa_dismissed", "true");
    };
  }

  // Physical Gestures & Offline Queue Initializations
  initOfflineQueue();
  initPullToRefresh();
  initSwipeDismissableSheets();

  // Global user interaction listener to unlock AudioContext on mobile
  document.addEventListener("touchstart", () => { getAudioContext(); }, { once: true, passive: true });
  document.addEventListener("click", () => { getAudioContext(); }, { once: true, passive: true });
});

// Attach global handlers to window for resilient HTML inline onclick execution
window.triggerHaptic = triggerHaptic;
window.setMobileSplitPane = setMobileSplitPane;
window.handleQuickCommand = handleQuickCommand;
window.handleQuickClipboardPaste = handleQuickClipboardPaste;
window.handleQuickClipboardCopy = handleQuickClipboardCopy;
window.toggleVoiceDictation = toggleVoiceDictation;
window.initPullToRefresh = initPullToRefresh;
window.makeSheetSwipeDismissable = makeSheetSwipeDismissable;
window.flushOfflineQueue = flushOfflineQueue;
window.openAntigravityOnLaptop = openAntigravityOnLaptop;
