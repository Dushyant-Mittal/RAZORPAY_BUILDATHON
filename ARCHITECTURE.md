# RecoverAI — Architecture

**Track:** AI Revenue Recovery — Razorpay AI Buildathon

This document explains how RecoverAI is built and, more importantly, *why* each
decision was made. It's meant to stand on its own — you shouldn't need to watch
the pitch video to understand the system.

---

## 1. High-level flow

```
Vanilla JS single-page UI  (public/index.html, app.js, styles.css)
        |
        v
   Express API (server.js)
        |
   +----+----+
   |         |
   v         v
AI Decision   Guardrails
  Engine      (lib/logic.js)
   |            |
   +-----+------+
         |
         v
  Recovery Action
    /      \
   /        \
TEST_SIM   Razorpay Test Mode
(deterministic)  (real order + Checkout.js
                  + signature verification)
         |
         v
   Audit Trail + Persistence (data/state.json)
```

A rendered version of this diagram is also in `architecture.svg`.

---

## 2. Components

| Layer | File(s) | Responsibility |
|---|---|---|
| UI | `public/index.html`, `public/app.js`, `public/styles.css` | Dashboard, per-transaction analysis view, AI Agent tab, Audit Trail tab. Talks to the API only over `fetch`. |
| API | `server.js` | Express routes. Owns HTTP concerns only — no business logic lives here beyond orchestration. |
| Decision & guardrail logic | `lib/logic.js` | Pure functions: `generateTransactions`, `baseDecision`, `computeMetrics`. No Express, no I/O, no side effects. |
| Persistence | `data/state.json` (gitignored) | Snapshot of transactions + audit log, written after every mutation, reloaded on boot. |
| Tests | `tests/logic.test.js` | Unit tests against `lib/logic.js` using Node's built-in test runner — no server needs to be running. |

### API surface (`server.js`)

- `GET /api/transactions` — current transaction batch
- `GET /api/metrics` — recovery-rate / revenue-at-risk metrics
- `GET /api/audit` — full audit trail
- `POST /api/analyze/:id` — runs the decision engine on one transaction
- `POST /api/recover/:id` — executes a bounded recovery action (guardrail-checked)
- `POST /api/reset` — regenerates a fresh synthetic batch
- `POST /api/create-order` — creates a real Razorpay Test Mode order
- `POST /api/verify-payment` — verifies the Checkout.js payment signature
- `POST /api/webhook` — independently verifies `X-Razorpay-Signature` on incoming webhook events

---

## 3. Why the decision logic is separated from the HTTP layer

`generateTransactions`, `baseDecision`, and `computeMetrics` live in `lib/logic.js`
as pure functions — same input, same output, no Express request/response objects
in sight. That's why `tests/logic.test.js` can exercise the guardrail rules
(max attempts, stop-on-success, escalation) directly with `npm test`, without
booting a server. Anyone reviewing the code can verify the rules are actually
enforced, rather than trusting a UI description of them.

---

## 4. Policy engine first, LLM second

`baseDecision()` is the default and always runs. If `OPENAI_API_KEY` or
`GEMINI_API_KEY` is set, the agent additionally asks the model for a structured
decision; if no key is configured, or the call fails, it falls back to the same
policy engine. This was a deliberate choice, not a fallback bolted on as an
afterthought: a six-branch rule set already handles the common failure reasons
(network error, insufficient funds, expired card) reliably and instantly, so the
LLM's value-add is on ambiguous or free-text cases — not on carrying the whole
system. It also means the demo never breaks just because an API key is missing.

---

## 5. Two recovery paths, kept deliberately separate

- **`TEST_SIMULATION`** — a deterministic/LLM-scored simulated outcome. Instant,
  repeatable, good for demonstrating guardrail behavior without needing a live
  payment each time.
