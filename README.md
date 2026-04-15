# Ajna Skills

`ajna-skills` is a repo-installable AgentSkills package that lets autonomous
agents inspect Ajna markets, prepare Ajna transactions, and execute previously
prepared actions under an explicit local policy.

This repo is intentionally scoped to one shipped thing in v1:

- one install surface, a repo-root AgentSkills-compatible skill
- one SDK dependency, [`@ajna-finance/sdk`](https://www.npmjs.com/package/@ajna-finance/sdk)
- one signer model, a local EVM private key
- one execute contract, prepare first then execute
- two officially supported runtimes, OpenClaw and Hermes
- wrong-chain RPC rejection before any action executes
- one-shot prepared payloads bound to the actor nonce at prepare time

## Status

Pre-v1. This repo is being built to match the approved design and eng review in
`~/.gstack/projects/ajna-skills/`.

## Planned v1 commands

- `inspect-pool`
- `inspect-bucket`
- `inspect-position`
- `prepare-create-erc20-pool`
- `prepare-create-erc721-pool`
- `prepare-lend`
- `prepare-borrow`
- `prepare-approve-erc20`
- `prepare-approve-erc721`
- `prepare-unsupported-ajna-action`
- `execute-prepared`

Each command will accept a single JSON payload and print normalized JSON output.
That keeps the public contract explicit and agent-friendly.

## Built-in networks

V1 includes built-in contract presets for:

- `base`
- `ethereum`

You only need to provide an RPC URL for the network you plan to use:

```bash
export AJNA_RPC_URL_BASE="https://..."
```

Or use a generic fallback:

```bash
export AJNA_RPC_URL="https://..."
```

Unsafe escape hatch is disabled by default. To allow unsupported Ajna contract
calls to be prepared:

```bash
export AJNA_ENABLE_UNSAFE_SDK_CALLS=1
```

## Development

```bash
npm install
npm run build
npm test
```

Optional chain-backed smoke test:

```bash
export RUN_AJNA_CHAIN_TESTS=1
export AJNA_RPC_URL_BASE="https://..."
export AJNA_TEST_POOL_ADDRESS="0x..."
npm run test:chain
```

Optional fork-backed execute test:

```bash
export AJNA_BASE_FORK_URL="https://..."
export AJNA_BASE_FORK_BLOCK_NUMBER=44450000
export AJNA_TEST_POOL_ADDRESS="0x97dbbdba28df6d629bc17e0349bcb73d541ed041"
export AJNA_TEST_BUCKET_INDEX=3232
export AJNA_TEST_FUND_AMOUNT_RAW=100000000
export AJNA_TEST_LEND_AMOUNT_WAD=100000000000000000000
export AJNA_TEST_BORROW_LIMIT_INDEX=5000
export AJNA_TEST_COLLATERAL_FUND_AMOUNT_RAW=50000000000000000000
export AJNA_TEST_COLLATERAL_AMOUNT_WAD=50000000000000000000
export AJNA_TEST_BORROW_AMOUNT_WAD=1000000000000000000
export AJNA_TEST_TTL_SECONDS=31536000
export AJNA_TEST_QUOTE_WHALE="0xee7ae85f2fe2239e27d9c1e23fffe168d63b4055"
export AJNA_TEST_COLLATERAL_WHALE="0x78f691c07e58fa6808e77915027ea1ca883d721d"
export AJNA_TEST_ERC721_TOKEN_ADDRESS="0x3c1027c40c281835e38d7950d74b3de5f9d21ef4"
export AJNA_TEST_ERC721_TOKEN_ID=1
export AJNA_TEST_ERC721_HOLDER="0x75360e6aDe76eA0258BA195Ca0905c5A5D354f68"
npm run test:fork
```

This path starts a local Anvil fork, runs real `prepare-* -> execute-prepared`
flows for lend, borrow, standalone ERC20 approval, standalone ERC721 approval,
and the unsupported `erc20-pool.updateInterest()` escape hatch, then asserts
that replaying the same prepared payload fails once the signer nonce has moved.
Set `AJNA_BASE_FORK_BLOCK_NUMBER` in CI if you want deterministic state across
runs. `AJNA_TEST_TTL_SECONDS` exists so old pinned blocks do not fail only
because the prepared payload expired relative to wall-clock time. Foundry is only
needed for this optional test path.

`AJNA_TEST_FUND_AMOUNT_RAW` is the quote-token transfer amount in native token
units, while `AJNA_TEST_LEND_AMOUNT_WAD` is the Ajna lend amount in WAD precision.
For backward compatibility, the fork runner still accepts the older
`AJNA_TEST_LEND_AMOUNT` name as a fallback for the WAD value. The borrow fixture
uses the same pinned pool and block, with `AJNA_TEST_COLLATERAL_FUND_AMOUNT_RAW`
for the AERO transfer, `AJNA_TEST_COLLATERAL_AMOUNT_WAD` for pledged collateral,
and `AJNA_TEST_BORROW_AMOUNT_WAD` for the borrowed USDC amount. The ERC721 fixture
uses Ratbase token `1`, transferred from a pinned holder to the test signer before
executing a standalone approval to the pool target.

## Runtime model

The skill itself lives at repo root so it can be installed directly into common
AgentSkills locations:

```bash
git clone <repo> ~/.agents/skills/ajna-skills
cd ~/.agents/skills/ajna-skills
npm install
npm run build
```

Or via the ecosystem installer:

```bash
npx skills add <owner>/<repo>
```

## Safety model

- inspect is always read-only
- prepare never sends a transaction
- execute only accepts a previously prepared payload
- execute preflights the whole prepared sequence before sending the first transaction
- execute requires a local signer and explicit policy mode
- execute rejects RPC endpoints that resolve to the wrong chain
- execute rejects prepared payloads once the signer nonce has moved, re-prepare instead
- unsupported Ajna actions are prepare-only and require an explicit env gate plus acknowledgement phrase

## JSON command contract

### `inspect-pool`

```json
{
  "network": "base",
  "poolAddress": "0x..."
}
```

Optional full mode:

```json
{
  "network": "base",
  "poolAddress": "0x...",
  "detailLevel": "full"
}
```

Or discover by token pair:

```json
{
  "network": "base",
  "collateralAddress": "0x...",
  "quoteAddress": "0x..."
}
```

Basic mode returns the agent-friendly pool summary. Full mode adds:

- pool type and token scales
- borrow rate, lender interest margin, and rate-update timestamp
- pool debt, debt in auction, pending inflator, pending interest factor
- pledged collateral and reserve-auction state

### `inspect-bucket`

```json
{
  "network": "base",
  "poolAddress": "0x...",
  "bucketIndex": 3232
}
```

This returns normalized bucket-level liquidity data:

- price
- quote tokens
- collateral
- bucket LP
- bucket scale
- exchange rate
- collateral dust

### `inspect-position`

Borrower position:

```json
{
  "network": "base",
  "poolAddress": "0x...",
  "owner": "0x...",
  "positionType": "borrower"
}
```

Lender bucket position:

```json
{
  "network": "base",
  "poolAddress": "0x...",
  "owner": "0x...",
  "positionType": "lender",
  "bucketIndex": 3232
}
```

### `prepare-lend`

```json
{
  "network": "base",
  "poolAddress": "0x...",
  "actorAddress": "0x...",
  "amount": "1000000000000000000",
  "bucketIndex": 3232,
  "ttlSeconds": 600,
  "approvalMode": "exact"
}
```

`amount` is an Ajna WAD-sized action amount. For `"approvalMode":"exact"`, the
skill derives the ERC20 approval amount from the pool token scale instead of
reusing the WAD value directly.

### `prepare-create-erc20-pool`

```json
{
  "network": "base",
  "actorAddress": "0x...",
  "collateralAddress": "0x...",
  "quoteAddress": "0x...",
  "interestRate": "50000000000000000",
  "maxAgeSeconds": 600
}
```

This prepares one ERC20 Ajna factory deployment and rejects if the pool already
exists for the provided collateral and quote token pair.

### `prepare-create-erc721-pool`

Collection pool:

```json
{
  "network": "base",
  "actorAddress": "0x...",
  "collateralAddress": "0x...",
  "quoteAddress": "0x...",
  "interestRate": "50000000000000000",
  "maxAgeSeconds": 600
}
```

Subset pool:

```json
{
  "network": "base",
  "actorAddress": "0x...",
  "collateralAddress": "0x...",
  "quoteAddress": "0x...",
  "interestRate": "50000000000000000",
  "tokenIds": ["1", "2", "5"],
  "maxAgeSeconds": 600
}
```

If `tokenIds` is omitted or empty, the skill prepares a collection pool.
Otherwise it normalizes the token IDs into a sorted unique subset before hashing
them for Ajna pool lookup.

### `prepare-borrow`

```json
{
  "network": "base",
  "poolAddress": "0x...",
  "actorAddress": "0x...",
  "amount": "1000000000000000000",
  "collateralAmount": "2000000000000000000",
  "limitIndex": 3232,
  "approvalMode": "exact",
  "maxAgeSeconds": 600
}
```

`amount` and `collateralAmount` are Ajna WAD-sized action amounts. For
`"approvalMode":"exact"`, the collateral approval is converted to raw token
units using the pool collateral scale.

### `prepare-approve-erc20`

```json
{
  "network": "base",
  "actorAddress": "0x...",
  "tokenAddress": "0x...",
  "poolAddress": "0x...",
  "amount": "1000000000000000000",
  "approvalMode": "exact",
  "maxAgeSeconds": 600
}
```

`poolAddress` must be a real Ajna pool on the selected network. This command no
longer allows arbitrary spender approvals through a fake or unrelated target.
If the existing allowance already matches the requested state, prepare now fails
instead of returning an empty no-op payload.

### `prepare-approve-erc721`

Single-token approval:

```json
{
  "network": "base",
  "actorAddress": "0x...",
  "tokenAddress": "0x...",
  "poolAddress": "0x...",
  "tokenId": "123",
  "maxAgeSeconds": 600
}
```

`poolAddress` must be a real Ajna pool on the selected network.
If the NFT approval already matches the requested state, prepare now fails
instead of returning an empty no-op payload.

### `prepare-unsupported-ajna-action`

This is the advanced escape hatch for unsupported Ajna-native operations. It is
disabled by default and only prepares the call. You still execute it through
`execute-prepared` after review.

Allowed `contractKind` values are:

- `erc20-pool`
- `erc721-pool`
- `position-manager`
- `ajna-token`

Example:

```json
{
  "network": "base",
  "actorAddress": "0x...",
  "contractKind": "position-manager",
  "methodName": "memorializePositions",
  "args": ["0x...", "123", ["1", "2"]],
  "acknowledgeRisk": "I understand this bypasses the stable skill surface",
  "notes": "operator requested unsupported Ajna action"
}
```

Pass large integer args such as `uint256`, token IDs, or bucket indexes as
quoted strings when they may exceed JavaScript's safe integer range.

For pool calls, include `contractAddress`. For `position-manager` and
`ajna-token`, the skill uses the built-in Ajna address for the selected network
and rejects mismatches. The skill now resolves the ABI from built-in Ajna
contract ABIs by `contractKind`, so `abiFragment` is optional. Provide it only
when you want to disambiguate an overloaded method or pin the exact signature
explicitly.

Operator approval for all owned NFTs:

```json
{
  "network": "base",
  "actorAddress": "0x...",
  "tokenAddress": "0x...",
  "poolAddress": "0x...",
  "approveForAll": true,
  "maxAgeSeconds": 600
}
```

### `execute-prepared`

Requires:

```bash
export AJNA_SKILLS_MODE=execute
export AJNA_SIGNER_PRIVATE_KEY=0x...
```

Then:

```json
{
  "preparedAction": {
    "...": "result from any prepare-* command"
  }
}
```

Prepared payloads are signed when the local signer matches `actorAddress`. Unsigned
prepared payloads are valid for dry runs, but execution rejects them. Executable
payloads are also bound to the actor's pending nonce, so retries after any other
signer activity require a fresh prepare step. For pool-creation payloads, the
execute result also attempts to include `resolvedPoolAddress` after the factory
transaction confirms.

## Unsupported Action Notes

`prepare-unsupported-ajna-action` exists as an escape hatch, not the main product.
It is intentionally ugly:

- it must be enabled with `AJNA_ENABLE_UNSAFE_SDK_CALLS=1`
- it requires the exact acknowledgement phrase `I understand this bypasses the stable skill surface`
- it only prepares the call, never sends it directly
- it is restricted to Ajna-related contract kinds, not arbitrary addresses by default

The benefit of keeping it prepare-only is that the raw call still goes through
the normal digest, signature, expiry, wrong-chain, and nonce-staleness checks
before `execute-prepared` sends anything.
