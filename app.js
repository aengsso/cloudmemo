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
        else if (c.nodeName === "IMG") cur = (cur ?? "") + "📷"; // same mark as remote.go
        else if (c.nodeType === 1 && c.hasAttribute("data-wx")) continue; // weather chip: not text
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
                 S: "S", STRIKE: "S", DEL: "S", CODE: "CODE", TIME: "TIME", IMG: "IMG",
                 BR: "BR", HR: "HR", DIV: "DIV", P: "DIV",
                 LI: "DIV", H1: "DIV", H2: "DIV", H3: "DIV", H4: "DIV", H5: "DIV", H6: "DIV", BLOCKQUOTE: "DIV", PRE: "DIV",
                 SUMMARY: "DIV" };
  const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "VIDEO",
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
  const IMG_ID = /^[0-9a-f]{24}$/; // photo ids (images.go / api-web.js)
  // Diary weather chip: <span data-wx="WMO code,min,max">. Its label is rebuilt from the data,
  // and it is left out of the memo's plain text (titles, search, "is it empty").
  const WX_RE = /^\d{1,2},-?\d{1,3},-?\d{1,3}$/;
  const WX = { 0: ["☀️", "맑음"], 1: ["🌤️", "대체로 맑음"], 2: ["⛅", "구름 조금"], 3: ["☁️", "흐림"], 45: ["🌫️", "안개"], 48: ["🌫️", "안개"],
    51: ["🌦️", "이슬비"], 53: ["🌦️", "이슬비"], 55: ["🌦️", "이슬비"], 56: ["🌧️", "어는 비"], 57: ["🌧️", "어는 비"],
    61: ["🌧️", "비"], 63: ["🌧️", "비"], 65: ["🌧️", "많은 비"], 66: ["🌧️", "어는 비"], 67: ["🌧️", "어는 비"],
    71: ["🌨️", "눈"], 73: ["🌨️", "눈"], 75: ["❄️", "많은 눈"], 77: ["🌨️", "싸락눈"], 80: ["🌦️", "소나기"], 81: ["🌦️", "소나기"],
    82: ["⛈️", "강한 소나기"], 85: ["🌨️", "눈 소나기"], 86: ["🌨️", "눈 소나기"], 95: ["⛈️", "뇌우"], 96: ["⛈️", "뇌우"], 99: ["⛈️", "뇌우"] };
  function wxLabel(v) {
    const [c, lo, hi] = v.split(",").map(Number), w = WX[c] || ["🌡️", "날씨"];
    return `${w[0]} ${w[1]} · 최저 ${lo}° 최고 ${hi}°`;
  }
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
      if (tag === "IMG") { // only this app's photos (data-img id); src is filled in at runtime, never saved
        const id = n.getAttribute("data-img");
        if (!IMG_ID.test(id || "")) continue;
        el.setAttribute("data-img", id);
        if (n.getAttribute("data-rep") === "1") el.setAttribute("data-rep", "1"); // the day's cover photo
        for (const a of ["data-fx", "data-fy"]) { const v = n.getAttribute(a); if (/^(0(\.\d{1,3})?|1(\.0{1,3})?)$/.test(v || "")) el.setAttribute(a, v); } // "중심" (0..1)
        el.alt = "사진";
        dst.appendChild(el);
        continue;
      }
      if (tag === "FONT") {
        const c = normColor(n.getAttribute("color"));
        if (c) el.setAttribute("color", c);
        const s = n.getAttribute("size");
        if (/^[1-7]$/.test(s || "")) el.setAttribute("size", s);
        if (!el.attributes.length) { cleanInto(n, dst); continue; }
      }
      if (tag === "SPAN" && WX_RE.test(n.getAttribute("data-wx") || "")) {
        const v = n.getAttribute("data-wx");
        el.setAttribute("data-wx", v); el.textContent = wxLabel(v);
        dst.appendChild(el);
        continue;
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
        if (s.textContent || (s.nodeType === 1 && (s.nodeName === "BR" || s.nodeName === "IMG" || s.querySelector("br,img")))) return false;
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
        else if (c.nodeName === "IMG") place(c.cloneNode(false), stack);
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

  const RICH = "b,i,u,font,strong,em,hr,mark,s,strike,del,code,time,img[data-img],span[data-wx],div[data-b],div[data-i],summary,h1,h2,h3,h4,h5,h6,blockquote,pre,li";
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
    hydratePhotos(editor);
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
    updateEmpty(); applyFolds(); updateBlockState(); hydratePhotos(editor);
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
    const first = editor.firstElementChild, wx = first && first.querySelector("[data-wx]") ? first : null;
    const len = editor.textContent.length - (wx ? wx.textContent.length : 0);
    editor.classList.toggle("empty", len === 0 && editor.children.length <= (wx ? 2 : 1) && !editor.querySelector("img"));
  }

  // ---------- text helpers ----------
  function title(body) {
    let photo = false;
    for (const line of plain(body).split("\n")) {
      const t = line.replace(BOX_RE, "").trim();
      if (t && !t.replace(/📷|\s/g, "")) { photo = true; continue; } // a line of photos only
      if (t) return t;
    }
    return photo ? "📷 사진" : "제목 없음";
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
    forgetLockedPhotos();
    renderAll();
  }
  async function moveToSecret() {
    const m = memos.find((x) => x.id === currentId);
    if (!m || !(await unlockVault())) return;
    await flush();
    // The editor holds this memo, now saved. Its photos get encrypted copies.
    const { body: text, replaced } = await recastPhotos(serialize(), true);
    const enc = await encryptFor(text);
    await api.save(m.id, enc);
    if (m.folder) await api.setFolder(m.id, "");
    vault.plain.set(m.id, { cipher: enc, text });
    if (!plain(text).trim()) pendingSecret.add(m.id);
    shownBody = enc;
    if (replaced.length) setContent(text, enc);
    memos = await api.list();
    await dropUnused(replaced);
    setFilter(SECRET);
    renderEditor();
    flashMeta("비밀 폴더로 옮김");
  }
  async function leaveSecret() {
    const m = memos.find((x) => x.id === currentId);
    if (!m || !vault) return;
    await flush();
    // Decrypted text shown in the editor, now saved. Its photos get plain copies.
    const { body: text, replaced } = await recastPhotos(serialize(), false);
    await api.save(m.id, text);
    vault.plain.delete(m.id);
    pendingSecret.delete(m.id);
    shownBody = text;
    if (replaced.length) setContent(text);
    memos = await api.list();
    await dropUnused(replaced);
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
    const key = { pw, salt: "" }, replaced = [];
    for (const m of memos.filter((x) => isLocked(x.body) && bodyOf(x) != null)) {
      const r = await recastPhotos(bodyOf(m), true, { from: vault.pw, key }); // photos: new password too
      replaced.push(...r.replaced);
      const enc = await api.encrypt(pw, key.salt, r.body);
      key.salt = key.salt || saltOf(enc);
      await api.save(m.id, enc);
    }
    forgetLockedPhotos();
    vault = { pw, salt: key.salt, plain: new Map() };
    memos = await api.list();
    await decryptAll();
    const cur = memos.find((x) => x.id === currentId);
    if (cur && isLocked(cur.body) && bodyOf(cur) != null) { shownBody = cur.body; if (replaced.length) setContent(bodyOf(cur), cur.body); }
    await dropUnused(replaced);
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
    const replaced = [];
    for (const m of memos.filter((x) => isDiary(x) && !isLocked(x.body) && plain(x.body).trim())) {
      const r = await recastPhotos(m.body, true); // photos: encrypted copies
      replaced.push(...r.replaced);
      const enc = await encryptFor(r.body);
      await api.save(m.id, enc);
      vault.plain.set(m.id, { cipher: enc, text: r.body });
    }
    for (const m of memos) if (isDiary(m) && !isLocked(m.body)) pendingSecret.add(m.id); // empty new entries
    lsSet(DIARY_LOCK_KEY, true);
    memos = await api.list();
    const cur = memos.find((x) => x.id === currentId);
    if (cur && isDiary(cur)) { shownBody = cur.body; if (replaced.length && bodyOf(cur) != null) setContent(bodyOf(cur), cur.body); }
    await dropUnused(replaced);
    renderAll();
    flashMeta("일기를 잠갔어");
  }
  async function lockDiaryOff() {
    if (!vault || !confirm("일기 잠금을 풀까? 일기가 다시 암호화 없이 저장돼.")) return;
    await flush();
    const replaced = [];
    for (const m of memos.filter((x) => isDiary(x) && isLocked(x.body))) {
      const text = bodyOf(m);
      if (text == null) continue; // made with another password: leave it locked
      const r = await recastPhotos(text, false); // photos: plain copies
      replaced.push(...r.replaced);
      await api.save(m.id, r.body);
      vault.plain.delete(m.id);
    }
    for (const m of memos) if (isDiary(m)) pendingSecret.delete(m.id);
    lsSet(DIARY_LOCK_KEY, false);
    memos = await api.list();
    const cur = memos.find((x) => x.id === currentId);
    if (cur && isDiary(cur)) { shownBody = cur.body; if (replaced.length) setContent(cur.body); }
    await dropUnused(replaced);
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
    if (closed) { $("cal-title").textContent = "일기"; renderCalEvents(ymd(new Date()), true); return; }
    const y = calMonth.getFullYear(), mo = calMonth.getMonth();
    $("cal-title").innerHTML = `${mo + 1}월<small>${y}</small>`; // month big, year small: fits beside the buttons
    const byDay = new Map();
    for (const m of memos) if (written(m)) (byDay.get(m.diary) || byDay.set(m.diary, []).get(m.diary)).push(m);
    const cur = memos.find((x) => x.id === currentId), selDay = cur && cur.diary;
    const first = new Date(y, mo, 1).getDay(), days = new Date(y, mo + 1, 0).getDate(), today = ymd(new Date());
    let html = WD.map((w, i) => `<span class="wd${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${w}</span>`).join("");
    for (let i = 0; i < first; i++) html += "<span></span>";
    for (let d = 1; d <= days; d++) {
      const key = `${y}-${pad(mo + 1)}-${pad(d)}`, list = byDay.get(key), dow = (first + d - 1) % 7;
      const cls = ["day", dow === 0 ? "sun" : dow === 6 ? "sat" : "", list ? "has" : "", key === today ? "today" : "", key === selDay ? "sel" : ""].filter(Boolean).join(" ");
      const evs = calShowing() ? cal.byDay.get(key) || [] : [];
      const tip = [list ? title(textOf(list[0])) : "", ...evs.slice(0, 4).map((e) => (e.allDay ? "" : timeLabel(e.start) + " ") + e.title)].filter(Boolean).join("\n");
      const dots = evs.length ? `<span class="ev-dots">${evs.slice(0, 3).map((e) => `<i style="background:${esc(e.color || "var(--accent)")}"></i>`).join("")}</span>` : "";
      html += `<button class="${cls}" data-date="${key}" title="${esc(tip)}" aria-label="${mo + 1}월 ${d}일${list ? ", 일기 있음" : ""}${evs.length ? `, 일정 ${evs.length}개` : ""}">${d}${dots}</button>`;
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
    // Events of the open entry's day (or today, or the 1st of the shown month).
    const shownDay = selDay && selDay.startsWith(prefix) ? selDay : today.startsWith(prefix) ? today : prefix + "01";
    renderCalEvents(shownDay, false);
    calLoad(false);
  }
  // ---------- Google Calendar events on the diary calendar (read only, opt-in) ----------
  const CAL_ON_KEY = "cloudmemo.calOn";
  const calAPI = () => (api.calendar && typeof api.calendar.events === "function" ? api.calendar : null);
  const cal = { on: !!lsGet(CAL_ON_KEY, false), granted: false, canWrite: false, month: "", byDay: new Map(), err: "", loading: false, at: 0, form: "" };
  const canAdd = () => !!(calAPI() && typeof api.calendar.add === "function");
  const calShowing = () => !!calAPI() && cal.on && cal.granted;
  // Events grouped by local day ("YYYY-MM-DD"); an event spanning days is listed on each.
  function groupEvents(list) {
    const by = new Map();
    const add = (k, e) => (by.get(k) || by.set(k, []).get(k)).push(e);
    for (const e of list) {
      let s, last;
      if (e.allDay) { s = dayOf(e.start); last = dayOf(e.end || e.start); last.setDate(last.getDate() - 1); }
      else { s = new Date(e.start); last = new Date(e.end || e.start); if (last > s) last = new Date(last.getTime() - 1); }
      const d = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      for (let n = 0; d <= last && n < 62; n++, d.setDate(d.getDate() + 1)) add(ymd(d), e);
      if (last < s) add(ymd(s), e);
    }
    return by;
  }
  async function calLoad(force) {
    const c = calAPI();
    if (!c || !cal.on) return;
    const y = calMonth.getFullYear(), mo = calMonth.getMonth(), key = `${y}-${mo}`;
    if (cal.loading || (!force && cal.month === key && Date.now() - cal.at < 10 * 60000)) return;
    cal.loading = true;
    try {
      const st = await c.status();
      cal.granted = !!(st && st.granted);
      cal.canWrite = !!(st && st.canWrite);
      if (cal.granted) {
        const list = await c.events(new Date(y, mo, 1).toISOString(), new Date(y, mo + 1, 1).toISOString());
        cal.byDay = groupEvents(list || []);
        cal.err = "";
      }
      cal.month = key; cal.at = Date.now();
    } catch (e) {
      cal.err = (e && e.message) || String(e); cal.month = key; cal.at = Date.now();
    }
    cal.loading = false;
    renderDiary();
  }
  async function calConnect() {
    const c = calAPI();
    if (!c) return;
    cal.on = true; lsSet(CAL_ON_KEY, true);
    const st = await c.status();
    if (st && st.granted) { cal.granted = true; calLoad(true); return; }
    if (!confirm("구글 캘린더 일정을 일기 달력에 같이 보여줄까?\n\n구글 로그인 화면이 열리면 '캘린더 보기' 권한을 허용해 줘. " +
                 "'확인되지 않은 앱' 화면이 나오면 고급 → CloudMemo(으)로 이동을 누르면 돼.\n일정은 읽기만 하고 바꾸지 않아.")) {
      cal.on = false; lsSet(CAL_ON_KEY, false); renderDiary(); return;
    }
    await flush();
    c.connect(); // web: goes to Google and comes back; PC app: browser, then a "calendar" event
    flashMeta("브라우저에서 구글 캘린더 권한을 허용해 줘");
  }
  function calMenu(anchor) {
    if (!calShowing()) { calConnect(); return; }
    openMenu(anchor, [
      { label: "일정 새로고침", onPick: () => calLoad(true) },
      { label: "구글 캘린더 열기", onPick: () => openExternal("https://calendar.google.com/calendar/r") },
      "-",
      { label: "일정 숨기기", onPick: () => { cal.on = false; lsSet(CAL_ON_KEY, false); renderDiary(); } },
    ]);
  }
  const openExternal = (url) => Promise.resolve(api.openURL ? api.openURL(url) : window.open(url, "_blank", "noopener")).catch(() => {});
  const timeLabel = (iso) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  function renderCalEvents(day, closed) {
    const box = $("cal-events"), btn = $("cal-gcal");
    btn.hidden = !calAPI();
    btn.classList.toggle("on", calShowing());
    btn.title = calShowing() ? "구글 캘린더 일정 (켜짐)" : "구글 캘린더 일정 보기";
    if (!calShowing() || closed) { box.hidden = true; cal.form = ""; return; }
    box.hidden = false;
    // Don't redraw over a half-filled form (sync re-renders the sidebar every minute).
    if (cal.form === day && box.querySelector("form.ce-form")) return;
    if (cal.form && cal.form !== day) cal.form = "";
    const list = cal.byDay.get(day) || [];
    const d = dayOf(day);
    const head = `<div class="ce-head"><span>${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일 일정</span>` +
      (canAdd() && !cal.form ? `<button class="text-btn ce-add" data-ce="add">＋ 일정 추가</button>` : "") + `</div>`;
    if (cal.err) {
      box.innerHTML = head + `<div class="ce-none err">${esc(cal.err)} <button class="text-btn" data-ce="retry">다시 시도</button></div>`;
    } else {
      box.innerHTML = head + (list.length ? list.map((e, i) => `
        <button class="ce" data-ce="${i}" title="${esc(e.calendar || "")}">
          <i style="background:${esc(e.color || "var(--accent)")}"></i>
          <span class="ce-t">${e.allDay ? "종일" : esc(timeLabel(e.start))}</span>
          <span class="ce-n">${esc(e.title)}</span>
        </button>`).join("") : `<div class="ce-none">${cal.loading ? "불러오는 중…" : "일정 없음"}</div>`) +
        (cal.form === day ? eventForm(day) : "");
    }
    box.onclick = (ev) => {
      const b = ev.target.closest("[data-ce]");
      if (!b) return;
      const k = b.dataset.ce;
      if (k === "retry") { calLoad(true); return; }
      if (k === "add") { openEventForm(day); return; }
      if (k === "cancel") { cal.form = ""; renderDiary(); return; }
      const e = list[+k];
      if (e && e.link) openExternal(e.link);
    };
    const f = box.querySelector("form.ce-form");
    if (f) wireEventForm(f, day);
  }

  // ---- adding an event (inserted straight into the main Google Calendar) ----
  const hm = (dt) => `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  function isoLocal(dt) { // "2026-11-28T15:30:00+09:00"
    const off = -dt.getTimezoneOffset(), a = Math.abs(off);
    return `${ymd(dt)}T${hm(dt)}:00${off >= 0 ? "+" : "-"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }
  function eventForm(day) {
    let s = new Date(dayOf(day)); s.setHours(9, 0, 0, 0);
    if (day === ymd(new Date())) { s = new Date(); s.setMinutes(0, 0, 0); s.setHours(Math.min(s.getHours() + 1, 23)); }
    const e = new Date(s.getTime() + 3600000);
    return `<form class="ce-form" autocomplete="off">
      <input name="t" class="ce-title" placeholder="일정 제목" maxlength="300" aria-label="일정 제목">
      <div class="ce-row">
        <label class="ce-all"><input type="checkbox" name="all"> 종일</label>
        <span class="ce-times"><input type="time" name="s" value="${hm(s)}" aria-label="시작"> ~ <input type="time" name="e" value="${hm(e)}" aria-label="끝"></span>
      </div>
      <p class="ce-err" role="alert"></p>
      <div class="ce-btns"><button type="button" class="text-btn" data-ce="cancel">취소</button><button class="text-btn primary">추가</button></div>
    </form>`;
  }
  function wireEventForm(f, day) {
    const all = f.elements.all, s = f.elements.s, e = f.elements.e, err = f.querySelector(".ce-err");
    all.onchange = () => f.querySelector(".ce-times").classList.toggle("off", all.checked);
    let dur = 60; // keep the length when the start moves
    const mins = (v) => { const [h, m] = v.split(":").map(Number); return h * 60 + m; };
    s.onchange = () => { if (s.value) { const t = Math.min(mins(s.value) + dur, 23 * 60 + 59); e.value = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; } };
    e.onchange = () => { if (s.value && e.value && mins(e.value) > mins(s.value)) dur = mins(e.value) - mins(s.value); };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const title = f.elements.t.value.trim();
      if (!title) { err.textContent = "제목을 적어줘"; f.elements.t.focus(); return; }
      let start, end;
      const d0 = dayOf(day);
      if (all.checked) { const d1 = new Date(d0); d1.setDate(d1.getDate() + 1); start = day; end = ymd(d1); }
      else {
        if (!s.value || !e.value) { err.textContent = "시간을 골라줘"; return; }
        const at = (v) => { const [h, m] = v.split(":").map(Number); const x = new Date(d0); x.setHours(h, m, 0, 0); return x; };
        const a = at(s.value), b = at(e.value);
        if (b <= a) { err.textContent = "끝나는 시간이 시작보다 뒤여야 해"; return; }
        start = isoLocal(a); end = isoLocal(b);
      }
      const btn = f.querySelector(".primary");
      btn.disabled = true; err.textContent = "추가하는 중…";
      try {
        await api.calendar.add({ title, allDay: all.checked, start, end });
        cal.form = "";
        flashMeta("구글 캘린더에 일정을 추가했어");
        await calLoad(true);
      } catch (x) {
        btn.disabled = false;
        err.textContent = (x && x.message) || String(x);
        if (/권한/.test(err.textContent)) cal.canWrite = false;
      }
    };
    if (document.activeElement === document.body || !f.contains(document.activeElement)) f.elements.t.focus();
  }
  async function openEventForm(day) {
    if (!cal.canWrite) {
      if (!confirm("앱에서 바로 일정을 추가하려면 구글 캘린더 '일정 만들기' 권한이 필요해.\n\n" +
                   "구글 화면이 열리면 허용해 줘. 앱은 일정을 추가만 하고, 고치거나 지우지 않아.")) return;
      await flush();
      api.calendar.connect(true);
      flashMeta("브라우저에서 구글 캘린더 권한을 허용해 줘");
      return;
    }
    cal.form = day;
    renderDiary();
  }

  // ---------- 이달의 사진: one stamp per day, the day's cover photo (diary only) ----------
  const ALBUM_KEY = "cloudmemo.album";
  // pmCenter: the postmark's middle — "" = a little cloud, "{days}" = "13 DAYS", else the user's text.
  const album = Object.assign({ shape: "stamp", filter: "orig", empty: true, bg: "white", font: "postmark", pmCenter: "", gpal: "night" }, lsGet(ALBUM_KEY, {}));
  const CLOUD_PATH = "M-9 6h18a6 6 0 0 0 .6-12A8.5 8.5 0 0 0-6-8.4 6 6 0 0 0-9 6z"; // ~24×14, centred on 0,0
  const pmCenterText = (days) => (album.pmCenter === "{days}" ? `${days} DAYS` : String(album.pmCenter || "").toUpperCase());
  // Postmark ink: the theme's accent color, so it changes with the theme.
  function pmInkRGB() {
    const g = canvasOf(1, 1).getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3b4a7a";
    g.fillRect(0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }
  // Text with emoji, printed in one ink color like a rubber stamp: the outline in full ink, light
  // areas as a soft tone, dark parts (eyes, mouth) dark. Returns a canvas `px` tall-ish.
  const hasEmoji = (s) => /\p{Extended_Pictographic}/u.test(s || "");
  function inkPicture(text, px, rgb) {
    const font = `700 ${px}px ${PM_FONT}`, pad = Math.round(px * 0.2);
    const m = canvasOf(1, 1).getContext("2d"); m.font = font;
    const w = Math.ceil(m.measureText(text).width) + pad * 2, h = Math.ceil(px * 1.25) + pad * 2;
    const cv = canvasOf(w, h), g = cv.getContext("2d", { willReadFrequently: true });
    g.font = font; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = `rgb(${rgb.join(",")})`; g.fillText(text, w / 2, h / 2 + px * 0.04);
    const img = g.getImageData(0, 0, w, h), s = img.data, A = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) A[p] = s[p * 4 + 3] / 255;
    const r = Math.max(1, Math.round(px / 48)); // outline thickness
    const out = (x, y) => x < 0 || y < 0 || x >= w || y >= h || A[y * w + x] < 0.35;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4, a = A[p];
      if (!a) continue;
      const l = (s[i] * 0.3 + s[i + 1] * 0.59 + s[i + 2] * 0.11) / 255;
      const edge = out(x - r, y) || out(x + r, y) || out(x, y - r) || out(x, y + r) ||
                   out(x - r, y - r) || out(x + r, y + r) || out(x - r, y + r) || out(x + r, y - r);
      // Three flat tones (like a carved stamp) keep small details crisp instead of a smudgy gradient.
      const tone = edge || l < 0.42 ? 1 : l < 0.72 ? 0.5 : 0.18;
      s[i] = rgb[0]; s[i + 1] = rgb[1]; s[i + 2] = rgb[2]; s[i + 3] = Math.round(255 * (a > 0.5 ? 1 : a * 2) * tone);
    }
    g.putImageData(img, 0, 0);
    // Trim to the inked area, so centring the picture centres what you see (an emoji's glyph box
    // has more room below it than above).
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (s[(y * w + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return cv;
    const m2 = 2, cw = x1 - x0 + 1 + m2 * 2, ch = y1 - y0 + 1 + m2 * 2, trimmed = canvasOf(cw, ch);
    trimmed.getContext("2d", { willReadFrequently: true }).drawImage(cv, x0 - m2, y0 - m2, cw, ch, 0, 0, cw, ch);
    return trimmed;
  }
  // Only emoji (1–3 of them): drawn big in the middle, like a picture stamp.
  const emojiOnly = (s) => !!s && [...s].length <= 6 && /^(\p{Extended_Pictographic}|️|‍|\p{Emoji_Modifier}|\s)+$/u.test(s);
  // Hangul in the postmark: Special Elite has none, so a fixed-width gothic like a typewriter.
  const PM_FONT = '"Special Elite", "Nanum Gothic Coding", monospace';
  if (album.bg !== "white" && album.bg !== "theme") album.bg = "white"; // the paper background was dropped
  if (album.filter === "dot") album.filter = "pixel"; // older dot look
  if (album.filter === "bead" || album.filter === "stitch") album.filter = "halftone"; // folded into 망점
  // Header styles ("2026 / 11월"). Fonts come from Google Fonts with only the letters used,
  // loaded when the month page opens; without internet the normal font shows.
  const HEAD_STYLES = ["postmark", "editorial", "bignum", "typewriter", "serif", "script", "basic"];
  if (!HEAD_STYLES.includes(album.font)) album.font = "postmark"; // older choices (손글씨 등)
  const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const HEAD_FONTS = {
    year: '"Josefin Sans", sans-serif', italic: '"Cormorant Garamond", serif', display: '"Playfair Display", serif',
    type: '"Special Elite", monospace', serif: '"Hahmlet", serif', script: '"Caveat", cursive',
  };
  let albumFontsAdded = false;
  function loadAlbumFonts() {
    if (albumFontsAdded) return;
    albumFontsAdded = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,600&family=Playfair+Display:wght@500" +
      "&family=Special+Elite&family=Hahmlet:wght@300;500&family=Caveat:wght@600&family=Josefin+Sans:wght@400" +
      "&text=" + encodeURIComponent("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz월.— ") + "&display=swap";
    document.head.appendChild(link);
    // Hangul for the postmark's middle text (Google sends only the slices a page uses).
    document.head.appendChild(Object.assign(document.createElement("link"), {
      rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Nanum+Gothic+Coding:wght@700&display=swap" }));
  }
  // The postmark's middle: emoji get smaller the more there are, and never leave the inner ring
  // (about 58×46 units inside the month/year lettering).
  const PM_MID_W = 58, PM_MID_H = 46;
  function pmMidSize(mid, big) {
    if (!big) return [...mid].length > 7 ? 10.5 : 14;
    let n = 1;
    try { n = [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(mid.trim())].filter((g) => g.segment.trim()).length; }
    catch (e) { n = [...mid.replace(/[\uFE0F\u200D\s]/g, "")].length; }
    return n <= 1 ? 36 : n === 2 ? 24 : n === 3 ? 17 : 13;
  }
  function headerHTML(y, mo, days) {
    const en = MONTH_EN[mo], ab = en.slice(0, 3);
    switch (album.font) {
      case "editorial": return `<div class="al-head h-ed"><span class="yr">${y}</span><b>${en}</b></div>`;
      case "bignum": return `<div class="al-head h-big"><b>${mo + 1}</b><span>${en.toUpperCase()}<br>${y}</span></div>`;
      case "postmark": { // like a real rubber-stamp cancellation: month on top, year below, your text (or a cloud) inside
        const waves = [26, 40, 54, 68, 82].map((wy) => `M110 ${wy}q9-7 18 0t18 0t18 0t18 0t18 0t18 0`).join(""); // whole waves, a small gap after the circle
        const mid = pmCenterText(days);
        const big = emojiOnly(mid), midSize = pmMidSize(mid, big), midY = big ? 65 : 59;
        return `<div class="al-head h-pm"><svg viewBox="0 0 220 108" width="297" height="146" aria-label="${y}년 ${mo + 1}월" style="color:rgb(${pmInkRGB().join(",")})">
          <defs><path id="pm-top" d="M18 54a36 36 0 0 1 72 0"/><path id="pm-bot" d="M12 54a42 42 0 0 0 84 0"/>
            <filter id="pm-wear" x="-4%" y="-4%" width="108%" height="108%">
              <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="n"/>
              <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -2.6 0 0 0 2.05" result="keep"/>
              <feComposite in="SourceGraphic" in2="keep" operator="in" result="worn"/>
              <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="1" seed="3" result="w"/>
              <feDisplacementMap in="worn" in2="w" scale="1.6" xChannelSelector="R" yChannelSelector="G"/>
            </filter>
            <filter id="pm-wear-soft" x="-4%" y="-4%" width="108%" height="108%"><!-- emoji: a little wear, no smudge -->
              <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="1" seed="11" result="n"/>
              <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.6 0 0 0 1.75" result="keep"/>
              <feComposite in="SourceGraphic" in2="keep" operator="in"/>
            </filter>
</defs>
          <g filter="url(#pm-wear)">
            <g fill="none" stroke="currentColor" stroke-width="2"><circle cx="54" cy="54" r="50"/><path d="${waves}"/></g>
            <text font-size="13.5" letter-spacing="2.2" fill="currentColor"><textPath href="#pm-top" startOffset="50%" text-anchor="middle">${en.toUpperCase()}</textPath></text>
            <text font-size="13" letter-spacing="5" fill="currentColor"><textPath href="#pm-bot" startOffset="50%" text-anchor="middle">${y}</textPath></text>
            ${mid && !hasEmoji(mid)
              ? `<text x="54" y="${midY}" text-anchor="middle" font-size="${midSize}" fill="currentColor" class="pm-mid">${esc(mid)}</text>`
              : !mid ? `<path d="${CLOUD_PATH}" transform="translate(54 54) scale(1.3)" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
          </g>
          ${mid && hasEmoji(mid) ? (() => { // emoji: pre-inked picture (same as the saved image), 3× for sharpness, gentle wear
            const cv = inkPicture(mid, midSize * 3, pmInkRGB()), fit = Math.min(1, PM_MID_W / (cv.width / 3), PM_MID_H / (cv.height / 3));
            const iw = (cv.width / 3) * fit, ih = (cv.height / 3) * fit; // always inside the ring
            return `<image filter="url(#pm-wear-soft)" href="${cv.toDataURL()}" x="${(54 - iw / 2).toFixed(1)}" y="${(54 - ih / 2).toFixed(1)}" width="${iw.toFixed(1)}" height="${ih.toFixed(1)}"/>`;
          })() : ""}
          </svg></div>`;
      }
      case "typewriter": return `<div class="al-head h-tw"><b>${ab}. ${y}</b><span>— a month in stamps</span></div>`;
      case "serif": return `<div class="al-head h-se"><span class="yr">${y}</span><b>${mo + 1}월</b></div>`;
      case "script": return `<div class="al-head h-sc"><span class="yr">${y}</span><b>${en}</b></div>`;
      default: return `<div class="al-head">${y}<b>${mo + 1}월</b></div>`;
    }
  }
  // Rubber-stamp wear on a drawn layer: smooth noise (fixed seed) knocks out patches of ink.
  function wearInk(g, w, h, soft, scale = 1) { // scale: how big the stamp is drawn (noise shrinks with it)
    const img = g.getImageData(0, 0, w, h), d = img.data;
    const rnd = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
    const noise = (x, y) => { // value noise, bilinear
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const a = rnd(xi, yi), b = rnd(xi + 1, yi), c = rnd(xi, yi + 1), e = rnd(xi + 1, yi + 1);
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!d[i + 3]) continue;
      const n = noise(x / (3.2 * scale), y / (3.2 * scale)) * 0.6 + noise(x / (11 * scale), y / (11 * scale)) * 0.4; // fine grain + bigger blotches
      // Same curves as the screen's SVG filters (pm-wear: 2.05 − 2.6n, pm-wear-soft: 1.75 − 1.6n).
      const keep = Math.max(0, Math.min(1, soft ? 1.75 - 1.6 * n : 2.05 - 2.6 * n));
      d[i + 3] = Math.round(d[i + 3] * keep);
    }
    g.putImageData(img, 0, 0);
  }
  // Text along a circle, centered on its top (top=true, letters standing outward, read clockwise)
  // or its bottom (letters standing inward, read left to right). r is the baseline radius.
  function arcText(g, text, cx, cy, r, top, gap) {
    const ws = [...text].map((ch) => g.measureText(ch).width + gap);
    const total = ws.reduce((a, b) => a + b, 0) - gap;
    let acc = 0;
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    [...text].forEach((ch, i) => {
      const mid = acc + (ws[i] - gap) / 2;
      const a = top ? -Math.PI / 2 - total / 2 / r + mid / r : Math.PI / 2 + total / 2 / r - mid / r;
      g.save();
      g.translate(cx + r * Math.cos(a), cy + r * Math.sin(a));
      g.rotate(top ? a + Math.PI / 2 : a - Math.PI / 2);
      g.fillText(ch, 0, 0);
      g.restore();
      acc += ws[i];
    });
  }
  // Same header on the saved image (2× the screen size). Returns nothing; draws within y < 190.
  async function drawAlbumHeader(g, x, y, mo, ink, baseFont, days, pmScale = 1) {
    const en = MONTH_EN[mo], ab = en.slice(0, 3), F = HEAD_FONTS;
    const spaced = (text, px, py, gap) => { for (const ch of text) { g.fillText(ch, px, py); px += g.measureText(ch).width + gap; } return px; };
    const need = {
      editorial: [`400 24px ${F.year}`, `italic 600 92px ${F.italic}`], bignum: [`500 128px ${F.display}`, `400 22px ${F.year}`],
      postmark: [`400 26px ${F.type}`], typewriter: [`400 64px ${F.type}`], serif: [`300 24px ${F.serif}`, `500 84px ${F.serif}`],
      script: [`400 24px ${F.year}`, `600 104px ${F.script}`],
    }[album.font] || [];
    try { await Promise.all(need.map((f) => document.fonts.load(f, `${y}${en}${mo + 1}월`))); } catch (e) {}
    g.fillStyle = ink; g.strokeStyle = ink; g.textAlign = "left"; g.textBaseline = "alphabetic";
    switch (album.font) {
      case "editorial": g.font = need[0]; spaced(String(y), x, 78, 10); g.font = need[1]; g.fillText(en, x, 162); break;
      case "bignum": {
        g.font = need[0]; g.fillText(String(mo + 1), x, 168);
        const nx = x + g.measureText(String(mo + 1)).width + 22;
        g.font = need[1]; spaced(en.toUpperCase(), nx, 132, 6); spaced(String(y), nx, 164, 6); break;
      }
      case "postmark": { // the screen's SVG postmark (220×108 units) redrawn K× larger, then worn like a rubber stamp
        const [ir, ig, ib] = pmInkRGB(), pm = `rgb(${ir},${ig},${ib})`;
        const K = 460 / 220, S = 1.35 * pmScale, LW = Math.ceil(220 * K * S), LH = Math.ceil(108 * K * S); // K: units → canvas px, S: size up
        const layer = canvasOf(LW, LH), lg = layer.getContext("2d");
        lg.scale(S * K, S * K); // from here on, draw in the SVG's own units
        lg.strokeStyle = pm; lg.fillStyle = pm; lg.lineWidth = 2; lg.lineCap = "butt";
        lg.beginPath(); lg.arc(54, 54, 50, 0, 7); lg.stroke();
        for (const wy of [26, 40, 54, 68, 82]) { // M110 y q9-7 18 0 t18 0 ×5
          lg.beginPath(); lg.moveTo(110, wy);
          for (let k = 0; k < 6; k++) lg.quadraticCurveTo(110 + k * 18 + 9, wy + (k % 2 ? 7 : -7), 110 + (k + 1) * 18, wy);
          lg.stroke();
        }
        lg.font = `400 13.5px ${F.type}`; arcText(lg, en.toUpperCase(), 54, 54, 36, true, 2.2);
        lg.font = `400 13px ${F.type}`; arcText(lg, String(y), 54, 54, 42, false, 5);
        const mid = pmCenterText(days), big = emojiOnly(mid), midSize = pmMidSize(mid, big), midY = big ? 65 : 59;
        let emojiLater = null;
        if (mid && hasEmoji(mid)) { // emoji: same pre-inked picture as the screen, gentle wear
          try { await document.fonts.load(`700 ${midSize}px ${PM_FONT}`, mid); } catch (e) {}
          const q = K * S * 1.5, pic = inkPicture(mid, Math.round(midSize * q), [ir, ig, ib]);
          wearInk(pic.getContext("2d"), pic.width, pic.height, true, pmScale);
          const fit = Math.min(1, PM_MID_W / (pic.width / q), PM_MID_H / (pic.height / q)), pw = (pic.width / q) * fit, ph = (pic.height / q) * fit;
          emojiLater = () => lg.drawImage(pic, 54 - pw / 2, 54 - ph / 2, pw, ph);
        } else if (mid) { // plain text: same ink as the month and year
          const midFont = `700 ${midSize}px ${PM_FONT}`;
          try { await document.fonts.load(midFont, mid); } catch (e) {}
          lg.font = midFont; lg.textAlign = "center"; lg.fillText(mid, 54, midY);
        } else { // cloud: translate(54 54) scale(1.3), stroke 1.7
          lg.save(); lg.translate(54, 54); lg.scale(1.3, 1.3); lg.lineWidth = 1.7; lg.lineJoin = "round"; lg.lineCap = "round"; lg.stroke(new Path2D(CLOUD_PATH)); lg.restore();
        }
        wearInk(lg, LW, LH, false, pmScale);
        if (emojiLater) emojiLater();
        g.save(); g.globalAlpha = 0.9; g.drawImage(layer, x, 0); g.restore();
        break;
      }
      case "typewriter": g.font = need[0]; g.fillText(`${ab}. ${y}`, x, 132); g.globalAlpha = 0.55; g.font = `400 22px ${F.type}`; g.fillText("— a month in stamps", x, 168); g.globalAlpha = 1; break;
      case "serif": g.font = need[0]; spaced(String(y), x, 78, 8); g.font = need[1]; g.fillText(`${mo + 1}월`, x, 162); break;
      case "script": g.font = need[0]; spaced(String(y), x, 78, 10); g.font = need[1]; g.fillText(en, x, 166); break;
      default: g.font = "500 34px " + baseFont; g.fillText(String(y), x, 92); g.font = "700 64px " + baseFont; g.fillText(`${mo + 1}월`, x, 156);
    }
  }
  let albumMonth = null, albumRun = 0;
  const TW = 200, TH = 240; // thumbnail pixels (shown at half size, sharp on retina)
  const ALBUM_OPTS = {
    shape: [["stamp", "우표"], ["ticket", "티켓"], ["window", "창문"], ["polaroid", "폴라로이드"], ["round", "둥근 사각"], ["circle", "동그라미"]],
    filter: [["orig", "원본"], ["pixel", "픽셀아트"], ["glass", "스테인드글라스"], ["halftone", "망점"], ["pastel", "파스텔"]],
    bg: [["white", "흰색"], ["theme", "테마"]],
    gpal: [["night", "밤하늘"], ["sunset", "노을"], ["forest", "숲"], ["jewel", "보석"], ["photo", "사진 색"]],
    font: [["basic", "기본"], ["postmark", "우체국 소인"], ["editorial", "영문 이탤릭"], ["bignum", "큰 숫자"], ["typewriter", "타자기"], ["serif", "명조"], ["script", "영문 손글씨"]],
  };
  // Cover photo of a diary body: the one marked data-rep, else the first.
  function coverOf(body) { // { id, fx, fy } or null
    if (!body || !isHTML(body)) return null;
    const tpl = document.createElement("template");
    tpl.innerHTML = body.slice(HTML_MARKER.length);
    const img = tpl.content.querySelector('img[data-rep="1"]') || tpl.content.querySelector("img[data-img]");
    const id = img && img.getAttribute("data-img");
    if (!id || !IMG_ID.test(id)) return null;
    const fx = parseFloat(img.getAttribute("data-fx")), fy = parseFloat(img.getAttribute("data-fy"));
    return { id, fx: isNaN(fx) ? null : fx, fy: isNaN(fy) ? null : fy };
  }
  function monthCovers(y, mo) {
    const prefix = `${y}-${pad(mo + 1)}-`, out = new Map();
    let locked = false;
    for (const m of memos) {
      if (!isDiary(m) || !m.diary.startsWith(prefix)) continue;
      const b = bodyOf(m);
      if (b == null) { locked = true; continue; }
      const cv = coverOf(b);
      const prev = out.get(m.diary);
      if (cv && (!prev || m.updated > prev.updated)) out.set(m.diary, { ...cv, updated: m.updated });
    }
    return { covers: out, locked };
  }
  const loadImage = (url) => new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = url; });
  function canvasOf(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  // Which part of a picture fills a w×h frame: the stretch with the most detail (usually the face),
  // pulled a little toward the middle. Kept per picture and shape, so GIF frames don't jump.
  const cropCache = new WeakMap();
  function cropBox(img, w, h) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.max(w / iw, h / ih), cw = w / s, ch = h / s, F = img._cmFocus;
    const key = `${Math.round((cw / iw) * 1000)}:${Math.round((ch / ih) * 1000)}:${F ? F.x + "," + F.y : ""}`;
    let m = cropCache.get(img);
    if (!m) { m = new Map(); cropCache.set(img, m); }
    if (m.has(key)) return m.get(key);
    let sx = (iw - cw) / 2, sy = (ih - ch) / 2;
    const free = iw - cw > 2 ? "x" : ih - ch > 2 ? "y" : "";
    if (F) { // a picked "중심": it goes in the middle of the frame (as far as the picture allows)
      sx = Math.max(0, Math.min(iw - cw, F.x * iw - cw / 2));
      sy = Math.max(0, Math.min(ih - ch, F.y * ih - ch / 2));
    } else if (free) {
      const k = 64 / Math.max(iw, ih), tw = Math.max(8, Math.round(iw * k)), th = Math.max(8, Math.round(ih * k));
      const t = canvasOf(tw, th), tg = t.getContext("2d", { willReadFrequently: true });
      tg.drawImage(img, 0, 0, tw, th);
      const d = tg.getImageData(0, 0, tw, th).data, L = new Float32Array(tw * th), line = new Float32Array(free === "x" ? tw : th);
      for (let i = 0; i < tw * th; i++) L[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
      for (let y = 1; y < th - 1; y++) for (let x = 1; x < tw - 1; x++) {
        const e = Math.abs(L[y * tw + x + 1] - L[y * tw + x - 1]) + Math.abs(L[(y + 1) * tw + x] - L[(y - 1) * tw + x]);
        line[free === "x" ? x : y] += e;
      }
      const n = line.length, win = Math.max(1, Math.round((free === "x" ? cw / iw : ch / ih) * n));
      let best = 0, bestScore = -1;
      for (let a = 0; a + win <= n; a++) {
        let sum = 0;
        for (let i = a; i < a + win; i++) sum += line[i];
        const off = Math.abs(a + win / 2 - n / 2) / Math.max(1, (n - win) / 2);
        const score = sum * (1 - 0.3 * off);
        if (score > bestScore) { bestScore = score; best = a; }
      }
      if (free === "x") sx = Math.min(iw - cw, Math.max(0, (best / n) * iw)); else sy = Math.min(ih - ch, Math.max(0, (best / n) * ih));
    }
    const box = { sx, sy, cw, ch };
    m.set(key, box);
    return box;
  }
  function coverDraw(g, img, w, h) { // fill w×h with the best part of the picture (an image or a canvas)
    const b = cropBox(img, w, h);
    g.drawImage(img, b.sx, b.sy, b.cw, b.ch, 0, 0, w, h);
  }
  function smallPixels(img, w, h) {
    const c = canvasOf(w, h), g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    coverDraw(g, img, w, h);
    return g.getImageData(0, 0, w, h);
  }
  // One palette for the whole month (k-means on small samples), so the stamps look like a set.
  function monthPalette(imgs, k) {
    const px = [];
    for (const im of imgs) {
      const d = smallPixels(im, 20, 24).data;
      for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
    }
    return kmeans(px, k);
  }
  // k representative colors of a list of [r,g,b] (k-means, 8 rounds, seeded across brightness).
  function kmeans(px, k) {
    if (!px.length) return [[0, 0, 0]];
    const lum = (p) => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
    px = px.slice();
    px.sort((a, b) => lum(a) - lum(b));
    let cs = Array.from({ length: k }, (_, i) => px[Math.floor((i + 0.5) * px.length / k)].slice());
    for (let it = 0; it < 8; it++) {
      const sum = cs.map(() => [0, 0, 0, 0]);
      for (const p of px) { const j = nearestIdx(cs, p); const s = sum[j]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; }
      cs = cs.map((c, j) => (sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : c));
    }
    return cs.map((c) => c.map(Math.round));
  }
  function nearestIdx(cs, p) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < cs.length; j++) {
      const c = cs[j], d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }
  // Thumbnail for one photo with the chosen filter.
  // memo (optional, per animated photo): keeps the pixel-art colors of its first frame for the rest.
  function stampCanvas(img, filter, pal, memo, W = TW, H = TH) {
    const out = canvasOf(W, H), g = out.getContext("2d");
    if (filter === "pixel") { // pixel art: strong color, then only 16 colors picked from this photo
      const w = Math.round((32 * W) / TW), h = Math.round((38 * H) / TH), d = smallPixels(img, w, h), px = [];
      for (let i = 0; i < d.data.length; i += 4) {
        const r = d.data[i], gg = d.data[i + 1], b = d.data[i + 2], l = r * 0.3 + gg * 0.59 + b * 0.11;
        const f = (v) => Math.max(0, Math.min(255, Math.round((l + (v - l) * 1.6 - 128) * 1.12 + 128)));
        const p = [f(r), f(gg), f(b)];
        d.data[i] = p[0]; d.data[i + 1] = p[1]; d.data[i + 2] = p[2];
        px.push(p);
      }
      const own = (memo && memo.own) || kmeans(px, 16);
      if (memo) memo.own = own;
      for (let i = 0; i < d.data.length; i += 4) {
        const c = own[nearestIdx(own, [d.data[i], d.data[i + 1], d.data[i + 2]])];
        d.data[i] = c[0]; d.data[i + 1] = c[1]; d.data[i + 2] = c[2];
      }
      const s = canvasOf(w, h); s.getContext("2d").putImageData(d, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(s, 0, 0, W, H);
    } else if (filter === "glass") {
      drawGlass(g, img, memo, W, H);
    } else if (filter === "halftone") { // print dots: bigger where darker, on cream paper
      const cell = 10, w = Math.round(W / cell), h = Math.round(H / cell), d = smallPixels(img, w, h).data;
      g.fillStyle = "#f5efe2"; g.fillRect(0, 0, W, H);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, p = [d[i], d[i + 1], d[i + 2]];
        const l = (p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11) / 255;
        const c = pal[nearestIdx(pal, p)];
        const r = Math.max(0.9, (cell / 2) * 1.15 * Math.sqrt(1 - l * 0.92));
        g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        g.beginPath(); g.arc(x * cell + cell / 2 + (y % 2 ? cell / 4 : 0), y * cell + cell / 2, r, 0, Math.PI * 2); g.fill();
      }
    } else if (filter === "pastel") { // flat palette colors, softened toward white
      const w = Math.round((80 * W) / TW), h = Math.round((96 * H) / TH), d = smallPixels(img, w, h);
      for (let i = 0; i < d.data.length; i += 4) {
        const c = pal[nearestIdx(pal, [d.data[i], d.data[i + 1], d.data[i + 2]])];
        for (let k = 0; k < 3; k++) d.data[i + k] = Math.round(c[k] * 0.68 + 255 * 0.32);
      }
      const s = canvasOf(w, h); s.getContext("2d").putImageData(d, 0, 0);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
      g.drawImage(s, 0, 0, W, H);
    } else {
      g.imageSmoothingQuality = "high";
      coverDraw(g, img, W, H);
    }
    return out;
  }
  // Stained glass: the picture split into a few dozen pieces that follow its shapes and colors (SLIC on a
  // 100×120 copy), each piece one deeper color that glows toward its middle, gold lead between.
  // memo (animated photos): the pieces of the first frame are kept, so the lead doesn't jump.
  function glassPieces(d, k, w, h) {
    const S = Math.sqrt((w * h) / k), cs = [];
    const rnd = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
    for (let y = S / 2; y < h; y += S) for (let x = S / 2; x < w; x += S) { // seeds a little off the grid: uneven pieces
      const j = cs.length, sx = Math.max(0, Math.min(w - 1, x + (rnd(j) - 0.5) * S * 0.7)), sy = Math.max(0, Math.min(h - 1, y + (rnd(j + 99) - 0.5) * S * 0.7));
      const i = ((sy | 0) * w + (sx | 0)) * 4;
      cs.push([sx, sy, d[i], d[i + 1], d[i + 2], S]);
    }

    let lab = new Int32Array(w * h).fill(0);
    const dist = new Float32Array(w * h), m2 = 30 * 30;
    for (let it = 0; it < 6; it++) {
      dist.fill(Infinity);
      cs.forEach((c, ci) => {
        const Sc = c[5], S2 = Sc * Sc;
        const x0 = Math.max(0, (c[0] - Sc) | 0), x1 = Math.min(w - 1, (c[0] + Sc) | 0);
        const y0 = Math.max(0, (c[1] - Sc) | 0), y1 = Math.min(h - 1, (c[1] + Sc) | 0);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const i = y * w + x, o = i * 4;
          const dc = (d[o] - c[2]) ** 2 + (d[o + 1] - c[3]) ** 2 + (d[o + 2] - c[4]) ** 2;
          const D = dc + (((x - c[0]) ** 2 + (y - c[1]) ** 2) / S2) * m2;
          if (D < dist[i]) { dist[i] = D; lab[i] = ci; }
        }
      });
      const sum = cs.map(() => [0, 0, 0, 0, 0, 0]);
      for (let i = 0; i < w * h; i++) { const t = sum[lab[i]], o = i * 4; t[0] += i % w; t[1] += (i / w) | 0; t[2] += d[o]; t[3] += d[o + 1]; t[4] += d[o + 2]; t[5]++; }
      cs.forEach((c, ci) => { const t = sum[ci]; if (t[5]) for (let j = 0; j < 5; j++) c[j] = t[j] / t[5]; }); // c[5] (its size) stays
    }
    for (let pass = 0; pass < 3; pass++) { // smooth the edges: each cell takes its neighbors' most common piece
      const out = new Int32Array(lab);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const cnt = new Map();
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const l = lab[(y + dy) * w + x + dx]; cnt.set(l, (cnt.get(l) || 0) + 1); }
        let best = lab[y * w + x], bn = 0;
        for (const [l, n] of cnt) if (n > bn) { bn = n; best = l; }
        out[y * w + x] = best;
      }
      lab = out;
    }
    // Neighbors of nearly the same color become one bigger pane (flat sky = a few big panes, not tiles).
    const n0 = cs.length, mean = new Float32Array(n0 * 4);
    for (let i = 0; i < w * h; i++) { const l = lab[i] * 4, o = i * 4; mean[l] += d[o]; mean[l + 1] += d[o + 1]; mean[l + 2] += d[o + 2]; mean[l + 3]++; }
    const par = Array.from({ length: n0 }, (_, i) => i), size = new Float32Array(n0), acc = new Float32Array(n0 * 3);
    for (let l = 0; l < n0; l++) { const c = mean[l * 4 + 3] || 1; size[l] = mean[l * 4 + 3]; for (let j = 0; j < 3; j++) acc[l * 3 + j] = mean[l * 4 + j]; mean[l * 4] /= c; mean[l * 4 + 1] /= c; mean[l * 4 + 2] /= c; }
    const root = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
    const pairs = new Map();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = lab[y * w + x];
      for (const b of [x < w - 1 ? lab[y * w + x + 1] : a, y < h - 1 ? lab[(y + 1) * w + x] : a]) if (a !== b) pairs.set(a < b ? a * 4096 + b : b * 4096 + a, 1);
    }
    const colDist = (a, b) => { const sa = size[a] || 1, sb = size[b] || 1; let t = 0; for (let j = 0; j < 3; j++) t += (acc[a * 3 + j] / sa - acc[b * 3 + j] / sb) ** 2; return Math.sqrt(t); };
    const maxSize = (w * h / k) * 6;
    for (let round = 0; round < 3; round++) {
      const list = [...pairs.keys()].map((key) => [Math.floor(key / 4096), key % 4096]).map(([a, b]) => [root(a), root(b)]).filter(([a, b]) => a !== b)
        .map(([a, b]) => [colDist(a, b), a, b]).sort((p, q) => p[0] - q[0]);
      for (const [, a0, b0] of list) {
        const a = root(a0), b = root(b0);
        const lumOf = (q) => (acc[q * 3] * 0.3 + acc[q * 3 + 1] * 0.59 + acc[q * 3 + 2] * 0.11) / (size[q] || 1);
        const limit = lumOf(a) < 75 && lumOf(b) < 75 ? 56 : 30; // dark fur and shadows: fewer, bigger panes
        if (a === b || colDist(a, b) > limit || size[a] + size[b] > maxSize * (limit > 30 ? 1.6 : 1)) continue;
        par[b] = a; size[a] += size[b]; for (let j = 0; j < 3; j++) acc[a * 3 + j] += acc[b * 3 + j];
      }
    }
    const ids = new Map();
    for (let i = 0; i < w * h; i++) { const r = root(lab[i]); if (!ids.has(r)) ids.set(r, ids.size); lab[i] = ids.get(r); }
    const n = ids.size, cx = new Float32Array(n), cy = new Float32Array(n), cnt = new Float32Array(n);
    for (let i = 0; i < w * h; i++) { const l = lab[i]; cx[l] += i % w; cy[l] += (i / w) | 0; cnt[l]++; }
    for (let l = 0; l < n; l++) if (cnt[l]) { cx[l] /= cnt[l]; cy[l] /= cnt[l]; }
    const R = new Float32Array(n); // each pane's reach, for its glow
    for (let l = 0; l < n; l++) R[l] = Math.sqrt(cnt[l] / Math.PI) * 1.25 + 1;
    return { lab, n, cx, cy, R };
  }
  // Glass colors: a few fixed colors for every window of the month, so photos look like one
  // set of glass (light/dark of the photo picks the color; strong warm or cool parts get the accent).
  const GLASS_PALS = {
    night: { ramp: ["#17224a", "#243c78", "#3a5fa8", "#7aa1d6", "#c5daef", "#f5f2e8"], accent: ["#b98a2c", "#ecc96b"], accentWarm: true },
    sunset: { ramp: ["#35204a", "#62305f", "#a94a68", "#e27d67", "#f4b688", "#fbe8cd"], accent: ["#33528f", "#86a7d6"], accentWarm: false },
    forest: { ramp: ["#18301f", "#2b5438", "#4a8452", "#8bbb76", "#cde2b2", "#f4f0dc"], accent: ["#83552a", "#d7a45a"], accentWarm: true },
    jewel: { near: ["#1a1c38", "#263f92", "#2f7fc0", "#1e7a6b", "#3e9b4f", "#8d2446", "#c9453e", "#d98b2b", "#e9c86a", "#7b4a9e", "#f3ead2", "#b9c7d8"] },
  };
  const gpalSample = (v) => {
    const P = GLASS_PALS[v], cs = P ? (P.ramp ? [P.ramp[1], P.ramp[3], P.ramp[5], P.accent[1]] : [P.near[1], P.near[5], P.near[3], P.near[8]]) : ["#c98a4a", "#6aa0c8", "#7bb36a", "#e2c4a0"];
    return `<span class="gp">${cs.map((c) => `<i style="background:${c}"></i>`).join("")}</span>`;
  };
  const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  // Pane colors → palette colors. lum: [low, high] luminance of the picture (kept per GIF).
  function glassRemap(col, lums, sizes, palName, memo) {
    const P = GLASS_PALS[palName];
    if (!P) return col;
    if (P.near) return col.map((c) => { const L = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11, k = 1.6; return hexRGB(P.near[nearestIdx(P.near.map(hexRGB), c.map((v) => L + (v - L) * k))]); });
    let range = memo && memo.lumRange;
    if (!range) { // 8th and 92nd percentile of the panes' brightness (by area), so each photo uses the whole ramp
      const order = lums.map((L, i) => [L, sizes[i]]).sort((a, b) => a[0] - b[0]), total = sizes.reduce((a, b) => a + b, 0) || 1;
      let accum = 0, lo = order[0][0], hi = order[order.length - 1][0];
      for (const [L, n] of order) { accum += n; if (accum / total < 0.08) lo = L; if (accum / total < 0.92) hi = L; }
      range = [lo, Math.max(lo + 30, hi)];
      if (memo) memo.lumRange = range;
    }
    const ramp = P.ramp.map(hexRGB), acc = P.accent.map(hexRGB);
    return col.map((c, i) => {
      const t = Math.max(0, Math.min(1, (lums[i] - range[0]) / (range[1] - range[0])));
      const chroma = Math.max(...c) - Math.min(...c), sat = chroma / Math.max(1, Math.max(...c)), warm = c[0] - c[2];
      if (chroma > 60 && sat > 0.42 && (P.accentWarm ? warm > 40 : warm < -30)) return acc[t > 0.5 ? 1 : 0]; // only truly vivid parts
      return ramp[Math.round(t * (ramp.length - 1))];
    });
  }
  function drawGlass(g, img, memo, W, H) {
    const GW = Math.round(W / 2), GH = Math.round(H / 2), d = smallPixels(img, GW, GH).data;
    const P = (memo && memo.glass) || glassPieces(d, Math.max(18, Math.round((52 * GW * GH) / 12000)), GW, GH);
    if (memo) memo.glass = P;
    const { lab, n, cx, cy, R } = P, sum = new Float32Array(n * 4);
    for (let i = 0; i < GW * GH; i++) { const l = lab[i] * 4, o = i * 4; sum[l] += d[o]; sum[l + 1] += d[o + 1]; sum[l + 2] += d[o + 2]; sum[l + 3]++; }
    let col = [];
    const lums = [], sizes = [], raw = [];
    for (let l = 0; l < n; l++) { const c = sum[l * 4 + 3] || 1; raw.push([sum[l * 4] / c, sum[l * 4 + 1] / c, sum[l * 4 + 2] / c]); lums.push(raw[l][0] * 0.3 + raw[l][1] * 0.59 + raw[l][2] * 0.11); sizes.push(sum[l * 4 + 3]); }
    const palName = album.gpal || "night", fixedPal = palName !== "photo" && GLASS_PALS[palName];
    for (let l = 0; l < n; l++) { // the piece's color: deeper and more saturated, like colored glass
      const c = sum[l * 4 + 3] || 1;
      let r = sum[l * 4] / c, gg = sum[l * 4 + 1] / c, b = sum[l * 4 + 2] / c;
      // Colored parts get richer; whites and grays stay clear glass instead of turning yellow.
      const L = r * 0.3 + gg * 0.59 + b * 0.11, chroma = Math.max(r, gg, b) - Math.min(r, gg, b);
      const k = L > 165 ? 1 : 1 + 0.55 * Math.min(1, Math.max(0, chroma - 14) / 50); // light parts: no extra color
      if (L > 165 && chroma < 45) { const m = (r + gg + b) / 3; r = m + (r - m) * 0.45; gg = m + (gg - m) * 0.45; b = m + (b - m) * 0.45; } // warm whites → white
      r = L + (r - L) * k; gg = L + (gg - L) * k; b = L + (b - L) * k;
      if (chroma < 28 && L > 150) { r = r * 0.92 + 8; gg = gg * 0.94 + 10; b = b * 0.94 + 18; } // a faint cool tint, like clear glass
      col.push([r, gg, b].map((v) => Math.max(0, Math.min(255, (v - 128) * 1.12 + 124))));
    }
    let lab2 = lab, n2 = n, cx2 = cx, cy2 = cy, R2 = R;
    if (fixedPal) { // neighbors that got the same palette color become one big pane: lead only where the color changes
      col = glassRemap(raw, lums, sizes, palName, memo);
      const par = Array.from({ length: n }, (_, i) => i), root = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
      const same = (a, b) => col[a][0] === col[b][0] && col[a][1] === col[b][1] && col[a][2] === col[b][2];
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
        const a = lab[y * GW + x];
        if (x < GW - 1) { const b = lab[y * GW + x + 1]; if (a !== b && same(a, b)) par[root(b)] = root(a); }
        if (y < GH - 1) { const b = lab[(y + 1) * GW + x]; if (a !== b && same(a, b)) par[root(b)] = root(a); }
      }
      const ids = new Map(), gcol = [];
      lab2 = new Int32Array(GW * GH);
      for (let i = 0; i < GW * GH; i++) { const r = root(lab[i]); if (!ids.has(r)) { ids.set(r, ids.size); gcol.push(col[r]); } lab2[i] = ids.get(r); }
      for (let pass = 0; pass < 2; pass++) { // round off the big panes' edges
        const out = new Int32Array(lab2);
        for (let y = 1; y < GH - 1; y++) for (let x = 1; x < GW - 1; x++) {
          const cnt = new Map();
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const l = lab2[(y + dy) * GW + x + dx]; cnt.set(l, (cnt.get(l) || 0) + 1); }
          let best = lab2[y * GW + x], bn = 0;
          for (const [l, k] of cnt) if (k > bn) { bn = k; best = l; }
          out[y * GW + x] = best;
        }
        lab2 = out;
      }
      n2 = ids.size; col = gcol;
      cx2 = new Float32Array(n2); cy2 = new Float32Array(n2); R2 = new Float32Array(n2);
      const cnt = new Float32Array(n2);
      for (let i = 0; i < GW * GH; i++) { const l = lab2[i]; cx2[l] += i % GW; cy2[l] += (i / GW) | 0; cnt[l]++; }
      for (let l = 0; l < n2; l++) { if (cnt[l]) { cx2[l] /= cnt[l]; cy2[l] /= cnt[l]; } R2[l] = Math.sqrt(cnt[l] / Math.PI) * 1.25 + 1; }
    }
    const glass = new ImageData(GW, GH), leads = [new ImageData(GW, GH), new ImageData(GW, GH), new ImageData(GW, GH)];
    const LEAD = [[80, 58, 20], [214, 178, 98], [248, 230, 168]]; // shadow, gold, shine
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const i = y * GW + x, l = lab2[i], o = i * 4, c = col[l];
      const t = Math.min(1, Math.hypot(x - cx2[l], y - cy2[l]) / R2[l]);
      const f = 1.08 - 0.24 * t * t + (((x + y * 0.6) % 23) < 2.2 ? 0.05 : 0); // glow in the middle, a faint streak
      glass.data[o] = Math.min(255, c[0] * f); glass.data[o + 1] = Math.min(255, c[1] * f); glass.data[o + 2] = Math.min(255, c[2] * f); glass.data[o + 3] = 255;
      const edge = (x < GW - 1 && lab2[i + 1] !== l) || (y < GH - 1 && lab2[i + GW] !== l) || x === 0 || y === 0 || x === GW - 1 || y === GH - 1;
      if (edge) leads.forEach((ld, j) => { ld.data[o] = LEAD[j][0]; ld.data[o + 1] = LEAD[j][1]; ld.data[o + 2] = LEAD[j][2]; ld.data[o + 3] = 255; });
    }
    const gc = canvasOf(GW, GH), [dark, gold, shine] = leads.map((ld) => { const c = canvasOf(GW, GH); c.getContext("2d").putImageData(ld, 0, 0); return c; });
    gc.getContext("2d").putImageData(glass, 0, 0);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    if (fixedPal) { // the palette's glass, with only the photo's light and shade showing through (shapes stay readable)
      g.drawImage(gc, 0, 0, W, H);
      g.save(); g.globalCompositeOperation = "luminosity"; g.globalAlpha = 0.2; coverDraw(g, img, W, H); g.restore();
    } else { // the photo shows faintly through the colored glass, so faces and shapes stay recognizable
      coverDraw(g, img, W, H);
      g.save(); g.globalAlpha = 0.64; g.drawImage(gc, 0, 0, W, H); g.restore();
    }
    g.save(); // the lead: a soft dark edge, then thin gold with a light line on top
    g.globalAlpha = 0.3;
    for (const [dx, dy] of [[-0.8, 0], [0.8, 0], [0, -0.8], [0, 0.8]]) g.drawImage(dark, dx, dy, W, H);
    g.globalAlpha = 1;
    for (const [dx, dy] of [[0, 0], [0.35, 0.35]]) g.drawImage(gold, dx, dy, W, H);
    g.globalAlpha = 0.5; g.drawImage(shine, -0.3, -0.3, W, H);
    g.restore();
  }
  // 창문: each day gets its own window size and frame, fixed by its date (the same every time):
  // tall, wide, small or panorama; frames: 0 arch, 1 oval, 2 cut corners, 3 rounded, 4 low dome.
  const hash01 = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
  const WIN_SIZES = [{ w: 180, h: 240, k: [0, 1, 2, 3] }, { w: 330, h: 200, k: [3, 4, 1, 2] }, { w: 150, h: 190, k: [1, 3, 0] }, { w: 400, h: 170, k: [3, 2, 4] }];
  // Every size × frame, in the order a tap walks through them.
  const WIN_VARIANTS = WIN_SIZES.flatMap((v) => v.k.map((kind) => ({ w: v.w, h: v.h, kind })));
  const WINPICK_KEY = "cloudmemo.winPick"; // date → chosen variant (this device)
  let winPick = lsGet(WINPICK_KEY, {});
  function winLay(s, y, mo) {
    const seed = y * 500 + mo * 40 + s.d, r = hash01(seed), dy = Math.round((hash01(seed + 0.71) - 0.5) * 26);
    const picked = WIN_VARIANTS[winPick[s.key]];
    if (picked) return { ...picked, dy };
    const v = !s.id ? WIN_SIZES[2] : WIN_SIZES[r < 0.42 ? 0 : r < 0.68 ? 1 : r < 0.84 ? 2 : 3];
    return { w: v.w, h: v.h, kind: v.k[Math.floor(hash01(seed + 0.37) * v.k.length)], dy };
  }
  // 티켓: one size of old paper ticket per day, a little crooked; the photo sits in its window.
  const TKT = { w: 200, h: 356, pw: 160, ph: 214 }; // a 3:4 photo window, like a phone photo
  function ticketLay(s, y, mo) {
    const seed = y * 500 + mo * 40 + s.d;
    return { w: TKT.w, h: TKT.h, pw: TKT.pw, ph: TKT.ph, kind: 0, dy: Math.round((hash01(seed + 0.71) - 0.5) * 22), tilt: +((hash01(seed + 0.13) - 0.5) * 7).toFixed(1) };
  }
  // 한 주씩 이어 붙이기: each week (Sun–Sat) is one roll of tickets in one paper color; only the
  // roll's two ends have notched corners, and a dashed tear line runs between the tickets.
  const rollOn = () => album.shape === "ticket" && !!album.roll;
  let rollInfo = null; // date → { paper, left, right, week }
  function setRoll(list, y, mo) {
    rollInfo = null;
    if (!rollOn()) return;
    rollInfo = new Map();
    const first = new Date(y, mo, 1).getDay(), weekOf = (d) => Math.floor((d - 1 + first) / 7);
    list.forEach((s, i) => {
      const w = weekOf(s.d), prev = list[i - 1], next = list[i + 1];
      rollInfo.set(s.key, { week: w, paper: TICKET_PAPERS[Math.floor(hash01(y * 53 + mo * 7 + w * 3.3) * TICKET_PAPERS.length)],
        left: !prev || weekOf(prev.d) !== w, right: !next || weekOf(next.d) !== w });
    });
  }
  const looseShape = () => album.shape === "window" || album.shape === "ticket";
  function layOf(s, y, mo) {
    if (album.shape === "ticket") {
      const L = ticketLay(s, y, mo), R = rollInfo && rollInfo.get(s.key);
      return R ? { ...L, dy: 0, tilt: 0, kind: R, week: R.week } : { ...L, kind: null };
    }
    const L = winLay(s, y, mo);
    return { ...L, pw: L.w, ph: L.h, tilt: 0 };
  }
  // A tap on a window: the next size/frame for that day.
  function nextWindow(s, y, mo) {
    const L = winLay(s, y, mo), i = WIN_VARIANTS.findIndex((v) => v.w === L.w && v.h === L.h && v.kind === L.kind);
    winPick = { ...winPick, [s.key]: (i + 1) % WIN_VARIANTS.length };
    lsSet(WINPICK_KEY, winPick);
  }
  // Little gold stars scattered between the windows (fixed per month).
  function sparkles(x, y, w, h, seed) {
    const out = [], n = Math.round((w * h) / 12000);
    for (let i = 0; i < n; i++) {
      const r = hash01(seed + i * 3.1);
      out.push({ x: x + hash01(seed + i * 1.7) * w, y: y + hash01(seed + i * 2.3) * h, r: r < 0.7 ? 4 + r * 6 : 10 + r * 6, dot: hash01(seed + i * 5.9) < 0.3 });
    }
    return out;
  }
  function drawSparkles(g, list) {
    g.save();
    for (const p of list) {
      g.fillStyle = p.dot ? "rgba(201,162,74,.75)" : "#cfa64e";
      g.beginPath();
      if (p.dot) g.arc(p.x, p.y, p.r * 0.28, 0, Math.PI * 2);
      else for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4, rr = k % 2 ? p.r * 0.24 : p.r; g.lineTo(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr); }
      g.closePath(); g.fill();
    }
    g.restore();
  }
  // 글씨 buttons show a small sample in their own style instead of a name.
  const FONT_SAMPLE = {
    basic: `<span style="font-weight:700">11월</span>`,
    postmark: `<svg viewBox="0 0 40 22" width="36" height="20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="11" cy="11" r="9.5"/><path d="M23 7q3-2 6 0t6 0M23 11q3-2 6 0t6 0M23 15q3-2 6 0t6 0"/></g></svg>`,
    editorial: `<span style="font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:600;font-size:16px">Nov</span>`,
    bignum: `<span style="font-family:'Playfair Display',serif;font-size:16px">11</span><small style="font-family:'Josefin Sans';font-size:8px;letter-spacing:1px;margin-left:2px">NOV</small>`,
    typewriter: `<span style="font-family:'Special Elite',monospace">Nov.</span>`,
    serif: `<span style="font-family:'Hahmlet',serif;font-weight:500">11월</span>`,
    script: `<span style="font-family:'Caveat',cursive;font-weight:600;font-size:17px">Nov</span>`,
  };
  function albumOptions() {
    const seg = (key) => `<div class="seg al-seg${key === "font" ? " al-fonts" : ""}" data-k="${key}">` + ALBUM_OPTS[key].map(([v, n]) =>
      `<button type="button" data-v="${v}" class="${album[key] === v ? "on" : ""}" title="${n}" aria-label="${n}">${key === "font" ? FONT_SAMPLE[v] : key === "gpal" ? gpalSample(v) + n : n}</button>`).join("") + `</div>`;
    $("al-opts").innerHTML =
      `<div class="al-row"><span>모양</span>${seg("shape")}</div>` +
      `<div class="al-row"><span>필터</span>${seg("filter")}</div>` +
      (album.filter === "glass" ? `<div class="al-row"><span>유리 색</span>${seg("gpal")}</div>` : "") +
      `<div class="al-row"><span>글씨</span>${seg("font")}</div>` +
      (album.font === "postmark"
        ? `<div class="al-row al-pm"><span>가운데</span><input id="al-pm" maxlength="16" placeholder="비우면 구름" value="${esc(album.pmCenter === "{days}" ? "" : album.pmCenter || "")}" aria-label="소인 가운데 글자 (이모지도 돼)">` +
          `<button type="button" class="al-pm-q${album.pmCenter === "{days}" ? " on" : ""}" data-pm="{days}">사진 수</button></div>`
        : "") +
      (album.shape === "ticket" ? `<div class="al-row"><span>티켓</span><label class="al-empty"><input type="checkbox" id="al-roll"${album.roll ? " checked" : ""}> 한 주씩 이어 붙이기</label></div>` : "") +
      `<div class="al-row"><span>배경</span>${seg("bg")}<label class="al-empty"><input type="checkbox" id="al-empty"${album.empty ? " checked" : ""}> 빈 날도</label></div>`;
  }
  async function renderAlbum() {
    const run = ++albumRun;
    const y = albumMonth.getFullYear(), mo = albumMonth.getMonth();
    $("al-title").textContent = `${y}년 ${mo + 1}월`;
    albumOptions();
    const page = $("al-page");
    page.className = `al-page bg-${album.bg} shape-${album.shape}`;
    const { covers, locked } = monthCovers(y, mo);
    const days = new Date(y, mo + 1, 0).getDate();
    const list = [];
    for (let d = 1; d <= days; d++) {
      const key = `${y}-${pad(mo + 1)}-${pad(d)}`, c = covers.get(key);
      if (c || album.empty) list.push({ key, d, id: c ? c.id : "", dow: new Date(y, mo, d).getDay(), focus: c && c.fx != null && c.fy != null ? { x: c.fx, y: c.fy } : null });
    }
    page.classList.toggle("few", list.length > 0 && list.length <= ALBUM_FEW);
    page.style.setProperty("--pm", pmScaleFor(list.length));
    $("al-count").textContent = (covers.size ? `사진 ${covers.size}일` : "이 달엔 대표 사진이 아직 없어") + (locked && !vault ? " · 잠긴 일기는 열어야 보여" : "");
    setRoll(list, y, mo);
    countTickets();
    page.classList.toggle("roll", rollOn());
    const win = looseShape(), lays = new Map(win ? list.map((s) => [s.key, layOf(s, y, mo)]) : []);
    const boxStyle = (L) => `width:${(L.w + 24) / 2}px;height:${(L.h + 24) / 2}px;margin-top:${L.dy}px${L.tilt ? `;transform:rotate(${L.tilt}deg)` : ""}`;
    const winStyle = (s) => { const L = lays.get(s.key); return L ? ` style="${boxStyle(L)}"` : ""; };
    const weekBreak = (s, i) => (rollInfo && i > 0 && rollInfo.get(s.key).week !== rollInfo.get(list[i - 1].key).week ? `<i class="wk-br"></i>` : "");
    page.innerHTML = headerHTML(y, mo, covers.size) + `<div class="al-grid">` + list.map((s, i) => weekBreak(s, i) +
      `<button type="button" class="stp${s.id ? "" : " none"}${tornAt(i, list.length) ? " torn" : ""}${s.dow === 0 ? " sun" : s.dow === 6 ? " sat" : ""}" data-day="${s.key}" title="${album.shape === "window" ? `${s.key} · 눌러서 창문 모양 바꾸기, 두 번 눌러 일기 열기` : `${s.key} 일기 열기`}"${winStyle(s)}><span class="ph"></span><b>${s.d}</b></button>`).join("") + `</div>`;
    // Load the photos, then draw them all with one palette.
    const imgs = new Map(), gifs = new Map();
    await Promise.all(list.filter((s) => s.id).map(async (s) => {
      try {
        const u = await photoSrc(s.id);
        if (!u) return;
        const im = await loadImage(u);
        if (s.focus) im._cmFocus = s.focus; // the "중심" picked on the photo
        imgs.set(s.id, im);
        const buf = await (await fetch(u)).arrayBuffer();
        if (isGif(buf)) gifs.set(s.id, buf);
      } catch (e) {}
    }));
    if (win) await dayFontsReady(); // window labels are drawn on the canvas
    if (run !== albumRun) return;
    const pal = album.filter === "halftone" || album.filter === "pastel" ? monthPalette([...imgs.values()], 10) : null;
    // Animated covers: every frame through the same filter (fewer frames each when there are many).
    const anims = new Map(), perGif = Math.max(6, Math.min(36, Math.floor(360 / Math.max(1, gifs.size))));
    for (const [id, buf] of gifs) {
      const owner = list.find((x) => x.id === id) || {}, frames = [], delays = [], memo = {}, L = win && lays.get(owner.key);
      try { gifFrames(buf, perGif, (cv, delay) => { if (owner.focus) cv._cmFocus = owner.focus; frames.push(stampCanvas(cv, album.filter, pal, memo, L ? L.pw : TW, L ? L.ph : TH)); delays.push(delay); }); } catch (e) {}
      if (frames.length > 1) anims.set(id, { frames, delays });
      await new Promise((r) => setTimeout(r)); // let the screen breathe between GIFs
      if (run !== albumRun) return;
    }
    const inkS = album.bg === "theme" ? getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#222" : "#2b2a28";
    // A window: the framed picture is drawn on its canvas, the same way as in the saved image.
    // fresh: after a tap the size changed, so a GIF's frames are made again for the new shape.
    const paintWindow = (s, fresh) => {
      const btn = page.querySelector(`[data-day="${s.key}"]`), slot = btn && btn.querySelector(".ph");
      if (!slot) return;
      const L = layOf(s, y, mo), im = s.id && imgs.get(s.id);
      lays.set(s.key, L);
      btn.style.cssText = boxStyle(L);
      let a = s.id && anims.get(s.id);
      if (a && fresh && gifs.has(s.id)) {
        const frames = [], delays = [], memo = {};
        try { gifFrames(gifs.get(s.id), perGif, (cv, delay) => { if (s.focus) cv._cmFocus = s.focus; frames.push(stampCanvas(cv, album.filter, pal, memo, L.pw, L.ph)); delays.push(delay); }); } catch (e) {}
        if (frames.length > 1) { a = { frames, delays }; anims.set(s.id, a); }
      }
      const framed = (photo) => { const c = canvasOf(L.w + 24, L.h + 24); drawStamp(c.getContext("2d"), 12, 12, L.w, L.h, photo, s.d, inkS, s.dow, 0, L.kind); return c; };
      if (a) { const fa = { frames: a.frames.map(framed), delays: a.delays }, cv = canvasOf(L.w + 24, L.h + 24); cv.getContext("2d").drawImage(fa.frames[0], 0, 0); slot.replaceChildren(cv); playStamp(cv, fa, run); }
      else slot.replaceChildren(framed(im ? stampCanvas(im, album.filter, pal, null, L.pw, L.ph) : null));
      if (s.id && !im) btn.classList.add("missing");
    };
    for (const s of list) {
      const im = s.id && imgs.get(s.id), slot = page.querySelector(`[data-day="${s.key}"] .ph`);
      if (!slot) continue;
      const a = s.id && anims.get(s.id);
      if (win) { paintWindow(s, false); continue; }
      if (a) { const cv = canvasOf(TW, TH); cv.getContext("2d").drawImage(a.frames[0], 0, 0); slot.replaceChildren(cv); playStamp(cv, a, run); }
      else if (im) slot.replaceChildren(stampCanvas(im, album.filter, pal));
      else if (s.id) slot.parentElement.classList.add("missing");
    }
    albumStamps = { y, mo, list, imgs, pal, anims, days: covers.size, paintWindow };
    $("al-save-gif").hidden = !anims.size;
  }
  // A stamp from a GIF keeps moving while the album is open.
  function playStamp(cv, a, run) {
    let i = 0;
    const tick = () => {
      if (run !== albumRun || $("album").hidden || !cv.isConnected) return;
      i = (i + 1) % a.frames.length;
      const g = cv.getContext("2d");
      g.clearRect(0, 0, cv.width, cv.height); g.drawImage(a.frames[i], 0, 0);
      setTimeout(tick, a.delays[i]);
    };
    setTimeout(tick, a.delays[0]);
  }
  let albumStamps = null;
  function openAlbum() {
    if (diaryLocked() && !vault) { unlockVault().then((ok) => { renderAll(); if (ok) openAlbum(); }); return; }
    albumMonth = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
    loadAlbumFonts();
    $("album").hidden = false;
    renderAlbum();
  }
  function closeAlbum() { $("album").hidden = true; albumRun++; }
  function saveAlbumOpts() { lsSet(ALBUM_KEY, album); renderAlbum(); }

  // "이미지로 저장": the page drawn on a canvas (same look as the screen) as one PNG.
  const ALBUM_FEW = 5; // up to this many stamps: one centered row (screen and saved image)
  // Tickets: one long strip; the month's last ticket is torn off and lies a little crooked.
  const tornAt = () => false; // (tickets now lie loosely, each a little crooked)
  const TORN = { dx: 22, deg: 6 };
  // Postmark size for a short row, so it doesn't tower over one or two stamps: about the row's
  // width, never under 60%. Measured on the saved image (stamps 200 wide, 34 apart; postmark 621).
  const pmScaleFor = (n) => n > 0 && n <= ALBUM_FEW ? Math.max(0.6, Math.min(1, (n * 200 + (n - 1) * 34) / (621 * 1.1))) : 1;
  // Left edge and width of what was drawn on a canvas (alpha > 0).
  function inkBounds(g, w, h) {
    const d = g.getImageData(0, 0, w, h).data;
    let x0 = w, x1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    return x1 < 0 ? { x: 0, w: 0 } : { x: x0, w: x1 - x0 + 1 };
  }
  async function albumPNG() {
    const r = await albumCanvas();
    return r && new Promise((ok) => r.c.toBlob(ok, "image/png"));
  }
  // The page on a canvas, plus where each stamp went (for the animated version).
  async function albumCanvas() {
    const st = albumStamps;
    if (!st) return null;
    await dayFontsReady();
    const n = st.list.length, few = n > 0 && n <= ALBUM_FEW; // a handful of photos: one centered row, page sized to fit
    const pm = pmScaleFor(n);
    const ticket = album.shape === "ticket";
    const sw = 200, sh = ticket ? 280 : 240, gap = ticket ? 0 : 34, gapY = ticket ? 40 : 34, mx = 70, top = album.font === "postmark" ? Math.round(305 * pm) + 20 : 190, bottom = 90;
    const cols = few ? n : 5;
    const rows = Math.max(1, Math.ceil(n / cols));
    const css = getComputedStyle(document.documentElement);
    const ink = album.bg === "theme" ? css.getPropertyValue("--text").trim() || "#222" : "#2b2a28";
    // Header drawn apart first, so a small page can be sized around it and center it.
    const hc = canvasOf(1600, top), hg = hc.getContext("2d", { willReadFrequently: true });
    await drawAlbumHeader(hg, 0, st.y, st.mo, ink, css.getPropertyValue("--font"), st.days, pm);
    const hb = inkBounds(hg, 1600, top);
    if (looseShape()) return windowPage({ st, n, few, top, bottom, mx, css, ink, hc, hb });
    const gridW = cols * sw + (cols - 1) * gap;
    const contentW = (few ? Math.max(gridW, hb.w, 560) : 5 * sw + 4 * gap) + (ticket && n > 1 ? TORN.dx + 16 : 0);
    const W = mx * 2 + contentW, H = top + rows * (sh + gapY + (album.shape === "polaroid" ? 28 : 0)) - gapY + bottom;
    const c = canvasOf(W, H), g = c.getContext("2d", { willReadFrequently: true });
    const bg = album.bg === "theme" ? css.getPropertyValue("--bg").trim() || "#f6f5f2" : "#ffffff";
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    g.drawImage(hc, few ? Math.round((W - hb.w) / 2) - hb.x : mx, 0);
    const gx = few ? Math.round((W - gridW - (ticket && n > 1 ? TORN.dx : 0)) / 2) : mx, slots = [];
    st.list.forEach((s, i) => {
      const torn = tornAt(i, n);
      const cx = gx + (i % cols) * (sw + gap) + (torn ? TORN.dx : 0), cy = top + Math.floor(i / cols) * (sh + gapY + (album.shape === "polaroid" ? 28 : 0));
      const im = s.id && st.imgs.get(s.id), a = s.id && st.anims && st.anims.get(s.id);
      const tilt = torn ? TORN.deg : 0;
      drawStamp(g, cx, cy, sw, sh, a ? a.frames[0] : im ? stampCanvas(im, album.filter, st.pal) : null, s.d, ink, s.dow, tilt);
      if (a) slots.push({ s, a, cx, cy, tilt });
    });
    g.fillStyle = ink; g.globalAlpha = 0.45; g.font = "400 20px " + css.getPropertyValue("--font");
    g.textAlign = few ? "center" : "left";
    g.fillText("클라우드 메모", few ? W / 2 : mx, H - 40); g.globalAlpha = 1; g.textAlign = "left";
    return { c, g, W, H, bg, ink, sw, sh, slots };
  }
  // 창문 / 티켓 page: pieces of different sizes flow in rows (each row centered); windows get stars in between.
  function windowPage(o) {
    const { st, n, few, top, bottom, mx, css, ink, hc, hb } = o;
    setRoll(st.list, st.y, st.mo);
    countTickets();
    const roll = !!rollInfo, GX = roll ? 0 : 34, GY = roll ? 40 : 30, maxW = roll ? 7 * 200 : 5 * 200 + 4 * 34;
    const rows = [];
    let row = null;
    for (const s of st.list) {
      const L = layOf(s, st.y, st.mo);
      if (!row || row.w + GX + L.w > maxW || (roll && row.week !== L.week)) { row = { items: [], w: -GX, h: 0, week: L.week }; rows.push(row); }
      row.items.push({ s, L }); row.w += GX + L.w; row.h = Math.max(row.h, L.h + Math.abs(L.dy) * 2);
    }
    const contentW = few || rows.length <= 1 ? Math.max(rows[0] ? rows[0].w : 0, hb.w, 560) : roll ? Math.max(...rows.map((r) => r.w)) : maxW;
    const gridH = rows.reduce((a, r) => a + r.h, 0) + GY * Math.max(0, rows.length - 1);
    const W = mx * 2 + contentW, H = top + Math.max(gridH, 0) + bottom;
    const c = canvasOf(W, H), g = c.getContext("2d", { willReadFrequently: true });
    const bg = album.bg === "theme" ? css.getPropertyValue("--bg").trim() || "#f6f5f2" : "#ffffff";
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.drawImage(hc, few ? Math.round((W - hb.w) / 2) - hb.x : mx, 0);
    const sparks = album.shape === "window" ? sparkles(mx - 20, top - 16, contentW + 40, gridH + 32, st.y * 13 + st.mo * 7) : null;
    if (sparks) drawSparkles(g, sparks);
    const slots = [];
    let yy = top;
    for (const r of rows) {
      let xx = roll && !few && rows.length > 1 ? mx : mx + (contentW - r.w) / 2; // week rolls start at the left
      for (const { s, L } of r.items) {
        const cx = Math.round(xx), cy = Math.round(yy + (r.h - L.h) / 2 + L.dy);
        const im = s.id && st.imgs.get(s.id), a = s.id && st.anims && st.anims.get(s.id);
        drawStamp(g, cx, cy, L.w, L.h, a ? a.frames[0] : im ? stampCanvas(im, album.filter, st.pal, null, L.pw, L.ph) : null, s.d, ink, s.dow, L.tilt, L.kind);
        if (a) slots.push({ s, a, cx, cy, tilt: L.tilt, lay: L });
        xx += L.w + GX;
      }
      yy += r.h + GY;
    }
    g.fillStyle = ink; g.globalAlpha = 0.45; g.font = "400 20px " + css.getPropertyValue("--font");
    g.textAlign = few ? "center" : "left";
    g.fillText("클라우드 메모", few ? W / 2 : mx, H - 40); g.globalAlpha = 1; g.textAlign = "left";
    return { c, g, W, H, bg, ink, sw: 200, sh: 240, slots, sparks };
  }
  // "움짤로 저장": the same page as an animated GIF. Stamps from GIFs move on one shared clock
  // (at most 4 s, then it loops); everything else is drawn once.
  async function albumGIF() {
    const r = await albumCanvas();
    if (!r) return null;
    const { c, g, W, H, bg, ink, sw, sh, slots, sparks } = r;
    if (!slots.length) return new Promise((ok) => c.toBlob(ok, "image/png"));
    const dur = (a) => a.delays.reduce((x, y) => x + y, 0);
    let step = Math.max(40, Math.min(100, ...slots.flatMap((x) => x.a.delays)));
    const total = Math.min(4000, Math.max(...slots.map((x) => dur(x.a))));
    if (total / step > 60) step = Math.ceil(total / 60);
    const nF = Math.max(2, Math.round(total / step));
    const frameAt = (a, t) => { t %= dur(a); for (let i = 0; i < a.delays.length; i++) { if (t < a.delays[i]) return i; t -= a.delays[i]; } return 0; };
    const boxH = album.shape === "circle" ? sw : album.shape === "polaroid" ? sh + 28 : sh;
    const margin = (x) => (x.lay && x.lay.kind && typeof x.lay.kind === "object" ? 0 : x.tilt ? 26 : 16);
    const sizeOf = (x) => (x.lay ? [x.lay.w, x.lay.h, x.lay.h] : [sw, sh, boxH]);
    const redraw = (x, k) => { // clear the stamp's spot (and its shadow), draw frame k
      const M = margin(x), [ww, hh, bh] = sizeOf(x);
      g.fillStyle = bg; g.fillRect(x.cx - M, x.cy - M, ww + 2 * M, bh + 2 * M);
      if (sparks) { g.save(); g.beginPath(); g.rect(x.cx - M, x.cy - M, ww + 2 * M, bh + 2 * M); g.clip(); drawSparkles(g, sparks); g.restore(); }
      drawStamp(g, x.cx, x.cy, ww, hh, x.a.frames[k], x.s.d, ink, x.s.dow, x.tilt, x.lay && x.lay.kind);
    };
    // One palette for the whole animation: the page plus every frame of the moving stamps.
    const sample = [];
    const addPixels = (d, every) => { for (let i = 0; i < d.length; i += 4 * every) sample.push([d[i], d[i + 1], d[i + 2]]); };
    addPixels(g.getImageData(0, 0, W, H).data, Math.max(1, Math.floor((W * H) / 60000)));
    for (const x of slots) for (const f of x.a.frames) addPixels(f.getContext("2d").getImageData(0, 0, f.width, f.height).data, 23);
    // Colors that cover much of the page (background, paper, ink) go in as they are; the rest by median cut.
    const freq = new Map();
    for (const p of sample) { const k = (p[0] << 16) | (p[1] << 8) | p[2]; freq.set(k, (freq.get(k) || 0) + 1); }
    const fixed = [...freq].filter(([, n]) => n > sample.length * 0.003).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k]) => k);
    const fixedSet = new Set(fixed), rest = sample.filter((p) => !fixedSet.has((p[0] << 16) | (p[1] << 8) | p[2]));
    const pal = [...fixed.map((k) => [k >> 16, (k >> 8) & 255, k & 255]), ...medianCut(rest, 255 - fixed.length)].slice(0, 255);
    const toIdx = paletteMapper(pal, album.filter === "orig" || album.filter === "glass" ? 18 : 0, new Map(fixed.map((k, i) => [k, i]))); // photos: dither
    const frames = [], prev = new Uint8Array(W * H);
    const first = toIdx(g.getImageData(0, 0, W, H).data, W);
    prev.set(first);
    frames.push({ x: 0, y: 0, w: W, h: H, idx: first, delay: step });
    const shown = slots.map(() => 0);
    for (let f = 1; f < nF; f++) {
      const t = f * step;
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      slots.forEach((x, i) => {
        const k = frameAt(x.a, t);
        if (k === shown[i]) return;
        shown[i] = k; redraw(x, k);
        const M = margin(x), [ww, , bh] = sizeOf(x);
        x0 = Math.min(x0, x.cx - M); y0 = Math.min(y0, x.cy - M); x1 = Math.max(x1, x.cx + ww + M); y1 = Math.max(y1, x.cy + bh + M);
      });
      if (x1 <= x0) { frames[frames.length - 1].delay += step; continue; } // nothing moved
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
      const w = x1 - x0, h = y1 - y0, idx = toIdx(g.getImageData(x0, y0, w, h).data, w, x0, y0);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { // unchanged pixels: transparent (smaller file)
        const j = yy * w + xx, o = (y0 + yy) * W + x0 + xx;
        if (idx[j] === prev[o]) idx[j] = 255; else prev[o] = idx[j];
      }
      frames.push({ x: x0, y: y0, w, h, idx, delay: step });
      if (f % 4 === 0) await new Promise((res) => setTimeout(res));
    }
    // back to the first picture at the loop's end: the stamps' first frames are already on frame 0
    return new Blob([gifEncode(W, H, pal, frames)], { type: "image/gif" });
  }
  // One stamp on the export canvas. The frame's outer box is w×h (circle: w×w; polaroid: + a
  // 28px caption strip); the photo fills the inner box, cropped to fit.
  function drawStamp(g, x, y, w, h, photo, day, ink, dow, tilt = 0, kind = null) {
    if (album.shape === "ticket") { const R = kind && typeof kind === "object" ? kind : null; stampOut(g, ticketLayer(w, h, photo, day, dow, R), x, y, w, h, tilt, !R); return; }
    const wk = kind == null ? day % 4 : kind; // window frame
    const dayInk = dow === 0 ? "#e03131" : dow === 6 ? "#1971c2" : "#2b2a28"; // Sunday red, Saturday blue
    const shape = album.shape, font = getComputedStyle(document.documentElement).getPropertyValue("--font");
    const boxH = shape === "circle" ? w : shape === "polaroid" ? h + 28 : h;
    const layer = canvasOf(w + 2, boxH + 2), lg = layer.getContext("2d");
    const P = shape === "stamp" ? 16 : shape === "polaroid" ? 10 : 0;
    const inner = { x: 1 + P, y: 1 + P, w: w - P * 2, h: (shape === "circle" ? w : h) - P * 2 };
    lg.save();
    if (shape === "window") { windowPath(lg, 1, 1, w, h, wk); lg.clip(); }
    if (shape === "circle") { lg.beginPath(); lg.arc(w / 2 + 1, w / 2 + 1, w / 2, 0, 7); lg.clip(); }
    else if (shape === "round") { roundRect(lg, 1, 1, w, h, 22); lg.clip(); }
    if (P) { lg.fillStyle = "#ffffff"; lg.fillRect(1, 1, w, boxH); }
    if (photo) { // crop the thumbnail to the inner box's shape
      const s = Math.max(inner.w / photo.width, inner.h / photo.height), sw = inner.w / s, sh = inner.h / s;
      lg.drawImage(photo, (photo.width - sw) / 2, (photo.height - sh) / 2, sw, sh, inner.x, inner.y, inner.w, inner.h);
    } else if (shape === "window") { // an empty window: pale glass
      lg.fillStyle = "#f7f2e6"; lg.fillRect(inner.x, inner.y, inner.w, inner.h);
    } else {
      lg.fillStyle = "rgba(0,0,0,.05)"; lg.fillRect(inner.x, inner.y, inner.w, inner.h);
      lg.setLineDash([6, 6]); lg.strokeStyle = "rgba(0,0,0,.25)"; lg.lineWidth = 2;
      lg.strokeRect(inner.x + 5, inner.y + 5, inner.w - 10, inner.h - 10);
    }
    lg.restore();
    if (shape === "window") { // gold frame, with a thin dark line inside it like lead
      const k = wk;
      windowPath(lg, 1, 1, w, h, k);
      const gold = lg.createLinearGradient(0, 0, w, h);
      gold.addColorStop(0, "#f0dc9c"); gold.addColorStop(0.5, "#b8913e"); gold.addColorStop(1, "#ead08a");
      lg.strokeStyle = gold; lg.lineWidth = 12; lg.stroke();
      windowPath(lg, 7, 7, w - 12, h - 12, k);
      lg.strokeStyle = "rgba(70,50,15,.45)"; lg.lineWidth = 1.5; lg.stroke();
    }
    if (shape === "stamp") { // perforated edge
      lg.globalCompositeOperation = "destination-out";
      for (let t = 0; t <= w; t += 20) { hole(lg, 1 + t, 1); hole(lg, 1 + t, 1 + h); } // 20px apart: 200×240 ends on a hole
      for (let t = 0; t <= h; t += 20) { hole(lg, 1, 1 + t); hole(lg, 1 + w, 1 + t); }
      lg.globalCompositeOperation = "source-over";
    }
    // The day number, dressed for the shape (same look as on the screen):
    // stamp: a serif value · ticket: "No.7" typed on a paper tab · window: a Roman numeral on a gold plaque
    // polaroid: handwritten · round: a thin pill · circle: a small round badge.
    const label = String(day), F = HEAD_FONTS, weekend = dow === 0 || dow === 6;
    lg.textAlign = "center";
    if (shape === "polaroid") {
      lg.save(); lg.font = `600 34px ${F.script}`; lg.textAlign = "right"; lg.fillStyle = weekend ? dayInk : "#55524c";
      lg.translate(w - 10, h + 23); lg.rotate(-0.07); lg.fillText(label, 0, 0); lg.restore();
    } else if (shape === "window") {
      const txt = romanNum(day);
      lg.font = `500 21px ${F.display}`;
      const tw = Math.max(34, lg.measureText(txt).width + 22), th = 28, cx = w / 2 + 1, by = h - 12;
      const gold = lg.createLinearGradient(cx - tw / 2, 0, cx + tw / 2, 0);
      gold.addColorStop(0, "#e9cf86"); gold.addColorStop(0.5, "#c49a45"); gold.addColorStop(1, "#ead38e");
      roundRect(lg, cx - tw / 2, by - th, tw, th, 6); lg.fillStyle = gold; lg.fill();
      lg.strokeStyle = "rgba(70,50,15,.5)"; lg.lineWidth = 1.2; lg.stroke();
      lg.fillStyle = dow === 0 ? "#8f2222" : dow === 6 ? "#1f3f7a" : "#4a3510";
      lg.fillText(txt, cx, by - 8);
    } else { // stamp, round, circle: on a photo the number sits on a small tab so its color reads
      lg.font = shape === "stamp" ? `500 23px ${F.display}` : shape === "round" ? `400 22px ${F.year}` : "700 22px " + font;
      const tw = Math.max(shape === "stamp" ? 0 : 28, lg.measureText(label).width + 14), th = 28, r = shape === "stamp" ? 6 : 14;
      const right = shape === "circle" ? w / 2 + 1 + tw / 2 : inner.x + inner.w - 6;
      const bottom = shape === "circle" ? w - 10 : inner.y + inner.h - 6;
      if (photo) { lg.fillStyle = "rgba(255,255,255,.92)"; roundRect(lg, right - tw, bottom - th, tw, th, r); lg.fill(); }
      lg.fillStyle = photo || weekend ? dayInk : ink;
      lg.fillText(label, right - tw / 2, bottom - (shape === "round" ? 6 : 7));
    }
    stampOut(g, layer, x, y, w, boxH, tilt);
  }
  // Puts a drawn piece on the page: turned by `tilt` degrees, with a faint outline and a soft shadow.
  function stampOut(g, layer, x, y, w, boxH, tilt, shadow = true) {
    g.save();
    if (tilt) { g.translate(x + w / 2, y + boxH / 2); g.rotate((tilt * Math.PI) / 180); g.translate(-(x + w / 2), -(y + boxH / 2)); }
    if (shadow) { g.shadowColor = "rgba(0,0,0,.07)"; g.shadowBlur = 8; g.shadowOffsetY = 2; g.drawImage(layer, x - 1, y - 1); g.shadowColor = "rgba(0,0,0,.16)"; g.shadowBlur = 1.4; g.shadowOffsetY = 0; }
    g.drawImage(layer, x - 1, y - 1);
    g.restore();
  }
  // An old paper ticket: colored card with notched corners, a double border, ADMIT ONE, the photo in
  // a window, then a dashed tear line and the stub with the day, month and a serial number.
  const TICKET_PAPERS = ["#cfc8a6", "#d65b4b", "#e3b458", "#ea9150", "#47ab8b", "#d88fbb", "#8fb4da", "#efe1c0", "#b45468", "#9ec6b0", "#f0c98a", "#7d9bc9"];
  // Ticket serial numbers: every day that has a cover photo, counted from the very first photo
  // diary (No.0001) on, across months and years. Days without a photo get no number.
  let ticketSerials = new Map();
  function countTickets() {
    const days = new Set();
    for (const m of memos) { if (!isDiary(m)) continue; const b = bodyOf(m); if (b != null && coverOf(b)) days.add(m.diary); }
    ticketSerials = new Map([...days].sort().map((d, i) => [d, i + 1]));
  }
  // roll (optional): { paper, left, right } when the ticket is part of a week's roll.
  function ticketLayer(w, h, photo, day, dow, roll) {
    const mo = albumMonth ? albumMonth.getMonth() : 0, yr = albumMonth ? albumMonth.getFullYear() : 2026;
    const paper = roll ? roll.paper : TICKET_PAPERS[Math.floor(hash01(day * 7.77 + mo * 31 + yr) * TICKET_PAPERS.length)];
    const endL = !roll || roll.left, endR = !roll || roll.right; // notched corners only at a roll's ends
    const [pr, pg, pb] = hexRGB(paper), lum = pr * 0.3 + pg * 0.59 + pb * 0.11, darkPaper = lum < 150;
    const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
    const inkRGB = darkPaper ? [251, 243, 223] : mix([pr, pg, pb], [40, 28, 20], 0.72), ink = `rgb(${inkRGB.join(",")})`;
    const layer = canvasOf(w + 2, h + 2), lg = layer.getContext("2d"), F = HEAD_FONTS;
    lg.translate(1, 1);
    const pf = h - 76, R = 14, N = 10; // tear line, corner notch, side notch
    const J = 7; // half notch at the top and bottom of a join inside a roll (and the tear-line notch, as at the ends)
    const outline = () => {
      lg.beginPath();
      lg.moveTo(endL ? R : J, 0);
      if (endR) { lg.lineTo(w - R, 0); lg.arc(w, 0, R, Math.PI, Math.PI / 2, true); lg.lineTo(w, pf - N); lg.arc(w, pf, N, -Math.PI / 2, Math.PI / 2, true); lg.lineTo(w, h - R); lg.arc(w, h, R, -Math.PI / 2, Math.PI, true); }
      else { lg.lineTo(w - J, 0); lg.arc(w, 0, J, Math.PI, Math.PI / 2, true); lg.lineTo(w, pf - N); lg.arc(w, pf, N, -Math.PI / 2, Math.PI / 2, true); lg.lineTo(w, h - J); lg.arc(w, h, J, -Math.PI / 2, Math.PI, true); }
      if (endL) { lg.lineTo(R, h); lg.arc(0, h, R, 0, -Math.PI / 2, true); lg.lineTo(0, pf + N); lg.arc(0, pf, N, Math.PI / 2, -Math.PI / 2, true); lg.lineTo(0, R); lg.arc(0, 0, R, Math.PI / 2, 0, true); }
      else { lg.lineTo(J, h); lg.arc(0, h, J, 0, -Math.PI / 2, true); lg.lineTo(0, pf + N); lg.arc(0, pf, N, Math.PI / 2, -Math.PI / 2, true); lg.lineTo(0, J); lg.arc(0, 0, J, Math.PI / 2, 0, true); }
      lg.closePath();
    };
    outline(); lg.fillStyle = paper; lg.fill();
    lg.save(); outline(); lg.clip();
    for (let i = 0; i < 700; i++) { // paper grain and a little wear
      const r = hash01(day * 13.1 + i * 1.7);
      lg.fillStyle = r < 0.5 ? "rgba(60,40,20,.06)" : "rgba(255,250,235,.10)";
      lg.fillRect(hash01(i * 3.3 + day) * w, hash01(i * 5.1 + day * 2) * h, 1 + r * 2, 1 + r * 2);
    }
    lg.restore();
    lg.strokeStyle = ink; lg.globalAlpha = 0.55; lg.lineWidth = 1.4; // double border
    roundRect(lg, 9, 9, w - 18, pf - 15, 3); lg.stroke();
    lg.globalAlpha = 0.3; lg.lineWidth = 1;
    roundRect(lg, 13, 13, w - 26, pf - 23, 2); lg.stroke();
    lg.globalAlpha = 1;
    // ADMIT ONE
    lg.fillStyle = ink; lg.textAlign = "center"; lg.font = `400 15px ${F.type}`;
    const head = "ADMIT ONE";
    let hx = w / 2 - ([...head].reduce((a, ch) => a + lg.measureText(ch).width + 2.2, 0) - 2.2) / 2;
    lg.textAlign = "left";
    for (const ch of head) { lg.fillText(ch, hx, 37); hx += lg.measureText(ch).width + 2.2; }
    lg.font = `400 11px ${F.type}`; lg.fillText("★", 24, 36); lg.textAlign = "right"; lg.fillText("★", w - 24, 36);
    // photo window
    const px = (w - TKT.pw) / 2, py = 48;
    if (photo) {
      const s = Math.max(TKT.pw / photo.width, TKT.ph / photo.height), sw = TKT.pw / s, sh = TKT.ph / s;
      lg.drawImage(photo, (photo.width - sw) / 2, (photo.height - sh) / 2, sw, sh, px, py, TKT.pw, TKT.ph);
    } else {
      lg.fillStyle = `rgba(${mix([pr, pg, pb], [255, 255, 255], 0.45).join(",")},1)`; lg.fillRect(px, py, TKT.pw, TKT.ph);
    }
    lg.strokeStyle = ink; lg.globalAlpha = 0.7; lg.lineWidth = 1.5; lg.strokeRect(px, py, TKT.pw, TKT.ph); lg.globalAlpha = 1;
    // tear lines: across above the stub, and down the right edge between two tickets of a roll
    lg.save(); lg.setLineDash([6, 5]); lg.strokeStyle = ink; lg.globalAlpha = 0.6; lg.lineWidth = 1.5;
    lg.beginPath(); lg.moveTo(endL ? N + 6 : 4, pf); lg.lineTo(endR ? w - N - 6 : w - 4, pf); lg.stroke();
    if (!endR) { lg.globalAlpha = 0.45; lg.beginPath(); lg.moveTo(w - 0.75, J + 3); lg.lineTo(w - 0.75, pf - N - 3); lg.moveTo(w - 0.75, pf + N + 3); lg.lineTo(w - 0.75, h - J - 3); lg.stroke(); }
    lg.restore();
    // stub: the day big, month and year beside it, a serial number
    const weekendInk = !darkPaper && (dow === 0 ? "#a3261e" : dow === 6 ? "#1d4f8f" : null);
    lg.textAlign = "left"; lg.fillStyle = weekendInk || ink; lg.font = `500 44px ${F.display}`;
    lg.fillText(String(day), 20, pf + 55);
    const dw = lg.measureText(String(day)).width;
    lg.fillStyle = ink; lg.font = `400 15px ${F.type}`;
    lg.fillText(MONTH_EN[mo].slice(0, 3).toUpperCase(), 28 + dw, pf + 32);
    lg.font = `400 12px ${F.type}`; lg.globalAlpha = 0.75; lg.fillText(String(yr), 28 + dw, pf + 50); lg.globalAlpha = 1;
    const serial = photo && ticketSerials.get(`${yr}-${pad(mo + 1)}-${pad(day)}`);
    if (serial) { lg.textAlign = "right"; lg.font = `400 14px ${F.type}`; lg.fillText("No." + String(serial).padStart(4, "0"), w - 18, pf + 47); }
    return layer;
  }
  // Window frames, one per day in turn: arch, oval, cut corners, rounded.
  function windowPath(g, x, y, w, h, kind) {
    g.beginPath();
    if (kind === 0 || kind === 4) { // arch, or a low dome on wide windows
      const ry = kind === 0 ? Math.min(w / 2, h * 0.55) : h * 0.32;
      g.moveTo(x, y + h); g.lineTo(x, y + ry); g.ellipse(x + w / 2, y + ry, w / 2, ry, 0, Math.PI, 0); g.lineTo(x + w, y + h); g.closePath();
    } else if (kind === 1) g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (kind === 2) { const c = Math.min(w, h) * 0.17; g.moveTo(x + c, y); g.lineTo(x + w - c, y); g.lineTo(x + w, y + c); g.lineTo(x + w, y + h - c); g.lineTo(x + w - c, y + h); g.lineTo(x + c, y + h); g.lineTo(x, y + h - c); g.lineTo(x, y + c); g.closePath(); }
    else { roundRect(g, x, y, w, h, Math.min(w, h) * 0.1); }
  }
  const romanNum = (n) => [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]].reduce((o, [v, r]) => { while (n >= v) { o += r; n -= v; } return o; }, "");
  // The day-number fonts, ready before anything is drawn on a canvas.
  const DAY_FONTS = ['500 23px "Playfair Display"', '400 21px "Special Elite"', '600 34px "Caveat"', '400 22px "Josefin Sans"'];
  const dayFontsReady = () => Promise.all(DAY_FONTS.map((f) => document.fonts.load(f, "0123456789No.IVX"))).catch(() => {});
  function hole(g, x, y) { g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  async function saveAlbum(gif) {
    const btn = $(gif ? "al-save-gif" : "al-save"), label = btn.textContent;
    btn.disabled = true; btn.textContent = "만드는 중…";
    try {
      const blob = gif ? await albumGIF() : await albumPNG();
      if (!blob) return;
      const ext = blob.type === "image/gif" ? "gif" : "png";
      const name = `이달의 사진 ${albumStamps.y}-${pad(albumStamps.mo + 1)}.${ext}`;
      const file = new File([blob], name, { type: blob.type });
      if (/iPhone|iPad|Android/i.test(navigator.userAgent) && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name }).catch(() => {});
      } else {
        const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        flashMeta("이미지를 저장했어 (다운로드 폴더)");
      }
    } catch (e) { alert("이미지를 만들지 못했어: " + ((e && e.message) || e)); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  // ---------- GIF: read (for animated photos) and write (for the animated album) ----------
  const isGif = (buf) => { const b = new Uint8Array(buf, 0, Math.min(6, buf.byteLength)); return b.length === 6 && b[0] === 71 && b[1] === 73 && b[2] === 70 && b[3] === 56; };
  // Blocks of a GIF file: size, global colors, and each frame's still-compressed data.
  function parseGif(buf) {
    const b = new Uint8Array(buf);
    if (!isGif(buf) || b.length < 13) return null;
    const W = b[6] | (b[7] << 8), H = b[8] | (b[9] << 8), f = b[10];
    let p = 13, gct = null;
    if (f & 0x80) { const n = 2 << (f & 7); gct = b.subarray(p, p + n * 3); p += n * 3; }
    const frames = [];
    let gce = { disp: 0, delay: 0, tr: -1 };
    const skipBlocks = () => { while (p < b.length && b[p]) p += b[p] + 1; p++; };
    while (p < b.length) {
      const t = b[p++];
      if (t === 0x3B) break;
      if (t === 0x21) {
        const label = b[p++];
        if (label === 0xF9 && b[p] >= 4) { const pf = b[p + 1]; gce = { disp: (pf >> 2) & 7, delay: b[p + 2] | (b[p + 3] << 8), tr: pf & 1 ? b[p + 4] : -1 }; }
        skipBlocks();
      } else if (t === 0x2C) {
        const x = b[p] | (b[p + 1] << 8), y = b[p + 2] | (b[p + 3] << 8), w = b[p + 4] | (b[p + 5] << 8), h = b[p + 6] | (b[p + 7] << 8), ff = b[p + 8];
        p += 9;
        let lct = null;
        if (ff & 0x80) { const n = 2 << (ff & 7); lct = b.subarray(p, p + n * 3); p += n * 3; }
        const minSize = b[p++];
        let len = 0;
        for (let q = p; q < b.length && b[q]; q += b[q] + 1) len += b[q];
        const data = new Uint8Array(len);
        for (let o = 0; p < b.length && b[p]; p += b[p] + 1) { data.set(b.subarray(p + 1, p + 1 + b[p]), o); o += b[p]; }
        p++;
        frames.push({ x, y, w, h, interlace: !!(ff & 0x40), pal: lct || gct, minSize, data, ...gce });
        gce = { disp: 0, delay: 0, tr: -1 };
      } else break;
    }
    return { W, H, frames };
  }
  function lzwDecode(minSize, data, npix) {
    const out = new Uint8Array(npix), clear = 1 << minSize, eoi = clear + 1;
    const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
    for (let i = 0; i < clear; i++) suffix[i] = i;
    let size = minSize + 1, mask = (1 << size) - 1, next = eoi + 1, acc = 0, bits = 0, p = 0, op = 0, old = -1, first = 0;
    while (op < npix) {
      while (bits < size) { if (p >= data.length) return out; acc |= data[p++] << bits; bits += 8; }
      const code = acc & mask;
      acc >>>= size; bits -= size;
      if (code === clear) { size = minSize + 1; mask = (1 << size) - 1; next = eoi + 1; old = -1; continue; }
      if (code === eoi) break;
      if (old === -1) { if (code > clear) break; out[op++] = suffix[code]; old = first = code; continue; }
      let top = 0, c = code;
      if (code >= next) { stack[top++] = first; c = old; }
      while (c > eoi) { stack[top++] = suffix[c]; c = prefix[c]; }
      first = suffix[c]; stack[top++] = first;
      while (top && op < npix) out[op++] = stack[--top];
      if (next < 4096) { prefix[next] = old; suffix[next] = first; next++; if ((next & mask) === 0 && next < 4096) { size++; mask = (1 << size) - 1; } }
      old = code;
    }
    return out;
  }
  // Calls onFrame(canvas W×H on white, delay ms) for up to `max` evenly picked frames (delays of
  // skipped frames are added to the shown ones). Frames are drawn over each other as a browser does.
  function gifFrames(buf, max, onFrame) {
    const gif = parseGif(buf);
    if (!gif || gif.frames.length < 2 || gif.W * gif.H > 4e6 || !gif.W || !gif.H) return 0;
    const { W, H, frames } = gif, n = frames.length, step = Math.ceil(n / max);
    const cur = new Uint8ClampedArray(W * H * 4), tmp = canvasOf(W, H), out = canvasOf(W, H);
    const tg = tmp.getContext("2d"), og = out.getContext("2d");
    let acc = 0, shown = 0;
    for (let i = 0; i < n; i++) {
      const f = frames[i], saved = f.disp === 3 ? cur.slice() : null;
      const px = lzwDecode(f.minSize, f.data, f.w * f.h), pal = f.pal;
      if (pal) {
        const rows = f.interlace ? [[0, 8], [4, 8], [2, 4], [1, 2]].flatMap(([s0, d]) => { const r = []; for (let y = s0; y < f.h; y += d) r.push(y); return r; }) : null;
        for (let r = 0; r < f.h; r++) {
          const yy = f.y + (rows ? rows[r] : r);
          if (yy >= H) continue;
          for (let c = 0; c < f.w; c++) {
            const xx = f.x + c, k = px[r * f.w + c];
            if (xx >= W || k === f.tr || k * 3 + 2 >= pal.length) continue;
            const o = (yy * W + xx) * 4;
            cur[o] = pal[k * 3]; cur[o + 1] = pal[k * 3 + 1]; cur[o + 2] = pal[k * 3 + 2]; cur[o + 3] = 255;
          }
        }
      }
      acc += (f.delay < 2 ? 10 : f.delay) * 10; // 0/1 means "as fast as it goes": browsers use 100 ms
      if (i % step === step - 1 || i === n - 1) {
        tg.putImageData(new ImageData(cur, W, H), 0, 0);
        og.fillStyle = "#fff"; og.fillRect(0, 0, W, H); og.drawImage(tmp, 0, 0);
        onFrame(out, acc); acc = 0; shown++;
      }
      if (f.disp === 2) for (let yy = f.y; yy < Math.min(H, f.y + f.h); yy++) cur.fill(0, (yy * W + f.x) * 4, (yy * W + Math.min(W, f.x + f.w)) * 4);
      else if (saved) cur.set(saved);
    }
    return shown;
  }
  // k colors for a list of [r,g,b] by median cut (split the box with the widest spread).
  function medianCut(px, k) {
    const box = (list) => {
      const lo = [255, 255, 255], hi = [0, 0, 0];
      for (const p of list) for (let c = 0; c < 3; c++) { if (p[c] < lo[c]) lo[c] = p[c]; if (p[c] > hi[c]) hi[c] = p[c]; }
      const r = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], ch = r.indexOf(Math.max(...r));
      return { list, ch, score: r[ch] * Math.sqrt(list.length) };
    };
    const boxes = [box(px.length ? px : [[0, 0, 0]])];
    while (boxes.length < k) {
      let bi = -1;
      boxes.forEach((b, i) => { if (b.list.length > 1 && b.score > 0 && (bi < 0 || b.score > boxes[bi].score)) bi = i; });
      if (bi < 0) break;
      const b = boxes[bi], ch = b.ch;
      b.list.sort((u, v) => u[ch] - v[ch]);
      const mid = b.list.length >> 1;
      boxes.splice(bi, 1, box(b.list.slice(0, mid)), box(b.list.slice(mid)));
    }
    return boxes.map((b) => {
      const s = [0, 0, 0];
      for (const p of b.list) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
      return s.map((v) => Math.round(v / b.list.length));
    });
  }
  // RGBA pixels of a w-wide region at (x0, y0) → palette indices (nearest color, cached per 5-bit
  // color). dither > 0 adds a fixed 4×4 pattern (by page position, so still parts stay the same
  // from frame to frame) that hides banding in smooth photos.
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function paletteMapper(pal, dither = 0, exact = new Map()) {
    const cache = new Int16Array(32768).fill(-1);
    return (d, w, x0 = 0, y0 = 0) => {
      const out = new Uint8Array(d.length >> 2);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        let r = d[i], g = d[i + 1], b = d[i + 2];
        const ex = exact.get((r << 16) | (g << 8) | b); // flat page colors stay exact (no dots)
        if (ex !== undefined) { out[j] = ex; continue; }
        if (dither) {
          const x = x0 + (j % w), y = y0 + ((j / w) | 0), o = (BAYER4[(y & 3) * 4 + (x & 3)] / 16 - 0.47) * dither;
          r = Math.max(0, Math.min(255, r + o)); g = Math.max(0, Math.min(255, g + o)); b = Math.max(0, Math.min(255, b + o));
        }
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let k = cache[key];
        if (k < 0) { k = nearestIdx(pal, [(r & 248) + 4, (g & 248) + 4, (b & 248) + 4]); cache[key] = k; }
        out[j] = k;
      }
      return out;
    };
  }
  function lzwEncode(minSize, idx) {
    const out = [], clear = 1 << minSize, eoi = clear + 1, dict = new Map();
    let size = minSize + 1, next = eoi + 1, acc = 0, bits = 0;
    const emit = (code) => { acc |= code << bits; bits += size; while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; } };
    emit(clear);
    let cur = idx[0];
    for (let i = 1; i < idx.length; i++) {
      const k = idx[i], key = (cur << 8) | k, hit = dict.get(key);
      if (hit !== undefined) { cur = hit; continue; }
      emit(cur);
      if (next === 4096) { emit(clear); dict.clear(); next = eoi + 1; size = minSize + 1; }
      else { if (next >= 1 << size) size++; dict.set(key, next++); }
      cur = k;
    }
    emit(cur); emit(eoi);
    if (bits > 0) out.push(acc & 255);
    return out;
  }
  // frames: [{ x, y, w, h, idx (palette indices, 255 = see-through), delay ms }], looping forever.
  function gifEncode(W, H, pal, frames) {
    let buf = new Uint8Array(1 << 20), n = 0;
    const put = (...v) => { if (n + v.length > buf.length) { const nb = new Uint8Array(Math.max(buf.length * 2, n + v.length)); nb.set(buf); buf = nb; } for (const x of v) buf[n++] = x; };
    const str = (t) => put(...[...t].map((ch) => ch.charCodeAt(0)));
    const u16 = (v) => put(v & 255, (v >> 8) & 255);
    str("GIF89a"); u16(W); u16(H); put(0xF7, 0, 0);
    for (let i = 0; i < 256; i++) { const c = pal[i] || [0, 0, 0]; put(c[0], c[1], c[2]); }
    put(0x21, 0xFF, 11); str("NETSCAPE2.0"); put(3, 1, 0, 0, 0);
    for (const f of frames) {
      put(0x21, 0xF9, 4, (1 << 2) | 1); u16(Math.max(2, Math.round(f.delay / 10))); put(255, 0);
      put(0x2C); u16(f.x); u16(f.y); u16(f.w); u16(f.h); put(0, 8);
      const data = lzwEncode(8, f.idx);
      for (let i = 0; i < data.length; i += 255) { const len = Math.min(255, data.length - i); put(len); for (let j = 0; j < len; j++) put(data[i + j]); }
      put(0);
    }
    put(0x3B);
    return buf.subarray(0, n);
  }

  // ---------- 📅 add a line to Google Calendar (Google's own "new event" page, no permission needed) ----------
  // Finds a date and time in the line: an F5 time chip, "2026-11-28", "11월 28일", "11/28",
  // "오늘/내일/모레", "오후 3시 반", "15:00".
  function parseWhen(text, chip) {
    if (chip) { const [d, hm] = chip.split("T"); return { date: d, time: hm || "" }; }
    const now = new Date();
    let date = "", time = "", m;
    const ok = (mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
    if ((m = text.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/)) && ok(+m[2], +m[3])) date = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    else if (((m = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/)) || (m = text.match(/(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/))) && ok(+m[1], +m[2])) {
      let y = now.getFullYear();
      if (+m[1] < now.getMonth() + 1 - 6) y++; // "1월 5일" written in November is next year
      date = `${y}-${pad(+m[1])}-${pad(+m[2])}`;
    } else {
      const rel = /모레/.test(text) ? 2 : /내일/.test(text) ? 1 : /오늘/.test(text) ? 0 : -1;
      if (rel >= 0) { const x = new Date(now); x.setDate(x.getDate() + rel); date = ymd(x); }
    }
    if ((m = text.match(/(오전|오후|저녁|밤|아침)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?/)) ||
        (m = text.match(/(오전|오후)?\s*(\d{1,2}):(\d{2})(?!\d)/))) {
      let h = +m[2];
      const mi = m[4] ? 30 : +(m[3] || 0);
      if (/오후|저녁|밤/.test(m[1] || "") && h < 12) h += 12;
      if (m[1] === "오전" && h === 12) h = 0;
      if (h <= 23 && mi <= 59) time = `${pad(h)}:${pad(mi)}`;
    }
    return { date, time };
  }
  function calendarURL(title, when, details) {
    const p = new URLSearchParams({ action: "TEMPLATE", text: title });
    if (when.date) {
      const [y, mo, d] = when.date.split("-").map(Number);
      const compact = (x) => ymd(x).replace(/-/g, "");
      if (when.time) {
        const [h, mi] = when.time.split(":").map(Number);
        const s = new Date(y, mo - 1, d, h, mi), e = new Date(s.getTime() + 3600000);
        const f = (x) => `${compact(x)}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
        p.set("dates", `${f(s)}/${f(e)}`);
        try { p.set("ctz", Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (x) {}
      } else {
        const s = new Date(y, mo - 1, d), e = new Date(y, mo - 1, d + 1);
        p.set("dates", `${compact(s)}/${compact(e)}`);
      }
    }
    if (details) p.set("details", details);
    return "https://calendar.google.com/calendar/render?" + p;
  }
  function addToCalendar() {
    const m = memos.find((x) => x.id === currentId);
    if (!m) return;
    const s = sel();
    const line = inEditor() ? lineOf(s.anchorNode) : null;
    const picked = inEditor() && !s.isCollapsed ? s.toString().trim() : "";
    const chipEl = line && line.querySelector("time[datetime]");
    let text = picked || (line ? line.textContent : "");
    const when = parseWhen((line ? line.textContent : "") + " " + picked, chipEl && chipEl.getAttribute("datetime"));
    if (chipEl) text = text.replace(chipEl.textContent, " ");
    let titleText = text.replace(ZW, "").replace(BOX_RE, "").replace(/\s+/g, " ").trim() || title(textOf(m));
    if (!when.date && m.diary) when.date = m.diary; // a diary line is about that day
    const url = calendarURL(titleText, when, `클라우드 메모 "${title(textOf(m))}"에서`);
    openExternal(url);
    flashMeta(when.date ? "구글 캘린더에서 저장을 눌러 줘" : "날짜를 고르고 저장을 눌러 줘");
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
    if (wxLoc) putWeather(m.id, date, wxLoc, false);
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
  const WX_ITEM = { t: "wx", n: "날씨", s: "날씨", ic: "☀", kb: "일기", k: "weather 날씨 기온 온도" };
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
    const cur = memos.find((x) => x.id === currentId);
    const pool = cur && cur.diary ? [...BLOCK_LIST, WX_ITEM] : BLOCK_LIST;
    const items = pool.filter((b) => words.every((w) => (b.n + " " + b.k).toLowerCase().includes(w)));
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
    if (b.t === "wx") { afterEdit(); weatherSlash(); return; }
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
  // ---------- diary weather ----------
  // Open-Meteo (free, no key, callable from the page). The place is per device: a city picked in
  // settings, or the current position. The weather is saved in the entry, so old entries keep theirs.
  const WX_KEY = "cloudmemo.weather";
  let wxLoc = lsGet(WX_KEY, null); // { name, sub, lat, lon } or null (off)
  const wxCache = new Map();
  async function getJSON(url) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    try { const r = await fetch(url, { signal: ctl.signal }); return r.ok ? await r.json() : null; }
    catch (e) { return null; } finally { clearTimeout(t); }
  }
  async function fetchWeather(date, loc) {
    const diff = Math.round((new Date(date + "T12:00") - new Date(ymd(new Date()) + "T12:00")) / 864e5);
    if (diff > 15) return null; // further out than the forecast
    const key = `${date}|${loc.lat}|${loc.lon}`;
    if (wxCache.has(key)) return wxCache.get(key);
    const host = diff >= -60 ? "https://api.open-meteo.com/v1/forecast" : "https://archive-api.open-meteo.com/v1/archive";
    const j = await getJSON(`${host}?latitude=${loc.lat}&longitude=${loc.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${date}&end_date=${date}`);
    const d = (j && j.daily) || {}, c = d.weather_code && d.weather_code[0];
    const hi = d.temperature_2m_max && d.temperature_2m_max[0], lo = d.temperature_2m_min && d.temperature_2m_min[0];
    if (c == null || hi == null || lo == null) return null;
    const v = `${c},${Math.round(lo) || 0},${Math.round(hi) || 0}`;
    wxCache.set(key, v);
    return v;
  }
  // Open-Meteo's search knows few Korean city names in Korean ("서울" finds nothing), so Korean
  // cities come from this list first; the rest of the world comes from the search.
  const KR_CITIES = ("서울 서울특별시 37.57 126.98|부산 부산광역시 35.18 129.08|대구 대구광역시 35.87 128.60|인천 인천광역시 37.46 126.71|" +
    "광주 광주광역시 35.16 126.85|대전 대전광역시 36.35 127.38|울산 울산광역시 35.54 129.31|세종 세종특별자치시 36.48 127.29|" +
    "수원 경기도 37.26 127.03|성남 경기도 37.42 127.13|고양 경기도 37.66 126.83|용인 경기도 37.24 127.18|부천 경기도 37.50 126.78|" +
    "안산 경기도 37.32 126.83|안양 경기도 37.39 126.92|남양주 경기도 37.64 127.22|화성 경기도 37.20 126.83|평택 경기도 36.99 127.09|" +
    "의정부 경기도 37.74 127.03|파주 경기도 37.76 126.78|김포 경기도 37.62 126.72|시흥 경기도 37.38 126.80|광명 경기도 37.48 126.86|" +
    "하남 경기도 37.54 127.21|춘천 강원도 37.88 127.73|원주 강원도 37.34 127.92|강릉 강원도 37.75 128.88|속초 강원도 38.21 128.59|" +
    "청주 충청북도 36.64 127.49|충주 충청북도 36.99 127.93|천안 충청남도 36.82 127.11|아산 충청남도 36.79 127.00|" +
    "전주 전라북도 35.82 127.15|군산 전라북도 35.97 126.74|익산 전라북도 35.95 126.96|목포 전라남도 34.81 126.39|" +
    "여수 전라남도 34.76 127.66|순천 전라남도 34.95 127.49|포항 경상북도 36.02 129.34|경주 경상북도 35.86 129.22|" +
    "구미 경상북도 36.12 128.34|안동 경상북도 36.57 128.73|창원 경상남도 35.23 128.68|김해 경상남도 35.23 128.89|" +
    "진주 경상남도 35.18 128.11|통영 경상남도 34.85 128.43|거제 경상남도 34.88 128.62|제주 제주특별자치도 33.50 126.53|" +
    "서귀포 제주특별자치도 33.25 126.56").split("|").map((r) => { const [name, sub, lat, lon] = r.split(" "); return { name, sub, lat: +lat, lon: +lon }; });
  async function geoSearch(q) {
    const key = q.replace(/\s+/g, "").replace(/(특별자치시|특별자치도|특별시|광역시|시)$/, "");
    const local = key ? KR_CITIES.filter((c) => c.name.startsWith(key) || c.sub.startsWith(key)).slice(0, 6) : [];
    const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=ko&format=json`);
    const far = ((j && j.results) || [])
      .filter((x) => !/^K[RP]$/.test(x.country_code) || (x.population || 0) > 100000) // Korean villages that share a city's name
      .sort((a, b) => (b.population || 0) - (a.population || 0))
      .map((x) => ({ name: x.name, sub: [x.admin1 !== x.name ? x.admin1 : "", x.country].filter(Boolean).join(" "),
        lat: +(+x.latitude).toFixed(2), lon: +(+x.longitude).toFixed(2) }))
      .filter((x) => !local.some((c) => Math.abs(c.lat - x.lat) < 0.2 && Math.abs(c.lon - x.lon) < 0.2));
    return [...local, ...far].slice(0, 6);
  }
  function herePosition() { // rounded to about 1 km
    return new Promise((res, rej) => {
      if (!navigator.geolocation) { rej(new Error("no geolocation")); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => res({ name: "현재 위치", sub: "", lat: +p.coords.latitude.toFixed(2), lon: +p.coords.longitude.toFixed(2) }),
        rej, { timeout: 10000, maximumAge: 600000 });
    });
  }
  function wxChip(v) {
    const s = document.createElement("span");
    s.dataset.wx = v; s.textContent = wxLabel(v); s.contentEditable = "false";
    return s;
  }
  // Weather of `date` as the entry's first line (replace: also when it already has one).
  async function putWeather(id, date, loc, replace) {
    const v = await fetchWeather(date, loc);
    if (!v || id !== currentId) return v;
    const old = editor.querySelector("[data-wx]");
    if (old && !replace) return v;
    const untouched = serialize() === savedBody && !linesOf(editor).join("").trim() && !editor.querySelector("img");
    if (old) old.replaceWith(wxChip(v));
    else { const line = document.createElement("div"); line.appendChild(wxChip(v)); editor.prepend(line); }
    if (untouched) { savedBody = serialize(); resetHistory(); updateEmpty(); } // a weather-only entry is still "empty"
    else afterEdit();
    return v;
  }
  function weatherFor(loc) {
    const m = memos.find((x) => x.id === currentId);
    if (!m || !m.diary) return;
    flashMeta("날씨 받아오는 중…");
    putWeather(m.id, m.diary, loc, true).then((v) => flashMeta(v ? `${loc.name} 날씨를 넣었어` : "그날 날씨를 못 받아왔어"));
  }
  async function weatherHere() {
    try { weatherFor(await herePosition()); }
    catch (e) { flashMeta("위치를 못 가져왔어. 설정에서 도시를 골라 줘"); }
  }
  function weatherMenu(chip) {
    const m = memos.find((x) => x.id === currentId), diary = m && m.diary;
    openMenu(chip, [
      ...(diary && wxLoc ? [{ label: `${wxLoc.name} 날씨로 다시 받기`, onPick: () => weatherFor(wxLoc) }] : []),
      ...(diary ? [{ label: "📍 현재 위치 날씨로 바꾸기", onPick: weatherHere }] : []),
      ...(diary ? ["-"] : []),
      { label: "날씨 지우기", danger: true, onPick: () => {
        const line = lineOf(chip);
        chip.remove();
        if (line && !line.textContent && !line.querySelector("img") && editor.children.length > 1) line.remove();
        afterEdit();
      } },
    ]);
  }
  // "/날씨" in a diary entry: add (or refresh) the weather.
  function weatherSlash() {
    if (wxLoc) weatherFor(wxLoc);
    else flashMeta("설정에서 날씨 위치를 먼저 골라 줘");
  }
  // Settings: the place for the weather.
  function renderWxSettings() {
    $("wx-cur").innerHTML = wxLoc
      ? `<span>☀️ <b>${esc(wxLoc.name)}</b>${wxLoc.sub ? ` <small>${esc(wxLoc.sub)}</small>` : ""}</span><button type="button" class="text-btn" id="wx-off">끄기</button>`
      : `<span class="muted">꺼져 있어. 고르면 새 일기 맨 위에 그날 날씨가 들어가.</span>`;
  }
  function setWxLoc(loc) {
    wxLoc = loc; lsSet(WX_KEY, loc);
    $("wx-q").value = ""; $("wx-res").innerHTML = "";
    renderWxSettings();
  }
  let wxFound = [], wxTimer = null, wxSeq = 0;
  function wxSearchInput() {
    clearTimeout(wxTimer);
    const q = $("wx-q").value.trim();
    if (!q) { $("wx-res").innerHTML = ""; return; }
    wxTimer = setTimeout(async () => {
      const seq = ++wxSeq;
      const found = await geoSearch(q);
      if (seq !== wxSeq) return;
      wxFound = found;
      $("wx-res").innerHTML = found.length
        ? found.map((x, i) => `<button type="button" data-wxi="${i}">${esc(x.name)} <small>${esc(x.sub)}</small></button>`).join("")
        : `<p class="muted">못 찾았어. 다른 이름으로 해 볼래?</p>`;
    }, 350);
  }

  // ---------- photos ----------
  // A memo keeps <img data-img="ID"> only; the picture (shrunk here first) is stored by the
  // backend (images.go / api-web.js) and synced to Drive "CloudMemo/사진". src is runtime only.
  const canPhoto = () => typeof api.putImage === "function" && typeof api.getImage === "function";
  const photoURL = new Map(); // id -> Promise of an object URL ("" when not available yet)
  function photoSrc(id) {
    if (!photoURL.has(id)) {
      photoURL.set(id, Promise.resolve(api.getImage(id)).then(async (b) => {
        if (b && (await isLockedBlob(b))) { lockedPhotos.add(id); b = await unsealPhoto(b); } // "" while locked
        return b ? URL.createObjectURL(b) : "";
      }).catch(() => ""));
    }
    return photoURL.get(id);
  }
  // ---------- locked photos ----------
  // A photo in a locked memo or locked diary is stored encrypted with the secret password: its
  // bytes are a locked body (same format as a locked memo) holding the picture as a data: URL.
  // Locking or unlocking a memo copies its photos under new ids in the other form.
  const LOCKED_IMG = "application/x-cloudmemo-locked";
  const lockedPhotos = new Set(); // encrypted photos decrypted for showing (forgotten when locking)
  const photoNeedsLock = (m) => !!m && (isSecret(m) || (isDiary(m) && diaryLocked()));
  async function isLockedBlob(b) {
    return !!b && b.size > LOCK_MARKER.length && (await b.slice(0, LOCK_MARKER.length).text()) === LOCK_MARKER;
  }
  const blobToDataURL = (b) => new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result)); r.onerror = () => fail(r.error);
    r.readAsDataURL(b);
  });
  async function sealPhoto(blob, key = vault) {
    const enc = await api.encrypt(key.pw, key.salt, await blobToDataURL(blob));
    if (!key.salt) key.salt = saltOf(enc);
    return new Blob([enc], { type: LOCKED_IMG });
  }
  async function unsealPhoto(blob, pw = vault && vault.pw) {
    if (!pw) return null;
    try {
      const url = await api.decrypt(pw, await blob.text());
      return /^data:image\//.test(url) ? await (await fetch(url)).blob() : null;
    } catch (e) { return null; }
  }
  function forgetLockedPhotos() {
    for (const id of lockedPhotos) {
      const p = photoURL.get(id);
      photoURL.delete(id);
      if (p) p.then((u) => u && URL.revokeObjectURL(u));
    }
    lockedPhotos.clear();
  }
  const IMG_REF = /data-img="([0-9a-f]{24})"/g;
  const photoIds = (body) => [...new Set([...(body || "").matchAll(IMG_REF)].map((x) => x[1]))];
  // Photo ids any memo uses; null when some locked memo can't be read right now.
  function photoRefs() {
    const refs = new Set();
    for (const m of memos) {
      const b = bodyOf(m);
      if (b == null) return null;
      for (const id of photoIds(b)) refs.add(id);
    }
    if (currentId) for (const id of photoIds(serialize())) refs.add(id);
    return refs;
  }
  // Removes old photo copies that no memo uses any more (when every memo can be read).
  async function dropUnused(ids) {
    if (!ids.length || typeof api.removeImage !== "function") return;
    const refs = photoRefs();
    if (!refs) return; // left for the cleanup in settings
    for (const id of ids) if (!refs.has(id)) await api.removeImage(id).catch(() => {});
  }
  // Gives the photos of a memo body the lock state `lock`: each one in the other form is copied
  // under a new id and the body points to the copy. o.from/o.key: old password and new key when
  // the password changes (then locked photos are copied too). Returns { body, replaced: old ids }.
  async function recastPhotos(body, lock, o = {}) {
    const ids = photoIds(body), map = new Map();
    if (!ids.length || !canPhoto() || (lock && !api.lockedPhotos)) return { body, replaced: [] };
    for (const id of ids) {
      const raw = await api.getImage(id).catch(() => null);
      if (!raw) continue; // not on this device and not on Drive (yet): left as it is
      const was = await isLockedBlob(raw);
      if (was === lock && !(was && o.from)) continue;
      const pic = was ? await unsealPhoto(raw, o.from || (vault && vault.pw)) : raw;
      if (!pic) continue;
      const nid = newPhotoId();
      await api.putImage(nid, lock ? await sealPhoto(pic, o.key || vault) : pic);
      photoURL.set(nid, Promise.resolve(URL.createObjectURL(pic)));
      if (lock) lockedPhotos.add(nid);
      map.set(id, nid);
    }
    if (!map.size) return { body, replaced: [] };
    return { body: body.replace(IMG_REF, (x, id) => (map.has(id) ? `data-img="${map.get(id)}"` : x)), replaced: [...map.keys()] };
  }
  // Settings → 안 쓰는 사진 정리: encrypts plain photos found in locked memos, then moves photos
  // that no memo uses (and older than 3 days, so nothing still on its way is touched) to the trash.
  async function cleanPhotos() {
    const note = $("ph-clean-note"), btn = $("ph-clean"), say = (t) => { note.textContent = t; };
    if (typeof api.listImages !== "function") { say("이 PC 앱에서는 아직 못 해. CloudMemo.exe를 새로 받아 줘."); return; }
    const st = await api.status();
    if (!st.loggedIn) { say("구글 드라이브에 연결된 상태에서만 정리할 수 있어."); return; }
    if (memos.some((m) => isLocked(m.body)) && !(await unlockVault())) return;
    btn.disabled = true;
    try {
      await flush();
      say("동기화하는 중…");
      api.syncNow();
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); if (!(await api.status()).syncing && i > 1) break; }
      memos = await api.list();
      await decryptAll();
      if (!photoRefs()) { say("다른 비밀번호로 잠긴 메모가 있어서 어떤 사진을 쓰는지 다 볼 수 없어. 정리는 건너뛸게."); return; }
      say("잠긴 메모 속 사진 확인 중…");
      let sealed = 0;
      const replaced = [];
      for (const m of memos.filter((x) => isLocked(x.body) && photoIds(bodyOf(x)).length)) {
        const r = await recastPhotos(bodyOf(m), true);
        if (!r.replaced.length) continue;
        const enc = await encryptFor(r.body);
        await api.save(m.id, enc);
        vault.plain.set(m.id, { cipher: enc, text: r.body });
        if (m.id === currentId) setContent(r.body, enc);
        sealed += r.replaced.length;
        replaced.push(...r.replaced);
      }
      if (sealed) { memos = await api.list(); await decryptAll(); await dropUnused(replaced); }
      say("사진 목록 받는 중…");
      const list = await api.listImages(), refs = photoRefs(), cutoff = Date.now() - 3 * 864e5;
      if (!refs) return;
      const unused = list.filter((x) => !refs.has(x.id) && x.t && x.t < cutoff);
      const fresh = list.filter((x) => !refs.has(x.id) && !(x.t && x.t < cutoff)).length;
      const sealedNote = sealed ? `잠긴 메모 속 사진 ${sealed}장은 암호화했어. ` : "";
      const freshNote = fresh ? ` (최근 3일 안에 넣은 ${fresh}장은 두었어)` : "";
      if (!unused.length) { say(sealedNote + "지울 사진은 없어." + freshNote); return; }
      const mb = (unused.reduce((a, x) => a + (x.size || 0), 0) / 1048576).toFixed(1);
      if (!confirm(`어느 메모에도 없는 사진 ${unused.length}장(약 ${mb}MB)을 지울까?\n드라이브에서는 휴지통으로 옮겨져서 30일 안에는 되살릴 수 있어.\n최근 3일 안에 넣은 사진은 건드리지 않아.`)) {
        say(sealedNote + "정리를 취소했어."); return;
      }
      let done = 0;
      for (const x of unused) { say(`사진 지우는 중… ${done}/${unused.length}`); await api.removeImage(x.id); done++; }
      say(`${sealedNote}안 쓰는 사진 ${done}장을 드라이브 휴지통으로 옮겼어.${freshNote}`);
    } catch (e) { say("정리하지 못했어: " + ((e && e.message) || e)); }
    finally { btn.disabled = false; renderAll(); }
  }
  function hydratePhotos(root) {
    if (root) for (const w of root.querySelectorAll("[data-wx]")) w.contentEditable = "false"; // weather chip: tap for its menu
    if (!canPhoto() || !root) return;
    for (const img of root.querySelectorAll("img[data-img]")) {
      if (img.getAttribute("src")) continue;
      const id = img.dataset.img;
      img.classList.add("loading");
      photoSrc(id).then((u) => {
        img.classList.remove("loading");
        if (u) { img.src = u; img.classList.remove("missing"); }
        else { img.classList.add("missing"); photoURL.delete(id); } // try again on the next render
      });
    }
  }
  const newPhotoId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join("");
  // Long side at most 1600px, JPEG ~82%: a phone photo of several MB becomes a few hundred KB.
  async function shrinkPhoto(file) {
    let src = null;
    try { src = await createImageBitmap(file); } catch (e) {}
    if (!src) {
      src = await new Promise((ok, fail) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.onerror = () => fail(new Error("이 사진은 열 수 없어"));
        im.src = URL.createObjectURL(file);
      });
    }
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    const k = Math.min(1, 1600 / Math.max(w, h, 1));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); // transparent PNGs get a white back
    g.drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.82));
    if (!blob) throw new Error("사진을 줄이지 못했어");
    return blob;
  }
  // Animated GIFs (up to 8 MB) are kept as they are, so they move; shrinking keeps only one picture.
  const GIF_MAX = 8 << 20;
  async function photoForMemo(f) {
    if (f.type === "image/gif") {
      if (f.size <= GIF_MAX) {
        const g = parseGif(await f.arrayBuffer());
        if (g && g.frames.length > 1) return new Blob([f], { type: "image/gif" });
      } else flashMeta("움짤이 8MB보다 커서 멈춘 사진으로 넣었어");
    }
    return shrinkPhoto(f);
  }
  function photoBlocked() {
    const m = memos.find((x) => x.id === currentId);
    if (!m) return "메모를 먼저 열어 줘";
    if (photoNeedsLock(m)) {
      if (!api.lockedPhotos) return "이 PC 앱은 잠긴 메모에 사진을 넣을 수 없어. CloudMemo.exe를 새로 받아 줘.";
      if (!vault) return "먼저 잠금을 풀어 줘";
    }
    return "";
  }
  async function insertPhotos(files, at) {
    files = [...(files || [])].filter((f) => f && /^image\//.test(f.type));
    if (!files.length || !canPhoto()) return;
    const why = photoBlocked();
    if (why) { alert(why); return; }
    const memoId = currentId, lock = photoNeedsLock(memos.find((x) => x.id === currentId)); // encrypted copy
    focusEditor(); ensureLines(); fixLines();
    if (at) { sel().removeAllRanges(); sel().addRange(at); }
    let line = inEditor() ? lineOf(sel().anchorNode) : editor.lastElementChild;
    flashMeta(files.length > 1 ? `사진 ${files.length}장 넣는 중…` : "사진 넣는 중…");
    for (const f of files) {
      let blob, id;
      try {
        blob = await photoForMemo(f);
        id = newPhotoId();
        await api.putImage(id, lock ? await sealPhoto(blob) : blob);
      } catch (e) { alert("사진을 넣지 못했어: " + ((e && e.message) || e)); continue; }
      if (currentId !== memoId) return; // switched memo meanwhile
      const url = URL.createObjectURL(blob);
      photoURL.set(id, Promise.resolve(url));
      if (lock) lockedPhotos.add(id);
      const img = Object.assign(document.createElement("img"), { alt: "사진", src: url });
      img.dataset.img = id;
      // An empty line takes the photo; otherwise it goes on its own line below.
      if (line && line.nodeName === "DIV" && !line.textContent.trim() && !line.querySelector("img,hr")) line.replaceChildren(img);
      else {
        const div = document.createElement("div");
        div.appendChild(img);
        if (line) line.after(div); else editor.appendChild(div);
        line = div;
      }
    }
    if (!line) return;
    let next = line.nextElementSibling; // keep typing right below the photos
    if (!next || next.nodeName !== "DIV" || next.textContent.trim() || next.querySelector("img,hr")) {
      next = document.createElement("div");
      next.appendChild(document.createElement("br"));
      line.after(next);
    }
    caretAt(next, 0);
    next.scrollIntoView({ block: "nearest" });
    afterEdit();
    flashMeta(files.length > 1 ? `사진 ${files.length}장을 넣었어` : "사진을 넣었어");
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
  function setZoom(i) {
    fsIndex = i;
    applyZoom();
    try { prefStore.setItem(FS_KEY, String(fsIndex)); } catch (e) {}
    flashMeta("화면 글자 크기: " + ZOOM[fsIndex].n);
  }
  const cycleZoom = () => setZoom((fsIndex + 1) % ZOOM.length);
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
    renderSettings(); renderWxSettings();
    $("set-ver").textContent = UI_VER ? `· 버전 ${UI_VER}` : "";
    $("settings").querySelector(".sheet").scrollTop = 0;
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
    hydratePhotos(page);
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

  // ---------- ⋯ menus: the less used buttons stay in the page (hidden, .in-more) and open from here ----------
  const menuIcon = (id) => { const el = $(id) && $(id).firstElementChild; return el ? el.outerHTML : ""; };
  const menuRow = (icon, label, key) => `<span class="mi-ico">${icon}</span><span class="mi-txt">${esc(label)}</span>${key ? `<kbd>${esc(key)}</kbd>` : ""}`;
  function moreItem(id, label, key, anchor) {
    const b = $(id);
    if (!b || b.hidden) return null;
    return { html: menuRow(menuIcon(id), label, key), onPick: () => b.onclick && b.onclick({ currentTarget: anchor, target: anchor, preventDefault() {} }) };
  }
  // Drops empty entries and separators that would start, end or double up.
  const tidyItems = (items) => items.filter(Boolean).filter((it, i, a) => it !== "-" || (i > 0 && i < a.length - 1 && a[i - 1] !== "-"));
  function fmtMoreMenu(anchor) {
    const it = (id, label, key) => moreItem(id, label, key, anchor);
    openMenu(anchor, tidyItems([
      it("f-size", "글자 크기"), it("f-italic", "기울임", "Ctrl+I"), it("f-under", "밑줄", "Ctrl+U"),
      it("f-strike", "취소선", "Ctrl+Shift+S"), it("f-code", "코드", "Ctrl+E"), it("f-clear", "서식 지우기"),
      "-", it("f-hr", "구분선", "---"), it("f-outdent", "내어쓰기", "Shift+Tab"), it("f-indent", "들여쓰기", "Tab"),
      "-", it("f-time", "날짜·시간 넣기", "F5"), it("f-cal", "구글 캘린더에 추가"), it("f-help", "단축키·사용법", "F1"),
    ]));
  }
  function memoMoreMenu(anchor) {
    const m = memos.find((x) => x.id === currentId);
    if (!m) return;
    const inFolder = !$("btn-folder").hidden;
    openMenu(anchor, tidyItems([
      inFolder && { html: menuRow(menuIcon("btn-folder"), isSecret(m) ? "비밀 폴더" : m.folder ? `폴더: ${m.folder}` : "폴더로 옮기기"), onPick: () => folderMenu(anchor) },
      { html: menuRow(menuIcon("btn-font"), "화면 글자 크기", ZOOM[fsIndex].n),
        onPick: () => openMenu(anchor, ZOOM.map((z, i) => ({ label: z.n, checked: i === fsIndex, onPick: () => setZoom(i) }))) },
      { html: menuRow(menuIcon("btn-present"), "발표 모드"), onPick: startPresent },
      "-",
      { html: menuRow(menuIcon("btn-delete"), "삭제"), danger: true, onPick: deleteCurrent },
    ]));
  }
  function diaryMoreMenu(anchor) {
    const g = $("cal-gcal"), lb = $("cal-lock");
    openMenu(anchor, tidyItems([
      !g.hidden && { html: menuRow(menuIcon("cal-gcal"), calShowing() ? "구글 캘린더 일정 (켜짐)" : "구글 캘린더 일정 보기"), onPick: () => calMenu(anchor) },
      { html: menuRow(menuIcon("cal-lock"), lb.title || "일기 잠금"), onPick: () => diaryLockMenu(anchor) },
    ]));
  }
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
    hydratePhotos(editor); // photos that weren't on Drive yet may be there now
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
    if (ev === "calendar") calLoad(true); // PC app: calendar permission granted in the browser
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
    else if (e.key === "Escape" && !$("album").hidden) closeAlbum();
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
    // A copied picture (screenshot, image from a page or Photos) becomes a photo.
    const pics = [...(cd.files || [])].filter((f) => /^image\//.test(f.type));
    if (pics.length && canPhoto()) { e.preventDefault(); insertPhotos(pics); return; }
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
  editor.addEventListener("click", (e) => { const w = e.target.closest && e.target.closest("[data-wx]"); if (w && editor.contains(w)) weatherMenu(w); });
  // Tapping a photo: cover photo for the month page (diary), move up/down (phones can't drag), delete.
  editor.addEventListener("click", (e) => {
    const img = e.target && e.target.nodeName === "IMG" && e.target.dataset.img ? e.target : null;
    if (!img) return;
    const m = memos.find((x) => x.id === currentId);
    const line = lineOf(img);
    const prevLine = () => { let p = line && line.previousElementSibling; while (p && p.classList.contains("folded")) p = p.previousElementSibling; return p; };
    const nextLine = () => { let n = line && line.nextElementSibling; while (n && n.classList.contains("folded")) n = n.nextElementSibling; return n; };
    const items = [];
    if (m && isDiary(m)) {
      const rep = img.dataset.rep === "1" || (!editor.querySelector("img[data-rep]") && editor.querySelector("img[data-img]") === img);
      items.push({ label: "이 날의 대표 사진", checked: rep, onPick: () => {
        for (const x of editor.querySelectorAll("img[data-rep]")) x.removeAttribute("data-rep");
        img.dataset.rep = "1";
        afterEdit(); flashMeta("대표 사진으로 정했어");
      } }, { label: img.dataset.fx != null ? "중심 찍기 (찍혀 있음)" : "중심 찍기 (앨범에서 가운데 올 곳)", onPick: () => pickFocus(img) }, "-");
    }
    if (prevLine()) items.push({ label: "위로 옮기기", onPick: () => movePhoto(img, { line: prevLine(), after: false }) });
    if (nextLine()) items.push({ label: "아래로 옮기기", onPick: () => movePhoto(img, { line: nextLine(), after: true }) });
    items.push({ label: "사진 지우기", danger: true, onPick: () => {
      const l = lineOf(img);
      img.remove();
      if (l && !l.textContent.trim() && !l.querySelector("img,hr")) { if (l.nextElementSibling || l.previousElementSibling) l.remove(); else l.replaceChildren(document.createElement("br")); }
      afterEdit();
    } });
    openMenu(img, items);
  });

  // "중심 찍기": tap where the face is; the album's frames are cropped around it.
  function pickFocus(img) {
    const ov = document.createElement("div");
    ov.className = "overlay focus-pick";
    ov.innerHTML = `<div class="sheet fp" role="dialog" aria-modal="true" aria-label="중심 찍기">
      <h2>중심 찍기</h2><p class="fp-note">얼굴처럼 앨범에서 꼭 보여야 하는 곳을 눌러 줘.</p>
      <div class="fp-box"><img alt="사진" src="${img.src}"><i class="fp-dot" hidden></i></div>
      <div class="sheet-btns"><button type="button" class="text-btn" data-a="clear">중심 지우기</button><button type="button" class="text-btn" data-a="cancel">취소</button><button type="button" class="text-btn primary" data-a="ok">완료</button></div></div>`;
    document.body.appendChild(ov);
    const box = ov.querySelector(".fp-box"), dot = ov.querySelector(".fp-dot");
    let pt = img.dataset.fx != null ? { x: +img.dataset.fx, y: +img.dataset.fy } : null;
    const show = () => { dot.hidden = !pt; if (pt) { dot.style.left = pt.x * 100 + "%"; dot.style.top = pt.y * 100 + "%"; } };
    show();
    box.onclick = (e) => {
      const r = box.querySelector("img").getBoundingClientRect();
      pt = { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
      show();
    };
    const close = () => ov.remove();
    ov.addEventListener("click", (e) => {
      if (e.target === ov) { close(); return; }
      const a = e.target.closest("[data-a]");
      if (!a) return;
      if (a.dataset.a === "ok" && pt) { img.dataset.fx = pt.x.toFixed(3); img.dataset.fy = pt.y.toFixed(3); afterEdit(); flashMeta("중심을 찍었어"); }
      if (a.dataset.a === "clear") { delete img.dataset.fx; delete img.dataset.fy; afterEdit(); flashMeta("중심을 지웠어"); }
      close();
    });
  }
  // Dragging a photo inside the memo moves it between lines (a bar shows where it lands).
  // The browser also offers the dragged picture as a "file", so this must win over the
  // file drop below, which would otherwise add a copy.
  let dragPhoto = null, dropMark = null;
  const clearMark = () => { if (dropMark) dropMark.classList.remove("drop-before", "drop-after"); dropMark = null; };
  function dropSpot(e) { // { line, after } for the pointer position, or null
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const line = el && editor.contains(el) ? lineOf(el) : null;
    if (!line || line.classList.contains("folded")) return null;
    const r = line.getBoundingClientRect();
    return { line, after: e.clientY > r.top + r.height / 2 };
  }
  editor.addEventListener("dragstart", (e) => {
    const img = e.target && e.target.nodeName === "IMG" && e.target.dataset && e.target.dataset.img ? e.target : null;
    dragPhoto = img;
    if (img) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", ""); }
  });
  editor.addEventListener("dragend", () => { dragPhoto = null; clearMark(); });
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  editor.addEventListener("dragover", (e) => {
    if (dragPhoto) {
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const s = dropSpot(e);
      clearMark();
      if (s) { dropMark = s.line; s.line.classList.add(s.after ? "drop-after" : "drop-before"); }
      return;
    }
    if (hasFiles(e) && canPhoto()) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
  });
  editor.addEventListener("dragleave", (e) => { if (!editor.contains(e.relatedTarget)) clearMark(); });
  function movePhoto(img, spot) {
    const from = lineOf(img);
    if (!from || !spot) return;
    // The photo's own line moves when it holds only the photo; otherwise the photo leaves on a new line.
    const alone = !from.textContent.trim() && from.querySelectorAll("img").length === 1;
    const piece = alone ? from : document.createElement("div");
    if (spot.line === piece) return;
    if (!alone) { img.remove(); piece.appendChild(img); if (!from.firstChild) from.appendChild(document.createElement("br")); }
    if (spot.after) spot.line.after(piece); else spot.line.before(piece);
    caretAt(piece, 0);
    afterEdit();
  }
  editor.addEventListener("drop", (e) => {
    if (dragPhoto) {
      e.preventDefault();
      const img = dragPhoto, s = dropSpot(e);
      dragPhoto = null; clearMark();
      movePhoto(img, s);
      return;
    }
    if (!hasFiles(e) || !canPhoto()) return;
    e.preventDefault();
    let at = null;
    if (document.caretRangeFromPoint) at = document.caretRangeFromPoint(e.clientX, e.clientY);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (p) { at = document.createRange(); at.setStart(p.offsetNode, p.offset); at.collapse(true); }
    }
    insertPhotos(e.dataTransfer.files, at && editor.contains(at.startContainer) ? at : null);
  });
  $("f-photo").hidden = !canPhoto();
  $("f-photo").onclick = () => {
    const why = photoBlocked();
    if (why) { alert(why); return; }
    $("photo-input").click();
  };
  $("photo-input").onchange = (e) => { const fs = [...e.target.files]; e.target.value = ""; insertPhotos(fs); };
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
  // 오늘: back to this month and open today's entry (the diary tab has no + button).
  $("cal-today").onclick = () => { const t = new Date(); calMonth = new Date(t.getFullYear(), t.getMonth(), 1); openDiary(ymd(t)); };
  $("cal-lock").onclick = (e) => diaryLockMenu(e.currentTarget);
  $("cal-gcal").onclick = (e) => calMenu(e.currentTarget);
  $("cal-album").hidden = !canPhoto();
  $("cal-album").onclick = openAlbum;
  $("al-close").onclick = closeAlbum;
  // Album options folded away by default, so the stamps get the room (remembered on this device).
  const DECO_KEY = "cloudmemo.albumDeco";
  function setDeco(open) {
    $("album").querySelector(".sheet.album").classList.toggle("deco-open", open);
    $("al-deco").setAttribute("aria-expanded", open ? "true" : "false");
    lsSet(DECO_KEY, open);
  }
  setDeco(!!lsGet(DECO_KEY, false));
  $("al-deco").onclick = () => setDeco($("al-deco").getAttribute("aria-expanded") !== "true");
  $("al-save").onclick = () => saveAlbum(false);
  $("al-save-gif").onclick = () => saveAlbum(true);
  $("al-prev").onclick = () => { albumMonth = new Date(albumMonth.getFullYear(), albumMonth.getMonth() - 1, 1); renderAlbum(); };
  $("al-next").onclick = () => { albumMonth = new Date(albumMonth.getFullYear(), albumMonth.getMonth() + 1, 1); renderAlbum(); };
  $("album").addEventListener("click", (e) => {
    if (e.target === $("album")) { closeAlbum(); return; }
    const opt = e.target.closest(".al-seg button[data-v]");
    if (opt) { album[opt.parentElement.dataset.k] = opt.dataset.v; saveAlbumOpts(); return; }
    const q = e.target.closest(".al-pm-q");
    if (q) { album.pmCenter = album.pmCenter === q.dataset.pm ? "" : q.dataset.pm; saveAlbumOpts(); return; }
    const st = e.target.closest(".stp[data-day]");
    if (!st) return;
    const day = st.dataset.day, open = () => { closeAlbum(); calMonth = dayOf(day); calMonth.setDate(1); openDiary(day); };
    if (album.shape !== "window" || !albumStamps || !albumStamps.paintWindow) { open(); return; }
    // 창문: one tap = the next window shape, two quick taps = open that day's diary.
    if (winTap && winTap.day === day) { clearTimeout(winTap.timer); winTap = null; open(); return; }
    if (winTap) clearTimeout(winTap.timer);
    winTap = { day, timer: setTimeout(() => {
      winTap = null;
      const s = albumStamps.list.find((x) => x.key === day);
      if (!s) return;
      nextWindow(s, albumStamps.y, albumStamps.mo);
      albumStamps.paintWindow(s, true);
    }, 260) };
  });
  let winTap = null;
  $("album").addEventListener("change", (e) => {
    if (e.target.id === "al-empty") { album.empty = e.target.checked; saveAlbumOpts(); }
    if (e.target.id === "al-roll") { album.roll = e.target.checked; saveAlbumOpts(); }
  });
  // Typing in the postmark's middle redraws only the header, so the box keeps focus.
  $("album").addEventListener("input", (e) => {
    if (e.target.id !== "al-pm") return;
    album.pmCenter = e.target.value.trim();
    lsSet(ALBUM_KEY, album);
    const head = $("al-page").querySelector(".al-head");
    if (head && albumStamps) head.outerHTML = headerHTML(albumStamps.y, albumStamps.mo, albumStamps.days);
    for (const b of document.querySelectorAll(".al-pm-q")) b.classList.toggle("on", b.dataset.pm === album.pmCenter);
  });
  $("f-cal").onclick = addToCalendar;
  document.addEventListener("visibilitychange", () => { if (!document.hidden && tab === "diary") calLoad(false); });
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
  $("ph-clean").onclick = cleanPhotos;
  $("wx-q").addEventListener("input", wxSearchInput);
  $("wx-res").addEventListener("click", (e) => { const b = e.target.closest("button[data-wxi]"); if (b) setWxLoc(wxFound[+b.dataset.wxi]); });
  $("wx-cur").addEventListener("click", (e) => { if (e.target.closest("#wx-off")) setWxLoc(null); });
  $("wx-here").onclick = async () => {
    $("wx-here").disabled = true;
    try { const p = await herePosition(); setWxLoc({ ...p, sub: `${p.lat}, ${p.lon}` }); }
    catch (e) { $("wx-res").innerHTML = `<p class="muted">위치를 못 가져왔어. 위치 권한을 켜거나 도시 이름으로 찾아 줘.</p>`; }
    $("wx-here").disabled = false;
  };
  $("settings").addEventListener("input", (e) => {
    if (e.target.id === "set-pick") { look.accent = e.target.value.toLowerCase(); try { prefStore.setItem(LOOK_KEY, JSON.stringify(look)); } catch (x) {} applyLook(); }
  });
  $("settings").addEventListener("change", (e) => { if (e.target.id === "set-pick") renderSettings(); });
  $("btn-delete").onclick = deleteCurrent;
  $("btn-more").onclick = (e) => memoMoreMenu(e.currentTarget);
  $("f-more").onclick = (e) => fmtMoreMenu(e.currentTarget);
  $("cal-more").onclick = (e) => diaryMoreMenu(e.currentTarget);
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
  function helpTab(name) {
    for (const b of document.querySelectorAll(".help-tabs button")) {
      const on = b.dataset.h === name;
      b.classList.toggle("on", on); b.setAttribute("aria-selected", on);
    }
    for (const s of document.querySelectorAll(".help-body section")) s.hidden = s.dataset.h !== name;
    $("help").querySelector(".help-body").scrollTop = 0;
  }
  helpTab("basic");
  document.querySelector(".help-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-h]");
    if (b) helpTab(b.dataset.h);
  });
  $("help").addEventListener("keydown", (e) => { // ← → switch tabs
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = [...document.querySelectorAll(".help-tabs button")];
    const i = tabs.findIndex((b) => b.classList.contains("on"));
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    helpTab(n.dataset.h); n.focus();
  });
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
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).nodeName || "");
    if (e.key === "F5" && !mod) { e.preventDefault(); if (currentId && !inField) insertNow(); return; }
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
