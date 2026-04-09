import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/json.js";
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
});
