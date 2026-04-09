import type { AjnaNetwork, RuntimeNetworkConfig } from "./types.js";

export const ERC20_NON_SUBSET_HASH =
  "0x2263c4378b4920f0bef611a3ff22c506afa4745b3319c50b6d704a874990b8b2";

export const DEFAULT_TTL_SECONDS = 600;
export const DEFAULT_PREPARED_MAX_AGE_SECONDS = 600;

export const NETWORK_DEFAULTS: Record<AjnaNetwork, Omit<RuntimeNetworkConfig, "rpcUrl">> = {
  base: {
    network: "base",
    chainId: 8453,
    ajnaToken: "0x7F05a7A9AF2f5a07D1e64877C8dC37a64a22508E",
    erc20PoolFactory: "0x214f62B5836D83f3D6c4f71F174209097B1A779C",
    erc721PoolFactory: "0xeefEC5d1Cc4bde97279d01D88eFf9e0fEe981769",
    poolInfoUtils: "0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa",
    positionManager: "0x59710a4149A27585f1841b5783ac704a08274e64"
  },
  ethereum: {
    network: "ethereum",
    chainId: 1,
    ajnaToken: "0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079",
    erc20PoolFactory: "0x6146DD43C5622bB6D12A5240ab9CF4de14eDC625",
    erc721PoolFactory: "0x27461199d3b7381De66a85D685828E967E35AF4c",
    poolInfoUtils: "0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE",
    positionManager: "0x87B0F458d8F1ACD28A83A748bFFbE24bD6B701B1"
  }
};

