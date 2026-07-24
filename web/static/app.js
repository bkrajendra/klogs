"use strict";

const contextSelect = document.getElementById("context-select");
const namespaceSelect = document.getElementById("namespace-select");
const workloadSelect = document.getElementById("workload-select");
const podSelect = document.getElementById("pod-select");
const containerLabel = document.getElementById("container-label");
const containerSelect = document.getElementById("container-select");
const tabBar = document.getElementById("tab-bar");
const tabContent = document.getElementById("tab-content");
const closeAllBtn = document.getElementById("close-all-tabs");
const themeToggleBtn = document.getElementById("theme-toggle");
const logTabTemplate = document.getElementById("log-tab-template");

const LS_THEME = "klogs-theme";
const LS_CONTEXT = "klogs-context";
const LS_NAMESPACE = "klogs-namespace";

let tabSeq = 0;
let activeTabId = null;
let podsByName = new Map(); // pod name -> { phase, containers }
const tabs = new Map(); // id -> tab state

// ---------- splash screen ----------

const splash = document.getElementById("splash");
const splashDismissBtn = document.getElementById("splash-dismiss");
const splashVersionEl = document.getElementById("splash-version");
const splashUpdateStatusEl = document.getElementById("splash-update-status");
const headerLogoBtn = document.getElementById("header-logo-btn");

let splashAutoDismissTimer = null;

function hideSplash() {
  splash.classList.add("hidden");
  if (splashAutoDismissTimer) {
    clearTimeout(splashAutoDismissTimer);
    splashAutoDismissTimer = null;
  }
}

function showSplash() {
  splash.classList.remove("hidden");
  renderSplashUpdateStatus();
  splashAutoDismissTimer = setTimeout(hideSplash, 6000);
}

splashDismissBtn.addEventListener("click", hideSplash);
splash.addEventListener("click", (e) => {
  if (e.target === splash) hideSplash();
});
document.addEventListener("keydown", () => {
  if (splash.classList.contains("hidden")) return;
  hideSplash();
});
headerLogoBtn.addEventListener("click", showSplash);

// ---------- version & self-update ----------

const GITHUB_REPO = "bkrajendra/klogs";
const UPDATE_CHECK_INITIAL_DELAY_MS = 5000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const versionBadge = document.getElementById("version-badge");
const updateToast = document.getElementById("update-toast");
const updateToastText = updateToast.querySelector(".update-toast-text");
const updateToastUpdateBtn = updateToast.querySelector(".update-toast-update-btn");
const updateToastSkipBtn = updateToast.querySelector(".update-toast-skip-btn");
const updateToastCloseBtn = updateToast.querySelector(".update-toast-close-btn");

const updateModal = document.getElementById("update-modal");
const updateModalVersions = updateModal.querySelector(".update-modal-versions");
const updateModalProgress = updateModal.querySelector(".update-modal-progress");
const updateModalStage = updateModal.querySelector(".update-modal-stage");
const updateModalProgressFill = updateModal.querySelector(".progress-bar-fill");
const updateModalStartBtn = updateModal.querySelector(".update-modal-start-btn");
const updateModalSkipBtn = updateModal.querySelector(".update-modal-skip-btn");
const updateModalRestartBtn = updateModal.querySelector(".update-modal-restart-btn");
const updateModalCloseBtn = updateModal.querySelector(".update-modal-close-btn");

let currentVersionStr = "dev"; // "vX.Y.Z" once /api/version resolves
const updateState = {
  checked: false,
  available: false,
  latest: null,
  // Reset only by a page reload / next launch - not persisted anywhere -
  // so a skipped/dismissed update stops being pushed at the user for the
  // rest of this session, but comes back next time.
  dismissedThisSession: false,
};

