import {
  AjnaToken__factory,
  ERC20Pool__factory,
  ERC20PoolFactory__factory,
  ERC721Pool__factory,
  ERC721PoolFactory__factory,
  ERC721__factory,
  ERC20__factory,
  PoolInfoUtils__factory,
  PositionManager__factory,
  SdkError,
  createTransaction
} from "@ajna-finance/sdk";
import { BigNumber, ethers } from "ethers";

import {
  DEFAULT_PREPARED_MAX_AGE_SECONDS,
  DEFAULT_TTL_SECONDS,
  ERC20_NON_SUBSET_HASH,
  ERC721_NON_SUBSET_HASH,
  UNSAFE_SDK_CALL_ACKNOWLEDGEMENT
} from "./constants.js";
import { AjnaSkillError, invariant } from "./errors.js";
import { finalizePreparedAction } from "./prepared.js";
import type {
  AllowanceCheck,
  BucketInspectionResult,
  InspectBucketInput,
  InspectPoolInput,
  InspectPositionInput,
  PoolInspectionResult,
  PreparedAction,
  PrepareApproveErc20Input,
  PrepareApproveErc721Input,
  PrepareBorrowInput,
  PrepareCreateErc20PoolInput,
  PrepareCreateErc721PoolInput,
  PrepareLendInput,
  PrepareUnsupportedAjnaActionInput,
  RuntimeConfig,
  RuntimeNetworkConfig,
  UnsupportedAjnaContractKind
} from "./types.js";

type TransactionLike = Awaited<ReturnType<typeof createTransaction>> & {
  _transaction?: ethers.providers.TransactionRequest;
};
type AjnaPoolTargetContext =
  | {
      kind: "erc20-pool";
      poolAddress: string;
      quoteAddress: string;
      collateralAddress: string;
      quoteTokenScale: BigNumber;
      collateralScale: BigNumber;
    }
  | {
      kind: "erc721-pool";
      poolAddress: string;
      quoteAddress: string;
      collateralAddress: string;
      subsetHash: string | null;
    };
type DeferredVerificationPolicy =
  | {
      kind: "erc20-allowance-raise";
      tokenAddress: string;
      owner: string;
      spender: string;
      requiredAllowance: BigNumber;
    }
  | {
      kind: "erc20-allowance-reset";
      tokenAddress: string;
      owner: string;
      spender: string;
      currentAllowance: BigNumber;
      desiredAllowance: BigNumber;
    };

const ERC721_APPROVAL_ABI = [
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)"
] as const;
const ERC721_INTERFACE_ID = "0x80ac58cd";
type UnsafeContractAbi = ReadonlyArray<any>;
const UNSAFE_CONTRACT_ABIS: Record<UnsupportedAjnaContractKind, UnsafeContractAbi> = {
  "erc20-pool": ERC20Pool__factory.abi,
  "erc721-pool": ERC721Pool__factory.abi,
  "position-manager": PositionManager__factory.abi,
  "ajna-token": AjnaToken__factory.abi
};
const UNSAFE_ALLOWED_METHODS: Record<UnsupportedAjnaContractKind, Set<string>> = {
  "erc20-pool": new Set([
    "addCollateral(uint256,uint256,uint256)",
    "addQuoteToken(uint256,uint256,uint256)",
    "bucketTake(address,bool,uint256)",
    "drawDebt(address,uint256,uint256,uint256)",
    "flashLoan(address,address,uint256,bytes)",
    "kick(address,uint256)",
    "kickReserveAuction()",
    "lenderKick(uint256,uint256)",
    "moveQuoteToken(uint256,uint256,uint256,uint256)",
    "removeCollateral(uint256,uint256)",
    "removeQuoteToken(uint256,uint256)",
    "repayDebt(address,uint256,uint256,address,uint256)",
    "settle(address,uint256)",
    "stampLoan()",
    "take(address,uint256,address,bytes)",
    "takeReserves(uint256)",
    "updateInterest()",
    "withdrawBonds(address,uint256)"
  ]),
  "erc721-pool": new Set([
    "addCollateral(uint256[],uint256,uint256)",
    "addQuoteToken(uint256,uint256,uint256)",
    "bucketTake(address,bool,uint256)",
    "drawDebt(address,uint256,uint256,uint256[])",
    "flashLoan(address,address,uint256,bytes)",
    "kick(address,uint256)",
    "kickReserveAuction()",
    "lenderKick(uint256,uint256)",
    "mergeOrRemoveCollateral(uint256[],uint256,uint256)",
    "moveQuoteToken(uint256,uint256,uint256,uint256)",
    "removeCollateral(uint256,uint256)",
    "removeQuoteToken(uint256,uint256)",
    "repayDebt(address,uint256,uint256,address,uint256)",
    "settle(address,uint256)",
    "stampLoan()",
    "take(address,uint256,address,bytes)",
    "takeReserves(uint256)",
    "updateInterest()",
    "withdrawBonds(address,uint256)"
  ]),
  "position-manager": new Set([
    "burn(address,uint256)",
    "memorializePositions(address,uint256,uint256[])",
    "mint(address,address,bytes32)",
    "moveLiquidity(address,uint256,uint256,uint256,uint256)",
    "redeemPositions(address,uint256,uint256[])"
  ]),
  "ajna-token": new Set([
    "delegate(address)",
    "delegateBySig(address,uint256,uint256,uint8,bytes32,bytes32)"
  ])
};
const ERC20_SYMBOL_STRING_IFACE = new ethers.utils.Interface(["function symbol() view returns (string)"]);
const ERC20_SYMBOL_BYTES32_IFACE = new ethers.utils.Interface(["function symbol() view returns (bytes32)"]);
const ALLOWANCE_RAISE_SDK_REASONS = new Set([
  "ERC20InsufficientAllowance",
  "transfer amount exceeds allowance",
  "insufficient approval"
]);
const ALLOWANCE_RESET_SDK_REASONS = new Set([
  "approve from non-zero to non-zero allowance",
  "must reset allowance to zero",
  "allowance must be zero before setting"
]);

export class AjnaAdapter {
  constructor(private readonly runtime: RuntimeConfig) {}

