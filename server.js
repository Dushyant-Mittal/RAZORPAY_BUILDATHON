require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { generateTransactions, baseDecision, computeMetrics } = require("./lib/logic");

const app = express();

// Capture the raw request body alongside the parsed JSON so webhook signatures
// can be verified against the exact bytes Razorpay signed (verifying against
// a re-serialized JSON.stringify of the parsed body can mismatch).
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Persistence: a small JSON snapshot so a restart doesn't wipe demo progress.
// This is intentionally simple (no DB) — good enough for a hackathon demo,
// explicit enough that it's not pretending to be production-grade.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (Array.isArray(raw.transactions) && raw.transactions.length) {
        return { transactions: raw.transactions, auditLog: raw.auditLog || [] };
      }
    }
  } catch (e) {
    console.error("Could not load persisted state, starting fresh:", e.message);
  }
  return null;
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ transactions, auditLog }, null, 2));
  } catch (e) {
    console.error("Could not persist state:", e.message);
  }
}

const persisted = loadState();
let transactions = persisted ? persisted.transactions : generateTransactions(100);
let auditLog = persisted ? persisted.auditLog : [];

// Maps a live Razorpay order id -> our internal transaction id, so that when
// Checkout.js redirects back (or the webhook fires) we know which synthetic
// transaction a real Test Mode payment corresponds to. Cleared on reset.
const orderToTransaction = new Map();

// Prevents two concurrent /api/recover calls on the same transaction from
// both passing the guardrail checks before either has written its result.
const recoveryLocks = new Set();

function addAudit(event, transactionId, details={}) {
  auditLog.unshift({
    id: `AUD-${Date.now()}-${Math.floor(Math.random()*1000)}`,
    timestamp: new Date().toISOString(),
    transactionId,
    event,
    ...details
  });
  auditLog = auditLog.slice(0, 200);
}

async function llmDecision(t) {
  const prompt = `You are RecoverAI, a cautious revenue recovery agent for a merchant.
Analyze this failed payment and return ONLY valid JSON:
{
 "action": "RETRY|PAYMENT_LINK|RECOVERY_REMINDER|ESCALATE|STOP",
 "confidence": number between 0 and 1,
 "explanation": "one concise sentence",
 "customer_message": "one concise customer-facing message"
}
Rules: max 2 automated payment attempts; never retry an expired card; do not keep retrying after repeated failures; prefer low-friction actions. Transaction:
${JSON.stringify(t)}`;

  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [{role:"system",content:"Return JSON only."},{role:"user",content:prompt}]
        })
      });
      if (r.ok) {
        const data = await r.json();
        const parsed = JSON.parse(data.choices[0].message.content);
        return {...parsed, source:"OpenAI"};
      }
    } catch (_) {}
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const r = await fetch(url, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          contents: [{parts:[{text: prompt}]}],
          generationConfig: {temperature:0.1, responseMimeType:"application/json"}
        })
      });
      if (r.ok) {
        const data = await r.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return {...JSON.parse(text), source:"Gemini"};
      }
    } catch (_) {}
  }
  return {...baseDecision(t), source:"RecoverAI Policy Engine"};
}

function metrics() { return computeMetrics(transactions); }

app.get("/api/transactions", (req,res) => {
  const q = String(req.query.q || "").toLowerCase();
  const status = req.query.status || "all";
  let rows = transactions.filter(t =>
    (!q || `${t.id} ${t.customer} ${t.reason}`.toLowerCase().includes(q)) &&
    (status==="all" ||
      (status==="recovered" && t.recovered) ||
      (status==="at-risk" && !t.recovered))
  );
  res.json({transactions: rows, metrics: metrics()});
});

app.get("/api/metrics", (req,res)=>res.json(metrics()));

app.get("/api/audit", (req,res)=>res.json(auditLog));

app.post("/api/analyze/:id", async (req,res) => {
  const t = transactions.find(x=>x.id===req.params.id);
  if (!t) return res.status(404).json({error:"Transaction not found"});
  addAudit("AI_ANALYSIS_STARTED", t.id);
  const decision = await llmDecision(t);
  t.action = decision.action;
  t.confidence = Number(decision.confidence || 0.8);
  t.explanation = decision.explanation;
  t.customerMessage = decision.customer_message || `We noticed your payment for ₹${t.amount.toLocaleString("en-IN")} did not complete. Please try again when convenient.`;
  addAudit("AI_DECISION", t.id, {action:decision.action, confidence:t.confidence, source:decision.source});
  saveState();
  res.json({transaction:t, decision});
});

