(function () {
  "use strict";
  var root = document.documentElement;

  /* ---------- THEME ---------- */
  var toggle = document.getElementById("themeToggle");
  try { var saved = localStorage.getItem("scribe-theme"); if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved); } catch (e) {}
  function currentTheme() { var t = root.getAttribute("data-theme"); if (t) return t; return window.matchMedia && window.matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"; }
  toggle.addEventListener("click", function () { var next = currentTheme() === "dark" ? "light" : "dark"; root.setAttribute("data-theme", next); try { localStorage.setItem("scribe-theme", next); } catch (e) {} });

  /* ---------- TOOLS ---------- */
  var TOOLS = [
    { mode: "chat",        glyph: "💬", name: "Auto",               desc: "Chat & auto-route to the right tool" },
    { mode: "research",    glyph: "🔎", name: "Keyword Research",     desc: "Top-ranking blogs + measured avg word count" },
    { mode: "competitors", glyph: "📊", name: "Competitor Analysis", desc: "Deep scrape of the top-ranking pages" },
    { mode: "gap",         glyph: "🕳️", name: "Content Gaps",        desc: "Openings vs competitors + your site" },
    { mode: "keywords",    glyph: "🧩", name: "Keyword Clusters",    desc: "Similar keywords, clustered to blog topics" },
    { mode: "brand",       glyph: "🎨", name: "Brand Voice",         desc: "Extract your voice & tone from your site" },
    { mode: "evidence",    glyph: "🔬", name: "Gather Evidence",     desc: "Verify real stats/quotes before writing" },
    { mode: "write",       glyph: "✍️", name: "Write Draft",         desc: "Evidence-constrained draft in your voice" },
    { mode: "factcheck",   glyph: "✅", name: "Fact-Check",          desc: "Verify claims against live search" },
    { mode: "aicheck",     glyph: "🤖", name: "AI-Pattern Scan",     desc: "Detect AI-writing tells & humanize" },
    { mode: "eeat",        glyph: "🏅", name: "E-E-A-T Score",       desc: "Score content on E-E-A-T (your params)" },
    { mode: "audit",       glyph: "🧷", name: "Self-Audit",          desc: "2nd-pass checklist: stats, quotes, placeholders" },
    { mode: "gate",        glyph: "🚦", name: "Publish Gate",        desc: "Autonomous verify-and-fix → READY / NEEDS_HUMAN" },
    { mode: "workflow",    glyph: "⚡", name: "Full Workflow",       desc: "Evidence → write → gate → publish-ready" }
  ];
  var TOOL_BY_MODE = {}; TOOLS.forEach(function (t) { TOOL_BY_MODE[t.mode] = t; });

  var PLACEHOLDERS = {
    chat: "Say hi, ask what I can do, or give a command like ‘research best running shoes’…",
    research: "Enter a keyword, e.g. ‘best running shoes for flat feet’…",
    competitors: "Keyword to analyse the top-ranking pages for…",
    gap: "Keyword to find content gaps for (add your site in Brief)…",
    keywords: "Seed keyword to expand & cluster…",
    brand: "Your website URL (or add it in Brief), e.g. yourbrand.com…",
    evidence: "Keyword to gather + verify real evidence for (before writing)…",
    write: "Keyword to write a draft about (add your site in Brief for voice)…",
    factcheck: "Keyword of a saved draft — or paste content here to fact-check…",
    aicheck: "Keyword of a saved draft — or paste content to scan for AI patterns…",
    eeat: "Keyword of a saved draft — or paste content (E-E-A-T params in Brief)…",
    audit: "Keyword of a saved draft — or paste content to run the self-audit checklist…",
    gate: "Keyword of a saved draft — run the autonomous verify-and-fix gate…",
    workflow: "Keyword to run the whole workflow (add your site URL in Brief)…"
  };

  var mode = "chat";

  /* ---------- COMPOSER BUILD (from template, into intro + dock) ---------- */
  var tpl = document.getElementById("composerTpl");
  var composers = [];

  function buildToolMenu(menuEl) {
    menuEl.innerHTML = TOOLS.map(function (t) {
      return '<button type="button" class="toolopt" role="menuitem" data-mode="' + t.mode + '">' +
        '<span class="oglyph">' + t.glyph + '</span>' +
        '<span class="obody"><span class="oname">' + t.name + '</span><span class="odesc">' + t.desc + '</span></span>' +
        '<svg class="ocheck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></button>';
    }).join("");
  }

  function makeComposer(host, dock) {
    var node = tpl.content.firstElementChild.cloneNode(true);
    host.appendChild(node);
    if (dock) node.classList.add("dock-composer");
    var c = {
      el: node,
      input: node.querySelector(".c-input"),
      send: node.querySelector(".c-send"),
      site: node.querySelector(".brief-site"),
      extra: node.querySelector(".brief-extra"),
      brief: node.querySelector(".brief"),
      briefToggle: node.querySelector(".brief-toggle"),
      picker: node.querySelector(".toolpicker"),
      toolbtn: node.querySelector(".toolbtn"),
      menu: node.querySelector(".toolmenu")
    };
    buildToolMenu(c.menu);
    c.input.addEventListener("input", function () { grow(c.input); });
    c.input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(c); } });
    c.send.addEventListener("click", function () { doSend(c); });
    c.briefToggle.addEventListener("click", function () { c.brief.hidden = !c.brief.hidden; c.briefToggle.classList.toggle("on", !c.brief.hidden); });
    c.toolbtn.addEventListener("click", function (e) { e.stopPropagation(); toggleMenu(c); });
    c.menu.addEventListener("click", function (e) { var opt = e.target.closest(".toolopt"); if (!opt) return; setMode(opt.getAttribute("data-mode")); closeMenus(); c.input.focus(); });
    composers.push(c);
    return c;
  }

  function toggleMenu(c) { var willOpen = c.menu.hidden; closeMenus(); if (willOpen) { c.menu.hidden = false; c.toolbtn.setAttribute("aria-expanded", "true"); } }
  function closeMenus() { composers.forEach(function (c) { c.menu.hidden = true; c.toolbtn.setAttribute("aria-expanded", "false"); }); }

  function setMode(m) {
    mode = m;
    var t = TOOL_BY_MODE[mode] || TOOL_BY_MODE.chat;
    composers.forEach(function (c) {
      c.picker.querySelector(".toolglyph").textContent = t.glyph;
      c.picker.querySelector(".toollabel").textContent = t.name;
      c.menu.querySelectorAll(".toolopt").forEach(function (o) { o.setAttribute("aria-selected", o.getAttribute("data-mode") === mode ? "true" : "false"); });
      c.input.setAttribute("placeholder", PLACEHOLDERS[mode] || "Message SCRIBE…");
    });
  }

  var introComposer = makeComposer(document.getElementById("composerShell"), false);
  var dockComposer = makeComposer(document.getElementById("dockShell"), true);
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenus(); });
  function grow(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }
  setMode("chat");

  /* ---------- CHAT SCAFFOLD ---------- */
  var app = document.getElementById("app");
  var messages = document.getElementById("messages");
  var chatting = false;
  var SYS = {};
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var avatarMark = '<div class="avatar"><svg viewBox="0 0 32 32" fill="none"><path d="M7 25V7h5l4 11 4-11h5v18h-4V14l-3.4 9h-3.2L11 14v11z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></div>';
  function addUser(text) { var el = document.createElement("div"); el.className = "msg user"; el.innerHTML = '<div class="avatar">Y</div><div class="bubble">' + esc(text).replace(/\n/g, "<br>") + "</div>"; messages.appendChild(el); messages.scrollTop = messages.scrollHeight; }
  function addTyping() { var el = document.createElement("div"); el.className = "msg sage"; el.id = "typing"; el.innerHTML = avatarMark + '<div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>'; messages.appendChild(el); messages.scrollTop = messages.scrollHeight; }
  function addBot(html) { var t = document.getElementById("typing"); if (t) t.remove(); var el = document.createElement("div"); el.className = "msg sage"; el.innerHTML = avatarMark + '<div class="bubble">' + html + "</div>"; messages.appendChild(el); messages.scrollTop = messages.scrollHeight; return el; }

  /* ---------- REPORT RENDERER (same block schema as SAGE/NOVA) ---------- */
  var CHIP_ACTIONS = {
    "analyze competitors": "competitors", "find content gaps": "gap", "expand keywords": "keywords",
    "write draft": "write", "fact-check this draft": "factcheck", "check e-e-a-t": "eeat",
    "check for ai patterns": "aicheck", "brand voice": "brand", "research a cluster keyword": "research",
    "audit this draft": "audit", "run the publish gate": "gate", "gather evidence": "evidence"
  };

  function renderReport(report) {
    var kw = (report.data && report.data.keyword) || "";
    var h = '<div class="r-head"><span class="r-tag">' + esc(report.tag || "SCRIBE") + "</span>";
    if (report.title) h += '<span class="r-title">' + esc(report.title) + "</span>";
    h += "</div>";
    (report.blocks || []).forEach(function (blk) { h += renderBlock(blk, kw); });
    return h;
  }
  function renderBlock(blk, kw) {
    switch (blk.type) {
      case "p": return "<p>" + esc(blk.text) + "</p>";
      case "note": return '<div class="note">' + esc(blk.text) + "</div>";
      case "list": return "<ul>" + (blk.items || []).map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>";
      case "chips":
        return '<div class="chips">' + (blk.items || []).map(function (i) {
          var action = kw && CHIP_ACTIONS[String(i).toLowerCase()];
          if (action) return '<button class="chip act" data-mode="' + action + '" data-kw="' + esc(kw) + '">' + esc(i) + "</button>";
          return '<span class="chip">' + esc(i) + "</span>";
        }).join("") + "</div>";
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

  function wireChipActions(bubble) {
    bubble.querySelectorAll(".chip.act").forEach(function (chip) {
      chip.addEventListener("click", function () { run(chip.getAttribute("data-kw"), null, chip.getAttribute("data-mode")); });
    });
  }

  /* ---------- SEND FLOW ---------- */
  var busy = false;
  function postJSON(url, body) {
    // A deep-research + write run can take several minutes on a free/rate-limited
    // LLM tier, so allow a long ceiling (25 min) before giving up, rather than
    // hanging forever. AbortController gives a clean, explainable timeout.
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 25 * 60 * 1000) : null;
    var opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts)
      .then(function (r) { return r.json(); })
      .then(function (d) { if (timer) clearTimeout(timer); return d; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  function activeComposer() { return chatting ? dockComposer : introComposer; }

  function doSend(c) {
    var text = c.input.value.trim();
    if (!text && mode !== "workflow") { c.input.focus(); return; }
    run(text, c, mode);
    c.input.value = ""; grow(c.input);
  }

  function run(text, c, useMode) {
    if (busy) return;
    text = (text || "").trim();
    useMode = useMode || mode;
    c = c || activeComposer();
    var siteUrl = (c.site && c.site.value.trim()) || "";
    var extra = (c.extra && c.extra.value.trim()) || "";

    if (!chatting) { app.classList.add("chatting"); chatting = true; }
    addUser(text || TOOL_BY_MODE[useMode].name);

    busy = true;
    var label = c.send.querySelector("span"); var orig = label ? label.textContent : "";
    c.send.disabled = true; if (label) label.innerHTML = '<span class="spinner"></span>';
    addTyping();

    postJSON("/api/ask", { mode: useMode, text: text, siteUrl: siteUrl, extraInfo: extra, params: extra })
      .then(function (data) {
        if (data && data.report) { var el = addBot(renderReport(data.report)); wireChipActions(el.querySelector(".bubble")); refreshLibrary(); }
        else addBot('<div class="note">Unexpected response from server.</div>');
      })
      .catch(function (err) {
        var msg = (err && err.message) || String(err);
        if (err && err.name === "AbortError") {
          msg = "The run took longer than 25 minutes and was stopped. Deep research on a free LLM tier can be very slow — try a shorter/more specific keyword, or use a faster LLM tier. Your project is saved; reopen it from the library to continue.";
        } else if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
          msg = "Could not reach the server (the request got no response). The server may have restarted, or the run outlasted the connection. Make sure SCRIBE is running (npm start), then try again — the work so far is saved to your project library.";
        }
        addBot('<div class="note">' + esc(msg) + "</div>");
      })
      .then(function () { busy = false; c.send.disabled = false; if (label) label.textContent = orig; dockComposer.input.focus(); });
  }

  var cando = document.getElementById("whatCanYouDo");
  if (cando) cando.addEventListener("click", function () { run("What can you do?", introComposer, "chat"); });

  /* ---------- SIDEBAR (content library) ---------- */
  var STATUS_LABEL = { "new": "New", researched: "Researched", analyzed: "Analyzed", drafted: "Drafted", reviewed: "Reviewed" };
  var STATUS_ORDER = ["new", "researched", "analyzed", "drafted", "reviewed"];

  function renderLegend(projects) {
    var counts = {}; projects.forEach(function (p) { counts[p.status] = (counts[p.status] || 0) + 1; });
    var el = document.getElementById("sideLegend");
    el.innerHTML = STATUS_ORDER.filter(function (s) { return counts[s] > 0; }).map(function (s) {
      return '<span class="leg"><span class="swatch st-' + s + '"></span>' + STATUS_LABEL[s] + " " + counts[s] + "</span>";
    }).join("") || '<span class="leg" style="color:var(--muted-2)">Empty</span>';
  }
  function domainOf(u) { try { return new URL(/^https?:/.test(u) ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch (e) { return u || ""; } }
  function renderLibrary(projects) {
    var list = document.getElementById("sideList");
    document.getElementById("sideCount").textContent = projects.length;
    renderLegend(projects);
    if (!projects.length) { list.innerHTML = '<div class="side-empty">No projects yet. Research a keyword to start one.</div>'; return; }
    list.innerHTML = projects.map(function (p) {
      var meta = (p.avgWordCount != null ? p.avgWordCount.toLocaleString() + "w avg" : "—") + (p.hasDraft ? " · draft ✓" : "");
      return '<button class="prow" data-key="' + esc(p.key) + '">' +
        '<div class="prow-top"><span class="prow-name">' + esc(p.keyword) + '</span>' +
        '<span class="prow-stage st-' + p.status + '">' + esc(STATUS_LABEL[p.status] || p.status) + '</span></div>' +
        '<div class="prow-meta"><span class="dom">' + esc(p.siteUrl ? domainOf(p.siteUrl) : (p.topBlogs + " results")) + '</span><span class="days">' + esc(meta) + '</span></div>' +
        "</button>";
    }).join("");
    list.querySelectorAll(".prow").forEach(function (row) { row.addEventListener("click", function () { openProject(row.getAttribute("data-key")); }); });
  }
  function openProject(key) {
    if (!chatting) { app.classList.add("chatting"); chatting = true; }
    addUser(key);
    addTyping();
    fetch("/api/projects/" + encodeURIComponent(key)).then(function (r) { return r.json(); }).then(function (res) {
      if (res.ok && res.report) { var el = addBot(renderReport(res.report)); wireChipActions(el.querySelector(".bubble")); }
      else addBot('<div class="note">Could not load that project.</div>');
    }).catch(function () { addBot('<div class="note">Could not load that project.</div>'); });
  }
  function refreshLibrary() { fetch("/api/projects").then(function (r) { return r.json(); }).then(function (d) { renderLibrary((d && d.projects) || []); }).catch(function () {}); }
  document.getElementById("sideRefresh").addEventListener("click", refreshLibrary);
  document.getElementById("sideToggle").addEventListener("click", function () { app.classList.toggle("side-collapsed"); });
  if (window.matchMedia && window.matchMedia("(max-width:900px)").matches) app.classList.add("side-collapsed");
  refreshLibrary();
  setInterval(refreshLibrary, 60000);

  /* ---------- STATUS ---------- */
  fetch("/api/status").then(function (r) { return r.json(); }).then(function (s) {
    SYS = s || {};
    var line = document.getElementById("statusLine");
    if (s && s.llm && !s.llm.configured) line.innerHTML = "⚠ LLM not configured — add a key to .env to activate SCRIBE";
    else if (s && s.serp && !s.serp.enabled) line.innerHTML = "⚠ Search disabled — set SERP_PROVIDER (tavily) + TAVILY_API_KEY for live research";
    else line.textContent = "SCRIBE — content automation on real data";
    if (s && s.auth && s.auth.enabled) {
      var chip = document.getElementById("userChip"); var out = document.getElementById("logoutBtn");
      if (chip && s.auth.user) { chip.textContent = s.auth.user; chip.hidden = false; }
      if (out) out.hidden = false;
    }
  }).catch(function () {});
})();
