# TODOS

## Distribution

### Publish a reusable npm library surface after v1 skill adoption

**What:** Add a reusable npm library surface for third-party developers after the repo-installable skill proves out.

**Why:** This unlocks non-AgentSkills consumers without forcing v1 to ship multiple public artifacts.

**Context:** V1 is intentionally scoped to one public surface, a repo-installable AgentSkills package for OpenClaw and Hermes. If the normalized Ajna action boundary proves useful, a later npm library can expose those same DTOs and policy-aware helpers for developers who want to embed Ajna capabilities directly.

**Effort:** M
**Priority:** P2
**Depends on:** V1 skill release and validation that the public tool boundary is stable

## Compatibility

### Evaluate runtime support beyond OpenClaw and Hermes

**What:** Assess additional AgentSkills-compatible runtimes after v1 stabilizes.

**Why:** This preserves the long-term compatibility goal without diluting the first release promise.

**Context:** V1 officially supports OpenClaw and Hermes only, and stays inside the shared AgentSkills subset to keep behavior portable. Later work should measure demand, test more runtimes, document incompatibilities, and decide whether broader support is best-effort or officially supported.

**Effort:** M
**Priority:** P3
**Depends on:** V1 release, runtime feedback from real users, and a stable shared skill contract

## Wallets

### Add additional wallet models beyond the local signer

**What:** Support wallet models beyond a local EVM signer after the execute path is stable.

**Why:** This creates a clean path for users who need delegated signing, external wallet callbacks, or other production wallet flows.

**Context:** V1 intentionally supports one wallet model, a local signer loaded from env or runtime config, because it is the smallest testable execution path. Future work can evaluate delegated signing, Safe-style flows, or wallet callbacks only after the current policy-gated execute contract is proven in practice.

**Effort:** M
**Priority:** P3
**Depends on:** Stable v1 execute flow and clear demand for alternate wallet models

## Completed
