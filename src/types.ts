import type { BigNumber } from "ethers";

export type AjnaNetwork = "base" | "ethereum";
export type AjnaSkillMode = "inspect" | "prepare" | "execute";
export type PositionType = "borrower" | "lender";
export type ActionKind =
  | "inspect-pool"
  | "inspect-position"
  | "prepare-lend"
  | "prepare-borrow"
  | "execute-prepared";

export interface PoolSelector {
  network: AjnaNetwork;
  poolAddress?: string;
  collateralAddress?: string;
  quoteAddress?: string;
}

export interface InspectPoolInput extends PoolSelector {}

export interface InspectPositionInput extends PoolSelector {
  owner: string;
  positionType: PositionType;
  bucketIndex?: number;
}

export interface PrepareLendInput extends PoolSelector {
  actorAddress: string;
  amount: string;
  bucketIndex: number;
  ttlSeconds?: number;
  approvalMode?: "exact" | "max";
}

export interface PrepareBorrowInput extends PoolSelector {
  actorAddress: string;
  amount: string;
  collateralAmount: string;
  limitIndex: number;
  approvalMode?: "exact" | "max";
  maxAgeSeconds?: number;
}

export interface ExecutePreparedInput {
  preparedAction: PreparedAction;
  confirmations?: number;
}

export interface PreparedTransaction {
  label: "approval" | "action";
  target: string;
  value: string;
  data: string;
  from?: string;
  nonce?: number;
  gasEstimate?: string;
  verificationError?: string;
}

export interface PreparedAction {
  version: 1;
  kind: "lend" | "borrow";
  network: AjnaNetwork;
  chainId: number;
  actorAddress: string;
  startingNonce: number;
  poolAddress: string;
  quoteAddress: string;
  collateralAddress: string;
  createdAt: string;
  expiresAt: string;
  transactions: PreparedTransaction[];
  metadata: Record<string, string | number | boolean | null>;
  digest: string;
  signature: string | null;
}

export interface RuntimeNetworkConfig {
  network: AjnaNetwork;
  chainId: number;
  rpcUrl: string;
  ajnaToken: string;
  erc20PoolFactory: string;
  erc721PoolFactory: string;
  poolInfoUtils: string;
  positionManager: string;
}

export interface RuntimeConfig {
  mode: AjnaSkillMode;
  signerPrivateKey?: string;
  executeSignerAddress?: string;
  networks: Partial<Record<AjnaNetwork, RuntimeNetworkConfig>>;
}

export interface SuccessEnvelope<T> {
  ok: true;
  result: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface PoolInspectionResult {
  network: AjnaNetwork;
  poolAddress: string;
  collateralAddress: string;
  collateralSymbol: string | null;
  quoteAddress: string;
  quoteSymbol: string | null;
  prices: {
    hpb: string;
    hpbIndex: number;
    htp: string;
    htpIndex: number;
    lup: string;
    lupIndex: number;
  };
  pool: {
    poolSize: string;
    loansCount: number;
    minDebtAmount: string;
    collateralization: string;
    actualUtilization: string;
    targetUtilization: string;
    reserves: string;
    claimableReserves: string;
    claimableReservesRemaining: string;
    borrowFeeRate: string;
    depositFeeRate: string;
  };
}

export interface BorrowerInspectionResult {
  positionType: "borrower";
  owner: string;
  debt: string;
  collateral: string;
  thresholdPrice: string;
  neutralPrice: string;
  poolDebtInAuction: string;
}

export interface LenderInspectionResult {
  positionType: "lender";
  owner: string;
  bucketIndex: number;
  lpBalance: string;
  depositTime: string;
  quoteRedeemable: string;
  collateralRedeemable: string;
}

export interface ExecutePreparedResult {
  kind: PreparedAction["kind"];
  network: AjnaNetwork;
  actorAddress: string;
  submitted: Array<{
    label: PreparedTransaction["label"];
    hash: string;
    status: number;
    gasUsed: string;
  }>;
}

export interface AllowanceCheck {
  current: BigNumber;
  needed: BigNumber;
  approvalTarget: string;
}
