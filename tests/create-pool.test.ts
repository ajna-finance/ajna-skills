import { ERC20__factory, ERC20PoolFactory__factory, ERC721PoolFactory__factory } from "@ajna-finance/sdk";
import { BigNumber, ethers } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runExecutePrepared } from "../src/actions.js";
import { finalizePreparedAction } from "../src/prepared.js";
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
const ORIGINAL_ENV = { ...process.env };

describe("pool creation flows", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("prepares an ERC20 pool creation against the Ajna factory", async () => {
    const actorAddress = "0x00000000000000000000000000000000000000A1";
    const collateralAddress = "0x00000000000000000000000000000000000000B1";
    const quoteAddress = "0x00000000000000000000000000000000000000C1";
    const preparedTransaction = {
      label: "action" as const,
      target: runtime.networks.base!.erc20PoolFactory,
      value: "0",
      data: "0xdeadbeef",
      from: actorAddress
    };
    const factory = {
      MIN_RATE: vi.fn().mockResolvedValue(BigNumber.from("10000000000000000")),
      MAX_RATE: vi.fn().mockResolvedValue(BigNumber.from("100000000000000000")),
      deployedPools: vi.fn().mockResolvedValue(ethers.constants.AddressZero)
    };

    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getBlock").mockResolvedValue({
      timestamp: 1_700_000_000
    } as never);
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getCode").mockResolvedValue("0x1234");
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getTransactionCount").mockResolvedValue(7);
    vi.spyOn(ERC20PoolFactory__factory, "connect").mockReturnValue(factory as never);
    vi.spyOn(ERC20__factory, "connect").mockReturnValue({
      decimals: vi.fn().mockResolvedValue(18)
    } as never);

    const adapter = new AjnaAdapter(runtime);
    const txSpy = vi
      .spyOn(adapter as never, "prepareContractTransaction")
      .mockResolvedValue(preparedTransaction);

    const preparedAction = await adapter.prepareCreateErc20Pool({
      network: "base",
      actorAddress,
      collateralAddress,
      quoteAddress,
      interestRate: "50000000000000000"
    });

    expect(factory.deployedPools).toHaveBeenCalledWith(
      "0x2263c4378b4920f0bef611a3ff22c506afa4745b3319c50b6d704a874990b8b2",
      collateralAddress,
      quoteAddress
    );
    expect(txSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        methodName: "deployPool",
        args: [collateralAddress, quoteAddress, BigNumber.from("50000000000000000")]
      })
    );
    expect(preparedAction.kind).toBe("create-erc20-pool");
    expect(preparedAction.poolAddress).toBe(runtime.networks.base!.erc20PoolFactory);
    expect(preparedAction.metadata.collateralType).toBe("erc20");
    expect(preparedAction.transactions).toEqual([preparedTransaction]);
  });

  it("prepares an ERC721 subset pool using a sorted unique subset hash", async () => {
    const actorAddress = "0x00000000000000000000000000000000000000A2";
    const collateralAddress = "0x00000000000000000000000000000000000000B2";
    const quoteAddress = "0x00000000000000000000000000000000000000C2";
    const preparedTransaction = {
      label: "action" as const,
      target: runtime.networks.base!.erc721PoolFactory,
      value: "0",
      data: "0xfeedface",
      from: actorAddress
    };
    const factory = {
      MIN_RATE: vi.fn().mockResolvedValue(BigNumber.from("10000000000000000")),
      MAX_RATE: vi.fn().mockResolvedValue(BigNumber.from("100000000000000000")),
      deployedPools: vi.fn().mockResolvedValue(ethers.constants.AddressZero)
    };

    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getBlock").mockResolvedValue({
      timestamp: 1_700_000_000
    } as never);
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getCode").mockResolvedValue("0x1234");
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getTransactionCount").mockResolvedValue(11);
    vi.spyOn(ERC721PoolFactory__factory, "connect").mockReturnValue(factory as never);
    vi.spyOn(ERC20__factory, "connect").mockReturnValue({
      decimals: vi.fn().mockResolvedValue(6)
    } as never);

    const adapter = new AjnaAdapter(runtime);
    const txSpy = vi
      .spyOn(adapter as never, "prepareContractTransaction")
      .mockResolvedValue(preparedTransaction);

    const preparedAction = await adapter.prepareCreateErc721Pool({
      network: "base",
      actorAddress,
      collateralAddress,
      quoteAddress,
      interestRate: "50000000000000000",
      tokenIds: ["5", "1", "2"]
    });

    expect(txSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        methodName: "deployPool(address,address,uint256[],uint256)",
        args: [
          ethers.utils.getAddress(collateralAddress),
          ethers.utils.getAddress(quoteAddress),
          ["1", "2", "5"],
          BigNumber.from("50000000000000000")
        ]
      })
    );
    expect(preparedAction.kind).toBe("create-erc721-pool");
    expect(preparedAction.metadata.subsetSize).toBe(3);
    expect(preparedAction.metadata.collateralType).toBe("erc721-subset");
    expect(typeof preparedAction.metadata.subsetHash).toBe("string");
  });

  it("returns resolvedPoolAddress after executing an ERC20 pool creation payload", async () => {
    const wallet = ethers.Wallet.createRandom();
    const resolvedPoolAddress = "0x0000000000000000000000000000000000000ABC";

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await finalizePreparedAction(
      {
        version: 1,
        kind: "create-erc20-pool",
        network: "base",
        chainId: 8453,
        actorAddress: wallet.address,
        startingNonce: 3,
        poolAddress: runtime.networks.base!.erc20PoolFactory,
        quoteAddress: "0x0000000000000000000000000000000000000101",
        collateralAddress: "0x0000000000000000000000000000000000000102",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        transactions: [
          {
            label: "action",
            target: runtime.networks.base!.erc20PoolFactory,
            value: "0",
            data: "0x1234",
            from: wallet.address
          }
        ],
        metadata: {
          factoryAddress: runtime.networks.base!.erc20PoolFactory,
          interestRate: "50000000000000000",
          subsetHash: "0x2263c4378b4920f0bef611a3ff22c506afa4745b3319c50b6d704a874990b8b2",
          collateralType: "erc20"
        }
      },
      {
        ...runtime,
        mode: "execute",
        signerPrivateKey: wallet.privateKey,
        executeSignerAddress: wallet.address
      }
    );

    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getTransactionCount").mockResolvedValue(3);
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "estimateGas").mockResolvedValue(BigNumber.from(21_000));
    vi.spyOn(ERC20PoolFactory__factory, "connect").mockReturnValue({
      deployedPools: vi.fn().mockResolvedValue(resolvedPoolAddress)
    } as never);
    vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockResolvedValue({
      hash: `0x${"1".padStart(64, "0")}`,
      wait: async () => ({
        status: 1,
        gasUsed: BigNumber.from(21_000)
      })
    } as never);

    const result = await runExecutePrepared({ preparedAction });

    expect(result.resolvedPoolAddress).toBe(resolvedPoolAddress);
    expect(result.submitted).toHaveLength(1);
  });

  it("rejects ERC20 pool creation when the token addresses are not deployed contracts", async () => {
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getCode").mockResolvedValue("0x");

    const adapter = new AjnaAdapter(runtime);

    await expect(
      adapter.prepareCreateErc20Pool({
        network: "base",
        actorAddress: "0x00000000000000000000000000000000000000A3",
        collateralAddress: "0x00000000000000000000000000000000000000B3",
        quoteAddress: "0x00000000000000000000000000000000000000C3",
        interestRate: "50000000000000000"
      })
    ).rejects.toMatchObject({
      code: "INVALID_POOL_TOKENS"
    });
  });
});
