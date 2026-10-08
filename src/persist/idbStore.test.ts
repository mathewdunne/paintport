import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cubeMesh, joinMeshes, leaf, makeModel, split2, stripMesh, tree } from "../../test/support/docFixtures";
import { createProject, type Project } from "../doc/project";
import { ProjectSaver, restoreProject, toGeometrySnapshot, toPaintSnapshot, toSnapshot } from "../doc/snapshot";
import { createIdbSnapshotStore, DB_NAME, StoreConflictError } from "./idbStore";
import { restoreSession } from "./session";

function project(): Project {
  const model = makeModel(joinMeshes(cubeMesh(), stripMesh([15, 30])), {
    dialect: "prusa",
    filaments: [{ color: "#FF0000" }, { color: "#00FF00" }],
    parts: [
      { firstTri: 0, triCount: 12, extruder: 1, type: "ModelPart", name: "Body" },
      { firstTri: 12, triCount: 6, extruder: 2, type: "ModelPart", name: null },
    ],
    paints: [leaf(2, "prusa"), tree(split2(1, 2), "prusa")],
  });
  const p = createProject(model);
  p.addColor("#0000FF");
  return p;
}

/** Wraps a factory so that the `n`th open() fails. */
function failingOpen(real: IDBFactory, failures: (() => unknown)[]): IDBFactory {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "open") {
        return (...args: Parameters<IDBFactory["open"]>) => {
          const fail = failures.shift();
          if (fail) return fail();
          return target.open(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** An open request the test completes by hand: only the handlers the store sets. */
const fakeOpenRequest = () => ({}) as { onerror?: (e: Event) => void; onblocked?: (e: Event) => void };

afterEach(() => vi.restoreAllMocks());

describe("IndexedDB snapshot store", () => {
  it("reports an empty database", async () => {
    const store = createIdbSnapshotStore(new IDBFactory());
    expect(await store.loadGeometry()).toBeNull();
    expect(await store.loadPaint()).toBeNull();
    expect(await restoreSession(store)).toEqual({ status: "empty" });
  });

  it("round-trips a project with typed arrays intact, and saves the two halves separately", async () => {
    const factory = new IDBFactory();
    const store = createIdbSnapshotStore(factory);
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);

    // A fresh connection (a page reload) sees it.
    const reloaded = await restoreSession(createIdbSnapshotStore(factory));
    expect(reloaded.status).toBe("restored");
    if (reloaded.status !== "restored") return;
    expect(toSnapshot(reloaded.project)).toEqual(toSnapshot(p));
    const geometry = (await createIdbSnapshotStore(factory).loadGeometry()) as { objects: { vertices: unknown; tris: unknown }[] };
    expect(geometry.objects[0].vertices).toBeInstanceOf(Float64Array);
    expect(geometry.objects[0].tris).toBeInstanceOf(Int32Array);

    // Later saves rewrite only the paint record.
    const geometryBefore = await store.loadGeometry();
    p.paintTriangles(0, [3, 4], 3);
    await saver.save(p);
    expect(await store.loadGeometry()).toEqual(geometryBefore);
    const r = await restoreProject(store);
    expect(r.status === "restored" && Array.from(r.project.fields[0].displayStates())).toEqual(Array.from(p.fields[0].displayStates()));
  });

  it("clear removes both records", async () => {
    const store = createIdbSnapshotStore(new IDBFactory());
    await new ProjectSaver(store).save(project());
    await store.clear();
    expect(await store.loadGeometry()).toBeNull();
    expect(await store.loadPaint()).toBeNull();
  });

  it("uses one database called paintportplus", async () => {
    const factory = new IDBFactory();
    await createIdbSnapshotStore(factory).clear();
    expect((await factory.databases()).map((d) => d.name)).toEqual([DB_NAME]);
    expect(DB_NAME).toBe("paintportplus");
  });

  describe("when the browser refuses", () => {
    it("rejects every call without IndexedDB", async () => {
      const store = createIdbSnapshotStore(null);
      await expect(store.loadGeometry()).rejects.toThrow(/not available/);
      await expect(store.savePaint(toPaintSnapshot(project()))).rejects.toThrow();
      await expect(store.clear()).rejects.toThrow();
      expect(await restoreSession(store)).toEqual({ status: "unavailable" });
    });

    it("turns a throwing open() (private mode, blocked storage) into a rejection, and retries later", async () => {
      const real = new IDBFactory();
      const factory = failingOpen(real, [() => { throw new DOMException("denied", "SecurityError"); }]);
      const store = createIdbSnapshotStore(factory);
      await expect(store.loadPaint()).rejects.toMatchObject({ name: "SecurityError" });
      expect(await store.loadPaint()).toBeNull(); // the next call opens normally
    });

    it("turns a failing open request into a rejection", async () => {
      const real = new IDBFactory();
      const factory = failingOpen(real, [() => {
        const request = fakeOpenRequest();
        queueMicrotask(() => {
          Object.defineProperty(request, "error", { value: new DOMException("disk", "UnknownError") });
          request.onerror?.(new Event("error"));
        });
        return request as unknown as IDBOpenDBRequest;
      }]);
      const store = createIdbSnapshotStore(factory);
      await expect(store.loadGeometry()).rejects.toMatchObject({ name: "UnknownError" });
      expect(await store.loadGeometry()).toBeNull();
    });

    it("rejects, and does not hang, when open() is blocked", async () => {
      const real = new IDBFactory();
      const factory = failingOpen(real, [() => {
        const request = fakeOpenRequest();
        queueMicrotask(() => request.onblocked?.(new Event("blocked")));
        return request as unknown as IDBOpenDBRequest;
      }]);
      await expect(createIdbSnapshotStore(factory).loadGeometry()).rejects.toThrow(/blocked/);
    });

    it("rejects a write that throws synchronously (data that cannot be cloned) and keeps working", async () => {
      const store = createIdbSnapshotStore(new IDBFactory());
      const p = project();
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
        throw new DOMException("cannot clone", "DataCloneError");
      });
      await expect(store.saveBoth(toGeometrySnapshot(p), toPaintSnapshot(p))).rejects.toMatchObject({ name: "DataCloneError" });
      await store.saveBoth(toGeometrySnapshot(p), toPaintSnapshot(p));
      expect(((await store.loadPaint()) as { projectId: string }).projectId).toBe(p.id);
    });

    /** Makes the transaction of the paint write abort (what a quota error does), after the other writes went in. */
    function abortOnPaintWrite() {
      const real = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
        const request = real.apply(this, args);
        if (args[1] === "paint") queueMicrotask(() => this.transaction.abort());
        return request;
      });
    }

    it("rejects a write whose transaction aborts (quota) and stores nothing, not even half of it", async () => {
      const store = createIdbSnapshotStore(new IDBFactory());
      const p = project();
      abortOnPaintWrite();
      await expect(store.saveBoth(toGeometrySnapshot(p), toPaintSnapshot(p))).rejects.toThrow(/aborted/);
      vi.restoreAllMocks();
      expect(await store.loadGeometry()).toBeNull();
      expect(await store.loadPaint()).toBeNull();
    });

    it("saveBoth replaces the previous project atomically: a failed second save leaves the first intact", async () => {
      const store = createIdbSnapshotStore(new IDBFactory());
      const first = project(), second = project();
      await store.saveBoth(toGeometrySnapshot(first), toPaintSnapshot(first));
      abortOnPaintWrite();
      await expect(store.saveBoth(toGeometrySnapshot(second), toPaintSnapshot(second))).rejects.toThrow();
      vi.restoreAllMocks();
      const r = await restoreProject(store);
      expect(r.status === "restored" && r.project.id).toBe(first.id);
    });

    it("does not write paint next to another project's geometry (another tab imported meanwhile)", async () => {
      const factory = new IDBFactory();
      const tabA = createIdbSnapshotStore(factory), tabB = createIdbSnapshotStore(factory);
      const a = project(), b = project();
      const saverA = new ProjectSaver(tabA);
      await saverA.save(a);
      await new ProjectSaver(tabB).save(b); // tab B replaces the project
      a.paintTriangles(0, [1], 3);
      await expect(saverA.save(a)).rejects.toBeInstanceOf(StoreConflictError);
      const r = await restoreProject(tabB);
      expect(r.status === "restored" && r.project.id).toBe(b.id); // B's work is intact
      expect(r.status === "restored" && toSnapshot(r.project)).toEqual(toSnapshot(b));
    });

    it("refuses paint when nothing is stored", async () => {
      const store = createIdbSnapshotStore(new IDBFactory());
      await expect(store.savePaint(toPaintSnapshot(project()))).rejects.toBeInstanceOf(StoreConflictError);
      expect(await store.loadPaint()).toBeNull();
    });

    it("still saves paint into a database from before the meta record existed", async () => {
      const factory = new IDBFactory();
      const p = project();
      await new Promise<void>((resolve, reject) => {
        const r = factory.open("paintportplus", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("snapshots");
        r.onsuccess = () => {
          const tx = r.result.transaction("snapshots", "readwrite");
          tx.objectStore("snapshots").put(toGeometrySnapshot(p), "geometry");
          tx.objectStore("snapshots").put(toPaintSnapshot(p), "paint");
          tx.oncomplete = () => {
            r.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
      const store = createIdbSnapshotStore(factory);
      p.paintTriangles(0, [2], 3);
      await store.savePaint(toPaintSnapshot(p));
      const r = await restoreProject(store);
      expect(r.status === "restored" && toSnapshot(r.project)).toEqual(toSnapshot(p));
    });

    it("lets the app start with a damaged record: it is reported and kept", async () => {
      const store = createIdbSnapshotStore(new IDBFactory());
      await store.saveBoth({ not: "a snapshot" } as never, { also: "not" } as never);
      expect(await restoreSession(store)).toEqual({ status: "invalid" });
      expect(await store.loadGeometry()).toEqual({ not: "a snapshot" });
    });

    it("keeps a record of another version", async () => {
      const store = createIdbSnapshotStore(new IDBFactory());
      const s = structuredClone(toSnapshot(project()));
      s.geometry.version = 2;
      s.paint.version = 2;
      await store.saveBoth(s.geometry, s.paint);
      expect(await restoreSession(store)).toEqual({ status: "version" });
      expect(await store.loadPaint()).toEqual(s.paint);
    });
  });
});