function parseVersionParts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewerVersion(latest, current) {
  const a = parseVersionParts(latest);
  const b = parseVersionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function loadVersion() {
  try {
    const v = await fetchJSON("/api/version");
    currentVersionStr = v.version === "dev" ? "dev" : `v${v.version}`;
  } catch {
    currentVersionStr = "dev";
  }
  splashVersionEl.textContent = currentVersionStr;
  renderVersionBadge();
  scheduleUpdateChecks();
}

function renderVersionBadge() {
  versionBadge.textContent = currentVersionStr;
  versionBadge.classList.toggle("update-available", updateState.available);
  versionBadge.title = updateState.available
    ? `Update available: ${updateState.latest} — click to install`
    : `Current version: ${currentVersionStr}`;
}

function renderSplashUpdateStatus() {
  if (!updateState.checked) {
    splashUpdateStatusEl.hidden = true;
    return;
  }
  splashUpdateStatusEl.hidden = false;
  if (updateState.available) {
    splashUpdateStatusEl.textContent = `⬆ ${updateState.latest} available — click to update`;
    splashUpdateStatusEl.className = "splash-update-status available";
  } else {
    splashUpdateStatusEl.textContent = "✓ up to date";
    splashUpdateStatusEl.className = "splash-update-status up-to-date";
  }
}

splashUpdateStatusEl.addEventListener("click", () => {
  if (updateState.available) openUpdateModal();
});
versionBadge.addEventListener("click", () => {
  if (updateState.available) openUpdateModal();
});

function scheduleUpdateChecks() {
  // A locally-built dev binary has no meaningful release to compare
  // against (and self-updating over a dev build would be surprising), so
  // don't proactively check at all - the badge just shows "dev" plainly.
  if (currentVersionStr === "dev") return;
  setTimeout(() => {
    checkForUpdate();
    setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  }, UPDATE_CHECK_INITIAL_DELAY_MS);
}

async function checkForUpdate() {
  let data;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return; // offline / rate-limited / blocked - fail silently, not the user's problem
  }

  updateState.checked = true;
  if (data.tag_name && isNewerVersion(data.tag_name, currentVersionStr)) {
    updateState.available = true;
    updateState.latest = data.tag_name;
  } else {
    updateState.available = false;
    updateState.latest = null;
  }

  renderVersionBadge();
  renderSplashUpdateStatus();
  if (updateState.available && !updateState.dismissedThisSession) {
    showUpdateToast();
  }
}

function showUpdateToast() {
  updateToastText.textContent = `New version ${updateState.latest} available`;
  updateToast.hidden = false;
}

function hideUpdateToast() {
  updateToast.hidden = true;
}

updateToastUpdateBtn.addEventListener("click", () => {
  hideUpdateToast();
  openUpdateModal();
});
updateToastSkipBtn.addEventListener("click", () => {
  updateState.dismissedThisSession = true;
  hideUpdateToast();
});
updateToastCloseBtn.addEventListener("click", () => {
  updateState.dismissedThisSession = true;
  hideUpdateToast();
});

let updateStatusPollTimer = null;

function openUpdateModal() {
  updateModal.hidden = false;
  updateModalVersions.textContent = `Current: ${currentVersionStr}   →   Latest: ${updateState.latest || "?"}`;
  updateModalProgress.hidden = true;
  updateModalProgress.classList.remove("error");
  updateModalStartBtn.hidden = false;
  updateModalSkipBtn.hidden = false;
  updateModalRestartBtn.hidden = true;
  updateModalCloseBtn.hidden = true;
}

function closeUpdateModal() {
  updateModal.hidden = true;
  if (updateStatusPollTimer) {
    clearInterval(updateStatusPollTimer);
    updateStatusPollTimer = null;
  }
}

updateModal.addEventListener("click", (e) => {
  if (e.target !== updateModal) return;
  updateState.dismissedThisSession = true;
  closeUpdateModal();
});
updateModalSkipBtn.addEventListener("click", () => {
  updateState.dismissedThisSession = true;
  closeUpdateModal();
});
updateModalCloseBtn.addEventListener("click", closeUpdateModal);

function stageProgressPercent(stage) {
  switch (stage) {
    case "downloading":
      return 30;
    case "verifying":
      return 60;
    case "installing":
      return 85;
    case "done":
      return 100;
    default:
      return 10;
  }
}

function showUpdateError(message) {
  updateModalProgress.hidden = false;
  updateModalProgress.classList.add("error");
  updateModalStage.textContent = `Update failed: ${message}`;
  updateModalProgressFill.style.width = "100%";
  updateModalCloseBtn.hidden = false;
}

