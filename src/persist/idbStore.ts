// IndexedDB implementation of the document's SnapshotStore (src/doc/snapshot.ts).
//
// One database, one object store, three records: "geometry" (written once per project), "paint"
// (rewritten on every autosave) and a small "meta" record naming the project the geometry
// belongs to. `savePaint` checks it inside its own transaction, so a tab that still holds an
// older project can never write its paint next to another tab's geometry (reading the meta
// record is cheap; reading the geometry on every save would not be). Every IndexedDB call is wrapped so that a browser
// that refuses (private mode, blocked or cleared storage, quota) surfaces as a rejected
// promise with a real Error, never as an uncaught exception or a promise that never settles.
// The callers decide what a failure means (see session.ts and autosave.ts).
import type { GeometrySnapshot, PaintSnapshot, SnapshotStore } from "../doc/snapshot";

export const DB_NAME = "paintportplus";
/** Version of the database layout (object stores), not of the snapshot format. */
export const DB_VERSION = 1;
const STORE = "snapshots";
const GEOMETRY_KEY = "geometry";
const PAINT_KEY = "paint";
const META_KEY = "meta";

/** The stored project is not the one being saved: another tab replaced it. Autosave must stop rather than overwrite or mix. */
export class StoreConflictError extends Error {
  constructor() {
    super("The saved project was replaced by another tab");
    this.name = "StoreConflictError";
  }
}

interface Meta {
  projectId: string;
  geometryHash: string;
}
const metaOf = (g: GeometrySnapshot): Meta => ({ projectId: g.projectId, geometryHash: g.geometryHash });

const asError = (e: unknown, fallback: string): Error => {
  if (e instanceof Error) return e;
  if (typeof e === "object" && e !== null && "name" in e) {
    // A DOMException from another realm, say.
    return Object.assign(new Error(String((e as { message?: unknown }).message ?? fallback)), { name: String((e as { name: unknown }).name) });
  }
  return new Error(fallback);
};

/**
 * @param factory the IndexedDB factory to use. Defaults to the global one; pass null to
 *   model a browser without IndexedDB (every call then rejects).
 */
export function createIdbSnapshotStore(factory?: IDBFactory | null): SnapshotStore {
  let connection: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (connection) return connection;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (e: unknown) => {
        settled = true;
        reject(asError(e, "IndexedDB could not be opened"));
      };
      let request: IDBOpenDBRequest;
      try {
        const idb = factory === undefined ? globalThis.indexedDB : factory;
        if (!idb) throw new Error("IndexedDB is not available");
        request = idb.open(DB_NAME, DB_VERSION);
      } catch (e) {
        fail(e); // e.g. SecurityError when storage is blocked
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close(); // reported as blocked earlier, and the open finished anyway: do not keep a connection nobody uses
          return;
        }
        settled = true;
        // Another tab upgrades the database, or the browser drops the connection (storage cleared): reconnect next time.
        db.onversionchange = () => {
          db.close();
          connection = null;
        };
        db.onclose = () => {
          connection = null;
        };
        resolve(db);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error("IndexedDB is blocked by another tab"));
    });
    connection = attempt;
    // A failed open is retried by the next call.
    attempt.catch(() => {
      if (connection === attempt) connection = null;
    });
    return attempt;
  };

  /** Runs one transaction; resolves with the request's result once the transaction has committed. */
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let result: T;
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        request.onsuccess = () => {
          result = request.result;
        };
      } catch (e) {
        connection = null; // e.g. InvalidStateError on a connection that is closing; DataCloneError for unclonable data
        reject(asError(e, "IndexedDB request failed"));
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(asError(tx.error, "IndexedDB transaction was aborted")); // QuotaExceededError arrives here
    });
  };

  /**
   * Writes the paint record only if the stored geometry belongs to the same project, checked in
   * the same readwrite transaction: otherwise the transaction aborts and the call rejects with a
   * StoreConflictError.
   */
  const savePaintChecked = async (paint: PaintSnapshot): Promise<void> => {
    const db = await open();
    return new Promise<void>((resolve, reject) => {
      let failure: Error | null = null;
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const proceed = (stored: unknown) => {
          const same = typeof stored === "object" && stored !== null
            && (stored as Partial<Meta>).projectId === paint.projectId && (stored as Partial<Meta>).geometryHash === paint.geometryHash;
          if (!same) {
            failure = new StoreConflictError();
            tx.abort();
            return;
          }
          try {
            store.put(paint, PAINT_KEY);
          } catch (e) {
            failure = asError(e, "IndexedDB request failed");
            tx.abort();
          }
        };
        const metaRequest = store.get(META_KEY);
        metaRequest.onsuccess = () => {
          if (metaRequest.result !== undefined) return proceed(metaRequest.result);
          // A database written before the meta record existed: take the identity from the geometry itself,
          // and store the meta record so later saves don't read the geometry again.
          const geometryRequest = store.get(GEOMETRY_KEY);
          geometryRequest.onsuccess = () => {
            const geometry = geometryRequest.result as GeometrySnapshot | undefined;
            proceed(geometry);
            if (!failure && geometry) store.put(metaOf(geometry), META_KEY);
          };
        };
      } catch (e) {
        connection = null;
        reject(asError(e, "IndexedDB request failed"));
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? asError(tx.error, "IndexedDB transaction was aborted"));
    });
  };

  const load = async (key: string): Promise<unknown | null> => (await run("readonly", (s) => s.get(key))) ?? null;
  const saveBoth = async (geometry: GeometrySnapshot, paint: PaintSnapshot): Promise<void> => {
    // One transaction, so a cut-off or a quota failure leaves the previous project, not a mix.
    await run("readwrite", (s) => {
      s.put(geometry, GEOMETRY_KEY);
      s.put(metaOf(geometry), META_KEY);
      return s.put(paint, PAINT_KEY);
    });
  };

  return {
    loadGeometry: () => load(GEOMETRY_KEY),
    loadPaint: () => load(PAINT_KEY),
    saveBoth,
    savePaint: savePaintChecked,
    clear: async () => {
      await run("readwrite", (s) => s.clear());
    },
  };
}
