const $ = (id) => document.getElementById(id);
const src = $("src"), dst = $("dst"), lang = $("lang"), saveBtn = $("save"), copyBtn = $("copy"), polishBtn = $("polish"), list = $("saved");

lang.value = localStorage.lang ?? "zh";
lang.value ||= "zh"; // 本地存的语言已下线（如 ja）时回退
let ctrl, timer, streaming = false, rows = [], inflight;
let shown = null; // 当前显示的是哪次翻译的结果：{ key, text }，出错或进行中为 null
const DEBOUNCE = 1200; // 每次请求约 200 token 的固定 prompt 开销，太短会让打字时请求成倍增加
const DELETE_DEBOUNCE = 3000; // 删字多半是为了重打，删到一半的句子不值得翻译
const cache = new Map(); // ponytail: 会话内不清理，单页面几百条没问题
const polishCache = new Map(); // 同一个 key，对应「地道」润色后的版本

function refresh() {
  const hasOut = dst.textContent !== "" && !dst.classList.contains("error");
  copyBtn.disabled = !hasOut;
  const polished = dst.classList.contains("polished");
  saveBtn.disabled = streaming || !hasOut || !src.value.trim() || polished; // 润色版语言和目标语言不一致，不能存
  dst.classList.toggle("busy", streaming);
  polishBtn.disabled = streaming || !hasOut || !shown;
  polishBtn.classList.toggle("working", dst.classList.contains("polishing"));
  polishBtn.setAttribute("aria-pressed", polished);
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
  const text = src.value.trim();
  const key = `${lang.value}\n${text}`;
  if (streaming && key === inflight) return; // 内容没变（比如打了空格又删掉），让当前请求继续
  if (!streaming && shown?.key === key) return; // 同上；也避免把已润色的结果冲掉
  ctrl?.abort();
  dst.textContent = "";
  dst.classList.remove("error", "polished", "polishing");
  shown = null;
  streaming = false;
  if (!text) return refresh();
  if (cache.has(key)) {
    dst.textContent = cache.get(key);
    shown = { key, text };
    return refresh();
  }

  inflight = key;
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
    cache.set(key, dst.textContent);
    shown = { key, text };
  } catch (e) {
    if (c.signal.aborted) return;
    // Access 会话过期时请求被重定向到登录页，fetch 会抛 TypeError
    dst.textContent = e instanceof TypeError ? "Request failed. Your session may have expired, reload the page." : e.message;
    dst.classList.add("error");
  }
  streaming = false;
  refresh();
}

// 「地道」：用原文所在的语言重写并检查逻辑（不看目标语言，也不是翻译）；再点一次在普通译文和润色版之间切换
async function polish() {
  if (polishBtn.disabled) return;
  const { key, text } = shown;
  if (dst.classList.contains("polished")) {
    dst.textContent = cache.get(key);
    dst.classList.remove("polished");
    return refresh();
  }
  if (polishCache.has(key)) {
    dst.textContent = polishCache.get(key);
    dst.classList.add("polished");
    return refresh();
  }

  const plain = cache.get(key);
  const c = (ctrl = new AbortController());
  streaming = true;
  dst.classList.add("polishing"); // 保留旧译文，等第一个字到了再替换
  refresh();
  let out = "";
  try {
    const res = await fetch("/api/polish", {
      method: "POST",
      body: JSON.stringify({ text }),
      signal: c.signal,
    });
    if (!res.ok) throw new Error(await res.text());
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (c !== ctrl) return; // 输入变了，translate() 已经接管界面
      if (done) break;
      dst.textContent = out += value;
    }
    if (!out.trim()) throw new Error("empty");
    polishCache.set(key, out);
    dst.classList.add("polished");
  } catch (e) {
    if (c.signal.aborted) return;
    dst.textContent = plain;
    flash(polishBtn, false);
  }
  dst.classList.remove("polishing");
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
  if (e.isComposing) return; // 输入法拼写中（拼音、假名），等 compositionend 再翻
  if (e.inputType === "insertFromPaste") translate();
  else timer = setTimeout(translate, e.inputType.startsWith("delete") ? DELETE_DEBOUNCE : DEBOUNCE);
});
src.addEventListener("compositionend", () => {
  clearTimeout(timer);
  timer = setTimeout(translate, DEBOUNCE);
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
// 手动选中复制时只放纯文本，否则 Teams 之类会连页面字号、颜色一起粘贴
document.addEventListener("copy", (e) => {
  if (e.target === src) return; // textarea 复制本来就是纯文本
  e.clipboardData.setData("text/plain", getSelection().toString());
  e.preventDefault();
});
saveBtn.onclick = save;
polishBtn.onclick = polish;
copyBtn.onclick = () => copy(dst.textContent, copyBtn);

load();
