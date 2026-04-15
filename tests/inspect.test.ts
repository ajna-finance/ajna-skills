import { ERC20Pool__factory, ERC20PoolFactory__factory, PoolInfoUtils__factory } from "@ajna-finance/sdk";
import { BigNumber, ethers } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AjnaAdapter } from "../src/sdk.js";
import type { RuntimeConfig } from "../src/types.js";

const runtime: RuntimeConfig = {
  mode: "inspect",
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

function namedTuple<T extends Record<string, unknown>>(values: unknown[], named: T): T {
  return Object.assign(values, named) as T;
}

describe("AjnaAdapter inspect helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the basic inspect-pool shape without full extras", async () => {
    const poolAddress = "0x0000000000000000000000000000000000000100";
    const collateralAddress = "0x0000000000000000000000000000000000000101";
    const quoteAddress = "0x0000000000000000000000000000000000000102";
    const pool = {
      collateralAddress: vi.fn().mockResolvedValue(collateralAddress),
      quoteTokenAddress: vi.fn().mockResolvedValue(quoteAddress),
      debtInfo: vi.fn(),
      interestRateInfo: vi.fn(),
      pledgedCollateral: vi.fn(),
      poolType: vi.fn(),
      quoteTokenScale: vi.fn(),
      collateralScale: vi.fn()
    };
    const poolInfoUtils = {
      poolPricesInfo: vi.fn().mockResolvedValue(
        namedTuple([1, 2, 3, 4, 5, 6], {
          hpb_: BigNumber.from(1),
          hpbIndex_: BigNumber.from(2),
          htp_: BigNumber.from(3),
          htpIndex_: BigNumber.from(4),
          lup_: BigNumber.from(5),
          lupIndex_: BigNumber.from(6)
        })
      ),
      poolLoansInfo: vi.fn().mockResolvedValue(
        namedTuple([1000, 7, ethers.constants.AddressZero, 8, 9], {
          poolSize_: BigNumber.from(1000),
          loansCount_: BigNumber.from(7),
          maxBorrower_: ethers.constants.AddressZero,
          pendingInflator_: BigNumber.from(8),
          pendingInterestFactor_: BigNumber.from(9)
        })
      ),
      poolUtilizationInfo: vi.fn().mockResolvedValue(
        namedTuple([10, 11, 12, 13], {
          poolMinDebtAmount_: BigNumber.from(10),
          poolCollateralization_: BigNumber.from(11),
          poolActualUtilization_: BigNumber.from(12),
          poolTargetUtilization_: BigNumber.from(13)
        })
      ),
      poolReservesInfo: vi.fn().mockResolvedValue(
        namedTuple([14, 15, 16, 17, 18], {
          reserves_: BigNumber.from(14),
          claimableReserves_: BigNumber.from(15),
          claimableReservesRemaining_: BigNumber.from(16),
          auctionPrice_: BigNumber.from(17),
          timeRemaining_: BigNumber.from(18)
        })
      ),
      borrowFeeRate: vi.fn().mockResolvedValue(BigNumber.from(19)),
      depositFeeRate: vi.fn().mockResolvedValue(BigNumber.from(20)),
      lenderInterestMargin: vi.fn()
    };

    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });
    vi.spyOn(ERC20Pool__factory, "connect").mockReturnValue(pool as never);
    vi.spyOn(ERC20PoolFactory__factory, "connect").mockReturnValue({
      deployedPools: vi.fn().mockResolvedValue(poolAddress)
    } as never);
    vi.spyOn(PoolInfoUtils__factory, "connect").mockReturnValue(poolInfoUtils as never);

    const adapter = new AjnaAdapter(runtime);
    vi.spyOn(adapter as never, "readSymbol").mockImplementation(async (address: string) => {
      if (address === collateralAddress) return "AERO";
      if (address === quoteAddress) return "USDC";
      return null;
    });

    const result = await adapter.inspectPool({
      network: "base",
      poolAddress
    });

    expect(result.detailLevel).toBe("basic");
    expect(result.collateralSymbol).toBe("AERO");
    expect(result.quoteSymbol).toBe("USDC");
    expect(result.pool.poolSize).toBe("1000");
    expect(result.pool.borrowFeeRate).toBe("19");
    expect(result.full).toBeUndefined();
    expect(pool.debtInfo).not.toHaveBeenCalled();
    expect(poolInfoUtils.lenderInterestMargin).not.toHaveBeenCalled();
  });

  it("returns expanded inspect-pool fields when detailLevel is full", async () => {
    const poolAddress = "0x0000000000000000000000000000000000000200";
    const collateralAddress = "0x0000000000000000000000000000000000000201";
    const quoteAddress = "0x0000000000000000000000000000000000000202";
    const pool = {
      collateralAddress: vi.fn().mockResolvedValue(collateralAddress),
      quoteTokenAddress: vi.fn().mockResolvedValue(quoteAddress),
      debtInfo: vi.fn().mockResolvedValue([BigNumber.from(21), BigNumber.from(22), BigNumber.from(23), BigNumber.from(24)]),
      interestRateInfo: vi.fn().mockResolvedValue([BigNumber.from(25), BigNumber.from(1_700_000_000)]),
      pledgedCollateral: vi.fn().mockResolvedValue(BigNumber.from(26)),
      poolType: vi.fn().mockResolvedValue(0),
      quoteTokenScale: vi.fn().mockResolvedValue(BigNumber.from(1_000_000)),
      collateralScale: vi.fn().mockResolvedValue(BigNumber.from("1000000000000000000"))
    };
    const poolInfoUtils = {
      poolPricesInfo: vi.fn().mockResolvedValue(
        namedTuple([1, 2, 3, 4, 5, 6], {
          hpb_: BigNumber.from(1),
          hpbIndex_: BigNumber.from(2),
          htp_: BigNumber.from(3),
          htpIndex_: BigNumber.from(4),
          lup_: BigNumber.from(5),
          lupIndex_: BigNumber.from(6)
        })
      ),
      poolLoansInfo: vi.fn().mockResolvedValue(
        namedTuple([1000, 7, ethers.constants.AddressZero, 27, 28], {
          poolSize_: BigNumber.from(1000),
          loansCount_: BigNumber.from(7),
          maxBorrower_: ethers.constants.AddressZero,
          pendingInflator_: BigNumber.from(27),
          pendingInterestFactor_: BigNumber.from(28)
        })
      ),
      poolUtilizationInfo: vi.fn().mockResolvedValue(
        namedTuple([10, 11, 12, 13], {
          poolMinDebtAmount_: BigNumber.from(10),
          poolCollateralization_: BigNumber.from(11),
          poolActualUtilization_: BigNumber.from(12),
          poolTargetUtilization_: BigNumber.from(13)
        })
      ),
      poolReservesInfo: vi.fn().mockResolvedValue(
        namedTuple([14, 15, 16, 29, 30], {
          reserves_: BigNumber.from(14),
          claimableReserves_: BigNumber.from(15),
          claimableReservesRemaining_: BigNumber.from(16),
          auctionPrice_: BigNumber.from(29),
          timeRemaining_: BigNumber.from(30)
        })
      ),
      borrowFeeRate: vi.fn().mockResolvedValue(BigNumber.from(19)),
      depositFeeRate: vi.fn().mockResolvedValue(BigNumber.from(20)),
      lenderInterestMargin: vi.fn().mockResolvedValue(BigNumber.from(31))
    };

    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });
    vi.spyOn(ERC20Pool__factory, "connect").mockReturnValue(pool as never);
    vi.spyOn(ERC20PoolFactory__factory, "connect").mockReturnValue({
      deployedPools: vi.fn().mockResolvedValue(poolAddress)
    } as never);
    vi.spyOn(PoolInfoUtils__factory, "connect").mockReturnValue(poolInfoUtils as never);

    const adapter = new AjnaAdapter(runtime);
    vi.spyOn(adapter as never, "readSymbol").mockResolvedValue(null);

    const result = await adapter.inspectPool({
      network: "base",
      poolAddress,
      detailLevel: "full"
    });

    expect(result.detailLevel).toBe("full");
    expect(result.full).toEqual({
      config: {
        poolType: 0,
        quoteTokenScale: "1000000",
        collateralScale: "1000000000000000000"
      },
      rates: {
        borrowRate: "25",
        lenderInterestMargin: "31",
        interestRateLastUpdated: "2023-11-14T22:13:20.000Z"
      },
      debt: {
        debt: "21",
        poolDebtInAuction: "23",
        pendingInflator: "27",
        pendingInterestFactor: "28"
      },
      totals: {
        pledgedCollateral: "26",
        reserveAuctionPrice: "29",
        reserveAuctionTimeRemaining: "30"
      }
    });
  });

  it("returns a normalized bucket inspection result", async () => {
    const poolAddress = "0x0000000000000000000000000000000000000300";
    const pool = {
      quoteTokenAddress: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000301"),
      collateralAddress: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000302"),
      quoteTokenScale: vi.fn().mockResolvedValue(BigNumber.from(1_000_000)),
      collateralScale: vi.fn().mockResolvedValue(BigNumber.from("1000000000000000000")),
      bucketCollateralDust: vi.fn().mockResolvedValue(BigNumber.from(40))
    };
    const poolInfoUtils = {
      bucketInfo: vi.fn().mockResolvedValue(
        namedTuple([32, 33, 34, 35, 36, 37], {
          price_: BigNumber.from(32),
          quoteTokens_: BigNumber.from(33),
          collateral_: BigNumber.from(34),
          bucketLP_: BigNumber.from(35),
          scale_: BigNumber.from(36),
          exchangeRate_: BigNumber.from(37)
        })
      )
    };

    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue({
      chainId: 8453,
      name: "base"
    });
    vi.spyOn(ERC20Pool__factory, "connect").mockReturnValue(pool as never);
    vi.spyOn(ERC20PoolFactory__factory, "connect").mockReturnValue({
      deployedPools: vi.fn().mockResolvedValue(poolAddress)
    } as never);
    vi.spyOn(PoolInfoUtils__factory, "connect").mockReturnValue(poolInfoUtils as never);

    const adapter = new AjnaAdapter(runtime);
    const result = await adapter.inspectBucket({
      network: "base",
      poolAddress,
      bucketIndex: 3232
    });

    expect(result).toEqual({
      network: "base",
      poolAddress,
      bucketIndex: 3232,
      bucket: {
        price: "32",
        quoteTokens: "33",
        collateral: "34",
        bucketLP: "35",
        scale: "36",
        exchangeRate: "37",
        collateralDust: "40"
      }
    });
  });
});
