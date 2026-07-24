"use strict";

const contextSelect = document.getElementById("context-select");
const namespaceSelect = document.getElementById("namespace-select");
const workloadsBody = document.querySelector("#workloads-table tbody");
const tabBar = document.getElementById("tab-bar");
const tabContent = document.getElementById("tab-content");
const workloadRowTemplate = document.getElementById("workload-row-template");
const logTabTemplate = document.getElementById("log-tab-template");

let tabSeq = 0;
const tabs = new Map(); // id -> { ws, el, autoscroll }

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
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
  if (!currentNamespace()) return;

  const workloads = await fetchJSON(
    `/api/workloads?context=${encodeURIComponent(currentContext())}&namespace=${encodeURIComponent(currentNamespace())}`
  );

  for (const w of workloads) {
    const frag = workloadRowTemplate.content.cloneNode(true);
    const row = frag.querySelector(".workload-row");
    const podsRow = frag.querySelector(".pods-row");
    const podsList = frag.querySelector(".pods-list");

    frag.querySelector(".w-kind").textContent = w.kind;
    frag.querySelector(".w-name").textContent = w.name;
    frag.querySelector(".w-ready").textContent =
      w.kind === "deployment" ? `${w.ready}/${w.desired}` : "-";

    let loaded = false;
    row.addEventListener("click", async () => {
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

    workloadsBody.appendChild(row);
    workloadsBody.appendChild(podsRow);
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

function openLogTab(pod, container) {
  const id = `tab-${++tabSeq}`;
  const title = `${pod}${container ? " / " + container : ""}`;

  const tabBtn = document.createElement("button");
  tabBtn.className = "tab-btn";
  tabBtn.textContent = title;
  tabBar.appendChild(tabBtn);

  const frag = logTabTemplate.content.cloneNode(true);
  const el = frag.querySelector(".log-tab");
  const view = frag.querySelector(".log-view");
  const status = frag.querySelector(".log-status");
  const tailInput = frag.querySelector(".tail-lines");
  const prevToggle = frag.querySelector(".previous-toggle");
  const autoscrollBtn = frag.querySelector(".autoscroll-toggle");
  const clearBtn = frag.querySelector(".clear-btn");
  const downloadBtn = frag.querySelector(".download-btn");
  const closeBtn = frag.querySelector(".close-btn");

  frag.querySelector(".log-title").textContent = title;
  tabContent.appendChild(frag);
  const tabEl = tabContent.lastElementChild;

  const state = { autoscroll: true };
  tabs.set(id, state);

  function setActive() {
    for (const b of tabBar.children) b.classList.remove("active");
    for (const t of tabContent.children) t.classList.remove("active");
    tabBtn.classList.add("active");
    tabEl.classList.add("active");
  }

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

  tabBtn.addEventListener("click", setActive);
  status.addEventListener("click", () => {
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED) connect();
  });
  prevToggle.addEventListener("change", connect);
  tailInput.addEventListener("change", connect);
  autoscrollBtn.addEventListener("click", () => {
    state.autoscroll = !state.autoscroll;
    autoscrollBtn.textContent = `autoscroll: ${state.autoscroll ? "on" : "off"}`;
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
  closeBtn.addEventListener("click", () => {
    if (state.ws) state.ws.close();
    tabBtn.remove();
    tabEl.remove();
    tabs.delete(id);
    if (tabBar.firstElementChild) tabBar.firstElementChild.click();
  });

  setActive();
  connect();
}

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
    workloadsBody.innerHTML = `<tr><td colspan="3">error: ${err.message}</td></tr>`;
  }
})();