  async inspectPool(input: InspectPoolInput): Promise<PoolInspectionResult> {
    const detailLevel = input.detailLevel ?? "basic";
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const poolTarget = await this.resolveInspectablePoolContext(input, network, provider);
    const poolInfoUtils = PoolInfoUtils__factory.connect(network.poolInfoUtils, provider);

    const [collateralAddress, quoteAddress, prices, loans, utilization, reserves, borrowFeeRate, depositFeeRate] =
      await Promise.all([
        Promise.resolve(poolTarget.collateralAddress),
        Promise.resolve(poolTarget.quoteAddress),
        poolInfoUtils.poolPricesInfo(poolTarget.poolAddress),
        poolInfoUtils.poolLoansInfo(poolTarget.poolAddress),
        poolInfoUtils.poolUtilizationInfo(poolTarget.poolAddress),
        poolInfoUtils.poolReservesInfo(poolTarget.poolAddress),
        poolInfoUtils.borrowFeeRate(poolTarget.poolAddress),
        poolInfoUtils.depositFeeRate(poolTarget.poolAddress)
      ]);

    const baseResult: PoolInspectionResult = {
      network: input.network,
      detailLevel,
      poolKind: poolTarget.kind,
      poolAddress: poolTarget.poolAddress,
      subsetHash: this.poolTargetSubsetHash(poolTarget),
      collateralAddress,
      collateralSymbol: await this.readSymbol(collateralAddress, provider),
      quoteAddress,
      quoteSymbol: await this.readSymbol(quoteAddress, provider),
      prices: {
        hpb: prices.hpb_.toString(),
        hpbIndex: prices.hpbIndex_.toNumber(),
        htp: prices.htp_.toString(),
        htpIndex: prices.htpIndex_.toNumber(),
        lup: prices.lup_.toString(),
        lupIndex: prices.lupIndex_.toNumber()
      },
      pool: {
        poolSize: loans.poolSize_.toString(),
        loansCount: loans.loansCount_.toNumber(),
        minDebtAmount: utilization.poolMinDebtAmount_.toString(),
        collateralization: utilization.poolCollateralization_.toString(),
        actualUtilization: utilization.poolActualUtilization_.toString(),
        targetUtilization: utilization.poolTargetUtilization_.toString(),
        reserves: reserves.reserves_.toString(),
        claimableReserves: reserves.claimableReserves_.toString(),
        claimableReservesRemaining: reserves.claimableReservesRemaining_.toString(),
        borrowFeeRate: borrowFeeRate.toString(),
        depositFeeRate: depositFeeRate.toString()
      }
    };

    if (detailLevel !== "full") {
      return baseResult;
    }

    if (poolTarget.kind === "erc20-pool") {
      const pool = ERC20Pool__factory.connect(poolTarget.poolAddress, provider);
      const [
        debtInfo,
        interestRateInfo,
        pledgedCollateral,
        poolType,
        quoteTokenScale,
        collateralScale,
        lenderMargin
      ] = await Promise.all([
        pool.debtInfo(),
        pool.interestRateInfo(),
        pool.pledgedCollateral(),
        pool.poolType(),
        pool.quoteTokenScale(),
        pool.collateralScale(),
        poolInfoUtils.lenderInterestMargin(poolTarget.poolAddress)
      ]);

      return {
        ...baseResult,
        full: {
          config: {
            poolType,
            quoteTokenScale: quoteTokenScale.toString(),
            collateralScale: collateralScale.toString()
          },
          rates: {
            borrowRate: interestRateInfo[0].toString(),
            lenderInterestMargin: lenderMargin.toString(),
            interestRateLastUpdated: new Date(interestRateInfo[1].toNumber() * 1000).toISOString()
          },
          debt: {
            debt: debtInfo[0].toString(),
            poolDebtInAuction: debtInfo[2].toString(),
            pendingInflator: loans.pendingInflator_.toString(),
            pendingInterestFactor: loans.pendingInterestFactor_.toString()
          },
          totals: {
            pledgedCollateral: pledgedCollateral.toString(),
            reserveAuctionPrice: reserves.auctionPrice_.toString(),
            reserveAuctionTimeRemaining: reserves.timeRemaining_.toString()
          }
        }
      };
    }

    const pool = ERC721Pool__factory.connect(poolTarget.poolAddress, provider);
    const [debtInfo, interestRateInfo, pledgedCollateral, poolType, quoteTokenScale, lenderMargin] =
      await Promise.all([
        pool.debtInfo(),
        pool.interestRateInfo(),
        pool.pledgedCollateral(),
        pool.poolType(),
        pool.quoteTokenScale(),
        poolInfoUtils.lenderInterestMargin(poolTarget.poolAddress)
      ]);

    return {
      ...baseResult,
      full: {
        config: {
          poolType,
          quoteTokenScale: quoteTokenScale.toString(),
          collateralScale: null
        },
        rates: {
          borrowRate: interestRateInfo[0].toString(),
          lenderInterestMargin: lenderMargin.toString(),
          interestRateLastUpdated: new Date(interestRateInfo[1].toNumber() * 1000).toISOString()
        },
        debt: {
          debt: debtInfo[0].toString(),
          poolDebtInAuction: debtInfo[2].toString(),
          pendingInflator: loans.pendingInflator_.toString(),
          pendingInterestFactor: loans.pendingInterestFactor_.toString()
        },
        totals: {
          pledgedCollateral: pledgedCollateral.toString(),
          reserveAuctionPrice: reserves.auctionPrice_.toString(),
          reserveAuctionTimeRemaining: reserves.timeRemaining_.toString()
        }
      }
    };
  }

  async inspectBucket(input: InspectBucketInput): Promise<BucketInspectionResult> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const poolTarget = await this.resolveInspectablePoolContext(input, network, provider);
    const poolInfoUtils = PoolInfoUtils__factory.connect(network.poolInfoUtils, provider);
    const bucketInfo = await poolInfoUtils.bucketInfo(poolTarget.poolAddress, input.bucketIndex);
    const collateralDust =
      poolTarget.kind === "erc20-pool"
        ? await ERC20Pool__factory.connect(poolTarget.poolAddress, provider).bucketCollateralDust(input.bucketIndex)
        : null;

