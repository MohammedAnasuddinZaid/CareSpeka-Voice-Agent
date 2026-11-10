import { beforeEach, describe, expect, it } from "vitest";
import { CareKeys, getDriver, resetDriverForTests } from "@/lib/care/store";

beforeEach(() => {
  delete process.env.CARE_STORE;
  resetDriverForTests();
});

describe("care store — driver selection", () => {
  it("uses the memory driver under NODE_ENV=test", async () => {
    const driver = await getDriver();
    expect(driver.name).toBe("memory");
    expect(driver.persistent).toBe(false);
  });

  it("honours an explicit CARE_STORE=memory override", async () => {
    process.env.CARE_STORE = "memory";
    const driver = await getDriver();
    expect(driver.name).toBe("memory");
  });

  it("memoises a single driver instance", async () => {
    expect(await getDriver()).toBe(await getDriver());
  });
});

describe("care store — key namespace", () => {
  it("namespaces every key without collisions", () => {
    const keys = [
      CareKeys.session("wc_1"),
      CareKeys.sessionIndex,
      CareKeys.events("wc_1"),
      CareKeys.transcript("wc_1"),
      CareKeys.report("wc_1"),
      CareKeys.patient("pt_1"),
      CareKeys.pair("AB12CD"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(CareKeys.session("wc_1")).toBe("care:session:wc_1");
    expect(CareKeys.pair("AB12CD")).toBe("care:pair:AB12CD");
  });
});

describe("care store — document + list semantics", () => {
  it("round-trips documents and returns null for a missing key", async () => {
    const d = await getDriver();
    expect(await d.getDoc("missing")).toBeNull();
    await d.setDoc("k", { a: 1 });
    expect(await d.getDoc("k")).toEqual({ a: 1 });
  });

  it("setDocIfAbsent only writes once and reports the outcome", async () => {
    const d = await getDriver();
    expect(await d.setDocIfAbsent("k", 1)).toBe(true);
    expect(await d.setDocIfAbsent("k", 2)).toBe(false);
    expect(await d.getDoc("k")).toBe(1);
  });

  it("setDocIfAbsent also respects a key already present as a list", async () => {
    const d = await getDriver();
    await d.appendList("shared", "x");
    expect(await d.setDocIfAbsent("shared", { doc: true })).toBe(false);
  });

  it("incr treats a missing or corrupt counter as zero", async () => {
    const d = await getDriver();
    expect(await d.incr("c")).toBe(1);
    expect(await d.incr("c", 4)).toBe(5);
    await d.setDoc("bad", "not-a-number");
    expect(await d.incr("bad")).toBe(1);
  });

  it("mutateDoc writes the new value and can abort with null", async () => {
    const d = await getDriver();
    await d.setDoc("list", ["a"]);
    const next = await d.mutateDoc<string[]>("list", (cur) => [...(cur ?? []), "b"]);
    expect(next).toEqual(["a", "b"]);
    const aborted = await d.mutateDoc<string[]>("list", () => null);
    expect(aborted).toBeNull();
    expect(await d.getDoc("list")).toEqual(["a", "b"]);
  });

  it("appendList caps length (keeping the newest) and returns the new length", async () => {
    const d = await getDriver();
    for (let i = 0; i < 5; i += 1) await d.appendList("l", i, 3);
    expect(await d.getList("l")).toEqual([2, 3, 4]);
    expect(await d.appendList("l", 5, 3)).toBe(3);
  });

  it("getList(from) slices from an index and handles a missing key", async () => {
    const d = await getDriver();
    await d.setList("l", [1, 2, 3, 4]);
    expect(await d.getList("l", 2)).toEqual([3, 4]);
    expect(await d.getList("missing")).toEqual([]);
  });

  it("setList replaces the whole list", async () => {
    const d = await getDriver();
    await d.setList("l", [1, 2]);
    await d.setList("l", ["only"]);
    expect(await d.getList("l")).toEqual(["only"]);
  });

  it("del removes both a document and a list under the same key", async () => {
    const d = await getDriver();
    await d.setDoc("k", 1);
    await d.setList("k2", [1]);
    await d.del("k");
    await d.del("k2");
    expect(await d.getDoc("k")).toBeNull();
    expect(await d.getList("k2")).toEqual([]);
  });
});
