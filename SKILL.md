---
name: ajna-skills
description: Inspect Ajna pools, buckets, and positions; prepare Ajna pool creation, lend, borrow, token approvals, and advanced Ajna-native actions; and execute reviewed prepared actions with a local signer.
---

# Ajna Skills

Use this skill when a user wants to inspect Ajna state or prepare and execute
Ajna-native actions on `base` or `ethereum`.

If you need deeper context, read:

- `references/ajna-overview.md` for Ajna mental models, buckets, pool types,
  and realistic operating flows.
- `references/official-sources.md` for official Ajna docs, deployment
  references, and runtime-specific skill docs.

## When to use

- Inspect an Ajna pool, bucket, or position.
- Prepare or execute Ajna ERC20 lend and borrow actions.
- Prepare ERC20 or ERC721 approvals for Ajna-related interactions.
- Create Ajna ERC20 or ERC721 pools.
- Prepare a supported but not yet first-class Ajna-native state-changing call
  through the gated escape hatch.

## Do not use

- Arbitrary token deployment or generic wallet operations unrelated to Ajna.
- Blind direct execution from a fresh prompt.
- Generic contract interaction when the user has not asked for an Ajna-native
  action.
- Portfolio or strategy advice without concrete user intent and parameters.

## What Ajna is

- Ajna is a permissionless lending protocol with no price oracles.
- Each pool has a quote token and a collateral asset.
- Lender liquidity is organized into price buckets. Bucket choice matters.
- ERC20 pools and ERC721 pools are different pool types.
- In this v1 skill, pool creation supports ERC20 and ERC721 pools, but the
  explicit lend and borrow commands target ERC20 pools only.
- Creating a pool is not enough to borrow. Someone still has to supply quote
  liquidity first.

## Preconditions

1. The skill is installed in the agent's skills directory.
2. Dependencies are installed:

```bash
npm install
npm run build
```

3. Set an RPC URL. For a simple single-chain install, use:

```bash
export AJNA_RPC_URL="https://..."
```

If you want per-chain overrides, use `AJNA_RPC_URL_BASE` and/or
`AJNA_RPC_URL_ETHEREUM`.

4. For execute-capable commands, also set:

```bash
export AJNA_SKILLS_MODE="execute"
export AJNA_SIGNER_PRIVATE_KEY="0x..."
```

5. For the advanced unsupported-action escape hatch, also set:

```bash
export AJNA_ENABLE_UNSAFE_SDK_CALLS="1"
```

## Interaction model

1. Inspect first with `inspect-pool`, `inspect-bucket`, or `inspect-position`.
2. Prepare exactly one action and review the normalized prepared payload.
3. Execute only from `execute-prepared`.
4. Verify the result with a follow-up inspect call or allowance/position check.

Preferred examples:

- New or unknown pool: `inspect-pool` with `"detailLevel":"full"`.
- Bucket-sensitive lend decision: `inspect-bucket` before `prepare-lend`.
- Existing borrower: `inspect-position` before modifying debt or collateral.
- New pool creation: execute, capture `resolvedPoolAddress`, then inspect the
  created pool before doing anything else with it.

## Commands

All commands accept one JSON payload and print one JSON result.

### Read commands

Inspect a pool:

```bash
node dist/cli.js inspect-pool '{"network":"base","poolAddress":"0x..."}'
```

Ask for fuller state when you need rates, debt, or reserve-auction state:

```bash
node dist/cli.js inspect-pool '{"network":"base","poolAddress":"0x...","detailLevel":"full"}'
```

Inspect one bucket:

```bash
node dist/cli.js inspect-bucket '{"network":"base","poolAddress":"0x...","bucketIndex":3232}'
```

Inspect a borrower or lender position:

```bash
node dist/cli.js inspect-position '{"network":"base","poolAddress":"0x...","owner":"0x...","positionType":"borrower"}'
```

For lender positions, also include `bucketIndex` and set
`"positionType":"lender"`.

### Supported write preparation

Prepare ERC20 pool creation:

```bash
node dist/cli.js prepare-create-erc20-pool '{"network":"base","actorAddress":"0x...","collateralAddress":"0x...","quoteAddress":"0x...","interestRate":"50000000000000000"}'
```

Prepare ERC721 pool creation:

```bash
node dist/cli.js prepare-create-erc721-pool '{"network":"base","actorAddress":"0x...","collateralAddress":"0x...","quoteAddress":"0x...","interestRate":"50000000000000000"}'
```

