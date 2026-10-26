"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const day = 864e5;
const iso = d => new Date(d).toISOString().slice(0, 10);
const ago = n => iso(Date.now() - n * day);

const BUREAUS = ["Equifax", "Experian", "TransUnion"];
const REASONS = {
  "not-mine": "This account does not belong to me and I did not open it.",
  "incorrect-balance": "The reported balance is inaccurate.",
  "incorrect-status": "The reported payment status is inaccurate.",
  "duplicate": "This account is reported more than once.",
  "obsolete": "This item is past the reporting period allowed by 15 U.S.C. §1681c.",
  "identity-theft": "This account resulted from identity theft; an FTC report is enclosed.",
};
const STATUSES = ["draft", "mailed", "investigating", "corrected", "deleted", "verified"];
const OPEN = ["mailed", "investigating"];

const seed = () => ({
  mode: "personal", dark: false, view: "dashboard",
  profile: { name: "Jordan Rivera", address: "123 Main St, Austin, TX 78701" },
  clients: [
    { id: 1, name: "Jordan Rivera", email: "jordan@example.com", plan: "Self", consent: true, start: ago(60) },
    { id: 2, name: "Priya Shah", email: "priya@example.com", plan: "Pro", consent: true, start: ago(40) },
    { id: 3, name: "Marcus Lee", email: "marcus@example.com", plan: "Pro", consent: false, start: ago(5) },
  ],
  disputes: [
    { id: 1, client: 1, creditor: "Capital One", account: "xxxx4421", bureau: "Equifax", reason: "incorrect-balance", status: "investigating", sent: ago(18), tracking: "9407 1000 0000 0000 0001 23", round: 1, log: [[ago(18), "Letter mailed (certified, return receipt)"], [ago(12), "Delivery confirmed"]] },
    { id: 2, client: 1, creditor: "Midland Credit", account: "xxxx9980", bureau: "Experian", reason: "not-mine", status: "mailed", sent: ago(6), tracking: "9407 1000 0000 0000 0002 45", round: 1, log: [[ago(6), "Letter mailed (certified, return receipt)"]] },
    { id: 3, client: 1, creditor: "Synchrony", account: "xxxx1177", bureau: "TransUnion", reason: "incorrect-status", status: "corrected", sent: ago(50), tracking: "9407 1000 0000 0000 0003 67", round: 1, log: [[ago(50), "Letter mailed"], [ago(15), "Bureau corrected the tradeline"]] },
    { id: 4, client: 2, creditor: "Portfolio Recovery", account: "xxxx5503", bureau: "Equifax", reason: "obsolete", status: "deleted", sent: ago(38), tracking: "9407 1000 0000 0000 0004 89", round: 1, log: [[ago(38), "Letter mailed"], [ago(4), "Item deleted"]] },
    { id: 5, client: 2, creditor: "Discover", account: "xxxx0912", bureau: "TransUnion", reason: "duplicate", status: "verified", sent: ago(35), tracking: "9407 1000 0000 0000 0005 01", round: 1, log: [[ago(35), "Letter mailed"], [ago(3), "Bureau verified; consider Round 2 with documentation"]] },
    { id: 6, client: 2, creditor: "Chase", account: "xxxx3340", bureau: "Experian", reason: "incorrect-balance", status: "draft", sent: null, tracking: "", round: 1, log: [] },
  ],
});

let state = (() => { try { return JSON.parse(localStorage.getItem("disputeos")) || seed(); } catch { return seed(); } })();
const save = () => localStorage.setItem("disputeos", JSON.stringify(state));
const clientName = id => (state.clients.find(c => c.id === id) || {}).name || "—";
const visible = () => state.mode === "personal" ? state.disputes.filter(d => d.client === 1) : state.disputes;
const dueDate = d => d.sent ? iso(new Date(d.sent).getTime() + 30 * day) : null; // FCRA 30-day investigation window
const daysLeft = d => d.sent ? Math.ceil((new Date(dueDate(d)) - Date.now()) / day) : null;

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; setTimeout(() => t.hidden = true, 2500); }
function openModal(html) { $("#modal-card").innerHTML = html; $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });

function letter(d) {
  const c = state.clients.find(x => x.id === d.client) || state.profile;
  const addr = d.client === 1 ? state.profile.address : "[Client address]";
  return `${c.name}
${addr}

${iso(Date.now())}

${d.bureau} Consumer Dispute Department
[Bureau mailing address]

VIA CERTIFIED MAIL, RETURN RECEIPT REQUESTED

Re: Dispute of inaccurate information (Round ${d.round}) — ${d.creditor}, account ${d.account}

To Whom It May Concern:

Under the Fair Credit Reporting Act, 15 U.S.C. §1681i, I am disputing the following item on my credit report:

  Creditor: ${d.creditor}
  Account:  ${d.account}

Reason: ${REASONS[d.reason]}

Please conduct a reasonable reinvestigation, forward all relevant information to the furnisher, and provide me
the results in writing within 30 days. If the information cannot be verified, it must be corrected or deleted.
Please also send a description of the procedure used to verify the item upon request (§1681i(a)(7)).

Enclosed: copy of ID, proof of address${d.reason === "identity-theft" ? ", FTC identity theft report" : ""}.

Sincerely,
${c.name}`;
}

const VIEWS = {
  dashboard() {
    const ds = visible(), n = s => ds.filter(d => d.status === s).length;
    const wins = n("deleted") + n("corrected"), closed = wins + n("verified");
    const rate = closed ? Math.round(wins / closed * 100) : 0;
    const urgent = ds.filter(d => OPEN.includes(d.status) && daysLeft(d) <= 7).sort((a, b) => daysLeft(a) - daysLeft(b));
    const by = BUREAUS.map(b => { const t = ds.filter(d => d.bureau === b); const w = t.filter(d => ["deleted", "corrected"].includes(d.status)).length; return [b, t.length, w]; });
    return `<div class="grid g4">
      <div class="card stat"><div class="n">${ds.length}</div><div class="l">Total disputes</div></div>
      <div class="card stat"><div class="n">${ds.filter(d => OPEN.includes(d.status)).length}</div><div class="l">In progress</div></div>
      <div class="card stat"><div class="n">${wins}</div><div class="l">Corrected / deleted</div></div>
      <div class="card stat"><div class="n">${rate}%</div><div class="l">Resolution rate (closed items)</div></div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>Needs attention</h2>${urgent.length ? `<table>${urgent.map(d => `<tr><td>${esc(d.creditor)}<br><small>${d.bureau}</small></td><td class="${daysLeft(d) < 0 ? "due" : ""}">${daysLeft(d) < 0 ? Math.abs(daysLeft(d)) + " days overdue" : daysLeft(d) + " days left"}</td><td><button class="btn sm" data-open="${d.id}">Open</button></td></tr>`).join("")}</table>` : "<p>Nothing due in the next 7 days.</p>"}
        <p class="warn">Bureaus generally have 30 days to investigate. If one misses the deadline, you can escalate (CFPB complaint).</p></div>
      <div class="card"><h2>Results by bureau</h2>${by.map(([b, t, w]) => `<div style="margin:10px 0"><div class="row" style="justify-content:space-between"><b>${b}</b><span>${w}/${t} resolved</span></div><div class="bar"><i style="width:${t ? w / t * 100 : 0}%"></i></div></div>`).join("")}</div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Recent activity</h2><ul class="timeline">${ds.flatMap(d => d.log.map(l => [l[0], `${d.creditor} (${d.bureau}): ${l[1]}`])).sort().reverse().slice(0, 6).map(l => `<li><small>${l[0]}</small><br>${esc(l[1])}</li>`).join("") || "<li>No activity yet</li>"}</ul></div>`;
  },
  disputes() {
    const ds = visible();
    return `<div class="card"><table><tr><th>Creditor</th>${state.mode === "agency" ? "<th>Client</th>" : ""}<th>Bureau</th><th>Reason</th><th>Status</th><th>Due</th><th></th></tr>
      ${ds.map(d => `<tr><td><b>${esc(d.creditor)}</b><br><small>${esc(d.account)}</small></td>${state.mode === "agency" ? `<td>${esc(clientName(d.client))}</td>` : ""}<td>${d.bureau}</td><td>${esc(d.reason.replace("-", " "))}</td><td><span class="pill ${d.status}">${d.status}</span></td><td>${d.sent && OPEN.includes(d.status) ? dueDate(d) : "—"}</td><td><button class="btn sm" data-open="${d.id}">Manage</button></td></tr>`).join("")}</table></div>`;
  },
  mail() {
    const ds = visible().filter(d => d.tracking);
    return `<div class="card"><h2>Certified mail tracking</h2><table><tr><th>Tracking #</th><th>To</th><th>Item</th><th>Mailed</th><th>Status</th></tr>
      ${ds.map(d => `<tr><td><code>${esc(d.tracking)}</code></td><td>${d.bureau}</td><td>${esc(d.creditor)}</td><td>${d.sent}</td><td>${d.log.some(l => /Delivery/.test(l[1])) ? "Delivered" : "In transit"}</td></tr>`).join("")}</table>
      <p><small>Demo mode: tracking numbers are sample values. Connect a certified-mail provider (e.g. Lob / USPS APIs) to send and track real letters.</small></p></div>`;
  },
  clients() {
    return `<div class="card"><table><tr><th>Client</th><th>Plan</th><th>Started</th><th>Signed contract &amp; disclosures</th><th>Disputes</th></tr>
      ${state.clients.map(c => `<tr><td><b>${esc(c.name)}</b><br><small>${esc(c.email)}</small></td><td>${c.plan}</td><td>${c.start}</td><td>${c.consent ? "✅ Signed" : '<span class="due">⚠ Required before work begins</span>'}</td><td>${state.disputes.filter(d => d.client === c.id).length}</td></tr>`).join("")}</table>
      <p class="warn">CROA: agencies may not charge before services are performed, and must provide a written contract, the consumer rights disclosure, and a 3-day cancellation right.</p></div>`;
  },
  compliance() {
    const items = [
      ["Consumer Rights Disclosure delivered (CROA §1679c)", true],
      ["Written contract with 3-business-day cancellation (CROA §1679d)", true],
      ["No advance fees collected (CROA §1679b)", true],
      ["No guarantees of score or deletion in marketing", true],
      ["Disputes only for information the client believes is inaccurate", true],
      ["Reinvestigation deadlines (30 days) tracked per dispute", true],
      ["Debt collector validation requests (FDCPA §1692g, 30-day window)", true],
      ["State credit services organization registration/bond checked", false],
    ];
    return `<div class="card"><h2>Compliance checklist</h2>${items.map(([t, ok]) => `<p>${ok ? "✅" : "⬜"} ${t}</p>`).join("")}</div>`;
  },
};