app.post("/api/recover/:id", async (req,res) => {
  const id = req.params.id;
  const t = transactions.find(x=>x.id===id);
  if (!t) return res.status(404).json({error:"Transaction not found"});

  if (recoveryLocks.has(id)) {
    return res.status(409).json({error:"A recovery action is already in progress for this transaction. Please wait for it to finish."});
  }
  recoveryLocks.add(id);

  try {
    const decision = await llmDecision(t);

    if (t.recovered) {
      addAudit("GUARDRAIL_STOP_ALREADY_RECOVERED", t.id);
      return res.json({ok:false, transaction:t, message:"Payment is already recovered."});
    }
    if (decision.action === "ESCALATE") {
      t.action = "ESCALATE";
      t.explanation = decision.explanation;
      addAudit("ESCALATED", t.id, {reason:decision.explanation});
      saveState();
      return res.json({ok:true, transaction:t, decision, message:"Escalated safely — no automated money action taken."});
    }
    if (decision.action === "STOP") {
      addAudit("GUARDRAIL_STOP", t.id);
      return res.json({ok:false, transaction:t, decision, message:"No action taken."});
    }

    // Demo simulation: this represents a bounded Test Mode recovery attempt.
    // No real money is moved here. See /api/create-order + /api/verify-payment
    // for the real Razorpay Test Mode checkout path.
    const successScore =
      decision.action === "RETRY" ? (t.reason==="network_error" ? 0.78 : 0.64) :
      decision.action === "PAYMENT_LINK" ? 0.72 :
      decision.action === "RECOVERY_REMINDER" ? 0.68 : 0.50;

    const succeeds = Math.random() < successScore;

    if (t.attempts >= 2) {
      t.action = "ESCALATE";
      addAudit("GUARDRAIL_MAX_ATTEMPTS", t.id);
      saveState();
      return res.json({ok:true, transaction:t, decision:{...decision,action:"ESCALATE"}, message:"Maximum automated attempts reached. Escalated."});
    }

    t.attempts += 1;
    t.action = decision.action;
    addAudit("RECOVERY_ACTION_EXECUTED", t.id, {action:decision.action, attempt:t.attempts, mode:"TEST_SIMULATION"});

    if (succeeds) {
      t.recovered = true;
      t.status = "captured";
      addAudit("PAYMENT_RECOVERED", t.id, {amount:t.amount, mode:"TEST_SIMULATION"});
      saveState();
      return res.json({
        ok:true,
        recovered:true,
        transaction:t,
        decision,
        message:`₹${t.amount.toLocaleString("en-IN")} recovered successfully in Test Mode simulation.`
      });
    }

    addAudit("RECOVERY_ATTEMPT_FAILED", t.id, {action:decision.action, attempt:t.attempts});
    if (t.attempts >= 2) {
      t.action = "ESCALATE";
      addAudit("ESCALATED_AFTER_FAILURE", t.id);
    }
    saveState();
    res.json({
      ok:true,
      recovered:false,
      transaction:t,
      decision,
      message:"Recovery attempt did not succeed. The agent will stop/escalate according to guardrails."
    });
  } finally {
    recoveryLocks.delete(id);
  }
});

app.post("/api/reset", (req,res) => {
  transactions = generateTransactions(100);
  auditLog = [];
  orderToTransaction.clear();
  addAudit("DEMO_RESET", "SYSTEM");
  saveState();
  res.json({ok:true, metrics:metrics()});
});

// ---------------------------------------------------------------------------
// Real Razorpay Test Mode flow: create an order tied to a transaction, let the
// browser complete it with Razorpay Checkout.js, then verify the signature
// Razorpay returns before trusting the payment. This is separate from the
// TEST_SIMULATION path above — it moves through Razorpay's real Test Mode
// APIs (no real money, but a real signed payment object).
// ---------------------------------------------------------------------------
app.post("/api/create-order", async (req,res) => {
  const amount = Number(req.body.amount || 2499);
  const transactionId = req.body.transactionId || null;
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return res.status(400).json({
      error:"Razorpay Test Mode keys are not configured.",
      hint:"Copy .env.example to .env and add your rzp_test key id + secret."
    });
  }
  try {
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    const order = await razorpay.orders.create({
      amount: Math.round(amount*100),
      currency:"INR",
      receipt:`recoverai_${Date.now()}`,
      notes:{source:"RecoverAI buildathon demo", recoverai_txn_id: transactionId || ""}
    });
    if (transactionId) orderToTransaction.set(order.id, transactionId);
    addAudit("RAZORPAY_TEST_ORDER_CREATED", transactionId || "SYSTEM", {orderId:order.id, amount});
    res.json({
      keyId:process.env.RAZORPAY_KEY_ID,
      order
    });
  } catch (e) {
    res.status(500).json({error:e.error?.description || e.message || "Failed to create Razorpay order."});
  }
});

