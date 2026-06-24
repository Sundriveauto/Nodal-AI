# Nodal AI

[![CI](https://github.com/Nodal-stellar/Nodal-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/Nodal-stellar/Nodal-AI/actions/workflows/ci.yml)
**Modular, production-ready Agent Kit for autonomous PayFi (Payment-Finance) flows on the Stellar Network.**

Nodal AI empowers developers to build autonomous agents capable of handling complex financial interactions. Whether you’re automating cross-border settlements, building machine-to-machine payment gateways, or orchestrating smart contract executions, Nodal AI provides the primitives to do it securely and efficiently on Stellar.

---

## Why Nodal AI?

In the era of **PayFi**, payments are no longer just passive transfers they are programmable, autonomous, and integrated into the global financial fabric. Nodal AI bridges the gap between AI reasoning and Stellar's high-speed, low-cost network.

- **Autonomous PayFi:** Built-in support for the `x402` payment standard, enabling seamless machine-to-machine value exchange.
- **Modular Architecture:** Swap in new tools, chain actions, and orchestrate complex workflows without touching core signing logic.
- **Safety-First Design:** Every transaction is simulated via Soroban RPC before broadcast, and all secrets remain strictly externalized.

---

## Architecture

Nodal AI is built on a clean, three-pillar separation of concerns. For a deep dive into the system design, tool dispatch, simulation gates, and state machines, please read the [Architecture Guide](./ARCHITECTURE.md).

```text
/
├── backend/            # Agent orchestration (TypeScript/Node.js)
├── contracts/          # Soroban smart contracts (Rust)
└── tests/              # E2E & integration tests (Vitest)

```

---

## Quick Start

1. **Clone & Configure:**

   ```bash
   git clone https://github.com/your-username/nodal-ai.git
   cd nodal-ai
   cp .env.example .env
   ```

   Open `.env` and fill in at minimum `AGENT_SECRET_KEY`, `HORIZON_URL`, `SOROBAN_RPC_URL`, and `X402_ASSET_ISSUER`. See [`.env.example`](./.env.example) for the full list of variables and their descriptions.

2. **Install Dependencies:**

   ```bash
   npm install
   ```

3. **Verify Installation:**
   ```bash
   npm run build
   npm run test
   ```

---

## Development & Testing

### Backend (TypeScript)

The `backend/` pillar contains the "Agent Brain." Use it to define tools and manage agent state.

- `npm run build`: Compiles the TypeScript agent core.

### Smart Contracts (Rust/Soroban)

The `contracts/` pillar holds your escrow and payment logic.

- `cd contracts/escrow && cargo test`: Run the suite of Soroban unit tests to ensure contract safety.

### Integration Testing

We use `Vitest` to ensure the entire flow—from AI reasoning to network settlement—works as expected.

- `npm run test`: Executes the `/tests` suite.
- `npm run test:ui`: Runs the test suite with the interactive Vitest UI.

---

## Docker

Nodal AI includes a multi-stage Dockerfile and Docker Compose stack for local development, testing, and deployment.

### Running with Docker Compose

1. **Start the local Stellar network and Nodal agent:**

   ```bash
   docker-compose up --build
   ```

   This will spin up:
   - `stellar-quickstart` at `http://localhost:8000` (Horizon) and `http://localhost:8001` (Soroban RPC).
   - `agent` which automatically connects to the quickstart services once they are healthy.

2. **Stop the services and clean up containers:**
   ```bash
   docker-compose down
   ```

### Run Tests in Docker

You can run the test suite within an isolated test runner container:

```bash
docker-compose --profile test up --build
```

---

## Security Policy

Security is the foundation of PayFi. See [SECURITY.md](./SECURITY.md) for the full responsible disclosure policy, response SLAs, core security invariants, and secret management guidelines.

To report a vulnerability privately, use [GitHub Security Advisories](https://github.com/Dami24-hub/nodal-ai/security/advisories/new).

---

## Contributing

We are actively participating in the **Stellar Wave** program! We welcome contributions ranging from bug fixes to new tool modules.

1.  Check the [Issues](https://github.com/your-username/nodal-ai/issues) tab for tickets tagged `good first issue` or `help wanted`.
2.  Follow the [CONTRIBUTING.md](./CONTRIBUTING.md) guide.
3.  Submit a Pull Request and join our community in the next Wave sprint to earn Drips points for your contributions!

---

## License

Released under the [MIT License](LICENSE).

---

_Built for the Stellar ecosystem by [Dami24-hub]._

````


## x402 Payment Flow

Nodal AI implements the [x402](https://github.com/x402-foundation/x402) protocol so the agent can pay for gated resources autonomously. The verified flow below covers what happens once `PayFiAgent.run()` is dispatched an `x402_respond` task — the upstream step of a resource server actually issuing the 402 challenge happens outside this codebase (in whatever client first calls `PayFiAgent.run()`), so it's described in prose rather than diagrammed.

```mermaid
sequenceDiagram
    participant C as Caller
    participant PA as PayFiAgent
    participant X as X402PaymentTool
    participant ST as StellarPaymentTool
    participant H as Horizon

    C->>PA: run({ type: "x402_respond", payload })
    PA->>PA: assertWithinSpendingLimit(amount)
    PA->>X: respond(challenge)
    X->>X: X402ChallengeSchema.parse(challenge)
    Note over X: reject if amount > AGENT_SPENDING_LIMIT<br/>reject if expiresAt has passed
    X->>ST: execute({ destination: payTo, amount, memo })
    ST->>H: sign + submit transaction
    H-->>ST: txHash, ledger
    ST-->>X: { txHash, ledger }
    X-->>PA: X402PaymentProof
    PA-->>C: AgentResult
````

In practice, the `payload` handed to `run()` is the parsed body of a `402 Payment Required` response from a resource server, conforming to `X402ChallengeSchema` — but the HTTP exchange that obtains and replays that challenge is the caller's responsibility, not `X402PaymentTool`'s.

### Spending limit guard

Before `PayFiAgent.run()` delegates to `X402PaymentTool`, it calls `assertWithinSpendingLimit()` on the payload's `amount` field. If the requested amount exceeds `config.AGENT_SPENDING_LIMIT`, the task throws immediately and `X402PaymentTool.respond()` is never invoked — the agent will not even attempt to validate or pay a challenge above its configured budget.

### `X402ChallengeSchema`

Once past the spending check, `X402PaymentTool.respond()` validates the challenge against this schema before doing anything else:

| Field         | Type                    | Description                                                                                                              |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `resource`    | `string` (URL)          | The URL of the resource being gated. Must be a valid URL.                                                                |
| `amount`      | `string`                | The amount due, as a string to avoid floating-point precision issues in transit.                                         |
| `assetCode`   | `string`                | The Stellar asset code to pay in (e.g. `USDC`, or `XLM` for native). Defaults to `config.X402_ASSET_CODE`.               |
| `assetIssuer` | `string`                | The issuing account of the asset. Defaults to `config.X402_ASSET_ISSUER`. Ignored when `assetCode` is `XLM`.             |
| `payTo`       | `string`                | The recipient Stellar account. Must be exactly 56 characters (a valid Stellar public key).                               |
| `nonce`       | `string` (UUID v4)      | A unique identifier for this challenge, used to correlate the resulting payment with the original request.               |
| `expiresAt`   | `string` (ISO datetime) | The deadline after which the challenge is no longer valid. Checked against `new Date()` before any payment is attempted. |

If `rawChallenge` doesn't conform to this shape, `X402ChallengeSchema.parse()` throws and no payment is attempted.

### Nonce → memo derivation

The challenge's `nonce` is a UUID v4 (36 characters), but Stellar's text memo field caps at 28 bytes. `X402PaymentTool` truncates it directly:

```typescript
memo: challenge.nonce.slice(0, 28);
```

This embeds enough of the nonce on-chain for a resource server to correlate a settled transaction with the original challenge by memo lookup on Horizon. Note this is a string truncation, not a hash — a resource server verifying the proof should compare against the same `slice(0, 28)` of the nonce it issued.

### `X402PaymentProof`

Once `StellarPaymentTool.execute()` returns a settled `txHash`, `respond()` builds and returns:

```typescript
interface X402PaymentProof {
  protocol: "x402"; // protocol tag, always "x402"
  network: string; // config.STELLAR_NETWORK
  txHash: string; // settled Stellar transaction hash
  nonce: string; // the original challenge nonce, in full
  payer: string; // the agent's Stellar public key
  signedAt: string; // ISO timestamp the proof was issued
}
```

The proof carries no embedded signature of its own. Verification is delegated to whatever consumes the proof: it looks up `txHash` on Horizon and confirms the payment's destination, amount, and memo match what the original challenge demanded. The proof is a pointer to on-chain truth, not a self-contained credential.

One thing to flag for reviewers: `StellarPaymentTool.execute()` does **not** run a Soroban simulation pass before submission — its own comments note that Horizon has no simulation endpoint, so it validates the transaction envelope locally, signs, and submits directly. Simulation-before-broadcast is real elsewhere in this codebase (`SorobanInvokeTool`), but not on this payment path — worth keeping the README's general security claims scoped accordingly if they currently imply otherwise project-wide.

### Minimal usage example

```typescript
import { PayFiAgent } from "./backend/agent";

const agent = new PayFiAgent();

// `challenge` is the parsed JSON body of a 402 response from a resource server
const result = await agent.run({
  type: "x402_respond",
  payload: challenge,
});

if (result.success) {
  const proof = result.data; // X402PaymentProof
  // retry the original resource request, attaching `proof`
}
```

See [`backend/agent.ts`](./backend/agent.ts) for task dispatch and the spending-limit guard, and [`backend/tools/X402PaymentTool.ts`](./backend/tools/X402PaymentTool.ts) for challenge validation and proof construction.