- **`RAZORPAY_TEST_MODE_REAL`** — `/api/create-order` creates a real Razorpay Test
  Mode order tied to the transaction (via an `orderToTransaction` map); the
  browser completes it with Razorpay's Checkout.js widget; `/api/verify-payment`
  verifies the `order_id|payment_id` HMAC-SHA256 signature before trusting the
  result. `/api/webhook` independently verifies `X-Razorpay-Signature` against
  the raw request body as a second, server-authoritative confirmation path.

Both paths write clearly distinct audit log entries, so nothing is ever
misrepresented as "real money recovered" when it was actually simulated — see
`README.md` section 8 for the explicit real-vs-simulated breakdown.

---

## 6. Guardrails are enforced in code, not just described in the UI

- Maximum 2 automated recovery attempts per transaction.
- Stop immediately once a payment is recovered.
- Expired cards are never blindly retried.
- Repeated failures and ambiguous cases are escalated instead of retried.
- Every AI decision and every recovery action is logged to the audit trail.

These rules live inside `baseDecision()` and are **re-checked again** inside
`POST /api/recover/:id`, regardless of what the LLM suggests — so a
misbehaving or unavailable model can't bypass a guardrail. A `recoveryLocks`
`Set` also prevents two concurrent requests on the same transaction from both
passing the guardrail check before either one writes its result, closing a
double-execution race condition.

---

## 7. State survives restarts

`data/state.json` is written after every mutation and reloaded on startup, so a
crash or redeploy doesn't silently wipe the demo batch. This is intentionally
simple — no database — because that's an honest match for a hackathon build,
not an attempt to look more production-grade than it is.

---

## 8. What's real vs. simulated — stated once, applies everywhere

- The transaction dataset is synthetic (100 generated records).
- `TEST_SIMULATION` recoveries are deterministic/LLM-scored, not real Razorpay
  calls.
- `RAZORPAY_TEST_MODE_REAL` recoveries are real Razorpay Test Mode API objects
  (order + payment), verified server-side — but Test Mode means no real money
  ever moves.
- The AI decision is a real LLM call only when a key is configured; otherwise
  it's the local policy engine.

This distinction is enforced in the audit log labels, not just asserted in
prose — see `README.md` section 8 and the two distinctly-labeled buttons in the
UI ("Run recovery action (simulated)" vs. "Pay via Razorpay Test Checkout
(real)").

---

## 9. What broke, and how it was fixed

- **Startup crash (temporal dead zone).** `server.js` originally called
  `generateTransactions(100)` before the `FAILURE_REASONS` and `NAMES` arrays it
  depends on were declared later in the same file, throwing
  `ReferenceError: Cannot access 'FAILURE_REASONS' before initialization` on
  every boot. Fixed by extracting the pure logic into `lib/logic.js`, which also
  made it independently unit-testable.
- **Silent empty error bodies.** `/api/create-order`'s error handler assumed
  every thrown error had either `e.error.description` (Razorpay SDK shape) or
  `e.message`; when neither was present the client got back an empty `{}`.
  Fixed with an explicit fallback message.
- **Unverified webhook signature.** The webhook handler didn't verify
  `X-Razorpay-Signature`. Fixed with HMAC-SHA256 verification against the raw
  request body, using `timingSafeEqual` to avoid timing attacks; invalid events
  are rejected and logged.
- **No idempotency guard on `/api/recover/:id`.** Two concurrent recovery
  requests for the same transaction could both pass guardrail checks before
  either wrote its result. Fixed with an in-memory lock keyed by transaction id.
- **No persistence.** State lived in memory only, so a crash or redeploy
  discarded the whole demo batch. Fixed with a JSON snapshot to
  `data/state.json` after every mutation.

---

## 10. Related docs

- `README.md` — setup instructions, guardrail list, real-vs-simulated summary,
  full demo-flow script.
- `PITCH_AND_ARCHITECTURE.md` — the spoken pitch-video script this document is
  derived from.
- `architecture.svg` — visual diagram version of section 1.
