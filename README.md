# RecoverAI — AI Revenue Recovery Agent

A focused hackathon build for **Razorpay AI Buildathon — Track 03: AI Revenue Recovery**.

## 1. What it does

RecoverAI acts like a cautious revenue-recovery employee for a merchant:

1. Finds failed/abandoned payments.
2. Estimates revenue at risk.
3. Diagnoses the likely failure cause.
4. Chooses a bounded recovery action.
5. Simulates the recovery in a clearly marked Test Mode.
6. Tracks recovered revenue and recovery rate.
7. Logs every decision/action in an audit trail.
8. Escalates instead of retrying forever.

The demo comes with 100 synthetic transactions so it works immediately.

## 2. Run locally

Requirements: Node.js 18+.

```bash
npm install
copy .env.example .env
npm start
```

Then open:

`http://localhost:3000`

On macOS/Linux:

```bash
cp .env.example .env
npm install
npm start
```

No API keys are required for the basic demo.

To run the guardrail/decision-logic unit tests (no extra dependencies, uses Node's built-in test runner):

```bash
npm test
```

## 3. Real Razorpay Test Mode (checkout + verified payment)

Razorpay's Test Mode uses separate test keys and does not move real money. Add your Test Mode `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to `.env`.

There are now two recovery paths in the demo, and the UI keeps them clearly separate:

1. **Run recovery action (simulated)** — the original deterministic/LLM-scored simulation, marked `TEST_SIMULATION` everywhere in the audit trail. No Razorpay calls involved.
2. **Pay via Razorpay Test Checkout (real)** — `POST /api/create-order` creates a real Razorpay Test Mode order tied to the transaction, the browser completes it with Razorpay's Checkout.js widget, and `POST /api/verify-payment` verifies the `order_id|payment_id` HMAC signature (using `RAZORPAY_KEY_SECRET`) before trusting the result and marking the transaction recovered. This path is logged as `RAZORPAY_TEST_MODE_REAL`.

`POST /api/webhook` independently verifies `X-Razorpay-Signature` against `RAZORPAY_WEBHOOK_SECRET` before trusting any event, and marks a transaction recovered on `payment.captured`. If `RAZORPAY_WEBHOOK_SECRET` isn't set, the endpoint still accepts events for local demoing, but every event is logged as `WEBHOOK_WARNING_NO_SECRET_CONFIGURED` so the gap is visible in the audit trail rather than silently trusted.

Razorpay's official docs:
- Create an order: https://razorpay.com/docs/api/orders/create/
- Test vs Live modes: https://razorpay.com/docs/payments/dashboard/test-live-modes/
- Checkout.js integration: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/
- Webhooks: https://razorpay.com/docs/webhooks/
- Payment failed webhook: https://razorpay.com/docs/webhooks/payments/

IMPORTANT: never commit `.env` or your API secret to GitHub.

## 4. Optional AI model

You can configure either:

- `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`)
- `GEMINI_API_KEY` (+ optional `GEMINI_MODEL`)

If no AI key is available, RecoverAI falls back to a deterministic policy engine. This is intentional: the hackathon demo remains reliable and offline.

## 5. Architecture

```text
React-like single-page UI (vanilla JS)
              |
              v
        Express API
              |
       +------+------+
       |             |
       v             v
 AI Decision      Guardrails
    Engine            |
       |              |
       +------+-------+
              |
              v
       Recovery Action
              |
       Razorpay Test Mode
              |
              v
        Audit Trail
              |
              v
       Recovery Metrics
```

State (transactions + audit log) is snapshotted to `data/state.json` after every mutation and reloaded on startup, so a server restart doesn't wipe demo progress. `data/` is gitignored — it's runtime state, not source.

## 6. Core guardrails

- Maximum 2 automated payment attempts.
- Stop immediately when a payment is recovered.
- Expired cards are not blindly retried.
- Repeated failures are escalated.
- Ambiguous cases are escalated.
- Every AI decision and recovery action is logged.
- Demo recovery actions are explicitly marked as `TEST_SIMULATION`; no real money is moved by the demo.

## 7. 5-minute demo flow

