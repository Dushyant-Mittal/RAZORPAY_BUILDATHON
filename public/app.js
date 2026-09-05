
const $ = s => document.querySelector(s);
let current = null;

function money(n){return "₹"+Number(n||0).toLocaleString("en-IN")}
function pct(n){return (Number(n||0)*100).toFixed(1)+"%"}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

async function api(url, options={}) {
  const r = await fetch(url,{headers:{"Content-Type":"application/json"},...options});
  const data = await r.json();
  if(!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showView(name){
  document.querySelectorAll(".view").forEach(x=>x.classList.remove("active"));
  $("#"+name).classList.add("active");
  document.querySelectorAll(".nav").forEach(x=>x.classList.toggle("active",x.dataset.view===name));
  if(name==="transactions") loadTransactions();
  if(name==="audit") loadAudit();
}
window.showView=showView;
document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>showView(b.dataset.view));

function renderMetrics(m){
  $("#metrics").innerHTML=`
    <div class="metric highlight"><div class="label">REVENUE AT RISK</div><div class="value">${money(m.revenueAtRisk)}</div><div class="sub">${m.transactions-m.recoveredCount} unresolved transactions</div></div>
    <div class="metric"><div class="label">RECOVERED REVENUE</div><div class="value">${money(m.recoveredRevenue)}</div><div class="sub">${m.recoveredCount} successful recoveries</div></div>
    <div class="metric"><div class="label">RECOVERY RATE</div><div class="value">${pct(m.recoveryRate)}</div><div class="sub">across current demo batch</div></div>
    <div class="metric"><div class="label">TRANSACTIONS</div><div class="value">${m.transactions}</div><div class="sub">${m.escalations} escalated · ${m.attempts} attempts</div></div>`;
}

function actionLabel(a){
  const map={RETRY:"Retry",PAYMENT_LINK:"Payment link",RECOVERY_REMINDER:"Reminder",ESCALATE:"Escalate",STOP:"Stop"};
  return map[a]||"Analyze";
}

async function loadOverview(){
  const data=await api("/api/transactions");
  renderMetrics(data.metrics);
  const rows=data.transactions.filter(x=>!x.recovered).slice(0,7);
  $("#riskTable").innerHTML=rows.map(t=>`
    <tr>
      <td><span class="customer">${esc(t.customer)}</span><br><span class="reason">${esc(t.id)}</span></td>
      <td class="amount">${money(t.amount)}</td>
      <td>${esc(t.reason.replaceAll("_"," "))}</td>
      <td>${t.attempts}/2</td>
      <td class="action-tag">${actionLabel(t.action)}</td>
      <td><button class="mini-btn" onclick="openTransaction('${t.id}')">Inspect</button></td>
    </tr>`).join("") || `<tr><td colspan="6">No revenue at risk.</td></tr>`;

  const counts={RETRY:0,PAYMENT_LINK:0,RECOVERY_REMINDER:0,ESCALATE:0,STOP:0};
  data.transactions.forEach(t=>{if(t.action)counts[t.action]++});
  const max=Math.max(1,...Object.values(counts));
  $("#actionBars").innerHTML=Object.entries(counts).map(([k,v])=>`
    <div class="barrow"><span>${actionLabel(k)}</span><div class="bartrack"><div class="barfill" style="width:${v/max*100}%"></div></div><em>${v}</em></div>`).join("");
}

async function loadTransactions(){
  const q=$("#search")?.value||"";
  const status=$("#statusFilter")?.value||"all";
  const data=await api(`/api/transactions?q=${encodeURIComponent(q)}&status=${status}`);
  $("#allTable").innerHTML=data.transactions.map(t=>`
    <tr>
      <td>${esc(t.id)}</td><td class="customer">${esc(t.customer)}</td><td class="amount">${money(t.amount)}</td>
      <td><span class="status ${t.status}">${esc(t.status)}</span></td><td class="reason">${esc(t.reason.replaceAll("_"," "))}</td>
      <td>${t.attempts}/2</td><td><button class="mini-btn" onclick="openTransaction('${t.id}')">${t.recovered?"View":"Analyze"}</button></td>
    </tr>`).join("");
}

async function loadAudit(){
  const rows=await api("/api/audit");
  $("#auditList").innerHTML=rows.map(a=>`
    <div class="audit-row"><div class="audit-time">${new Date(a.timestamp).toLocaleTimeString()}</div>
    <div class="audit-event">${esc(a.event)}</div>
    <div class="audit-detail">${esc(a.transactionId)} ${a.action?`· action=${esc(a.action)}`:""} ${a.amount?`· ${money(a.amount)}`:""} ${a.source?`· ${esc(a.source)}`:""}</div></div>`).join("");
}

async function openTransaction(id){
  try{
    const data=await api(`/api/transactions`);
    const t=data.transactions.find(x=>x.id===id);
    if(!t)return;
    current=t;
    $("#backdrop").classList.add("open");$("#drawer").classList.add("open");
    $("#drawerContent").innerHTML=`
      <div class="kicker">TRANSACTION ${esc(t.id)}</div>
      <h2>${esc(t.customer)}</h2>
      <div class="bigamount">${money(t.amount)}</div>
      <div class="reason">${esc(t.reason.replaceAll("_"," "))} · ${t.attempts}/2 attempts</div>
      <div class="decision">
        <div class="kicker">AI DECISION</div>
        <div class="decision-action" id="decisionAction">${t.action?esc(actionLabel(t.action).toUpperCase()):"ANALYZING…"}</div>
        <div class="confidence"><div id="confidenceBar" style="width:${(t.confidence||0)*100}%"></div></div>
        <p class="explain" id="explain">${esc(t.explanation||"RecoverAI is analyzing the transaction and customer history…")}</p>
      </div>
      <div id="drawerButton"></div>
      <div class="kicker" style="margin-top:24px">AGENT CONTEXT</div>
      <div class="policy" style="margin-top:9px">
        <div><b>Successful history</b><span>${t.successfulHistory} payments</span></div>
        <div><b>Failure class</b><span>${esc(t.reason.replaceAll("_"," "))}</span></div>
        <div><b>Guardrail</b><span>2 max attempts</span></div>
      </div>`;
    if(!t.action && !t.recovered){
      await analyze(id);
    } else renderDrawerButton(t);
  }catch(e){toast(e.message)}
}

async function analyze(id){
  try{
    const d=await api(`/api/analyze/${id}`,{method:"POST"});
    current=d.transaction;
    $("#decisionAction").textContent=actionLabel(d.decision.action).toUpperCase();
    $("#confidenceBar").style.width=(d.decision.confidence*100)+"%";
    $("#explain").textContent=d.decision.explanation;
    renderDrawerButton(current);
    toast("AI decision ready");
    loadOverview();
  }catch(e){toast(e.message)}
}

function renderDrawerButton(t){
  const disabled=t.recovered || t.action==="ESCALATE" || t.action==="STOP";
  $("#drawerButton").innerHTML=`
    <button class="recover-btn" ${disabled?"disabled":""} onclick="executeRecovery('${t.id}')">
      ${t.recovered?"✓ Payment already recovered":t.action==="ESCALATE"?"Escalated safely":"Run recovery action (simulated) →"}
    </button>
    <button class="recover-btn secondary" ${disabled?"disabled":""} onclick="payWithRazorpay('${t.id}')" style="margin-top:8px">
      ${t.recovered?"✓ Recovered":"Pay via Razorpay Test Checkout (real)"}
    </button>`;
}

async function payWithRazorpay(id){
  const btns=document.querySelectorAll(".recover-btn"); btns.forEach(b=>b.disabled=true);
  try{
    const t = current && current.id===id ? current : null;
    const amount = t ? t.amount : 0;
    const order = await api("/api/create-order",{method:"POST",body:JSON.stringify({amount, transactionId:id})});
    if(typeof Razorpay === "undefined"){
      toast("Razorpay Checkout script did not load — check your network.");
      btns.forEach(b=>b.disabled=false);
      return;
    }
    const rzp = new Razorpay({
      key: order.keyId,
      amount: order.order.amount,
      currency: order.order.currency,
      order_id: order.order.id,
      name: "RecoverAI — Test Mode",
      description: `Recovering ${id}`,
      handler: async function(response){
        try{
          const verify = await api("/api/verify-payment",{method:"POST",body:JSON.stringify(response)});
          if(verify.ok && verify.transaction){
            current = verify.transaction;
            toast("Real Razorpay Test Mode payment verified and recovered.");
          } else {
            toast("Payment captured but could not be matched to a transaction.");
          }
        }catch(e){ toast(e.message); }
        await openTransaction(id);
        await loadOverview();
      },
      modal: {
        ondismiss: function(){ btns.forEach(b=>b.disabled=false); }
      },
      theme: { color: "#635bff" }
    });
    rzp.on("payment.failed", function(){ toast("Razorpay Test Mode payment failed."); btns.forEach(b=>b.disabled=false); });
    rzp.open();
  }catch(e){
    toast(e.message);
    btns.forEach(b=>b.disabled=false);
  }
}
window.payWithRazorpay=payWithRazorpay;

async function executeRecovery(id){
  const btn=document.querySelector(".recover-btn"); if(btn)btn.disabled=true;
  try{
    const d=await api(`/api/recover/${id}`,{method:"POST"});
    current=d.transaction;
    toast(d.message);
    await openTransaction(id);
    await loadOverview();
  }catch(e){toast(e.message);if(btn)btn.disabled=false}
}

function closeDrawer(){$("#backdrop").classList.remove("open");$("#drawer").classList.remove("open")}
window.closeDrawer=closeDrawer;window.openTransaction=openTransaction;window.executeRecovery=executeRecovery;
$("#backdrop").onclick=closeDrawer;
$("#search").oninput=()=>loadTransactions();
$("#statusFilter").onchange=()=>loadTransactions();

$("#resetBtn").onclick=async()=>{
  if(!confirm("Reset the demo to 100 fresh transactions?"))return;
  await api("/api/reset",{method:"POST"});toast("Demo reset");loadOverview();loadAudit();
};

function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.classList.remove("show"),2600)}

loadOverview();
