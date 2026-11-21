/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { PageSelection } from "./selection.js";
const selection = new PageSelection();
const $ = (id) => document.getElementById(id),
  base = "/plugins/gallery";
let state,
  selected,
  purpose = "image",
  archived = false,
  offset = 0,
  searching = false,
  settingsDirty = false,
  settingsRevision = "",
  refreshVersion = 0,
  lastGridKey = "",
  lastSettingsKey = "",
  historyOpen = false,
  viewVersion = 0,
  bulkBusy = false;
const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").className = error ? "error" : "";
  if ($("detail").open) $("detailError").textContent = error ? message : "";
}
async function api(path, body) {
  const response = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok || result.ok === false)
    throw Error(result.error || "操作未完成");
  return result;
}
async function action(value) {
  const r = await api("/action", value);
  await refresh();
  return r;
}
function task(fn) {
  return async (e) => {
    e?.preventDefault();
    const button =
      e?.submitter ??
      (e?.currentTarget instanceof HTMLButtonElement ? e.currentTarget : null);
    if (button) button.disabled = true;
    try {
      await fn(e);
    } catch (e) {
      notice(e.message, true);
    } finally {
      if (button) button.disabled = false;
      updateSelection();
    }
  };
}
function renderSettings() {
  const key = JSON.stringify([state.config, state.models]);
  if (settingsDirty || key === lastSettingsKey) return;
  lastSettingsKey = key;
  settingsRevision = state.revision;
  for (const field of ["visionModelId", "embeddingModelId"]) {
    const select = $(field);
    select.replaceChildren(new Option("请选择模型配置", ""));
    for (const m of state.models.filter((m) =>
      field === "embeddingModelId"
        ? m.type === "embedding"
        : ["chat", "image", "custom"].includes(m.type),
    ))
      select.add(new Option(m.name + " · " + m.model, m.id));
    select.value = state.config[field];
  }
  $("topK").value = state.config.topK;
  $("allowOriginals").checked = state.config.allowOriginals;
  $("configError").textContent = state.configError;
}
function updateSelection() {
  const count = selection.selected.size,
    total = selection.items.size;
  $("selectAll").checked = total > 0 && count === total;
  $("selectAll").indeterminate = count > 0 && count < total;
  $("selectAll").disabled = bulkBusy || !total;
  $("selectionCount").textContent = "已选 " + count + " 张";
  $("clearSelection").disabled = bulkBusy || !count;
  $("batchArchive").textContent = bulkBusy
    ? "正在处理…"
    : archived
      ? "恢复所选"
      : "归档所选";
  $("batchArchive").disabled = bulkBusy || !count;
  for (const input of $("grid").querySelectorAll("input[data-asset-id]")) {
    input.checked = selection.selected.has(input.dataset.assetId);
    input.disabled = bulkBusy || !selection.items.has(input.dataset.assetId);
    input.closest(".asset-card").classList.toggle("selected", input.checked);
  }
  for (const control of document.querySelectorAll(
    "[data-purpose], #archive, #searchForm button, #query",
  ))
    control.disabled = bulkBusy;
  $("previous").disabled = bulkBusy || searching || offset === 0;
  $("next").disabled =
    bulkBusy || searching || offset + 60 >= (state?.total ?? 0);
}
function changeView() {
  viewVersion++;
  refreshVersion++;
  selection.clear();
  selection.setItems([]);
  updateSelection();
}
function renderCards(items) {
  if (selection.setItems(items))
    notice("部分所选图片已变化或离开当前页，已取消勾选，请核对后操作。");
  const key = JSON.stringify([purpose, archived, searching, items]);
  if (key === lastGridKey) {
    updateSelection();
    return;
  }
  lastGridKey = key;
  $("grid").replaceChildren();
  for (const a of items) {
    const wrapper = node("article", undefined, "asset-card");
    const label = node("label", undefined, "asset-check");
    const check = node("input");
    check.type = "checkbox";
    check.dataset.assetId = a.id;
    check.setAttribute(
      "aria-label",
      "选择图片：" + (a.description || a.id.slice(0, 8)),
    );
    check.onchange = () => {
      selection.toggle(a.id, check.checked);
      updateSelection();
    };
    label.append(check);
    const card = node("button", undefined, "card");
    card.type = "button";
    const img = node("img");
    img.src = base + "/image?id=" + encodeURIComponent(a.id) + "&preview=1";
    img.alt = a.description || "未描述图片";
    img.loading = "lazy";
    const caption = node("div", undefined, "caption");
    caption.append(
      node(
        "p",
        a.description ||
          (a.indexState === "failed"
            ? "预处理失败，点击查看原因"
            : "等待预处理"),
      ),
    );
    const badges = node("div", undefined, "asset-badges");
    badges.append(
      node(
        "span",
        a.archived
          ? "已归档"
          : searching || a.indexState === "ready"
            ? "已建索引"
            : a.indexState === "failed"
              ? "处理失败"
              : "待预处理",
        "badge",
      ),
    );
    if (a.frames > 1 || a.animated)
      badges.append(node("span", "动图", "badge"));
    caption.append(badges);
    card.append(img, caption);
    card.onclick = task(() => openDetail(a.id));
    wrapper.append(card, label);
    $("grid").append(wrapper);
  }
  if (!items.length) {
    const empty = node("div", undefined, "empty");
    empty.append(
      node("h2", searching ? "没有匹配的候选" : "这里还没有图片"),
      node(
        "p",
        searching
          ? "请确认该用途下的图片已用当前向量模型完成预处理。"
          : "从「导入与预处理」添加图片，准备好以后就能检索使用。",
        "sub",
      ),
    );
    $("grid").append(empty);
  }
  updateSelection();
}
async function openDetail(id) {
  $("detailError").textContent = "";
  let a = state.items.find((x) => x.id === id);
  if (!a) {
    const response = await api(
      "/state?purpose=" + purpose + "&archived=" + archived,
    );
    a = response.items.find((x) => x.id === id);
  }
  // Search candidates outside current page are loaded through the read endpoint.
  if (!a) a = (await api("/action", { action: "read", id })).asset;
  selected = a;
  $("detailImage").src = base + "/image?id=" + a.id;
  $("description").value = a.description;
  $("tags").value = a.tags.join("，");
  $("isMeme").checked = a.purposes.includes("meme");
  $("isImage").checked = a.purposes.includes("image");
  $("assetState").textContent =
    `${a.width} × ${a.height} · ${a.frames} 帧 · ${(a.bytes / 1024).toFixed(0)} KiB · ${a.error || { ready: "已建索引", pending: "待预处理", failed: "处理失败" }[a.indexState]}`;
  $("sourceInfo").textContent = a.sources
    .map((s) =>
      [
        {
          chat: "聊天收藏",
          local: "本机导入",
          web: "链接收藏",
          github: "GitHub",
          astr: "Astr 导入",
          backup: "备份恢复",
        }[s.kind] || s.kind,
        s.repository || s.path || s.url || s.key,
        s.ref,
        s.author,
        s.license,
      ]
        .filter(Boolean)
        .join(" · "),
    )
    .join("\n");
  $("sourceInfo").textContent +=
    `\n图片 ${a.id.slice(0, 8)} · 保存于 ${new Date(a.createdAt).toLocaleString()}`;
  $("archiveAsset").textContent = a.archived ? "恢复到图库" : "归档";
  $("prepareAsset").disabled = a.archived;
  if (!$("detail").open) $("detail").showModal();
}
function renderJobs() {
  const box = $("jobs");
  box.replaceChildren();
  const history = node("details"),
    summary = node("summary");
  const isHistory = (j) =>
    j.state === "completed" ||
    (j.state === "errors" && j.failed > 0 && j.resolvedFailed === j.failed);
  const historyCount = state.jobs.filter(isHistory).length;
  summary.textContent = `历史任务（${historyCount}）`;
  history.open = historyOpen;
  history.ontoggle = () => {
    if (history.isConnected) historyOpen = history.open;
  };
  history.append(summary);
  for (const j of state.jobs) {
    const resolved =
      j.state === "errors" && j.failed > 0 && j.resolvedFailed === j.failed;
    const wrap = node("div", undefined, "job"),
      line = node("div", undefined, "job-line"),
      label = node("div");
    label.append(
      node("strong", j.kind === "prepare" ? "图片预处理" : "图片导入"),
      node(
        "small",
        `　${resolved ? "历史失败，图片现已就绪" : { running: "处理中", paused: "已暂停", completed: "已完成", errors: "处理已结束，有失败项" }[j.state]} · 成功 ${j.done}/${j.total}，当时失败 ${j.failed}`,
      ),
      node("small", `　${new Date(j.createdAt).toLocaleString()}`),
    );
    line.append(label);
    const buttons = node("div", undefined, "row");
    if (j.state === "running") {
      const b = node("button", "暂停", "quiet");
      b.onclick = task(() => action({ action: "pause", id: j.id }));
      buttons.append(b);
    }
    if (j.state === "paused" || (j.state === "errors" && !resolved)) {
      const b = node(
        "button",
        j.state === "errors" ? "重试失败项" : "继续",
        "quiet",
      );
      b.onclick = task(() =>
        action({ action: "resume", id: j.id, retry: true }),
      );
      buttons.append(b);
    }
    line.append(buttons);
    const progress = node("progress");
    progress.max = j.total || 1;
    progress.value = j.done + j.failed;
    wrap.append(line, progress);
    for (const error of j.errors) {
      const row = node("div", undefined, "job-error");
      if (error.assetId) {
        const button = node("button", undefined, "job-image quiet");
        const img = node("img");
        img.src =
          base +
          "/image?id=" +
          encodeURIComponent(error.assetId) +
          "&preview=1";
        img.alt = "查看图片 " + error.assetId.slice(0, 8);
        img.loading = "lazy";
        button.append(img, node("span", "查看图片"));
        button.onclick = task(() => openDetail(error.assetId));
        row.append(button);
      }
      row.append(
        node(
          "p",
          `${error.description || error.key}: ${error.error}${error.resolved ? "\n已恢复：该图片现已建好索引，无需重试。此处仅保留历史记录。" : ""}`,
          error.resolved ? "error-list resolved" : "error-list",
        ),
      );
      wrap.append(row);
    }
    (isHistory(j) ? history : box).append(wrap);
  }
  if (historyCount) box.append(history);
  if (state.jobs.length && state.jobs.every(isHistory))
    box.prepend(
      node("p", "当前没有等待处理或失败的任务，已完成记录见下方历史。", "sub"),
    );
  if (!state.jobs.length) box.append(node("p", "还没有处理任务。", "sub"));
}
async function refresh() {
  const version = ++refreshVersion,
    view = viewVersion;
  const next = await api(
    "/state?purpose=" + purpose + "&archived=" + archived + "&offset=" + offset,
  );
  if (version !== refreshVersion || view !== viewVersion) return;
  if (!searching && offset > 0 && offset >= next.total) {
    offset = Math.floor(Math.max(0, next.total - 1) / 60) * 60;
    return refresh();
  }
  state = next;
  $("metrics").replaceChildren();
  for (const [label, value] of [
    ["图库图片", state.stats.active],
    ["可恢复归档", state.stats.archived],
    [
      "活动图片向量",
      `${state.stats.activeIndexed ?? state.stats.indexed} / ${state.stats.active}`,
    ],
    ["模型请求", state.stats.usage.reduce((sum, x) => sum + x.requests, 0)],
  ]) {
    const el = node("div", label, "metric");
    el.append(node("b", String(value)));
    $("metrics").append(el);
  }
  renderSettings();
  renderJobs();
  if (!searching) renderCards(state.items);
  $("libraryInfo").textContent = archived
    ? "归档图片保留原图与信息，恢复后重新进入检索。"
    : "先按用途过滤，再做语义检索。同一张图可以属于两种用途。";
  $("pageInfo").textContent =
    `共 ${state.total} 张 · 第 ${Math.floor(offset / 60) + 1} 页`;
  updateSelection();
}
for (const button of document.querySelectorAll("[data-tab]"))
  button.onclick = () => {
    for (const pane of document.querySelectorAll(".pane"))
      pane.hidden = pane.id !== button.dataset.tab;
    for (const b of document.querySelectorAll("[data-tab]"))
      b.classList.toggle("active", b === button);
  };
