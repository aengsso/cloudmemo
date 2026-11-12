// Shared UI. Talks only to window.api, which is provided either by the
// Windows exe (Go bindings) or by api-web.js (iPhone / browser).
(function () {
  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const app = $("app"), list = $("list"), editor = $("editor"), search = $("search"), menu = $("menu");

  let memos = [];
  let currentId = null;
  let shownBody = "";      // memo body (as stored) currently rendered in the editor
  let savedBody = "";      // serialize() of the editor when it matched shownBody / was last saved
  let saveTimer = null;
  const narrow = () => matchMedia("(max-width: 700px)").matches;

  // Checklist items are lines starting with "☐ " (open) or "☑ " (done),
  // so they read the same in the Drive files.
  const OPEN = "☐", DONE = "☑";
  const BOX_RE = /^[☐☑] ?/;

  // A memo with formatting is stored as HTML after this marker; a plain memo stays plain
  // text (same rule as remote.go / api-web.js).
  const HTML_MARKER = "<!--cloudmemo-html-->";
  const isHTML = (b) => b.startsWith(HTML_MARKER);

  // Partial font sizes use <font size> (1-7) and colors use <font color>, so the browser's
  // own editing commands (with undo) do the work. CSS maps them to the theme.
  const SIZES = [{ v: "2", n: "작게" }, { v: "3", n: "보통" }, { v: "5", n: "크게" }, { v: "6", n: "아주 크게" }];
  const DEFAULT_COLOR = "#010101"; // "기본색": shown as the normal text color in both themes
  const COLORS = [
    { v: DEFAULT_COLOR, n: "기본", css: "var(--text)" },
    { v: "#e03131", n: "빨강", css: "var(--c-red)" },
    { v: "#e8590c", n: "주황", css: "var(--c-orange)" },
    { v: "#2f9e44", n: "초록", css: "var(--c-green)" },
    { v: "#1971c2", n: "파랑", css: "var(--c-blue)" },
    { v: "#9c36b5", n: "보라", css: "var(--c-purple)" },
    { v: "#868e96", n: "회색", css: "var(--c-gray)" },
  ];
  const COLOR_SET = new Set(COLORS.map((c) => c.v));

  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ---------- body <-> DOM ----------
  const BLOCK = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"]);
  // Text lines of a DOM tree: each block is a line, <br> breaks a line.
  function linesOf(root) {
    const lines = [];
    let cur = null;
    const end = () => { if (cur !== null) { lines.push(cur); cur = null; } };
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const parts = c.nodeValue.split("\n");
          parts.forEach((p, i) => { if (i) { lines.push(cur ?? ""); cur = null; } if (p || i) cur = (cur ?? "") + p; });
        } else if (c.nodeName === "BR") { lines.push(cur ?? ""); cur = null; }
        else if (BLOCK.has(c.nodeName)) { end(); walk(c); end(); }
        else if (c.nodeType === 1) walk(c);
      }
    })(root);
    end();
    return lines.map((l) => l.replace(/ /g, " "));
  }
  const plainCache = new Map();
  function plain(body) {
    if (!isHTML(body)) return body;
    let t = plainCache.get(body);
    if (t == null) {
      const tpl = document.createElement("template");
      tpl.innerHTML = body.slice(HTML_MARKER.length);
      t = linesOf(tpl.content).join("\n");
      if (plainCache.size > 500) plainCache.clear();
      plainCache.set(body, t);
    }
    return t;
  }

  function normColor(v) {
    if (!v) return "";
    v = v.trim().toLowerCase();
    const m = v.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (m) v = "#" + m.slice(1, 4).map((x) => (+x).toString(16).padStart(2, "0")).join("");
    return COLOR_SET.has(v) ? v : "";
  }
  // Only these tags/attributes survive; everything else is unwrapped or dropped.
  const TAGS = { B: "B", STRONG: "B", I: "I", EM: "I", U: "U", FONT: "FONT", BR: "BR", DIV: "DIV", P: "DIV",
                 LI: "DIV", H1: "DIV", H2: "DIV", H3: "DIV", H4: "DIV", H5: "DIV", H6: "DIV", BLOCKQUOTE: "DIV", PRE: "DIV" };
  const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "IMG", "VIDEO",
                        "AUDIO", "CANVAS", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "HEAD", "TITLE", "META", "LINK"]);
  function cleanInto(src, dst) {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1 || DROP.has(n.nodeName)) continue;
      const tag = TAGS[n.nodeName];
      if (!tag) { cleanInto(n, dst); continue; }
      const el = document.createElement(tag);
      if (tag === "FONT") {
        const c = normColor(n.getAttribute("color"));
        if (c) el.setAttribute("color", c);
        const s = n.getAttribute("size");
        if (/^[1-7]$/.test(s || "")) el.setAttribute("size", s);
        if (!el.attributes.length) { cleanInto(n, dst); continue; }
      }
      if (tag !== "BR") cleanInto(n, el);
      dst.appendChild(el);
    }
  }
  // Every top-level node becomes a <div> line; empty lines get a <br> so they keep their height.
  function normalizeTop(root) {
    let run = null;
    for (const n of [...root.childNodes]) {
      if (n.nodeType === 1 && n.nodeName === "DIV") { run = null; continue; }
      if (!run) { run = document.createElement("div"); root.insertBefore(run, n); }
      run.appendChild(n);
    }
    for (const d of root.children) if (!d.firstChild) d.appendChild(document.createElement("br"));
    if (!root.firstChild) root.appendChild(Object.assign(document.createElement("div"), { innerHTML: "<br>" }));
  }

  function serialize() {
    if (!editor.querySelector("b,i,u,font,strong,em")) return linesOf(editor).join("\n");
    const box = document.createElement("div");
    cleanInto(editor, box);
    return HTML_MARKER + box.innerHTML;
  }
  function setContent(body) {
    const frag = document.createDocumentFragment();
    if (isHTML(body)) {
      const tpl = document.createElement("template");
      tpl.innerHTML = body.slice(HTML_MARKER.length);
      cleanInto(tpl.content, frag);
    } else if (body) {
      for (const l of body.split("\n")) {
        const d = document.createElement("div");
        if (l) d.textContent = l; else d.appendChild(document.createElement("br"));
        frag.appendChild(d);
      }
    }
    normalizeTop(frag);
    editor.replaceChildren(frag);
    shownBody = body;
    savedBody = serialize();
    updateEmpty();
  }
  function updateEmpty() {
    editor.classList.toggle("empty", editor.textContent === "" && editor.children.length <= 1);
  }

  // ---------- text helpers ----------
  function title(body) {
    for (const line of plain(body).split("\n")) {
      const t = line.replace(BOX_RE, "").trim();
      if (t) return t;
    }
    return "제목 없음";
  }
  function snippet(body) {
    const lines = plain(body).split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.slice(1).join(" ").slice(0, 120) || "추가 텍스트 없음";
  }
  function progress(body) {
    let done = 0, all = 0;
    for (const line of plain(body).split("\n")) {
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

  // ---------- folders (app-level; stored per memo, synced via Drive appProperties) ----------
  const FOLDERS_KEY = "cloudmemo.folders", FILTER_KEY = "cloudmemo.folderFilter";
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  let extraFolders = lsGet(FOLDERS_KEY, []);  // folders made on this device that may still be empty
  let filter = lsGet(FILTER_KEY, null);       // null = 전체
  const cleanFolder = (f) => Array.from(String(f || "").trim()).slice(0, 30).join("");
  function folderNames() {
    const s = new Set(extraFolders);
    for (const m of memos) if (m.folder) s.add(m.folder);
    return [...s].sort((a, b) => a.localeCompare(b, "ko"));
  }
  function setFilter(f) { filter = f; lsSet(FILTER_KEY, f); renderFolders(); renderList(); }
  function renderFolders() {
    const names = folderNames();
    if (filter != null && !names.includes(filter)) { filter = null; lsSet(FILTER_KEY, null); }
    const chip = (label, data, on) =>
      `<button class="chip${on ? " on" : ""}" ${data} role="tab" aria-selected="${on}">${esc(label)}</button>`;
    $("folders").innerHTML =
      chip("전체", `data-all="1"`, filter == null) +
      names.map((n) => chip(n, `data-f="${esc(n)}"`, filter === n)).join("") +
      (filter != null ? `<button class="chip ghost" id="folder-more" data-menu title="폴더 이름 바꾸기·삭제" aria-label="폴더 관리">⋯</button>` : "") +
      `<button class="chip ghost" id="folder-add" title="새 폴더" aria-label="새 폴더">+ 폴더</button>`;
  }
  function askFolderName(initial) {
    const v = prompt(initial ? "폴더 새 이름" : "새 폴더 이름", initial || "");
    return v == null ? "" : cleanFolder(v);
  }
  function rememberFolder(name) {
    if (name && !extraFolders.includes(name)) { extraFolders.push(name); lsSet(FOLDERS_KEY, extraFolders); }
  }
  function forgetFolder(name) {
    extraFolders = extraFolders.filter((f) => f !== name); lsSet(FOLDERS_KEY, extraFolders);
  }
  async function addFolder() {
    const name = askFolderName();
    if (!name) return;
    rememberFolder(name);
    setFilter(name);
  }
  async function renameFolder(old) {
    const name = askFolderName(old);
    if (!name || name === old) return;
    await flush();
    for (const m of memos.filter((x) => x.folder === old)) await api.setFolder(m.id, name);
    forgetFolder(old); rememberFolder(name);
    memos = await api.list();
    filter = name; lsSet(FILTER_KEY, name);
    renderAll();
  }
  async function deleteFolder(old) {
    const inside = memos.filter((x) => x.folder === old);
    if (!confirm(`"${old}" 폴더를 지울까?` + (inside.length ? `\n안에 있는 메모 ${inside.length}개는 지워지지 않고 폴더 밖으로 옮겨져.` : ""))) return;
    await flush();
    for (const m of inside) await api.setFolder(m.id, "");
    forgetFolder(old);
    memos = await api.list();
    filter = null; lsSet(FILTER_KEY, null);
    renderAll();
  }
  async function moveCurrent(folder) {
    const m = memos.find((x) => x.id === currentId);
    if (!m || (m.folder || "") === folder) return;
    await flush();
    rememberFolder(folder);
    await api.setFolder(m.id, folder);
    memos = await api.list();
    renderAll();
    flashMeta(folder ? `"${folder}" 폴더로 옮김` : "폴더에서 뺌");
  }

  // ---------- rendering ----------
  function renderList() {
    const q = search.value.trim().toLowerCase();
    let shown = filter != null ? memos.filter((m) => m.folder === filter) : memos;
    if (q) shown = shown.filter((m) => plain(m.body).toLowerCase().includes(q));
    if (!shown.length) {
      list.innerHTML = `<li class="none">${q ? "검색 결과 없음" : filter != null ? "이 폴더에 메모가 없어" : "메모가 없어"}</li>`;
      return;
    }
    const item = (m) => {
      const p = progress(m.body);
      const f = filter == null && m.folder ? `<em>${esc(m.folder)}</em>` : "";
      return `<li data-id="${m.id}" class="${m.id === currentId ? "active" : ""}" role="option">
         <div class="t">${esc(title(m.body))}</div>
         <div class="s"><b>${fmtDate(m.updated)}</b>${f}${p ? `<i>${p}</i>` : ""}${esc(snippet(m.body))}</div>
       </li>`;
    };
    const pinned = shown.filter((m) => m.pinned), rest = shown.filter((m) => !m.pinned);
    list.innerHTML = pinned.length
      ? `<li class="group">고정됨</li>${pinned.map(item).join("")}` +
        (rest.length ? `<li class="group">메모</li>${rest.map(item).join("")}` : "")
      : rest.map(item).join("");
  }

  let metaNote = null, noteTimer = null; // temporary text in the header, cleared after a moment
  function flashMeta(text) {
    metaNote = text; renderEditor();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { metaNote = null; renderEditor(); }, 1500);
  }
  function renderEditor() {
    const m = memos.find((x) => x.id === currentId);
    app.classList.toggle("no-memo", !m);
    const pin = $("btn-pin");
    pin.classList.toggle("on", !!(m && m.pinned));
    pin.setAttribute("aria-pressed", m && m.pinned ? "true" : "false");
    pin.title = m && m.pinned ? "고정 해제" : "고정";
    const fb = $("btn-folder");
    fb.classList.toggle("on", !!(m && m.folder));
    fb.title = m && m.folder ? `폴더: ${m.folder}` : "폴더로 옮기기";
    if (metaNote) { $("editor-meta").textContent = metaNote; return; }
    if (!m) { $("editor-meta").textContent = ""; return; }
    const date = new Date(m.updated).toLocaleString("ko-KR", narrow()
      ? { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    $("editor-meta").textContent = m.folder ? `${m.folder} · ${date}` : date;
  }
  function renderAll() { renderFolders(); renderList(); renderEditor(); }

  // ---------- caret helpers ----------
  const sel = () => getSelection();
  function lineOf(node) {
    while (node && node !== editor && node.parentNode !== editor) node = node.parentNode;
    return node && node !== editor && node.nodeType === 1 ? node : null;
  }
  function lineOffset(line, node, off) {
    const r = document.createRange();
    r.setStart(line, 0); r.setEnd(node, off);
    return r.toString().length;
  }
  function textPoint(line, off) {
    const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let n, last = null, acc = 0;
    while ((n = w.nextNode())) {
      const len = n.nodeValue.length;
      if (off <= acc + len) return [n, off - acc];
      acc += len; last = n;
    }
    return last ? [last, last.nodeValue.length] : [line, 0];
  }
  function selectIn(line, start, end) {
    const [a, ao] = textPoint(line, start), [b, bo] = textPoint(line, end);
    const r = document.createRange();
    r.setStart(a, ao); r.setEnd(b, bo);
    sel().removeAllRanges(); sel().addRange(r);
  }
  const caretAt = (line, off) => selectIn(line, off, off);
  function inEditor() {
    const s = sel();
    return s.rangeCount > 0 && editor.contains(s.anchorNode);
  }
  function caretPos() {
    if (!inEditor()) return null;
    const line = lineOf(sel().anchorNode);
    if (!line) return null;
    return { i: [...editor.children].indexOf(line), off: lineOffset(line, sel().anchorNode, sel().anchorOffset) };
  }
  function restoreCaret(p) {
    const line = editor.children[Math.min(p.i, editor.children.length - 1)];
    if (line) caretAt(line, Math.min(p.off, line.textContent.length));
  }

  // Remember the selection so toolbar taps (which may blur the editor on phones) act on it.
  let lastRange = null;
  document.addEventListener("selectionchange", () => {
    if (inEditor()) { lastRange = sel().getRangeAt(0).cloneRange(); updateFmtState(); }
  });
  function focusEditor() {
    if (document.activeElement !== editor) {
      editor.focus({ preventScroll: true });
      if (lastRange && editor.contains(lastRange.startContainer)) { sel().removeAllRanges(); sel().addRange(lastRange); }
    }
    if (!inEditor()) caretAt(editor.lastElementChild || editor, (editor.lastElementChild || editor).textContent.length);
  }

  // Edits made from code run through execCommand so undo (Ctrl+Z) keeps working.
  let busy = false;
  function run(fn) { busy = true; try { fn(); } finally { busy = false; } }
  function editLine(line, start, end, text) {
    selectIn(line, start, end);
    if (text) document.execCommand("insertText", false, text);
    else if (start !== end) document.execCommand("delete");
  }
  // Stray top-level text (e.g. after deleting everything) is wrapped into a line.
  function ensureLines() {
    if (!editor.firstChild) {
      editor.innerHTML = "<div><br></div>";
      caretAt(editor.firstChild, 0);
      return;
    }
    if ([...editor.childNodes].some((n) => !(n.nodeType === 1 && n.nodeName === "DIV")) && inEditor())
      run(() => document.execCommand("formatBlock", false, "div"));
  }

  // ---------- formatting ----------
  function fmt(cmd, val) {
    if (!currentId) return;
    focusEditor();
    run(() => {
      document.execCommand("styleWithCSS", false, false);
      document.execCommand(cmd, false, val);
    });
    afterEdit(); updateFmtState();
  }
  function updateFmtState() {
    for (const [id, cmd] of [["f-bold", "bold"], ["f-italic", "italic"], ["f-under", "underline"]]) {
      let on = false;
      try { on = inEditor() && document.queryCommandState(cmd); } catch (e) {}
      $(id).classList.toggle("on", on);
      $(id).setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  function sizeMenu(anchor) {
    let cur = "3";
    try { cur = String(document.queryCommandValue("fontSize") || "3"); } catch (e) {}
    openMenu(anchor, SIZES.map((s) => ({
      html: `<span class="size-s${s.v}">${s.n}</span>`, checked: cur === s.v, onPick: () => fmt("fontSize", s.v),
    })));
  }
  let lastColor = COLORS[1];
  function colorMenu(anchor) {
    openMenu(anchor, COLORS.map((c) => ({
      html: `<i class="sw" style="background:${c.css}"></i>${c.n}`,
      onPick: () => { fmt("foreColor", c.v); if (c.v !== DEFAULT_COLOR) { lastColor = c; $("color-bar").style.background = c.css; } },
    })));
  }

  // ---------- checklist ----------
  function selectedLines() {
    if (!inEditor()) return [];
    const r = sel().getRangeAt(0);
    const out = [...editor.children].filter((l) => r.intersectsNode(l));
    if (out.length > 1 && !r.collapsed) {
      const last = out[out.length - 1];
      if (last.contains(r.endContainer) && lineOffset(last, r.endContainer, r.endOffset) === 0) out.pop();
    }
    return out;
  }
  // Turns the selected lines into checklist items, or back into plain lines if they all are.
  function toggleChecklist() {
    if (!currentId) return;
    focusEditor(); ensureLines();
    const lines = selectedLines();
    if (!lines.length) return;
    const collapsed = sel().isCollapsed;
    const caret = collapsed ? lineOffset(lines[0], sel().anchorNode, sel().anchorOffset) : 0;
    const filled = lines.filter((l) => l.textContent.trim());
    const allItems = filled.length > 0 && filled.every((l) => BOX_RE.test(l.textContent));
    let delta = 0;
    run(() => {
      for (const l of lines) {
        const t = l.textContent, m = t.match(BOX_RE);
        if (allItems) { if (m) { editLine(l, 0, m[0].length, ""); delta = -m[0].length; } }
        else if (!m && (t.trim() || lines.length === 1)) { editLine(l, 0, 0, OPEN + " "); delta = 2; }
      }
    });
    if (collapsed) caretAt(lines[0], Math.max(0, caret + delta));
    else {
      const last = lines[lines.length - 1], r = document.createRange();
      const [a, ao] = textPoint(lines[0], 0), [b, bo] = textPoint(last, last.textContent.length);
      r.setStart(a, ao); r.setEnd(b, bo);
      sel().removeAllRanges(); sel().addRange(r);
    }
    afterEdit();
  }
  // Tapping a box (caret lands right before or after ☐/☑) checks or unchecks it.
  function toggleBoxAtCaret() {
    if (!sel().isCollapsed || !inEditor()) return;
    const line = lineOf(sel().anchorNode);
    if (!line) return;
    const t = line.textContent, c = t[0];
    if ((c !== OPEN && c !== DONE) || lineOffset(line, sel().anchorNode, sel().anchorOffset) > 1) return;
    run(() => editLine(line, 0, 1, c === OPEN ? DONE : OPEN));
    caretAt(line, Math.min(2, line.textContent.length));
    afterEdit();
  }
  // Enter on an item starts a new item; Enter on an empty item ends the list.
  let boxNext = false;
  function onEnter(e) {
    ensureLines();
    const line = inEditor() ? lineOf(sel().anchorNode) : null;
    const t = line ? line.textContent : "";
    const m = t.match(BOX_RE);
    if (m && !t.slice(m[0].length).trim()) {
      e.preventDefault();
      run(() => editLine(line, 0, m[0].length, ""));
      afterEdit();
      return;
    }
    boxNext = !!m;
    if (e.inputType === "insertLineBreak") { // Shift+Enter: keep one line per block
      e.preventDefault();
      run(() => document.execCommand("insertParagraph"));
      afterParagraph();
    }
  }
  function afterParagraph() {
    if (!boxNext) { afterEdit(); return; }
    boxNext = false;
    const line = inEditor() ? lineOf(sel().anchorNode) : null;
    if (line && !BOX_RE.test(line.textContent)) run(() => editLine(line, 0, 0, OPEN + " "));
    afterEdit();
  }

  // ---------- font zoom for this device (whole editor) ----------
  const ZOOM = [{ s: 0.875, n: "작게" }, { s: 1, n: "보통" }, { s: 1.15, n: "크게" }, { s: 1.3, n: "아주 크게" }];
  const FS_KEY = "cloudmemo.fontSize";
  let fsIndex = 1;
  try { const i = +localStorage.getItem(FS_KEY); if (localStorage.getItem(FS_KEY) != null && ZOOM[i]) fsIndex = i; } catch (e) {}
  function applyZoom() { document.documentElement.style.setProperty("--fs", ZOOM[fsIndex].s); }
  function cycleZoom() {
    fsIndex = (fsIndex + 1) % ZOOM.length;
    applyZoom();
    try { localStorage.setItem(FS_KEY, String(fsIndex)); } catch (e) {}
    flashMeta("화면 글자 크기: " + ZOOM[fsIndex].n);
  }
  applyZoom();

  // ---------- popup menu ----------
  let menuAnchor = null;
  function closeMenu() { menu.hidden = true; menuAnchor = null; }
  function openMenu(anchor, items) {
    if (menuAnchor === anchor) { closeMenu(); return; }
    menu.innerHTML = items.map((it, i) => it === "-" ? "<hr>" :
      `<button role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}"><span class="chk">${it.checked ? "✓" : ""}</span>${it.html || esc(it.label)}</button>`).join("");
    menu.hidden = false;
    menuAnchor = anchor;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
    menu.style.top = (r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
    menu.onclick = (e) => {
      const b = e.target.closest("button[data-i]");
      if (!b) return;
      closeMenu();
      items[+b.dataset.i].onPick();
    };
  }
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target))) closeMenu();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) closeMenu(); });

  function folderMenu(anchor) {
    const m = memos.find((x) => x.id === currentId);
    if (!m) return;
    const cur = m.folder || "";
    openMenu(anchor, [
      { label: "폴더 없음", checked: !cur, onPick: () => moveCurrent("") },
      ...folderNames().map((n) => ({ label: n, checked: cur === n, onPick: () => moveCurrent(n) })),
      "-",
      { label: "새 폴더…", onPick: () => { const n = askFolderName(); if (n) moveCurrent(n); } },
    ]);
  }
  function folderManageMenu(anchor) {
    const f = filter;
    if (f == null) return;
    openMenu(anchor, [
      { label: "이름 바꾸기…", onPick: () => renameFolder(f) },
      { label: "폴더 삭제", danger: true, onPick: () => deleteFolder(f) },
    ]);
  }

  // ---------- memo actions ----------
  async function reload() {
    memos = await api.list();
    const cur = memos.find((m) => m.id === currentId);
    if (currentId && !cur) {
      currentId = null; setContent("");
      if (narrow()) showList();
    } else if (cur && cur.body !== shownBody && serialize() === savedBody) {
      // Changed by sync and no pending local edits: show the new text.
      const pos = document.activeElement === editor ? caretPos() : null;
      setContent(cur.body);
      if (pos) restoreCaret(pos);
    }
    renderAll();
  }

  async function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!currentId) return;
    const body = serialize();
    if (body === savedBody) return;
    const id = currentId;
    const m = await api.save(id, body);
    if (id === currentId) { savedBody = body; shownBody = m.body; }
    const i = memos.findIndex((x) => x.id === m.id);
    if (i >= 0) memos.splice(i, 1);
    memos.unshift(m);
    renderList(); renderEditor();
  }
  function afterEdit() {
    updateEmpty();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }

  async function leaveCurrent() {
    await flush();
    const m = memos.find((x) => x.id === currentId);
    if (m && !plain(m.body).trim()) {
      await api.remove(m.id);
      memos = memos.filter((x) => x.id !== m.id);
    }
  }

  async function select(id) {
    if (id === currentId) { if (narrow()) showEditor(); return; }
    await leaveCurrent();
    currentId = id;
    const m = memos.find((x) => x.id === id);
    setContent(m ? m.body : "");
    editor.scrollTop = 0;
    renderAll();
    if (narrow()) showEditor();
    if (!narrow()) editor.focus();
  }

  async function newMemo() {
    await leaveCurrent();
    search.value = "";
    const m = await api.create(filter || "");
    memos.unshift(m);
    currentId = m.id;
    setContent("");
    renderAll();
    if (narrow()) showEditor();
    editor.focus();
    caretAt(editor.firstElementChild, 0);
  }

  async function deleteCurrent() {
    const m = memos.find((x) => x.id === currentId);
    if (!m) return;
    if (plain(m.body).trim() && !confirm(`"${title(m.body)}" 메모를 삭제할까?`)) return;
    clearTimeout(saveTimer);
    await api.remove(m.id);
    memos = memos.filter((x) => x.id !== m.id);
    currentId = null; setContent("");
    renderAll();
    if (narrow()) showList();
  }

  async function togglePin() {
    const m = memos.find((x) => x.id === currentId);
    if (!m) return;
    await flush();
    await api.setPinned(m.id, !m.pinned);
    memos = await api.list();
    renderList(); renderEditor();
  }

  function showEditor() { app.classList.add("show-editor"); app.classList.remove("show-list"); }
  async function showList() {
    await leaveCurrent();
    if (narrow()) { currentId = null; setContent(""); }
    app.classList.add("show-list"); app.classList.remove("show-editor");
    renderAll();
  }

  // ---------- sync status bar ----------
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

  // ---------- events ----------
  try { document.execCommand("defaultParagraphSeparator", false, "div"); } catch (e) {}
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) select(li.dataset.id);
  });
  $("folders").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "folder-add") addFolder();
    else if (b.id === "folder-more") folderManageMenu(b);
    else if (b.dataset.all) setFilter(null);
    else if (b.dataset.f != null) setFilter(b.dataset.f);
  });
  editor.addEventListener("beforeinput", (e) => {
    if (busy) return;
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") onEnter(e);
  });
  editor.addEventListener("input", (e) => {
    if (busy) return;
    if (e.inputType === "insertParagraph" && boxNext) { afterParagraph(); return; }
    if (!editor.firstChild || editor.firstChild.nodeType === 3) ensureLines();
    afterEdit();
  });
  // Paste as plain text so pasted web pages don't bring their styles along.
  editor.addEventListener("paste", (e) => {
    const t = e.clipboardData && e.clipboardData.getData("text/plain");
    if (t == null) return;
    e.preventDefault();
    const lines = t.replace(/\r\n?/g, "\n").split("\n");
    run(() => lines.forEach((l, i) => {
      if (i) document.execCommand("insertParagraph");
      if (l) document.execCommand("insertText", false, l);
    }));
    afterEdit();
  });
  editor.addEventListener("click", toggleBoxAtCaret);
  editor.addEventListener("blur", flush);
  search.addEventListener("input", renderList);
  $("btn-new").onclick = newMemo;
  $("btn-delete").onclick = deleteCurrent;
  $("btn-pin").onclick = togglePin;
  $("btn-folder").onclick = (e) => folderMenu(e.currentTarget);
  $("btn-font").onclick = cycleZoom;
  $("btn-check").onclick = toggleChecklist;
  $("f-size").onclick = (e) => sizeMenu(e.currentTarget);
  $("f-color").onclick = (e) => colorMenu(e.currentTarget);
  $("f-bold").onclick = () => fmt("bold");
  $("f-italic").onclick = () => fmt("italic");
  $("f-under").onclick = () => fmt("underline");
  $("f-clear").onclick = () => fmt("removeFormat");
  // Keep the editor's caret/selection when tapping toolbar buttons and menu items.
  for (const el of [$("fmt-bar"), $("editor-head"), menu])
    for (const ev of ["mousedown", "pointerdown"])
      el.addEventListener(ev, (e) => { if (e.target.closest("button")) e.preventDefault(); });
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

  // ---------- start ----------
  (async () => {
    setContent("");
    await reload();
    const first = memos.find((m) => filter == null || m.folder === filter);
    if (!narrow() && first) await select(first.id);
    renderStatus();
    setInterval(renderStatus, 30000); // keeps "동기화됨 HH:MM" fresh
  })();
})();
