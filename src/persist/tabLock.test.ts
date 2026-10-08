import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cubeMesh, makeModel } from "../../test/support/docFixtures";
import { createProject } from "../doc/project";
import { restoreProject, type SnapshotStore } from "../doc/snapshot";
import { restoreSession } from "./session";
import { requestPersistentStorage, resetPersistentStorageRequest } from "./storage";
import { createTabLock, type LockManagerLike } from "./tabLock";

/** A lock manager shared by "tabs": the first request with ifAvailable gets the lock and never lets go. */
function fakeLocks(): LockManagerLike {
  let held = false;
  return {
    async request(_name, _options, callback) {
      if (held) return callback(null);
      held = true;
      return callback({});
    },
  };
}

describe("tab lock", () => {
  it("the first tab holds the lock and later tabs find it taken", async () => {
    const locks = fakeLocks();
    expect(await createTabLock(locks)()).toBe("held");
    expect(await createTabLock(locks)()).toBe("other");
    expect(await createTabLock(locks)()).toBe("other");
  });

  it("asks once per page: later calls get the same answer", async () => {
    const locks = fakeLocks();
    const request = vi.spyOn(locks, "request");
    const acquire = createTabLock(locks);
    expect(await acquire()).toBe("held");
    expect(await acquire()).toBe("held");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("passes the name and ifAvailable, and keeps the lock for the page's lifetime", async () => {
    let settled = false;
    const manager: LockManagerLike = {
      request: (name, options, callback) => {
        expect(name).toBe("paintportplus");
        expect(options).toEqual({ ifAvailable: true });
        const held = callback({});
        held?.then(() => { settled = true; }, () => { settled = true; });
        return Promise.resolve();
      },
    };
    expect(await createTabLock(manager)()).toBe("held");
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  });

  it("falls back without Web Locks, or when the browser refuses", async () => {
    expect(await createTabLock(undefined)()).toBe("unsupported");
    expect(await createTabLock(null)()).toBe("unsupported");
    expect(await createTabLock({ request: () => { throw new DOMException("opaque", "SecurityError"); } })()).toBe("unsupported");
    expect(await createTabLock({ request: () => Promise.reject(new Error("no")) })()).toBe("unsupported");
  });
});

describe("restoreSession timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hanging = (): SnapshotStore => ({
    loadGeometry: () => new Promise(() => {}),
    loadPaint: () => new Promise(() => {}),
    saveBoth: () => new Promise(() => {}),
    savePaint: () => new Promise(() => {}),
    clear: () => new Promise(() => {}),
  });

  it("gives up on a store that never answers", async () => {
    const result = restoreSession(hanging(), 8000);
    await vi.advanceTimersByTimeAsync(7999);
    let done = false;
    void result.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await result).toEqual({ status: "unavailable" });
  });

  it("does not wait when the store answers", async () => {
    const empty: SnapshotStore = { ...hanging(), loadGeometry: async () => null, loadPaint: async () => null };
    expect(await restoreSession(empty)).toEqual({ status: "empty" });
    expect(vi.getTimerCount()).toBe(0); // the timeout is cleared
  });

  it("restores normally within the time limit", async () => {
    const p = createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }] }));
    let g: unknown = null, pa: unknown = null;
    const store: SnapshotStore = {
      ...hanging(),
      loadGeometry: async () => g, loadPaint: async () => pa,
      saveBoth: async (a, b) => { g = a; pa = b; },
    };
    await store.saveBoth(await import("../doc/snapshot").then((m) => m.toGeometrySnapshot(p)), await import("../doc/snapshot").then((m) => m.toPaintSnapshot(p)));
    const r = await restoreSession(store);
    expect(r.status).toBe("restored");
    expect((await restoreProject(store)).status).toBe("restored");
  });
});

describe("requestPersistentStorage", () => {
  beforeEach(() => resetPersistentStorageRequest());

  it("asks the browser once", async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorage({ persist })).toBe(true);
    expect(await requestPersistentStorage({ persist })).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("never throws: missing API, a refusal or an error all just say no", async () => {
    expect(await requestPersistentStorage(undefined)).toBe(false);
    resetPersistentStorageRequest();
    expect(await requestPersistentStorage({})).toBe(false);
    resetPersistentStorageRequest();
    expect(await requestPersistentStorage({ persist: async () => false })).toBe(false);
    resetPersistentStorageRequest();
    expect(await requestPersistentStorage({ persist: () => Promise.reject(new Error("denied")) })).toBe(false);
  });
});
