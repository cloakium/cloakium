import assert from "node:assert/strict";

async function storageSnapshot(page) {
  return await page.evaluate(() => ({
    cookie: document.cookie,
    local: localStorage.getItem("parity"),
    session: sessionStorage.getItem("parity"),
  }));
}

export const probes = [
  {
    name: "storage/cookies-and-tab-isolation",
    async run({ browser, context, origin }) {
      await context.addCookies([
        { name: "visible", value: "cookie", url: origin },
        { name: "private", value: "hidden", httpOnly: true, url: origin },
      ]);
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(() => {
        localStorage.setItem("parity", "persistent");
        sessionStorage.setItem("parity", "this-tab");
      });
      const initial = await storageSnapshot(page);
      assert.deepEqual(initial, { cookie: "visible=cookie", local: "persistent", session: "this-tab" });
      const second = await context.newPage();
      await second.goto(origin);
      const otherTab = await storageSnapshot(second);
      assert.deepEqual(otherTab, { cookie: "visible=cookie", local: "persistent", session: null });
      const isolated = await browser.newContext();
      let isolatedState;
      try {
        const other = await isolated.newPage();
        await other.goto(origin);
        isolatedState = await storageSnapshot(other);
        assert.deepEqual(isolatedState, { cookie: "", local: null, session: null });
      } finally { await isolated.close(); }
      const cookies = (await context.cookies()).map(({ name, httpOnly }) => ({ name, httpOnly }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { initial, otherTab, isolated: isolatedState, cookies };
    },
  },
  {
    name: "storage/indexeddb-and-cache",
    async run({ context, origin }) {
      const page = await context.newPage();
      await page.goto(origin);
      const result = await page.evaluate(async () => {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open("parity-database", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("values");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        let record;
        try {
          await new Promise((resolve, reject) => {
            const transaction = database.transaction("values", "readwrite");
            transaction.objectStore("values").put({ message: "stored", count: 42 }, "sample");
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
          record = await new Promise((resolve, reject) => {
            const request = database.transaction("values").objectStore("values").get("sample");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        } finally { database.close(); }
        const cache = await caches.open("parity-cache");
        await cache.put("/cached-resource", new Response("cached locally"));
        const cached = await (await cache.match("/cached-resource")).text();
        return { record, cached, keys: await caches.keys() };
      });
      assert.deepEqual(result, {
        record: { message: "stored", count: 42 }, cached: "cached locally", keys: ["parity-cache"],
      });
      return result;
    },
  },
  {
    name: "storage/service-worker-fetch",
    async run({ context, origin }) {
      const page = await context.newPage();
      await page.goto(origin);
      const workerEvent = context.waitForEvent("serviceworker");
      await page.evaluate(() => navigator.serviceWorker.register("/service-worker.js"));
      const worker = await workerEvent;
      assert.ok(worker.url().endsWith("/service-worker.js"));
      const result = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
          await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
        const text = await (await fetch("/service-worker-resource")).text();
        const result = { state: registration.active.state, controlled: Boolean(navigator.serviceWorker.controller), text };
        await registration.unregister();
        return result;
      });
      assert.deepEqual(result, { state: "activated", controlled: true, text: "service-worker-intercepted" });
      return result;
    },
  },
];
