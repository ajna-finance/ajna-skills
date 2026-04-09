#!/usr/bin/env node

import { errorEnvelope } from "./errors.js";
import { parseJsonArgument } from "./json.js";
import {
  runExecutePrepared,
  runInspectBucket,
  runInspectPool,
  runInspectPosition,
  runPrepareApproveErc20,
  runPrepareApproveErc721,
  runPrepareBorrow,
  runPrepareCreateErc20Pool,
  runPrepareCreateErc721Pool,
  runPrepareLend,
  runPrepareUnsupportedAjnaAction
} from "./actions.js";
import type {
  ExecutePreparedInput,
  InspectBucketInput,
  InspectPoolInput,
  InspectPositionInput,
  PrepareApproveErc20Input,
  PrepareApproveErc721Input,
  PrepareBorrowInput,
  PrepareCreateErc20PoolInput,
  PrepareCreateErc721PoolInput,
  PrepareLendInput,
  PrepareUnsupportedAjnaActionInput,
  SuccessEnvelope
} from "./types.js";

async function main() {
  const action = process.argv[2];
  const payload = process.argv[3];

  switch (action) {
    case "inspect-pool":
      return printSuccess(await runInspectPool(parseJsonArgument<InspectPoolInput>(payload)));
    case "inspect-bucket":
      return printSuccess(await runInspectBucket(parseJsonArgument<InspectBucketInput>(payload)));
    case "inspect-position":
      return printSuccess(await runInspectPosition(parseJsonArgument<InspectPositionInput>(payload)));
    case "prepare-create-erc20-pool":
      return printSuccess(await runPrepareCreateErc20Pool(parseJsonArgument<PrepareCreateErc20PoolInput>(payload)));
    case "prepare-create-erc721-pool":
      return printSuccess(await runPrepareCreateErc721Pool(parseJsonArgument<PrepareCreateErc721PoolInput>(payload)));
    case "prepare-lend":
      return printSuccess(await runPrepareLend(parseJsonArgument<PrepareLendInput>(payload)));
    case "prepare-borrow":
      return printSuccess(await runPrepareBorrow(parseJsonArgument<PrepareBorrowInput>(payload)));
    case "prepare-approve-erc20":
      return printSuccess(await runPrepareApproveErc20(parseJsonArgument<PrepareApproveErc20Input>(payload)));
    case "prepare-approve-erc721":
      return printSuccess(await runPrepareApproveErc721(parseJsonArgument<PrepareApproveErc721Input>(payload)));
    case "prepare-unsupported-ajna-action":
      return printSuccess(
        await runPrepareUnsupportedAjnaAction(parseJsonArgument<PrepareUnsupportedAjnaActionInput>(payload))
      );
    case "execute-prepared":
      return printSuccess(await runExecutePrepared(parseJsonArgument<ExecutePreparedInput>(payload)));
    default:
      throw new Error(
        "Unknown action. Expected one of inspect-pool, inspect-bucket, inspect-position, prepare-create-erc20-pool, prepare-create-erc721-pool, prepare-lend, prepare-borrow, prepare-approve-erc20, prepare-approve-erc721, prepare-unsupported-ajna-action, execute-prepared"
      );
  }
}

function printSuccess<T>(result: T) {
  const output: SuccessEnvelope<T> = {
    ok: true,
    result
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(errorEnvelope(error), null, 2)}\n`);
  process.exitCode = 1;
});