const NAV = { dashboard: "Dashboard", disputes: "Disputes", mail: "Certified mail", clients: "Clients", compliance: "Compliance" };
function render() {
  document.body.classList.toggle("dark", state.dark);
  document.querySelectorAll(".mode-switch button").forEach(b => b.classList.toggle("active", b.dataset.mode === state.mode));
  const keys = Object.keys(NAV).filter(k => k !== "clients" || state.mode === "agency");
  if (!keys.includes(state.view)) state.view = "dashboard";
  $("#nav").innerHTML = keys.map(k => `<a data-view="${k}" class="${k === state.view ? "active" : ""}">${NAV[k]}</a>`).join("");
  $("#page-title").textContent = NAV[state.view] + (state.mode === "agency" ? " · Agency" : "");
  $("#view").innerHTML = VIEWS[state.view]();
  save();
}

function manage(id) {
  const d = state.disputes.find(x => x.id === id);
  openModal(`<h2>${esc(d.creditor)} — ${d.bureau} <span class="pill ${d.status}">${d.status}</span></h2>
    <label>Letter (editable)</label><textarea id="letter">${esc(letter(d))}</textarea>
    <label>Status</label><select id="status">${STATUSES.map(s => `<option ${s === d.status ? "selected" : ""}>${s}</option>`).join("")}</select>
    <label>Certified mail tracking #</label><input id="tracking" value="${esc(d.tracking)}">
    <ul class="timeline" style="margin-top:12px">${d.log.map(l => `<li><small>${l[0]}</small> ${esc(l[1])}</li>`).join("")}</ul>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      ${d.status === "verified" ? '<button class="btn" id="round2">Start round 2</button>' : ""}
      <button class="btn" id="copy">Copy letter</button><button class="btn" id="cancel">Close</button><button class="btn primary" id="save">Save</button></div>`);
  $("#cancel").onclick = closeModal;
  $("#copy").onclick = () => navigator.clipboard?.writeText($("#letter").value).then(() => toast("Letter copied"));
  const r2 = $("#round2"); if (r2) r2.onclick = () => { d.round++; d.status = "draft"; d.log.push([iso(Date.now()), `Round ${d.round} started`]); closeModal(); render(); toast("Round " + d.round + " drafted"); };
  $("#save").onclick = () => {
    const ns = $("#status").value, tr = $("#tracking").value.trim();
    if (ns !== d.status) {
      d.log.push([iso(Date.now()), `Status changed to ${ns}`]);
      if (ns === "mailed" && !d.sent) d.sent = iso(Date.now());
      d.status = ns;
    }
    d.tracking = tr; closeModal(); render(); toast("Dispute saved");
  };
}

