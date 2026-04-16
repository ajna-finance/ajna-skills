import { ethers } from "ethers";

import { loadRuntimeConfig } from "./config.js";
import { UNSAFE_SDK_CALL_ACKNOWLEDGEMENT } from "./constants.js";
import { AjnaSkillError, invariant } from "./errors.js";
import { validatePreparedAction } from "./prepared.js";
import { AjnaAdapter, buildNetworkProvider, resolveCreatedPoolAddress } from "./sdk.js";
import type {
  BucketInspectionResult,
  ExecutePreparedInput,
  ExecutePreparedResult,
  InspectBucketInput,
  InspectPoolInput,
  InspectPositionInput,
  PrepareApproveErc20Input,
  PrepareApproveErc721Input,
  PrepareBorrowInput,
  PrepareCreateErc20PoolInput,
  PrepareCreateErc721PoolInput,
  PrepareLendInput,
  PrepareUnsupportedAjnaActionInput
} from "./types.js";

export async function runInspectPool(input: InspectPoolInput) {
  const runtime = loadRuntimeConfig();
  const adapter = new AjnaAdapter(runtime);
  return adapter.inspectPool(input);
}

export async function runInspectBucket(input: InspectBucketInput): Promise<BucketInspectionResult> {
  const runtime = loadRuntimeConfig();
  const adapter = new AjnaAdapter(runtime);
  return adapter.inspectBucket(input);
}

export async function runInspectPosition(input: InspectPositionInput) {
  const runtime = loadRuntimeConfig();
  const adapter = new AjnaAdapter(runtime);
  return adapter.inspectPosition(input);
}

export async function runPrepareLend(input: PrepareLendInput) {
  const runtime = loadRuntimeConfig();
  invariant(runtime.mode !== "inspect", "MODE_BLOCKS_PREPARE", "Prepare requires AJNA_SKILLS_MODE=prepare or execute");
  const adapter = new AjnaAdapter(runtime);
  return adapter.prepareLend(input);
}

export async function runPrepareCreateErc20Pool(input: PrepareCreateErc20PoolInput) {
  const runtime = loadRuntimeConfig();
  invariant(runtime.mode !== "inspect", "MODE_BLOCKS_PREPARE", "Prepare requires AJNA_SKILLS_MODE=prepare or execute");
  const adapter = new AjnaAdapter(runtime);
  return adapter.prepareCreateErc20Pool(input);
}

export async function runPrepareCreateErc721Pool(input: PrepareCreateErc721PoolInput) {
  const runtime = loadRuntimeConfig();
  invariant(runtime.mode !== "inspect", "MODE_BLOCKS_PREPARE", "Prepare requires AJNA_SKILLS_MODE=prepare or execute");
  const adapter = new AjnaAdapter(runtime);
  return adapter.prepareCreateErc721Pool(input);
}

export async function runPrepareBorrow(input: PrepareBorrowInput) {
  const runtime = loadRuntimeConfig();
  invariant(runtime.mode !== "inspect", "MODE_BLOCKS_PREPARE", "Prepare requires AJNA_SKILLS_MODE=prepare or execute");
  const adapter = new AjnaAdapter(runtime);
  return adapter.prepareBorrow(input);
}

export async function runPrepareApproveErc20(input: PrepareApproveErc20Input) {
  const runtime = loadRuntimeConfig();
  invariant(runtime.mode !== "inspect", "MODE_BLOCKS_PREPARE", "Prepare requires AJNA_SKILLS_MODE=prepare or execute");
  const adapter = new AjnaAdapter(runtime);
  return adapter.prepareApproveErc20(input);
}

export async function runPrepareApproveErc721(input: PrepareApproveErc721Input) {
  const runtime = loadRuntimeConfig();
  invariant(runtime.mode !== "inspect", "MODE_BLOCKS_PREPARE", "Prepare requires AJNA_SKILLS_MODE=prepare or execute");
  const adapter = new AjnaAdapter(runtime);
  return adapter.prepareApproveErc721(input);
}

export async function runPrepareUnsupportedAjnaAction(input: PrepareUnsupportedAjnaActionInput) {
  const runtime = loadRuntimeConfig();
  invariant(runtime.mode !== "inspect", "MODE_BLOCKS_PREPARE", "Prepare requires AJNA_SKILLS_MODE=prepare or execute");
  invariant(
    runtime.unsafeUnsupportedActionsEnabled,
    "UNSAFE_SDK_CALLS_DISABLED",
    "prepare-unsupported-ajna-action requires AJNA_ENABLE_UNSAFE_SDK_CALLS=1"
  );
  invariant(
    input.acknowledgeRisk === UNSAFE_SDK_CALL_ACKNOWLEDGEMENT,
    "UNSAFE_ACKNOWLEDGEMENT_REQUIRED",
    "Unsupported Ajna action prepare requires the exact acknowledgement phrase",
    {
      expected: UNSAFE_SDK_CALL_ACKNOWLEDGEMENT
    }
  );
  const adapter = new AjnaAdapter(runtime);
  return adapter.prepareUnsupportedAjnaAction(input);
}

