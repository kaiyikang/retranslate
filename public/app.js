const $ = (id) => document.getElementById(id);
const src = $("src"), dst = $("dst"), lang = $("lang"), saveBtn = $("save"), copyBtn = $("copy"), list = $("saved");

lang.value = localStorage.lang ?? "zh";
let ctrl, timer, streaming = false, rows = [];

function refresh() {
  const hasOut = dst.textContent !== "" && !dst.classList.contains("error");
  copyBtn.disabled = !hasOut;
  saveBtn.disabled = streaming || !hasOut || !src.value.trim();
  dst.classList.toggle("busy", streaming);
}

function flash(btn, ok = true) {
  btn.dataset.label ??= btn.textContent;
  btn.textContent = ok ? "✓" : "✗";
  clearTimeout(btn.flashTimer);
  btn.flashTimer = setTimeout(() => (btn.textContent = btn.dataset.label), 1000);
}

async function api(path, method = "GET", body) {
  const res = await fetch(path, { method, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res;
}

async function translate() {
  clearTimeout(timer);
  ctrl?.abort();
  dst.textContent = "";
  dst.classList.remove("error");
  streaming = false;
  const text = src.value;
  if (!text.trim()) return refresh();

  const c = (ctrl = new AbortController());
  streaming = true;
  refresh();
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      body: JSON.stringify({ text, target: lang.value }),
      signal: c.signal,
    });
    if (!res.ok) throw new Error(await res.text());
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (c !== ctrl) return; // 已被新请求取代，别把旧结果写进去
      if (done) break;
      dst.textContent += value;
    }
  } catch (e) {
    if (c.signal.aborted) return;
    // Access 会话过期时请求被重定向到登录页，fetch 会抛 TypeError
    dst.textContent = e instanceof TypeError ? "Request failed. Your session may have expired, reload the page." : e.message;
    dst.classList.add("error");
  }
  streaming = false;
  refresh();
}

async function save() {
  if (saveBtn.disabled) return;
  try {
    await api("/api/saved", "POST", { source: src.value, target: dst.textContent, target_lang: lang.value });
    flash(saveBtn);
    load();
  } catch {
    flash(saveBtn, false);
  }
}

function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => flash(btn), () => flash(btn, false));
}

async function load() {
  rows = await (await api("/api/saved")).json();
  list.replaceChildren(
    ...rows.map((r) => {
      const li = $("item").content.firstElementChild.cloneNode(true);
      li.querySelector(".s").textContent = r.source;
      li.querySelector(".t").textContent = r.target;
      li.querySelector(".copy").onclick = (e) => copy(r.target, e.currentTarget);
      li.querySelector(".del").onclick = (e) =>
        api(`/api/saved/${r.id}`, "DELETE").then(() => {
          li.remove();
          rows = rows.filter((x) => x !== r);
        }, () => flash(e.target, false));
      return li;
    }),
  );
}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function exportCsv() {
  if (!rows.length) return;
  const cell = (v) => `"${String(v).replaceAll('"', '""')}"`; // 全部加引号，多行译文也安全
  const lines = [
    ["source", "target", "target_lang", "saved_at"],
    ...rows.map((r) => [r.source, r.target, r.target_lang, `${ymd(new Date(r.created_at))} ${hm(new Date(r.created_at))}`]),
  ];
  const csv = "﻿" + lines.map((l) => l.map(cell).join(",")).join("\r\n"); // BOM：Excel 才能认出 UTF-8 中日文
  const now = new Date();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `retranslate-${ymd(now)}-${hm(now).replace(":", "")}${pad(now.getSeconds())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href));
}

src.addEventListener("input", (e) => {
  clearTimeout(timer);
  if (e.inputType === "insertFromPaste") translate();
  else timer = setTimeout(translate, 500);
});
lang.addEventListener("change", () => {
  localStorage.lang = lang.value;
  translate();
});
// Cmd+Tab 切回来：聚焦并全选，粘贴或打字直接覆盖旧内容
window.addEventListener("focus", () => {
  src.focus();
  src.select();
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    e.shiftKey ? exportCsv() : save();
  }
});
saveBtn.onclick = save;
copyBtn.onclick = () => copy(dst.textContent, copyBtn);

load();
