import { BigNumber, ethers } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runExecutePrepared } from "../src/actions.js";
import { buildPreparedFixture } from "./helpers/prepared.js";
import { mockBaseProvider } from "./helpers/provider.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("runExecutePrepared", () => {
  it("rejects execute when the RPC resolves to the wrong chain", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet);

    mockBaseProvider({ chainId: 1, name: "homestead" });

    await expect(runExecutePrepared({ preparedAction })).rejects.toMatchObject({
      code: "RPC_CHAIN_MISMATCH"
    });
  });

  it("rejects execute when the prepared chainId does not match the selected runtime network", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet, {
      chainId: 1
    });

    await expect(runExecutePrepared({ preparedAction })).rejects.toMatchObject({
      code: "PREPARED_CHAIN_MISMATCH"
    });
  });

  it("rejects execute when the prepared nonce is stale", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet);

    mockBaseProvider({ nonce: 5 });

    await expect(runExecutePrepared({ preparedAction })).rejects.toMatchObject({
      code: "PREPARED_NONCE_STALE"
    });
  });

  it("executes prepared transactions with exact sequential nonces", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet, {
      kind: "borrow",
      startingNonce: 9,
      transactions: [
        {
          label: "approval",
          target: "0x0000000000000000000000000000000000000101",
          value: "0",
          data: "0xaaaa",
          from: wallet.address
        },
        {
          label: "approval",
          target: "0x0000000000000000000000000000000000000102",
          value: "0",
          data: "0xcccc",
          from: wallet.address
        },
        {
          label: "action",
          target: "0x0000000000000000000000000000000000000100",
          value: "0",
          data: "0xbbbb",
          from: wallet.address
        }
      ],
      metadata: {
        amount: "100",
        collateralAmount: "200"
      }
    });

    mockBaseProvider({ nonce: 9 });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "estimateGas").mockResolvedValue(
      BigNumber.from(21_000)
    );

    const nonces: number[] = [];
    vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockImplementation(async (request) => {
      nonces.push(request.nonce as number);
      return {
        hash: `0x${String(nonces.length).padStart(64, "0")}`,
        wait: async () => ({
          status: 1,
          gasUsed: BigNumber.from(21_000)
        })
      } as never;
    });

    const result = await runExecutePrepared({ preparedAction });

    expect(nonces).toEqual([9, 10, 11]);
    expect(result.submitted).toHaveLength(3);
    expect(result.submitted.map((entry) => entry.label)).toEqual(["approval", "approval", "action"]);
  });

  it("estimates and submits dependent transactions in order", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet, {
      kind: "borrow",
      startingNonce: 2,
      transactions: [
        {
          label: "approval",
          target: "0x0000000000000000000000000000000000000101",
          value: "0",
          data: "0xaaaa",
          from: wallet.address
        },
        {
          label: "action",
          target: "0x0000000000000000000000000000000000000100",
          value: "0",
          data: "0xbbbb",
          from: wallet.address
        }
      ]
    });

    mockBaseProvider({ nonce: 2 });
    const steps: string[] = [];
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "estimateGas").mockImplementation(async (request) => {
      steps.push(`estimate:${request.nonce}`);
      if (request.nonce === 3) {
        expect(steps).toContain("send:2");
      }
      return BigNumber.from(21_000);
    });
    vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockImplementation(async (request) => {
      steps.push(`send:${request.nonce}`);
      return {
        hash: `0x${String(request.nonce).padStart(64, "0")}`,
        wait: async () => ({
          status: 1,
          gasUsed: BigNumber.from(21_000)
        })
      } as never;
    });

    const result = await runExecutePrepared({ preparedAction });

    expect(steps).toEqual(["estimate:2", "send:2", "estimate:3", "send:3"]);
    expect(result.submitted).toHaveLength(2);
  });

  it("caps padded gas limits below the latest block gas limit ceiling", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet);

    mockBaseProvider({ nonce: 4, gasLimit: 100_000 });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "estimateGas").mockResolvedValue(
      BigNumber.from(90_000)
    );

    const sendSpy = vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockResolvedValue({
      hash: `0x${"1".padStart(64, "0")}`,
      wait: async () => ({
        status: 1,
        gasUsed: BigNumber.from(90_000)
      })
    } as never);

    await runExecutePrepared({ preparedAction });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        gasLimit: BigNumber.from(95_000)
      })
    );
  });

  it("fails when a submitted transaction is mined with status 0", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet, { startingNonce: 6 });

    mockBaseProvider({ nonce: 6 });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "estimateGas").mockResolvedValue(
      BigNumber.from(21_000)
    );
    vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockResolvedValue({
      hash: `0x${"2".padStart(64, "0")}`,
      wait: async () => ({
        status: 0,
        gasUsed: BigNumber.from(21_000)
      })
    } as never);

    await expect(runExecutePrepared({ preparedAction })).rejects.toMatchObject({
      code: "EXECUTE_TRANSACTION_REVERTED"
    });
  });

  it("surfaces submittedSoFar when a later transaction fails after earlier submissions", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet, {
      kind: "borrow",
      startingNonce: 8,
      transactions: [
        {
          label: "approval",
          target: "0x0000000000000000000000000000000000000101",
          value: "0",
          data: "0xaaaa",
          from: wallet.address
        },
        {
          label: "action",
          target: "0x0000000000000000000000000000000000000100",
          value: "0",
          data: "0xbbbb",
          from: wallet.address
        }
      ]
    });

    mockBaseProvider({ nonce: 8 });
    let estimateCalls = 0;
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "estimateGas").mockImplementation(async () => {
      estimateCalls += 1;
      if (estimateCalls === 2) {
        throw new Error("pool no longer healthy");
      }
      return BigNumber.from(21_000);
    });
    vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockResolvedValue({
      hash: `0x${"4".padStart(64, "0")}`,
      wait: async () => ({
        status: 1,
        gasUsed: BigNumber.from(21_000)
      })
    } as never);

    await expect(runExecutePrepared({ preparedAction })).rejects.toMatchObject({
      code: "EXECUTE_VERIFICATION_FAILED",
      details: {
        submittedSoFar: [
          {
            label: "approval",
            hash: `0x${"4".padStart(64, "0")}`,
            status: 1,
            gasUsed: "21000"
          }
        ]
      }
    });
  });

  it("fails distinctly when a transaction receipt omits status", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet, { startingNonce: 7 });

    mockBaseProvider({ nonce: 7 });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "estimateGas").mockResolvedValue(
      BigNumber.from(21_000)
    );
    vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockResolvedValue({
      hash: `0x${"3".padStart(64, "0")}`,
      wait: async () => ({
        gasUsed: BigNumber.from(21_000)
      })
    } as never);

    await expect(runExecutePrepared({ preparedAction })).rejects.toMatchObject({
      code: "EXECUTE_RECEIPT_STATUS_UNKNOWN"
    });
  });

  it("surfaces the original submitted hash when wait throws after submit", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet, { startingNonce: 10 });

    mockBaseProvider({ nonce: 10 });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "estimateGas").mockResolvedValue(
      BigNumber.from(21_000)
    );
    vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockResolvedValue({
      hash: `0x${"5".padStart(64, "0")}`,
      wait: async () => {
        const error = new Error("timed out") as Error & { code: string };
        error.code = "TIMEOUT";
        throw error;
      }
    } as never);

    await expect(runExecutePrepared({ preparedAction })).rejects.toMatchObject({
      code: "EXECUTE_WAIT_FAILED",
      details: {
        hash: `0x${"5".padStart(64, "0")}`,
        waitErrorCode: "TIMEOUT",
        submittedSoFar: [
          {
            label: "action",
            hash: `0x${"5".padStart(64, "0")}`,
            status: null,
            gasUsed: null
          }
        ]
      }
    });
  });

  it("accepts a repriced replacement when the mined replacement matches the prepared tx intent", async () => {
    const wallet = ethers.Wallet.createRandom();

    process.env.AJNA_SKILLS_MODE = "execute";
    process.env.AJNA_SIGNER_PRIVATE_KEY = wallet.privateKey;
    process.env.AJNA_RPC_URL_BASE = "http://127.0.0.1:8545";

    const preparedAction = await buildPreparedFixture(wallet, {
      startingNonce: 11,
      transactions: [
        {
          label: "action",
          target: "0x0000000000000000000000000000000000000100",
          value: "0",
          data: "0x1234",
          from: wallet.address
        }
      ]
    });

    mockBaseProvider({ nonce: 11 });
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, "estimateGas").mockResolvedValue(
      BigNumber.from(21_000)
    );
    vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockResolvedValue({
      hash: `0x${"6".padStart(64, "0")}`,
      wait: async () => {
        throw {
          code: "TRANSACTION_REPLACED",
          cancelled: false,
          reason: "repriced",
          replacement: {
            hash: `0x${"7".padStart(64, "0")}`,
            to: "0x0000000000000000000000000000000000000100",
            data: "0x1234",
            value: BigNumber.from(0)
          },
          receipt: {
            status: 1,
            gasUsed: BigNumber.from(21_000)
          }
        };
      }
    } as never);

    const result = await runExecutePrepared({ preparedAction });

    expect(result.submitted).toEqual([
      {
        label: "action",
        hash: `0x${"7".padStart(64, "0")}`,
        status: 1,
        gasUsed: "21000"
      }
    ]);
  });
});
