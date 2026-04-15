import { BigNumber } from "ethers";
import { describe, expect, it, vi } from "vitest";

const { createTransactionMock } = vi.hoisted(() => ({
  createTransactionMock: vi.fn()
}));

vi.mock("@ajna-finance/sdk", async () => {
  const actual = await vi.importActual<typeof import("@ajna-finance/sdk")>("@ajna-finance/sdk");
  return {
    ...actual,
    createTransaction: createTransactionMock
  };
});

import { AjnaAdapter } from "../src/sdk.js";
import type { RuntimeConfig } from "../src/types.js";

const runtime: RuntimeConfig = {
  mode: "prepare",
  unsafeUnsupportedActionsEnabled: false,
  networks: {
    base: {
      network: "base",
      chainId: 8453,
      rpcUrl: "http://127.0.0.1:8545",
      ajnaToken: "0x0000000000000000000000000000000000000010",
      erc20PoolFactory: "0x0000000000000000000000000000000000000020",
      erc721PoolFactory: "0x0000000000000000000000000000000000000030",
      poolInfoUtils: "0x0000000000000000000000000000000000000040",
      positionManager: "0x0000000000000000000000000000000000000050"
    }
  }
};

describe("prepare-time verification", () => {
  it("fails closed when transaction verification fails", async () => {
    const adapter = new AjnaAdapter(runtime);

    createTransactionMock.mockResolvedValue({
      _transaction: {
        to: "0x00000000000000000000000000000000000000B1",
        value: BigNumber.from(0),
        data: "0x1234",
        nonce: 0
      },
      verify: vi.fn().mockRejectedValue(new Error("verification exploded"))
    });

    await expect(
      (adapter as never).prepareContractTransaction({
        contract: { address: "0x00000000000000000000000000000000000000B1" },
        methodName: "approve",
        args: ["0x00000000000000000000000000000000000000B1", 1],
        from: "0x00000000000000000000000000000000000000A1",
        label: "approval"
      })
    ).rejects.toMatchObject({
      code: "PREPARE_VERIFICATION_FAILED"
    });
  });
});