function pollUpdateStatus() {
  updateStatusPollTimer = setInterval(async () => {
    let status;
    try {
      status = await fetchJSON("/api/update/status");
    } catch {
      return; // transient - keep polling
    }

    updateModalStage.textContent = status.message || status.stage;
    updateModalProgressFill.style.width = stageProgressPercent(status.stage) + "%";

    if (status.stage === "done") {
      clearInterval(updateStatusPollTimer);
      updateStatusPollTimer = null;
      updateModalStage.textContent = `Installed ${status.version}. Restart to use it.`;
      updateModalRestartBtn.hidden = false;
      updateModalCloseBtn.hidden = false;
    } else if (status.stage === "error") {
      clearInterval(updateStatusPollTimer);
      updateStatusPollTimer = null;
      showUpdateError(status.message);
    }
  }, 400);
}

updateModalStartBtn.addEventListener("click", async () => {
  if (!updateState.latest) return;
  updateModalStartBtn.hidden = true;
  updateModalSkipBtn.hidden = true;
  updateModalProgress.hidden = false;
  updateModalStage.textContent = "starting...";
  updateModalProgressFill.style.width = "5%";

  try {
    await fetchJSON("/api/update/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: updateState.latest }),
    });
  } catch (err) {
    showUpdateError(err.message);
    return;
  }
  pollUpdateStatus();
});

updateModalRestartBtn.addEventListener("click", async () => {
  updateModalRestartBtn.hidden = true;
  updateModalStage.textContent = "Restarting...";
  try {
    await fetchJSON("/api/update/restart", { method: "POST" });
  } catch (err) {
    updateModalStage.textContent = `Restart failed: ${err.message}`;
    updateModalRestartBtn.hidden = false;
    return;
  }
  updateModalStage.textContent = "Restarting — reloading shortly...";
  setTimeout(() => location.reload(), 2500);
});

loadVersion();
showSplash();

// ---------- theme ----------

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggleBtn.textContent = theme === "dark" ? "☀️" : "🌙";
  themeToggleBtn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

let currentTheme =
  localStorage.getItem(LS_THEME) ||
  (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
applyTheme(currentTheme);

themeToggleBtn.addEventListener("click", () => {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem(LS_THEME, currentTheme);
  applyTheme(currentTheme);
});

// ---------- data loading ----------

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

function currentContext() {
  return contextSelect.value;
}

function currentNamespace() {
  return namespaceSelect.value;
}

function resetSelect(select, placeholder) {
  select.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = placeholder;
  select.appendChild(opt);
}

async function loadContexts() {
  const contexts = await fetchJSON("/api/contexts");
  contextSelect.innerHTML = "";
  for (const c of contexts) {
    const opt = document.createElement("option");
    opt.value = c.name;
    opt.textContent = c.name;
    if (c.current) opt.selected = true;
    contextSelect.appendChild(opt);
  }
  const saved = localStorage.getItem(LS_CONTEXT);
  if (saved && contexts.some((c) => c.name === saved)) {
    contextSelect.value = saved;
  }
}

async function loadNamespaces() {
  const namespaces = await fetchJSON(
    `/api/namespaces?context=${encodeURIComponent(currentContext())}`
  );
  namespaceSelect.innerHTML = "";
  for (const ns of namespaces) {
    const opt = document.createElement("option");
    opt.value = ns.name;
    opt.textContent = ns.name;
    namespaceSelect.appendChild(opt);
  }
  const saved = localStorage.getItem(LS_NAMESPACE);
  if (saved && namespaces.some((ns) => ns.name === saved)) {
    namespaceSelect.value = saved;
  } else if (namespaces.some((ns) => ns.name === "default")) {
    namespaceSelect.value = "default";
  }
}

function workloadLabel(kind) {
  return kind === "deployment" ? "d" : "s";
}

async function loadWorkloads() {
  resetSelect(workloadSelect, "-- select --");
  resetSelect(podSelect, "-- select --");
  containerLabel.hidden = true;
  podsByName.clear();
  if (!currentNamespace()) return;

  const workloads = await fetchJSON(
    `/api/workloads?context=${encodeURIComponent(currentContext())}&namespace=${encodeURIComponent(currentNamespace())}`
  );
  for (const w of workloads) {
    const opt = document.createElement("option");
    opt.value = `${w.kind}:${w.name}`;
    opt.textContent = `[${workloadLabel(w.kind)}] ${w.name}`;
    workloadSelect.appendChild(opt);
  }
}

async function loadPods() {
  resetSelect(podSelect, "-- select --");
  containerLabel.hidden = true;
  podsByName.clear();

  const val = workloadSelect.value;
  if (!val) return;
  const [kind, name] = val.split(":");

  const pods = await fetchJSON(
    `/api/workloads/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/pods` +
      `?context=${encodeURIComponent(currentContext())}&namespace=${encodeURIComponent(currentNamespace())}`
  );
  for (const p of pods) {
    podsByName.set(p.name, p);
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = `${p.name} (${p.phase})`;
    podSelect.appendChild(opt);
  }
}

function currentSelection(container) {
  const val = workloadSelect.value;
  if (!val) return null;
  const [kind, name] = val.split(":");
  const pod = podSelect.value;
  if (!pod) return null;
  return {
    context: currentContext(),
    namespace: currentNamespace(),
    kind,
    name,
    pod,
    container,
  };
}

function onPodSelected() {
  containerSelect.innerHTML = "";
  const podName = podSelect.value;
  if (!podName) {
    containerLabel.hidden = true;
    return;
  }

  const pod = podsByName.get(podName);
  const containers = pod?.containers || [];

  if (containers.length > 1) {
    containerLabel.hidden = false;
    for (const c of containers) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      containerSelect.appendChild(opt);
    }
    containerSelect.value = containers[0];
  } else {
    containerLabel.hidden = true;
  }

  const sel = currentSelection(containers[0] || "");
  if (sel) openLogTab(sel);
}

