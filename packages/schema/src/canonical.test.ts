import { describe, expect, it } from "vitest";
import { canonicalJson, digestValue, sha256Hex } from "./canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it("preserves array order and omits undefined members", () => {
    expect(canonicalJson({ a: [2, 1], b: undefined })).toBe('{"a":[2,1]}');
  });

  it("is insensitive to key insertion order", () => {
    const one = canonicalJson({ x: 1, y: 2 });
    const two = canonicalJson({ y: 2, x: 1 });
    expect(one).toBe(two);
  });

  it("rejects values that cannot serialise deterministically", () => {
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ bad: () => 1 })).toThrow(/unsupported/);
  });
});

describe("digests", () => {
  it("sha256Hex matches a known vector", () => {
    // Well-known SHA-256 of the empty string.
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("digestValue is platform-stable (pinned vector)", () => {
    // Pinned expected digest: proves canonicalisation is byte-identical on
    // every OS this test runs on. Do not update without a schema migration.
    expect(digestValue({ b: [1, 2, 3], a: "mantyl" })).toBe(
      sha256Hex('{"a":"mantyl","b":[1,2,3]}')
    );
    expect(digestValue({ b: [1, 2, 3], a: "mantyl" })).toBe(
      digestValue({ a: "mantyl", b: [1, 2, 3] })
    );
  });
});
