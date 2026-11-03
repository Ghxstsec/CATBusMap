/* CATBusMap — app sin dependencias aparte de Leaflet */
(() => {
  "use strict";

  // ---------- utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const cache = new Map();
  async function getJSON(url) {
    if (cache.has(url)) return cache.get(url);
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    cache.set(url, p);
    p.catch(() => cache.delete(url));
    return p;
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmt = (m) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
  const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const todayIso = () => isoDate(new Date());
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const dist = (a, b, c, d) => {
    const R = 6371e3, r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * R;
  };
  function decodePolyline(s) {
    const pts = []; let i = 0, lat = 0, lon = 0;
    while (i < s.length) {
      for (const k of [0, 1]) {
        let b, shift = 0, res = 0;
        do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const v = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += v; else lon += v;
      }
      pts.push([lat / 1e5, lon / 1e5]);
    }
    return pts;
  }

  // ---------- estado ----------
  const S = {
    lang: store.get("lang", "es"),
    agency: store.get("operator", null), // null = todos
    favs: store.get("favs", { stops: [], routes: [] }),
    meta: null, stops: [], stopById: new Map(), svcBits: new Map(),
    me: null,
  };
  const t = (k, vars) => {
    let s = (I18N[S.lang] && I18N[S.lang][k]) || I18N.es[k] || k;
    if (vars) for (const [a, b] of Object.entries(vars)) s = s.replace(`{${a}}`, b);
    return s;
  };

  // ---------- calendario ----------
  function svcActive(svc, dateIso) {
    let bits = S.svcBits.get(svc);
    if (!bits) {
      const b64 = S.meta.services[svc];
      if (!b64) return false;
      bits = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      S.svcBits.set(svc, bits);
    }
    const idx = Math.round((parseIso(dateIso) - parseIso(S.meta.base)) / 864e5);
    if (idx < 0 || idx >= S.meta.days) return false;
    return (bits[idx >> 3] >> (idx & 7)) & 1;
  }
  const prevDay = (iso) => { const d = parseIso(iso); d.setDate(d.getDate() - 1); return isoDate(d); };

  // ---------- líneas ----------
  const PALETTE = ["#0f766e", "#1d4ed8", "#b91c1c", "#7c3aed", "#c2410c", "#047857", "#be185d", "#0369a1", "#a16207", "#4d7c0f", "#9333ea", "#0e7490"];
  function routeInfo(rid) {
    const r = S.meta.routes[rid];
    if (!r) return { id: rid, code: rid, name: rid, color: "#666", agency: "" };
    const m = r.l.match(/^\(([^)]+)\)\s*(.*)$/);
    const code = m ? m[1] : r.s.replace(/^L0*/, "L");
    const name = m ? m[2] : r.l;
    let h = 0; for (const c of rid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const color = r.c ? `#${r.c}` : PALETTE[h % PALETTE.length];
    return { id: rid, code, name: name || r.l, color, agency: S.meta.agencies[r.a] || "", agencyId: r.a };
  }
  const badge = (ri) => `<span class="badge" style="background:${ri.color}">${esc(ri.code)}</span>`;
  const stopName = (id) => (S.stopById.get(id) || [id, id])[1];
  const inAgency = (rid) => !S.agency || (S.meta.routes[rid] && S.meta.routes[rid].a === S.agency);
  const stopVisible = (s) => !S.agency || s[4].some(inAgency);

  // ---------- favoritos ----------
  const isFav = (kind, id) => S.favs[kind].includes(id);
  function toggleFav(kind, id) {
    const a = S.favs[kind];
    const i = a.indexOf(id);
    if (i >= 0) a.splice(i, 1); else a.push(id);
    store.set("favs", S.favs);
  }
  const starBtn = (kind, id) =>
    `<button class="star" data-fav="${kind}:${esc(id)}" title="${t(isFav(kind, id) ? "removeFav" : "addFav")}">${isFav(kind, id) ? "★" : "☆"}</button>`;

  // ---------- mapa ----------
  let map, tiles, stopLayer, routeLayer, busLayer, meMarker, selMarker;
  function initMap() {
    map = L.map("map", { preferCanvas: true, zoomControl: true }).setView(store.get("view", [41.75, 1.75]), store.get("zoom", 8));
    if (isMobile()) map.attributionControl.setPosition("topright");
    // OpenStreetMap; en modo oscuro se invierte por CSS (sin API key)
    tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    stopLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    busLayer = L.layerGroup().addTo(map);
    map.on("moveend", () => {
      const c = map.getCenter();
      store.set("view", [c.lat, c.lng]); store.set("zoom", map.getZoom());
      drawStops();
    });
  }
  let highlightStops = null; // Set de paradas a destacar (línea abierta)
  function drawStops() {
    if (!map || !S.stops.length) return;
    stopLayer.clearLayers();
    const z = map.getZoom();
    const b = map.getBounds().pad(0.2);
    const dark = document.documentElement.dataset.theme === "dark";
    const filtered = !!S.agency;
    if (!highlightStops && !filtered && z < 11) return;
    if (!highlightStops && filtered && z < 9) return;
    const r = z >= 15 ? 7 : z >= 13 ? 5 : 4;
    for (const s of S.stops) {
      if (!b.contains([s[2], s[3]])) continue;
      const hl = highlightStops && highlightStops.has(s[0]);
      if (highlightStops ? !hl && z < 13 : !stopVisible(s)) continue;
      L.circleMarker([s[2], s[3]], {
        radius: hl ? r + 1 : r, weight: 2,
        color: hl ? "#fff" : dark ? "#0e1116" : "#ffffff",
        fillColor: hl ? "#111" : "#0f766e", fillOpacity: hl ? 1 : 0.9, opacity: 1,
      }).bindTooltip(esc(s[1]), { direction: "top" })
        .on("click", () => go(`#/stop/${encodeURIComponent(s[0])}`))
        .addTo(stopLayer);
    }
  }
  function selectStopMarker(s) {
    if (selMarker) map.removeLayer(selMarker);
    if (!s) return;
    selMarker = L.circleMarker([s[2], s[3]], { radius: 11, color: "#d9480f", weight: 4, fill: false, interactive: false }).addTo(map);
  }
  function clearRouteLayers() {
    routeLayer.clearLayers(); busLayer.clearLayers(); highlightStops = null;
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }
  const isMobile = () => matchMedia("(max-width: 760px)").matches;
  function fitTo(bounds) {
    const opts = isMobile() ? { paddingTopLeft: [20, 20], paddingBottomRight: [20, window.innerHeight * 0.5] } : { padding: [30, 30] };
    map.fitBounds(bounds, { ...opts, maxZoom: 15 });
  }
  function panToStop(s) {
    const z = Math.max(map.getZoom(), 15);
    if (isMobile()) {
      const p = map.project([s[2], s[3]], z).add([0, window.innerHeight * 0.22]);
      map.setView(map.unproject(p, z), z);
    } else map.setView([s[2], s[3]], z);
  }

  // ---------- router ----------
  const view = () => $("#view");
  const go = (h) => { if (location.hash === h) route(); else location.hash = h; };
  window.addEventListener("hashchange", route);
  function setTab(name) {
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === name));
  }
  async function route() {
    const h = decodeURIComponent(location.hash.slice(1) || "/");
    const parts = h.split("/").filter(Boolean);
    clearRouteLayers();
    expandSheet("open");
    if (parts[0] !== "stop") selectStopMarker(null);
    view().scrollTop = 0;
    try {
      if (parts[0] === "stop") { setTab(""); await renderStop(parts[1], parts[2]); }
      else if (parts[0] === "route") { setTab(""); await renderRoute(parts[1], parts[2], parts[3]); }
      else if (parts[0] === "plan") { setTab("plan"); renderPlan(parts[1], parts[2]); }
      else if (parts[0] === "favs") { setTab("favs"); renderFavs(); }
      else if (parts[0] === "search") { setTab(""); const q = parts.slice(1).join("/"); $("#q").value = q; renderSearch(q); }
      else { setTab("home"); renderHome(); }
    } catch (e) {
      console.error(e);
      view().innerHTML = `<p class="pad muted">Error: ${esc(e.message)}</p>`;
    }
    drawStops();
  }

  // ---------- vistas ----------
  function agencyPicker() {
    const ags = Object.entries(S.meta.agencies).sort((a, b) => a[1].localeCompare(b[1]));
    return `
      <div class="row-ctrl">
        <select id="agencySel" aria-label="${t("operator")}">
          <option value="">${t("allOperators")}</option>
          ${ags.map(([id, n]) => `<option value="${id}" ${S.agency === id ? "selected" : ""}>${esc(n)}</option>`).join("")}
        </select>
      </div>`;
  }
  function routeItem(rid) {
    const ri = routeInfo(rid);
    return `<li><a href="#/route/${encodeURIComponent(rid)}">${badge(ri)}<div class="t"><b>${esc(ri.name)}</b><span>${esc(ri.agency)}</span></div></a></li>`;
  }
  function stopItem(s, extra = "") {
    const codes = s[4].slice(0, 6).map((r) => routeInfo(r).code).join(" · ");
    return `<li><a href="#/stop/${encodeURIComponent(s[0])}"><span class="dot"></span><div class="t"><b>${esc(s[1])}</b><span>${esc(codes)}</span></div>${extra}</a></li>`;
  }
  function sortRoutes(ids) {
    return ids.sort((a, b) => routeInfo(a).code.localeCompare(routeInfo(b).code, undefined, { numeric: true }));
  }

  function renderHome() {
    const rids = sortRoutes(Object.keys(S.meta.routes).filter(inAgency));
    let near = "";
    if (S.me) {
      const ns = S.stops.filter(stopVisible)
        .map((s) => [s, dist(S.me[0], S.me[1], s[2], s[3])])
        .sort((a, b) => a[1] - b[1]).slice(0, 5);
      near = `<h3>${t("nearby")}</h3><ul class="list">${ns.map(([s, d]) => stopItem(s, `<span class="muted small">${d < 1000 ? Math.round(d) + " m" : (d / 1000).toFixed(1) + " km"}</span>`)).join("")}</ul>`;
    }
    view().innerHTML = `${agencyPicker()}${near}
      <h3>${t("lines")} (${rids.length})</h3>
      <ul class="list">${rids.map(routeItem).join("")}</ul>
      ${!S.agency && map.getZoom() < 11 ? `<p class="pad muted small">${t("zoomHint")}</p>` : ""}`;
  }

  function renderSearch(q) {
    const n = norm(q.trim());
    if (!n) return renderHome();
    const words = n.split(/\s+/);
    const match = (txt) => { const x = norm(txt); return words.every((w) => x.includes(w)); };
    const rids = sortRoutes(Object.keys(S.meta.routes).filter((rid) => {
      const ri = routeInfo(rid); return inAgency(rid) && match(`${ri.code} ${ri.name} ${ri.agency}`);
    })).slice(0, 30);
    const sts = S.stops.filter((s) => stopVisible(s) && match(s[1])).slice(0, 40);
    view().innerHTML = `
      ${S.agency ? `<p class="pad small muted">${t("operator")}: ${esc(S.meta.agencies[S.agency])} · <a href="#" data-agency="">${t("allOperators")}</a></p>` : ""}
      <h3>${t("lines")}</h3>${rids.length ? `<ul class="list">${rids.map(routeItem).join("")}</ul>` : `<p class="pad muted">${t("noResults")}</p>`}
      <h3>${t("stops")}</h3>${sts.length ? `<ul class="list">${sts.map((s) => stopItem(s)).join("")}</ul>` : `<p class="pad muted">${t("noResults")}</p>`}`;
  }

  function renderFavs() {
    const rs = S.favs.routes.filter((r) => S.meta.routes[r]);
    const ss = S.favs.stops.map((id) => S.stopById.get(id)).filter(Boolean);
    if (!rs.length && !ss.length) { view().innerHTML = `<p class="pad muted">${t("favsEmpty")}</p>`; return; }
    view().innerHTML = `
      ${ss.length ? `<h3>${t("stops")}</h3><ul class="list">${ss.map((s) => stopItem(s)).join("")}</ul>` : ""}
      ${rs.length ? `<h3>${t("lines")}</h3><ul class="list">${rs.map(routeItem).join("")}</ul>` : ""}`;
  }

  // salidas de una parada en una fecha (incluye nocturnos del día anterior)
  async function stopDepartures(sid, dateIso) {
    const deps = await getJSON(`data/stop/${encodeURIComponent(sid)}.json`);
    const prev = prevDay(dateIso);
    const out = [];
    for (const d of deps) {
      const [m, rid, svc, dest, tid] = d;
      if (svcActive(svc, dateIso)) out.push({ m, rid, dest, tid, night: false });
      if (m >= 1440 && svcActive(svc, prev)) out.push({ m: m - 1440, rid, dest, tid, night: true });
    }
    return out.sort((a, b) => a.m - b.m);
  }

  async function renderStop(sid, dateIso) {
    const s = S.stopById.get(sid);
    if (!s) { view().innerHTML = `<p class="pad muted">${t("noResults")}</p>`; return; }
    selectStopMarker(s);
    panToStop(s);
    const date = dateIso || todayIso();
    const isToday = date === todayIso();
    const showAll = !isToday || sessionStorage.getItem("showAll") === "1";
    view().innerHTML = `
      <div class="head">
        <button class="back" data-back title="${t("back")}">‹</button>
        <div class="grow"><h2>${esc(s[1])}</h2><div class="small muted">${s[4].slice(0, 10).map((r) => badge(routeInfo(r))).join(" ")}${s[4].length > 10 ? ` +${s[4].length - 10}` : ""}</div></div>
        ${starBtn("stops", sid)}
      </div>
      <div class="row-ctrl">
        <input type="date" id="dateSel" value="${date}" min="${S.meta.base}">
        ${!isToday ? `<button class="chip" data-date="">${t("today")}</button>` : `<button class="chip" id="toggleAll">${showAll ? t("showNext") : t("showAll")}</button>`}
        <a class="chip" href="#/plan/${encodeURIComponent(sid)}">${t("tabPlan")}</a>
      </div>
      <div id="deps"><p class="pad muted">${t("loading")}</p></div>`;
    let deps = await stopDepartures(sid, date);
    const now = nowMin();
    if (isToday && !showAll) deps = deps.filter((d) => d.m >= now - 1).slice(0, 30);
    const html = deps.map((d) => {
      const ri = routeInfo(d.rid);
      const diff = d.m - now;
      const when = isToday && diff >= 0 && diff <= 90 ? `<small>${diff === 0 ? t("now") : t("inMin", { n: diff })}</small>` : "";
      const past = isToday && showAll && d.m < now;
      return `<li${past ? ' style="opacity:.5"' : ""}><a href="#/route/${encodeURIComponent(d.rid)}/${encodeURIComponent(d.tid)}/${date}">${badge(ri)}
        <div class="t"><b>${t("to")} ${esc(stopName(d.dest))}</b><span>${esc(ri.name)}${d.night ? " " + t("yesterday") : ""}</span></div>
        <div class="time">${fmt(d.m)}${when}</div></a></li>`;
    }).join("");
    $("#deps").innerHTML = `<h3>${isToday && !showAll ? t("nextDeps") : t("depsOf") + " " + parseIso(date).toLocaleDateString(S.lang)}</h3>
      ${deps.length ? `<ul class="list">${html}</ul>` : `<p class="pad muted">${isToday && !showAll ? t("noMoreToday") : t("noDeps")}</p>`}`;
    $("#dateSel").onchange = (e) => go(`#/stop/${encodeURIComponent(sid)}/${e.target.value}`);
    const ta = $("#toggleAll");
    if (ta) ta.onclick = () => { sessionStorage.setItem("showAll", showAll ? "0" : "1"); route(); };
  }

  let liveTimer = null;
  // #/route/<id>/<dir|tripId>/<fecha>
  async function renderRoute(rid, arg, dateIso) {
    if (!S.meta.routes[rid]) { view().innerHTML = `<p class="pad muted">${t("noResults")}</p>`; return; }
    const ri = routeInfo(rid);
    const R = await getJSON(`data/route/${encodeURIComponent(rid)}.json`);
    const date = dateIso || todayIso();
    const isToday = date === todayIso();
    let tripSel = null;
    let dir = 0;
    if (arg && arg.length > 1) {
      for (const p of R.patterns) for (const tr of p.trips) if (tr[0] === arg) { tripSel = { p, tr }; dir = p.dir; }
    } else if (arg) dir = Number(arg);
    const dirs = [...new Set(R.patterns.map((p) => p.dir))].sort();
    if (!dirs.includes(dir)) dir = dirs[0];

    // mapa: trazados
    const shapes = Object.entries(R.shapes).map(([k, v]) => [k, decodePolyline(v)]);
    let bounds = null;
    for (const [k, pts] of shapes) {
      const mine = tripSel ? tripSel.p.shape === k : R.patterns.some((p) => p.dir === dir && p.shape === k);
      const line = L.polyline(pts, { color: ri.color, weight: mine ? 5 : 3, opacity: mine ? 0.95 : 0.35, interactive: false }).addTo(routeLayer);
      if (mine) bounds = bounds ? bounds.extend(line.getBounds()) : line.getBounds();
    }
    const allStops = new Set(R.patterns.flatMap((p) => p.stops));
    highlightStops = allStops;
    if (!bounds) {
      const ll = [...allStops].map((id) => S.stopById.get(id)).filter(Boolean).map((s) => [s[2], s[3]]);
      if (ll.length) bounds = L.latLngBounds(ll);
    }
    if (bounds) fitTo(bounds);

    const pats = R.patterns.filter((p) => p.dir === dir);
    const main = tripSel ? tripSel.p : pats[0];
    const runs = (svc) => svcActive(svc, date);
    const dirLabel = (d) => {
      const p = R.patterns.find((x) => x.dir === d);
      return p ? `${stopName(p.stops[0])} → ${stopName(p.stops[p.stops.length - 1])}` : d;
    };

    // horario del día en este sentido
    const prev = prevDay(date);
    const trips = [];
    for (const p of pats) for (const tr of p.trips) {
      if (runs(tr[1])) trips.push({ p, tr, off: 0 });
      if (tr[2][tr[2].length - 1] >= 1440 && svcActive(tr[1], prev)) trips.push({ p, tr, off: -1440 });
    }
    trips.sort((a, b) => a.tr[2][0] + a.off - (b.tr[2][0] + b.off));
    const now = nowMin();

    let body;
    if (tripSel) {
      const { p, tr } = tripSel;
      const note = R.notes[tr[0]];
      body = `<h3>${t("stopTrips")}</h3>
        ${note ? `<div class="notice">⚠ ${esc(note)}</div>` : ""}
        <ul class="stoplist" style="--c:${ri.color}">${p.stops.map((sid, i) =>
          `<li data-stop="${esc(sid)}"><span class="rail"></span><span class="nm">${esc(stopName(sid))}</span><span class="tm">${fmt(tr[2][i])}</span></li>`).join("")}</ul>`;
    } else {
      body = `
        <h3>${t("timetable")} · ${t("trips", { n: trips.length })}</h3>
        ${trips.length ? `<table class="tt"><tr><th>${t("departure")}</th><th>${t("arrival")}</th><th>${t("duration")}</th><th></th></tr>
          ${trips.map(({ p, tr, off }) => {
            const a = tr[2][0] + off, b = tr[2][tr[2].length - 1] + off;
            const past = isToday && b < now;
            const variant = p !== main ? `<span class="small muted"> · ${esc(stopName(p.stops[0]))} → ${esc(stopName(p.stops[p.stops.length - 1]))}</span>` : "";
            return `<tr class="click${past ? " past" : ""}" data-trip="${esc(tr[0])}"><td><b>${fmt(a)}</b>${variant}</td><td>${fmt(b)}</td><td>${b - a} min</td><td class="note">${R.notes[tr[0]] ? "⚠" : ""}</td></tr>`;
          }).join("")}</table>` : `<p class="pad muted">${t("noTrips")}</p>`}
        <h3>${t("route")}</h3>
        <ul class="stoplist" style="--c:${ri.color}">${main.stops.map((sid) =>
          `<li data-stop="${esc(sid)}"><span class="rail"></span><span class="nm">${esc(stopName(sid))}</span></li>`).join("")}</ul>`;
    }

    view().innerHTML = `
      <div class="head">
        <button class="back" data-back title="${t("back")}">‹</button>
        ${badge(ri)}
        <div class="grow"><h2>${esc(ri.name)}</h2><div class="small muted">${esc(ri.agency)}</div></div>
        ${starBtn("routes", rid)}
      </div>
      ${tripSel ? "" : `<div class="chips">${dirs.map((d) => `<button class="chip ${d === dir ? "on" : ""}" data-dir="${d}">${esc(dirLabel(d))}</button>`).join("")}</div>`}
      <div class="row-ctrl">
        <input type="date" id="dateSel" value="${date}" min="${S.meta.base}">
        ${!isToday ? `<button class="chip" data-date="">${t("today")}</button>` : ""}
        ${tripSel ? `<a class="chip" href="#/route/${encodeURIComponent(rid)}/${dir}/${date}">${t("timetable")}</a>` : ""}
      </div>
      ${isToday ? `<p class="pad small live" id="liveInfo"></p>` : ""}
      ${body}`;

    $("#dateSel").onchange = (e) => go(`#/route/${encodeURIComponent(rid)}/${tripSel ? tripSel.tr[0] : dir}/${e.target.value}`);
    view().querySelectorAll("[data-dir]").forEach((b) => (b.onclick = () => go(`#/route/${encodeURIComponent(rid)}/${b.dataset.dir}/${date}`)));
    view().querySelectorAll("[data-trip]").forEach((r) => (r.onclick = () => go(`#/route/${encodeURIComponent(rid)}/${r.dataset.trip}/${date}`)));
    view().querySelectorAll("[data-stop]").forEach((li) => (li.onclick = () => go(`#/stop/${encodeURIComponent(li.dataset.stop)}/${date}`)));

    // posición estimada de los buses en ruta (según horario)
    if (isToday) {
      const allToday = [];
      for (const p of R.patterns) for (const tr of p.trips) {
        if (runs(tr[1])) allToday.push({ p, tr, off: 0 });
        if (tr[2][tr[2].length - 1] >= 1440 && svcActive(tr[1], prev)) allToday.push({ p, tr, off: -1440 });
      }
      const tick = () => {
        busLayer.clearLayers();
        const d = new Date();
        const nm = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
        let n = 0;
        for (const { p, tr, off } of allToday) {
          if (tripSel && tr !== tripSel.tr) continue;
          const ts = tr[2].map((x) => x + off);
          if (nm < ts[0] || nm > ts[ts.length - 1]) continue;
          let i = 0; while (i < ts.length - 2 && nm > ts[i + 1]) i++;
          const a = S.stopById.get(p.stops[i]), b = S.stopById.get(p.stops[i + 1]);
          if (!a || !b) continue;
          const f = ts[i + 1] > ts[i] ? (nm - ts[i]) / (ts[i + 1] - ts[i]) : 0;
          const pos = [a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
          n++;
          L.marker(pos, { icon: L.divIcon({ className: "", html: '<div class="bus-icon">🚌</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) })
            .bindTooltip(`${esc(ri.code)} → ${esc(stopName(p.stops[p.stops.length - 1]))}<br>${t("estPos")}`)
            .on("click", () => go(`#/route/${encodeURIComponent(rid)}/${tr[0]}/${date}`))
            .addTo(busLayer);
        }
        const li = $("#liveInfo");
        if (li) li.textContent = n ? t("liveEst", { n }) : t("noLive");
      };
      tick();
      liveTimer = setInterval(tick, 15000);
    }
  }

  // ---------- planificador A → B (directo) ----------
  const plan = { from: null, to: null, date: null };
  function stopPicker(id, label, val) {
    const s = val && S.stopById.get(val);
    return `<div class="field"><label for="${id}">${label}</label>
      <input id="${id}" type="search" autocomplete="off" placeholder="${t("pickStop")}" value="${s ? esc(s[1]) : ""}">
      <ul class="suggest" hidden></ul></div>`;
  }
  function renderPlan(from, to) {
    if (from) plan.from = from;
    if (to) plan.to = to;
    plan.date = plan.date || todayIso();
    view().innerHTML = `
      <p class="pad small muted">${t("planHint")}</p>
      ${stopPicker("pFrom", t("from"), plan.from)}
      ${stopPicker("pTo", t("toStop"), plan.to)}
      <div class="row-ctrl">
        <input type="date" id="pDate" value="${plan.date}" min="${S.meta.base}">
        <button class="btn ghost" id="pSwap">⇅ ${t("swap")}</button>
        <button class="btn" id="pGo">${t("search")}</button>
      </div>
      <div id="pRes"></div>`;
    for (const [id, key] of [["pFrom", "from"], ["pTo", "to"]]) {
      const inp = $("#" + id), sug = inp.nextElementSibling;
      inp.oninput = () => {
        const n = norm(inp.value.trim());
        if (n.length < 2) { sug.hidden = true; return; }
        const w = n.split(/\s+/);
        const res = S.stops.filter((s) => { const x = norm(s[1]); return w.every((q) => x.includes(q)); }).slice(0, 15);
        sug.innerHTML = res.map((s) => `<li data-id="${esc(s[0])}">${esc(s[1])}<div class="small muted">${esc(s[4].slice(0, 5).map((r) => routeInfo(r).code).join(" · "))}</div></li>`).join("");
        sug.hidden = !res.length;
      };
      sug.onclick = (e) => {
        const li = e.target.closest("li"); if (!li) return;
        plan[key] = li.dataset.id; inp.value = stopName(li.dataset.id); sug.hidden = true;
        const s = S.stopById.get(li.dataset.id); if (s) panToStop(s);
      };
      inp.onblur = () => setTimeout(() => (sug.hidden = true), 200);
    }
    $("#pDate").onchange = (e) => (plan.date = e.target.value);
    $("#pSwap").onclick = () => { [plan.from, plan.to] = [plan.to, plan.from]; renderPlan(); };
    $("#pGo").onclick = runPlan;
    if (plan.from && plan.to) runPlan();
  }
  async function runPlan() {
    const out = $("#pRes");
    if (!plan.from || !plan.to) return;
    out.innerHTML = `<p class="pad muted">${t("loading")}</p>`;
    const A = S.stopById.get(plan.from), B = S.stopById.get(plan.to);
    const common = A[4].filter((r) => B[4].includes(r));
    const date = plan.date, prev = prevDay(date), isToday = date === todayIso(), now = nowMin();
    const res = [];
    await Promise.all(common.map(async (rid) => {
      const R = await getJSON(`data/route/${encodeURIComponent(rid)}.json`);
      for (const p of R.patterns) {
        const ia = p.stops.indexOf(plan.from);
        const ib = ia < 0 ? -1 : p.stops.indexOf(plan.to, ia + 1);
        if (ia < 0 || ib < 0) continue;
        for (const tr of p.trips) {
          for (const [ok, off] of [[svcActive(tr[1], date), 0], [tr[2][ia] >= 1440 && svcActive(tr[1], prev), -1440]]) {
            if (ok) res.push({ rid, tid: tr[0], a: tr[2][ia] + off, b: tr[2][ib] + off, dest: p.stops[p.stops.length - 1] });
          }
        }
      }
    }));
    res.sort((x, y) => x.a - y.a);
    // dibuja origen y destino
    routeLayer.clearLayers();
    for (const s of [A, B]) L.circleMarker([s[2], s[3]], { radius: 10, color: "#d9480f", weight: 4, fill: false }).addTo(routeLayer);
    fitTo(L.latLngBounds([[A[2], A[3]], [B[2], B[3]]]));
    if (!res.length) { out.innerHTML = `<p class="pad muted">${t("noDirect")}</p>`; return; }
    out.innerHTML = `<ul class="list">${res.map((r) => {
      const ri = routeInfo(r.rid);
      const past = isToday && r.a < now;
      return `<li${past ? ' style="opacity:.5"' : ""}><a href="#/route/${encodeURIComponent(r.rid)}/${encodeURIComponent(r.tid)}/${date}">${badge(ri)}
        <div class="t"><b>${fmt(r.a)} → ${fmt(r.b)}</b><span>${r.b - r.a} min · ${t("to")} ${esc(stopName(r.dest))}</span></div></a></li>`;
    }).join("")}</ul>`;
    if (isToday) {
      const next = out.querySelectorAll("li")[res.findIndex((r) => r.a >= now)];
      if (next) next.scrollIntoView({ block: "nearest" });
    }
  }

  // ---------- eventos globales ----------
  document.addEventListener("click", (e) => {
    const fav = e.target.closest("[data-fav]");
    if (fav) { const [k, id] = fav.dataset.fav.split(/:(.*)/s); toggleFav(k, id); route(); return; }
    const ag = e.target.closest("[data-agency]");
    if (ag) { e.preventDefault(); setAgency(ag.dataset.agency || null); return; }
    if (e.target.closest("[data-back]")) { history.length > 1 ? history.back() : go("#/"); return; }
    const dt = e.target.closest("[data-date]");
    if (dt) { go(location.hash.split("/").filter((x) => !/^\d{4}-\d\d-\d\d$/.test(x)).join("/")); }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "agencySel") setAgency(e.target.value || null);
  });
  function setAgency(a) {
    S.agency = a; store.set("operator", a);
    const q = $("#q").value.trim();
    if (q) renderSearch(q); else renderHome();
    drawStops();
  }
  let qTimer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const q = e.target.value;
      expandSheet(true);
      history.replaceState(null, "", q.trim() ? `#/search/${encodeURIComponent(q)}` : "#/");
      clearRouteLayers(); selectStopMarker(null);
      setTab(q.trim() ? "" : "home");
      q.trim() ? renderSearch(q) : renderHome();
      drawStops();
    }, 150);
  });
  $("#btnTheme").onclick = () => {
    const d = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = d;
    try { localStorage.setItem("theme", d); } catch {}
    drawStops();
  };
  $("#btnLang").onclick = () => { S.lang = S.lang === "es" ? "ca" : "es"; store.set("lang", S.lang); applyLang(); route(); };
  function setMe(lat, lon, zoom = 15) {
    S.me = [lat, lon];
    if (meMarker) map.removeLayer(meMarker);
    meMarker = L.marker(S.me, { icon: L.divIcon({ className: "", html: '<div class="me-icon"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false }).addTo(map);
    map.setView(S.me, Math.max(map.getZoom(), zoom));
    go("#/");
  }
  // si el navegador no da la ubicación, el usuario puede tocar el mapa
  function pickOnMap(msg) {
    alert(`${msg}\n\n${t("geoPick")}`);
    map.getContainer().style.cursor = "crosshair";
    map.once("click", (e) => { map.getContainer().style.cursor = ""; setMe(e.latlng.lat, e.latlng.lng, map.getZoom()); });
  }
  $("#btnLocate").onclick = () => {
    const btn = $("#btnLocate");
    if (!navigator.geolocation || !window.isSecureContext) return pickOnMap(t("geoUnsupported"));
    btn.disabled = true; btn.textContent = "…";
    const done = () => { btn.disabled = false; btn.textContent = "◎"; };
    const ok = (p) => { done(); setMe(p.coords.latitude, p.coords.longitude); };
    const fail = (err) => {
      done();
      if (err.code === 1) alert(t("geoDenied"));
      else pickOnMap(t(err.code === 3 ? "geoTimeout" : "geoUnavailable"));
    };
    // 1º aproximada (wifi/red, rápida); si falla, reintento con GPS
    navigator.geolocation.getCurrentPosition(ok, (err) => {
      if (err.code === 1) return fail(err);
      navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  };
  const panel = $("#panel");
  // ---------- panel inferior arrastrable (móvil) ----------
  const SNAPS = ["collapsed", "mid", "expanded"];
  const sheetState = () => (panel.classList.contains("expanded") ? "expanded" : panel.classList.contains("collapsed") ? "collapsed" : "mid");
  function setSheet(st) {
    panel.classList.remove("expanded", "collapsed", "dragging");
    panel.style.height = "";
    if (st !== "mid") panel.classList.add(st);
  }
  function snapHeights() {
    const H = panel.parentElement.clientHeight;
    return { collapsed: 84, mid: H * 0.46, expanded: H * 0.88 };
  }
  function expandSheet(force) {
    if (!isMobile()) return;
    if (force === true) return setSheet("expanded");
    if (force === "open") { if (sheetState() === "collapsed") setSheet("mid"); return; }
    setSheet(sheetState() === "expanded" ? "mid" : "expanded");
  }
  let drag = null;
  function dragStart(y) {
    drag = { y0: y, h0: panel.getBoundingClientRect().height, moved: false, samples: [[y, performance.now()]] };
  }
  function dragMove(y) {
    if (!drag) return false;
    const dy = y - drag.y0;
    if (!drag.moved && Math.abs(dy) < 6) return false;
    drag.moved = true;
    panel.classList.add("dragging");
    const sh = snapHeights();
    panel.style.height = `${Math.max(sh.collapsed, Math.min(sh.expanded + 20, drag.h0 - dy))}px`;
    drag.samples.push([y, performance.now()]);
    if (drag.samples.length > 5) drag.samples.shift();
    return true;
  }
  function dragEnd() {
    if (!drag) return false;
    const d = drag; drag = null;
    if (!d.moved) return false;
    const [y1, t1] = d.samples[0], [y2, t2] = d.samples[d.samples.length - 1];
    const v = (y2 - y1) / Math.max(1, t2 - t1); // px/ms, + = hacia abajo
    const h = panel.getBoundingClientRect().height;
    const sh = snapHeights();
    let st;
    if (Math.abs(v) > 0.45) {
      const order = SNAPS.slice().sort((a, b) => sh[a] - sh[b]);
      const cur = order.reduce((best, k) => (Math.abs(sh[k] - h) < Math.abs(sh[best] - h) ? k : best), order[0]);
      let i = order.indexOf(cur);
      if (v < 0 && sh[cur] <= h) i++;
      if (v > 0 && sh[cur] >= h) i--;
      st = order[Math.max(0, Math.min(order.length - 1, i))];
    } else {
      st = SNAPS.reduce((best, k) => (Math.abs(sh[k] - h) < Math.abs(sh[best] - h) ? k : best), "mid");
    }
    setSheet(st);
    setTimeout(() => map.invalidateSize(), 300);
    return true;
  }
  // asa y pestañas: arrastrar con cualquier puntero
  let suppressClick = false;
  for (const el of [$("#sheetHandle"), $(".tabs")]) {
    el.addEventListener("pointerdown", (e) => { suppressClick = false; if (isMobile()) dragStart(e.clientY); });
    // capturamos el puntero solo cuando empieza a arrastrar, para no romper los toques en las pestañas
    el.addEventListener("pointermove", (e) => { if (dragMove(e.clientY) && !el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointerup", () => {
      if (dragEnd()) suppressClick = true;
      else if (el.id === "sheetHandle") expandSheet(); // toque en el asa
    });
    el.addEventListener("pointercancel", () => dragEnd());
    el.addEventListener("click", (e) => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; } }, true);
  }
  // contenido: si estás arriba del todo, deslizar hacia abajo baja el panel
  const viewEl = $("#view");
  viewEl.addEventListener("touchstart", (e) => {
    if (isMobile() && viewEl.scrollTop <= 0) dragStart(e.touches[0].clientY);
  }, { passive: true });
  viewEl.addEventListener("touchmove", (e) => {
    if (!drag) return;
    const dy = e.touches[0].clientY - drag.y0;
    if (!drag.moved && dy < 0) { drag = null; return; } // hacia arriba = scroll normal
    if (dragMove(e.touches[0].clientY)) e.preventDefault();
  }, { passive: false });
  viewEl.addEventListener("touchend", dragEnd);
  viewEl.addEventListener("touchcancel", dragEnd);

  function applyLang() {
    document.documentElement.lang = S.lang;
    $("#btnLang").textContent = S.lang === "es" ? "CA" : "ES";
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    document.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
    if (S.meta) $("#foot").textContent = t("attribution", { d: new Date(S.meta.generated).toLocaleDateString(S.lang) });
  }

  // ---------- arranque ----------
  async function boot() {
    applyLang();
    initMap();
    const [meta, stops] = await Promise.all([getJSON("data/meta.json"), getJSON("data/stops.json")]);
    S.meta = meta; S.stops = stops;
    for (const s of stops) S.stopById.set(s[0], s);
    if (S.agency && !meta.agencies[S.agency]) S.agency = null;
    applyLang();
    await route();
  }
  boot().catch((e) => { console.error(e); view().innerHTML = `<p class="pad">Error: ${esc(e.message)}</p>`; });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