containerSelect.addEventListener("change", () => {
  const sel = currentSelection(containerSelect.value);
  if (sel) openLogTab(sel);
});

// ---------- log tabs ----------

function wsURL(sel) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    context: sel.context,
    namespace: sel.namespace,
    pod: sel.pod,
    container: sel.container,
    follow: "true",
  });
  if (sel.previous) params.set("previous", "true");
  if (sel.tailLines !== undefined) params.set("tailLines", String(sel.tailLines));
  return `${proto}//${location.host}/ws/logs?${params.toString()}`;
}

// Always downloads the complete available log, regardless of the tab's
// "show last N" display cap - the cap is a client-side memory/performance
// setting, not a data limit.
function downloadURL(sel) {
  const params = new URLSearchParams({
    context: sel.context,
    namespace: sel.namespace,
    pod: sel.pod,
    container: sel.container,
  });
  if (sel.previous) params.set("previous", "true");
  return `/api/logs/download?${params.toString()}`;
}

function restartURL(sel) {
  const params = new URLSearchParams({ context: sel.context, namespace: sel.namespace });
  return `/api/workloads/${encodeURIComponent(sel.kind)}/${encodeURIComponent(sel.name)}/restart?${params.toString()}`;
}

function podsURL(sel) {
  const params = new URLSearchParams({ context: sel.context, namespace: sel.namespace });
  return `/api/workloads/${encodeURIComponent(sel.kind)}/${encodeURIComponent(sel.name)}/pods?${params.toString()}`;
}

function setActiveTab(id) {
  activeTabId = id;
  for (const [tid, t] of tabs) {
    const active = tid === id;
    t.tabItemEl.classList.toggle("active", active);
    t.tabEl.classList.toggle("active", active);
  }
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.ws) t.ws.close();
  t.tabItemEl.remove();
  t.tabEl.remove();
  tabs.delete(id);

  if (activeTabId === id) {
    const remaining = [...tabs.keys()];
    if (remaining.length) setActiveTab(remaining[remaining.length - 1]);
    else activeTabId = null;
  }
}

closeAllBtn.addEventListener("click", () => {
  for (const id of [...tabs.keys()]) closeTab(id);
});

