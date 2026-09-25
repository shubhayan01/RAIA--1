(function () {
  "use strict";
  var app = document.getElementById("app");
  var tabs = document.getElementById("navTabs");
  if (!app || !tabs) return;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function getJSON(url) { return fetch(url).then(function (r) { return r.json(); }); }
  function send(method, url, body) { return fetch(url, { method: method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); }); }

  var STAGES = [
    { key: "first", label: "First email" },
    { key: "thankyou", label: "Thank-you email" },
    { key: "followup", label: "Follow-up email" },
    { key: "closing", label: "Closing email" }
  ];
  var STATUS = [
    { v: "new", t: "New" }, { v: "first_sent", t: "First sent" }, { v: "thankyou_sent", t: "Thanked" },
    { v: "followup_sent", t: "Followed up" }, { v: "replied", t: "Replied" }, { v: "closed", t: "Closed" }, { v: "failed", t: "Failed" }
  ];
  function badgeClass(s) {
    if (s === "new") return "cb-new"; if (s === "replied") return "cb-replied";
    if (s === "closed") return "cb-closed"; if (s === "failed") return "cb-failed"; return "cb-sent";
  }

  var current = null;      // full current campaign object
  var currentId = null;

  /* ---------- view switching ---------- */
  function setView(v) {
    app.setAttribute("data-view", v);
    tabs.querySelectorAll(".navtab").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-view") === v); });
    if (v === "campaigns") loadCampaigns();
    if (v === "contacts") loadCampaigns(true);
  }
  tabs.addEventListener("click", function (e) { var b = e.target.closest(".navtab"); if (b) setView(b.getAttribute("data-view")); });

  /* ---------- campaigns list + selectors ---------- */
  function loadCampaigns(forContacts) {
    return getJSON("/api/campaigns").then(function (res) {
      var list = (res && res.campaigns) || [];
      if (!currentId && list.length) currentId = list[0].id;
      fillSelect(document.getElementById("campSelect"), list);
      fillSelect(document.getElementById("contactCampSelect"), list);
      if (!list.length) { showCampaign(null); renderContacts(null); return; }
      return loadCampaign(currentId, forContacts);
    });
  }
  function fillSelect(sel, list) {
    if (!sel) return;
    sel.innerHTML = list.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + " (" + c.contacts.length + ")</option>"; }).join("");
    if (currentId) sel.value = currentId;
  }
  function loadCampaign(id, forContacts) {
    return getJSON("/api/campaigns/" + encodeURIComponent(id)).then(function (res) {
      current = res && res.campaign;
      if (forContacts) renderContacts(current); else showCampaign(current);
    });
  }

  document.getElementById("campSelect").addEventListener("change", function () { currentId = this.value; loadCampaign(currentId); });
  document.getElementById("contactCampSelect").addEventListener("change", function () { currentId = this.value; loadCampaign(currentId, true); });

  function createCampaign() {
    var name = prompt("Name this campaign:", "New outreach campaign");
    if (name == null) return;
    send("POST", "/api/campaigns", { name: name }).then(function (res) { if (res.ok) { currentId = res.campaign.id; loadCampaigns(); } });
  }
  document.getElementById("campNew").addEventListener("click", createCampaign);
  document.getElementById("campNew2").addEventListener("click", createCampaign);
  document.getElementById("campDelete").addEventListener("click", function () {
    if (!currentId || !current) return;
    if (!confirm('Delete campaign "' + current.name + '" and all its contacts?')) return;
    send("DELETE", "/api/campaigns/" + encodeURIComponent(currentId)).then(function () { currentId = null; loadCampaigns(); });
  });

  /* ---------- campaign body (import / templates / send) ---------- */
  function showCampaign(c) {
    var empty = document.getElementById("campEmpty");
    var body = document.getElementById("campBody");
    if (!c) { empty.hidden = false; body.hidden = true; return; }
    empty.hidden = true; body.hidden = false;
    renderTemplates(c);
    renderSend(c);
  }

  function renderTemplates(c) {
    var wrap = document.getElementById("campTemplates");
    wrap.innerHTML = STAGES.map(function (s) {
      var t = c.templates[s.key] || { subject: "", body: "" };
      return '<div class="tpl" data-stage="' + s.key + '">' +
        '<div class="tpl-head"><span class="tpl-name">' + esc(s.label) + '</span>' +
        '<button class="tpl-ai" data-stage="' + s.key + '">✨ Draft with AI</button></div>' +
        '<input class="tpl-subj" value="' + esc(t.subject) + '" placeholder="Subject line" />' +
        '<textarea class="tpl-body" placeholder="Email body">' + esc(t.body) + "</textarea>" +
        '<div class="tpl-saved" data-stage="' + s.key + '"></div></div>';
    }).join("");

    // auto-save on blur
    wrap.querySelectorAll(".tpl").forEach(function (tplEl) {
      var stage = tplEl.getAttribute("data-stage");
      var subj = tplEl.querySelector(".tpl-subj");
      var bodyEl = tplEl.querySelector(".tpl-body");
      function saveTpl() {
        var payload = { templates: {} };
        payload.templates[stage] = { subject: subj.value, body: bodyEl.value };
        var savedEl = tplEl.querySelector(".tpl-saved");
        send("PUT", "/api/campaigns/" + encodeURIComponent(currentId) + "/templates", payload).then(function (res) {
          savedEl.textContent = res.ok ? "✓ Saved" : (res.error || "Save failed");
          setTimeout(function () { savedEl.textContent = ""; }, 1600);
          if (res.ok && current) current.templates[stage] = payload.templates[stage];
        });
      }
      subj.addEventListener("change", saveTpl);
      bodyEl.addEventListener("change", saveTpl);
    });

    wrap.querySelectorAll(".tpl-ai").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var stage = btn.getAttribute("data-stage");
        var tplEl = wrap.querySelector('.tpl[data-stage="' + stage + '"]');
        var orig = btn.textContent; btn.textContent = "Drafting…"; btn.disabled = true;
        send("POST", "/api/campaigns/" + encodeURIComponent(currentId) + "/draft", { stage: stage }).then(function (res) {
          btn.textContent = orig; btn.disabled = false;
          if (res.ok && res.template) {
            tplEl.querySelector(".tpl-subj").value = res.template.subject;
            tplEl.querySelector(".tpl-body").value = res.template.body;
            tplEl.querySelector(".tpl-subj").dispatchEvent(new Event("change"));
            tplEl.querySelector(".tpl-body").dispatchEvent(new Event("change"));
          } else { alert(res.error || "Could not draft."); }
        });
      });
    });
  }

  function eligibleCount(c, stage) {
    return c.contacts.filter(function (ct) {
      if (ct.status === "closed" && stage !== "closing") return false;
      return !(ct.history || []).some(function (h) { return h.stage === stage && h.ok; });
    }).length;
  }

  function renderSend(c) {
    var wrap = document.getElementById("campSend");
    var onlyEligible = document.getElementById("campOnlyEligible").checked;
    wrap.innerHTML = STAGES.map(function (s) {
      var n = onlyEligible ? eligibleCount(c, s.key) : c.contacts.length;
      return '<button class="send-btn" data-stage="' + s.key + '"' + (n === 0 ? " disabled" : "") + ">" +
        "<span>Send " + esc(s.label) + '</span><span class="cnt">' + n + " " + (onlyEligible ? "eligible" : "contacts") + "</span></button>";
    }).join("");
    wrap.querySelectorAll(".send-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var stage = btn.getAttribute("data-stage");
        var label = STAGES.filter(function (s) { return s.key === stage; })[0].label;
        var oe = document.getElementById("campOnlyEligible").checked;
        var n = oe ? eligibleCount(c, stage) : c.contacts.length;
        if (!confirm("Send the " + label + " to " + n + " contact(s) now? This sends real emails.")) return;
        var orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = "<span>Sending…</span>";
        var msg = document.getElementById("campSendMsg");
        send("POST", "/api/campaigns/" + encodeURIComponent(currentId) + "/send", { stage: stage, onlyEligible: oe }).then(function (res) {
          if (res.ok) {
            msg.className = "import-msg ok";
            msg.textContent = "Sent " + res.sent + " · failed " + res.failed + " · skipped " + res.skipped + ".";
          } else { msg.className = "import-msg err"; msg.textContent = res.error || "Send failed."; btn.innerHTML = orig; btn.disabled = false; }
          loadCampaign(currentId); // refresh counts/statuses
        }).catch(function (e) { msg.className = "import-msg err"; msg.textContent = String(e); btn.innerHTML = orig; btn.disabled = false; });
      });
    });
  }
  document.getElementById("campOnlyEligible").addEventListener("change", function () { if (current) renderSend(current); });

  /* ---------- import ---------- */
  var fileInput = document.getElementById("campFile");
  var chosen = null;
  fileInput.addEventListener("change", function () {
    chosen = fileInput.files && fileInput.files[0];
    document.getElementById("campFileName").textContent = chosen ? chosen.name : "No file chosen";
    document.getElementById("campImport").disabled = !chosen;
  });
  document.getElementById("campImport").addEventListener("click", function () {
    if (!chosen || !currentId) return;
    var msg = document.getElementById("campImportMsg");
    var reader = new FileReader();
    reader.onload = function () {
      send("POST", "/api/campaigns/" + encodeURIComponent(currentId) + "/import", { content: String(reader.result || "") }).then(function (res) {
        if (res.ok) { msg.className = "import-msg ok"; msg.textContent = "Imported " + res.added + " contact(s) · " + res.skipped + " skipped · " + res.total + " total."; loadCampaign(currentId); }
        else { msg.className = "import-msg err"; msg.textContent = res.error || "Import failed."; }
      });
    };
    reader.readAsText(chosen);
  });

  /* ---------- contacts view ---------- */
  function renderContacts(c) {
    var wrap = document.getElementById("contactsWrap");
    var empty = document.getElementById("contactsEmpty");
    var bodyEl = document.getElementById("contactsBody");
    if (!c || !c.contacts.length) { wrap.hidden = true; empty.hidden = false; empty.textContent = c ? "No contacts in this campaign yet. Import a list from the Campaigns tab." : "No campaigns. Create one in the Campaigns tab."; return; }
    empty.hidden = true; wrap.hidden = false;
    var q = (document.getElementById("contactSearch").value || "").toLowerCase();
    var rows = c.contacts.filter(function (ct) {
      return !q || (ct.email + " " + ct.name + " " + ct.company).toLowerCase().indexOf(q) !== -1;
    });
    bodyEl.innerHTML = rows.map(function (ct) {
      var last = (ct.history || []).filter(function (h) { return h.ok; }).slice(-1)[0];
      var lastTxt = last ? (last.stage + " · " + new Date(last.sentAt).toLocaleDateString("en-US")) : "—";
      var opts = STATUS.map(function (o) { return '<option value="' + o.v + '"' + (o.v === ct.status ? " selected" : "") + ">" + o.t + "</option>"; }).join("");
      return "<tr data-email=\"" + esc(ct.email) + "\">" +
        '<td class="c-email">' + esc(ct.email) + "</td>" +
        "<td>" + esc(ct.name || "—") + "</td>" +
        "<td>" + esc(ct.company || "—") + "</td>" +
        '<td><select class="cstatus">' + opts + "</select></td>" +
        "<td>" + esc(lastTxt) + "</td>" +
        '<td><button class="c-remove" title="Remove">✕</button></td></tr>';
    }).join("");

    bodyEl.querySelectorAll("tr").forEach(function (tr) {
      var email = tr.getAttribute("data-email");
      tr.querySelector(".cstatus").addEventListener("change", function () {
        send("POST", "/api/campaigns/" + encodeURIComponent(currentId) + "/contact", { email: email, status: this.value }).then(function () {
          var ct = current.contacts.filter(function (x) { return x.email === email; })[0]; if (ct) ct.status = tr.querySelector(".cstatus").value;
        });
      });
      tr.querySelector(".c-remove").addEventListener("click", function () {
        if (!confirm("Remove " + email + " from this campaign?")) return;
        send("DELETE", "/api/campaigns/" + encodeURIComponent(currentId) + "/contact", { email: email }).then(function () { loadCampaign(currentId, true); });
      });
    });
  }
  document.getElementById("contactSearch").addEventListener("input", function () { if (current) renderContacts(current); });
})();
