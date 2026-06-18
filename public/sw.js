const VERSION = "v7";
const CACHE_NAME = `pedro-visualizer-${VERSION}`;

const APP_STATIC_RESOURCES = [
  "./",
  "./favicon.ico",
  "./fields/centerstage.webp",
  "./fields/intothedeep.webp",
  "./fields/decode.webp",
  "./robot.png",
  "./assets/index.js",
  "./assets/index.css",
  "./fonts/Poppins-Regular.ttf",
  "./fonts/Poppins-SemiBold.ttf",
  "./fonts/Poppins-Light.ttf",
  "./fonts/Poppins-ExtraLight.ttf",
];

// On install, cache the static resources and activate this worker immediately.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_STATIC_RESOURCES);
      await self.skipWaiting();
    })(),
  );
});

// Delete old caches on activate and take over existing tabs.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
          return undefined;
        }),
      );
      await clients.claim();

      const windowClients = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      await Promise.all(
        windowClients.map((client) => {
          if ("navigate" in client) {
            return client.navigate(client.url);
          }
          return undefined;
        }),
      );
    })(),
  );
});

// Prefer fresh network responses; use cache only as a fallback.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      try {
        const networkResponse = await fetch(event.request);
        if (networkResponse.ok) {
          await cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      } catch (error) {
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) return cachedResponse;

        if (event.request.mode === "navigate") {
          const appShell = await cache.match("./");
          if (appShell) return appShell;
        }

        return new Response(null, { status: 404 });
      }
    })(),
  );
});
