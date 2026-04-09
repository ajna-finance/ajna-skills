import { afterEach, describe, expect, it } from "vitest";

import { runPrepareUnsupportedAjnaAction } from "../src/actions.js";
import { UNSAFE_SDK_CALL_ACKNOWLEDGEMENT } from "../src/constants.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("prepare-unsupported-ajna-action", () => {
  it("rejects when the unsafe gate is disabled", async () => {
    process.env.AJNA_SKILLS_MODE = "prepare";

    await expect(
      runPrepareUnsupportedAjnaAction({
        network: "base",
        actorAddress: "0x0000000000000000000000000000000000000001",
        contractKind: "position-manager",
        abiFragment: "function memorializePositions(address,uint256[])",
        methodName: "memorializePositions",
        args: ["0x0000000000000000000000000000000000000001", []],
        acknowledgeRisk: UNSAFE_SDK_CALL_ACKNOWLEDGEMENT
      })
    ).rejects.toMatchObject({
      code: "UNSAFE_SDK_CALLS_DISABLED"
    });
  });

  it("rejects when the acknowledgement phrase is wrong", async () => {
    process.env.AJNA_SKILLS_MODE = "prepare";
    process.env.AJNA_ENABLE_UNSAFE_SDK_CALLS = "1";

    await expect(
      runPrepareUnsupportedAjnaAction({
        network: "base",
        actorAddress: "0x0000000000000000000000000000000000000001",
        contractKind: "position-manager",
        abiFragment: "function memorializePositions(address,uint256[])",
        methodName: "memorializePositions",
        args: ["0x0000000000000000000000000000000000000001", []],
        acknowledgeRisk: "please just do it"
      })
    ).rejects.toMatchObject({
      code: "UNSAFE_ACKNOWLEDGEMENT_REQUIRED"
    });
  });
});