/*
inspect -> prepare -> execute
          |             |
          |             +-- signer must match prepared actor
          |             +-- digest must match payload
          |             +-- signature must recover actor
          +-- prepare may be unsigned for dry-run only
*/
export async function runExecutePrepared(
  input: ExecutePreparedInput
): Promise<ExecutePreparedResult> {
  const runtime = loadRuntimeConfig();
  invariant(runtime.mode === "execute", "MODE_BLOCKS_EXECUTE", "Execute requires AJNA_SKILLS_MODE=execute");
  validatePreparedAction(input.preparedAction, runtime);
  invariant(runtime.signerPrivateKey, "MISSING_SIGNER", "Execution requires AJNA_SIGNER_PRIVATE_KEY");

  const network = runtime.networks[input.preparedAction.network];
  invariant(
    network,
    "MISSING_RPC_URL",
    `Missing RPC URL for ${input.preparedAction.network}`,
    {
      expected: [`AJNA_RPC_URL_${input.preparedAction.network.toUpperCase()}`, "AJNA_RPC_URL"]
    }
  );
  invariant(
    input.preparedAction.chainId === network.chainId,
    "PREPARED_CHAIN_MISMATCH",
    "Prepared action chainId does not match the selected runtime network",
    {
      network: input.preparedAction.network,
      preparedChainId: input.preparedAction.chainId,
      runtimeChainId: network.chainId
    }
  );
  const provider = await buildNetworkProvider(network);
  const signer = new ethers.Wallet(runtime.signerPrivateKey, provider);
  const signerAddress = await signer.getAddress();

  invariant(
    ethers.utils.getAddress(signerAddress) === ethers.utils.getAddress(input.preparedAction.actorAddress),
    "SIGNER_MISMATCH",
    "Configured signer does not match prepared actor address"
  );

  const currentPendingNonce = await provider.getTransactionCount(signerAddress, "pending");
  invariant(
    currentPendingNonce === input.preparedAction.startingNonce,
    "PREPARED_NONCE_STALE",
    "Prepared action is stale because the signer nonce changed",
    {
      expectedStartingNonce: input.preparedAction.startingNonce,
      currentPendingNonce
    }
  );

  const confirmations = input.confirmations ?? 1;
  const submitted: ExecutePreparedResult["submitted"] = [];
  const blockGasLimit = await readLatestBlockGasLimit(provider);

  try {
    for (const [index, tx] of input.preparedAction.transactions.entries()) {
      const expectedNonce = input.preparedAction.startingNonce + index;
      invariant(
        tx.nonce === undefined || tx.nonce === expectedNonce,
        "PREPARED_TRANSACTION_NONCE_MISMATCH",
        "Prepared transaction nonce does not match expected execution sequence",
        {
          label: tx.label,
          preparedNonce: tx.nonce,
          expectedNonce
        }
      );

      const estimateInput: ethers.providers.TransactionRequest = {
        to: tx.target,
        data: tx.data,
        value: ethers.BigNumber.from(tx.value),
        from: signerAddress,
        nonce: expectedNonce
      };

      let gasEstimate: ethers.BigNumber;

      try {
        gasEstimate = await provider.estimateGas(estimateInput);
      } catch (error) {
        throw new AjnaSkillError(
          "EXECUTE_VERIFICATION_FAILED",
          "Prepared transaction failed verification before submit",
          {
            label: tx.label,
            reason: error instanceof Error ? error.message : String(error)
          }
        );
      }

      const response = await signer.sendTransaction({
        ...estimateInput,
        gasLimit: computeExecutionGasLimit(gasEstimate, blockGasLimit)
      });
      const baseSubmittedEntry = {
        label: tx.label,
        hash: response.hash,
        status: null,
        gasUsed: null
      };
      let receipt: ethers.providers.TransactionReceipt;
      let confirmedHash = response.hash;
      let receiptStatus: number | null;
      let receiptGasUsed: string;

      try {
        receipt = await response.wait(confirmations);
        receiptStatus = receipt.status ?? null;
        receiptGasUsed = receipt.gasUsed.toString();
      } catch (error) {
        const replacementReceipt = replacementSuccessReceipt(error, estimateInput);

        if (replacementReceipt) {
          receipt = replacementReceipt.receipt;
          confirmedHash = replacementReceipt.hash;
          receiptStatus = replacementReceipt.receipt.status ?? null;
          receiptGasUsed = replacementReceipt.receipt.gasUsed.toString();
        } else {
          throw waitFailureAsSkillError(error, tx.label, response.hash, submitted, baseSubmittedEntry);
        }
      }

      const receiptEntry = {
        label: tx.label,
        hash: confirmedHash,
        status: receiptStatus,
        gasUsed: receiptGasUsed
      };

      invariant(
        receipt.status !== undefined,
        "EXECUTE_RECEIPT_STATUS_UNKNOWN",
        "Prepared transaction receipt did not include a success status; verify onchain state manually",
        {
          label: tx.label,
          hash: confirmedHash,
          submittedSoFar: [...submitted, receiptEntry]
        }
      );
      invariant(
        receipt.status === 1,
        "EXECUTE_TRANSACTION_REVERTED",
        "Prepared transaction reverted after it was submitted",
        {
          label: tx.label,
          hash: confirmedHash,
          status: receipt.status,
          submittedSoFar: [...submitted, receiptEntry]
        }
      );

      submitted.push({
        label: tx.label,
        hash: confirmedHash,
        status: receipt.status,
        gasUsed: receiptGasUsed
      });
    }
  } catch (error) {
    throw withSubmittedContext(error, submitted);
  }

  const resolvedPoolAddress = await resolveCreatedPoolAddress(provider, network, input.preparedAction);

  return {
    kind: input.preparedAction.kind,
    network: input.preparedAction.network,
    actorAddress: input.preparedAction.actorAddress,
    resolvedPoolAddress,
    submitted
  };
}

