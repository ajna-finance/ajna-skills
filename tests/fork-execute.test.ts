import { ERC20__factory, ERC20Pool__factory } from "@ajna-finance/sdk";
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";

import {
  runExecutePrepared,
  runPrepareApproveErc20,
  runPrepareApproveErc721,
  runPrepareBorrow,
  runPrepareLend,
  runPrepareUnsupportedAjnaAction
} from "../src/actions.js";
import { UNSAFE_SDK_CALL_ACKNOWLEDGEMENT } from "../src/constants.js";

const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WHALE_ETH_BALANCE_HEX = "0x8AC7230489E80000";
const DEFAULT_FORK_TTL_SECONDS = 365 * 24 * 60 * 60;
const ERC721_TEST_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function transferFrom(address from, address to, uint256 tokenId)"
] as const;

const shouldRunBase =
  process.env.RUN_AJNA_FORK_TESTS === "1" &&
  Boolean(process.env.AJNA_RPC_URL_BASE) &&
  Boolean(process.env.AJNA_TEST_POOL_ADDRESS);

const shouldRunLend =
  shouldRunBase &&
  Boolean(process.env.AJNA_TEST_BUCKET_INDEX) &&
  Boolean(process.env.AJNA_TEST_FUND_AMOUNT_RAW) &&
  Boolean(process.env.AJNA_TEST_LEND_AMOUNT_WAD ?? process.env.AJNA_TEST_LEND_AMOUNT) &&
  Boolean(process.env.AJNA_TEST_QUOTE_WHALE);

const shouldRunBorrow =
  shouldRunBase &&
  Boolean(process.env.AJNA_TEST_BORROW_LIMIT_INDEX) &&
  Boolean(process.env.AJNA_TEST_COLLATERAL_FUND_AMOUNT_RAW) &&
  Boolean(process.env.AJNA_TEST_COLLATERAL_AMOUNT_WAD) &&
  Boolean(process.env.AJNA_TEST_BORROW_AMOUNT_WAD) &&
  Boolean(process.env.AJNA_TEST_COLLATERAL_WHALE);

const shouldRunApproveErc20 =
  shouldRunBase &&
  Boolean(process.env.AJNA_TEST_FUND_AMOUNT_RAW) &&
  Boolean(process.env.AJNA_TEST_QUOTE_WHALE);

const shouldRunApproveErc721 =
  shouldRunBase &&
  Boolean(process.env.AJNA_TEST_ERC721_TOKEN_ADDRESS) &&
  Boolean(process.env.AJNA_TEST_ERC721_TOKEN_ID) &&
  Boolean(process.env.AJNA_TEST_ERC721_HOLDER);

async function withForkSnapshot<T>(
  rpcUrl: string,
  run: (provider: ethers.providers.JsonRpcProvider) => Promise<T>
): Promise<T> {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, 8453);
  const snapshotId = await provider.send("evm_snapshot", []);

  try {
    return await run(provider);
  } finally {
    await provider.send("evm_revert", [snapshotId]);
  }
}

async function fundTokenFromWhale({
  provider,
  tokenAddress,
  whaleAddress,
  recipientAddress,
  amountRaw
}: {
  provider: ethers.providers.JsonRpcProvider;
  tokenAddress: string;
  whaleAddress: string;
  recipientAddress: string;
  amountRaw: string;
}) {
  const token = ERC20__factory.connect(tokenAddress, provider);

  await provider.send("anvil_setBalance", [whaleAddress, WHALE_ETH_BALANCE_HEX]);
  await provider.send("anvil_impersonateAccount", [whaleAddress]);

  try {
    const whaleSigner = provider.getSigner(whaleAddress);
    const transfer = await token.connect(whaleSigner).transfer(recipientAddress, amountRaw);
    await transfer.wait(1);
  } finally {
    await provider.send("anvil_stopImpersonatingAccount", [whaleAddress]);
  }
}

