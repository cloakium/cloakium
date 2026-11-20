// Page-side storage operations.
//
// All values are dummy lab canaries. Reads return presence/match booleans and a
// length, never the stored string, so reports stay metadata-only.

export async function writeCanary(page, spec) {
  return page.evaluate(async ({ localKey, localValue, dbName, store, recordKey, recordValue }) => {
    localStorage.setItem(localKey, localValue);
    const indexedDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      };
      request.onerror = () => reject(request.error ?? new Error('open failed'));
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(store, 'readwrite');
        transaction.objectStore(store).put(recordValue, recordKey);
        transaction.oncomplete = () => {
          db.close();
          resolve(true);
        };
        transaction.onerror = () => reject(transaction.error ?? new Error('transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
      };
    });
    return { localStorage: localStorage.getItem(localKey) === localValue, indexedDb };
  }, spec);
}

export async function readCanary(page, spec) {
  return page.evaluate(async ({ localKey, localValue, dbName, store, recordKey, recordValue }) => {
    const local = localStorage.getItem(localKey);
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : null;
    const known = databases ? databases.some((entry) => entry.name === dbName) : null;

    const readRecord = () =>
      new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        let request;
        try {
          request = indexedDB.open(dbName);
        } catch {
          done({ status: 'error' });
          return;
        }
        request.onupgradeneeded = () => {
          // The database did not exist; abort so the read does not create it.
          try {
            request.transaction.abort();
          } catch {
            /* already aborting */
          }
          done({ status: 'missing' });
        };
        request.onerror = () => done({ status: 'error' });
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            done({ status: 'missing-store' });
            return;
          }
          let transaction;
          try {
            transaction = db.transaction(store, 'readonly');
          } catch {
            db.close();
            done({ status: 'missing-store' });
            return;
          }
          const get = transaction.objectStore(store).get(recordKey);
          get.onsuccess = () => done({ status: 'found', value: get.result });
          get.onerror = () => done({ status: 'error' });
          transaction.oncomplete = () => db.close();
        };
      });

    const record = known === false ? { status: 'missing' } : await readRecord();
    return {
      local: {
        present: typeof local === 'string',
        matches: local === localValue,
        length: typeof local === 'string' ? local.length : 0
      },
      indexedDb: {
        status: record.status,
        matches: record.status === 'found' ? record.value === recordValue : false,
        databasesKnown: known
      },
      origin: location.origin
    };
  }, spec);
}

// localStorage keys and IndexedDB database names, for isolation reports.
export async function storageInventory(page) {
  return page.evaluate(async () => {
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : null;
    return {
      origin: location.origin,
      localStorageKeys: Object.keys(localStorage).sort(),
      databases: databases ? databases.map((entry) => entry.name).sort() : null
    };
  });
}

export async function clearStorage(page, { dbName }) {
  return page.evaluate(
    async ({ dbName: name }) => {
      localStorage.clear();
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
        request.onblocked = () => resolve(false);
      });
      return true;
    },
    { dbName }
  );
}

// Chrome's own command line, used to confirm the harness arguments reached the
// engine. Only flag names are extracted by callers.
export async function readChromeVersion(page, timeoutMs = 5000) {
  await page.goto('chrome://version', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const text = await page.locator('body').innerText({ timeout: timeoutMs });
  return text;
}