async function readLatestBlockGasLimit(
  provider: ethers.providers.JsonRpcProvider
): Promise<ethers.BigNumber | undefined> {
  try {
    const latestBlock = await provider.getBlock("latest");
    return latestBlock?.gasLimit ? ethers.BigNumber.from(latestBlock.gasLimit) : undefined;
  } catch {
    return undefined;
  }
}

function computeExecutionGasLimit(
  gasEstimate: ethers.BigNumber,
  blockGasLimit: ethers.BigNumber | undefined
): ethers.BigNumber {
  const buffer = ethers.BigNumber.from(25_000);
  const padded = gasEstimate.add(gasEstimate.div(5)).add(buffer);

  if (!blockGasLimit) {
    return padded;
  }

  const ceiling = blockGasLimit.sub(blockGasLimit.div(20));
  if (gasEstimate.gte(ceiling)) {
    return gasEstimate;
  }

  return padded.gt(ceiling) ? ceiling : padded;
}

function withSubmittedContext(
  error: unknown,
  submitted: ExecutePreparedResult["submitted"]
): unknown {
  if (submitted.length === 0) {
    return error;
  }

  if (error instanceof AjnaSkillError) {
    if (error.details?.submittedSoFar) {
      return error;
    }

    return new AjnaSkillError(error.code, error.message, {
      ...error.details,
      submittedSoFar: submitted
    });
  }

  return new AjnaSkillError("EXECUTE_FAILED", "Prepared transaction execution failed", {
    submittedSoFar: submitted
  });
}

function waitFailureAsSkillError(
  error: unknown,
  label: ExecutePreparedResult["submitted"][number]["label"],
  originalHash: string,
  submitted: ExecutePreparedResult["submitted"],
  submittedEntry: {
    label: ExecutePreparedResult["submitted"][number]["label"];
    hash: string;
    status: null;
    gasUsed: null;
  }
): AjnaSkillError {
  const submittedSoFar = [...submitted, submittedEntry];

  if (isTransactionReplacedError(error)) {
    return new AjnaSkillError(
      "EXECUTE_TRANSACTION_REPLACED",
      "Submitted transaction was replaced before confirmation",
      {
        label,
        hash: originalHash,
        replacementHash: error.replacement?.hash ?? null,
        replacementReason: error.reason ?? null,
        cancelled: Boolean(error.cancelled),
        submittedSoFar
      }
    );
  }

  return new AjnaSkillError("EXECUTE_WAIT_FAILED", "Submitted transaction could not be confirmed", {
    label,
    hash: originalHash,
    waitErrorCode: waitErrorCode(error),
    submittedSoFar
  });
}

function replacementSuccessReceipt(
  error: unknown,
  original: ethers.providers.TransactionRequest
): { hash: string; receipt: ethers.providers.TransactionReceipt } | null {
  if (!isTransactionReplacedError(error)) {
    return null;
  }

  const receipt = error.receipt;
  const replacement = error.replacement;

  if (error.cancelled || !receipt || receipt.status !== 1 || !replacement) {
    return null;
  }

  const sameTarget = (replacement.to ?? null) === (original.to ?? null);
  const sameData = (replacement.data ?? "0x").toString() === (original.data ?? "0x").toString();
  const sameValue = ethers.BigNumber.from(replacement.value ?? 0).eq(ethers.BigNumber.from(original.value ?? 0));

  if (!sameTarget || !sameData || !sameValue) {
    return null;
  }

  return {
    hash: replacement.hash,
    receipt
  };
}

function isTransactionReplacedError(
  error: unknown
): error is Error & {
  code: string;
  cancelled?: boolean;
  reason?: string;
  replacement?: ethers.providers.TransactionResponse;
  receipt?: ethers.providers.TransactionReceipt;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "TRANSACTION_REPLACED"
  );
}

function waitErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }

  return null;
}
