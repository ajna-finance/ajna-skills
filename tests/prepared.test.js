import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { finalizePreparedAction, validatePreparedAction } from "../src/prepared.js";
describe("prepared action integrity", () => {
    it("signs and validates when signer matches actor", async () => {
        const wallet = ethers.Wallet.createRandom();
        const runtime = {
            mode: "execute",
            signerPrivateKey: wallet.privateKey,
            executeSignerAddress: wallet.address,
            networks: {
                base: {
                    network: "base",
                    chainId: 8453,
                    rpcUrl: "http://localhost:8545",
                    ajnaToken: "0x0000000000000000000000000000000000000001",
                    erc20PoolFactory: "0x0000000000000000000000000000000000000002",
                    erc721PoolFactory: "0x0000000000000000000000000000000000000003",
                    poolInfoUtils: "0x0000000000000000000000000000000000000004",
                    positionManager: "0x0000000000000000000000000000000000000005"
                },
                ethereum: {
                    network: "ethereum",
                    chainId: 1,
                    rpcUrl: "http://localhost:8545",
                    ajnaToken: "0x0000000000000000000000000000000000000011",
                    erc20PoolFactory: "0x0000000000000000000000000000000000000012",
                    erc721PoolFactory: "0x0000000000000000000000000000000000000013",
                    poolInfoUtils: "0x0000000000000000000000000000000000000014",
                    positionManager: "0x0000000000000000000000000000000000000015"
                }
            }
        };
        const prepared = await finalizePreparedAction({
            version: 1,
            kind: "lend",
            network: "base",
            chainId: 8453,
            actorAddress: wallet.address,
            poolAddress: "0x0000000000000000000000000000000000000100",
            quoteAddress: "0x0000000000000000000000000000000000000101",
            collateralAddress: "0x0000000000000000000000000000000000000102",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            transactions: [
                {
                    label: "action",
                    target: "0x0000000000000000000000000000000000000100",
                    value: "0",
                    data: "0x1234",
                    from: wallet.address
                }
            ],
            metadata: {
                amount: "100"
            }
        }, runtime);
        expect(prepared.signature).toBeTruthy();
        expect(() => validatePreparedAction(prepared, runtime)).not.toThrow();
    });
    it("rejects tampered payloads", async () => {
        const wallet = ethers.Wallet.createRandom();
        const runtime = {
            mode: "execute",
            signerPrivateKey: wallet.privateKey,
            executeSignerAddress: wallet.address,
            networks: {
                base: {
                    network: "base",
                    chainId: 8453,
                    rpcUrl: "http://localhost:8545",
                    ajnaToken: "0x0000000000000000000000000000000000000001",
                    erc20PoolFactory: "0x0000000000000000000000000000000000000002",
                    erc721PoolFactory: "0x0000000000000000000000000000000000000003",
                    poolInfoUtils: "0x0000000000000000000000000000000000000004",
                    positionManager: "0x0000000000000000000000000000000000000005"
                },
                ethereum: {
                    network: "ethereum",
                    chainId: 1,
                    rpcUrl: "http://localhost:8545",
                    ajnaToken: "0x0000000000000000000000000000000000000011",
                    erc20PoolFactory: "0x0000000000000000000000000000000000000012",
                    erc721PoolFactory: "0x0000000000000000000000000000000000000013",
                    poolInfoUtils: "0x0000000000000000000000000000000000000014",
                    positionManager: "0x0000000000000000000000000000000000000015"
                }
            }
        };
        const prepared = await finalizePreparedAction({
            version: 1,
            kind: "borrow",
            network: "base",
            chainId: 8453,
            actorAddress: wallet.address,
            poolAddress: "0x0000000000000000000000000000000000000100",
            quoteAddress: "0x0000000000000000000000000000000000000101",
            collateralAddress: "0x0000000000000000000000000000000000000102",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            transactions: [
                {
                    label: "action",
                    target: "0x0000000000000000000000000000000000000100",
                    value: "0",
                    data: "0x1234",
                    from: wallet.address
                }
            ],
            metadata: {
                amount: "100"
            }
        }, runtime);
        const tampered = {
            ...prepared,
            metadata: {
                ...prepared.metadata,
                amount: "999"
            }
        };
        expect(() => validatePreparedAction(tampered, runtime)).toThrow(/digest/i);
    });
});
