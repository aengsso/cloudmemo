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

  function title(body) {
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t) return t;
    }
    return "제목 없음";
  }
  function snippet(body) {
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.slice(1).join(" ").slice(0, 120) || "추가 텍스트 없음";
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
    list.innerHTML = shown.map((m) =>
      `<li data-id="${m.id}" class="${m.id === currentId ? "active" : ""}" role="option">
         <div class="t">${esc(title(m.body))}</div>
         <div class="s"><b>${fmtDate(m.updated)}</b>${esc(snippet(m.body))}</div>
       </li>`).join("");
  }

  function renderEditor() {
    const m = memos.find((x) => x.id === currentId);
    app.classList.toggle("no-memo", !m);
    if (!m) { $("editor-meta").textContent = ""; return; }
    $("editor-meta").textContent = new Date(m.updated).toLocaleString("ko-KR",
      { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
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
  editor.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  });
  editor.addEventListener("blur", flush);
  search.addEventListener("input", renderList);
  $("btn-new").onclick = newMemo;
  $("btn-delete").onclick = deleteCurrent;
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
