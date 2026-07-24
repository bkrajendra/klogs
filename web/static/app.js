"use strict";

const contextSelect = document.getElementById("context-select");
const namespaceSelect = document.getElementById("namespace-select");
const workloadsBody = document.querySelector("#workloads-table tbody");
const tabBar = document.getElementById("tab-bar");
const tabContent = document.getElementById("tab-content");
const closeAllBtn = document.getElementById("close-all-tabs");
const themeToggleBtn = document.getElementById("theme-toggle");
const workloadRowTemplate = document.getElementById("workload-row-template");
const logTabTemplate = document.getElementById("log-tab-template");

let tabSeq = 0;
let activeTabId = null;
let selectedRow = null;
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
  workloadsBody.innerHTML = "";
  selectedRow = null;
  if (!currentNamespace()) return;

  const workloads = await fetchJSON(
    `/api/workloads?context=${encodeURIComponent(currentContext())}&namespace=${encodeURIComponent(currentNamespace())}`
  );

  for (const w of workloads) {
    const frag = workloadRowTemplate.content.cloneNode(true);
    const row = frag.querySelector(".workload-row");
    const podsRow = frag.querySelector(".pods-row");
    const podsList = frag.querySelector(".pods-list");
    const restartBtn = frag.querySelector(".restart-btn");

    frag.querySelector(".w-kind").textContent = w.kind;
    frag.querySelector(".w-name").textContent = w.name;
    frag.querySelector(".w-ready").textContent =
      w.kind === "deployment" ? `${w.ready}/${w.desired}` : "-";

    let loaded = false;
    row.addEventListener("click", async () => {
      if (selectedRow && selectedRow !== row) selectedRow.classList.remove("selected");
      row.classList.add("selected");
      selectedRow = row;

      const willShow = podsRow.hidden;
      podsRow.hidden = !willShow;
      if (willShow && !loaded) {
        loaded = true;
        try {
          await renderPods(podsList, w.kind, w.name);
        } catch (err) {
          podsList.textContent = `error: ${err.message}`;
        }
      }
    });

    restartBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      restartWorkload(restartBtn, w.kind, w.name);
    });

    workloadsBody.appendChild(row);
    workloadsBody.appendChild(podsRow);
  }
}

async function restartWorkload(btn, kind, name) {
  if (!confirm(`Restart ${kind} "${name}"? This will restart its pods.`)) return;

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "restarting...";
  try {
    await fetchJSON(
      `/api/workloads/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/restart` +
        `?context=${encodeURIComponent(currentContext())}&namespace=${encodeURIComponent(currentNamespace())}`,
      { method: "POST" }
    );
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

async function renderPods(container, kind, name) {
  const pods = await fetchJSON(
    `/api/workloads/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/pods` +
      `?context=${encodeURIComponent(currentContext())}&namespace=${encodeURIComponent(currentNamespace())}`
  );

  container.innerHTML = "";
  if (pods.length === 0) {
    container.textContent = "no pods";
    return;
  }

  for (const pod of pods) {
    const entry = document.createElement("div");
    entry.className = "pod-entry";

    const podName = document.createElement("span");
    podName.className = "pod-name";
    podName.textContent = `${pod.name} (${pod.phase})`;
    entry.appendChild(podName);

    for (const c of pod.containers) {
      const btn = document.createElement("button");
      btn.className = "container-btn";
      btn.textContent = pod.containers.length > 1 ? c : "logs";
      btn.addEventListener("click", () => openLogTab(pod.name, c));
      entry.appendChild(btn);
    }

    container.appendChild(entry);
  }
}

// ---------- log tabs ----------

function wsURL(pod, container, opts) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    context: currentContext(),
    namespace: currentNamespace(),
    pod,
    container,
    follow: "true",
  });
  if (opts.previous) params.set("previous", "true");
  if (opts.tailLines) params.set("tailLines", String(opts.tailLines));
  return `${proto}//${location.host}/ws/logs?${params.toString()}`;
}

function downloadURL(pod, container, opts) {
  const params = new URLSearchParams({
    context: currentContext(),
    namespace: currentNamespace(),
    pod,
    container,
  });
  if (opts.previous) params.set("previous", "true");
  if (opts.tailLines) params.set("tailLines", String(opts.tailLines));
  return `/api/logs/download?${params.toString()}`;
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

function openLogTab(pod, container) {
  const id = `tab-${++tabSeq}`;
  const title = `${pod}${container ? " / " + container : ""}`;

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

  frag.querySelector(".log-title").textContent = title;
  tabContent.appendChild(frag);
  const tabEl = tabContent.lastElementChild;

  const state = {
    ws: null,
    autoscroll: true,
    wordwrap: true,
    tabItemEl,
    tabEl,
  };
  tabs.set(id, state);

  function connect() {
    if (state.ws) state.ws.close();
    const opts = {
      previous: prevToggle.checked,
      tailLines: tailInput.value ? Number(tailInput.value) : undefined,
    };
    status.textContent = "connecting...";
    const ws = new WebSocket(wsURL(pod, container, opts));
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
    const opts = {
      previous: prevToggle.checked,
      tailLines: tailInput.value ? Number(tailInput.value) : undefined,
    };
    window.open(downloadURL(pod, container, opts), "_blank");
  });

  setActiveTab(id);
  connect();
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
  }
});

// ---------- init ----------

contextSelect.addEventListener("change", async () => {
  await loadNamespaces();
  await loadWorkloads();
});
namespaceSelect.addEventListener("change", loadWorkloads);

(async function init() {
  try {
    await loadContexts();
    await loadNamespaces();
    await loadWorkloads();
  } catch (err) {
    workloadsBody.innerHTML = `<tr><td colspan="4">error: ${err.message}</td></tr>`;
  }
})();
