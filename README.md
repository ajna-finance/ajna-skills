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
- `inspect-position`
- `prepare-lend`
- `prepare-borrow`
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
export AJNA_TEST_TTL_SECONDS=31536000
export AJNA_TEST_QUOTE_WHALE="0xee7ae85f2fe2239e27d9c1e23fffe168d63b4055"
npm run test:fork
```

This path starts a local Anvil fork, runs one real `prepare-lend -> execute-prepared`
flow, then asserts that replaying the same prepared payload fails once the signer
nonce has moved. Set `AJNA_BASE_FORK_BLOCK_NUMBER` in CI if you want deterministic
state across runs. `AJNA_TEST_TTL_SECONDS` exists so old pinned blocks do not fail
only because the prepared payload expired relative to wall-clock time. Foundry is
only needed for this optional test path. `AJNA_TEST_FUND_AMOUNT_RAW` is the quote
token transfer amount in native token units, while `AJNA_TEST_LEND_AMOUNT_WAD` is
the Ajna lend amount in WAD precision. For backward compatibility, the fork runner
still accepts the older `AJNA_TEST_LEND_AMOUNT` name as a fallback for the WAD
value.

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
- execute requires a local signer and explicit policy mode
- execute rejects RPC endpoints that resolve to the wrong chain
- execute rejects prepared payloads once the signer nonce has moved, re-prepare instead

## JSON command contract

### `inspect-pool`

```json
{
  "network": "base",
  "poolAddress": "0x..."
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
    "...": "result from prepare-lend or prepare-borrow"
  }
}
```

Prepared payloads are signed when the local signer matches `actorAddress`. Unsigned
prepared payloads are valid for dry runs, but execution rejects them. Executable
payloads are also bound to the actor's pending nonce, so retries after any other
signer activity require a fresh prepare step.
