// Service worker: app offline + datos visitados disponibles sin conexión
const VERSION = "v2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "i18n.js", "icon.svg", "manifest.webmanifest",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open("shell-" + VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(
    ks.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // teselas del mapa: caché primero (limitada por el navegador)
  if (url.hostname === "tile.openstreetmap.org") {
    e.respondWith(caches.open("tiles-" + VERSION).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  // app y datos: red primero, caché si no hay conexión
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && (url.origin === location.origin || url.hostname === "cdnjs.cloudflare.com")) {
      const copy = r.clone();
      caches.open((url.pathname.includes("/data/") ? "data-" : "shell-") + VERSION).then((c) => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request)));
});