for (const button of document.querySelectorAll("[data-purpose]"))
  button.onclick = task(async () => {
    if (bulkBusy) return;
    changeView();
    purpose = button.dataset.purpose;
    offset = 0;
    searching = false;
    for (const b of document.querySelectorAll("[data-purpose]"))
      b.classList.toggle("active", b === button);
    await refresh();
  });
$("archive").onclick = task(async () => {
  if (bulkBusy) return;
  changeView();
  archived = !archived;
  offset = 0;
  searching = false;
  $("archive").classList.toggle("active", archived);
  await refresh();
});
$("refresh").onclick = task(refresh);
$("previous").onclick = task(async () => {
  if (bulkBusy) return;
  changeView();
  offset = Math.max(0, offset - 60);
  searching = false;
  await refresh();
});
$("next").onclick = task(async () => {
  if (bulkBusy) return;
  changeView();
  offset += 60;
  searching = false;
  await refresh();
});
$("selectAll").onchange = () => {
  selection.selectAll($("selectAll").checked);
  updateSelection();
};
$("clearSelection").onclick = () => {
  selection.clear();
  updateSelection();
};
$("batchArchive").onclick = async () => {
  if (bulkBusy || !selection.selected.size) return;
  const items = selection.entries(),
    target = !archived;
  const verb = target ? "归档" : "恢复";
  bulkBusy = true;
  viewVersion++;
  refreshVersion++;
  updateSelection();
  let changed;
  try {
    const result = await api("/action", {
      action: "archiveMany",
      items,
      archived: target,
    });
    changed = result.changed;
    changeView();
    searching = false;
    await refresh();
    notice("已" + verb + " " + changed + " 张图片。");
  } catch (e) {
    await refresh().catch(() => {});
    notice(
      (changed === undefined
        ? ""
        : "已" + verb + " " + changed + " 张，但刷新失败：") + e.message,
      true,
    );
  } finally {
    bulkBusy = false;
    updateSelection();
  }
};
$("settingsForm").oninput = () => (settingsDirty = true);
$("settingsForm").onsubmit = task(async () => {
  await api("/action", {
    action: "config",
    revision: settingsRevision,
    config: {
      schemaVersion: 1,
      visionModelId: $("visionModelId").value,
      embeddingModelId: $("embeddingModelId").value,
      topK: Number($("topK").value),
      allowOriginals: $("allowOriginals").checked,
    },
  });
  settingsDirty = false;
  await refresh();
  notice("设置已保存。");
});
$("files").onchange = task(async () => {
  const files = [...$("files").files];
  for (let i = 0; i < files.length; i++) {
    notice(`正在保存 ${i + 1}/${files.length}：${files[i].name}`);
    const response = await fetch(
      base + "/upload?name=" + encodeURIComponent(files[i].name),
      { method: "POST", body: files[i] },
    );
    const r = await response.json();
    if (!response.ok) throw Error(r.error);
  }
  await refresh();
  notice("图片已保存，准备好后点击预处理。");
  $("files").value = "";
});
$("zip").onchange = task(async () => {
  const file = $("zip").files[0];
  if (!file) return;
  notice("正在上传并读取图包…");
  const r = await fetch(base + "/zip", { method: "POST", body: file });
  const result = await r.json();
  if (!r.ok) throw Error(result.error);
  notice("导入任务已创建。" + (result.warnings || []).join(" "));
  await refresh();
  $("zip").value = "";
});
$("folderForm").onsubmit = task(async () => {
  notice("正在读取目录…");
  const r = await action({
    action: "folder",
    path: $("folder").value,
    kind: $("astr").checked ? "astr" : "local",
  });
  notice("导入任务已创建。" + r.warnings.join(" "));
});
$("githubForm").onsubmit = task(async () => {
  notice("正在读取仓库版本和图片目录…");
  const r = await action({
    action: "github",
    repository: $("repository").value,
    ref: $("ref").value,
    subpath: $("subpath").value,
  });
  notice("图包已固定到具体提交，开始导入。" + r.warnings.join(" "));
});
$("prepare").onclick = task(async () => {
  await action({ action: "prepare" });
  notice("预处理任务已启动，可随时暂停。");
});
$("recaption").onclick = task(async () => {
  if (
    !confirm(
      "重新识别全部未归档图片会再次调用图片理解模型，并更新已有描述、标签和用途。继续吗？",
    )
  )
    return;
  await action({ action: "prepare", forceCaption: true });
  notice("重新识别任务已启动。");
});
$("searchForm").onsubmit = task(async () => {
  if (bulkBusy) return;
  if (archived) throw Error("归档图片不参与语义检索，请先退出归档。");
  changeView();
  const view = viewVersion;
  const r = await api("/action", {
    action: "search",
    query: $("query").value,
    purpose,
  });
  if (view !== viewVersion || bulkBusy) return;
  searching = true;
  renderCards(r.candidates);
  notice(`找到 ${r.candidates.length} 个候选。`);
});
$("resetSearch").onclick = task(async () => {
  if (bulkBusy) return;
  changeView();
  searching = false;
  $("query").value = "";
  await refresh();
});
$("closeDetail").onclick = () => $("detail").close();
$("prepareAsset").onclick = task(async () => {
  await action({ action: "prepare", ids: [selected.id] });
  notice(
    "这张图片已开始预处理，使用已保存的描述；进度可在「导入与预处理」查看。",
  );
  $("detail").close();
});
$("editForm").onsubmit = task(async () => {
  const purposes = [
    $("isMeme").checked ? "meme" : null,
    $("isImage").checked ? "image" : null,
  ].filter(Boolean);
  await action({
    action: "edit",
    id: selected.id,
    revision: selected.revision,
    patch: {
      description: $("description").value,
      tags: $("tags")
        .value.split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      purposes,
    },
  });
  $("detail").close();
  searching = false;
  await refresh();
  notice("修改已保存，必要的向量会增量更新。");
});
$("archiveAsset").onclick = task(async () => {
  await action({
    action: "edit",
    id: selected.id,
    revision: selected.revision,
    patch: { archived: !selected.archived },
  });
  $("detail").close();
  searching = false;
  await refresh();
  notice(selected.archived ? "图片已恢复。" : "图片已归档，可随时恢复。");
});
await task(refresh)();
setInterval(() => {
  if (!document.hidden) refresh().catch((e) => notice(e.message, true));
}, 4000);
