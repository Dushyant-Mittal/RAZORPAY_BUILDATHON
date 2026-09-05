// Pure logic — no Express, no I/O, no randomness that can't be seeded by the caller.
// Kept separate from server.js so the guardrail rules can be unit tested directly
// (see tests/logic.test.js) instead of only being exercised through HTTP calls.

const FAILURE_REASONS = [
  "network_error",
  "bank_declined",
  "insufficient_funds",
  "expired_card",
  "checkout_abandoned",
  "subscription_failed"
];

const NAMES = [
  "Rahul Sharma","Priya Verma","Amit Gupta","Neha Singh","Arjun Mehta",
  "Ananya Kapoor","Rohan Jain","Simran Kaur","Vikram Malhotra","Ishita Rao",
  "Karan Bansal","Meera Iyer","Aditya Shah","Nisha Agarwal","Sahil Kumar"
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateTransactions(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const amount = [799, 999, 1299, 1499, 1999, 2499, 2999, 3999, 4999, 7499, 9999][Math.floor(Math.random()*11)];
    const reason = pick(FAILURE_REASONS);
    const attempts = reason === "checkout_abandoned" ? 0 : Math.floor(Math.random() * 3);
    const successfulHistory = Math.floor(Math.random() * 6) + 1;
    const customer = pick(NAMES);
    const status = reason === "checkout_abandoned" ? "abandoned" : "failed";
    rows.push({
      id: `TXN-${String(1000+i)}`,
      customer,
      email: customer.toLowerCase().replace(/ /g,".") + "@demo.shop",
      amount,
      currency: "INR",
      status,
      reason,
      attempts,
      successfulHistory,
      createdAt: new Date(Date.now() - Math.floor(Math.random()*72)*3600000).toISOString(),
      recovered: false,
      action: null,
      confidence: null,
      explanation: null
    });
  }
  return rows;
}

// The deterministic policy engine. This is the guardrail layer that always runs,
// whether or not an LLM key is configured — see server.js:llmDecision.
function baseDecision(t) {
  if (t.recovered || t.status === "captured") {
    return {
      action: "STOP",
      label: "Stop — already recovered",
      confidence: 0.99,
      explanation: "The payment is already successful. The safest action is to stop further recovery attempts.",
      channel: "none"
    };
  }
  if (t.attempts >= 2) {
    return {
      action: "ESCALATE",
      label: "Escalate to merchant",
      confidence: 0.96,
      explanation: `This payment has already failed ${t.attempts} times. Further automated retries could annoy the customer or waste attempts, so RecoverAI escalates it.`,
      channel: "merchant"
    };
  }
  if (t.reason === "network_error" || t.reason === "bank_declined") {
    return {
      action: "RETRY",
      label: "Retry payment",
      confidence: t.successfulHistory >= 3 ? 0.93 : 0.86,
      explanation: "The failure looks potentially temporary. The customer has a usable payment history, so a bounded retry is the lowest-friction recovery action.",
      channel: "payment"
    };
  }
  if (t.reason === "insufficient_funds") {
    return {
      action: "PAYMENT_LINK",
      label: "Send payment link",
      confidence: 0.89,
      explanation: "A direct retry may fail again when funds are unavailable. A payment link gives the customer another chance to pay later using a different method.",
      channel: "link"
    };
  }
  if (t.reason === "checkout_abandoned") {
    return {
      action: "RECOVERY_REMINDER",
      label: "Send checkout reminder",
      confidence: 0.91,
      explanation: "The customer reached checkout but did not finish. A lightweight reminder is appropriate before any stronger intervention.",
      channel: "email"
    };
  }
  if (t.reason === "subscription_failed") {
    return {
      action: "RETRY",
      label: "Retry subscription payment",
      confidence: 0.88,
      explanation: "A subscription failure can often be recovered with a controlled retry. RecoverAI limits retries and stops after success.",
      channel: "subscription"
    };
  }
  if (t.reason === "expired_card") {
    return {
      action: "PAYMENT_LINK",
      label: "Request updated payment method",
      confidence: 0.94,
      explanation: "An expired card is unlikely to succeed if retried unchanged. A payment link lets the customer use an updated payment method.",
      channel: "link"
    };
  }
  return {
    action: "ESCALATE",
    label: "Escalate to merchant",
    confidence: 0.75,
    explanation: "The cause is ambiguous, so RecoverAI avoids an aggressive automated action.",
    channel: "merchant"
  };
}

function computeMetrics(transactions) {
  const atRisk = transactions.filter(t => !t.recovered && t.status !== "captured")
    .reduce((s,t)=>s+t.amount,0);
  const recoveredAmount = transactions.filter(t=>t.recovered).reduce((s,t)=>s+t.amount,0);
  const totalOriginal = atRisk + recoveredAmount;
  const recoveredCount = transactions.filter(t=>t.recovered).length;
  return {
    transactions: transactions.length,
    revenueAtRisk: atRisk,
    recoveredRevenue: recoveredAmount,
    recoveryRate: totalOriginal ? recoveredAmount/totalOriginal : 0,
    recoveredCount,
    actionable: transactions.length,
    escalations: transactions.filter(t=>t.action==="ESCALATE").length,
    attempts: transactions.reduce((s,t)=>s+t.attempts,0)
  };
}

module.exports = { FAILURE_REASONS, NAMES, pick, generateTransactions, baseDecision, computeMetrics };
