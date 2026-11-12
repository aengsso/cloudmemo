// Shared UI. Talks only to window.api, which is provided either by the
// Windows exe (Go bindings) or by api-web.js (iPhone / browser).
(function () {
  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const app = $("app"), list = $("list"), editor = $("editor"), search = $("search");

  let memos = [];
  let currentId = null;
  let savedBody = "";      // body as last persisted, to detect pending edits
  let saveTimer = null;
  const narrow = () => matchMedia("(max-width: 700px)").matches;

  // Checklist items are plain-text lines starting with "☐ " (open) or "☑ " (done),
  // so they read the same in the Drive .txt files.
  const OPEN = "☐", DONE = "☑";
  const BOX_RE = /^[☐☑] ?/;

  function title(body) {
    for (const line of body.split("\n")) {
      const t = line.replace(BOX_RE, "").trim();
      if (t) return t;
    }
    return "제목 없음";
  }
  function snippet(body) {
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.slice(1).join(" ").slice(0, 120) || "추가 텍스트 없음";
  }
  function progress(body) {
    let done = 0, all = 0;
    for (const line of body.split("\n")) {
      if (line.startsWith(DONE)) { done++; all++; } else if (line.startsWith(OPEN)) all++;
    }
    return all ? `${done}/${all}` : "";
  }
  function fmtDate(ms) {
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "어제";
    return d.toLocaleDateString("ko-KR", d.getFullYear() === now.getFullYear()
      ? { month: "long", day: "numeric" } : { year: "numeric", month: "numeric", day: "numeric" });
  }
  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const shown = q ? memos.filter((m) => m.body.toLowerCase().includes(q)) : memos;
    if (!shown.length) {
      list.innerHTML = `<li class="none">${q ? "검색 결과 없음" : "메모가 없어"}</li>`;
      return;
    }
    const item = (m) => {
      const p = progress(m.body);
      return `<li data-id="${m.id}" class="${m.id === currentId ? "active" : ""}" role="option">
         <div class="t">${esc(title(m.body))}</div>
         <div class="s"><b>${fmtDate(m.updated)}</b>${p ? `<i>${p}</i>` : ""}${esc(snippet(m.body))}</div>
       </li>`;
    };
    const pinned = shown.filter((m) => m.pinned), rest = shown.filter((m) => !m.pinned);
    list.innerHTML = pinned.length
      ? `<li class="group">고정됨</li>${pinned.map(item).join("")}` +
        (rest.length ? `<li class="group">메모</li>${rest.map(item).join("")}` : "")
      : rest.map(item).join("");
  }

  let metaNote = null; // temporary text in the header (e.g. font size), cleared after a moment
  function renderEditor() {
    const m = memos.find((x) => x.id === currentId);
    app.classList.toggle("no-memo", !m);
    const pin = $("btn-pin");
    pin.classList.toggle("on", !!(m && m.pinned));
    pin.setAttribute("aria-pressed", m && m.pinned ? "true" : "false");
    pin.title = m && m.pinned ? "고정 해제" : "고정";
    if (metaNote) { $("editor-meta").textContent = metaNote; return; }
    if (!m) { $("editor-meta").textContent = ""; return; }
    $("editor-meta").textContent = new Date(m.updated).toLocaleString("ko-KR", narrow()
      ? { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  async function reload() {
    memos = await api.list();
    const cur = memos.find((m) => m.id === currentId);
    if (currentId && !cur) {
      currentId = null; editor.value = ""; savedBody = "";
      if (narrow()) showList();
    } else if (cur && editor.value === savedBody && cur.body !== savedBody) {
      // Changed by sync and no pending local edits: show the new text.
      const pos = editor.selectionStart;
      editor.value = cur.body; savedBody = cur.body;
      editor.setSelectionRange(pos, pos);
    }
    renderList(); renderEditor();
  }

  async function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!currentId || editor.value === savedBody) return;
    const body = editor.value;
    const m = await api.save(currentId, body);
    savedBody = body;
    const i = memos.findIndex((x) => x.id === m.id);
    if (i >= 0) memos.splice(i, 1);
    memos.unshift(m);
    renderList(); renderEditor();
  }

  async function leaveCurrent() {
    await flush();
    const m = memos.find((x) => x.id === currentId);
    if (m && !m.body.trim()) {
      await api.remove(m.id);
      memos = memos.filter((x) => x.id !== m.id);
    }
  }

  async function select(id) {
    if (id === currentId) { if (narrow()) showEditor(); return; }
    await leaveCurrent();
    currentId = id;
    const m = memos.find((x) => x.id === id);
    editor.value = savedBody = m ? m.body : "";
    renderList(); renderEditor();
    if (narrow()) showEditor();
    if (!narrow()) editor.focus();
  }

  async function newMemo() {
    await leaveCurrent();
    search.value = "";
    const m = await api.create();
    memos.unshift(m);
    currentId = m.id;
    editor.value = savedBody = "";
    renderList(); renderEditor();
    if (narrow()) showEditor();
    editor.focus();
  }

  async function deleteCurrent() {
    const m = memos.find((x) => x.id === currentId);
    if (!m) return;
    if (m.body.trim() && !confirm(`"${title(m.body)}" 메모를 삭제할까?`)) return;
    clearTimeout(saveTimer);
    await api.remove(m.id);
    memos = memos.filter((x) => x.id !== m.id);
    currentId = null; editor.value = savedBody = "";
    renderList(); renderEditor();
    if (narrow()) showList();
  }

  // ---- pin ----
  async function togglePin() {
    const m = memos.find((x) => x.id === currentId);
    if (!m) return;
    await flush();
    await api.setPinned(m.id, !m.pinned);
    memos = await api.list();
    renderList(); renderEditor();
  }

  // ---- checklist ----
  // Edits go through insertText so the browser's undo (Ctrl+Z) still works.
  function replaceRange(start, end, text, caret) {
    editor.focus();
    editor.setSelectionRange(start, end);
    const ok = text ? document.execCommand("insertText", false, text)
                    : (start === end || document.execCommand("delete"));
    if (!ok) {
      editor.setRangeText(text, start, end, "end");
      editor.dispatchEvent(new Event("input"));
    }
    if (caret != null) editor.setSelectionRange(caret, caret);
  }
  const lineStart = (v, i) => v.lastIndexOf("\n", i - 1) + 1;
  function lineEnd(v, i) { const e = v.indexOf("\n", i); return e < 0 ? v.length : e; }

  // Turns the selected lines into checklist items, or back into plain lines if they all are.
  function toggleChecklist() {
    if (!currentId) return;
    const v = editor.value, s0 = editor.selectionStart, s1 = editor.selectionEnd;
    const start = lineStart(v, s0);
    const end = lineEnd(v, s1 > s0 && v[s1 - 1] === "\n" ? s1 - 1 : s1);
    const lines = v.slice(start, end).split("\n");
    const filled = lines.filter((l) => l.trim());
    const allItems = filled.length > 0 && filled.every((l) => BOX_RE.test(l));
    const out = lines.map((l) => {
      if (allItems) return l.replace(BOX_RE, "");
      if (BOX_RE.test(l) || (!l.trim() && lines.length > 1)) return l;
      return OPEN + " " + l;
    }).join("\n");
    replaceRange(start, end, out);
    if (lines.length === 1) {
      const pos = Math.max(start, Math.min(start + out.length, s0 + (out.length - (end - start))));
      editor.setSelectionRange(pos, pos);
    } else {
      editor.setSelectionRange(start, start + out.length);
    }
  }

  // Tapping on a box (caret lands right before or after ☐/☑) checks or unchecks it.
  function toggleBoxAtCaret() {
    if (editor.selectionStart !== editor.selectionEnd) return;
    const v = editor.value, pos = editor.selectionStart, start = lineStart(v, pos);
    const c = v[start];
    if ((c !== OPEN && c !== DONE) || pos - start > 1) return;
    replaceRange(start, start + 1, c === OPEN ? DONE : OPEN, Math.min(start + 2, lineEnd(v, start)));
  }

  // Enter on an item starts a new item; Enter on an empty item ends the list.
  function continueChecklist(e) {
    if (e.inputType !== "insertLineBreak" && e.inputType !== "insertParagraph") return;
    const v = editor.value, pos = editor.selectionStart;
    if (pos !== editor.selectionEnd || v[pos - 1] !== "\n") return;
    const prevStart = lineStart(v, pos - 1), prev = v.slice(prevStart, pos - 1);
    if (!BOX_RE.test(prev)) return;
    if (!prev.replace(BOX_RE, "").trim()) replaceRange(prevStart, pos, "", prevStart);
    else replaceRange(pos, pos, OPEN + " ");
  }

  // ---- font size (per device) ----
  const SIZES = [{ s: 0.875, n: "작게" }, { s: 1, n: "보통" }, { s: 1.15, n: "크게" }, { s: 1.3, n: "아주 크게" }];
  const FS_KEY = "cloudmemo.fontSize";
  let fsIndex = 1;
  try { const i = +localStorage.getItem(FS_KEY); if (localStorage.getItem(FS_KEY) != null && SIZES[i]) fsIndex = i; } catch (e) {}
  function applyFont() { document.documentElement.style.setProperty("--fs", SIZES[fsIndex].s); }
  let noteTimer = null;
  function cycleFont() {
    fsIndex = (fsIndex + 1) % SIZES.length;
    applyFont();
    try { localStorage.setItem(FS_KEY, String(fsIndex)); } catch (e) {}
    metaNote = "글자 크기: " + SIZES[fsIndex].n;
    renderEditor();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { metaNote = null; renderEditor(); }, 1500);
  }
  applyFont();

  function showEditor() { app.classList.add("show-editor"); app.classList.remove("show-list"); }
  async function showList() {
    await leaveCurrent();
    if (narrow()) { currentId = null; editor.value = savedBody = ""; }
    app.classList.add("show-list"); app.classList.remove("show-editor");
    renderList(); renderEditor();
  }

  // ---- sync status bar ----
  async function renderStatus() {
    const s = await api.status();
    const dot = $("sync-dot"), text = $("sync-text");
    dot.className = ""; text.className = "";
    $("btn-login").hidden = $("btn-logout").hidden = $("btn-sync").hidden = true;

    if (!s.hasCredentials) {
      dot.className = "err"; text.className = "err";
      text.textContent = s.credHint || "구글 연동 설정이 없음";
      return;
    }
    if (s.loggingIn) { dot.className = "busy"; text.textContent = "브라우저에서 로그인 중…"; return; }
    if (!s.loggedIn) {
      text.textContent = s.error || "로컬에만 저장 중";
      if (s.error) text.className = "err";
      $("btn-login").hidden = false;
      return;
    }
    $("btn-logout").hidden = false;
    if (s.syncing) { dot.className = "busy"; text.textContent = "동기화 중…"; return; }
    $("btn-sync").hidden = false;
    if (s.error) { dot.className = "err"; text.className = "err"; text.textContent = s.error; return; }
    dot.className = s.lastSync ? "ok" : "";
    text.textContent = s.lastSync
      ? "드라이브 동기화됨 " + new Date(s.lastSync).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })
      : "드라이브 연결됨";
  }

  window.__cmEvent = (ev) => {
    if (ev === "changed") reload();
    renderStatus();
  };

  // ---- events ----
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) select(li.dataset.id);
  });
  editor.addEventListener("input", (e) => {
    continueChecklist(e);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  });
  editor.addEventListener("click", toggleBoxAtCaret);
  editor.addEventListener("blur", flush);
  search.addEventListener("input", renderList);
  $("btn-new").onclick = newMemo;
  $("btn-delete").onclick = deleteCurrent;
  $("btn-pin").onclick = togglePin;
  $("btn-check").onclick = toggleChecklist;
  $("btn-font").onclick = cycleFont;
  // Keep the editor's caret/selection when tapping header buttons.
  for (const id of ["btn-check", "btn-font", "btn-pin"]) $(id).addEventListener("mousedown", (e) => e.preventDefault());
  $("btn-back").onclick = showList;
  $("btn-login").onclick = () => { api.login(); setTimeout(renderStatus, 100); };
  $("btn-logout").onclick = async () => {
    if (confirm("구글 드라이브 연결을 해제할까? 메모는 이 기기에 남아.")) { await api.logout(); renderStatus(); }
  };
  $("btn-sync").onclick = async () => { await flush(); api.syncNow(); setTimeout(renderStatus, 100); };
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newMemo(); }
    if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); search.focus(); search.select(); }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); flush(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); toggleChecklist(); }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  window.addEventListener("pagehide", flush);
  window.__cmFlush = flush; // used by api-web.js before redirecting to Google

  // ---- start ----
  (async () => {
    await reload();
    if (!narrow() && memos.length) await select(memos[0].id);
    renderStatus();
    setInterval(renderStatus, 30000); // keeps "동기화됨 HH:MM" fresh
  })();
})();