    return {
      network: input.network,
      poolKind: poolTarget.kind,
      poolAddress: poolTarget.poolAddress,
      subsetHash: this.poolTargetSubsetHash(poolTarget),
      bucketIndex: input.bucketIndex,
      bucket: {
        price: bucketInfo.price_.toString(),
        quoteTokens: bucketInfo.quoteTokens_.toString(),
        collateral: bucketInfo.collateral_.toString(),
        bucketLP: bucketInfo.bucketLP_.toString(),
        scale: bucketInfo.scale_.toString(),
        exchangeRate: bucketInfo.exchangeRate_.toString(),
        collateralDust: collateralDust?.toString() ?? null
      }
    };
  }

  async inspectPosition(input: InspectPositionInput): Promise<Record<string, unknown>> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const poolTarget = await this.resolveInspectablePoolContext(input, network, provider);
    const owner = ethers.utils.getAddress(input.owner);
    const poolInfoUtils = PoolInfoUtils__factory.connect(network.poolInfoUtils, provider);

    if (input.positionType === "borrower") {
      const borrowerInfoPromise = poolInfoUtils.borrowerInfo(poolTarget.poolAddress, owner);

      if (poolTarget.kind === "erc20-pool") {
        const pool = ERC20Pool__factory.connect(poolTarget.poolAddress, provider);
        const [borrowerInfo, debtInfo] = await Promise.all([borrowerInfoPromise, pool.debtInfo()]);
        const debtInAuction = debtInfo[2];

        return {
          poolKind: poolTarget.kind,
          poolAddress: poolTarget.poolAddress,
          subsetHash: this.poolTargetSubsetHash(poolTarget),
          positionType: "borrower",
          owner,
          debt: borrowerInfo.debt_.toString(),
          collateral: borrowerInfo.collateral_.toString(),
          thresholdPrice: borrowerInfo.thresholdPrice_.toString(),
          neutralPrice: borrowerInfo.t0Np_.toString(),
          poolDebtInAuction: debtInAuction.toString(),
          collateralTokenIds: null
        };
      }

      const pool = ERC721Pool__factory.connect(poolTarget.poolAddress, provider);
      const [borrowerInfo, debtInfo, borrowerTokenIds] = await Promise.all([
        borrowerInfoPromise,
        pool.debtInfo(),
        pool.getBorrowerTokenIds(owner)
      ]);
      const debtInAuction = debtInfo[2];

      return {
        poolKind: poolTarget.kind,
        poolAddress: poolTarget.poolAddress,
        subsetHash: this.poolTargetSubsetHash(poolTarget),
        positionType: "borrower",
        owner,
        debt: borrowerInfo.debt_.toString(),
        collateral: borrowerInfo.collateral_.toString(),
        thresholdPrice: borrowerInfo.thresholdPrice_.toString(),
        neutralPrice: borrowerInfo.t0Np_.toString(),
        poolDebtInAuction: debtInAuction.toString(),
        collateralTokenIds: borrowerTokenIds.map((tokenId: BigNumber) => BigNumber.from(tokenId).toString())
      };
    }

    invariant(
      typeof input.bucketIndex === "number",
      "MISSING_BUCKET_INDEX",
      "Lender position inspection requires bucketIndex"
    );

    const pool =
      poolTarget.kind === "erc20-pool"
        ? ERC20Pool__factory.connect(poolTarget.poolAddress, provider)
        : ERC721Pool__factory.connect(poolTarget.poolAddress, provider);
    const lenderInfo = await pool.lenderInfo(input.bucketIndex, owner);
    const [lpBalance, depositTime] = lenderInfo;
    const [quoteRedeemable, collateralRedeemable] = await Promise.all([
      poolInfoUtils.lpToQuoteTokens(poolTarget.poolAddress, lpBalance, input.bucketIndex),
      poolInfoUtils.lpToCollateral(poolTarget.poolAddress, lpBalance, input.bucketIndex)
    ]);

    return {
      poolKind: poolTarget.kind,
      poolAddress: poolTarget.poolAddress,
      subsetHash: this.poolTargetSubsetHash(poolTarget),
      positionType: "lender",
      owner,
      bucketIndex: input.bucketIndex,
      lpBalance: lpBalance.toString(),
      depositTime: depositTime.toString(),
      quoteRedeemable: quoteRedeemable.toString(),
      collateralRedeemable: collateralRedeemable.toString()
    };
  }

  async prepareCreateErc20Pool(input: PrepareCreateErc20PoolInput): Promise<PreparedAction> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const collateralAddress = ethers.utils.getAddress(input.collateralAddress);
    const quoteAddress = ethers.utils.getAddress(input.quoteAddress);
    const interestRate = BigNumber.from(input.interestRate);
    invariant(
      collateralAddress !== quoteAddress,
      "INVALID_POOL_TOKENS",
      "Collateral and quote token addresses must differ"
    );
    await Promise.all([
      this.assertFungibleTokenCompatible(provider, collateralAddress, "ERC20 pool collateral token"),
      this.assertFungibleTokenCompatible(provider, quoteAddress, "ERC20 pool quote token")
    ]);

    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const factory = ERC20PoolFactory__factory.connect(network.erc20PoolFactory, provider);
    await this.assertFactoryInterestRateRange(factory, interestRate);

    const existingPoolAddress = await this.lookupDeployedPool(
      factory,
      ERC20_NON_SUBSET_HASH,
      collateralAddress,
      quoteAddress
    );
    invariant(
      existingPoolAddress === ethers.constants.AddressZero,
      "POOL_ALREADY_EXISTS",
      "Ajna ERC20 pool already exists for the provided token pair",
      {
        poolAddress: existingPoolAddress,
        collateralAddress,
        quoteAddress
      }
    );

    const tx = await this.prepareContractTransaction({
      contract: factory,
      methodName: "deployPool",
      args: [collateralAddress, quoteAddress, interestRate],
      from: actorAddress,
      label: "action"
    });
    const expiresAt = await this.expirationIso(provider, input.maxAgeSeconds);

    return finalizePreparedAction(
      {
        version: 1,
        kind: "create-erc20-pool",
        network: input.network,
        chainId: network.chainId,
        actorAddress,
        startingNonce,
        poolAddress: network.erc20PoolFactory,
        quoteAddress,
        collateralAddress,
        createdAt: new Date().toISOString(),
        expiresAt,
        transactions: [tx],
        metadata: {
          factoryAddress: network.erc20PoolFactory,
          interestRate: interestRate.toString(),
          subsetHash: ERC20_NON_SUBSET_HASH,
          collateralType: "erc20"
        }
      },
      this.runtime
    );
  }

  async prepareCreateErc721Pool(input: PrepareCreateErc721PoolInput): Promise<PreparedAction> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const collateralAddress = ethers.utils.getAddress(input.collateralAddress);
    const quoteAddress = ethers.utils.getAddress(input.quoteAddress);
    const interestRate = BigNumber.from(input.interestRate);
    invariant(
      collateralAddress !== quoteAddress,
      "INVALID_POOL_TOKENS",
      "Collateral and quote token addresses must differ"
    );
    await Promise.all([
      this.assertErc721Compatible(provider, collateralAddress, "ERC721 pool collateral token"),
      this.assertFungibleTokenCompatible(provider, quoteAddress, "ERC721 pool quote token")
    ]);

    const tokenIds = this.normalizeSubsetTokenIds(input.tokenIds);
    const subsetHash = this.computeErc721SubsetHash(tokenIds);
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const factory = ERC721PoolFactory__factory.connect(network.erc721PoolFactory, provider);
    await this.assertFactoryInterestRateRange(factory, interestRate);

    const existingPoolAddress = await this.lookupDeployedPool(
      factory,
      subsetHash,
      collateralAddress,
      quoteAddress
    );
    invariant(
      existingPoolAddress === ethers.constants.AddressZero,
      "POOL_ALREADY_EXISTS",
      "Ajna ERC721 pool already exists for the provided collateral, quote, and subset",
      {
        poolAddress: existingPoolAddress,
        collateralAddress,
        quoteAddress,
        subsetHash
      }
    );

    const tx = await this.prepareContractTransaction({
      contract: factory,
      methodName:
        tokenIds.length === 0
          ? "deployPool(address,address,uint256)"
          : "deployPool(address,address,uint256[],uint256)",
      args:
        tokenIds.length === 0
          ? [collateralAddress, quoteAddress, interestRate]
          : [collateralAddress, quoteAddress, tokenIds, interestRate],
      from: actorAddress,
      label: "action"
    });
    const expiresAt = await this.expirationIso(provider, input.maxAgeSeconds);

    return finalizePreparedAction(
      {
        version: 1,
        kind: "create-erc721-pool",
        network: input.network,
        chainId: network.chainId,
        actorAddress,
        startingNonce,
        poolAddress: network.erc721PoolFactory,
        quoteAddress,
        collateralAddress,
        createdAt: new Date().toISOString(),
        expiresAt,
        transactions: [tx],
        metadata: {
          factoryAddress: network.erc721PoolFactory,
          interestRate: interestRate.toString(),
          subsetHash,
          subsetSize: tokenIds.length,
          collateralType: tokenIds.length === 0 ? "erc721-collection" : "erc721-subset"
        }
      },
      this.runtime
    );
  }

  async prepareLend(input: PrepareLendInput): Promise<PreparedAction> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const amount = BigNumber.from(input.amount);
    const approvalMode = input.approvalMode ?? "exact";
    invariant(
      approvalMode === "exact",
      "UNSAFE_APPROVAL_MODE",
      "Coupled lend preparation only supports exact approvals"
    );
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const poolContext = input.poolAddress
      ? await this.loadAjnaErc20PoolContext(input.poolAddress, network, provider)
      : await this.loadAjnaErc20PoolContext(
          await this.resolvePoolAddress(input, network, provider),
          network,
          provider
        );
    const approvalAmount = this.convertWadAmountToTokenApproval(
      amount,
      poolContext.quoteTokenScale,
      "quote token"
    );
    const approval = await this.checkAllowance(
      provider,
      poolContext.quoteAddress,
      actorAddress,
      poolContext.poolAddress,
      approvalAmount
    );
    const expiry = (await this.latestTimestamp(provider)) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
    const transactions = [];

    if (approval.current.lt(approval.needed)) {
      transactions.push(
        ...(await this.buildErc20ApprovalTransactions({
          provider,
          tokenAddress: poolContext.quoteAddress,
          actorAddress,
          approvalTarget: poolContext.poolAddress,
          currentAllowance: approval.current,
          neededAllowance: approval.needed,
          approvalMode
        }))
      );
    }

    const expiresAt = await this.expirationIso(provider, input.ttlSeconds);
    const lendTx = await this.prepareContractTransaction({
      contract: ERC20Pool__factory.connect(poolContext.poolAddress, provider),
      methodName: "addQuoteToken",
      args: [amount, input.bucketIndex, expiry],
      from: actorAddress,
      label: "action",
      deferredVerification:
        transactions.length > 0
          ? {
              kind: "erc20-allowance-raise",
              tokenAddress: poolContext.quoteAddress,
              owner: actorAddress,
              spender: poolContext.poolAddress,
              requiredAllowance: approval.needed
            }
          : undefined
    });
    transactions.push(lendTx);

    return finalizePreparedAction(
      {
        version: 1,
        kind: "lend",
        network: input.network,
        chainId: network.chainId,
        actorAddress,
        startingNonce,
        poolAddress: poolContext.poolAddress,
        quoteAddress: poolContext.quoteAddress,
        collateralAddress: poolContext.collateralAddress,
        createdAt: new Date().toISOString(),
        expiresAt,
        transactions,
        metadata: {
          amount: amount.toString(),
          approvalAmount: approvalAmount.toString(),
          approvalAlreadySufficient: approval.current.gte(approval.needed),
          bucketIndex: input.bucketIndex,
          approvalMode
        }
      },
      this.runtime
    );
  }

  async prepareBorrow(input: PrepareBorrowInput): Promise<PreparedAction> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const amount = BigNumber.from(input.amount);
    const collateralAmount = BigNumber.from(input.collateralAmount);
    const approvalMode = input.approvalMode ?? "exact";
    invariant(
      approvalMode === "exact",
      "UNSAFE_APPROVAL_MODE",
      "Coupled borrow preparation only supports exact approvals"
    );
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const poolContext = input.poolAddress
      ? await this.loadAjnaErc20PoolContext(input.poolAddress, network, provider)
      : await this.loadAjnaErc20PoolContext(
          await this.resolvePoolAddress(input, network, provider),
          network,
          provider
        );
    const approvalAmount = this.convertWadAmountToTokenApproval(
      collateralAmount,
      poolContext.collateralScale,
      "collateral token"
    );
    const approval = await this.checkAllowance(
      provider,
      poolContext.collateralAddress,
      actorAddress,
      poolContext.poolAddress,
      approvalAmount
    );
    const expiresAt = await this.expirationIso(provider, input.maxAgeSeconds);
    const transactions = [];

    if (approval.current.lt(approval.needed)) {
      transactions.push(
        ...(await this.buildErc20ApprovalTransactions({
          provider,
          tokenAddress: poolContext.collateralAddress,
          actorAddress,
          approvalTarget: poolContext.poolAddress,
          currentAllowance: approval.current,
          neededAllowance: approval.needed,
          approvalMode
        }))
      );
    }

    const borrowTx = await this.prepareContractTransaction({
      contract: ERC20Pool__factory.connect(poolContext.poolAddress, provider),
      methodName: "drawDebt",
      args: [actorAddress, amount, input.limitIndex, collateralAmount],
      from: actorAddress,
      label: "action",
      deferredVerification:
        transactions.length > 0
          ? {
              kind: "erc20-allowance-raise",
              tokenAddress: poolContext.collateralAddress,
              owner: actorAddress,
              spender: poolContext.poolAddress,
              requiredAllowance: approval.needed
            }
          : undefined
    });
    transactions.push(borrowTx);

    return finalizePreparedAction(
      {
        version: 1,
        kind: "borrow",
        network: input.network,
        chainId: network.chainId,
        actorAddress,
        startingNonce,
        poolAddress: poolContext.poolAddress,
        quoteAddress: poolContext.quoteAddress,
        collateralAddress: poolContext.collateralAddress,
        createdAt: new Date().toISOString(),
        expiresAt,
        transactions,
        metadata: {
          amount: amount.toString(),
          collateralAmount: collateralAmount.toString(),
          approvalAmount: approvalAmount.toString(),
          approvalAlreadySufficient: approval.current.gte(approval.needed),
          limitIndex: input.limitIndex,
          approvalMode
        }
      },
      this.runtime
    );
  }

  async prepareApproveErc20(input: PrepareApproveErc20Input): Promise<PreparedAction> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const poolTarget = await this.loadAjnaPoolTargetContext(input.poolAddress, network, provider);
    const approvalTarget = poolTarget.poolAddress;
    const tokenAddress = ethers.utils.getAddress(input.tokenAddress);
    this.assertApproveErc20TokenMatchesPool(tokenAddress, poolTarget);
    const amount = BigNumber.from(input.amount);
    const approvalMode = input.approvalMode ?? "exact";
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const approval = await this.checkAllowance(provider, tokenAddress, actorAddress, approvalTarget, amount);
    const desiredAllowance = this.desiredErc20Allowance(amount, approvalMode);
    const expiresAt = await this.expirationIso(provider, input.maxAgeSeconds);
    const transactions = [];

    transactions.push(
      ...(await this.buildErc20ApprovalTransactions({
        provider,
        tokenAddress,
        actorAddress,
        approvalTarget,
        currentAllowance: approval.current,
        neededAllowance: approval.needed,
        approvalMode
      }))
    );

    invariant(
      transactions.length > 0,
      "APPROVAL_ALREADY_SATISFIED",
      "Requested ERC20 approval already matches the requested target state",
      {
        tokenAddress,
        approvalTarget,
        amount: amount.toString()
      }
    );

    return finalizePreparedAction(
      {
        version: 1,
        kind: "approve-erc20",
        network: input.network,
        chainId: network.chainId,
        actorAddress,
        startingNonce,
        poolAddress: approvalTarget,
        quoteAddress: tokenAddress,
        collateralAddress: tokenAddress,
        createdAt: new Date().toISOString(),
        expiresAt,
        transactions,
        metadata: {
          tokenStandard: "erc20",
          tokenAddress,
          approvalTarget,
          amount: amount.toString(),
          approvalMode,
          alreadyApproved: approval.current.eq(desiredAllowance)
        }
      },
      this.runtime
    );
  }

  async prepareApproveErc721(input: PrepareApproveErc721Input): Promise<PreparedAction> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const poolTarget = await this.loadAjnaPoolTargetContext(input.poolAddress, network, provider);
    const approvalTarget = poolTarget.poolAddress;
    const tokenAddress = ethers.utils.getAddress(input.tokenAddress);
    this.assertApproveErc721TokenMatchesPool(tokenAddress, poolTarget);
    const hasOperatorApprovalPreference = input.approveForAll !== undefined;
    const approveForAll = input.approveForAll ?? false;
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const token = new ethers.Contract(tokenAddress, ERC721_APPROVAL_ABI, provider);
    const expiresAt = await this.expirationIso(provider, input.maxAgeSeconds);
    const transactions = [];
    let alreadyApproved = false;
    let tokenIdMetadata: string | null = null;

    if (hasOperatorApprovalPreference) {
      alreadyApproved = (await token.isApprovedForAll(actorAddress, approvalTarget)) === approveForAll;

      if (!alreadyApproved) {
        const approveTx = await this.prepareContractTransaction({
          contract: token,
          methodName: "setApprovalForAll",
          args: [approvalTarget, approveForAll],
          from: actorAddress,
          label: "approval"
        });
        transactions.push(approveTx);
      }

      invariant(
        transactions.length > 0,
        "APPROVAL_ALREADY_SATISFIED",
        approveForAll
          ? "Requested ERC721 operator approval already matches the requested target state"
          : "Requested ERC721 operator revoke already matches the requested target state",
        {
          tokenAddress,
          approvalTarget,
          approveForAll
        }
      );
    } else {
      invariant(
        input.tokenId !== undefined,
        "MISSING_TOKEN_ID",
        "ERC721 approval requires tokenId unless approveForAll is explicitly set"
      );

      const tokenId = BigNumber.from(input.tokenId);
      tokenIdMetadata = tokenId.toString();
      await this.assertSubsetPoolTokenIdAllowed(poolTarget, provider, tokenId);
      const [approvedAddress, operatorApproved] = await Promise.all([
        token.getApproved(tokenId),
        token.isApprovedForAll(actorAddress, approvalTarget)
      ]);
      alreadyApproved =
        operatorApproved || ethers.utils.getAddress(approvedAddress) === approvalTarget;

      if (!alreadyApproved) {
        const approveTx = await this.prepareContractTransaction({
          contract: token,
          methodName: "approve",
          args: [approvalTarget, tokenId],
          from: actorAddress,
          label: "approval"
        });
        transactions.push(approveTx);
      }
    }

    invariant(
      transactions.length > 0,
      "APPROVAL_ALREADY_SATISFIED",
      hasOperatorApprovalPreference
        ? approveForAll
          ? "Requested ERC721 operator approval already matches the requested target state"
          : "Requested ERC721 operator revoke already matches the requested target state"
        : "Requested ERC721 approval already matches the requested target state",
      hasOperatorApprovalPreference
        ? {
            tokenAddress,
            approvalTarget,
            approveForAll
          }
        : {
            tokenAddress,
            approvalTarget,
            tokenId: tokenIdMetadata
          }
    );

    return finalizePreparedAction(
      {
        version: 1,
        kind: "approve-erc721",
        network: input.network,
        chainId: network.chainId,
        actorAddress,
        startingNonce,
        poolAddress: approvalTarget,
        quoteAddress: tokenAddress,
        collateralAddress: tokenAddress,
        createdAt: new Date().toISOString(),
        expiresAt,
        transactions,
        metadata: {
          tokenStandard: "erc721",
          tokenAddress,
          approvalTarget,
          tokenId: tokenIdMetadata,
          approveForAll: hasOperatorApprovalPreference ? approveForAll : null,
          approvalScope: hasOperatorApprovalPreference ? "operator" : "token",
          alreadyApproved
        }
      },
      this.runtime
    );
  }

  async prepareUnsupportedAjnaAction(input: PrepareUnsupportedAjnaActionInput): Promise<PreparedAction> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const contractAddress = await this.resolveUnsupportedContractAddress(input, network, provider);
    const resolvedMethod = this.resolveUnsupportedMethod(input);
    this.assertUnsafeArgsEncodable(resolvedMethod.abi, resolvedMethod.methodName, input.args, input.contractKind);
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const expiresAt = await this.expirationIso(provider, input.maxAgeSeconds);
    const contract = new ethers.Contract(contractAddress, resolvedMethod.abi, provider);
    const tx = await this.prepareContractTransaction({
      contract,
      methodName: resolvedMethod.methodName,
      args: input.args,
      from: actorAddress,
      label: "action",
      value: input.value
    });

    return finalizePreparedAction(
      {
        version: 1,
        kind: "unsupported-ajna-action",
        network: input.network,
        chainId: network.chainId,
        actorAddress,
        startingNonce,
        poolAddress: contractAddress,
        quoteAddress: contractAddress,
        collateralAddress: contractAddress,
        createdAt: new Date().toISOString(),
        expiresAt,
        transactions: [tx],
        metadata: {
          unsafe: true,
          contractKind: input.contractKind,
          contractAddress,
          abiFragment: resolvedMethod.abiFragment,
          methodName: resolvedMethod.methodName,
          requestedMethodName: input.methodName,
          abiSource: resolvedMethod.source,
          argsCount: input.args.length,
          value: BigNumber.from(input.value ?? 0).toString(),
          acknowledgement: UNSAFE_SDK_CALL_ACKNOWLEDGEMENT,
          notes: input.notes ?? null
        }
      },
      this.runtime
    );
  }

  private network(network: RuntimeNetworkConfig["network"]): RuntimeNetworkConfig {
    const config = this.runtime.networks[network];
    invariant(
      config,
      "MISSING_RPC_URL",
      `Missing RPC URL for ${network}`,
      {
        expected: [`AJNA_RPC_URL_${network.toUpperCase()}`, "AJNA_RPC_URL"]
      }
    );
    return config;
  }

  private async provider(network: RuntimeNetworkConfig): Promise<ethers.providers.JsonRpcProvider> {
    return buildNetworkProvider(network);
  }

  private async resolvePoolAddress(
    selector: InspectPoolInput | InspectPositionInput | PrepareLendInput | PrepareBorrowInput,
    network: RuntimeNetworkConfig,
    provider: ethers.providers.JsonRpcProvider
  ): Promise<string> {
    if (selector.poolAddress) {
      return (await this.loadAjnaErc20PoolContext(selector.poolAddress, network, provider)).poolAddress;
    }

    invariant(
      selector.collateralAddress && selector.quoteAddress,
      "MISSING_POOL_SELECTOR",
      "Provide either poolAddress or collateralAddress + quoteAddress"
    );

    const factory = ERC20PoolFactory__factory.connect(network.erc20PoolFactory, provider);
    const poolAddress = await this.lookupDeployedPool(
      factory,
      ERC20_NON_SUBSET_HASH,
      ethers.utils.getAddress(selector.collateralAddress),
      ethers.utils.getAddress(selector.quoteAddress)
    );

    invariant(
      poolAddress !== ethers.constants.AddressZero,
      "POOL_NOT_FOUND",
      "No Ajna ERC20 pool found for the provided token pair",
      {
        collateralAddress: selector.collateralAddress,
        quoteAddress: selector.quoteAddress
      }
    );

    return poolAddress;
  }

  private async resolveInspectablePoolContext(
    selector: InspectPoolInput | InspectBucketInput | InspectPositionInput,
    network: RuntimeNetworkConfig,
    provider: ethers.providers.JsonRpcProvider
  ): Promise<AjnaPoolTargetContext> {
    if (selector.poolAddress) {
      return this.loadAjnaPoolTargetContext(selector.poolAddress, network, provider);
    }

    invariant(
      selector.collateralAddress && selector.quoteAddress,
      "MISSING_POOL_SELECTOR",
      "Provide either poolAddress or collateralAddress + quoteAddress"
    );

    const collateralAddress = ethers.utils.getAddress(selector.collateralAddress);
    const quoteAddress = ethers.utils.getAddress(selector.quoteAddress);
    const erc20Factory = ERC20PoolFactory__factory.connect(network.erc20PoolFactory, provider);
    const erc20PoolAddress = await this.lookupDeployedPool(
      erc20Factory,
      ERC20_NON_SUBSET_HASH,
      collateralAddress,
      quoteAddress
    );

    if (erc20PoolAddress !== ethers.constants.AddressZero) {
      return this.loadAjnaErc20PoolContext(erc20PoolAddress, network, provider);
    }

    const erc721Factory = ERC721PoolFactory__factory.connect(network.erc721PoolFactory, provider);
    const erc721PoolAddress = await this.lookupDeployedPool(
      erc721Factory,
      ERC721_NON_SUBSET_HASH,
      collateralAddress,
      quoteAddress
    );

    if (erc721PoolAddress !== ethers.constants.AddressZero) {
      return this.loadAjnaErc721PoolContext(erc721PoolAddress, network, provider);
    }

    throw new AjnaSkillError(
      "POOL_NOT_FOUND",
      "No Ajna ERC20 or ERC721 collection pool found for the provided token pair",
      {
        collateralAddress,
        quoteAddress
      }
    );
  }

  private poolTargetSubsetHash(poolTarget: AjnaPoolTargetContext): string | null {
    return poolTarget.kind === "erc721-pool" ? poolTarget.subsetHash : null;
  }

  private async assertSubsetPoolTokenIdAllowed(
    poolTarget: AjnaPoolTargetContext,
    provider: ethers.providers.JsonRpcProvider,
    tokenId: BigNumber
  ): Promise<void> {
    if (poolTarget.kind !== "erc721-pool" || poolTarget.subsetHash === ERC721_NON_SUBSET_HASH) {
      return;
    }

    const pool = ERC721Pool__factory.connect(poolTarget.poolAddress, provider);
    const tokenAllowed = await pool.tokenIdsAllowed(tokenId);

    invariant(
      tokenAllowed,
      "INVALID_SUBSET_TOKEN_ID",
      "Provided tokenId is not allowed in the Ajna ERC721 subset pool",
      {
        poolAddress: poolTarget.poolAddress,
        tokenId: tokenId.toString()
      }
    );
  }

  private async readSymbol(
    tokenAddress: string,
    provider: ethers.providers.Provider
  ): Promise<string | null> {
    try {
      const callResult = await provider.call({
        to: tokenAddress,
        data: ERC20_SYMBOL_STRING_IFACE.encodeFunctionData("symbol")
      });

      try {
        const [symbol] = ERC20_SYMBOL_STRING_IFACE.decodeFunctionResult("symbol", callResult);
        return this.sanitizeSymbol(symbol);
      } catch {
        const [bytes32Symbol] = ERC20_SYMBOL_BYTES32_IFACE.decodeFunctionResult("symbol", callResult);
        return this.sanitizeSymbol(this.parseBytes32Symbol(bytes32Symbol));
      }
    } catch {
      return null;
    }
  }

  private parseBytes32Symbol(value: string): string {
    try {
      return ethers.utils.parseBytes32String(value);
    } catch {
      return value.replace(/\x00+$/g, "").trim();
    }
  }

  private async checkAllowance(
    provider: ethers.providers.Provider,
    tokenAddress: string,
    owner: string,
    spender: string,
    amount: BigNumber
  ): Promise<AllowanceCheck> {
    const token = ERC20__factory.connect(tokenAddress, provider);
    return {
      current: await token.allowance(owner, spender),
      needed: amount,
      approvalTarget: spender
    };
  }

  private async latestTimestamp(provider: ethers.providers.Provider): Promise<number> {
    const block = await provider.getBlock("latest");
    return block.timestamp;
  }

  private async expirationIso(
    _provider: ethers.providers.Provider,
    maxAgeSeconds: number = DEFAULT_PREPARED_MAX_AGE_SECONDS
  ): Promise<string> {
    return new Date(Date.now() + maxAgeSeconds * 1000).toISOString();
  }

  private async assertContractHasCode(
    provider: ethers.providers.Provider,
    address: string,
    label: string
  ): Promise<void> {
    const code = await provider.getCode(address);
    invariant(
      code !== "0x",
      "INVALID_POOL_TOKENS",
      `${label} must be a deployed contract`,
      {
        address
      }
    );
  }

  private async assertFungibleTokenCompatible(
    provider: ethers.providers.Provider,
    tokenAddress: string,
    label: string
  ): Promise<void> {
    await this.assertContractHasCode(provider, tokenAddress, label);
    const decimals = await ERC20__factory.connect(tokenAddress, provider).decimals();
    invariant(
      Number.isInteger(decimals) && decimals > 0 && decimals <= 18,
      "INVALID_POOL_TOKENS",
      `${label} must expose a constant decimals() between 1 and 18`,
      {
        tokenAddress,
        decimals
      }
    );
  }

  private async assertErc721Compatible(
    provider: ethers.providers.Provider,
    tokenAddress: string,
    label: string
  ): Promise<void> {
    await this.assertContractHasCode(provider, tokenAddress, label);

    let supportsErc721 = false;

    try {
      supportsErc721 = await ERC721__factory.connect(tokenAddress, provider).supportsInterface(
        ERC721_INTERFACE_ID
      );
    } catch {
      throw new AjnaSkillError("INVALID_POOL_TOKENS", `${label} must implement ERC721`, {
        tokenAddress
      });
    }

    invariant(supportsErc721, "INVALID_POOL_TOKENS", `${label} must implement ERC721`, {
      tokenAddress
    });
  }

  private sanitizeSymbol(symbol: string): string | null {
    const trimmed = symbol.trim();

    if (!trimmed) {
      return null;
    }

    return /^[A-Za-z0-9._+\-/]{1,32}$/.test(trimmed) ? trimmed : null;
  }

  private convertWadAmountToTokenApproval(
    wadAmount: BigNumber,
    tokenScale: BigNumber,
    tokenLabel: string
  ): BigNumber {
    invariant(tokenScale.gt(0), "INVALID_TOKEN_SCALE", "Ajna token scale must be greater than zero", {
      tokenLabel,
      tokenScale: tokenScale.toString()
    });
    invariant(
      wadAmount.mod(tokenScale).isZero(),
      "AMOUNT_NOT_SCALE_ALIGNED",
      `Ajna ${tokenLabel} amount must align exactly with token precision for exact approval`,
      {
        tokenLabel,
        amount: wadAmount.toString(),
        tokenScale: tokenScale.toString()
      }
    );

    return wadAmount.div(tokenScale);
  }

  private async buildErc20ApprovalTransactions({
    provider,
    tokenAddress,
    actorAddress,
    approvalTarget,
    currentAllowance,
    neededAllowance,
    approvalMode
  }: {
    provider: ethers.providers.Provider;
    tokenAddress: string;
    actorAddress: string;
    approvalTarget: string;
    currentAllowance: BigNumber;
    neededAllowance: BigNumber;
    approvalMode: "exact" | "max";
  }) {
    const desiredAllowance = this.desiredErc20Allowance(neededAllowance, approvalMode);

    if (currentAllowance.eq(desiredAllowance)) {
      return [];
    }

    const token = ERC20__factory.connect(tokenAddress, provider);
    const transactions = [];
    const requiresReset = !currentAllowance.isZero();

    if (requiresReset) {
      transactions.push(
        await this.prepareContractTransaction({
          contract: token,
          methodName: "approve",
          args: [approvalTarget, 0],
          from: actorAddress,
          label: "approval"
        })
      );
    }

    if (desiredAllowance.isZero()) {
      return transactions;
    }

    transactions.push(
      await this.prepareContractTransaction({
        contract: token,
        methodName: "approve",
        args: [approvalTarget, desiredAllowance],
        from: actorAddress,
        label: "approval",
        deferredVerification: requiresReset
          ? {
              kind: "erc20-allowance-reset",
              tokenAddress,
              owner: actorAddress,
              spender: approvalTarget,
              currentAllowance,
              desiredAllowance
            }
          : undefined
      })
    );

    return transactions;
  }

  private desiredErc20Allowance(
    neededAllowance: BigNumber,
    approvalMode: "exact" | "max"
  ): BigNumber {
    return approvalMode === "max" ? ethers.constants.MaxUint256 : neededAllowance;
  }

  private assertApproveErc20TokenMatchesPool(
    tokenAddress: string,
    poolTarget: AjnaPoolTargetContext
  ): void {
    if (poolTarget.kind === "erc20-pool") {
      invariant(
        tokenAddress === poolTarget.quoteAddress || tokenAddress === poolTarget.collateralAddress,
        "INVALID_APPROVAL_TOKEN",
        "ERC20 approval token must match the Ajna pool quote or collateral token",
        {
          tokenAddress,
          poolAddress: poolTarget.poolAddress,
          quoteAddress: poolTarget.quoteAddress,
          collateralAddress: poolTarget.collateralAddress
        }
      );
      return;
    }

    invariant(
      tokenAddress === poolTarget.quoteAddress,
      "INVALID_APPROVAL_TOKEN",
      "ERC721 pool ERC20 approval token must match the Ajna pool quote token",
      {
        tokenAddress,
        poolAddress: poolTarget.poolAddress,
        quoteAddress: poolTarget.quoteAddress
      }
    );
  }

  private assertApproveErc721TokenMatchesPool(
    tokenAddress: string,
    poolTarget: AjnaPoolTargetContext
  ): void {
    invariant(
      poolTarget.kind === "erc721-pool",
      "INVALID_APPROVAL_TOKEN",
      "ERC721 approvals are only valid for Ajna ERC721 pools",
      {
        tokenAddress,
        poolAddress: poolTarget.poolAddress
      }
    );

    invariant(
      tokenAddress === poolTarget.collateralAddress,
      "INVALID_APPROVAL_TOKEN",
      "ERC721 approval token must match the Ajna pool collateral collection",
      {
        tokenAddress,
        poolAddress: poolTarget.poolAddress,
        collateralAddress: poolTarget.collateralAddress
      }
    );
  }

  private async loadAjnaErc20PoolContext(
    poolAddress: string,
    network: RuntimeNetworkConfig,
    provider: ethers.providers.JsonRpcProvider
  ): Promise<Extract<AjnaPoolTargetContext, { kind: "erc20-pool" }>> {
    const normalizedPoolAddress = ethers.utils.getAddress(poolAddress);
    const pool = ERC20Pool__factory.connect(normalizedPoolAddress, provider);
    const [quoteAddress, collateralAddress, quoteTokenScale, collateralScale] = await Promise.all([
      pool.quoteTokenAddress(),
      pool.collateralAddress(),
      pool.quoteTokenScale(),
      pool.collateralScale()
    ]);
    const factory = ERC20PoolFactory__factory.connect(network.erc20PoolFactory, provider);
    this.assertCanonicalPoolDeployment(
      await this.lookupDeployedPool(factory, ERC20_NON_SUBSET_HASH, collateralAddress, quoteAddress),
      normalizedPoolAddress,
      "Provided poolAddress is not a deployed Ajna ERC20 pool",
      {
        poolAddress: normalizedPoolAddress,
        collateralAddress,
        quoteAddress
      }
    );

    return {
      kind: "erc20-pool",
      poolAddress: normalizedPoolAddress,
      quoteAddress,
      collateralAddress,
      quoteTokenScale,
      collateralScale
    };
  }

  private async loadAjnaErc721PoolContext(
    poolAddress: string,
    network: RuntimeNetworkConfig,
    provider: ethers.providers.JsonRpcProvider
  ): Promise<Extract<AjnaPoolTargetContext, { kind: "erc721-pool" }>> {
    const normalizedPoolAddress = ethers.utils.getAddress(poolAddress);
    const pool = ERC721Pool__factory.connect(normalizedPoolAddress, provider);
    const [quoteAddress, collateralAddress, isSubset] = await Promise.all([
      pool.quoteTokenAddress(),
      pool.collateralAddress(),
      pool.isSubset()
    ]);
    const factory = ERC721PoolFactory__factory.connect(network.erc721PoolFactory, provider);
    let subsetHash: string | null = null;

    if (isSubset) {
      const deployedPools = await this.loadErc721DeployedPools(factory);
      invariant(
        deployedPools.some((address) => address === normalizedPoolAddress),
        "INVALID_AJNA_POOL",
        "Provided poolAddress is not a deployed Ajna ERC721 subset pool",
        {
          poolAddress: normalizedPoolAddress,
          collateralAddress,
          quoteAddress
        }
      );

      try {
        subsetHash = await this.findErc721SubsetHashForPool(normalizedPoolAddress, network, provider);
      } catch {
        subsetHash = null;
      }
    } else {
      this.assertCanonicalPoolDeployment(
        await this.lookupDeployedPool(factory, ERC721_NON_SUBSET_HASH, collateralAddress, quoteAddress),
        normalizedPoolAddress,
        "Provided poolAddress is not a deployed Ajna ERC721 pool",
        {
          poolAddress: normalizedPoolAddress,
          collateralAddress,
          quoteAddress,
          subsetHash: ERC721_NON_SUBSET_HASH
        }
      );

      subsetHash = ERC721_NON_SUBSET_HASH;
    }

    return {
      kind: "erc721-pool",
      poolAddress: normalizedPoolAddress,
      quoteAddress,
      collateralAddress,
      subsetHash
    };
  }

  private async loadErc721DeployedPools(
    factory: ReturnType<typeof ERC721PoolFactory__factory.connect>
  ): Promise<string[]> {
    try {
      return (await factory.getDeployedPoolsList()).map((address) => ethers.utils.getAddress(address));
    } catch {
      throw new AjnaSkillError(
        "AJNA_POOL_VALIDATION_UNAVAILABLE",
        "Could not validate Ajna ERC721 pool membership from the factory",
        {
          factoryAddress: factory.address
        }
      );
    }
  }

  private async lookupDeployedPool(
    factory: {
      deployedPools: (
        subsetHash: string,
        collateralAddress: string,
        quoteAddress: string
      ) => Promise<string>;
    },
    subsetHash: string,
    collateralAddress: string,
    quoteAddress: string
  ): Promise<string> {
    return factory.deployedPools(subsetHash, collateralAddress, quoteAddress);
  }

  private assertCanonicalPoolDeployment(
    canonicalPoolAddress: string,
    poolAddress: string,
    message: string,
    details: Record<string, unknown>
  ): void {
    invariant(
      canonicalPoolAddress !== ethers.constants.AddressZero &&
        ethers.utils.getAddress(canonicalPoolAddress) === poolAddress,
      "INVALID_AJNA_POOL",
      message,
      details
    );
  }

  private async loadAjnaPoolTargetContext(
    poolAddress: string,
    network: RuntimeNetworkConfig,
    provider: ethers.providers.JsonRpcProvider
  ): Promise<AjnaPoolTargetContext> {
    try {
      return await this.loadAjnaErc20PoolContext(poolAddress, network, provider);
    } catch (error) {
      if (!this.shouldFallbackPoolTypeProbe(error)) {
        throw error;
      }
      // fall through to ERC721 validation
    }

    try {
      return await this.loadAjnaErc721PoolContext(poolAddress, network, provider);
    } catch (error) {
      if (!this.shouldFallbackPoolTypeProbe(error)) {
        throw error;
      }
      // fall through to the explicit error below
    }

    throw new AjnaSkillError(
      "INVALID_AJNA_POOL",
      "Approval target must be a real Ajna pool on the selected network",
      {
        poolAddress
      }
    );
  }

  private shouldFallbackPoolTypeProbe(error: unknown): boolean {
    if (error instanceof AjnaSkillError) {
      return error.code === "INVALID_AJNA_POOL";
    }

    if (typeof error === "object" && error !== null && "code" in error) {
      const code = String((error as { code?: unknown }).code ?? "");
      return code === "CALL_EXCEPTION" || code === "BAD_DATA";
    }

    return false;
  }

  private async findErc721SubsetHashForPool(
    poolAddress: string,
    network: RuntimeNetworkConfig,
    provider: ethers.providers.JsonRpcProvider
  ): Promise<string> {
    const iface = new ethers.utils.Interface(ERC721PoolFactory__factory.abi);
    const topic = iface.getEventTopic("PoolCreated");
    let logs: ethers.providers.Log[];

    try {
      logs = await provider.getLogs({
        address: network.erc721PoolFactory,
        topics: [topic],
        fromBlock: 0,
        toBlock: "latest"
      });
    } catch {
      throw new AjnaSkillError(
        "AJNA_POOL_VALIDATION_UNAVAILABLE",
        "Could not validate Ajna ERC721 pool subset hash from factory logs",
        {
          poolAddress,
          factoryAddress: network.erc721PoolFactory
        }
      );
    }

    for (const log of logs) {
      const parsed = iface.parseLog(log);
      const createdPoolAddress = ethers.utils.getAddress(parsed.args.pool_);
      if (createdPoolAddress === poolAddress) {
        return parsed.args.subsetHash_;
      }
    }

    throw new AjnaSkillError("INVALID_AJNA_POOL", "Could not resolve ERC721 Ajna pool subset hash", {
      poolAddress
    });
  }

  private resolveUnsupportedMethod(input: PrepareUnsupportedAjnaActionInput): {
    abi: UnsafeContractAbi;
    abiFragment: string;
    methodName: string;
    source: "builtin" | "fragment";
  } {
    const abi = UNSAFE_CONTRACT_ABIS[input.contractKind];
    const iface = new ethers.utils.Interface(abi);

    if (input.abiFragment) {
      const fragment = ethers.utils.FunctionFragment.from(input.abiFragment);
      const signature = fragment.format(ethers.utils.FormatTypes.sighash);
      const builtinFragment = iface.getFunction(signature);
      this.assertUnsafeMethodAllowed(input.contractKind, signature);

      return {
        abi,
        abiFragment: builtinFragment.format(ethers.utils.FormatTypes.full),
        methodName: signature,
        source: "fragment"
      };
    }

    if (input.methodName.includes("(")) {
      const fragment = iface.getFunction(input.methodName);
      const signature = fragment.format(ethers.utils.FormatTypes.sighash);
      this.assertUnsafeMethodAllowed(input.contractKind, signature);
      return {
        abi,
        abiFragment: fragment.format(ethers.utils.FormatTypes.full),
        methodName: signature,
        source: "builtin"
      };
    }

    const fragments = Object.values(iface.functions).filter((fragment) => fragment.name === input.methodName);
    invariant(
      fragments.length > 0,
      "UNSAFE_METHOD_NOT_FOUND",
      "Requested unsupported Ajna method was not found in the built-in ABI",
      {
        contractKind: input.contractKind,
        methodName: input.methodName
      }
    );
    invariant(
      fragments.length === 1,
      "UNSAFE_METHOD_AMBIGUOUS",
      "Requested unsupported Ajna method is overloaded; provide abiFragment or full method signature",
      {
        contractKind: input.contractKind,
        methodName: input.methodName,
        candidates: fragments.map((fragment) => fragment.format(ethers.utils.FormatTypes.sighash))
      }
    );
    const signature = fragments[0]!.format(ethers.utils.FormatTypes.sighash);
    this.assertUnsafeMethodAllowed(input.contractKind, signature);

    return {
      abi,
      abiFragment: fragments[0]!.format(ethers.utils.FormatTypes.full),
      methodName: signature,
      source: "builtin"
    };
  }

  private assertUnsafeMethodAllowed(
    contractKind: UnsupportedAjnaContractKind,
    methodSignature: string
  ): void {
    invariant(
      UNSAFE_ALLOWED_METHODS[contractKind].has(methodSignature),
      "UNSAFE_METHOD_DISALLOWED",
      "Requested unsupported Ajna method is outside the allowed Ajna-native escape hatch surface",
      {
        contractKind,
        methodSignature
      }
    );
  }

  private assertUnsafeArgsEncodable(
    abi: UnsafeContractAbi,
    methodSignature: string,
    args: Array<unknown>,
    contractKind: UnsupportedAjnaContractKind
  ): void {
    const iface = new ethers.utils.Interface(abi);

    try {
      iface.encodeFunctionData(methodSignature, args);
    } catch (error) {
      throw new AjnaSkillError(
        "UNSAFE_ARGUMENTS_INVALID",
        "Unsupported Ajna action arguments do not match the selected method ABI",
        {
          contractKind,
          methodSignature,
          reason: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  private normalizeSubsetTokenIds(tokenIds: string[] | undefined): string[] {
    if (!tokenIds || tokenIds.length === 0) {
      return [];
    }

    const sorted = tokenIds.map((tokenId) => BigNumber.from(tokenId)).sort((left, right) => {
      if (left.lt(right)) return -1;
      if (left.gt(right)) return 1;
      return 0;
    });

    for (let index = 1; index < sorted.length; index += 1) {
      invariant(
        !sorted[index]!.eq(sorted[index - 1]!),
        "DUPLICATE_TOKEN_ID",
        "ERC721 subset tokenIds must be unique"
      );
    }

    return sorted.map((tokenId) => tokenId.toString());
  }

  private computeErc721SubsetHash(tokenIds: string[]): string {
    if (tokenIds.length === 0) {
      return ERC721_NON_SUBSET_HASH;
    }

    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(["uint256[]"], [tokenIds.map((tokenId) => BigNumber.from(tokenId))])
    );
  }

  private async assertFactoryInterestRateRange(
    factory: {
      MIN_RATE: () => Promise<BigNumber>;
      MAX_RATE: () => Promise<BigNumber>;
    },
    interestRate: BigNumber
  ): Promise<void> {
    const [minRate, maxRate] = await Promise.all([factory.MIN_RATE(), factory.MAX_RATE()]);
    invariant(
      interestRate.gte(minRate) && interestRate.lte(maxRate),
      "INTEREST_RATE_OUT_OF_RANGE",
      "Ajna factory rejected the requested interest rate range",
      {
        interestRate: interestRate.toString(),
        minRate: minRate.toString(),
        maxRate: maxRate.toString()
      }
    );
  }

  private async prepareContractTransaction({
    contract,
    methodName,
    args,
    from,
    label,
    value,
    deferredVerification
  }: {
    contract: ethers.Contract;
    methodName: string;
    args: Array<unknown>;
    from: string;
    label: "approval" | "action";
    value?: string;
    deferredVerification?: DeferredVerificationPolicy;
  }) {
    const wrapped = (await createTransaction(
      contract,
      {
        methodName,
        args
      },
      {
        from,
        ...(value !== undefined ? { value } : {})
      }
    )) as TransactionLike;

    const tx = wrapped._transaction;
    invariant(tx, "SDK_TRANSACTION_PRIVATE_SHAPE", "Ajna SDK transaction did not expose populated transaction");

    let gasEstimate: BigNumber | undefined;

    try {
      gasEstimate = await wrapped.verify();
    } catch (error) {
      const canDefer = await this.canDeferVerification(error, contract.provider, deferredVerification);
      if (!canDefer) {
        throw new AjnaSkillError(
          "PREPARE_VERIFICATION_FAILED",
          "Prepared transaction failed verification before it was signed",
          {
            label,
            reason: error instanceof Error ? error.message : String(error)
          }
        );
      }
    }

    return {
      label,
      target: tx.to ? ethers.utils.getAddress(tx.to) : contract.address,
      value: BigNumber.from(tx.value ?? 0).toString(),
      data: tx.data?.toString() ?? "0x",
      from,
      nonce:
        tx.nonce === undefined
          ? undefined
          : typeof tx.nonce === "number"
            ? tx.nonce
            : BigNumber.from(tx.nonce).toNumber(),
      gasEstimate: gasEstimate?.toString()
    };
  }

  private async canDeferVerification(
    error: unknown,
    provider: ethers.providers.Provider | undefined,
    deferredVerification?: DeferredVerificationPolicy
  ): Promise<boolean> {
    if (!deferredVerification || !provider) {
      return false;
    }

    switch (deferredVerification.kind) {
      case "erc20-allowance-raise": {
        if (!this.isKnownAllowanceRaiseVerificationFailure(error)) {
          return false;
        }

        const allowance = await ERC20__factory
          .connect(deferredVerification.tokenAddress, provider)
          .allowance(deferredVerification.owner, deferredVerification.spender);
        return allowance.lt(deferredVerification.requiredAllowance);
      }
      case "erc20-allowance-reset": {
        if (!this.isKnownAllowanceResetVerificationFailure(error)) {
          return false;
        }

        const allowance = await ERC20__factory
          .connect(deferredVerification.tokenAddress, provider)
          .allowance(deferredVerification.owner, deferredVerification.spender);
        return (
          deferredVerification.currentAllowance.gt(0) &&
          deferredVerification.desiredAllowance.gt(0) &&
          allowance.eq(deferredVerification.currentAllowance)
        );
      }
    }
  }

  private isKnownAllowanceRaiseVerificationFailure(error: unknown): boolean {
    return this.matchesKnownSdkReason(error, ALLOWANCE_RAISE_SDK_REASONS);
  }

  private isKnownAllowanceResetVerificationFailure(error: unknown): boolean {
    return this.matchesKnownSdkReason(error, ALLOWANCE_RESET_SDK_REASONS);
  }

  private matchesKnownSdkReason(error: unknown, expectedReasons: Set<string>): boolean {
    return error instanceof SdkError && expectedReasons.has(error.message);
  }

  private async resolveUnsupportedContractAddress(
    input: PrepareUnsupportedAjnaActionInput,
    network: RuntimeNetworkConfig,
    provider: ethers.providers.JsonRpcProvider
  ): Promise<string> {
    switch (input.contractKind) {
      case "position-manager":
        if (input.contractAddress) {
          invariant(
            ethers.utils.getAddress(input.contractAddress) === network.positionManager,
            "UNSUPPORTED_CONTRACT_MISMATCH",
            "Position manager address must match the built-in Ajna preset",
            {
              expected: network.positionManager,
              received: input.contractAddress
            }
          );
        }
        return network.positionManager;
      case "ajna-token":
        if (input.contractAddress) {
          invariant(
            ethers.utils.getAddress(input.contractAddress) === network.ajnaToken,
            "UNSUPPORTED_CONTRACT_MISMATCH",
            "Ajna token address must match the built-in Ajna preset",
            {
              expected: network.ajnaToken,
              received: input.contractAddress
            }
          );
        }
        return network.ajnaToken;
      case "erc20-pool": {
        return (await this.loadAjnaErc20PoolContext(
          this.requireUnsupportedContractAddress(input),
          network,
          provider
        )).poolAddress;
      }
      case "erc721-pool": {
        return (await this.loadAjnaErc721PoolContext(
          this.requireUnsupportedContractAddress(input),
          network,
          provider
        )).poolAddress;
      }
      default:
        return this.assertNeverUnsupportedContractKind(input.contractKind);
    }
  }

  private requireUnsupportedContractAddress(input: PrepareUnsupportedAjnaActionInput): string {
    invariant(
      input.contractAddress,
      "MISSING_CONTRACT_ADDRESS",
      `${input.contractKind} requires contractAddress`
    );
    return ethers.utils.getAddress(input.contractAddress);
  }

  private assertNeverUnsupportedContractKind(kind: never): never {
    throw new AjnaSkillError("UNSUPPORTED_CONTRACT_KIND", "Unsupported Ajna contract kind", {
      contractKind: kind
    });
  }
}

export async function resolveCreatedPoolAddress(
  provider: ethers.providers.JsonRpcProvider,
  network: RuntimeNetworkConfig,
  preparedAction: PreparedAction
): Promise<string | undefined> {
  if (preparedAction.kind === "create-erc20-pool") {
    const factory = ERC20PoolFactory__factory.connect(network.erc20PoolFactory, provider);
    const poolAddress = await factory.deployedPools(
      ERC20_NON_SUBSET_HASH,
      preparedAction.collateralAddress,
      preparedAction.quoteAddress
    );
    return poolAddress === ethers.constants.AddressZero ? undefined : poolAddress;
  }

  if (preparedAction.kind === "create-erc721-pool") {
    const subsetHash = preparedAction.metadata.subsetHash;
    invariant(
      typeof subsetHash === "string" && subsetHash.length > 0,
      "POOL_RESOLUTION_FAILED",
      "Prepared ERC721 pool creation is missing subset hash metadata"
    );
    const factory = ERC721PoolFactory__factory.connect(network.erc721PoolFactory, provider);
    const poolAddress = await factory.deployedPools(
      subsetHash,
      preparedAction.collateralAddress,
      preparedAction.quoteAddress
    );
    return poolAddress === ethers.constants.AddressZero ? undefined : poolAddress;
  }

  return undefined;
}

export async function buildNetworkProvider(
  network: RuntimeNetworkConfig
): Promise<ethers.providers.JsonRpcProvider> {
  const provider = new ethers.providers.JsonRpcProvider(network.rpcUrl, network.chainId);
  await assertProviderMatchesNetwork(provider, network);
  return provider;
}

export async function assertProviderMatchesNetwork(
  provider: Pick<ethers.providers.JsonRpcProvider, "getNetwork">,
  network: RuntimeNetworkConfig
): Promise<void> {
  const actualNetwork = await provider.getNetwork();

  invariant(
    actualNetwork.chainId === network.chainId,
    "RPC_CHAIN_MISMATCH",
    `RPC URL for ${network.network} resolved to the wrong chain`,
    {
      network: network.network,
      expectedChainId: network.chainId,
      actualChainId: actualNetwork.chainId,
      actualName: actualNetwork.name
    }
  );
}
