import { ethers } from "ethers";

import { loadRuntimeConfig } from "./config.js";
import { AjnaSkillError, invariant } from "./errors.js";
import { validatePreparedAction } from "./prepared.js";
import { AjnaAdapter, assertProviderMatchesNetwork } from "./sdk.js";
import type {
  ExecutePreparedInput,
  ExecutePreparedResult,
  InspectPoolInput,
  InspectPositionInput,
  PrepareBorrowInput,
  PrepareLendInput
} from "./types.js";

export async function runInspectPool(input: InspectPoolInput) {
  const runtime = loadRuntimeConfig();
  const adapter = new AjnaAdapter(runtime);
  return adapter.inspectPool(input);
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

export async function runPrepareBorrow(input: PrepareBorrowInput) {
  const runtime = loadRuntimeConfig();
  invariant(runtime.mode !== "inspect", "MODE_BLOCKS_PREPARE", "Prepare requires AJNA_SKILLS_MODE=prepare or execute");
  const adapter = new AjnaAdapter(runtime);
  return adapter.prepareBorrow(input);
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
  const provider = new ethers.providers.JsonRpcProvider(network.rpcUrl, network.chainId);
  await assertProviderMatchesNetwork(provider, network);
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
      throw new AjnaSkillError("EXECUTE_VERIFICATION_FAILED", "Prepared transaction failed verification before submit", {
        label: tx.label,
        reason: error instanceof Error ? error.message : String(error)
      });
    }

    const response = await signer.sendTransaction({
      ...estimateInput,
      gasLimit: gasEstimate.mul(3)
    });
    const receipt = await response.wait(confirmations);

    submitted.push({
      label: tx.label,
      hash: response.hash,
      status: receipt.status ?? 0,
      gasUsed: receipt.gasUsed.toString()
    });
  }

  return {
    kind: input.preparedAction.kind,
    network: input.preparedAction.network,
    actorAddress: input.preparedAction.actorAddress,
    submitted
  };
}
