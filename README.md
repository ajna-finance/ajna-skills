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
prepared payloads are valid for dry runs, but execution rejects them.
