import {
  AjnaToken__factory,
  Config,
  ERC20Pool__factory,
  ERC20PoolFactory__factory,
  ERC721Pool__factory,
  ERC721PoolFactory__factory,
  ERC20__factory,
  PoolInfoUtils__factory,
  PositionManager__factory,
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

const ERC721_APPROVAL_ABI = [
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)"
] as const;
type UnsafeContractAbi = ReadonlyArray<any>;
const UNSAFE_CONTRACT_ABIS: Record<UnsupportedAjnaContractKind, UnsafeContractAbi> = {
  "erc20-pool": ERC20Pool__factory.abi,
  "erc721-pool": ERC721Pool__factory.abi,
  "position-manager": PositionManager__factory.abi,
  "ajna-token": AjnaToken__factory.abi
};

export class AjnaAdapter {
  constructor(private readonly runtime: RuntimeConfig) {}

  async inspectPool(input: InspectPoolInput): Promise<PoolInspectionResult> {
    const detailLevel = input.detailLevel ?? "basic";
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const poolAddress = await this.resolvePoolAddress(input, network, provider);
    const pool = ERC20Pool__factory.connect(poolAddress, provider);
    const poolInfoUtils = PoolInfoUtils__factory.connect(network.poolInfoUtils, provider);

    const [collateralAddress, quoteAddress, prices, loans, utilization, reserves, borrowFeeRate, depositFeeRate] =
      await Promise.all([
        pool.collateralAddress(),
        pool.quoteTokenAddress(),
        poolInfoUtils.poolPricesInfo(poolAddress),
        poolInfoUtils.poolLoansInfo(poolAddress),
        poolInfoUtils.poolUtilizationInfo(poolAddress),
        poolInfoUtils.poolReservesInfo(poolAddress),
        poolInfoUtils.borrowFeeRate(poolAddress),
        poolInfoUtils.depositFeeRate(poolAddress)
      ]);

    const baseResult: PoolInspectionResult = {
      network: input.network,
      detailLevel,
      poolAddress,
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

    const [debtInfo, interestRateInfo, pledgedCollateral, poolType, quoteTokenScale, collateralScale, lenderMargin] =
      await Promise.all([
        pool.debtInfo(),
        pool.interestRateInfo(),
        pool.pledgedCollateral(),
        pool.poolType(),
        pool.quoteTokenScale(),
        pool.collateralScale(),
        poolInfoUtils.lenderInterestMargin(poolAddress)
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

  async inspectBucket(input: InspectBucketInput): Promise<BucketInspectionResult> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const poolAddress = await this.resolvePoolAddress(input, network, provider);
    const pool = ERC20Pool__factory.connect(poolAddress, provider);
    const poolInfoUtils = PoolInfoUtils__factory.connect(network.poolInfoUtils, provider);
    const [bucketInfo, collateralDust] = await Promise.all([
      poolInfoUtils.bucketInfo(poolAddress, input.bucketIndex),
      pool.bucketCollateralDust(input.bucketIndex)
    ]);

    return {
      network: input.network,
      poolAddress,
      bucketIndex: input.bucketIndex,
      bucket: {
        price: bucketInfo.price_.toString(),
        quoteTokens: bucketInfo.quoteTokens_.toString(),
        collateral: bucketInfo.collateral_.toString(),
        bucketLP: bucketInfo.bucketLP_.toString(),
        scale: bucketInfo.scale_.toString(),
        exchangeRate: bucketInfo.exchangeRate_.toString(),
        collateralDust: collateralDust.toString()
      }
    };
  }

  async inspectPosition(input: InspectPositionInput): Promise<Record<string, unknown>> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const poolAddress = await this.resolvePoolAddress(input, network, provider);
    const owner = ethers.utils.getAddress(input.owner);
    const pool = ERC20Pool__factory.connect(poolAddress, provider);
    const poolInfoUtils = PoolInfoUtils__factory.connect(network.poolInfoUtils, provider);

    if (input.positionType === "borrower") {
      const [borrowerInfo, debtInfo] = await Promise.all([
        poolInfoUtils.borrowerInfo(poolAddress, owner),
        pool.debtInfo()
      ]);
      const debtInAuction = debtInfo[2];

      return {
        positionType: "borrower",
        owner,
        debt: borrowerInfo.debt_.toString(),
        collateral: borrowerInfo.collateral_.toString(),
        thresholdPrice: borrowerInfo.thresholdPrice_.toString(),
        neutralPrice: borrowerInfo.t0Np_.toString(),
        poolDebtInAuction: debtInAuction.toString()
      };
    }

    invariant(
      typeof input.bucketIndex === "number",
      "MISSING_BUCKET_INDEX",
      "Lender position inspection requires bucketIndex"
    );

    const lenderInfo = await pool.lenderInfo(input.bucketIndex, owner);
    const [lpBalance, depositTime] = lenderInfo;
    const [quoteRedeemable, collateralRedeemable] = await Promise.all([
      poolInfoUtils.lpToQuoteTokens(poolAddress, lpBalance, input.bucketIndex),
      poolInfoUtils.lpToCollateral(poolAddress, lpBalance, input.bucketIndex)
    ]);

    return {
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

    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const factory = ERC20PoolFactory__factory.connect(network.erc20PoolFactory, provider);
    await this.assertFactoryInterestRateRange(factory, interestRate);

    const existingPoolAddress = await factory.deployedPools(ERC20_NON_SUBSET_HASH, collateralAddress, quoteAddress);
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
    const expiresAt = new Date(
      Date.now() + (input.maxAgeSeconds ?? DEFAULT_PREPARED_MAX_AGE_SECONDS) * 1000
    ).toISOString();

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

    const tokenIds = this.normalizeSubsetTokenIds(input.tokenIds);
    const subsetHash = this.computeErc721SubsetHash(tokenIds);
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const factory = ERC721PoolFactory__factory.connect(network.erc721PoolFactory, provider);
    await this.assertFactoryInterestRateRange(factory, interestRate);

    const existingPoolAddress = await factory.deployedPools(subsetHash, collateralAddress, quoteAddress);
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
      methodName: "deployPool(address,address,uint256[],uint256)",
      args: [collateralAddress, quoteAddress, tokenIds, interestRate],
      from: actorAddress,
      label: "action"
    });
    const expiresAt = new Date(
      Date.now() + (input.maxAgeSeconds ?? DEFAULT_PREPARED_MAX_AGE_SECONDS) * 1000
    ).toISOString();

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
    const poolAddress = await this.resolvePoolAddress(input, network, provider);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const amount = BigNumber.from(input.amount);
    const approvalMode = input.approvalMode ?? "exact";
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const pool = ERC20Pool__factory.connect(poolAddress, provider);
    const quoteAddress = await pool.quoteTokenAddress();
    const collateralAddress = await pool.collateralAddress();
    const approval = await this.checkAllowance(provider, quoteAddress, actorAddress, poolAddress, amount);
    const expiry = (await this.latestTimestamp(provider)) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
    const transactions = [];

    if (approval.current.lt(approval.needed)) {
      const approveTx = await this.prepareContractTransaction({
        contract: ERC20__factory.connect(quoteAddress, provider),
        methodName: "approve",
        args: [approval.approvalTarget, approvalMode === "max" ? ethers.constants.MaxUint256 : amount],
        from: actorAddress,
        label: "approval"
      });
      transactions.push(approveTx);
    }

    const lendTx = await this.prepareContractTransaction({
      contract: pool,
      methodName: "addQuoteToken",
      args: [amount, input.bucketIndex, expiry],
      from: actorAddress,
      label: "action"
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
        poolAddress,
        quoteAddress,
        collateralAddress,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(expiry * 1000).toISOString(),
        transactions,
        metadata: {
          amount: amount.toString(),
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
    const poolAddress = await this.resolvePoolAddress(input, network, provider);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const amount = BigNumber.from(input.amount);
    const collateralAmount = BigNumber.from(input.collateralAmount);
    const approvalMode = input.approvalMode ?? "exact";
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const pool = ERC20Pool__factory.connect(poolAddress, provider);
    const quoteAddress = await pool.quoteTokenAddress();
    const collateralAddress = await pool.collateralAddress();
    const approval = await this.checkAllowance(
      provider,
      collateralAddress,
      actorAddress,
      poolAddress,
      collateralAmount
    );
    const expiresAt = new Date(
      Date.now() + (input.maxAgeSeconds ?? DEFAULT_PREPARED_MAX_AGE_SECONDS) * 1000
    ).toISOString();
    const transactions = [];

    if (approval.current.lt(approval.needed) && !collateralAmount.isZero()) {
      const approveTx = await this.prepareContractTransaction({
        contract: ERC20__factory.connect(collateralAddress, provider),
        methodName: "approve",
        args: [approval.approvalTarget, approvalMode === "max" ? ethers.constants.MaxUint256 : collateralAmount],
        from: actorAddress,
        label: "approval"
      });
      transactions.push(approveTx);
    }

    const borrowTx = await this.prepareContractTransaction({
      contract: pool,
      methodName: "drawDebt",
      args: [actorAddress, amount, input.limitIndex, collateralAmount],
      from: actorAddress,
      label: "action"
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
        poolAddress,
        quoteAddress,
        collateralAddress,
        createdAt: new Date().toISOString(),
        expiresAt,
        transactions,
        metadata: {
          amount: amount.toString(),
          collateralAmount: collateralAmount.toString(),
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
    const approvalTarget = ethers.utils.getAddress(input.poolAddress);
    const tokenAddress = ethers.utils.getAddress(input.tokenAddress);
    const amount = BigNumber.from(input.amount);
    const approvalMode = input.approvalMode ?? "exact";
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const approval = await this.checkAllowance(provider, tokenAddress, actorAddress, approvalTarget, amount);
    const expiresAt = new Date(
      Date.now() + (input.maxAgeSeconds ?? DEFAULT_PREPARED_MAX_AGE_SECONDS) * 1000
    ).toISOString();
    const transactions = [];

    if (approval.current.lt(approval.needed)) {
      const approveTx = await this.prepareContractTransaction({
        contract: ERC20__factory.connect(tokenAddress, provider),
        methodName: "approve",
        args: [approval.approvalTarget, approvalMode === "max" ? ethers.constants.MaxUint256 : amount],
        from: actorAddress,
        label: "approval"
      });
      transactions.push(approveTx);
    }

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
          alreadyApproved: approval.current.gte(approval.needed)
        }
      },
      this.runtime
    );
  }

  async prepareApproveErc721(input: PrepareApproveErc721Input): Promise<PreparedAction> {
    const network = this.network(input.network);
    const provider = await this.provider(network);
    const actorAddress = ethers.utils.getAddress(input.actorAddress);
    const approvalTarget = ethers.utils.getAddress(input.poolAddress);
    const tokenAddress = ethers.utils.getAddress(input.tokenAddress);
    const approveForAll = input.approveForAll ?? false;
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const token = new ethers.Contract(tokenAddress, ERC721_APPROVAL_ABI, provider);
    const expiresAt = new Date(
      Date.now() + (input.maxAgeSeconds ?? DEFAULT_PREPARED_MAX_AGE_SECONDS) * 1000
    ).toISOString();
    const transactions = [];

    if (approveForAll) {
      const alreadyApproved = await token.isApprovedForAll(actorAddress, approvalTarget);

      if (!alreadyApproved) {
        const approveTx = await this.prepareContractTransaction({
          contract: token,
          methodName: "setApprovalForAll",
          args: [approvalTarget, true],
          from: actorAddress,
          label: "approval"
        });
        transactions.push(approveTx);
      }

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
            approveForAll: true,
            alreadyApproved
          }
        },
        this.runtime
      );
    }

    invariant(
      input.tokenId !== undefined,
      "MISSING_TOKEN_ID",
      "ERC721 approval requires tokenId unless approveForAll is true"
    );

    const tokenId = BigNumber.from(input.tokenId);
    const [approvedAddress, operatorApproved] = await Promise.all([
      token.getApproved(tokenId),
      token.isApprovedForAll(actorAddress, approvalTarget)
    ]);
    const alreadyApproved =
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
          tokenId: tokenId.toString(),
          approveForAll: false,
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
    const startingNonce = await provider.getTransactionCount(actorAddress, "pending");
    const expiresAt = new Date(
      Date.now() + (input.maxAgeSeconds ?? DEFAULT_PREPARED_MAX_AGE_SECONDS) * 1000
    ).toISOString();
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
    Config.poolUtils = network.poolInfoUtils;
    Config.erc20PoolFactory = network.erc20PoolFactory;
    Config.erc721PoolFactory = network.erc721PoolFactory;
    Config.positionManager = network.positionManager;
    Config.ajnaToken = network.ajnaToken;

    const provider = new ethers.providers.JsonRpcProvider(network.rpcUrl, network.chainId);
    await assertProviderMatchesNetwork(provider, network);
    return provider;
  }

  private async resolvePoolAddress(
    selector: InspectPoolInput | InspectPositionInput | PrepareLendInput | PrepareBorrowInput,
    network: RuntimeNetworkConfig,
    provider: ethers.providers.JsonRpcProvider
  ): Promise<string> {
    if (selector.poolAddress) {
      return ethers.utils.getAddress(selector.poolAddress);
    }

    invariant(
      selector.collateralAddress && selector.quoteAddress,
      "MISSING_POOL_SELECTOR",
      "Provide either poolAddress or collateralAddress + quoteAddress"
    );

    const factory = ERC20PoolFactory__factory.connect(network.erc20PoolFactory, provider);
    const poolAddress = await factory.deployedPools(
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

  private async readSymbol(
    tokenAddress: string,
    provider: ethers.providers.Provider
  ): Promise<string | null> {
    try {
      return await ERC20__factory.connect(tokenAddress, provider).symbol();
    } catch {
      return null;
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

      return {
        abi,
        abiFragment: builtinFragment.format(ethers.utils.FormatTypes.full),
        methodName: signature,
        source: "fragment"
      };
    }

    if (input.methodName.includes("(")) {
      const fragment = iface.getFunction(input.methodName);
      return {
        abi,
        abiFragment: fragment.format(ethers.utils.FormatTypes.full),
        methodName: fragment.format(ethers.utils.FormatTypes.sighash),
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

    return {
      abi,
      abiFragment: fragments[0]!.format(ethers.utils.FormatTypes.full),
      methodName: fragments[0]!.format(ethers.utils.FormatTypes.sighash),
      source: "builtin"
    };
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
    value
  }: {
    contract: ethers.Contract;
    methodName: string;
    args: Array<unknown>;
    from: string;
    label: "approval" | "action";
    value?: string;
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
    let verificationError: string | undefined;

    try {
      gasEstimate = await wrapped.verify();
    } catch (error) {
      verificationError = error instanceof Error ? error.message : String(error);
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
      gasEstimate: gasEstimate?.toString(),
      verificationError
    };
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
        const poolAddress = this.requireUnsupportedContractAddress(input);
        const pool = ERC20Pool__factory.connect(poolAddress, provider);
        await Promise.all([pool.quoteTokenAddress(), pool.collateralAddress()]);
        return poolAddress;
      }
      case "erc721-pool": {
        const poolAddress = this.requireUnsupportedContractAddress(input);
        const pool = ERC721Pool__factory.connect(poolAddress, provider);
        await Promise.all([pool.quoteTokenAddress(), pool.collateralAddress()]);
        return poolAddress;
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