// Called by the browser right after Checkout.js completes. Verifies the
// signature Razorpay signs with the key secret before trusting the payment —
// this is the standard order_id|payment_id HMAC check from Razorpay's docs.
app.post("/api/verify-payment", (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ ok:false, error:"Missing payment verification fields." });
  }
  if (!process.env.RAZORPAY_KEY_SECRET) {
    return res.status(400).json({ ok:false, error:"Razorpay key secret is not configured on the server." });
  }

  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  const provided = Buffer.from(razorpay_signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  const valid = provided.length === expectedBuf.length && crypto.timingSafeEqual(provided, expectedBuf);

  const transactionId = orderToTransaction.get(razorpay_order_id);

  if (!valid) {
    addAudit("REAL_PAYMENT_SIGNATURE_INVALID", transactionId || razorpay_order_id, { orderId: razorpay_order_id, paymentId: razorpay_payment_id });
    return res.status(400).json({ ok:false, error:"Signature verification failed — payment not trusted." });
  }

  const t = transactionId ? transactions.find(x => x.id === transactionId) : null;
  if (t && !t.recovered) {
    t.recovered = true;
    t.status = "captured";
    t.action = "RETRY";
    addAudit("PAYMENT_RECOVERED", t.id, {
      amount: t.amount,
      mode: "RAZORPAY_TEST_MODE_REAL",
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id
    });
    saveState();
  } else {
    addAudit("REAL_PAYMENT_VERIFIED_NO_MATCHING_TXN", razorpay_order_id, { orderId: razorpay_order_id, paymentId: razorpay_payment_id });
  }

  res.json({ ok:true, transaction: t || null });
});

// Verifies X-Razorpay-Signature against the raw request body before trusting
// any webhook event. Requires RAZORPAY_WEBHOOK_SECRET to be set; without it,
// the endpoint still accepts events (for local demoing) but flags every
// event as unverified in the audit trail so that gap is visible, not silent.
app.post("/api/webhook", (req,res)=>{
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  if (secret) {
    if (!signature || !req.rawBody) {
      addAudit("WEBHOOK_REJECTED_NO_SIGNATURE", "SYSTEM");
      return res.status(400).json({error:"Missing X-Razorpay-Signature header."});
    }
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    const provided = Buffer.from(signature, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    const valid = provided.length === expectedBuf.length && crypto.timingSafeEqual(provided, expectedBuf);
    if (!valid) {
      addAudit("WEBHOOK_REJECTED_BAD_SIGNATURE", "SYSTEM");
      return res.status(400).json({error:"Invalid webhook signature."});
    }
  } else {
    addAudit("WEBHOOK_WARNING_NO_SECRET_CONFIGURED", "SYSTEM");
  }

  const event = req.body?.event || "unknown";
  const payment = req.body?.payload?.payment?.entity;
  if (payment?.id) {
    const txnId = payment.notes?.recoverai_txn_id || orderToTransaction.get(payment.order_id);
    const t = txnId ? transactions.find(x=>x.id===txnId) : null;
    if (event === "payment.captured" && t && !t.recovered) {
      t.recovered = true;
      t.status = "captured";
      addAudit("PAYMENT_RECOVERED", t.id, { amount:t.amount, mode:"RAZORPAY_TEST_MODE_REAL", paymentId:payment.id, via:"webhook" });
      saveState();
    } else {
      addAudit(`WEBHOOK_${event.toUpperCase()}`, t?.id || payment.id, {paymentId:payment.id});
    }
  }
  res.json({received:true});
});

addAudit("SYSTEM_READY", "SYSTEM", {transactions: transactions.length});

app.listen(PORT, () => {
  console.log(`RecoverAI running at http://localhost:${PORT}`);
});
