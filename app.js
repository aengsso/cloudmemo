// Shared UI. Talks only to window.api, which is provided either by the
// Windows exe (Go bindings) or by api-web.js (iPhone / browser).
(function () {
  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const app = $("app"), list = $("list"), editor = $("editor"), search = $("search"), menu = $("menu");
  // Per-device settings: the desktop app provides window.cmStorage (saved to prefs.json),
  // because its page has no web origin and localStorage would not persist there.
  const prefStore = window.cmStorage || (() => { try { return window.localStorage; } catch (e) { return null; } })();

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

  // Secret folder: its memos are encrypted (crypt.go / api-web.js) and the password lives in
  // memory only, so closing the app or staying away RELOCK_MS locks it again.
  const LOCK_MARKER = "<!--cloudmemo-locked-->";
  const isLocked = (b) => b.startsWith(LOCK_MARKER);
  const SECRET = "@secret";          // filter value of the secret-folder chip
  const RELOCK_MS = 30000;
  let vault = null;                  // { pw, salt, plain: Map(id -> { cipher, text }) } while unlocked
  const pendingSecret = new Set();   // memos created in the secret folder that have no text yet
  const isSecret = (m) => isLocked(m.body) || pendingSecret.has(m.id);
  const saltOf = (b) => b.slice(LOCK_MARKER.length).split(".")[1] || "";
  // Readable body of a memo; null for a locked memo we can't open (vault closed or another password).
  function bodyOf(m) {
    if (!isLocked(m.body)) return m.body;
    const e = vault && vault.plain.get(m.id);
    return e && e.cipher === m.body ? e.text : null;
  }
  const textOf = (m) => bodyOf(m) ?? "";

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
  const BLOCK = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "DETAILS", "SUMMARY"]);
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
        else if (c.nodeName === "HR") { end(); lines.push("―――"); }
        else if (BLOCK.has(c.nodeName)) { end(); walk(c); end(); }
        else if (c.nodeType === 1) walk(c);
      }
    })(root);
    end();
    return lines.map((l) => l.replace(/ /g, " ").replace(ZW, ""));
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
  // Highlighter: translucent backgrounds (the browser writes <span style="background-color">),
  // so the text under them stays readable in both light and dark themes.
  const HIGHLIGHTS = [
    { v: "rgba(255, 212, 0, 0.4)", n: "노랑" },
    { v: "rgba(64, 192, 87, 0.3)", n: "초록" },
    { v: "rgba(240, 101, 149, 0.3)", n: "분홍" },
    { v: "rgba(77, 171, 247, 0.3)", n: "파랑" },
  ];
  const rgba = (s) => {
    const m = String(s || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
    return m && [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
  };
  // Canonical highlight value for an element's background, or "" if it isn't one of ours.
  function normHighlight(bg) {
    const c = rgba(bg);
    if (!c) return "";
    const h = HIGHLIGHTS.find((x) => { const p = rgba(x.v); return p[0] === c[0] && p[1] === c[1] && p[2] === c[2] && Math.abs(p[3] - c[3]) < 0.03; });
    return h ? h.v : "";
  }
  // Only these tags/attributes survive; everything else is unwrapped or dropped.
  const TAGS = { B: "B", STRONG: "B", I: "I", EM: "I", U: "U", FONT: "FONT", SPAN: "SPAN", MARK: "SPAN",
                 S: "S", STRIKE: "S", DEL: "S", CODE: "CODE", TIME: "TIME",
                 BR: "BR", HR: "HR", DIV: "DIV", P: "DIV",
                 LI: "DIV", H1: "DIV", H2: "DIV", H3: "DIV", H4: "DIV", H5: "DIV", H6: "DIV", BLOCKQUOTE: "DIV", PRE: "DIV",
                 SUMMARY: "DIV" };
  const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "IMG", "VIDEO",
                        "AUDIO", "CANVAS", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "HEAD", "TITLE", "META", "LINK"]);
  // Notion-style line types, kept as data-b on the line's <div> (headings, lists, quote, ...).
  const BTYPES = new Set(["h1", "h2", "h3", "ul", "ol", "quote", "callout", "code", "toggle"]);
  // Indent level of a line (data-i, 1..MAX_IND): nested lists and toggle contents.
  const MAX_IND = 4;
  function indentOf(n) {
    const v = Math.floor(+n.getAttribute("data-i"));
    if (v >= 1 && v <= MAX_IND) return v;
    if (n.nodeName === "LI") { // pasted nested lists: depth of the surrounding <ul>/<ol>
      let d = -1;
      for (let p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) if (p.nodeName === "UL" || p.nodeName === "OL") d++;
      return Math.max(0, Math.min(MAX_IND, d));
    }
    return 0;
  }
  function blockTypeOf(n) {
    const b = n.getAttribute("data-b");
    if (BTYPES.has(b)) return b;
    switch (n.nodeName) {
      case "SUMMARY": return "toggle";
      case "H1": return "h1";
      case "H2": return "h2";
      case "H3": case "H4": case "H5": case "H6": return "h3";
      case "BLOCKQUOTE": return "quote";
      case "PRE": return "code";
      case "LI": return n.parentNode && n.parentNode.nodeName === "OL" ? "ol" : "ul";
    }
    return "";
  }
  const ZW = /​/g; // zero-width space used to step out of inline code/bold made by typing
  function cleanInto(src, dst) {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { const v = n.nodeValue.replace(ZW, ""); if (v) dst.appendChild(document.createTextNode(v)); continue; }
      if (n.nodeType !== 1 || DROP.has(n.nodeName)) continue;
      const tag = TAGS[n.nodeName];
      if (!tag || (tag === "CODE" && n.parentNode && n.parentNode.closest && n.parentNode.closest("pre"))) { cleanInto(n, dst); continue; }
      const el = document.createElement(tag);
      if (tag === "DIV") {
        const b = blockTypeOf(n), ind = indentOf(n);
        if (b) el.dataset.b = b;
        if (ind) el.dataset.i = ind;
        if (b === "toggle" && n.getAttribute("data-c") === "1") el.dataset.c = "1";
      }
      if (tag === "TIME") { const d = n.getAttribute("datetime"); if (/^[\d\-T:]{4,19}$/.test(d || "")) el.setAttribute("datetime", d); }
      if (tag === "FONT") {
        const c = normColor(n.getAttribute("color"));
        if (c) el.setAttribute("color", c);
        const s = n.getAttribute("size");
        if (/^[1-7]$/.test(s || "")) el.setAttribute("size", s);
        if (!el.attributes.length) { cleanInto(n, dst); continue; }
      }
      if (tag === "SPAN") { // only highlighter spans survive (<mark> from other pages → yellow)
        const h = n.nodeName === "MARK" ? HIGHLIGHTS[0].v : normHighlight(n.style && n.style.backgroundColor);
        if (!h) { cleanInto(n, dst); continue; }
        el.style.backgroundColor = h;
      }
      if (tag !== "BR" && tag !== "HR") cleanInto(n, el);
      dst.appendChild(el);
    }
  }
  // Every top-level node becomes a <div> line; empty lines get a <br> so they keep their height.
  // One visual line = one top-level <div>. Pasted HTML and some edits can leave several lines
  // inside one block (nested <div>s or <br> breaks); the checklist, Enter handling and the
  // presentation all work per top-level line, so those blocks are split back into lines.
  const CARET_ID = "cm-caret";
  // A <br> only ends its line if nothing visible follows it inside the line (the browser's
  // placeholder in an empty or just-finished line).
  function trailingBr(br, line) {
    for (let n = br; n && n !== line; n = n.parentNode)
      for (let s = n.nextSibling; s; s = s.nextSibling)
        if (s.textContent || (s.nodeType === 1 && (s.nodeName === "BR" || s.querySelector("br")))) return false;
    return true;
  }
  function hasMergedLines(root) {
    for (const n of root.childNodes) {
      if (n.nodeType !== 1) return true;
      if (n.nodeName === "HR") continue;
      if (n.nodeName !== "DIV" || n.querySelector("div,p,li")) return true;
      for (const br of n.querySelectorAll("br")) if (!trailingBr(br, n)) return true;
    }
    return false;
  }
  function splitLines(root) {
    const out = document.createDocumentFragment();
    let cur = document.createElement("div"), open = []; // open: [original inline element, its clone in cur]
    // Line attributes (type, indent, folded) of the block being walked; its lines keep them.
    let at = { b: "", i: 0, c: "" };
    const stamp = () => {
      if (at.b && !cur.dataset.b) cur.dataset.b = at.b;
      if (at.i && !cur.dataset.i) cur.dataset.i = at.i;
      if (at.c && at.b === "toggle" && !cur.dataset.c) cur.dataset.c = at.c;
    };
    const filled = () => cur.childNodes.length > 0;
    const push = () => {
      if (!cur.firstChild) cur.appendChild(document.createElement("br"));
      stamp();
      out.appendChild(cur); cur = document.createElement("div"); open = [];
    };
    const place = (node, stack) => { // put node into cur under clones of its inline ancestors
      if (!cur.firstChild) stamp();
      let k = 0;
      while (k < open.length && k < stack.length && open[k][0] === stack[k]) k++;
      open.length = k;
      let parent = k ? open[k - 1][1] : cur;
      for (; k < stack.length; k++) {
        const c = stack[k].cloneNode(false);
        parent.appendChild(c); open.push([stack[k], c]); parent = c;
      }
      parent.appendChild(node);
    };
    (function walk(node, stack) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { if (c.nodeValue) place(c.cloneNode(), stack); }
        else if (c.nodeType !== 1) continue;
        else if (c.id === CARET_ID) place(c.cloneNode(false), stack);
        else if (c.nodeName === "BR") push();
        else if (c.nodeName === "HR") { if (filled()) push(); out.appendChild(document.createElement("hr")); }
        else if (BLOCK.has(c.nodeName)) {
          if (filled()) push();
          const outer = at, b = blockTypeOf(c), i = indentOf(c);
          at = { b: b || outer.b, i: i || outer.i, c: b ? c.getAttribute("data-c") || "" : outer.c };
          walk(c, []);
          if (filled()) push();
          at = outer;
        }
        else walk(c, [...stack, c]);
      }
    })(root, []);
    if (filled()) push();
    return out;
  }
  // Splits merged lines in the editor itself, keeping the caret where it was.
  function fixLines() {
    if (!hasMergedLines(editor)) return false;
    let mark = null;
    if (inEditor() && sel().isCollapsed) {
      mark = Object.assign(document.createElement("span"), { id: CARET_ID });
      sel().getRangeAt(0).insertNode(mark);
    }
    editor.replaceChildren(splitLines(editor));
    const m = editor.querySelector("#" + CARET_ID);
    if (m) {
      const r = document.createRange();
      r.setStartBefore(m); r.collapse(true);
      m.remove();
      sel().removeAllRanges(); sel().addRange(r);
    }
    return true;
  }
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

  const RICH = "b,i,u,font,strong,em,hr,mark,s,strike,del,code,time,div[data-b],div[data-i],summary,h1,h2,h3,h4,h5,h6,blockquote,pre,li";
  const hasRich = (root) => !!root.querySelector(RICH) ||
    [...root.querySelectorAll("span[style]")].some((s) => normHighlight(s.style.backgroundColor));
  function serialize() {
    if (!hasRich(editor)) return linesOf(editor).join("\n");
    const box = document.createElement("div");
    cleanInto(editor, box);
    return HTML_MARKER + box.innerHTML;
  }
  // body: readable text to show; stored: the memo body as saved (differs for locked memos).
  function setContent(body, stored = body) {
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
    editor.replaceChildren(hasMergedLines(frag) ? splitLines(frag) : frag);
    applyFolds();
    shownBody = stored;
    savedBody = serialize();
    updateEmpty();
    resetHistory();
  }

  // ---------- undo / redo ----------
  // The app keeps its own history of editor states: many edits here (typed shortcuts, line
  // types, indent, toggles) change the DOM directly, which the browser's own undo can't follow.
  // Each entry is the editor after a step; typing in a row is merged into one step.
  const TEXT_KINDS = new Set(["insertText", "insertCompositionText", "deleteContentBackward", "deleteContentForward"]);
  let hist = [], histAt = -1;
  function snapshot(kind) {
    const p = document.activeElement === editor ? caretPos() : null;
    return { html: editor.innerHTML, caret: p, kind, t: Date.now() };
  }
  function resetHistory() { hist = [snapshot("base")]; histAt = 0; }  function record(kind = "op") {
    if (histAt < 0) resetHistory();
    const top = hist[histAt], html = editor.innerHTML;
    if (top.html === html) { top.caret = (document.activeElement === editor && caretPos()) || top.caret; return; }
    hist.length = histAt + 1; // a new change drops the redo steps
    const s = snapshot(kind);
    if (histAt > 0 && TEXT_KINDS.has(kind) && top.kind === kind && s.t - top.t < 1500) hist[histAt] = s;
    else { hist.push(s); histAt++; }
    if (hist.length > 300) { hist.shift(); histAt--; }
  }
  function restoreState(s) {
    closeMenu();
    editor.innerHTML = s.html;
    if (!editor.firstChild) editor.innerHTML = "<div><br></div>";
    editor.focus({ preventScroll: true });
    if (s.caret) restoreCaret(s.caret);
    else { const l = editor.lastElementChild; caretAt(l, l.textContent.length); }
    updateEmpty(); applyFolds(); updateBlockState();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }
  function undo() {
    if (!currentId || composing) return;
    record(); // keep the latest typing as its own step first
    if (histAt <= 0) return;
    histAt--;
    // Put the caret where the undone change was.
    restoreState({ ...hist[histAt], caret: hist[histAt + 1].caret || hist[histAt].caret });
  }
  function redo() {
    if (!currentId || composing || histAt >= hist.length - 1) return;
    histAt++;
    restoreState(hist[histAt]);
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
  const lsGet = (k, d) => { try { const v = prefStore.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { prefStore.setItem(k, JSON.stringify(v)); } catch (e) {} };
  let extraFolders = lsGet(FOLDERS_KEY, []);  // folders made on this device that may still be empty
  let filter = lsGet(FILTER_KEY, null);       // null = 전체
  if (filter === "@secret") filter = null;    // the secret folder always starts locked
  const cleanFolder = (f) => Array.from(String(f || "").trim()).slice(0, 30).join("");
  function folderNames() {
    const s = new Set(extraFolders);
    for (const m of memos) if (m.folder) s.add(m.folder);
    return [...s].sort((a, b) => a.localeCompare(b, "ko"));
  }
  function setFilter(f) { filter = f; lsSet(FILTER_KEY, f); renderAll(); }
  const LOCK_ICON = (open) => `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5" fill="currentColor"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 ${open ? "6.9-.8" : "7 0v2.5"}" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;
  function renderFolders() {
    const names = folderNames();
    if (filter != null && filter !== SECRET && !names.includes(filter)) { filter = null; lsSet(FILTER_KEY, null); }
    const chip = (label, data, on) =>
      `<button class="chip${on ? " on" : ""}" ${data} role="tab" aria-selected="${on}">${esc(label)}</button>`;
    const showMore = filter != null && (filter !== SECRET || vault);
    $("folders").innerHTML =
      chip("전체", `data-all="1"`, filter == null) +
      names.map((n) => chip(n, `data-f="${esc(n)}"`, filter === n)).join("") +
      `<button class="chip secret${filter === SECRET ? " on" : ""}" data-secret="1" role="tab" aria-selected="${filter === SECRET}" title="${vault ? "비밀 폴더 (열림)" : "비밀 폴더 (잠김)"}">${LOCK_ICON(!!vault)}비밀</button>` +
      (showMore ? `<button class="chip ghost" id="folder-more" title="${filter === SECRET ? "잠그기·비밀번호 바꾸기" : "폴더 이름 바꾸기·삭제"}" aria-label="폴더 관리">⋯</button>` : "") +
      `<button class="chip ghost" id="folder-add" title="새 폴더" aria-label="새 폴더">+ 폴더</button>`;
  }

  // ---------- secret folder ----------
  async function decryptAll() {
    if (!vault) return;
    for (const m of memos) {
      if (!isLocked(m.body)) continue;
      const e = vault.plain.get(m.id);
      if (e && e.cipher === m.body) continue;
      try { vault.plain.set(m.id, { cipher: m.body, text: await api.decrypt(vault.pw, m.body) }); }
      catch (err) { vault.plain.delete(m.id); } // made with another password: listed but not openable
    }
  }
  async function encryptFor(text) {
    const enc = await api.encrypt(vault.pw, vault.salt, text);
    if (!vault.salt) vault.salt = saltOf(enc);
    return enc;
  }
  // Asks for the password (or sets one up the first time). Returns true when unlocked.
  async function unlockVault() {
    if (vault) return true;
    const locked = memos.filter((m) => isLocked(m.body));
    if (!locked.length) {
      const pw = await askPassword({
        title: "비밀번호 만들기", confirm: true,
        note: "비밀 폴더와 잠긴 일기는 이 비밀번호로 암호화돼서 드라이브에서도 읽을 수 없어. 비밀번호를 잊으면 아무도 되살릴 수 없으니 꼭 기억해 둬. 다른 기기에서도 같은 비밀번호를 써.",
      });
      if (!pw) return false;
      vault = { pw, salt: "", plain: new Map() };
    } else {
      const pw = await askPassword({
        title: "비밀번호 입력",
        check: async (pw) => { try { await api.decrypt(pw, locked[0].body); return ""; } catch (e) { return "비밀번호가 틀렸어"; } },
      });
      if (!pw) return false;
      vault = { pw, salt: saltOf(locked[0].body), plain: new Map() };
      await decryptAll();
    }
    return true;
  }
  async function openSecret() {
    if (await unlockVault()) setFilter(SECRET);
    else renderFolders();
  }
  async function lockVault() {
    if (!vault) return;
    const cur = memos.find((x) => x.id === currentId);
    if (cur && isSecret(cur)) {
      await leaveCurrent();
      currentId = null; setContent("");
      if (narrow()) { app.classList.add("show-list"); app.classList.remove("show-editor"); }
    }
    vault = null;
    pendingSecret.clear();
    renderAll();
  }
  async function moveToSecret() {
    const m = memos.find((x) => x.id === currentId);
    if (!m || !(await unlockVault())) return;
    await flush();
    const text = serialize(); // the editor holds this memo, now saved
    const enc = await encryptFor(text);
    await api.save(m.id, enc);
    if (m.folder) await api.setFolder(m.id, "");
    vault.plain.set(m.id, { cipher: enc, text });
    if (!plain(text).trim()) pendingSecret.add(m.id);
    shownBody = enc;
    memos = await api.list();
    setFilter(SECRET);
    renderEditor();
    flashMeta("비밀 폴더로 옮김");
  }
  async function leaveSecret() {
    const m = memos.find((x) => x.id === currentId);
    if (!m || !vault) return;
    await flush();
    const text = serialize(); // decrypted text shown in the editor, now saved
    await api.save(m.id, text);
    vault.plain.delete(m.id);
    pendingSecret.delete(m.id);
    shownBody = text;
    memos = await api.list();
    setFilter(null);
    renderEditor();
    flashMeta("비밀 해제됨");
  }
  async function changePassword() {
    if (!vault) return;
    const pw = await askPassword({
      title: "새 비밀번호", confirm: true,
      note: "비밀 메모를 모두 새 비밀번호로 다시 잠가. 다른 기기에서도 새 비밀번호로 열어야 해.",
    });
    if (!pw) return;
    await flush();
    let salt = "";
    for (const m of memos.filter((x) => isLocked(x.body) && bodyOf(x) != null)) {
      const enc = await api.encrypt(pw, salt, bodyOf(m));
      salt = salt || saltOf(enc);
      await api.save(m.id, enc);
    }
    vault = { pw, salt, plain: new Map() };
    memos = await api.list();
    await decryptAll();
    const cur = memos.find((x) => x.id === currentId);
    if (cur && isSecret(cur)) shownBody = cur.body;
    renderAll();
    flashMeta("비밀번호를 바꿨어");
  }

  // Password sheet. check(pw) may return an error message to keep it open.
  function askPassword(o) {
    return new Promise((resolve) => {
      const modal = $("modal"), form = $("pw-form"), p1 = $("pw1"), p2 = $("pw2"), err = $("pw-err");
      $("pw-title").textContent = o.title;
      $("pw-note").textContent = o.note || "";
      $("pw-note").hidden = !o.note;
      p1.value = p2.value = ""; p2.hidden = !o.confirm; err.textContent = "";
      modal.hidden = false;
      setTimeout(() => p1.focus(), 30);
      const done = (v) => { modal.hidden = true; form.onsubmit = null; $("pw-cancel").onclick = null; resolve(v); };
      $("pw-cancel").onclick = () => done(null);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const v = p1.value;
        if (v.length < 4) { err.textContent = "4글자 이상으로 해줘"; return; }
        if (o.confirm && v !== p2.value) { err.textContent = "두 비밀번호가 달라"; return; }
        if (o.check) {
          err.textContent = "확인 중…";
          const msg = await o.check(v);
          if (msg) { err.textContent = msg; p1.select(); return; }
        }
        done(v);
      };
    });
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
    if (filter === SECRET && !vault) {
      list.innerHTML = `<li class="none locked">${LOCK_ICON(false)}<p>비밀 폴더가 잠겨 있어</p>
        <button class="text-btn primary" id="unlock-btn">비밀번호 입력</button></li>`;
      return;
    }
    let shown = memos.filter((m) => !isDiary(m) && (filter === SECRET ? isSecret(m) : !isSecret(m)));
    if (filter != null && filter !== SECRET) shown = shown.filter((m) => m.folder === filter);
    if (q) shown = shown.filter((m) => plain(textOf(m)).toLowerCase().includes(q));
    if (!shown.length) {
      list.innerHTML = `<li class="none">${q ? "검색 결과 없음" : filter != null ? "이 폴더에 메모가 없어" : "메모가 없어"}</li>`;
      return;
    }
    const item = (m) => {
      const body = bodyOf(m);
      if (body == null) {
        return `<li data-id="${m.id}" class="unreadable" role="option"><div class="t">다른 비밀번호로 잠긴 메모</div>
           <div class="s"><b>${fmtDate(m.updated)}</b>지금 비밀번호로는 열 수 없어</div></li>`;
      }
      const p = progress(body);
      const f = filter == null && m.folder ? `<em>${esc(m.folder)}</em>` : "";
      return `<li data-id="${m.id}" class="${m.id === currentId ? "active" : ""}" role="option">
         <div class="t">${esc(title(body))}</div>
         <div class="s"><b>${fmtDate(m.updated)}</b>${f}${p ? `<i>${p}</i>` : ""}${esc(snippet(body))}</div>
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
    const diary = !!(m && isDiary(m));
    editor.classList.toggle("diary", diary);
    $("btn-folder").hidden = pin.hidden = diary; // diary entries live in the calendar, not in folders
    const fb = $("btn-folder"), secret = !!(m && isSecret(m));
    fb.classList.toggle("on", !!(m && (m.folder || secret)));
    fb.title = secret ? "비밀 폴더" : m && m.folder ? `폴더: ${m.folder}` : "폴더로 옮기기";
    if (metaNote) { $("editor-meta").textContent = metaNote; return; }
    if (!m) { $("editor-meta").textContent = ""; return; }
    const date = new Date(m.updated).toLocaleString("ko-KR", narrow()
      ? { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    if (diary) { $("editor-meta").textContent = `${diaryLabel(m.diary)} 일기`; return; }
    const where = secret ? "비밀" : m.folder;
    $("editor-meta").textContent = where ? `${where} · ${date}` : date;
  }
  function renderAll() { renderFolders(); renderList(); renderDiary(); renderEditor(); $("browse-name").textContent = tab === "diary" ? "일기" : filter === SECRET ? "비밀" : filter == null ? "전체" : filter; }

  // ---------- diary (memos with a "YYYY-MM-DD" date; shown in the 일기 tab as a calendar) ----------
  const TAB_KEY = "cloudmemo.tab";
  let tab = lsGet(TAB_KEY, "memo") === "diary" ? "diary" : "memo";
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const WD = ["일", "월", "화", "수", "목", "금", "토"];
  const dayOf = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const diaryLabel = (s) => { const d = dayOf(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`; };
  let calMonth = new Date(); calMonth.setDate(1);
  const isDiary = (m) => !!m.diary;
  const written = (m) => isDiary(m) && bodyOf(m) != null && plain(textOf(m)).trim();
  // Diary lock: entries are encrypted with the secret-folder password. It is on when any
  // entry is encrypted (so it follows sync), or when turned on here before any entry exists.
  const DIARY_LOCK_KEY = "cloudmemo.diaryLock";
  const diaryLocked = () => lsGet(DIARY_LOCK_KEY, false) || memos.some((m) => isDiary(m) && isLocked(m.body));
  async function lockDiaryOn() {
    if (!(await unlockVault())) return;
    if (!confirm("일기를 모두 비밀번호로 잠글까?\n비밀 폴더와 같은 비밀번호를 써. 비밀번호를 잊으면 일기를 되살릴 수 없어.")) return;
    await flush();
    for (const m of memos.filter((x) => isDiary(x) && !isLocked(x.body) && plain(x.body).trim())) {
      const enc = await encryptFor(m.body);
      await api.save(m.id, enc);
      vault.plain.set(m.id, { cipher: enc, text: m.body });
    }
    for (const m of memos) if (isDiary(m) && !isLocked(m.body)) pendingSecret.add(m.id); // empty new entries
    lsSet(DIARY_LOCK_KEY, true);
    memos = await api.list();
    const cur = memos.find((x) => x.id === currentId);
    if (cur && isDiary(cur)) shownBody = cur.body;
    renderAll();
    flashMeta("일기를 잠갔어");
  }
  async function lockDiaryOff() {
    if (!vault || !confirm("일기 잠금을 풀까? 일기가 다시 암호화 없이 저장돼.")) return;
    await flush();
    for (const m of memos.filter((x) => isDiary(x) && isLocked(x.body))) {
      const text = bodyOf(m);
      if (text == null) continue; // made with another password: leave it locked
      await api.save(m.id, text);
      vault.plain.delete(m.id);
    }
    for (const m of memos) if (isDiary(m)) pendingSecret.delete(m.id);
    lsSet(DIARY_LOCK_KEY, false);
    memos = await api.list();
    const cur = memos.find((x) => x.id === currentId);
    if (cur && isDiary(cur)) shownBody = cur.body;
    renderAll();
    flashMeta("일기 잠금을 풀었어");
  }
  function diaryLockMenu(anchor) {
    if (!diaryLocked()) { openMenu(anchor, [{ label: "일기 잠그기 (비밀번호)", onPick: lockDiaryOn }]); return; }
    if (!vault) { unlockVault().then(renderAll); return; }
    openMenu(anchor, [
      { label: "지금 잠그기", onPick: lockVault },
      { label: "일기 잠금 풀기", onPick: lockDiaryOff },
    ]);
  }
  async function setTab(t) {
    tab = t; lsSet(TAB_KEY, t);
    app.classList.toggle("tab-diary", t === "diary");
    for (const b of $("tabs").children) {
      const on = b.dataset.tab === t;
      b.classList.toggle("on", on); b.setAttribute("aria-selected", on);
    }
    const cur = memos.find((x) => x.id === currentId);
    if (cur && isDiary(cur) !== (t === "diary")) {
      // The open memo belongs to the other tab: close it so the editor matches the tab.
      await leaveCurrent();
      currentId = null; setContent("");
    }
    if (t === "diary" && cur && cur.diary) { calMonth = dayOf(cur.diary); calMonth.setDate(1); }
    renderAll();
  }
  function renderDiary() {
    if (tab !== "diary") return;
    const locked = diaryLocked(), closed = locked && !vault;
    const lb = $("cal-lock");
    lb.innerHTML = LOCK_ICON(!closed).replace('width="13" height="13"', 'width="18" height="18"');
    lb.classList.toggle("on", locked);
    lb.title = !locked ? "일기 잠그기" : closed ? "일기 열기" : "일기 잠금 (열림)";
    $("diary").classList.toggle("locked", closed);
    $("diary-locked").hidden = !closed;
    if (closed) { $("cal-title").textContent = "일기"; return; }
    const y = calMonth.getFullYear(), mo = calMonth.getMonth();
    $("cal-title").textContent = `${y}년 ${mo + 1}월`;
    const byDay = new Map();
    for (const m of memos) if (written(m)) (byDay.get(m.diary) || byDay.set(m.diary, []).get(m.diary)).push(m);
    const cur = memos.find((x) => x.id === currentId), selDay = cur && cur.diary;
    const first = new Date(y, mo, 1).getDay(), days = new Date(y, mo + 1, 0).getDate(), today = ymd(new Date());
    let html = WD.map((w, i) => `<span class="wd${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${w}</span>`).join("");
    for (let i = 0; i < first; i++) html += "<span></span>";
    for (let d = 1; d <= days; d++) {
      const key = `${y}-${pad(mo + 1)}-${pad(d)}`, list = byDay.get(key), dow = (first + d - 1) % 7;
      const cls = ["day", dow === 0 ? "sun" : dow === 6 ? "sat" : "", list ? "has" : "", key === today ? "today" : "", key === selDay ? "sel" : ""].filter(Boolean).join(" ");
      const tip = list ? esc(title(textOf(list[0]))) : "";
      html += `<button class="${cls}" data-date="${key}" title="${tip}" aria-label="${mo + 1}월 ${d}일${list ? ", 일기 있음" : ""}">${d}</button>`;
    }
    $("cal-grid").innerHTML = html;
    const prefix = `${y}-${pad(mo + 1)}-`;
    const inMonth = memos.filter((m) => written(m) && m.diary.startsWith(prefix))
      .sort((a, b) => b.diary.localeCompare(a.diary) || b.updated - a.updated);
    $("diary-list").innerHTML = inMonth.length
      ? inMonth.map((m) => `<li data-id="${m.id}" class="${m.id === currentId ? "active" : ""}">
          <div class="dd"><b>${+m.diary.slice(8)}</b><span>${WD[dayOf(m.diary).getDay()]}</span></div>
          <div class="dt"><div class="t">${esc(title(textOf(m)))}</div><div class="s">${esc(snippet(textOf(m)))}</div></div></li>`).join("")
      : `<li class="none">이 달에 쓴 일기가 없어. 날짜를 눌러서 써봐.</li>`;
  }
  // Opens the entry for a day, or starts a new one (discarded if left empty).
  async function openDiary(date) {
    if (diaryLocked() && !(await unlockVault())) { renderAll(); return; }
    const existing = memos.filter((m) => m.diary === date && bodyOf(m) != null).sort((a, b) => b.updated - a.updated)[0];
    if (existing) { await select(existing.id); return; }
    await leaveCurrent();
    const m = await api.create("", date);
    if (diaryLocked()) pendingSecret.add(m.id); // encrypted on first save
    memos.unshift(m);
    currentId = m.id;
    setContent("");
    renderAll();
    if (narrow()) showEditor();
    editor.focus();
    caretAt(editor.firstElementChild, 0);
  }

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
  // Korean/Japanese/Chinese input (IME): while a syllable is being composed (ㅎ → 하 → 한), the
  // editor must not be touched at all — no class changes, no DOM fixes, no caret moves, no
  // re-render — or the IME commits early and only single letters come out. Deferred work runs
  // on compositionend.
  let composing = false;
  document.addEventListener("selectionchange", () => {
    if (composing || !inEditor()) return;
    // A caret sitting directly in the editor (not in a line) would put typed text outside any
    // line; move it into the nearest line before anything is typed.
    const s = sel();
    if (s.isCollapsed && s.anchorNode === editor && editor.children.length) {
      const next = editor.childNodes[s.anchorOffset];
      if (next && next.nodeType === 1) caretAt(next, 0);
      else { const last = editor.lastElementChild; caretAt(last, last.textContent.length); }
      return;
    }
    lastRange = s.getRangeAt(0).cloneRange(); updateFmtState();
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
    updateBlockState();
    for (const [id, cmd] of [["f-bold", "bold"], ["f-italic", "italic"], ["f-under", "underline"], ["f-strike", "strikeThrough"]]) {
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
  function highlightMenu(anchor) {
    openMenu(anchor, [
      ...HIGHLIGHTS.map((h) => ({
        html: `<i class="sw hl" style="background:${h.v}"></i>${h.n}`,
        onPick: () => { fmt("hiliteColor", h.v); $("hl-bar").style.background = h.v; },
      })),
      "-",
      { html: `<i class="sw none"></i>형광펜 지우기`, onPick: () => fmt("hiliteColor", "transparent") },
    ]);
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
    focusEditor(); ensureLines(); fixLines();
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
  // Typing "[] " (or "[ ] ") at the start of a line makes it a checklist item; "[x] " a checked one.
  function autoBox() {
    const s = sel();
    if (!s.isCollapsed || !inEditor()) return;
    const line = lineOf(s.anchorNode);
    if (!line) return;
    const off = lineOffset(line, s.anchorNode, s.anchorOffset);
    const m = line.textContent.slice(0, off).replace(/ /g, " ").match(/^\s*\[( |x|X)?\] $/);
    if (!m) return;
    const box = (m[1] && m[1] !== " " ? DONE : OPEN) + " ";
    let ok = false;
    run(() => {
      selectIn(line, 0, off);
      ok = document.execCommand("insertText", false, box);
    });
    if (!ok) { // the browser refused a nested edit: change the text directly
      const r = sel().getRangeAt(0);
      r.deleteContents();
      r.insertNode(document.createTextNode(box));
      caretAt(line, box.length);
    }
  }
  function toggleBoxAtCaret() {
    if (!sel().isCollapsed || !inEditor()) return;
    fixLines();
    const line = lineOf(sel().anchorNode);
    if (!line) return;
    const t = line.textContent, c = t[0];
    if ((c !== OPEN && c !== DONE) || lineOffset(line, sel().anchorNode, sel().anchorOffset) > 1) return;
    run(() => editLine(line, 0, 1, c === OPEN ? DONE : OPEN));
    caretAt(line, Math.min(2, line.textContent.length));
    afterEdit();
  }
  // ---------- divider ----------
  function insertDivider() {
    if (!currentId) return;
    focusEditor(); ensureLines();
    run(() => document.execCommand("insertHorizontalRule"));
    fixAfterDivider();
    afterEdit();
  }
  // Keep an editable line right after a divider so typing continues below it.
  function fixAfterDivider() {
    const s = sel();
    if (!s.rangeCount) return;
    let hr = null;
    for (const h of editor.querySelectorAll("hr")) {
      const r = document.createRange(); r.selectNode(h);
      if (r.compareBoundaryPoints(Range.END_TO_START, s.getRangeAt(0)) <= 0) hr = h; // last hr before the caret
    }
    if (!hr) return;
    const line = lineOf(hr) || hr;
    let next = line.nextSibling;
    if (line !== hr && hr.nextSibling) return; // text follows the divider inside the same line
    if (!next || next.nodeName !== "DIV") {
      next = document.createElement("div");
      next.appendChild(document.createElement("br"));
      line.after(next);
    }
    caretAt(next, 0);
  }

  // ---------- line types (Notion-style blocks) ----------
  // ic: icon in menus, kb: shortcut shown in menus, k: search words for the "/" menu.
  const BLOCK_LIST = [
    { t: "p", n: "텍스트", s: "본문", ic: "T", kb: "Ctrl+Alt+0", k: "text 텍스트 본문 일반 p" },
    { t: "h1", n: "제목 1", s: "제목1", ic: "H1", kb: "# 스페이스", k: "h1 heading 제목1 제목 1 큰제목" },
    { t: "h2", n: "제목 2", s: "제목2", ic: "H2", kb: "## 스페이스", k: "h2 heading 제목2 제목 2 중간제목" },
    { t: "h3", n: "제목 3", s: "제목3", ic: "H3", kb: "### 스페이스", k: "h3 heading 제목3 제목 3 작은제목" },
    { t: "ul", n: "글머리 기호 목록", s: "글머리", ic: "•", kb: "- 스페이스", k: "bullet ul list 글머리 기호 목록 리스트 점" },
    { t: "ol", n: "번호 매기기 목록", s: "번호", ic: "1.", kb: "1. 스페이스", k: "number numbered ol list 번호 숫자 목록" },
    { t: "todo", n: "체크리스트", s: "체크", ic: "☐", kb: "[] 스페이스", k: "todo check checklist 체크리스트 할일 할 일" },
    { t: "toggle", n: "토글 목록", s: "토글", ic: "▸", kb: "> 스페이스", k: "toggle 토글 접기 펼치기 접는 목록" },
    { t: "quote", n: "인용", s: "인용", ic: "❝", kb: "\" 스페이스", k: "quote blockquote 인용 말머리" },
    { t: "callout", n: "콜아웃", s: "콜아웃", ic: "💡", kb: "Ctrl+Alt+9", k: "callout 콜아웃 강조 박스 상자 말머리 메모 알림" },
    { t: "code", n: "코드", s: "코드", ic: "</>", kb: "``` 입력", k: "code 코드 프로그램" },
    { t: "hr", n: "구분선", s: "구분선", ic: "―", kb: "--- 입력", k: "divider hr line 구분선 줄 선" },
  ];
  const blockOf = (line) => (line && line.dataset && BTYPES.has(line.dataset.b) ? line.dataset.b : "");
  const setType = (line, t) => {
    if (BTYPES.has(t)) line.dataset.b = t; else line.removeAttribute("data-b");
    if (t !== "toggle") line.removeAttribute("data-c");
  };

  // ---------- indent (Tab / Shift+Tab) ----------
  const indOf = (l) => (l && l.dataset ? +l.dataset.i || 0 : 0);
  const setInd = (l, n) => { n = Math.max(0, Math.min(MAX_IND, n)); if (n) l.dataset.i = n; else l.removeAttribute("data-i"); };
  function indent(delta) {
    if (!currentId) return;
    focusEditor(); ensureLines(); fixLines();
    const lines = selectedLines().filter((l) => l.nodeName === "DIV");
    if (!lines.length) return;
    const pos = sel().isCollapsed ? caretPos() : null;
    lines.forEach((l) => setInd(l, indOf(l) + delta));
    if (pos) restoreCaret(pos);
    afterEdit();
  }

  // ---------- toggles: a toggle line folds the lines indented under it ----------
  // data-c="1" on a toggle = folded (saved with the memo). Hidden lines get the "folded" class.
  function foldedSet(lines, isClosed) {
    const hidden = new Set();
    let hideAbove = -1;
    for (const l of lines) {
      const i = indOf(l);
      if (hideAbove >= 0 && i > hideAbove) { hidden.add(l); continue; }
      hideAbove = -1;
      if (l.dataset && l.dataset.b === "toggle" && isClosed(l)) hideAbove = i;
    }
    return hidden;
  }
  function applyFolds() {
    if (composing) return;
    const hidden = foldedSet([...editor.children], (l) => l.dataset.c === "1");
    for (const l of editor.children) l.classList.toggle("folded", hidden.has(l));
    if (!editor.querySelector(".folded")) return;
    // Never leave the caret inside a hidden line.
    const c = caretLine();
    if (c && c.line.classList.contains("folded")) {
      let t = c.line;
      while (t && t.classList.contains("folded")) t = t.previousElementSibling;
      if (t) caretAt(t, t.textContent.length);
    }
  }
  function toggleFold(line) {
    if (line.dataset.c === "1") line.removeAttribute("data-c"); else line.dataset.c = "1";
    applyFolds();
    afterEdit();
  }
  // Turns the selected lines into a type ("p" = plain text). Pressing the same type again
  // (e.g. Ctrl+Alt+1 on a heading) turns it back into text.
  function setBlock(t) {
    if (!currentId) return;
    if (t === "hr") { insertDivider(); return; }
    focusEditor(); ensureLines(); fixLines();
    const lines = selectedLines();
    if (!lines.length) return;
    if (t === "todo") {
      lines.forEach((l) => setType(l, ""));
      if (!lines.filter((l) => l.textContent.trim()).every((l) => BOX_RE.test(l.textContent)) || lines.every((l) => !l.textContent.trim()))
        toggleChecklist();
      updateBlockState();
      return;
    }
    const target = t !== "p" && lines.every((l) => blockOf(l) === t) ? "" : t;
    const pos = sel().isCollapsed ? caretPos() : null;
    let cut = 0;
    run(() => {
      for (const l of lines) {
        const m = target && l.textContent.match(BOX_RE); // a heading/list line drops its checkbox
        if (m) { editLine(l, 0, m[0].length, ""); if (l === lines[0]) cut = m[0].length; }
      }
    });
    lines.forEach((l) => setType(l, target));
    if (pos) restoreCaret({ i: pos.i, off: Math.max(0, pos.off - cut) });
    afterEdit(); updateBlockState();
  }
  function curBlock() {
    const line = inEditor() ? lineOf(sel().anchorNode) : null;
    if (!line) return "p";
    if (BOX_RE.test(line.textContent) && !blockOf(line)) return "todo";
    return blockOf(line) || "p";
  }
  function updateBlockState() {
    const b = BLOCK_LIST.find((x) => x.t === curBlock()) || BLOCK_LIST[0];
    $("f-block-name").textContent = b.s;
  }
  function blockMenu(anchor) {
    const cur = curBlock();
    openMenu(anchor, BLOCK_LIST.map((b) => ({
      html: `<span class="bi">${esc(b.ic)}</span><span class="bn">${esc(b.n)}</span><kbd>${esc(b.kb)}</kbd>`,
      checked: b.t === cur, onPick: () => setBlock(b.t),
    })));
  }

  // Typed shortcuts at the start of a line, finished with a space: "# " → heading, "- " → bullet, ...
  const MD_BLOCKS = [[/^#$/, "h1"], [/^##$/, "h2"], [/^###$/, "h3"], [/^[-*+•]$/, "ul"], [/^\d{1,3}[.)]$/, "ol"], [/^>$/, "toggle"], [/^["“”]$/, "quote"]];
  function caretLine() {
    const s = sel();
    if (!s.isCollapsed || !inEditor()) return null;
    const line = lineOf(s.anchorNode);
    return line ? { line, off: lineOffset(line, s.anchorNode, s.anchorOffset) } : null;
  }
  // Removes the first `len` characters of a line without execCommand (not allowed inside an
  // input handler) and puts the caret at the line start.
  function cutLineStart(line, len) {
    selectIn(line, 0, len);
    sel().getRangeAt(0).deleteContents();
    if (!line.textContent && !line.querySelector("br")) line.replaceChildren(document.createElement("br"));
    caretAt(line, 0);
  }
  function autoBlock(ch) {
    const c = caretLine();
    if (!c || blockOf(c.line) === "code") return false;
    const before = c.line.textContent.slice(0, c.off).replace(/ /g, " ");
    if (ch === " ") {
      const hit = MD_BLOCKS.find(([re]) => re.test(before.slice(0, -1)));
      if (!hit || !before.endsWith(" ")) return false;
      cutLineStart(c.line, c.off);
      setType(c.line, hit[1]);
      return true;
    }
    if (ch === "`" && before === "```") { cutLineStart(c.line, c.off); setType(c.line, "code"); return true; }
    if (ch === "-" && before === "---" && c.line.textContent.replace(/ /g, " ").trim() === "---") {
      const line = c.line;
      setTimeout(() => { // a divider needs execCommand, which only works outside the input event
        if (line.textContent.trim() !== "---") return;
        run(() => { editLine(line, 0, line.textContent.length, ""); document.execCommand("insertHorizontalRule"); });
        fixAfterDivider(); afterEdit();
      }, 0);
      return true;
    }
    return false;
  }
  // Inline marks typed Notion/Markdown style: **굵게**, *기울임*, `코드`, ~~취소선~~.
  function autoInline(ch) {
    const s = sel();
    if (!s.isCollapsed || !inEditor()) return false;
    const node = s.anchorNode;
    if (!node || node.nodeType !== 3) return false;
    const line = lineOf(node);
    if (!line || blockOf(line) === "code" || node.parentNode.closest("code")) return false;
    const before = node.nodeValue.slice(0, s.anchorOffset);
    let m = null, tag = "", full = "";
    if (ch === "*" && (m = before.match(/\*\*([^*\s](?:[^*]*?[^*\s])?)\*\*$/))) { tag = "b"; full = m[0]; }
    else if (ch === "*" && (m = before.match(/(?:^|[^*])\*([^*\s](?:[^*]*?[^*\s])?)\*$/))) { tag = "i"; full = "*" + m[1] + "*"; }
    else if (ch === "`" && (m = before.match(/`([^`]+)`$/))) { tag = "code"; full = m[0]; }
    else if (ch === "~" && (m = before.match(/~~([^~\s](?:[^~]*?[^~\s])?)~~$/))) { tag = "s"; full = m[0]; }
    if (!tag) return false;
    const start = s.anchorOffset - full.length;
    node.splitText(s.anchorOffset);
    node.nodeValue = node.nodeValue.slice(0, start);
    const el = document.createElement(tag);
    el.textContent = m[1];
    const z = document.createTextNode("​"); // caret goes after the mark, so typing continues plain
    node.after(el, z);
    const r = document.createRange();
    r.setStart(z, 1); r.collapse(true);
    sel().removeAllRanges(); sel().addRange(r);
    return true;
  }
  // Ctrl+E: selected text becomes inline code (or back to plain text).
  function toggleCode() {
    if (!currentId) return;
    focusEditor();
    const s = sel();
    if (!s.rangeCount) return;
    const inCode = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentNode).closest("code");
    if (inCode && editor.contains(inCode)) {
      const txt = document.createTextNode(inCode.textContent);
      inCode.replaceWith(txt);
      const r = document.createRange(); r.selectNodeContents(txt);
      sel().removeAllRanges(); sel().addRange(r);
    } else if (!s.isCollapsed) {
      const text = s.toString();
      if (!text.trim() || text.includes("\n") || selectedLines().length > 1) return;
      const c = document.createElement("code");
      c.textContent = text.replace(ZW, "");
      putInline(c, "​");
    } else return;
    afterEdit();
  }

  // ---------- "/" menu: type / at the start of a line or after a space ----------
  let slash = null; // { line, start, i, items }
  function slashCheck() {
    const c = caretLine();
    if (slash) {
      if (!c || c.line !== slash.line || c.off <= slash.start || c.line.textContent[slash.start] !== "/") { closeMenu(); return; }
      const q = c.line.textContent.slice(slash.start + 1, c.off);
      if (q.length > 24 || /\s\s/.test(q)) { closeMenu(); return; }
      slashRender(q);
      return;
    }
    if (!c || c.off < 1 || blockOf(c.line) === "code") return;
    const t = c.line.textContent;
    if (t[c.off - 1] !== "/" || (c.off > 1 && !/\s/.test(t[c.off - 2]))) return;
    slash = { line: c.line, start: c.off - 1, i: 0, items: [] };
    slashRender("");
  }
  function slashRender(q) {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const items = BLOCK_LIST.filter((b) => words.every((w) => (b.n + " " + b.k).toLowerCase().includes(w)));
    if (!items.length) { closeMenu(); return; }
    slash.items = items;
    slash.i = Math.min(slash.i, items.length - 1);
    menu.innerHTML = `<div class="menu-cap">블록 바꾸기 · ↑↓ 고르고 Enter</div>` + items.map((b, i) =>
      `<button role="menuitem" data-s="${i}" class="${i === slash.i ? "hot" : ""}"><span class="bi">${esc(b.ic)}</span><span class="bn">${esc(b.n)}</span><kbd>${esc(b.kb)}</kbd></button>`).join("");
    menu.hidden = false;
    menuAnchor = null;
    const r = sel().rangeCount ? sel().getRangeAt(0).getBoundingClientRect() : slash.line.getBoundingClientRect();
    const top = r.bottom || slash.line.getBoundingClientRect().bottom, left = r.left || slash.line.getBoundingClientRect().left;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + "px";
    menu.style.top = (top + 6 + h > innerHeight - 8 ? Math.max(8, top - h - 28) : top + 6) + "px";
    const hot = menu.querySelector(".hot");
    if (hot) hot.scrollIntoView({ block: "nearest" });
    menu.onclick = (e) => { const b = e.target.closest("button[data-s]"); if (b) slashPick(+b.dataset.s); };
  }
  function slashPick(i) {
    if (!slash) return;
    const { line, start, items } = slash, b = items[i];
    const c = caretLine();
    const end = c && c.line === line ? c.off : start + 1;
    closeMenu();
    if (!b) return;
    focusEditor();
    run(() => editLine(line, start, end, ""));
    caretAt(line, start);
    if (b.t === "hr" && !line.textContent.trim()) {
      run(() => { editLine(line, 0, line.textContent.length, ""); document.execCommand("insertHorizontalRule"); });
      fixAfterDivider(); afterEdit();
      return;
    }
    setBlock(b.t);
  }
  function slashKey(e) { // keys while the "/" menu is open; true if used
    if (!slash) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = slash.items.length;
      slash.i = (slash.i + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      const c = caretLine();
      slashRender(c ? c.line.textContent.slice(slash.start + 1, c.off) : "");
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) { e.preventDefault(); slashPick(slash.i); return true; }
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); return true; }
    return false;
  }

  // ---------- F5: current date and time as a small chip ----------
  function insertNow() {
    if (!currentId) return;
    focusEditor();
    const d = new Date();
    const time = d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
    const label = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]}) ${time}`;
    const iso = `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const t = document.createElement("time");
    t.setAttribute("datetime", iso);
    t.textContent = label;
    putInline(t, " ");
    afterEdit();
  }
  // Puts an inline element at the caret (replacing a selection) and the caret right after it.
  // Done on the DOM: insertHTML would wrap the following text in a span with fixed colors.
  function putInline(el, tail) {
    const r = sel().getRangeAt(0);
    r.deleteContents();
    const after = document.createTextNode(tail);
    r.insertNode(after);
    r.insertNode(el);
    const c = document.createRange();
    c.setStart(after, tail.length); c.collapse(true);
    sel().removeAllRanges(); sel().addRange(c);
  }

  // Enter on an item starts a new item; Enter on an empty item ends the list; "---" + Enter draws a divider.
  let boxNext = false;
  let enterFix = null; // line type to carry over (or not) after the browser splits the line
  function onEnter(e) {
    ensureLines(); fixLines();
    const line = inEditor() ? lineOf(sel().anchorNode) : null;
    const t = line ? line.textContent : "";
    const bt = blockOf(line);
    // Enter on an empty list/quote/code line: first back out one indent level, then end it
    // (back to plain text), like Notion.
    const empty = line && !t.replace(ZW, "").trim() && e.inputType === "insertParagraph";
    if (empty && (bt || indOf(line)) && bt !== "h1" && bt !== "h2" && bt !== "h3") {
      e.preventDefault();
      if (indOf(line) && (CONTINUES.has(bt) || !bt)) setInd(line, indOf(line) - 1);
      else setType(line, "");
      afterEdit(); updateBlockState();
      return;
    }
    enterFix = null;
    if (line && bt !== "code" && /^\s*(-{3,}|―{3,}|={3,})\s*$/.test(t)) {
      e.preventDefault();
      run(() => { editLine(line, 0, t.length, ""); document.execCommand("insertHorizontalRule"); });
      fixAfterDivider();
      afterEdit();
      return;
    }
    const m = t.match(BOX_RE);
    if (m && !t.slice(m[0].length).trim()) {
      e.preventDefault();
      run(() => editLine(line, 0, m[0].length, ""));
      afterEdit();
      return;
    }
    boxNext = !!m;
    enterFix = line ? {
      type: bt, ind: indOf(line), shift: e.inputType === "insertLineBreak",
      atStart: !!t.replace(ZW, "").trim() && lineOffset(line, sel().anchorNode, sel().anchorOffset) === 0,
    } : null;
    if (e.inputType === "insertLineBreak") { // Shift+Enter: keep one line per block
      e.preventDefault();
      run(() => document.execCommand("insertParagraph"));
      afterParagraph();
    }
  }
  const CONTINUES = new Set(["ul", "ol", "quote", "callout", "code"]); // Enter keeps these types
  function afterParagraph() {
    const line = inEditor() ? lineOf(sel().anchorNode) : null;
    if (enterFix && line) {
      const f = enterFix, keep = f.shift || CONTINUES.has(f.type);
      const prev = line.previousElementSibling;
      if (f.atStart) { // the browser added an empty line above; the caret line is the original
        setType(line, f.type);
        if (prev && !keep) setType(prev, "");
        if (prev) prev.removeAttribute("data-c");
      } else if (f.type === "toggle" && !f.shift) {
        // Enter on a toggle opens it and starts its first line inside, like Notion.
        setType(line, "");
        setInd(line, f.ind + 1);
        if (prev && prev.dataset.b === "toggle") prev.removeAttribute("data-c");
      } else {
        setType(line, keep ? f.type : "");
        line.removeAttribute("data-c");
      }
    }
    enterFix = null;
    if (boxNext) {
      boxNext = false;
      if (line && !BOX_RE.test(line.textContent)) run(() => editLine(line, 0, 0, OPEN + " "));
    }
    afterEdit(); updateBlockState();
  }

  // ---------- font zoom for this device (whole editor) ----------
  const ZOOM = [{ s: 0.875, n: "작게" }, { s: 1, n: "보통" }, { s: 1.15, n: "크게" }, { s: 1.3, n: "아주 크게" }];
  const FS_KEY = "cloudmemo.fontSize";
  let fsIndex = 1;
  try { const i = +prefStore.getItem(FS_KEY); if (prefStore.getItem(FS_KEY) != null && ZOOM[i]) fsIndex = i; } catch (e) {}
  function applyZoom() { document.documentElement.style.setProperty("--fs", ZOOM[fsIndex].s); }
  function cycleZoom() {
    fsIndex = (fsIndex + 1) % ZOOM.length;
    applyZoom();
    try { prefStore.setItem(FS_KEY, String(fsIndex)); } catch (e) {}
    flashMeta("화면 글자 크기: " + ZOOM[fsIndex].n);
  }
  applyZoom();

  // ---------- appearance: mode / theme / accent (per device) ----------
  const LOOK_KEY = "cloudmemo.look";
  // h/t: background hue/tint, a: accent for the preview card (CSS has the real values).
  const THEMES = [
    { id: "", n: "클래식", h: 45, t: 17, a: "hsl(37 77% 44%)" },
    { id: "mint", n: "민트", h: 160, t: 20, a: "hsl(168 62% 34%)" },
    { id: "lavender", n: "라벤더", h: 255, t: 24, a: "hsl(258 52% 52%)" },
    { id: "ocean", n: "오션", h: 210, t: 24, a: "hsl(212 78% 44%)" },
    { id: "rose", n: "로즈", h: 345, t: 24, a: "hsl(345 62% 50%)" },
    { id: "mono", n: "모노", h: 0, t: 0, a: "hsl(0 0% 16%)" },
  ];
  const ACCENTS = ["#e5484d", "#f76b15", "#d9a400", "#30a46c", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#1d1d1f"];
  let look = { mode: "", theme: "", accent: "" };
  try { look = Object.assign(look, JSON.parse(prefStore.getItem(LOOK_KEY) || "{}")); } catch (e) {}
  function hexToHsl(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return null;
    const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = Math.round(h * 60 + 360) % 360;
    }
    return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
  }
  function applyLook() {
    const root = document.documentElement;
    if (look.theme) root.dataset.theme = look.theme; else delete root.dataset.theme;
    if (look.mode) root.dataset.mode = look.mode; else delete root.dataset.mode;
    const c = hexToHsl(look.accent);
    for (const k of ["--ah", "--as", "--al", "--al-d"]) root.style.removeProperty(k);
    if (c) {
      // Keep white text readable on it in light mode and dark text in dark mode.
      root.style.setProperty("--ah", c.h);
      root.style.setProperty("--as", c.s);
      root.style.setProperty("--al", Math.min(Math.max(c.l, 22), 48) + "%");
      root.style.setProperty("--al-d", Math.min(Math.max(c.l, 62), 80) + "%");
    }
    const bg = getComputedStyle(document.body).backgroundColor;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
  }
  function saveLook() {
    try { prefStore.setItem(LOOK_KEY, JSON.stringify(look)); } catch (e) {}
    applyLook(); renderSettings();
  }
  function renderSettings() {
    for (const b of $("set-mode").children) {
      const on = b.dataset.mode === look.mode;
      b.classList.toggle("on", on); b.setAttribute("aria-checked", on);
    }
    $("set-theme").innerHTML = THEMES.map((t) => `
      <button class="theme-card${t.id === look.theme ? " on" : ""}" data-theme="${t.id}" role="radio" aria-checked="${t.id === look.theme}">
        <span class="pv" style="background:hsl(${t.h} ${t.t * 0.5}% 99%)">
          <span class="sd" style="background:hsl(${t.h} ${t.t}% 92%)"><span class="dot" style="background:${t.a}"></span></span>
          <span class="mn"><span class="ln" style="background:hsl(${t.h} 10% 30%);width:80%"></span><span class="ln" style="background:hsl(${t.h} 10% 30%);width:55%"></span></span>
        </span>${t.n}</button>`).join("");
    const custom = look.accent && !ACCENTS.includes(look.accent);
    $("set-accent").innerHTML =
      `<button class="acc default${!look.accent ? " on" : ""}" data-accent="" title="테마 기본색" aria-label="테마 기본색" role="radio" aria-checked="${!look.accent}"></button>` +
      ACCENTS.map((a) => `<button class="acc${look.accent === a ? " on" : ""}" data-accent="${a}" style="background:${a}" aria-label="${a}" role="radio" aria-checked="${look.accent === a}"></button>`).join("") +
      `<label class="acc pick${custom ? " on" : ""}" title="직접 고르기"><input type="color" id="set-pick" value="${look.accent || "#c8861a"}" aria-label="강조색 직접 고르기"></label>`;
  }
  // Screen version: the ?v= of app.js on the web, data-ver set by the PC app (which inlines it).
  const UI_VER = document.documentElement.dataset.ver ||
    ((document.querySelector('script[src*="app.js"]') || {}).src || "").replace(/^.*[?&]v=(\d+).*$|^.*$/, "$1");
  function openSettings() {
    renderSettings();
    $("set-ver").textContent = UI_VER ? `· 버전 ${UI_VER}` : "";
    $("settings").hidden = false;
  }
  function closeSettings() { $("settings").hidden = true; }
  applyLook();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyLook);

  // ---------- presentation mode: dividers split the memo into pages ----------
  // Lines starting with "//" are speaker notes: hidden on slides, shown in the presenter view.
  // With the audience window open (presenter view), the projector window shows only the slide
  // and this window shows the slide, the next one, the notes and a timer.
  // Slide text size: Ctrl+wheel / +/- change it during a presentation only; every presentation
  // starts again at the default, so nothing stays enlarged after leaving.
  const PRESENT_SCALE = 0.7;
  try { prefStore && prefStore.removeItem("cloudmemo.presentScale"); } catch (e) {} // older versions kept it
  const pres = {
    on: false, pages: [], i: 0, ownFullscreen: false, hintTimer: null,
    aud: null, audWatch: null, t0: 0, clock: null, dpr: 1,
    scale: PRESENT_SCALE, flip: new Set(),
  };
  const isBlankLine = (l) => !l.textContent.trim() && !l.querySelector("hr");
  const isBreakLine = (l) => l.nodeName === "HR" || (!!l.querySelector("hr") && !l.textContent.trim());
  const isNoteLine = (l) => /^\s*\/\//.test(l.textContent);
  // Pages as lists of editor line indexes, without empty lines at their edges.
  function buildPages() {
    const pages = [[]];
    [...editor.children].forEach((l, i) => { if (isBreakLine(l)) pages.push([]); else pages[pages.length - 1].push(i); });
    return pages.map((p) => {
      while (p.length && isBlankLine(editor.children[p[0]])) p.shift();
      while (p.length && isBlankLine(editor.children[p[p.length - 1]])) p.pop();
      return p;
    }).filter((p) => p.length);
  }
  // Draws one page into a slide box (this window or the audience window); returns its notes.
  function renderSlide(page, idx) {
    page.replaceChildren();
    const notes = [];
    // Toggles show as they are in the memo; clicking one on the slide flips it for this
    // presentation only (pres.flip), so an answer can be revealed live.
    const closed = (l) => (l.dataset.c === "1") !== pres.flip.has([...editor.children].indexOf(l));
    const hidden = foldedSet(idx.map((i) => editor.children[i]).filter(Boolean), closed);
    for (const i of idx) {
      const line = editor.children[i];
      if (!line || hidden.has(line)) continue;
      if (isNoteLine(line)) { notes.push(line.textContent.replace(/^\s*\/\/\s?/, "")); continue; }
      const tmp = document.createElement("div");
      tmp.appendChild(line.cloneNode(true));
      const before = page.childNodes.length;
      cleanInto(tmp, page);
      const el = page.childNodes[before];
      if (el && el.nodeType === 1) {
        el.dataset.line = i;
        if (el.dataset.b === "toggle") { if (closed(line)) el.dataset.c = "1"; else el.removeAttribute("data-c"); }
        const c = el.textContent[0];
        if (c === OPEN || c === DONE) el.classList.add("box-line", ...(c === DONE ? ["done"] : []));
      }
    }
    // Font follows the box size and the chosen scale, then shrinks until the page fits.
    let size = Math.max(12, Math.min(page.clientWidth / 15, page.clientHeight / 8) * pres.scale);
    const fits = () => page.scrollHeight <= page.clientHeight + 1 && page.scrollWidth <= page.clientWidth + 1;
    page.style.setProperty("--efs", size + "px");
    while (!fits() && size > 10) { size *= 0.92; page.style.setProperty("--efs", size + "px"); }
    return notes;
  }
  function renderPage() {
    const idx = pres.pages[pres.i] || [], count = `${pres.i + 1} / ${pres.pages.length}`;
    const notes = renderSlide($("present-page"), idx);
    $("present-count").textContent = count;
    if (!pres.aud) return;
    const d = pres.aud.document;
    renderSlide(d.getElementById("present-page"), idx);
    d.getElementById("present-count").textContent = count;
    const nx = $("present-next"), next = pres.pages[pres.i + 1];
    if (next) renderSlide(nx, next);
    else nx.replaceChildren(Object.assign(document.createElement("div"), { className: "end-note", textContent: "마지막 장이야" }));
    const nt = $("present-notes");
    nt.textContent = notes.length ? notes.join("\n") : "이 장에는 노트가 없어.\n메모에서 // 로 시작하는 줄이 그 장의 노트가 되고, 슬라이드에는 안 보여.";
    nt.classList.toggle("empty", !notes.length);
  }
  function flashHint(text) {
    const hint = $("present-hint");
    hint.textContent = text;
    hint.classList.remove("fade");
    clearTimeout(pres.hintTimer);
    pres.hintTimer = setTimeout(() => hint.classList.add("fade"), 3500);
  }
  function setScale(v) {
    pres.scale = Math.round(Math.min(1, Math.max(0.3, v)) * 100) / 100;
    renderPage();
    flashHint(`글자 크기 ${Math.round(pres.scale * 100)}%`);
  }
  function startPresent() {
    if (!currentId) return;
    const pages = buildPages();
    if (!pages.length) { flashMeta("발표할 내용이 없어"); return; }
    flush();
    const caretLine = caretPos();
    pres.pages = pages;
    pres.i = Math.max(0, caretLine ? pages.findIndex((p) => p.includes(caretLine.i)) : 0);
    pres.on = true;
    pres.scale = PRESENT_SCALE;
    pres.flip = new Set();
    pres.dpr = devicePixelRatio;
    editor.blur();
    $("present").hidden = false;
    renderPage();
    flashHint("→ 다음 · ← 이전 · Ctrl+휠 글자 크기 · P 발표자 화면 · Esc 끝내기");
    // Browsers: go full screen (their first Esc leaves it, which ends the presentation too).
    // Desktop app: its window already shows only the slide, and staying out of full screen
    // keeps Esc reaching the page.
    const root = document.documentElement;
    if (!window.cmStorage && root.requestFullscreen && !document.fullscreenElement) {
      root.requestFullscreen().then(() => { pres.ownFullscreen = true; }).catch(() => {});
    }
  }
  function stopPresent() {
    if (!pres.on) return;
    pres.on = false;
    closeAudience();
    $("present").hidden = true;
    pres.scale = PRESENT_SCALE;
    if (pres.ownFullscreen && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    pres.ownFullscreen = false;
    // If the browser itself zoomed the page anyway, say how to undo it.
    if (Math.abs(devicePixelRatio - pres.dpr) > 0.01) flashMeta("화면 배율이 바뀌었어 · Ctrl+0으로 원래대로");
  }
  function goPage(d) {
    const n = Math.min(pres.pages.length - 1, Math.max(0, d));
    if (n !== pres.i) { pres.i = n; renderPage(); }
  }
  // Checking a box during the meeting edits the memo itself.
  function toggleBoxLine(i) {
    const line = editor.children[i];
    if (!line) return;
    const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode()) && !n.nodeValue) {}
    if (!n || (n.nodeValue[0] !== OPEN && n.nodeValue[0] !== DONE)) return;
    n.nodeValue = (n.nodeValue[0] === OPEN ? DONE : OPEN) + n.nodeValue.slice(1);
    afterEdit();
    renderPage();
  }

  // ---- presenter view: a second window for the projector ----
  function tick() {
    const s = Math.floor((Date.now() - pres.t0) / 1000);
    $("present-timer").textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
  }
  function audienceCSS() {
    return [...document.styleSheets].map((s) => {
      try { return [...s.cssRules].map((r) => r.cssText).join("\n"); } catch (e) { return ""; }
    }).join("\n");
  }
  function openAudience() {
    if (pres.aud && !pres.aud.closed) { pres.aud.focus(); return; }
    // The presenter window stays windowed so the audience window can sit on the projector.
    if (pres.ownFullscreen) { pres.ownFullscreen = false; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
    const w = window.open("", "cloudmemo-audience", "popup,width=1024,height=640");
    if (!w) { alert("발표 화면 창이 막혔어. 주소창 오른쪽의 팝업 차단 아이콘에서 허용해줘."); return; }
    const d = w.document;
    d.open();
    d.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>발표 화면 - 클라우드 메모</title>` +
      `<style>${audienceCSS()}</style></head><body><div id="present" class="audience">` +
      `<div id="present-page" class="present-page"></div><div class="present-bar">` +
      `<span id="present-hint">이 창을 프로젝터 화면으로 옮긴 뒤 F 키나 [전체 화면]을 눌러줘</span>` +
      `<span class="present-right"><span id="present-count"></span><button type="button" class="pb" id="aud-full">전체 화면</button></span>` +
      `</div></div></body></html>`);
    d.close();
    pres.aud = w;
    const full = () => { const r = d.documentElement; if (r.requestFullscreen) r.requestFullscreen().catch(() => {}); };
    d.addEventListener("keydown", (e) => {
      if (e.key === "f" || e.key === "F") { e.preventDefault(); full(); return; }
      presentKey(e);
    }, true);
    d.getElementById("present").addEventListener("click", (e) => {
      if (e.target.closest("#aud-full")) { full(); return; }
      goPage(pres.i + (e.clientX < w.innerWidth / 3 ? -1 : 1));
    });
    w.addEventListener("resize", () => { if (pres.aud) renderPage(); });
    w.addEventListener("wheel", wheelZoom, { passive: false });
    clearInterval(pres.audWatch);
    pres.audWatch = setInterval(() => { if (pres.aud && pres.aud.closed) closeAudience(); }, 700);
    $("present").classList.add("presenter");
    $("present-screen").textContent = "발표자 화면 닫기";
    pres.t0 = Date.now();
    tick();
    clearInterval(pres.clock);
    pres.clock = setInterval(tick, 1000);
    // On a second display, move the window there (Chrome asks for permission once).
    if (screen.isExtended && window.getScreenDetails) {
      window.getScreenDetails().then((sd) => {
        const o = sd.screens.find((s) => s !== sd.currentScreen);
        if (o && !w.closed) { w.moveTo(o.availLeft, o.availTop); w.resizeTo(o.availWidth, o.availHeight); }
      }).catch(() => {});
    }
    renderPage();
  }
  function closeAudience() {
    clearInterval(pres.audWatch); clearInterval(pres.clock);
    if (pres.aud && !pres.aud.closed) pres.aud.close();
    pres.aud = null;
    $("present").classList.remove("presenter");
    $("present-screen").textContent = "발표자 화면";
    if (pres.on) renderPage();
  }

  // ---- input: keys (this window and the audience window), Ctrl+wheel, clicks, swipes ----
  function presentKey(e) {
    if (!pres.on) return;
    const k = e.key;
    if (k === "Escape" || k === "Esc" || k === "F11") stopPresent();
    else if ((e.ctrlKey || e.metaKey) && k === "0") setScale(PRESENT_SCALE); // not the page zoom
    else if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " " || k === "Enter") goPage(pres.i + 1);
    else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") goPage(pres.i - 1);
    else if (k === "Home") goPage(0);
    else if (k === "End") goPage(pres.pages.length - 1);
    else if (k === "+" || k === "=") setScale(pres.scale + 0.1);
    else if (k === "-" || k === "_") setScale(pres.scale - 0.1);
    else if ((k === "p" || k === "P") && !e.ctrlKey && !e.metaKey) { if (pres.aud) closeAudience(); else openAudience(); }
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }
  function wheelZoom(e) {
    if (!pres.on || !(e.ctrlKey || e.metaKey) || e.defaultPrevented) return; // listened twice: once is enough
    e.preventDefault(); // instead of zooming the whole page
    setScale(pres.scale + (e.deltaY < 0 ? 0.05 : -0.05));
  }
  document.addEventListener("keydown", (e) => {
    if (!pres.on) {
      // F11 starts it in the desktop app (browsers keep F11 for their own full screen).
      if (e.key === "F11" && window.cmStorage && currentId) { e.preventDefault(); startPresent(); }
      return;
    }
    presentKey(e);
  }, true);
  // Backup for Esc: some hosts swallow its keydown but still deliver keyup.
  document.addEventListener("keyup", (e) => { if (pres.on && (e.key === "Escape" || e.key === "Esc")) stopPresent(); }, true);
  addEventListener("wheel", wheelZoom, { passive: false });
  document.addEventListener("wheel", wheelZoom, { passive: false, capture: true });
  document.addEventListener("fullscreenchange", () => {
    // Leaving full screen (the browser takes the first Esc for that) ends the presentation too.
    if (!document.fullscreenElement && pres.ownFullscreen) { pres.ownFullscreen = false; stopPresent(); }
  });
  addEventListener("resize", () => { if (pres.on) renderPage(); });
  addEventListener("pagehide", () => { if (pres.aud && !pres.aud.closed) pres.aud.close(); });
  $("present").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) {
      if (b.id === "present-close") stopPresent();
      else if (b.id === "present-prev") goPage(pres.i - 1);
      else if (b.id === "present-fwd") goPage(pres.i + 1);
      else if (b.id === "present-smaller") setScale(pres.scale - 0.1);
      else if (b.id === "present-bigger") setScale(pres.scale + 0.1);
      else if (b.id === "present-screen") { if (pres.aud) closeAudience(); else openAudience(); }
      return;
    }
    if (e.target.closest("#present-timer")) { pres.t0 = Date.now(); tick(); return; }
    if (e.target.closest(".presenter-side, .present-bar")) return;
    const box = e.target.closest("#present-page .box-line");
    if (box) { toggleBoxLine(+box.dataset.line); return; }
    const tg = e.target.closest('#present-page [data-b="toggle"]');
    if (tg) {
      const i = +tg.dataset.line;
      if (pres.flip.has(i)) pres.flip.delete(i); else pres.flip.add(i);
      renderPage();
      return;
    }
    if (!pres.aud) goPage(pres.i + (e.clientX < innerWidth / 3 ? -1 : 1)); // tap left third: back, elsewhere: next
  });
  let touchX = null;
  $("present").addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  $("present").addEventListener("touchend", (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) { e.preventDefault(); goPage(pres.i + (dx < 0 ? 1 : -1)); }
  });

  // ---------- popup menu ----------
  let menuAnchor = null;
  function closeMenu() { menu.hidden = true; menuAnchor = null; slash = null; }
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
    if (isSecret(m)) {
      openMenu(anchor, [{ label: "비밀 해제 (일반 메모로)", onPick: leaveSecret }]);
      return;
    }
    const cur = m.folder || "";
    openMenu(anchor, [
      { label: "폴더 없음", checked: !cur, onPick: () => moveCurrent("") },
      ...folderNames().map((n) => ({ label: n, checked: cur === n, onPick: () => moveCurrent(n) })),
      "-",
      { label: "새 폴더…", onPick: () => { const n = askFolderName(); if (n) moveCurrent(n); } },
      { html: `${LOCK_ICON(false)} 비밀 폴더로 옮기기`, onPick: moveToSecret },
    ]);
  }
  function folderManageMenu(anchor) {
    const f = filter;
    if (f == null) return;
    if (f === SECRET) {
      openMenu(anchor, [
        { label: "지금 잠그기", onPick: lockVault },
        { label: "비밀번호 바꾸기…", onPick: changePassword },
      ]);
      return;
    }
    openMenu(anchor, [
      { label: "이름 바꾸기…", onPick: () => renameFolder(f) },
      { label: "폴더 삭제", danger: true, onPick: () => deleteFolder(f) },
    ]);
  }

  // ---------- memo actions ----------
  async function reload() {
    memos = await api.list();
    await decryptAll();
    const cur = memos.find((m) => m.id === currentId);
    if (currentId && !cur) {
      currentId = null; setContent("");
      if (narrow()) showList();
    } else if (!composing && cur && cur.body !== shownBody && serialize() === savedBody && bodyOf(cur) != null) {
      // Changed by sync and no pending local edits: show the new text.
      const pos = document.activeElement === editor ? caretPos() : null;
      setContent(bodyOf(cur), cur.body);
      if (pos) restoreCaret(pos);
    }
    renderAll();
  }

  async function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!currentId) return;
    if (composing) { saveTimer = setTimeout(flush, 400); return; } // save after the syllable is done
    const body = serialize();
    if (body === savedBody) return;
    const id = currentId;
    const m0 = memos.find((x) => x.id === id);
    let stored = body;
    if (m0 && isSecret(m0)) {
      if (!vault) return; // locked meanwhile; lockVault saved before closing
      stored = await encryptFor(body);
      vault.plain.set(id, { cipher: stored, text: body });
      pendingSecret.delete(id);
    }
    const m = await api.save(id, stored);
    if (id === currentId) { savedBody = body; shownBody = m.body; }
    const i = memos.findIndex((x) => x.id === m.id);
    if (i >= 0) memos.splice(i, 1);
    memos.unshift(m);
    renderList(); renderDiary(); renderEditor();
  }
  function afterEdit(kind = "op") {
    updateEmpty();
    applyFolds();
    if (!composing) record(kind);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }

  async function leaveCurrent() {
    await flush();
    const m = memos.find((x) => x.id === currentId);
    if (m && bodyOf(m) != null && !plain(textOf(m)).trim()) {
      await api.remove(m.id);
      memos = memos.filter((x) => x.id !== m.id);
      pendingSecret.delete(m.id);
    }
  }

  async function select(id) {
    if (id === currentId) { if (narrow()) showEditor(); return; }
    const target = memos.find((x) => x.id === id);
    if (target && bodyOf(target) == null) { alert("다른 비밀번호로 잠긴 메모라서 지금 비밀번호로는 열 수 없어."); return; }
    await leaveCurrent();
    currentId = id;
    const m = memos.find((x) => x.id === id);
    setContent(m ? textOf(m) : "", m ? m.body : "");
    editor.scrollTop = 0;
    renderAll();
    if (narrow()) showEditor();
    if (!narrow()) editor.focus();
  }

  async function newMemo() {
    if (tab === "diary") { const t = new Date(); calMonth = new Date(t.getFullYear(), t.getMonth(), 1); await openDiary(ymd(t)); return; }
    if (filter === SECRET && !(await unlockVault())) return;
    await leaveCurrent();
    search.value = "";
    const inSecret = filter === SECRET;
    const m = await api.create(inSecret ? "" : filter || "");
    if (inSecret) pendingSecret.add(m.id);
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
    if (plain(textOf(m)).trim() && !confirm(`"${title(textOf(m))}" 메모를 삭제할까?`)) return;
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
    if (e.target.closest("#unlock-btn")) { openSecret(); return; }
    const li = e.target.closest("li[data-id]");
    if (li) select(li.dataset.id);
  });
  // Relock the secret folder after RELOCK_MS away (timers may not run in the background on
  // phones, so the elapsed time is also checked on return).
  let hiddenAt = 0, relockTimer = null;
  document.addEventListener("visibilitychange", () => {
    clearTimeout(relockTimer);
    if (document.hidden) {
      hiddenAt = Date.now();
      relockTimer = setTimeout(lockVault, RELOCK_MS);
    } else {
      if (vault && hiddenAt && Date.now() - hiddenAt >= RELOCK_MS) lockVault();
      hiddenAt = 0;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("modal").hidden) $("pw-cancel").click();
    else if (e.key === "Escape" && !$("help").hidden) toggleHelp();
    else if (e.key === "Escape" && !$("settings").hidden) closeSettings();
  });
  $("folders").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "folder-add") addFolder();
    else if (b.id === "folder-more") folderManageMenu(b);
    else if (b.dataset.secret) openSecret();
    else if (b.dataset.all) setFilter(null);
    else if (b.dataset.f != null) setFilter(b.dataset.f);
  });
  editor.addEventListener("compositionstart", () => {
    composing = true;
    clearTimeout(saveTimer);
    // Drop the placeholder now, before the IME puts its first letter in.
    editor.classList.remove("empty");
  });
  editor.addEventListener("compositionend", () => {
    composing = false;
    // Let the browser finish committing the syllable, then catch up on the deferred work.
    setTimeout(() => {
      if (composing) return;
      if (!editor.firstChild || editor.firstChild.nodeType === 3) ensureLines();
      afterEdit("insertText");
    }, 0);
  });
  editor.addEventListener("beforeinput", (e) => {
    if (busy) return;
    // Undo/redo from menus or gestures (e.g. shaking an iPhone) use the app's history too.
    if (e.inputType === "historyUndo") { e.preventDefault(); undo(); return; }
    if (e.inputType === "historyRedo") { e.preventDefault(); redo(); return; }
    if (slash && e.inputType === "insertParagraph") { e.preventDefault(); slashPick(slash.i); return; }
    if (composing || e.isComposing) return;
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") onEnter(e);
  });
  editor.addEventListener("input", (e) => {
    if (busy) return;
    if (slash || (e.data && e.data.includes("/"))) slashCheck(); // only reads the editor: safe while composing
    if (composing || e.isComposing) return; // handled on compositionend
    if (e.inputType === "insertParagraph") { afterParagraph(); return; }
    if (!editor.firstChild || editor.firstChild.nodeType === 3) ensureLines();
    let kind = e.inputType;
    if (e.inputType === "insertText" && e.data) {
      const ch = e.data.slice(-1);
      if (" `-*~".includes(ch)) {
        record(kind); // the typed characters are a step of their own: undo brings back "- " etc.
        const before = editor.innerHTML;
        if (ch === " ") { autoBox(); autoBlock(" "); }
        else if (ch === "`") { if (!autoBlock("`")) autoInline("`"); }
        else if (ch === "-") autoBlock("-");
        else autoInline(ch);
        if (editor.innerHTML !== before) kind = "op";
      }
      updateBlockState();
    }
    afterEdit(kind);
  });
  editor.addEventListener("keydown", (e) => {
    if (slashKey(e)) return;
    if (e.isComposing) return;
    // Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo (by key position, so it works in Korean input mode too).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY")) {
      e.preventDefault();
      if (e.code === "KeyY" || e.shiftKey) redo(); else undo();
      return;
    }
    // Tab / Shift+Tab: indent / outdent the selected lines.
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); indent(e.shiftKey ? -1 : 1); return; }
    // Ctrl+Enter: fold/unfold a toggle, or check/uncheck a checklist item.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      const c = caretLine();
      if (!c) return;
      e.preventDefault();
      if (blockOf(c.line) === "toggle") { toggleFold(c.line); return; }
      const ch = c.line.textContent[0];
      if (ch === OPEN || ch === DONE) { run(() => editLine(c.line, 0, 1, ch === OPEN ? DONE : OPEN)); caretAt(c.line, c.off); afterEdit(); }
      return;
    }
    // Backspace at the very start of a line: a heading/list/quote line turns back into plain
    // text; a plain indented line moves one level out.
    if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const c = caretLine();
      if (c && c.off === 0 && (blockOf(c.line) || indOf(c.line))) {
        e.preventDefault();
        if (blockOf(c.line)) setType(c.line, ""); else setInd(c.line, indOf(c.line) - 1);
        afterEdit(); updateBlockState();
      }
    }
  });
  // Paste keeps the formatting this app supports (bold/italic/underline/size/color/divider)
  // and drops everything else, so web pages don't bring their layout along.
  editor.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const html = cd.getData("text/html"), t = cd.getData("text/plain");
    e.preventDefault();
    if (html) {
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      // Source-code line breaks are just spaces in HTML.
      const w = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
      const blanks = [];
      for (let n; (n = w.nextNode());) {
        if (/^\s*$/.test(n.nodeValue) && /[\r\n]/.test(n.nodeValue)) blanks.push(n);
        else n.nodeValue = n.nodeValue.replace(/[\r\n]+/g, " ");
      }
      blanks.forEach((n) => n.remove());
      const box = document.createElement("div");
      cleanInto(tpl.content, box);
      if (hasRich(box)) {
        run(() => document.execCommand("insertHTML", false, box.innerHTML));
        fixLines(); // pasted blocks become separate lines
        afterEdit();
        return;
      }
    }
    if (!t) return;
    const lines = t.replace(/\r\n?/g, "\n").split("\n");
    run(() => lines.forEach((l, i) => {
      if (i) document.execCommand("insertParagraph");
      if (l) document.execCommand("insertText", false, l);
    }));
    afterEdit();
  });
  editor.addEventListener("click", toggleBoxAtCaret);
  // Clicking the ▸ arrow of a toggle (its left padding) folds / unfolds it.
  editor.addEventListener("mousedown", (e) => {
    const line = e.target.nodeType === 1 ? lineOf(e.target) : null;
    if (!line || blockOf(line) !== "toggle") return;
    const r = line.getBoundingClientRect(), pad = parseFloat(getComputedStyle(line).paddingLeft) || 0;
    if (e.clientX >= r.left + pad) return;
    e.preventDefault();
    toggleFold(line);
  });
  editor.addEventListener("blur", () => { composing = false; flush(); }); // a lost compositionend must not block saving
  search.addEventListener("input", renderList);
  $("btn-new").onclick = newMemo;
  $("tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });
  $("cal-prev").onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderDiary(); };
  $("cal-next").onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderDiary(); };
  $("cal-today").onclick = () => { const t = new Date(); calMonth = new Date(t.getFullYear(), t.getMonth(), 1); renderDiary(); };
  $("cal-lock").onclick = (e) => diaryLockMenu(e.currentTarget);
  $("diary-unlock").onclick = () => unlockVault().then(renderAll);
  $("cal-grid").addEventListener("click", (e) => { const b = e.target.closest("button[data-date]"); if (b) openDiary(b.dataset.date); });
  $("diary-list").addEventListener("click", (e) => { const li = e.target.closest("li[data-id]"); if (li) select(li.dataset.id); });
  $("btn-settings").onclick = openSettings;
  $("set-close").onclick = closeSettings;
  $("settings").addEventListener("click", (e) => {
    if (e.target === $("settings")) { closeSettings(); return; }
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.mode != null && b.parentElement.id === "set-mode") { look.mode = b.dataset.mode; saveLook(); }
    else if (b.dataset.theme != null) { look.theme = b.dataset.theme; look.accent = ""; saveLook(); }
    else if (b.dataset.accent != null) { look.accent = b.dataset.accent; saveLook(); }
  });
  $("settings").addEventListener("input", (e) => {
    if (e.target.id === "set-pick") { look.accent = e.target.value.toLowerCase(); try { prefStore.setItem(LOOK_KEY, JSON.stringify(look)); } catch (x) {} applyLook(); }
  });
  $("settings").addEventListener("change", (e) => { if (e.target.id === "set-pick") renderSettings(); });
  $("btn-delete").onclick = deleteCurrent;
  $("btn-pin").onclick = togglePin;
  $("btn-present").onclick = startPresent;
  $("btn-folder").onclick = (e) => folderMenu(e.currentTarget);
  $("btn-font").onclick = cycleZoom;
  $("btn-check").onclick = toggleChecklist;
  $("f-size").onclick = (e) => sizeMenu(e.currentTarget);
  $("f-color").onclick = (e) => colorMenu(e.currentTarget);
  $("f-hl").onclick = (e) => highlightMenu(e.currentTarget);
  $("f-bold").onclick = () => fmt("bold");
  $("f-italic").onclick = () => fmt("italic");
  $("f-under").onclick = () => fmt("underline");
  $("f-clear").onclick = () => fmt("removeFormat");
  $("f-hr").onclick = insertDivider;
  // Keep the editor's caret/selection when tapping toolbar buttons and menu items.
  for (const el of [$("fmt-bar"), $("editor-head"), menu])
    for (const ev of ["mousedown", "pointerdown"])
      el.addEventListener(ev, (e) => { if (e.target.closest("button")) e.preventDefault(); });
  $("btn-back").onclick = showList;
  // Wide screens: fold the memo list away (remembered on this device).
  const SIDE_KEY = "cloudmemo.hideSide";
  function setSideHidden(on) {
    app.classList.toggle("hide-side", on);
    const b = $("btn-side"), label = on ? "메모 목록 보이기" : "메모 목록 숨기기";
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", label);
    b.title = label + " (Ctrl+\\)";
    lsSet(SIDE_KEY, on);
  }
  setSideHidden(!!lsGet(SIDE_KEY, false));
  $("btn-side").onclick = () => setSideHidden(!app.classList.contains("hide-side"));

  // With the list hidden: a folder button in the header picks a folder, then a memo in it.
  function browseLabel() {
    return tab === "diary" ? "일기" : filter === SECRET ? "비밀" : filter == null ? "전체" : filter;
  }
  function memoItems(shown) {
    const pinned = shown.filter((m) => m.pinned), rest = shown.filter((m) => !m.pinned);
    return [...pinned, ...rest].slice(0, 60).map((m) => {
      const body = bodyOf(m);
      return {
        html: `<span class="mt">${m.pinned ? "📌 " : ""}${esc(body == null ? "다른 비밀번호로 잠긴 메모" : title(body))}</span><small>${esc(fmtDate(m.updated))}</small>`,
        checked: m.id === currentId, onPick: () => select(m.id),
      };
    });
  }
  function browseMemos(anchor, f) {
    const shown = memos.filter((m) => !isDiary(m) && (f === SECRET ? isSecret(m) : !isSecret(m)) && (f == null || f === SECRET || m.folder === f));
    const name = f === SECRET ? "비밀" : f == null ? "전체" : f;
    openMenu(anchor, [
      { html: `<span class="mt">← 폴더 목록</span>`, onPick: () => setTimeout(() => browseMenu(anchor), 0) },
      { html: `<span class="mt">＋ "${esc(name)}"에 새 메모</span>`, onPick: newMemo },
      "-",
      ...(shown.length ? memoItems(shown) : [{ label: "이 폴더에 메모가 없어", onPick: () => {} }]),
    ]);
  }
  async function browseFolder(anchor, f) {
    if (f === SECRET && !(await unlockVault())) { renderFolders(); return; }
    if (tab === "diary") await setTab("memo");
    setFilter(f);
    renderBrowse();
    setTimeout(() => browseMemos(anchor, f), 0);
  }
  function browseMenu(anchor) {
    const count = (f) => memos.filter((m) => !isDiary(m) && !isSecret(m) && (f == null || m.folder === f)).length;
    const cur = tab === "diary" ? "@diary" : filter;
    openMenu(anchor, [
      { html: `<span class="mt">전체</span><small>${count(null)}</small>`, checked: cur == null, onPick: () => browseFolder(anchor, null) },
      ...folderNames().map((n) => ({ html: `<span class="mt">${esc(n)}</span><small>${count(n)}</small>`, checked: cur === n, onPick: () => browseFolder(anchor, n) })),
      { html: `<span class="mt">${LOCK_ICON(!!vault)} 비밀</span>`, checked: cur === SECRET, onPick: () => browseFolder(anchor, SECRET) },
      "-",
      { html: `<span class="mt">일기</span>`, checked: cur === "@diary", onPick: async () => {
        if (tab !== "diary") await setTab("diary");
        renderBrowse();
        if (diaryLocked() && !(await unlockVault())) return;
        const entries = memos.filter((m) => written(m)).sort((a, b) => b.diary.localeCompare(a.diary) || b.updated - a.updated);
        setTimeout(() => openMenu(anchor, [
          { html: `<span class="mt">← 폴더 목록</span>`, onPick: () => setTimeout(() => browseMenu(anchor), 0) },
          { html: `<span class="mt">＋ 오늘 일기</span>`, onPick: newMemo },
          "-",
          ...(entries.length ? entries.slice(0, 60).map((m) => ({
            html: `<span class="mt">${esc(diaryLabel(m.diary))}</span><small>${esc(title(textOf(m)))}</small>`,
            checked: m.id === currentId, onPick: () => select(m.id),
          })) : [{ label: "아직 쓴 일기가 없어", onPick: () => {} }]),
        ]), 0);
      } },
    ]);
  }
  function renderBrowse() { $("browse-name").textContent = browseLabel(); }
  $("btn-browse").onclick = (e) => browseMenu(e.currentTarget);

  // ---------- help (F1) ----------
  function toggleHelp() {
    const h = $("help");
    if (h.hidden) { closeMenu(); closeSettings(); h.hidden = false; $("help-close").focus(); }
    else { h.hidden = true; if (currentId && !narrow()) focusEditor(); }
  }
  $("help-close").onclick = toggleHelp;
  $("help").addEventListener("click", (e) => { if (e.target === $("help")) toggleHelp(); });
  $("f-help").onclick = toggleHelp;
  $("set-help").onclick = () => { closeSettings(); toggleHelp(); };
  $("f-time").onclick = insertNow;
  $("f-block").onclick = (e) => blockMenu(e.currentTarget);
  $("f-strike").onclick = () => fmt("strikeThrough");
  $("f-code").onclick = toggleCode;
  $("f-indent").onclick = () => indent(1);
  $("f-outdent").onclick = () => indent(-1);
  $("btn-login").onclick = () => { api.login(); setTimeout(renderStatus, 100); };
  $("btn-logout").onclick = async () => {
    if (confirm("구글 드라이브 연결을 해제할까? 메모는 이 기기에 남아.")) { await api.logout(); renderStatus(); }
  };
  $("btn-sync").onclick = async () => { await flush(); api.syncNow(); setTimeout(renderStatus, 100); };
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === "KeyN") { e.preventDefault(); newMemo(); }
    if (mod && e.key === "\\") { e.preventDefault(); if (!narrow()) setSideHidden(!app.classList.contains("hide-side")); }
    if (mod && e.code === "KeyF") { e.preventDefault(); if (!narrow()) setSideHidden(false); search.focus(); search.select(); }
    if (mod && e.code === "KeyS") { e.preventDefault(); flush(); }
    if (mod && e.shiftKey && e.code === "KeyL") { e.preventDefault(); toggleChecklist(); }
    if (e.key === "F1") { e.preventDefault(); toggleHelp(); return; }
    if (!$("present").hidden || !$("help").hidden) return;
    if (e.key === "F5" && !mod) { e.preventDefault(); if (currentId) insertNow(); return; }
    if (mod && e.altKey && /^Digit[0-9]$/.test(e.code)) { // Ctrl+Alt+0..9: line type, like Notion
      e.preventDefault();
      setBlock(["p", "h1", "h2", "h3", "todo", "ul", "ol", "toggle", "code", "callout"][+e.code.slice(5)]);
      return;
    }
    if (mod && e.shiftKey && !e.altKey && e.code === "KeyS") { e.preventDefault(); fmt("strikeThrough"); return; }
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyE") { e.preventDefault(); toggleCode(); return; }
    // Desktop app: Ctrl+R refreshes the data instead of reloading the page.
    if (window.cmStorage && mod && e.code === "KeyR") {
      e.preventDefault(); flush().then(() => { api.syncNow(); reload(); });
    }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  window.addEventListener("pagehide", flush);
  window.__cmFlush = flush; // used by api-web.js before redirecting to Google

  // ---------- start ----------
  (async () => {
    setContent("");
    await reload();
    setTab(tab);
    const first = tab === "diary"
      ? memos.find((m) => written(m) && m.diary === ymd(new Date()))
      : memos.find((m) => !isSecret(m) && !isDiary(m) && (filter == null || m.folder === filter));
    if (!narrow() && first) await select(first.id);
    renderStatus();
    setInterval(renderStatus, 30000); // keeps "동기화됨 HH:MM" fresh
  })();
})();
