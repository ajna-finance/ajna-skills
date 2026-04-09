import { ERC20__factory, ERC20Pool__factory } from "@ajna-finance/sdk";
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";

import { runExecutePrepared, runPrepareLend } from "../src/actions.js";

const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WHALE_ETH_BALANCE_HEX = "0x8AC7230489E80000";
const DEFAULT_FORK_TTL_SECONDS = 365 * 24 * 60 * 60;

const shouldRun =
  process.env.RUN_AJNA_FORK_TESTS === "1" &&
  Boolean(process.env.AJNA_RPC_URL_BASE) &&
  Boolean(process.env.AJNA_TEST_POOL_ADDRESS) &&
  Boolean(process.env.AJNA_TEST_BUCKET_INDEX) &&
  Boolean(process.env.AJNA_TEST_FUND_AMOUNT_RAW) &&
  Boolean(process.env.AJNA_TEST_LEND_AMOUNT_WAD ?? process.env.AJNA_TEST_LEND_AMOUNT) &&
  Boolean(process.env.AJNA_TEST_QUOTE_WHALE);

describe.skipIf(!shouldRun)("fork-backed execute flow", () => {
  it("executes a prepared lend and rejects replay after the nonce changes", async () => {
    const rpcUrl = process.env.AJNA_RPC_URL_BASE!;
    const poolAddress = process.env.AJNA_TEST_POOL_ADDRESS!;
    const bucketIndex = Number.parseInt(process.env.AJNA_TEST_BUCKET_INDEX!, 10);
    const fundAmountRaw = process.env.AJNA_TEST_FUND_AMOUNT_RAW!;
    const lendAmountWad = process.env.AJNA_TEST_LEND_AMOUNT_WAD ?? process.env.AJNA_TEST_LEND_AMOUNT!;
    const quoteWhale = ethers.utils.getAddress(process.env.AJNA_TEST_QUOTE_WHALE!);
    const signerPrivateKey = process.env.AJNA_FORK_SIGNER_PRIVATE_KEY ?? ANVIL_DEFAULT_PRIVATE_KEY;
    const ttlSeconds = Number.parseInt(
      process.env.AJNA_TEST_TTL_SECONDS ?? String(DEFAULT_FORK_TTL_SECONDS),
      10
    );

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, 8453);
    const signer = new ethers.Wallet(signerPrivateKey, provider);
    const signerAddress = await signer.getAddress();
    const pool = ERC20Pool__factory.connect(poolAddress, provider);
    const quoteTokenAddress = await pool.quoteTokenAddress();
    const quoteToken = ERC20__factory.connect(quoteTokenAddress, provider);

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = signerPrivateKey;

    await provider.send("anvil_setBalance", [quoteWhale, WHALE_ETH_BALANCE_HEX]);
    await provider.send("anvil_impersonateAccount", [quoteWhale]);

    try {
      const whaleSigner = provider.getSigner(quoteWhale);
      // The funding transfer uses the quote token's native units, while Ajna lend
      // actions expect WAD-scaled quote amounts.
      const transfer = await quoteToken.connect(whaleSigner).transfer(signerAddress, fundAmountRaw);
      await transfer.wait(1);
    } finally {
      await provider.send("anvil_stopImpersonatingAccount", [quoteWhale]);
    }

    const preparedAction = await runPrepareLend({
      network: "base",
      poolAddress,
      actorAddress: signerAddress,
      amount: lendAmountWad,
      bucketIndex,
      approvalMode: "exact",
      ttlSeconds
    });

    expect(preparedAction.transactions.length).toBeGreaterThan(0);

    const result = await runExecutePrepared({
      preparedAction,
      confirmations: 1
    });

    expect(result.submitted.length).toBe(preparedAction.transactions.length);

    await expect(
      runExecutePrepared({
        preparedAction,
        confirmations: 1
      })
    ).rejects.toMatchObject({
      code: "PREPARED_NONCE_STALE"
    });
  }, 120_000);
});