async function transferNftFromHolder({
  provider,
  tokenAddress,
  holderAddress,
  recipientAddress,
  tokenId
}: {
  provider: ethers.providers.JsonRpcProvider;
  tokenAddress: string;
  holderAddress: string;
  recipientAddress: string;
  tokenId: string;
}) {
  const token = new ethers.Contract(tokenAddress, ERC721_TEST_ABI, provider);

  await provider.send("anvil_setBalance", [holderAddress, WHALE_ETH_BALANCE_HEX]);
  await provider.send("anvil_impersonateAccount", [holderAddress]);

  try {
    const holderSigner = provider.getSigner(holderAddress);
    const transfer = await token.connect(holderSigner).transferFrom(holderAddress, recipientAddress, tokenId);
    await transfer.wait(1);
  } finally {
    await provider.send("anvil_stopImpersonatingAccount", [holderAddress]);
  }
}

describe("fork-backed execute flow", () => {
  const runLend = shouldRunLend ? it : it.skip;
  const runBorrow = shouldRunBorrow ? it : it.skip;
  const runApproveErc20 = shouldRunApproveErc20 ? it : it.skip;
  const runApproveErc721 = shouldRunApproveErc721 ? it : it.skip;
  const runUnsupportedErc20Pool = shouldRunBase ? it : it.skip;

  runLend("executes a prepared lend and rejects replay after the nonce changes", async () => {
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

    await withForkSnapshot(rpcUrl, async (provider) => {
      const signer = new ethers.Wallet(signerPrivateKey, provider);
      const signerAddress = await signer.getAddress();
      const pool = ERC20Pool__factory.connect(poolAddress, provider);
      const quoteTokenAddress = await pool.quoteTokenAddress();

      process.env.AJNA_SKILLS_MODE = "execute";
      process.env.AJNA_SIGNER_PRIVATE_KEY = signerPrivateKey;

      await fundTokenFromWhale({
        provider,
        tokenAddress: quoteTokenAddress,
        whaleAddress: quoteWhale,
        recipientAddress: signerAddress,
        amountRaw: fundAmountRaw
      });

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
    });
  }, 120_000);

  runBorrow("executes a prepared borrow and rejects replay after the nonce changes", async () => {
    const rpcUrl = process.env.AJNA_RPC_URL_BASE!;
    const poolAddress = process.env.AJNA_TEST_POOL_ADDRESS!;
    const limitIndex = Number.parseInt(process.env.AJNA_TEST_BORROW_LIMIT_INDEX!, 10);
    const collateralFundAmountRaw = process.env.AJNA_TEST_COLLATERAL_FUND_AMOUNT_RAW!;
    const collateralAmountWad = process.env.AJNA_TEST_COLLATERAL_AMOUNT_WAD!;
    const borrowAmountWad = process.env.AJNA_TEST_BORROW_AMOUNT_WAD!;
    const collateralWhale = ethers.utils.getAddress(process.env.AJNA_TEST_COLLATERAL_WHALE!);
    const signerPrivateKey = process.env.AJNA_FORK_SIGNER_PRIVATE_KEY ?? ANVIL_DEFAULT_PRIVATE_KEY;
    const maxAgeSeconds = Number.parseInt(
      process.env.AJNA_TEST_TTL_SECONDS ?? String(DEFAULT_FORK_TTL_SECONDS),
      10
    );

    await withForkSnapshot(rpcUrl, async (provider) => {
      const signer = new ethers.Wallet(signerPrivateKey, provider);
      const signerAddress = await signer.getAddress();
      const pool = ERC20Pool__factory.connect(poolAddress, provider);
      const collateralTokenAddress = await pool.collateralAddress();

      process.env.AJNA_SKILLS_MODE = "execute";
      process.env.AJNA_SIGNER_PRIVATE_KEY = signerPrivateKey;

      await fundTokenFromWhale({
        provider,
        tokenAddress: collateralTokenAddress,
        whaleAddress: collateralWhale,
        recipientAddress: signerAddress,
        amountRaw: collateralFundAmountRaw
      });

      const preparedAction = await runPrepareBorrow({
        network: "base",
        poolAddress,
        actorAddress: signerAddress,
        amount: borrowAmountWad,
        collateralAmount: collateralAmountWad,
        limitIndex,
        approvalMode: "exact",
        maxAgeSeconds
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
    });
  }, 120_000);

  runApproveErc20("executes a standalone ERC20 approval and rejects replay after the nonce changes", async () => {
    const rpcUrl = process.env.AJNA_RPC_URL_BASE!;
    const poolAddress = process.env.AJNA_TEST_POOL_ADDRESS!;
    const fundAmountRaw = process.env.AJNA_TEST_FUND_AMOUNT_RAW!;
    const quoteWhale = ethers.utils.getAddress(process.env.AJNA_TEST_QUOTE_WHALE!);
    const signerPrivateKey = process.env.AJNA_FORK_SIGNER_PRIVATE_KEY ?? ANVIL_DEFAULT_PRIVATE_KEY;
    const maxAgeSeconds = Number.parseInt(
      process.env.AJNA_TEST_TTL_SECONDS ?? String(DEFAULT_FORK_TTL_SECONDS),
      10
    );

    await withForkSnapshot(rpcUrl, async (provider) => {
      const signer = new ethers.Wallet(signerPrivateKey, provider);
      const signerAddress = await signer.getAddress();
      const pool = ERC20Pool__factory.connect(poolAddress, provider);
      const quoteTokenAddress = await pool.quoteTokenAddress();
      const quoteToken = ERC20__factory.connect(quoteTokenAddress, provider);

      process.env.AJNA_SKILLS_MODE = "execute";
      process.env.AJNA_SIGNER_PRIVATE_KEY = signerPrivateKey;

      await fundTokenFromWhale({
        provider,
        tokenAddress: quoteTokenAddress,
        whaleAddress: quoteWhale,
        recipientAddress: signerAddress,
        amountRaw: fundAmountRaw
      });

      const existingAllowance = await quoteToken.allowance(signerAddress, poolAddress);
      const requestedAmount = existingAllowance.gte(fundAmountRaw)
        ? existingAllowance.add(1)
        : ethers.BigNumber.from(fundAmountRaw);

      const preparedAction = await runPrepareApproveErc20({
        network: "base",
        actorAddress: signerAddress,
        tokenAddress: quoteTokenAddress,
        poolAddress,
        amount: requestedAmount.toString(),
        approvalMode: "exact",
        maxAgeSeconds
      });

      expect(preparedAction.transactions).toHaveLength(1);

      const result = await runExecutePrepared({
        preparedAction,
        confirmations: 1
      });

      expect(result.submitted).toHaveLength(1);
      expect(await quoteToken.allowance(signerAddress, poolAddress)).toEqual(requestedAmount);

      await expect(
        runExecutePrepared({
          preparedAction,
          confirmations: 1
        })
      ).rejects.toMatchObject({
        code: "PREPARED_NONCE_STALE"
      });
    });
  }, 120_000);

  runApproveErc721("executes a standalone ERC721 approval and rejects replay after the nonce changes", async () => {
    const rpcUrl = process.env.AJNA_RPC_URL_BASE!;
    const poolAddress = process.env.AJNA_TEST_POOL_ADDRESS!;
    const tokenAddress = ethers.utils.getAddress(process.env.AJNA_TEST_ERC721_TOKEN_ADDRESS!);
    const tokenId = process.env.AJNA_TEST_ERC721_TOKEN_ID!;
    const holderAddress = ethers.utils.getAddress(process.env.AJNA_TEST_ERC721_HOLDER!);
    const signerPrivateKey = process.env.AJNA_FORK_SIGNER_PRIVATE_KEY ?? ANVIL_DEFAULT_PRIVATE_KEY;
    const maxAgeSeconds = Number.parseInt(
      process.env.AJNA_TEST_TTL_SECONDS ?? String(DEFAULT_FORK_TTL_SECONDS),
      10
    );

    await withForkSnapshot(rpcUrl, async (provider) => {
      const signer = new ethers.Wallet(signerPrivateKey, provider);
      const signerAddress = await signer.getAddress();
      const token = new ethers.Contract(tokenAddress, ERC721_TEST_ABI, provider);

      process.env.AJNA_SKILLS_MODE = "execute";
      process.env.AJNA_SIGNER_PRIVATE_KEY = signerPrivateKey;

      await transferNftFromHolder({
        provider,
        tokenAddress,
        holderAddress,
        recipientAddress: signerAddress,
        tokenId
      });

      expect(await token.ownerOf(tokenId)).toBe(ethers.utils.getAddress(signerAddress));

      const preparedAction = await runPrepareApproveErc721({
        network: "base",
        actorAddress: signerAddress,
        tokenAddress,
        poolAddress,
        tokenId,
        maxAgeSeconds
      });

      expect(preparedAction.transactions).toHaveLength(1);

      const result = await runExecutePrepared({
        preparedAction,
        confirmations: 1
      });

      expect(result.submitted).toHaveLength(1);
      expect(await token.getApproved(tokenId)).toBe(ethers.utils.getAddress(poolAddress));

      await expect(
        runExecutePrepared({
          preparedAction,
          confirmations: 1
        })
      ).rejects.toMatchObject({
        code: "PREPARED_NONCE_STALE"
      });
    });
  }, 120_000);

  runUnsupportedErc20Pool(
    "executes an unsupported erc20-pool updateInterest action and rejects replay after the nonce changes",
    async () => {
      const rpcUrl = process.env.AJNA_RPC_URL_BASE!;
      const poolAddress = process.env.AJNA_TEST_POOL_ADDRESS!;
      const signerPrivateKey = process.env.AJNA_FORK_SIGNER_PRIVATE_KEY ?? ANVIL_DEFAULT_PRIVATE_KEY;
      const previousUnsafeGate = process.env.AJNA_ENABLE_UNSAFE_SDK_CALLS;

      await withForkSnapshot(rpcUrl, async (provider) => {
        const signer = new ethers.Wallet(signerPrivateKey, provider);
        const signerAddress = await signer.getAddress();

        process.env.AJNA_SKILLS_MODE = "execute";
        process.env.AJNA_SIGNER_PRIVATE_KEY = signerPrivateKey;
        process.env.AJNA_ENABLE_UNSAFE_SDK_CALLS = "1";

        try {
          const preparedAction = await runPrepareUnsupportedAjnaAction({
            network: "base",
            actorAddress: signerAddress,
            contractKind: "erc20-pool",
            contractAddress: poolAddress,
            abiFragment: "function updateInterest()",
            methodName: "updateInterest",
            args: [],
            acknowledgeRisk: UNSAFE_SDK_CALL_ACKNOWLEDGEMENT,
            notes: "fork test for unsupported erc20-pool updateInterest"
          });

          expect(preparedAction.transactions).toHaveLength(1);
          expect(preparedAction.transactions[0]?.target).toBe(ethers.utils.getAddress(poolAddress));

          const result = await runExecutePrepared({
            preparedAction,
            confirmations: 1
          });

          expect(result.submitted).toHaveLength(1);
          expect(result.submitted[0]?.status).toBe(1);

          await expect(
            runExecutePrepared({
              preparedAction,
              confirmations: 1
            })
          ).rejects.toMatchObject({
            code: "PREPARED_NONCE_STALE"
          });
        } finally {
          if (previousUnsafeGate === undefined) {
            delete process.env.AJNA_ENABLE_UNSAFE_SDK_CALLS;
          } else {
            process.env.AJNA_ENABLE_UNSAFE_SDK_CALLS = previousUnsafeGate;
          }
        }
      });
    },
    120_000
  );
});
