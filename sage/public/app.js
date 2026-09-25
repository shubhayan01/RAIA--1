(function () {
  "use strict";
  var root = document.documentElement;

  /* ---------- THEME ---------- */
  var toggle = document.getElementById("themeToggle");
  try {
    var saved = localStorage.getItem("sage-theme");
    if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);
  } catch (e) {}
  function currentTheme() {
    var t = root.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light";
  }
  toggle.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("sage-theme", next); } catch (e) {}
  });

  /* ---------- MODES ---------- */
  var PLACEHOLDERS = {
    chat: "Say hi, ask what I can do, or give a command like ‘audit example.com’…",
    keywords: "Enter a seed keyword or topic to research…",
    audit: "Enter a URL to crawl & audit, e.g. https://clientsite.com",
    briefs: "Enter the primary keyword for the content brief…",
    aio: "Keyword + your URL, e.g. best crm software vs https://yoursite.com/crm…",
    ranks: "Your domain + keywords, e.g. yoursite.com: running shoes, best trainers…",
    cannibal: "Enter the site to check for cannibalization, e.g. clientsite.com",
    intel: "Type 'report' to pull the latest GSC + GA4 intelligence…",
    competitors: "Enter the client domain, e.g. clientsite.com",
    opportunity: "Type 'find quick wins' — add 'and publish' to queue WP drafts (needs GSC)…",
    autolink: "Enter a site, e.g. clientsite.com — add 'apply' to insert links into WordPress",
    schema: "Enter a site, e.g. clientsite.com — add 'apply' to inject JSON-LD into WordPress",
    report: "Enter a site for a full client audit report (PDF), e.g. clientsite.com"
  };
  var mode = "chat";

  // The tool menu. `chat` = Auto (S.A.G.E decides). The rest force a tool.
  var TOOLS = [
    { mode: "chat",        glyph: "💬", name: "Auto",            desc: "Chat & auto-route to the right tool" },
    { mode: "keywords",    glyph: "🔑", name: "Keywords",        desc: "Research & cluster keywords (free Google data)" },
    { mode: "audit",       glyph: "🩺", name: "Audit",           desc: "Crawl a site + Google Lighthouse" },
    { mode: "briefs",      glyph: "📝", name: "Content Brief",   desc: "SERP-based brief for a keyword" },
    { mode: "aio",         glyph: "✨", name: "AI Overview",     desc: "AI Overview content-gap (GEO/AEO)" },
    { mode: "ranks",       glyph: "📈", name: "Rank Tracker",    desc: "Live Google positions for keywords" },
    { mode: "cannibal",    glyph: "🔀", name: "Cannibalization", desc: "Find pages competing for one query" },
    { mode: "opportunity", glyph: "🚀", name: "Opportunity",     desc: "GSC striking-distance → rewrite briefs → WP drafts" },
    { mode: "autolink",    glyph: "🔗", name: "Internal Links",  desc: "Find & insert internal links (→ WordPress)" },
    { mode: "schema",      glyph: "🧩", name: "Schema",          desc: "Generate & inject JSON-LD structured data (→ WordPress)" },
    { mode: "intel",       glyph: "📊", name: "Intelligence",    desc: "GSC + GA4 monthly report" },
    { mode: "competitors", glyph: "🥊", name: "Competitors",     desc: "Competitive & content-gap analysis" },
    { mode: "report",      glyph: "📄", name: "Full Report",     desc: "Detailed client audit + PDF download" }
  ];
  var TOOL_BY_MODE = {};
  TOOLS.forEach(function (t) { TOOL_BY_MODE[t.mode] = t; });

  // Build the menu items into both dropdowns.
  function buildMenu(menuEl) {
    menuEl.innerHTML = TOOLS.map(function (t) {
      return '<button type="button" class="toolopt" role="menuitem" data-mode="' + t.mode + '">' +
        '<span class="oglyph">' + t.glyph + '</span>' +
        '<span class="obody"><span class="oname">' + t.name + '</span>' +
        '<span class="odesc">' + t.desc + '</span></span>' +
        '<svg class="ocheck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' +
        '</button>';
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
      p.querySelectorAll(".toolopt").forEach(function (o) {
        o.setAttribute("aria-selected", o.getAttribute("data-mode") === mode ? "true" : "false");
      });
    });
    var ph = PLACEHOLDERS[mode] || "Message S.A.G.E…";
    var i1 = document.getElementById("input"); if (i1) i1.setAttribute("placeholder", ph);
    var i2 = document.getElementById("input2"); if (i2) i2.setAttribute("placeholder", ph);
  }

  function closeMenus() {
    menus.forEach(function (m) { if (m) m.hidden = true; });
    pickers.forEach(function (p) { var btn = p && p.querySelector(".toolbtn"); if (btn) btn.setAttribute("aria-expanded", "false"); });
  }
  function toggleMenu(picker) {
    var menu = picker.querySelector(".toolmenu");
    var btn = picker.querySelector(".toolbtn");
    var willOpen = menu.hidden;
    closeMenus();
    if (willOpen) { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); }
  }

  pickers.forEach(function (p) {
    if (!p) return;
    p.querySelector(".toolbtn").addEventListener("click", function (e) { e.stopPropagation(); toggleMenu(p); });
    p.querySelector(".toolmenu").addEventListener("click", function (e) {
      var opt = e.target.closest(".toolopt");
      if (!opt) return;
      mode = opt.getAttribute("data-mode");
      syncTool();
      closeMenus();
      var di = document.getElementById(chatting ? "input2" : "input"); if (di) di.focus();
    });
  });
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenus(); });

  /* ---------- TEXTAREA AUTOGROW ---------- */
  function grow(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }

  /* ---------- CHAT ---------- */
  var app = document.getElementById("app");
  var messages = document.getElementById("messages");
  var chatting = false;
  var SYS = {}; // /api/status snapshot — used to gate execution-layer actions

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var sageAvatar =
    '<div class="avatar"><svg viewBox="0 0 32 32" fill="none">' +
    '<circle cx="16" cy="16" r="13" stroke="currentColor" stroke-width="1.4" opacity=".5"/>' +
    '<circle cx="16" cy="16" r="7.5" stroke="currentColor" stroke-width="1.6" opacity=".85"/>' +
    '<circle cx="16" cy="16" r="3" fill="currentColor"/></svg></div>';

  function addUser(text) {
    var el = document.createElement("div");
    el.className = "msg user";
    el.innerHTML = '<div class="avatar">Y</div><div class="bubble">' + esc(text).replace(/\n/g, "<br>") + "</div>";
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }
  function addTyping() {
    var el = document.createElement("div");
    el.className = "msg sage"; el.id = "typing";
    el.innerHTML = sageAvatar + '<div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>';
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }
  function addSage(html) {
    var t = document.getElementById("typing"); if (t) t.remove();
    var el = document.createElement("div");
    el.className = "msg sage";
    el.innerHTML = sageAvatar + '<div class="bubble">' + html + "</div>";
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  /* ---------- REPORT RENDERER ---------- */
  function renderReport(report) {
    var h = "";
    h += '<div class="r-head"><span class="r-tag">' + esc(report.tag || "S.A.G.E") + "</span>";
    if (report.title) h += '<span class="r-title">' + esc(report.title) + "</span>";
    h += "</div>";
    (report.blocks || []).forEach(function (blk) { h += renderBlock(blk); });
    return h;
  }
  function renderBlock(blk) {
    switch (blk.type) {
      case "p":
        return "<p>" + esc(blk.text) + "</p>";
      case "note":
        return '<div class="note">' + esc(blk.text) + "</div>";
      case "list":
        return "<ul>" + (blk.items || []).map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>";
      case "chips":
        return '<div class="chips">' + (blk.items || []).map(function (i) { return '<span class="chip">' + esc(i) + "</span>"; }).join("") + "</div>";
      case "kv":
        return '<div class="kv">' + (blk.items || []).map(function (r) {
          return '<div class="row"><span class="k">' + esc(r.k) + '</span><span class="v">' + esc(r.v) + "</span></div>";
        }).join("") + "</div>";
      case "table":
        var head = (blk.head || []).map(function (h2) { return "<th>" + esc(h2) + "</th>"; }).join("");
        var rows = (blk.rows || []).map(function (row) {
          return "<tr>" + row.map(function (cell) { return "<td>" + renderCell(cell) + "</td>"; }).join("") + "</tr>";
        }).join("");
        return '<div class="tblwrap"><table class="tbl"><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table></div>";
      case "tasks":
        return '<div class="tasks">' + (blk.items || []).map(function (t) {
          var sev = (t.priority || "medium");
          return '<div class="task"><span class="sev ' + sev + ' tsev">' + sev.toUpperCase() + "</span>" +
            '<div class="tbody"><div class="ttitle">' + esc(t.title) + "</div>" +
            (t.detail ? '<div class="tdetail">' + esc(t.detail) + "</div>" : "") + "</div></div>";
        }).join("") + "</div>";
      default:
        return "";
    }
  }
  function renderCell(cell) {
    var s = String(cell);
    var sev = s.toLowerCase();
    if (["critical", "high", "medium", "low"].indexOf(sev) !== -1) {
      return '<span class="sev ' + sev + '">' + s + "</span>";
    }
    return esc(s);
  }

  /* ---------- EXECUTION-LAYER ACTIONS (WordPress push / meta fix) ---------- */
  var BTN_STYLE =
    "display:inline-flex;align-items:center;gap:6px;margin:2px 8px 2px 0;padding:8px 14px;" +
    "border:1px solid var(--accent,#4f46e5);border-radius:999px;background:var(--accent,#4f46e5);" +
    "color:#fff;font:600 13px system-ui;cursor:pointer";

  function actionBar(bubble) {
    var bar = document.createElement("div");
    bar.className = "r-actions";
    bar.style.cssText = "margin-top:12px;display:flex;flex-wrap:wrap;align-items:center";
    bubble.appendChild(bar);
    return bar;
  }
  function actionNote(bar, text) {
    var n = document.createElement("div");
    n.className = "note";
    n.style.cssText = "margin-top:8px;width:100%";
    n.textContent = text;
    bar.appendChild(n);
  }
  function actionButton(bar, label) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText = BTN_STYLE;
    btn.innerHTML = "<span>" + esc(label) + "</span>";
    bar.appendChild(btn);
    return btn;
  }
  function spin(btn, on, label) {
    var span = btn.querySelector("span");
    btn.disabled = on;
    if (span) span.innerHTML = on ? '<span class="spinner"></span>' : esc(label);
  }

  // Called after each report renders: attach any feature actions to its bubble.
  function attachReportActions(report) {
    if (!report || !report.tag) return;
    var msgEl = messages.lastElementChild;
    if (!msgEl) return;
    var bubble = msgEl.querySelector(".bubble");
    if (!bubble) return;

    if (report.tag === "Content Brief" && report.data) {
      var bar = actionBar(bubble);
      if (SYS.wordpress && SYS.wordpress.connected) {
        var pb = actionButton(bar, "Push to WordPress");
        pb.addEventListener("click", function () { pushBrief(report.data, pb, bar); });
      } else {
        actionNote(bar, "Connect WordPress (WP_URL, WP_USERNAME, WP_APP_PASSWORD in .env) to push this brief straight into the CMS as a draft.");
      }
    }

    if (report.tag === "SEO Audit" && report.data) {
      var bar2 = actionBar(bubble);
      if (SYS.wordpress && SYS.wordpress.connected) {
        var fb = actionButton(bar2, "Fix Meta Tags");
        fb.addEventListener("click", function () { fixMeta(report.data, fb, bar2); });
      } else {
        actionNote(bar2, "Connect WordPress in .env to auto-generate and push optimized title tags & meta descriptions for the flagged pages.");
      }
    }
  }

  function pushBrief(briefData, btn, bar) {
    spin(btn, true);
    fetch("/api/cms/push-brief", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefData: briefData })
    }).then(function (r) { return r.json(); }).then(function (res) {
      spin(btn, false, "Push to WordPress");
      if (res && res.ok) {
        btn.disabled = true;
        var ok = document.createElement("div");
        ok.className = "chips"; ok.style.cssText = "margin-top:8px;width:100%";
        ok.innerHTML =
          '<span class="chip">✓ Draft created</span>' +
          (res.editLink ? '<a class="chip" href="' + esc(res.editLink) + '" target="_blank" rel="noopener">Open in WordPress editor</a>' : "") +
          (res.link ? '<a class="chip" href="' + esc(res.link) + '" target="_blank" rel="noopener">Preview</a>' : "");
        bar.appendChild(ok);
      } else {
        actionNote(bar, "Push failed: " + ((res && res.error) || "unknown error"));
      }
    }).catch(function (e) {
      spin(btn, false, "Push to WordPress");
      actionNote(bar, "Push failed: " + (e.message || e));
    });
  }

  function fixMeta(auditData, btn, bar) {
    spin(btn, true);
    fetch("/api/metapush/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auditData: auditData })
    }).then(function (r) { return r.json(); }).then(function (res) {
      spin(btn, false, "Fix Meta Tags");
      if (res && res.ok) {
        btn.disabled = true;
        var sum = document.createElement("div");
        sum.style.cssText = "margin-top:8px;width:100%";
        sum.innerHTML = '<div class="note">Updated ' + res.updated + " · skipped " + res.skipped + " · failed " + res.failed + "</div>";
        var rows = (res.entries || []).slice(0, 12).map(function (e) {
          var after = e.after ? (" → “" + esc(e.after.title) + "”") : "";
          return "<li>" + esc(e.url) + " (" + esc(e.status) + ")" + after + "</li>";
        }).join("");
        if (rows) sum.innerHTML += "<ul>" + rows + "</ul>";
        bar.appendChild(sum);
      } else {
        actionNote(bar, "Meta push failed: " + ((res && res.error) || "unknown error"));
      }
    }).catch(function (e) {
      spin(btn, false, "Fix Meta Tags");
      actionNote(bar, "Meta push failed: " + (e.message || e));
    });
  }

  /* ---------- SEND FLOW ---------- */
  var busy = false;

  // Core: send `text` to the backend under `useMode`, render the reply.
  function run(text, btnEl, modeOverride) {
    if (busy) return;
    text = (text || "").trim();
    var useMode = modeOverride || mode;
    // Intelligence and the opportunity loop need no text; everything else does.
    if (!text && useMode !== "intel" && useMode !== "opportunity") return;

    // Pick the button to spin BEFORE we switch views (start uses #send, chat uses #send2).
    var activeBtn = btnEl || document.getElementById(chatting ? "send2" : "send");
    if (!chatting) { app.classList.add("chatting"); chatting = true; }
    addUser(text || "Pull the latest SEO intelligence report");

    // Full Report opens a standalone, printable page (and offers the PDF) rather
    // than rendering chat blocks — a deep crawl can take a minute.
    if (useMode === "report") {
      var dom = text.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      var htmlUrl = "/api/report?url=" + encodeURIComponent(text);
      var pdfUrl = htmlUrl + "&format=pdf";
      try { window.open(htmlUrl, "_blank"); } catch (e) {}
      addSage(
        "<p>Building a full audit report for <b>" + esc(dom) + "</b> — it opens in a new tab. " +
        "A deep crawl plus Lighthouse and authority data can take a minute.</p>" +
        '<div class="chips"><a class="chip" href="' + esc(htmlUrl) + '" target="_blank" rel="noopener">Open report</a>' +
        '<a class="chip" href="' + esc(pdfUrl) + '">⬇ Download PDF</a></div>'
      );
      var di0 = document.getElementById("input2"); if (di0) di0.focus();
      return;
    }

    busy = true;
    var label = activeBtn.querySelector("span"); var orig = label ? label.textContent : "";
    activeBtn.disabled = true; if (label) label.innerHTML = '<span class="spinner"></span>';
    addTyping();

    fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: useMode, text: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.report) { addSage(renderReport(data.report)); attachReportActions(data.report); }
        else addSage('<div class="note">Unexpected response from server.</div>');
      })
      .catch(function (err) {
        addSage('<div class="note">Request failed: ' + esc(err.message || err) + "</div>");
      })
      .then(function () {
        busy = false; activeBtn.disabled = false; if (label) label.textContent = orig;
        var di = document.getElementById("input2"); if (di) di.focus();
      });
  }

  function send(inputEl, btnEl) {
    var text = inputEl.value.trim();
    if (!text && mode !== "intel" && mode !== "opportunity") { inputEl.focus(); return; }
    run(text, btnEl);
    inputEl.value = ""; grow(inputEl);
  }

  function wire(inputEl, btnEl) {
    inputEl.addEventListener("input", function () { grow(inputEl); });
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(inputEl, btnEl); }
    });
    btnEl.addEventListener("click", function () { send(inputEl, btnEl); });
  }
  wire(document.getElementById("input"), document.getElementById("send"));
  wire(document.getElementById("input2"), document.getElementById("send2"));

  /* ---------- INTRO QUICK ACTIONS ---------- */
  var cando = document.getElementById("whatCanYouDo");
  if (cando) cando.addEventListener("click", function () { run("What can you do?", null, "chat"); });

  syncTool();

  /* ---------- STATUS ---------- */
  fetch("/api/status").then(function (r) { return r.json(); }).then(function (s) {
    SYS = s || {};
    var line = document.getElementById("statusLine");
    if (s && s.llm && !s.llm.configured) {
      line.innerHTML = "⚠ LLM not configured — add a key to .env to activate S.A.G.E";
    }
    // auth: show the logged-in user + a log-out link
    if (s && s.auth && s.auth.enabled) {
      var chip = document.getElementById("userChip");
      var out = document.getElementById("logoutBtn");
      if (chip && s.auth.user) { chip.textContent = s.auth.user; chip.hidden = false; }
      if (out) out.hidden = false;
    }
  }).catch(function () {});
})();
