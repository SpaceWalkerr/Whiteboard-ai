/**
 * Keys of private boards opened on this device (IndexedDB), so the dashboard can show
 * their titles and reopen them without the link. Wiped on sign-out, like the offline board
 * copies — the dashboard warns first, since the links are then the only way back in.
 *
 * Kept outside the "whiteboard:board:" databases on purpose: losing access to one board
 * (which wipes its local copy) must not silently delete the key too.
 */
export const KEYRING_DB = "whiteboard:keys";
const STORE = "keys";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEYRING_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("keyring unavailable"));
    };
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => {
        resolve(request.result as T);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("keyring request failed"));
      };
    });
  } finally {
    db.close();
  }
}

/** Best effort: without IndexedDB (private browsing), keys simply aren't remembered. */
export async function rememberKey(boardId: string, encodedKey: string): Promise<void> {
  try {
    await run("readwrite", (store) => store.put(encodedKey, boardId));
  } catch {
    // Not remembered; the link still works.
  }
}

export async function keyFor(boardId: string): Promise<string | null> {
  try {
    const value = await run<unknown>("readonly", (store) => store.get(boardId));
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function forgetKey(boardId: string): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(boardId));
  } catch {
    // ignore
  }
}

export async function rememberedKeyCount(): Promise<number> {
  try {
    return await run<number>("readonly", (store) => store.count());
  } catch {
    return 0;
  }
}