function newDispute() {
  const cl = state.mode === "agency" ? state.clients : state.clients.filter(c => c.id === 1);
  openModal(`<h2>New dispute</h2>
    <label>Client</label><select id="n-client">${cl.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
    <label>Creditor / furnisher</label><input id="n-cred" placeholder="e.g. Capital One">
    <label>Account (last 4)</label><input id="n-acct" placeholder="xxxx1234">
    <label>Bureau</label><select id="n-bureau">${BUREAUS.map(b => `<option>${b}</option>`).join("")}</select>
    <label>Reason (must be an inaccuracy)</label><select id="n-reason">${Object.keys(REASONS).map(k => `<option value="${k}">${k.replace("-", " ")}</option>`).join("")}</select>
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="create">Create draft</button></div>`);
  $("#cancel").onclick = closeModal;
  $("#create").onclick = () => {
    const cred = $("#n-cred").value.trim();
    if (!cred) return toast("Creditor is required");
    const client = +$("#n-client").value;
    if (!state.clients.find(c => c.id === client).consent) return toast("Client must sign contract & disclosures first");
    state.disputes.push({ id: Math.max(0, ...state.disputes.map(d => d.id)) + 1, client, creditor: cred, account: $("#n-acct").value || "xxxx0000", bureau: $("#n-bureau").value, reason: $("#n-reason").value, status: "draft", sent: null, tracking: "", round: 1, log: [] });
    state.view = "disputes"; closeModal(); render(); toast("Draft created");
  };
}

document.addEventListener("click", e => {
  const t = e.target;
  if (t.dataset.view) { state.view = t.dataset.view; render(); }
  if (t.dataset.mode) { state.mode = t.dataset.mode; render(); }
  if (t.dataset.open) manage(+t.dataset.open);
});
$("#btn-new-dispute").onclick = newDispute;
$("#btn-theme").onclick = () => { state.dark = !state.dark; render(); };
render();
