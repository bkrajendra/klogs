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

let tabSeq = 0;
let activeTabId = null;
let podsByName = new Map(); // pod name -> { phase, containers }
const tabs = new Map(); // id -> tab state

// ---------- theme ----------

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggleBtn.textContent = theme === "dark" ? "☀️" : "🌙";
  themeToggleBtn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

let currentTheme =
  localStorage.getItem("klogs-theme") ||
  (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
applyTheme(currentTheme);

themeToggleBtn.addEventListener("click", () => {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem("klogs-theme", currentTheme);
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
  if (namespaces.some((ns) => ns.name === "default")) {
    namespaceSelect.value = "default";
  }
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
    opt.textContent = `[${w.kind}] ${w.name}`;
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
  if (sel.tailLines) params.set("tailLines", String(sel.tailLines));
  return `${proto}//${location.host}/ws/logs?${params.toString()}`;
}

function downloadURL(sel) {
  const params = new URLSearchParams({
    context: sel.context,
    namespace: sel.namespace,
    pod: sel.pod,
    container: sel.container,
  });
  if (sel.previous) params.set("previous", "true");
  if (sel.tailLines) params.set("tailLines", String(sel.tailLines));
  return `/api/logs/download?${params.toString()}`;
}

function restartURL(sel) {
  const params = new URLSearchParams({ context: sel.context, namespace: sel.namespace });
  return `/api/workloads/${encodeURIComponent(sel.kind)}/${encodeURIComponent(sel.name)}/restart?${params.toString()}`;
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
  const tailInput = frag.querySelector(".tail-lines");
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
    tabItemEl,
    tabEl,
    sel,
  };
  tabs.set(id, state);

  function connect() {
    if (state.ws) state.ws.close();
    const opts = { ...sel, previous: prevToggle.checked, tailLines: tailInput.value ? Number(tailInput.value) : undefined };
    status.textContent = "connecting...";
    const ws = new WebSocket(wsURL(opts));
    state.ws = ws;

    ws.onopen = () => {
      status.textContent = "streaming";
    };
    ws.onmessage = (ev) => {
      view.textContent += ev.data + "\n";
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
  prevToggle.addEventListener("change", connect);
  tailInput.addEventListener("change", connect);

  autoscrollBtn.addEventListener("click", () => {
    state.autoscroll = !state.autoscroll;
    autoscrollBtn.textContent = `autoscroll: ${state.autoscroll ? "on" : "off"}`;
    if (state.autoscroll) view.scrollTop = view.scrollHeight;
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

  clearBtn.addEventListener("click", () => {
    view.textContent = "";
  });

  downloadBtn.addEventListener("click", () => {
    const opts = { ...sel, previous: prevToggle.checked, tailLines: tailInput.value ? Number(tailInput.value) : undefined };
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
    await fetchJSON(restartURL(sel), { method: "POST" });
    btn.textContent = "restarted!";
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
  await loadNamespaces();
  await loadWorkloads();
});
namespaceSelect.addEventListener("change", loadWorkloads);
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
