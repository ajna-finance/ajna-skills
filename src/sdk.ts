import {
  Config,
  ERC20Pool__factory,
  ERC20PoolFactory__factory,
  ERC20__factory,
  PoolInfoUtils__factory,
  createTransaction
} from "@ajna-finance/sdk";
import { BigNumber, ethers } from "ethers";

import { DEFAULT_PREPARED_MAX_AGE_SECONDS, DEFAULT_TTL_SECONDS, ERC20_NON_SUBSET_HASH } from "./constants.js";
import { AjnaSkillError, invariant } from "./errors.js";
import { finalizePreparedAction } from "./prepared.js";
import type {
  AllowanceCheck,
  InspectPoolInput,
  InspectPositionInput,
  PoolInspectionResult,
  PreparedAction,
  PrepareApproveErc20Input,
  PrepareApproveErc721Input,
  PrepareBorrowInput,
  PrepareLendInput,
  RuntimeConfig,
  RuntimeNetworkConfig
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

export class AjnaAdapter {
  constructor(private readonly runtime: RuntimeConfig) {}

  async inspectPool(input: InspectPoolInput): Promise<PoolInspectionResult> {
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

    return {
      network: input.network,
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

  private async prepareContractTransaction({
    contract,
    methodName,
    args,
    from,
    label
  }: {
    contract: ethers.Contract;
    methodName: string;
    args: Array<unknown>;
    from: string;
    label: "approval" | "action";
  }) {
    const wrapped = (await createTransaction(contract, {
      methodName,
      args
    }, { from })) as TransactionLike;

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
