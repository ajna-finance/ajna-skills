import { ethers } from "ethers";

import { canonicalize } from "./json.js";
import { AjnaSkillError, invariant } from "./errors.js";
import type {
  PreparedAction,
  PreparedTransaction,
  RuntimeConfig
} from "./types.js";

type UnsignedPreparedAction = Omit<PreparedAction, "digest" | "signature">;

export async function finalizePreparedAction(
  unsigned: UnsignedPreparedAction,
  runtime: RuntimeConfig
): Promise<PreparedAction> {
  const digest = computePreparedDigest(unsigned);
  const signer = runtime.signerPrivateKey
    ? new ethers.Wallet(runtime.signerPrivateKey)
    : undefined;

  let signature: string | null = null;

  if (signer && sameAddress(signer.address, unsigned.actorAddress)) {
    signature = await signer.signMessage(ethers.utils.arrayify(digest));
  }

  return {
    ...unsigned,
    digest,
    signature
  };
}

export function computePreparedDigest(unsigned: UnsignedPreparedAction): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonicalize(unsigned)));
}

export function validatePreparedAction(
  preparedAction: PreparedAction,
  runtime: RuntimeConfig
): void {
  invariant(preparedAction.version === 1, "INVALID_PREPARED_VERSION", "Unsupported prepared action version");

  const unsigned: UnsignedPreparedAction = {
    version: preparedAction.version,
    kind: preparedAction.kind,
    network: preparedAction.network,
    chainId: preparedAction.chainId,
    actorAddress: preparedAction.actorAddress,
    poolAddress: preparedAction.poolAddress,
    quoteAddress: preparedAction.quoteAddress,
    collateralAddress: preparedAction.collateralAddress,
    createdAt: preparedAction.createdAt,
    expiresAt: preparedAction.expiresAt,
    transactions: preparedAction.transactions,
    metadata: preparedAction.metadata
  };

  const expectedDigest = computePreparedDigest(unsigned);
  invariant(
    expectedDigest === preparedAction.digest,
    "PREPARED_DIGEST_MISMATCH",
    "Prepared action digest does not match payload"
  );

  invariant(
    Date.now() <= new Date(preparedAction.expiresAt).getTime(),
    "PREPARED_ACTION_EXPIRED",
    "Prepared action has expired",
    { expiresAt: preparedAction.expiresAt }
  );

  invariant(runtime.executeSignerAddress, "MISSING_SIGNER", "Execution requires AJNA_SIGNER_PRIVATE_KEY");
  invariant(
    sameAddress(runtime.executeSignerAddress, preparedAction.actorAddress),
    "SIGNER_MISMATCH",
    "Configured signer does not match prepared actor address",
    {
      signer: runtime.executeSignerAddress,
      actorAddress: preparedAction.actorAddress
    }
  );
  invariant(
    preparedAction.signature,
    "UNSIGNED_PREPARED_ACTION",
    "Prepared action was not signed by the execution signer"
  );

  const recovered = ethers.utils.verifyMessage(
    ethers.utils.arrayify(preparedAction.digest),
    preparedAction.signature
  );

  invariant(
    sameAddress(recovered, preparedAction.actorAddress),
    "INVALID_PREPARED_SIGNATURE",
    "Prepared action signature does not recover to actor address"
  );
}

export function txSummaryHash(transactions: PreparedTransaction[]): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonicalize(transactions)));
}

function sameAddress(left: string, right: string): boolean {
  try {
    return ethers.utils.getAddress(left) === ethers.utils.getAddress(right);
  } catch (error) {
    throw new AjnaSkillError("INVALID_ADDRESS", "Address comparison failed", {
      left,
      right,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

