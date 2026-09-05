const test = require("node:test");
const assert = require("node:assert/strict");
const { generateTransactions, baseDecision, computeMetrics } = require("../lib/logic");

function txn(overrides = {}) {
  return {
    id: "TXN-TEST",
    customer: "Test Customer",
    amount: 1000,
    currency: "INR",
    status: "failed",
    reason: "network_error",
    attempts: 0,
    successfulHistory: 4,
    recovered: false,
    action: null,
    ...overrides
  };
}

test("generateTransactions produces the requested count with required fields", () => {
  const rows = generateTransactions(25);
  assert.equal(rows.length, 25);
  for (const t of rows) {
    assert.ok(t.id.startsWith("TXN-"));
    assert.ok(t.amount > 0);
    assert.equal(t.recovered, false);
  }
});

test("guardrail: already-recovered transactions always STOP", () => {
  const decision = baseDecision(txn({ recovered: true, status: "captured" }));
  assert.equal(decision.action, "STOP");
});

test("guardrail: max 2 attempts forces ESCALATE regardless of failure reason", () => {
  const decision = baseDecision(txn({ attempts: 2, reason: "network_error" }));
  assert.equal(decision.action, "ESCALATE");
});

test("guardrail: expired card is never retried", () => {
  const decision = baseDecision(txn({ reason: "expired_card", attempts: 0 }));
  assert.notEqual(decision.action, "RETRY");
  assert.equal(decision.action, "PAYMENT_LINK");
});

test("guardrail: unknown/ambiguous failure reasons are escalated, not retried blindly", () => {
  const decision = baseDecision(txn({ reason: "something_unmapped", attempts: 0 }));
  assert.equal(decision.action, "ESCALATE");
});

test("network_error and bank_declined with clean history get a bounded retry", () => {
  const decision = baseDecision(txn({ reason: "network_error", attempts: 0, successfulHistory: 5 }));
  assert.equal(decision.action, "RETRY");
  assert.ok(decision.confidence > 0 && decision.confidence <= 1);
});

test("computeMetrics: recovery rate is 0 with no recoveries and correctly weighted with some", () => {
  const none = computeMetrics([txn({ amount: 500 }), txn({ amount: 500 })]);
  assert.equal(none.recoveryRate, 0);

  const some = computeMetrics([
    txn({ amount: 500, recovered: true, status: "captured" }),
    txn({ amount: 500, recovered: false })
  ]);
  assert.equal(some.recoveredRevenue, 500);
  assert.equal(some.revenueAtRisk, 500);
  assert.equal(some.recoveryRate, 0.5);
});
