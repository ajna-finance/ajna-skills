#!/usr/bin/env node

import { errorEnvelope } from "./errors.js";
import { parseJsonArgument } from "./json.js";
import {
  runExecutePrepared,
  runInspectPool,
  runInspectPosition,
  runPrepareApproveErc20,
  runPrepareApproveErc721,
  runPrepareBorrow,
  runPrepareLend
} from "./actions.js";
import type {
  ExecutePreparedInput,
  InspectPoolInput,
  InspectPositionInput,
  PrepareApproveErc20Input,
  PrepareApproveErc721Input,
  PrepareBorrowInput,
  PrepareLendInput,
  SuccessEnvelope
} from "./types.js";

async function main() {
  const action = process.argv[2];
  const payload = process.argv[3];

  switch (action) {
    case "inspect-pool":
      return printSuccess(await runInspectPool(parseJsonArgument<InspectPoolInput>(payload)));
    case "inspect-position":
      return printSuccess(await runInspectPosition(parseJsonArgument<InspectPositionInput>(payload)));
    case "prepare-lend":
      return printSuccess(await runPrepareLend(parseJsonArgument<PrepareLendInput>(payload)));
    case "prepare-borrow":
      return printSuccess(await runPrepareBorrow(parseJsonArgument<PrepareBorrowInput>(payload)));
    case "prepare-approve-erc20":
      return printSuccess(await runPrepareApproveErc20(parseJsonArgument<PrepareApproveErc20Input>(payload)));
    case "prepare-approve-erc721":
      return printSuccess(await runPrepareApproveErc721(parseJsonArgument<PrepareApproveErc721Input>(payload)));
    case "execute-prepared":
      return printSuccess(await runExecutePrepared(parseJsonArgument<ExecutePreparedInput>(payload)));
    default:
      throw new Error(
        "Unknown action. Expected one of inspect-pool, inspect-position, prepare-lend, prepare-borrow, prepare-approve-erc20, prepare-approve-erc721, execute-prepared"
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
