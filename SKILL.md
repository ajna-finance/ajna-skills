---
name: ajna-skills
description: Inspect Ajna markets, prepare Ajna lend, borrow, and token approval transactions, and execute approved prepared actions with a local signer.
---

# Ajna Skills

Use this skill when you need Ajna-specific actions from an autonomous agent.

This skill is intentionally narrow in v1. It does not expose the full
`@ajna-finance/sdk` surface. It provides a small set of explicit commands with
stable JSON inputs and outputs.

## Preconditions

1. The skill has been installed into your agent's skills directory.
2. Dependencies are installed:

```bash
npm install
npm run build
```

3. For inspect-only commands, set a network RPC URL:

```bash
export AJNA_RPC_URL_BASE="https://..."
```

4. For execute-capable commands, also set:

```bash
export AJNA_SKILLS_MODE="execute"
export AJNA_SIGNER_PRIVATE_KEY="0x..."
```

5. For the unsupported Ajna escape hatch, also set:

```bash
export AJNA_ENABLE_UNSAFE_SDK_CALLS="1"
```

## Supported commands

All commands accept one JSON payload argument and print one JSON result.

### Inspect pool

```bash
node dist/cli.js inspect-pool '{"network":"base","poolAddress":"0x..."}'
```

### Inspect position

```bash
node dist/cli.js inspect-position '{"network":"base","poolAddress":"0x...","owner":"0x...","positionType":"borrower"}'
```

For lender positions, also include `bucketIndex` and set `"positionType":"lender"`.

### Prepare lend

```bash
node dist/cli.js prepare-lend '{"network":"base","poolAddress":"0x...","actorAddress":"0x...","amount":"1000000000000000000","bucketIndex":1234,"approvalMode":"exact"}'
```

### Prepare borrow

```bash
node dist/cli.js prepare-borrow '{"network":"base","poolAddress":"0x...","actorAddress":"0x...","amount":"1000000000000000000","collateralAmount":"2000000000000000000","limitIndex":1234,"approvalMode":"exact"}'
```

### Prepare ERC20 approval

```bash
node dist/cli.js prepare-approve-erc20 '{"network":"base","poolAddress":"0x...","tokenAddress":"0x...","actorAddress":"0x...","amount":"1000000000000000000","approvalMode":"exact"}'
```

### Prepare ERC721 approval

Single-token approval:

```bash
node dist/cli.js prepare-approve-erc721 '{"network":"base","poolAddress":"0x...","tokenAddress":"0x...","actorAddress":"0x...","tokenId":"123"}'
```

Or operator approval for all NFTs on that collection:

```bash
node dist/cli.js prepare-approve-erc721 '{"network":"base","poolAddress":"0x...","tokenAddress":"0x...","actorAddress":"0x...","approveForAll":true}'
```

### Prepare unsupported Ajna action

```bash
node dist/cli.js prepare-unsupported-ajna-action '{"network":"base","actorAddress":"0x...","contractKind":"position-manager","abiFragment":"function memorializePositions(address,uint256[])","methodName":"memorializePositions","args":["0x...",["1","2"]],"acknowledgeRisk":"I understand this bypasses the stable skill surface","notes":"operator requested unsupported Ajna action"}'
```

### Execute prepared payload

```bash
node dist/cli.js execute-prepared '{"preparedAction":{...}}'
```

## Safety rules

- Never execute directly from a fresh user prompt. Always inspect, then prepare,
  then review the prepared payload, then execute.
- `execute-prepared` only works in `AJNA_SKILLS_MODE=execute`.
- If a prepared payload is unsigned, stale, or mutated, execution should fail.
- If the RPC endpoint resolves to the wrong chain, fail before any transaction send.
- If the signer nonce changed since prepare time, re-prepare instead of retrying.
- If you are missing RPC or signer config, fail clearly instead of guessing.
- Unsupported Ajna actions must stay prepare-only and require both the env gate and the exact acknowledgement phrase.

## Notes

- v1 officially supports OpenClaw and Hermes only.
- The skill stays inside the shared AgentSkills subset to keep behavior portable.
- Ajna lend and borrow actions in v1 still target ERC20 pools only.
- v1 also supports preparing ERC20 and ERC721 approvals to a pool/operator target.
- `prepare-unsupported-ajna-action` is the explicit advanced escape hatch for unsupported Ajna-native calls.