### 0:00 — Problem
"Merchants don't just lose revenue because customers don't want to pay. Revenue leaks because payments fail, checkout gets abandoned, subscriptions fail, and recovery is often manual."

### 0:30 — Show dashboard
Point to:
- Revenue at risk
- Recovered revenue
- Recovery rate
- 100 transaction batch

### 1:15 — Show one transaction
Pick a network error or insufficient-funds transaction.

Click **Analyze**.

Explain:
"RecoverAI doesn't just label the failure. It chooses an intervention based on failure reason, customer history and previous attempts."

### 2:00 — Execute recovery
Click **Run recovery action**.

Show:
- AI decision
- bounded action
- recovered amount
- audit entry

### 3:00 — Show guardrails
Go to AI Agent.

Highlight:
- 2 max attempts
- stop on success
- escalation
- audit trail

### 4:00 — Show audit trail
"Every money-adjacent action is explainable and traceable."

### 4:30 — Close
"We are not trying to maximize retries. We are trying to maximize recovered revenue subject to customer-friendly and merchant-safe constraints."

## 8. What is real vs simulated?

For the hackathon demo:
- Transaction dataset: synthetic.
- "Run recovery action (simulated)": a deterministic/LLM-scored Test Mode outcome so the demo is reliable to present. Logged as `TEST_SIMULATION`.
- "Pay via Razorpay Test Checkout (real)": a real Razorpay Test Mode order, completed through Checkout.js, and only trusted after the `order_id|payment_id` HMAC signature is verified server-side. No real money moves (it's Test Mode), but the order/payment objects themselves are real Razorpay API objects, not mocked. Logged as `RAZORPAY_TEST_MODE_REAL`.
- AI decision: real LLM when an API key is configured; otherwise local policy engine.

Do not claim simulated recoveries are real money recovered.

## 9. What broke, and how it was fixed

Being transparent about this because it's a real part of building this:

- **Startup crash.** `server.js` called `generateTransactions(100)` before the `const FAILURE_REASONS` and `const NAMES` arrays it depends on were declared further down the file. Because `const`/`let` bindings are in the temporal dead zone until their declaration line, this threw `ReferenceError: Cannot access 'FAILURE_REASONS' before initialization` on every boot — the server never reached `app.listen()`. Fixed by moving the pure data/logic (`FAILURE_REASONS`, `NAMES`, `pick`, `generateTransactions`, `baseDecision`) into `lib/logic.js`, which also made it independently unit-testable (see `tests/logic.test.js`).
- **Silent empty error bodies.** `/api/create-order`'s error handler assumed every thrown error had either `e.error.description` (Razorpay SDK shape) or `e.message`. When neither was present, `JSON.stringify` dropped the `error` key entirely and the client got back a bare `{}` with no explanation. Fixed with an explicit fallback message.
- **Unverified webhook signature.** The original webhook handler had a comment acknowledging it should verify `X-Razorpay-Signature` but didn't. Fixed: signatures are now verified via HMAC-SHA256 against the raw request body, using `timingSafeEqual` to avoid timing attacks; unverified/invalid events are rejected and logged.
- **No idempotency guard on `/api/recover/:id`.** Two concurrent recovery requests for the same transaction could both pass the guardrail checks before either wrote its result, double-executing an attempt. Fixed with a simple in-memory lock keyed by transaction id.
- **No persistence.** All state lived in memory only, so a crash or redeploy silently discarded the whole demo batch. Fixed with a JSON snapshot to `data/state.json` after every mutation.

## 10. GitHub checklist

Before submission:

- Remove `.env` from Git.
- Add `.env` to `.gitignore`.
- Add screenshots/GIF of the dashboard.
- Include architecture diagram in README.
- Include the 100-record evaluation/demo dataset or explain its generation.
- Add a short demo video.
- Mention which parts are synthetic/Test Mode.

## 11. Suggested pitch line

> "RecoverAI is a bounded AI revenue-recovery agent: it detects money at risk, diagnoses why a payment failed, chooses the least-friction intervention, executes it in Test Mode, and proves what happened with measurable recovery metrics and an audit trail."
