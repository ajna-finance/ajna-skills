import { BigNumber, ethers } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runPrepareUnsupportedAjnaAction } from "../src/actions.js";
import { AjnaAdapter } from "../src/sdk.js";
import { UNSAFE_SDK_CALL_ACKNOWLEDGEMENT } from "../src/constants.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("prepare-unsupported-ajna-action", () => {
  it("rejects when the unsafe gate is disabled", async () => {
    process.env.AJNA_SKILLS_MODE = "prepare";

    await expect(
      runPrepareUnsupportedAjnaAction({
        network: "base",
        actorAddress: "0x0000000000000000000000000000000000000001",
        contractKind: "position-manager",
        methodName: "memorializePositions",
        args: ["0x0000000000000000000000000000000000000001", "1", []],
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
        methodName: "memorializePositions",
        args: ["0x0000000000000000000000000000000000000001", "1", []],
        acknowledgeRisk: "please just do it"
      })
    ).rejects.toMatchObject({
      code: "UNSAFE_ACKNOWLEDGEMENT_REQUIRED"
    });
  });

  it("uses the built-in ABI registry when abiFragment is omitted", async () => {
    process.env.AJNA_SKILLS_MODE = "prepare";
    process.env.AJNA_ENABLE_UNSAFE_SDK_CALLS = "1";
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getBlock").mockResolvedValue({
      timestamp: 1_700_000_000
    } as never);
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getTransactionCount").mockResolvedValue(2);

    const txSpy = vi.spyOn(AjnaAdapter.prototype as never, "prepareContractTransaction").mockResolvedValue({
      label: "action",
      target: "0x59710a4149A27585f1841b5783ac704a08274e64",
      value: "0",
      data: "0x1234",
      gasEstimate: BigNumber.from(21_000).toString()
    });

    const preparedAction = await runPrepareUnsupportedAjnaAction({
      network: "base",
      actorAddress: "0x0000000000000000000000000000000000000001",
      contractKind: "position-manager",
      methodName: "memorializePositions",
      args: ["0x0000000000000000000000000000000000000001", "1", []],
      acknowledgeRisk: UNSAFE_SDK_CALL_ACKNOWLEDGEMENT
    });

    expect(txSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        methodName: "memorializePositions(address,uint256,uint256[])"
      })
    );
    expect(preparedAction.metadata.abiSource).toBe("builtin");
    expect(preparedAction.metadata.methodName).toBe("memorializePositions(address,uint256,uint256[])");
    expect(String(preparedAction.metadata.abiFragment)).toMatch(
      /^function memorializePositions\(address .*?, uint256 tokenId_, uint256\[] indexes_\)$/
    );
  });

  it("rejects generic token-approval methods on the position manager escape hatch", async () => {
    process.env.AJNA_SKILLS_MODE = "prepare";
    process.env.AJNA_ENABLE_UNSAFE_SDK_CALLS = "1";
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });

    await expect(
      runPrepareUnsupportedAjnaAction({
        network: "base",
        actorAddress: "0x0000000000000000000000000000000000000001",
        contractKind: "position-manager",
        methodName: "approve",
        args: ["0x0000000000000000000000000000000000000002", "1"],
        acknowledgeRisk: UNSAFE_SDK_CALL_ACKNOWLEDGEMENT
      })
    ).rejects.toMatchObject({
      code: "UNSAFE_METHOD_DISALLOWED"
    });
  });

  it("rejects LP transfer methods on pool escape hatches", () => {
    const adapter = new AjnaAdapter({
      mode: "prepare",
      unsafeUnsupportedActionsEnabled: true,
      networks: {}
    });

    try {
      (adapter as never).resolveUnsupportedMethod({
        network: "base",
        actorAddress: "0x0000000000000000000000000000000000000001",
        contractKind: "erc20-pool",
        contractAddress: "0x0000000000000000000000000000000000000002",
        methodName: "transferLP",
        args: [
          "0x0000000000000000000000000000000000000001",
          "0x0000000000000000000000000000000000000002",
          []
        ],
        acknowledgeRisk: UNSAFE_SDK_CALL_ACKNOWLEDGEMENT
      });
      throw new Error("expected resolveUnsupportedMethod to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "UNSAFE_METHOD_DISALLOWED"
      });
    }
  });

  it("rejects unsupported actions whose args do not match the selected ABI", async () => {
    process.env.AJNA_SKILLS_MODE = "prepare";
    process.env.AJNA_ENABLE_UNSAFE_SDK_CALLS = "1";
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });

    await expect(
      runPrepareUnsupportedAjnaAction({
        network: "base",
        actorAddress: "0x0000000000000000000000000000000000000001",
        contractKind: "position-manager",
        methodName: "memorializePositions",
        args: ["0x0000000000000000000000000000000000000001", "1"],
        acknowledgeRisk: UNSAFE_SDK_CALL_ACKNOWLEDGEMENT
      })
    ).rejects.toMatchObject({
      code: "UNSAFE_ARGUMENTS_INVALID"
    });
  });
});