For an ERC721 subset pool, also include `tokenIds`.

Prepare lend:

```bash
node dist/cli.js prepare-lend '{"network":"base","poolAddress":"0x...","actorAddress":"0x...","amount":"1000000000000000000","bucketIndex":1234,"approvalMode":"exact"}'
```

`amount` is an Ajna WAD-sized action amount. Exact approvals are converted to
raw token units from the pool token scale.

Prepare borrow:

```bash
node dist/cli.js prepare-borrow '{"network":"base","poolAddress":"0x...","actorAddress":"0x...","amount":"1000000000000000000","collateralAmount":"2000000000000000000","limitIndex":1234,"approvalMode":"exact"}'
```

`amount` and `collateralAmount` are Ajna WAD-sized action amounts.

Prepare ERC20 approval:

```bash
node dist/cli.js prepare-approve-erc20 '{"network":"base","poolAddress":"0x...","tokenAddress":"0x...","actorAddress":"0x...","amount":"1000000000000000000","approvalMode":"exact"}'
```

`poolAddress` must be a real Ajna pool on the selected network.
If the requested allowance is already satisfied, prepare fails instead of
returning an empty payload.

Prepare ERC721 approval:

```bash
node dist/cli.js prepare-approve-erc721 '{"network":"base","poolAddress":"0x...","tokenAddress":"0x...","actorAddress":"0x...","tokenId":"123"}'
```

Or operator approval for all NFTs on that collection:

```bash
node dist/cli.js prepare-approve-erc721 '{"network":"base","poolAddress":"0x...","tokenAddress":"0x...","actorAddress":"0x...","approveForAll":true}'
```

`poolAddress` must be a real Ajna pool on the selected network.
If the requested approval is already satisfied, prepare fails instead of
returning an empty payload.

Execute a reviewed payload:

```bash
node dist/cli.js execute-prepared '{"preparedAction":{...}}'
```

### Advanced command

Prepare an unsupported Ajna-native action:

```bash
node dist/cli.js prepare-unsupported-ajna-action '{"network":"base","actorAddress":"0x...","contractKind":"position-manager","methodName":"memorializePositions","args":["0x...","123",["1","2"]],"acknowledgeRisk":"I understand this bypasses the stable skill surface","notes":"operator requested unsupported Ajna action"}'
```

Use this only when there is no first-class command for the requested Ajna
action. It still stays on the same `prepare -> review -> execute` path. It is
not a direct-execute shortcut.
Pass large integers as quoted strings when they may exceed JavaScript's safe
integer range.

## Pitfalls

- RPC mismatch: if the RPC endpoint resolves to the wrong chain, stop and fix
  configuration before continuing.
- Fresh pool assumptions: a newly created pool may still have no quote
  liquidity, so borrowing may be impossible or meaningless until lenders seed it.
- Pool-type mismatch: ERC20 and ERC721 pools are different. Do not assume an
  ERC20 borrow/lend flow applies to an ERC721 pool.
- Bucket blindness: bucket choice matters. Inspect the target bucket before
  treating a lend action as realistic.
- Unit mistakes: amounts are big-integer strings, not friendly UI decimals.
  When you are unsure about units or scaling, read `references/ajna-overview.md`
  and cross-check the examples in `README.md`.
- One-shot prepared payloads: if the signer nonce moved, re-prepare instead of
  retrying the old payload.
- Unsupported actions: use the escape hatch only for Ajna-native calls and only
  when the operator explicitly wants the unsupported action.

## Verification

- After pool creation, inspect the returned `resolvedPoolAddress`.
- After lend, inspect the same bucket or lender position again.
- After borrow, inspect the borrower position again.
- After approval, confirm allowance or approval state before assuming the next
  step will succeed.
- After an unsupported action, verify the intended onchain state with an
  explicit read. Do not treat "transaction mined" as enough.

## Safety rules

- Never execute directly from a fresh user prompt.
- Always inspect, then prepare, then review, then execute, then verify.
- Execution preflights the whole prepared sequence before sending the first
  transaction.
- `execute-prepared` only works in `AJNA_SKILLS_MODE=execute`.
- If a prepared payload is unsigned, stale, mutated, or nonce-invalid,
  execution should fail.
- Unsupported Ajna actions require both the env gate and the exact
  acknowledgement phrase.

## References

- Read `references/ajna-overview.md` for Ajna mental models and operator
  guidance.
- Read `references/official-sources.md` for official protocol, deployment, and
  runtime docs.