function openLogTab(sel) {
  const id = `tab-${++tabSeq}`;
  const title = `${sel.pod}${sel.container ? " / " + sel.container : ""}`;

  const tabItemEl = document.createElement("div");
  tabItemEl.className = "tab-item";

  const tabSelectBtn = document.createElement("button");
  tabSelectBtn.className = "tab-select-btn";
  tabSelectBtn.textContent = title;
  tabSelectBtn.title = title;

  const tabCloseBtn = document.createElement("button");
  tabCloseBtn.className = "tab-close-btn";
  tabCloseBtn.textContent = "×";
  tabCloseBtn.title = "Close tab";

  tabItemEl.appendChild(tabSelectBtn);
  tabItemEl.appendChild(tabCloseBtn);
  tabBar.appendChild(tabItemEl);

  const frag = logTabTemplate.content.cloneNode(true);
  const view = frag.querySelector(".log-view");
  const status = frag.querySelector(".log-status");
  const maxLinesSelect = frag.querySelector(".max-lines");
  const nowBtn = frag.querySelector(".now-btn");
  const prevToggle = frag.querySelector(".previous-toggle");
  const autoscrollBtn = frag.querySelector(".autoscroll-toggle");
  const wordwrapBtn = frag.querySelector(".wordwrap-toggle");
  const fullscreenBtn = frag.querySelector(".fullscreen-toggle");
  const clearBtn = frag.querySelector(".clear-btn");
  const downloadBtn = frag.querySelector(".download-btn");
  const restartBtn = frag.querySelector(".restart-btn");

  frag.querySelector(".log-title").textContent = title;
  tabContent.appendChild(frag);
  const tabEl = tabContent.lastElementChild;

  const state = {
    ws: null,
    autoscroll: true,
    wordwrap: true,
    maxLines: 1000,
    lineNodes: [],
    tabItemEl,
    tabEl,
    sel,
  };
  tabs.set(id, state);

  function clearView() {
    view.textContent = "";
    state.lineNodes = [];
  }

  // Appending a text node + trimming old ones from the front keeps each
  // update O(1)-ish regardless of how long the tab has been streaming -
  // using `view.textContent += line` here would re-serialize the entire
  // buffer on every single line and grind the tab to a halt after a while.
  function appendLine(text) {
    const node = document.createTextNode(text + "\n");
    view.appendChild(node);
    state.lineNodes.push(node);
    if (state.maxLines > 0 && state.lineNodes.length > state.maxLines) {
      const excess = state.lineNodes.length - state.maxLines;
      for (let i = 0; i < excess; i++) {
        view.removeChild(state.lineNodes.shift());
      }
    }
  }

  // connect() reconnects the WebSocket. forceTailLines overrides the
  // "show last" setting for just this one connection (used by the "now"
  // button) without changing the dropdown itself.
  function connect(forceTailLines) {
    if (state.ws) state.ws.close();
    clearView();

    const raw = maxLinesSelect.value;
    state.maxLines = raw === "all" ? 0 : Number(raw);
    const tailLines = forceTailLines !== undefined ? forceTailLines : state.maxLines > 0 ? state.maxLines : undefined;

    const opts = { ...sel, previous: prevToggle.checked, tailLines };
    status.textContent = "connecting...";
    const ws = new WebSocket(wsURL(opts));
    state.ws = ws;

    ws.onopen = () => {
      status.textContent = "streaming";
    };
    ws.onmessage = (ev) => {
      appendLine(ev.data);
      if (state.autoscroll) view.scrollTop = view.scrollHeight;
    };
    ws.onclose = () => {
      status.textContent = "disconnected (click to resume)";
    };
    ws.onerror = () => {
      status.textContent = "error";
    };
  }

  tabSelectBtn.addEventListener("click", () => setActiveTab(id));
  tabCloseBtn.addEventListener("click", () => closeTab(id));
  status.addEventListener("click", () => {
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED) connect();
  });
  prevToggle.addEventListener("change", () => connect());
  maxLinesSelect.addEventListener("change", () => connect());
  nowBtn.addEventListener("click", () => connect(0));

  autoscrollBtn.addEventListener("click", () => {
    state.autoscroll = !state.autoscroll;
    autoscrollBtn.textContent = `autoscroll: ${state.autoscroll ? "on" : "off"}`;
    if (state.autoscroll) view.scrollTop = view.scrollHeight;
  });

  // Scrolling away from the bottom pauses autoscroll so reading history
  // isn't interrupted by new lines; scrolling back to the bottom resumes it.
  view.addEventListener("scroll", () => {
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    if (nearBottom !== state.autoscroll) {
      state.autoscroll = nearBottom;
      autoscrollBtn.textContent = `autoscroll: ${state.autoscroll ? "on" : "off"}`;
    }
  });

  wordwrapBtn.addEventListener("click", () => {
    state.wordwrap = !state.wordwrap;
    view.classList.toggle("nowrap", !state.wordwrap);
    wordwrapBtn.textContent = `wrap: ${state.wordwrap ? "on" : "off"}`;
  });

  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement === tabEl) {
      document.exitFullscreen();
    } else {
      tabEl.requestFullscreen?.();
    }
  });

  clearBtn.addEventListener("click", clearView);

  downloadBtn.addEventListener("click", () => {
    const opts = { ...sel, previous: prevToggle.checked };
    window.open(downloadURL(opts), "_blank");
  });

  restartBtn.addEventListener("click", () => restartWorkload(restartBtn, sel));

  setActiveTab(id);
  connect();
}

