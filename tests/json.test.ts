import { describe, expect, it } from "vitest";

import { canonicalize, parseJsonArgument } from "../src/json.js";

describe("canonicalize", () => {
  it("sorts nested object keys deterministically", () => {
    const output = canonicalize({
      b: 2,
      a: {
        d: 4,
        c: 3
      }
    });

    expect(output).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it("sorts keys with a locale-independent codepoint order", () => {
    const output = canonicalize({
      i: 2,
      I: 1
    });

    expect(output).toBe('{"I":1,"i":2}');
  });
});

describe("parseJsonArgument", () => {
  it("rejects unsafe JSON numbers before they can be rounded into calldata", () => {
    expect(() =>
      parseJsonArgument<{ args: number[] }>('{"args":[9007199254740993]}')
    ).toThrowError(/safe integers/);
  });
});
