// Browser backend for the iPhone / web app. Implements the same window.api
// the Windows exe provides, with the same Drive layout and sync rules as
// remote.go / sync.go, so both apps share one "CloudMemo" folder.
(function () {
  const CLIENT_ID = (window.CLOUDMEMO_CLIENT_ID || "").trim();
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const K = { memos: "cloudmemo.memos.v1", token: "cloudmemo.token", acct: "cloudmemo.account",
              state: "cloudmemo.oauthState", silentAt: "cloudmemo.silentAt", connected: "cloudmemo.connected" };
  const FOLDER = "CloudMemo", FOLDER_MIME = "application/vnd.google-apps.folder";
  const API = "https://www.googleapis.com/drive/v3", UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const FILE_FIELDS = "id,name,modifiedTime,appProperties";

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { lastError = "이 기기 저장 공간이 부족해"; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  let memos = ls.get(K.memos, {});      // id -> memo (same fields as Go's Memo)
  let syncing = false, lastSync = 0, lastError = "", folderId = "", syncTimer = null;
  const persist = () => ls.set(K.memos, memos);
  const emit = (ev) => window.__cmEvent && window.__cmEvent(ev);
  const dto = (m) => ({ id: m.id, body: m.body, updated: m.updated });
  const bump = (prev) => Math.max(Date.now(), (prev || 0) + 1);
  function newId() {
    const b = new Uint8Array(12); crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  function titleOf(body) {
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t) return Array.from(t).slice(0, 40).join("");
    }
    return "제목 없음";
  }
  const fileNameOf = (body) => titleOf(body).replace(/[\/\\:*?"<>|]/g, "_") + ".txt";

  // ---------- auth (OAuth implicit flow via full-page redirect; popups are unreliable in iOS home-screen apps) ----------
  const redirectUri = () => new URL(".", location.href).href;
  function token() {
    const t = ls.get(K.token, null);
    return t && t.exp > Date.now() + 60000 ? t.access_token : null;
  }
  async function startAuth(silent) {
    if (!CLIENT_ID) return;
    if (window.__cmFlush) await window.__cmFlush();
    const state = newId();
    ls.set(K.state, state);
    const p = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: redirectUri(), response_type: "token",
      scope: SCOPE, state, include_granted_scopes: "true",
    });
    const hint = ls.get(K.acct, "");
    if (hint) p.set("login_hint", hint);
    if (silent) { p.set("prompt", "none"); ls.set(K.silentAt, Date.now()); }
    location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + p);
  }
  function consumeRedirect() {
    if (!location.hash || location.hash.length < 2) return;
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.has("access_token") && !h.has("error")) return;
    history.replaceState(null, "", location.pathname + location.search);
    const expected = ls.get(K.state, "");
    ls.del(K.state);
    if (!expected || h.get("state") !== expected) return;
    // Silent renewal refused (signed out of Google, consent revoked...): the status bar
    // then shows "세션 만료" with a reconnect button.
    if (h.has("error")) return;
    ls.set(K.token, { access_token: h.get("access_token"), exp: Date.now() + (+h.get("expires_in") || 3600) * 1000 });
    ls.set(K.connected, true);
  }
  // Renew an expired token without interaction, at most once per 5 minutes, only when idle.
  function maybeSilentRenew() {
    if (!CLIENT_ID || !ls.get(K.connected, false) || token()) return;
    if (!navigator.onLine || Date.now() - ls.get(K.silentAt, 0) < 5 * 60000) return;
    startAuth(true);
  }

  // ---------- Drive REST ----------
  async function gfetch(url, opt = {}) {
    const t = token();
    if (!t) throw new Error("드라이브 세션 만료");
    const res = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), Authorization: "Bearer " + t } });
    if (res.status === 401) { ls.del(K.token); throw new Error("드라이브 세션 만료"); }
    if (!res.ok) {
      let msg = res.status + "";
      try { msg = (await res.json()).error.message || msg; } catch (e) {}
      const err = new Error("드라이브 오류: " + msg); err.status = res.status; throw err;
    }
    return res;
  }
  const toRemote = (f) => ({ id: f.id, memoId: (f.appProperties || {}).memoId || "", name: f.name, modified: f.modifiedTime });
  function multipart(meta, body) {
    const b = "cm" + newId();
    return {
      headers: { "Content-Type": "multipart/related; boundary=" + b },
      body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
            `--${b}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n--${b}--`,
    };
  }
  const remote = {
    async folder() {
      if (folderId) return { id: folderId, fresh: false };
      const q = `name = '${FOLDER}' and mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`;
      const r = await (await gfetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&orderBy=createdTime`)).json();
      if (r.files && r.files.length) { folderId = r.files[0].id; return { id: folderId, fresh: false }; }
      const f = await (await gfetch(`${API}/files?fields=id`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_MIME }),
      })).json();
      folderId = f.id;
      return { id: folderId, fresh: true };
    },
    async list() {
      const { id, fresh } = await this.folder();
      const files = [];
      let page = "";
      try {
        do {
          const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
          const r = await (await gfetch(`${API}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(${FILE_FIELDS})` +
            (page ? "&pageToken=" + encodeURIComponent(page) : ""))).json();
          for (const f of r.files || []) { const rf = toRemote(f); if (rf.memoId) files.push(rf); }
          page = r.nextPageToken || "";
        } while (page);
      } catch (e) { if (e.status === 404) folderId = ""; throw e; }
      return { files, fresh };
    },
    async download(id) {
      const s = await (await gfetch(`${API}/files/${id}?alt=media`)).text();
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    },
    async create(memoId, name, body) {
      const { id } = await this.folder();
      const meta = { name, mimeType: "text/plain", parents: [id], appProperties: { memoId } };
      return toRemote(await (await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`,
        { method: "POST", ...multipart(meta, body) })).json());
    },
    async update(fileId, memoId, name, body) {
      const meta = { name, appProperties: { memoId } };
      return toRemote(await (await gfetch(`${UPLOAD}/files/${fileId}?uploadType=multipart&fields=${FILE_FIELDS}`,
        { method: "PATCH", ...multipart(meta, body) })).json());
    },
    async trash(fileId) {
      try {
        await gfetch(`${API}/files/${fileId}?fields=id`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
        });
      } catch (e) { if (e.status !== 404) throw e; }
    },
  };

  // ---------- sync (mirror of sync.go SyncOnce) ----------
  function resetSync() {
    for (const id of Object.keys(memos)) {
      const m = memos[id];
      if (m.deleted) { delete memos[id]; continue; }
      m.remoteId = ""; m.remoteModified = ""; m.syncedAt = 0;
    }
    persist();
  }
  function applyRemote(l, r, body) {
    const m = memos[l.id];
    if (!m || m.updated !== l.updated || m.deleted) return; // edited during download; next round
    const t = Date.parse(r.modified) || Date.now();
    Object.assign(m, { body, updated: t, remoteId: r.id, remoteModified: r.modified, syncedAt: t });
    persist();
  }
  async function push(l, fileId) {
    const name = fileNameOf(l.body);
    const r = fileId ? await remote.update(fileId, l.id, name, l.body) : await remote.create(l.id, name, l.body);
    const m = memos[l.id];
    if (!m) return;
    Object.assign(m, { remoteId: r.id, remoteModified: r.modified, syncedAt: l.updated });
    persist();
  }
  async function syncOnce() {
    const { files, fresh } = await remote.list();
    if (fresh) resetSync();

    const rmap = {};
    for (const f of files) {
      const prev = rmap[f.memoId];
      if (prev) {
        if (prev.modified >= f.modified) { await remote.trash(f.id).catch(() => {}); continue; }
        await remote.trash(prev.id).catch(() => {});
      }
      rmap[f.memoId] = f;
    }
    const local = {};
    for (const id of Object.keys(memos)) local[id] = { ...memos[id] };

    for (const memoId of Object.keys(rmap)) {
      const r = rmap[memoId], l = local[memoId];
      if (!l) {
        const body = await remote.download(r.id);
        const t = Date.parse(r.modified) || Date.now();
        if (!memos[memoId]) {
          memos[memoId] = { id: memoId, body, created: t, updated: t, remoteId: r.id, remoteModified: r.modified, syncedAt: t };
          persist();
        }
        continue;
      }
      if (l.deleted) {
        await remote.trash(r.id);
        if (memos[memoId] && memos[memoId].deleted) { delete memos[memoId]; persist(); }
        continue;
      }
      const remoteChanged = r.modified !== (l.remoteModified || "") || r.id !== (l.remoteId || "");
      const localChanged = l.updated > (l.syncedAt || 0);
      if (!remoteChanged && !localChanged) continue;
      if (!localChanged) { applyRemote(l, r, await remote.download(r.id)); continue; }
      if (!remoteChanged) { await push(l, r.id); continue; }
      const body = await remote.download(r.id);
      if (body !== l.body) {
        const t = Date.now(), id = newId();
        memos[id] = { id, body: "[충돌] " + l.body, created: t, updated: t };
        persist();
      }
      applyRemote(l, r, body);
    }

    for (const id of Object.keys(local)) {
      if (rmap[id]) continue;
      const l = local[id], m = memos[id];
      if (l.deleted) {
        if (m && m.deleted) { delete memos[id]; persist(); }
      } else if (l.remoteId && !fresh) {
        if (l.updated > (l.syncedAt || 0)) await push(l, "");
        else if (m && m.updated === l.updated) { delete memos[id]; persist(); }
      } else if (l.body.trim()) {
        await push(l, "");
      }
    }
  }

  async function ensureAccount() {
    const r = await (await gfetch(`${API}/about?fields=user(emailAddress)`)).json();
    const email = (r.user && r.user.emailAddress) || "";
    const prev = ls.get(K.acct, "");
    if (email && prev && email !== prev) { resetSync(); folderId = ""; }
    if (email) ls.set(K.acct, email);
  }
  let accountChecked = false;

  async function runSync() {
    if (syncing || !token()) { emit("status"); return; }
    syncing = true; emit("status");
    try {
      if (!accountChecked) { await ensureAccount(); accountChecked = true; }
      await syncOnce();
      lastSync = Date.now(); lastError = "";
    } catch (e) {
      lastError = e instanceof TypeError ? "오프라인 — 연결되면 동기화돼" : (e.message || String(e));
    }
    syncing = false;
    emit("changed");
  }
  function requestSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, delay);
  }

  // ---------- public API ----------
  window.api = {
    async list() {
      return Object.values(memos).filter((m) => !m.deleted).sort((a, b) => b.updated - a.updated).map(dto);
    },
    async create() {
      const t = Date.now(), m = { id: newId(), body: "", created: t, updated: t };
      memos[m.id] = m; persist();
      return dto(m);
    },
    async save(id, body) {
      const m = memos[id];
      if (!m || m.deleted) throw new Error("메모를 찾을 수 없음");
      if (m.body !== body) { m.body = body; m.updated = bump(m.updated); persist(); requestSync(3000); }
      return dto(m);
    },
    async remove(id) {
      const m = memos[id];
      if (!m) return;
      if (!m.remoteId) delete memos[id];
      else { m.deleted = true; m.body = ""; m.updated = bump(m.updated); }
      persist(); requestSync(1000);
    },
    async status() {
      const connected = ls.get(K.connected, false), live = !!token();
      return {
        loggedIn: connected && live,
        hasCredentials: !!CLIENT_ID,
        credHint: CLIENT_ID ? "" : "config.js에 OAuth 클라이언트 ID를 넣어줘",
        syncing, loggingIn: false, lastSync,
        error: connected && !live ? "드라이브 세션 만료" : lastError,
      };
    },
    login() { startAuth(false); },
    async logout() {
      const t = token();
      ls.del(K.token); ls.del(K.connected); ls.del(K.acct);
      folderId = ""; lastSync = 0; lastError = ""; accountChecked = false;
      resetSync();
      if (t) fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t), { method: "POST" }).catch(() => {});
    },
    syncNow() { token() ? runSync() : startAuth(false); },
  };

  // ---------- startup ----------
  consumeRedirect();
  maybeSilentRenew();
  setTimeout(runSync, 0);
  setInterval(() => { if (!document.hidden) runSync(); }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (token()) runSync(); else maybeSilentRenew();
  });
  window.addEventListener("online", () => runSync());
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