async function restartWorkload(btn, sel) {
  if (!confirm(`Restart ${sel.kind} "${sel.name}"? This will restart its pods.`)) return;

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "restarting...";
  try {
    const priorPods = await fetchJSON(podsURL(sel)).catch(() => []);
    const priorNames = new Set((priorPods || []).map((p) => p.name));

    await fetchJSON(restartURL(sel), { method: "POST" });
    btn.textContent = "restarted!";

    watchForReplacementPod(sel, priorNames);
  } catch (err) {
    btn.textContent = "failed";
    alert(`Restart failed: ${err.message}`);
  } finally {
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 2000);
  }
}

// After a restart, the old pod is eventually replaced by a new one with a
// different name. Poll until a new, Running pod shows up, then refresh the
// pod dropdown (if it's still pointed at this workload) and open a tab for
// the new pod automatically.
async function watchForReplacementPod(sel, priorNames) {
  const attempts = 15;
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    let pods;
    try {
      pods = await fetchJSON(podsURL(sel));
    } catch {
      continue;
    }

    const fresh = pods.find((p) => !priorNames.has(p.name) && p.phase === "Running");
    if (!fresh) continue;

    if (
      workloadSelect.value === `${sel.kind}:${sel.name}` &&
      currentContext() === sel.context &&
      currentNamespace() === sel.namespace
    ) {
      await loadPods();
      podSelect.value = fresh.name;
    }

    const container = fresh.containers.includes(sel.container) ? sel.container : fresh.containers[0] || "";
    openLogTab({ ...sel, pod: fresh.name, container });
    return;
  }
}

// ---------- keyboard shortcuts ----------

document.addEventListener("keydown", (e) => {
  if (!activeTabId) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const t = tabs.get(activeTabId);
  if (!t) return;

  switch (e.key.toLowerCase()) {
    case "a":
      t.tabEl.querySelector(".autoscroll-toggle").click();
      e.preventDefault();
      break;
    case "w":
      t.tabEl.querySelector(".wordwrap-toggle").click();
      e.preventDefault();
      break;
    case "f":
      t.tabEl.querySelector(".fullscreen-toggle").click();
      e.preventDefault();
      break;
    case "r":
      t.tabEl.querySelector(".restart-btn").click();
      e.preventDefault();
      break;
  }
});

// ---------- init ----------

contextSelect.addEventListener("change", async () => {
  localStorage.setItem(LS_CONTEXT, contextSelect.value);
  await loadNamespaces();
  await loadWorkloads();
});
namespaceSelect.addEventListener("change", () => {
  localStorage.setItem(LS_NAMESPACE, namespaceSelect.value);
  loadWorkloads();
});
workloadSelect.addEventListener("change", loadPods);
podSelect.addEventListener("change", onPodSelected);

(async function init() {
  try {
    await loadContexts();
    await loadNamespaces();
    await loadWorkloads();
  } catch (err) {
    resetSelect(workloadSelect, `error: ${err.message}`);
  }
})();
