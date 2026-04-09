import { describe, expect, it } from "vitest";

import { runInspectPool } from "../src/actions.js";

const shouldRun =
  process.env.RUN_AJNA_CHAIN_TESTS === "1" &&
  Boolean(process.env.AJNA_RPC_URL_BASE) &&
  Boolean(process.env.AJNA_TEST_POOL_ADDRESS);

describe.skipIf(!shouldRun)("chain-backed smoke", () => {
  it("inspects a real Ajna pool on Base", async () => {
    process.env.AJNA_SKILLS_MODE = "inspect";

    const result = await runInspectPool({
      network: "base",
      poolAddress: process.env.AJNA_TEST_POOL_ADDRESS!
    });

    expect(result.poolAddress).toBeTruthy();
    expect(Number(result.prices.lupIndex)).toBeGreaterThan(0);
  });
});

