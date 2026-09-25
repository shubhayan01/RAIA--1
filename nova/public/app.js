(function () {
  "use strict";
  var root = document.documentElement;

  /* ---------- THEME ---------- */
  var toggle = document.getElementById("themeToggle");
  try { var saved = localStorage.getItem("nova-theme"); if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved); } catch (e) {}
  function currentTheme() { var t = root.getAttribute("data-theme"); if (t) return t; return window.matchMedia && window.matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"; }
  toggle.addEventListener("click", function () { var next = currentTheme() === "dark" ? "light" : "dark"; root.setAttribute("data-theme", next); try { localStorage.setItem("nova-theme", next); } catch (e) {} });

  /* ---------- MODES ---------- */
  var PLACEHOLDERS = {
    chat: "Say hi, ask what I can do, or give a command like ‘research acmedigital.com’…",
    research: "Paste one or more domains to research, e.g. acmedigital.com, contact@acme.com…",
    outreach: "Which prospect? e.g. ‘outreach for acmedigital.com’…",
    pipeline: "Type ‘show pipeline’ for stage counts, stale deals & this week’s actions…",
    followup: "‘follow up with acme.com’, or leave blank for today’s due queue…",
    replies: "Type ‘check replies’ to read & classify inbound prospect replies (IMAP)…",
    meeting: "‘book meeting with acme.com’ or ‘show my meetings’…",
    clientcare: "Type ‘client care’ for today’s birthdays, anniversaries & check-ins…",
    audit: "Enter a domain for a lightweight SEO audit, e.g. acmedigital.com…",
    report: "‘full report for acme.com’ — aggregates everything NOVA knows…"
  };
  var mode = "chat";

  var TOOLS = [
    { mode: "chat",       glyph: "💬", name: "Auto",              desc: "Chat & auto-route to the right tool" },
    { mode: "research",   glyph: "🔎", name: "Research Prospect",  desc: "Scrape site + Lighthouse + socials + brief" },
    { mode: "outreach",   glyph: "✉️", name: "Generate Outreach",  desc: "3 cold-email variants over the real research" },
    { mode: "pipeline",   glyph: "📊", name: "Manage Pipeline",    desc: "Stage counts, stale deals, next actions" },
    { mode: "followup",   glyph: "🔁", name: "Follow-up Sequences",desc: "Day 3 / 7 / 14 queue (approve to send)" },
    { mode: "replies",    glyph: "📥", name: "Parse Replies",      desc: "IMAP inbox → classify → draft response" },
    { mode: "meeting",    glyph: "📅", name: "Schedule Meeting",   desc: "Offer slots, book, confirm & notify" },
    { mode: "clientcare", glyph: "🎂", name: "Client Care",        desc: "Birthdays, anniversaries, check-ins" },
    { mode: "audit",      glyph: "🩺", name: "Run Audit",          desc: "Lighthouse + shallow crawl SEO snapshot" },
    { mode: "report",     glyph: "📄", name: "Full Prospect Report",desc: "Everything aggregated → HTML / PDF" }
  ];
  var TOOL_BY_MODE = {}; TOOLS.forEach(function (t) { TOOL_BY_MODE[t.mode] = t; });

  function buildMenu(menuEl) {
    menuEl.innerHTML = TOOLS.map(function (t) {
      return '<button type="button" class="toolopt" role="menuitem" data-mode="' + t.mode + '">' +
        '<span class="oglyph">' + t.glyph + '</span>' +
        '<span class="obody"><span class="oname">' + t.name + '</span><span class="odesc">' + t.desc + '</span></span>' +
        '<svg class="ocheck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></button>';
    }).join("");
  }
  var menus = [document.getElementById("toolmenu"), document.getElementById("toolmenu2")];
  var pickers = [document.getElementById("toolpicker"), document.getElementById("toolpicker2")];
  menus.forEach(function (m) { if (m) buildMenu(m); });

  function syncTool() {
    var t = TOOL_BY_MODE[mode] || TOOL_BY_MODE.chat;
    pickers.forEach(function (p) {
      if (!p) return;
      var g = p.querySelector(".toolglyph"); if (g) g.textContent = t.glyph;
      var l = p.querySelector(".toollabel"); if (l) l.textContent = t.name;
      p.querySelectorAll(".toolopt").forEach(function (o) { o.setAttribute("aria-selected", o.getAttribute("data-mode") === mode ? "true" : "false"); });
    });
    var ph = PLACEHOLDERS[mode] || "Message NOVA…";
    var i1 = document.getElementById("input"); if (i1) i1.setAttribute("placeholder", ph);
    var i2 = document.getElementById("input2"); if (i2) i2.setAttribute("placeholder", ph);
  }
  function closeMenus() { menus.forEach(function (m) { if (m) m.hidden = true; }); pickers.forEach(function (p) { var b = p && p.querySelector(".toolbtn"); if (b) b.setAttribute("aria-expanded", "false"); }); }
  function toggleMenu(picker) { var menu = picker.querySelector(".toolmenu"); var btn = picker.querySelector(".toolbtn"); var willOpen = menu.hidden; closeMenus(); if (willOpen) { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); } }
  pickers.forEach(function (p) {
    if (!p) return;
    p.querySelector(".toolbtn").addEventListener("click", function (e) { e.stopPropagation(); toggleMenu(p); });
    p.querySelector(".toolmenu").addEventListener("click", function (e) { var opt = e.target.closest(".toolopt"); if (!opt) return; mode = opt.getAttribute("data-mode"); syncTool(); closeMenus(); var di = document.getElementById(chatting ? "input2" : "input"); if (di) di.focus(); });
  });
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenus(); });

  function grow(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }

  /* ---------- CHAT ---------- */
  var app = document.getElementById("app");
  var messages = document.getElementById("messages");
  var chatting = false;
  var SYS = {};

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var novaAvatar = '<div class="avatar"><svg viewBox="0 0 32 32" fill="none"><path d="M8 24V8l16 16V8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';

  function addUser(text) { var el = document.createElement("div"); el.className = "msg user"; el.innerHTML = '<div class="avatar">Y</div><div class="bubble">' + esc(text).replace(/\n/g, "<br>") + "</div>"; messages.appendChild(el); messages.scrollTop = messages.scrollHeight; }
  function addTyping() { var el = document.createElement("div"); el.className = "msg sage"; el.id = "typing"; el.innerHTML = novaAvatar + '<div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>'; messages.appendChild(el); messages.scrollTop = messages.scrollHeight; }
  function addSage(html) { var t = document.getElementById("typing"); if (t) t.remove(); var el = document.createElement("div"); el.className = "msg sage"; el.innerHTML = novaAvatar + '<div class="bubble">' + html + "</div>"; messages.appendChild(el); messages.scrollTop = messages.scrollHeight; return el; }

  /* ---------- REPORT RENDERER (same block schema as SAGE) ---------- */
  function renderReport(report) {
    var h = '<div class="r-head"><span class="r-tag">' + esc(report.tag || "NOVA") + "</span>";
    if (report.title) h += '<span class="r-title">' + esc(report.title) + "</span>";
    h += "</div>";
    (report.blocks || []).forEach(function (blk) { h += renderBlock(blk); });
    return h;
  }
  function renderBlock(blk) {
    switch (blk.type) {
      case "p": return "<p>" + esc(blk.text) + "</p>";
      case "note": return '<div class="note">' + esc(blk.text) + "</div>";
      case "list": return "<ul>" + (blk.items || []).map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>";
      case "chips": return '<div class="chips">' + (blk.items || []).map(function (i) { return '<span class="chip">' + esc(i) + "</span>"; }).join("") + "</div>";
      case "kv": return '<div class="kv">' + (blk.items || []).map(function (r) { return '<div class="row"><span class="k">' + esc(r.k) + '</span><span class="v">' + esc(r.v) + "</span></div>"; }).join("") + "</div>";
      case "table":
        var head = (blk.head || []).map(function (h2) { return "<th>" + esc(h2) + "</th>"; }).join("");
        var rows = (blk.rows || []).map(function (row) { return "<tr>" + row.map(function (cell) { return "<td>" + renderCell(cell) + "</td>"; }).join("") + "</tr>"; }).join("");
        return '<div class="tblwrap"><table class="tbl"><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table></div>";
      case "tasks":
        return '<div class="tasks">' + (blk.items || []).map(function (t) { var sev = (t.priority || "medium"); return '<div class="task"><span class="sev ' + sev + ' tsev">' + sev.toUpperCase() + "</span><div class=\"tbody\"><div class=\"ttitle\">" + esc(t.title) + "</div>" + (t.detail ? '<div class="tdetail">' + esc(t.detail) + "</div>" : "") + "</div></div>"; }).join("") + "</div>";
      default: return "";
    }
  }
  function renderCell(cell) { var s = String(cell); var sev = s.toLowerCase(); if (["critical", "high", "medium", "low"].indexOf(sev) !== -1) return '<span class="sev ' + sev + '">' + s + "</span>"; return esc(s); }

  /* ---------- ACTION WIRING ---------- */
  function actionBar(bubble) { var bar = document.createElement("div"); bar.className = "r-actions"; bubble.appendChild(bar); return bar; }
  function actBtn(bar, label, ghost) { var b = document.createElement("button"); b.type = "button"; b.className = "act-btn" + (ghost ? " ghost" : ""); b.innerHTML = "<span>" + esc(label) + "</span>"; bar.appendChild(b); return b; }
  function note(bar, text) { var n = document.createElement("div"); n.className = "note"; n.style.width = "100%"; n.textContent = text; bar.appendChild(n); }
  function spin(btn, on, label) { var s = btn.querySelector("span"); btn.disabled = on; if (s) s.innerHTML = on ? '<span class="spinner"></span>' : esc(label); }
  function postJSON(url, body) { return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); }); }

  function attachReportActions(report, bubble) {
    var d = report.data || {};
    var tag = report.tag;

    if (tag === "Prospect Research" && d.domain) {
      var bar = actionBar(bubble);
      var gb = actBtn(bar, "Generate Outreach Email");
      gb.addEventListener("click", function () { spin(gb, true); postJSON("/api/outreach/generate", { domain: d.domain }).then(function (res) { spin(gb, false, "Generate Outreach Email"); if (res.ok) { var el = addSage(renderReport(res.report)); attachReportActions(res.report, el.querySelector(".bubble")); } else note(bar, res.error || "Failed."); }); });
      var ab = actBtn(bar, "Run Full Audit", true); ab.addEventListener("click", function () { run("audit " + d.domain, null, "audit"); });
      var rb = actBtn(bar, "Full Prospect Report", true); rb.addEventListener("click", function () { run("full report for " + d.domain, null, "report"); });
    }

    if (tag === "Outreach" && d.variants && d.variants.length) {
      var obar = actionBar(bubble);
      if (!(SYS.email && SYS.email.connected)) { note(obar, "Connect SMTP (SMTP_HOST/USER/PASS) to send. Drafts are saved."); }
      d.variants.forEach(function (v, i) {
        var sb = actBtn(obar, "Send Variant " + (i + 1));
        sb.addEventListener("click", function () {
          if (!confirm("Send variant " + (i + 1) + ' "' + v.subject + '" to ' + (d.to || "the prospect") + "?")) return;
          spin(sb, true); postJSON("/api/outreach/send", { domain: d.domain, variantIndex: i, toEmail: d.to }).then(function (res) { spin(sb, false, "Send Variant " + (i + 1)); if (res.ok) { sb.disabled = true; note(obar, "✓ Sent to " + res.to + " — follow-up sequence armed."); refreshPipeline(); } else note(obar, res.error || "Send failed."); });
        });
      });
    }

    if (tag === "Meetings" && d.slots && d.slots.length) {
      var mbar = actionBar(bubble);
      var email = d.prospectEmail || "";
      d.slots.forEach(function (s) {
        var slb = actBtn(mbar, s.display, true);
        slb.addEventListener("click", function () {
          var to = email || prompt("Prospect email for the confirmation?") || "";
          spin(slb, true); postJSON("/api/meetings/book", { domain: d.domain, slotIso: s.iso, prospectEmail: to }).then(function (res) { spin(slb, false, s.display); if (res.ok) { note(mbar, "✓ Booked " + s.display + (res.meeting && res.meeting.prospectEmail ? " · confirmation sent" : "")); refreshPipeline(); } else note(mbar, res.error || "Booking failed."); });
        });
      });
    }

    if (tag === "Follow-up" && d.domain && d.n) {
      var fbar = actionBar(bubble);
      var apb = actBtn(fbar, "Approve follow-up #" + d.n);
      apb.addEventListener("click", function () { spin(apb, true); postJSON("/api/followup/approve", { domain: d.domain, n: d.n }).then(function (res) { spin(apb, false, "Approve follow-up #" + d.n); if (res.ok) { apb.disabled = true; note(fbar, "✓ Follow-up sent."); refreshPipeline(); } else note(fbar, res.error || "Failed."); }); });
      var skb = actBtn(fbar, "Skip", true); skb.addEventListener("click", function () { postJSON("/api/followup/skip", { domain: d.domain, n: d.n }).then(function () { note(fbar, "Skipped."); }); });
    }

    if (tag === "Client Care" && d.actions && d.actions.length) {
      var cbar = actionBar(bubble);
      d.actions.forEach(function (a) {
        var cb = actBtn(cbar, "Approve " + a.type + " · " + a.client);
        cb.addEventListener("click", function () { spin(cb, true); postJSON("/api/clientcare/approve", { domain: a.domain, type: a.type }).then(function (res) { spin(cb, false, "Approve " + a.type + " · " + a.client); if (res.ok) { cb.disabled = true; note(cbar, "✓ Sent."); } else note(cbar, res.error || "Failed."); }); });
      });
    }

    if (tag === "Full Report" && (d.htmlUrl || d.pdfUrl)) {
      var rbar = actionBar(bubble);
      if (d.htmlUrl) { var ob = actBtn(rbar, "Open report"); ob.addEventListener("click", function () { window.open(d.htmlUrl, "_blank"); }); }
      if (d.pdfUrl) { var pb = actBtn(rbar, "⬇ Download PDF", true); pb.addEventListener("click", function () { window.open(d.pdfUrl, "_blank"); }); }
    }
  }

  /* ---------- SEND FLOW ---------- */
  var busy = false;
  var NO_TEXT_MODES = { pipeline: 1, replies: 1, clientcare: 1, followup: 1, meeting: 1 };

  function run(text, btnEl, modeOverride) {
    if (busy) return;
    text = (text || "").trim();
    var useMode = modeOverride || mode;
    if (!text && !NO_TEXT_MODES[useMode]) return;
    var activeBtn = btnEl || document.getElementById(chatting ? "send2" : "send");
    if (!chatting) { app.classList.add("chatting"); chatting = true; }
    addUser(text || TOOL_BY_MODE[useMode].name);

    busy = true;
    var label = activeBtn.querySelector("span"); var orig = label ? label.textContent : "";
    activeBtn.disabled = true; if (label) label.innerHTML = '<span class="spinner"></span>';
    addTyping();

    postJSON("/api/ask", { mode: useMode, text: text })
      .then(function (data) { if (data && data.report) { var el = addSage(renderReport(data.report)); attachReportActions(data.report, el.querySelector(".bubble")); refreshPipeline(); } else addSage('<div class="note">Unexpected response from server.</div>'); })
      .catch(function (err) { addSage('<div class="note">Request failed: ' + esc(err.message || err) + "</div>"); })
      .then(function () { busy = false; activeBtn.disabled = false; if (label) label.textContent = orig; var di = document.getElementById("input2"); if (di) di.focus(); });
  }

  function send(inputEl, btnEl) { var text = inputEl.value.trim(); if (!text && !NO_TEXT_MODES[mode]) { inputEl.focus(); return; } run(text, btnEl); inputEl.value = ""; grow(inputEl); }
  function wire(inputEl, btnEl) { inputEl.addEventListener("input", function () { grow(inputEl); }); inputEl.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(inputEl, btnEl); } }); btnEl.addEventListener("click", function () { send(inputEl, btnEl); }); }
  wire(document.getElementById("input"), document.getElementById("send"));
  wire(document.getElementById("input2"), document.getElementById("send2"));

  var cando = document.getElementById("whatCanYouDo");
  if (cando) cando.addEventListener("click", function () { run("What can you do?", null, "chat"); });
  syncTool();

  /* ---------- SIDEBAR (live pipeline) ---------- */
  var STAGE_LABEL = { RESEARCHED: "Researched", CONTACTED: "Contacted", REPLIED: "Replied", MEETING_BOOKED: "Meeting", PROPOSAL_SENT: "Proposal", CLOSED_WON: "Won", CLOSED_LOST: "Lost", DEAD: "Dead" };
  var STAGE_ORDER = ["RESEARCHED", "CONTACTED", "REPLIED", "MEETING_BOOKED", "PROPOSAL_SENT", "CLOSED_WON", "CLOSED_LOST", "DEAD"];

  function renderLegend(summary) {
    var el = document.getElementById("sideLegend");
    el.innerHTML = STAGE_ORDER.filter(function (s) { return (summary && summary[s]) > 0; }).map(function (s) {
      return '<span class="leg"><span class="swatch st-' + s + '"></span>' + STAGE_LABEL[s] + " " + summary[s] + "</span>";
    }).join("") || '<span class="leg" style="color:var(--muted-2)">Empty</span>';
  }
  function renderSidebar(data) {
    var list = document.getElementById("sideList");
    var count = document.getElementById("sideCount");
    var prospects = (data && data.prospects) || [];
    count.textContent = prospects.length;
    renderLegend((data && data.summary) || {});
    if (!prospects.length) { list.innerHTML = '<div class="side-empty">No prospects yet. Say “research acmedigital.com”.</div>'; return; }
    list.innerHTML = prospects.map(function (p) {
      var next = p.nextActionAt ? ("Next: " + new Date(p.nextActionAt).toLocaleDateString("en-US") + " · " + (p.nextActionNote || "")) : "";
      return '<button class="prow" data-domain="' + esc(p.domain) + '">' +
        '<div class="prow-top"><span class="prow-name">' + esc(p.companyName || p.domain) + '</span>' +
        '<span class="prow-stage st-' + p.stage + '">' + esc(STAGE_LABEL[p.stage] || p.stage) + '</span></div>' +
        '<div class="prow-meta"><span class="dom">' + esc(p.domain) + '</span><span class="days">' + (p.daysSinceContact != null ? p.daysSinceContact + "d" : "—") + '</span></div>' +
        (next ? '<div class="prow-next">' + esc(next) + "</div>" : "") + "</button>";
    }).join("");
    list.querySelectorAll(".prow").forEach(function (row) {
      row.addEventListener("click", function () { openProspect(row.getAttribute("data-domain")); });
    });
  }
  function openProspect(domain) {
    if (!chatting) { app.classList.add("chatting"); chatting = true; }
    addUser(domain);
    addTyping();
    fetch("/api/pipeline/" + encodeURIComponent(domain)).then(function (r) { return r.json(); }).then(function (res) {
      if (res.ok && res.report) { var el = addSage(renderReport(res.report)); attachReportActions(res.report, el.querySelector(".bubble")); }
      else addSage('<div class="note">Could not load that prospect.</div>');
    }).catch(function () { addSage('<div class="note">Could not load that prospect.</div>'); });
  }
  function refreshPipeline() { fetch("/api/pipeline").then(function (r) { return r.json(); }).then(renderSidebar).catch(function () {}); }
  document.getElementById("sideRefresh").addEventListener("click", refreshPipeline);
  document.getElementById("sideToggle").addEventListener("click", function () { app.classList.toggle("side-collapsed"); });
  if (window.matchMedia && window.matchMedia("(max-width:900px)").matches) app.classList.add("side-collapsed");
  refreshPipeline();
  setInterval(refreshPipeline, 60000);

  /* ---------- STATUS ---------- */
  fetch("/api/status").then(function (r) { return r.json(); }).then(function (s) {
    SYS = s || {};
    var line = document.getElementById("statusLine");
    if (s && s.llm && !s.llm.configured) line.innerHTML = "⚠ LLM not configured — add a key to .env to activate NOVA";
    else if (s && s.agency) line.textContent = "NOVA by " + s.agency.name + " — autonomous business development";
    if (s && s.auth && s.auth.enabled) {
      var chip = document.getElementById("userChip"); var out = document.getElementById("logoutBtn");
      if (chip && s.auth.user) { chip.textContent = s.auth.user; chip.hidden = false; }
      if (out) out.hidden = false;
    }
  }).catch(function () {});
})();
