import { afterEach, describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../src/config.js";

const ORIGINAL_ENV = { ...process.env };

describe("loadRuntimeConfig", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("loads built-in base config from env", () => {
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const runtime = loadRuntimeConfig();

    expect(runtime.mode).toBe("inspect");
    expect(runtime.networks.base.chainId).toBe(8453);
    expect(runtime.networks.base.erc20PoolFactory).toBe(
      "0x214f62B5836D83f3D6c4f71F174209097B1A779C"
    );
  });
});

