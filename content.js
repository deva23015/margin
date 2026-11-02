(() => {
  if (window.__margin) return;
  window.__margin = true;

  const MAX_CONTROLS = 70;
  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=tab]", "[role=menuitem]", "[role=checkbox]", "[role=switch]",
    "[role=combobox]", "[role=link]", "[role=option]", "[onclick]", "[contenteditable=true]",
  ].join(",");
  const SECTION_SELECTOR =
    "form,nav,header,footer,aside,main,dialog,[role=dialog],[role=navigation],[role=toolbar],[role=search]";
  const TEXT_INPUT = /^(text|search|url|tel|email)$/i;

  let host, shadow, hl, toolbar, card, panel, panelBody, panelBadge;
  let controls = [];
  let hoverEl = null;
  let rafId = 0;
  let lastSelection = "";
  let askToken = 0;

  /* ---------- small helpers ---------- */

  const clean = (s, n = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const ICONS = {
    translate: "M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6",
    explain: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
    listen: "M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
    copy: "M8 8h12v12H8zM4 16V4h12",
    close: "M18 6 6 18M6 6l12 12",
    stop: "M6 6h12v12H6z",
  };
  function icon(name, size = 15) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
  }
  function iconButton(name, label, cls = "btn") {
    const b = h("button", cls);
    b.type = "button";
    b.innerHTML = icon(name) + (label ? `<span>${label}</span>` : "");
    if (!label) b.setAttribute("aria-hidden", "false");
    return b;
  }

  const store = () => chrome.storage.local.get({ preferredLanguage: "en-US" });

  /* ---------- selection ---------- */

  function activeTextControl() {
    const a = document.activeElement;
    if (!a) return null;
    if (a.tagName === "TEXTAREA") return a;
    if (a.tagName === "INPUT" && TEXT_INPUT.test(a.type)) return a;
    return null;
  }

  function selectedText() {
    const c = activeTextControl();
    if (c) {
      try {
        const s = c.value.slice(c.selectionStart, c.selectionEnd).trim();
        if (s) return s;
      } catch {}
    }
    return (window.getSelection()?.toString() || "").trim();
  }

  function selectionRect() {
    const c = activeTextControl();
    if (c && c.selectionStart !== c.selectionEnd) return c.getBoundingClientRect();
    const sel = window.getSelection();
    return sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
  }

  /* ---------- speech ---------- */

  function guessLang(text) {
    if (/[\u0900-\u097F]/.test(text)) return "hi-IN";
    if (/[\u0980-\u09FF]/.test(text)) return "bn-IN";
    if (/[\u0B80-\u0BFF]/.test(text)) return "ta-IN";
    if (/[\u0C00-\u0C7F]/.test(text)) return "te-IN";
    if (/[\u0600-\u06FF]/.test(text)) return "ur-PK";
    return document.documentElement.lang || "en-US";
  }

  function speak(text, lang) {
    if (!text || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || guessLang(text);
    u.rate = 0.92;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  /* ---------- page reading (for the page guide) ---------- */

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }

  // Anything a person can type into is never read, so it can't leak into a prompt.
  const isEditable = (el) =>
    /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;

  function labelOf(el) {
    let l = el.getAttribute("aria-label") || "";
    const by = el.getAttribute("aria-labelledby");
    if (!l && by) l = by.split(" ").map((id) => document.getElementById(id)?.textContent || "").join(" ");
    if (!l && el.labels && el.labels.length) l = el.labels[0].textContent;
    if (!l && el.tagName === "INPUT" && /^(button|submit|reset)$/.test(el.type || "")) l = el.value;
    if (!l && !isEditable(el)) l = el.innerText || "";
    if (!l) l = el.title || el.placeholder || el.alt || "";
    if (!l && !isEditable(el)) l = el.querySelector("img[alt]")?.alt || el.querySelector("svg title")?.textContent || "";
    if (!l) l = el.getAttribute("name") || "";
    return clean(l);
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    if (role === "button") return "Button";
    if (tag === "a" || role === "link") return "Link";
    if (tag === "select" || role === "combobox") return "Dropdown";
    if (tag === "textarea" || el.isContentEditable) return "Text field";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "Checkbox";
      if (t === "radio") return "Option";
      if (/^(submit|button|reset|image)$/.test(t)) return "Button";
      if (t === "file") return "File picker";
      if (t === "range") return "Slider";
      return "Field";
    }
    if (role === "tab") return "Tab";
    if (role === "switch") return "Switch";
    if (role === "checkbox") return "Checkbox";
    if (role === "menuitem") return "Menu item";
    return "Button";
  }

  function sectionOf(el) {
    const s = el.parentElement?.closest(SECTION_SELECTOR);
    if (!s) return "";
    return clean(s.getAttribute("aria-label") || s.getAttribute("role") || s.tagName.toLowerCase(), 30);
  }

  function visibleText(root, max) {
    let out = "";
    let seen = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (p.closest("script,style,noscript,textarea,select,[contenteditable]")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode() && out.length < max && seen++ < 2500) {
      if (isVisible(walker.currentNode.parentElement)) out += walker.currentNode.nodeValue.trim() + " ";
    }
    return clean(out, max);
  }

  function collect(selection) {
    const modal = [...document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]")]
      .find((el) => isVisible(el));
    const root = modal || document;
    controls = [];
    for (const el of root.querySelectorAll(SELECTOR)) {
      if (controls.length >= MAX_CONTROLS) break;
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      const kind = kindOf(el);
      if (!label && kind === "Link") continue;
      controls.push({
        id: controls.length,
        el,
        kind,
        label,
        section: sectionOf(el),
        disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
        required: !!el.required || el.getAttribute("aria-required") === "true",
        type: el.type || "",
        expanded: el.getAttribute("aria-expanded"),
        href: el.tagName === "A" ? clean(el.getAttribute("href"), 60) : undefined,
        opensNewTab: el.target === "_blank" || undefined,
      });
    }
    const headings = [...document.querySelectorAll("h1,h2,h3")]
      .filter(isVisible).slice(0, 15).map((n) => clean(n.textContent, 80));
    return {
      page: {
        title: document.title,
        url: location.origin + location.pathname,
        headings,
        textExcerpt: visibleText(modal || document.body, 1500),
      },
      dialogOpen: !!modal,
      selection: clean(selection, 400),
      controls: controls.map(({ el, ...rest }) =>
        Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== "" && v !== undefined && v !== false && v !== null))),
    };
  }

  /* ---------- offline fallback ---------- */

  const RULES = [
    [/\blog ?out\b|\bsign ?out\b/i, "Signs you out of your account."],
    [/\blog ?in\b|\bsign ?in\b/i, "Signs you in. Enter your email or username and password first."],
    [/sign ?up|register|create (an )?account|\bjoin\b/i, "Starts creating a new account."],
    [/delete|remove|discard|erase|clear all/i, "Removes something. This may not be undoable.", "Check what will be removed before you confirm."],
    [/\bbuy\b|checkout|\bpay\b|purchase|place order|subscribe|upgrade/i, "Part of a purchase. This can charge money.", "Review the price and your payment details first."],
    [/add to (cart|bag|basket)|\bcart\b|\bbasket\b/i, "Adds an item to your order, or shows what is in it. Nothing is charged yet."],
    [/search|\bfind\b|\bgo$/i, "Searches using what you typed in the nearby field."],
    [/cancel|\bclose\b|dismiss|\bback\b|no thanks|×|^x$/i, "Closes this or goes back without saving your changes."],
    [/submit|\bsend\b|\bsave\b|apply|confirm|continue|\bnext\b|\bdone\b|finish|\bok$/i, "Saves or sends what you entered, then moves on. Check your details first."],
    [/download|export/i, "Saves a copy to your device."],
    [/upload|attach|browse|choose file/i, "Lets you pick a file from your device."],
    [/filter|\bsort\b|refine/i, "Changes which items are shown or in what order."],
    [/\bmenu\b|\bmore\b|options|settings|preferences|⋮|\.\.\./i, "Opens more choices or settings."],
    [/\bhelp\b|support|\bfaq\b|contact/i, "Shows help or ways to reach the site."],
    [/accept|\bagree\b|\ballow\b|got it/i, "Agrees to what's described, such as cookies or terms."],
    [/reject|decline|\bdeny\b/i, "Declines what's described, such as optional cookies."],
  ];

  function describeLocal(c) {
    for (const [re, text, caution] of RULES) if (re.test(c.label)) return { explanation: text, caution };
    const req = c.required ? " Required." : "";
    switch (c.kind) {
      case "Link": return { explanation: "Takes you to another page" + (c.opensNewTab ? " (opens in a new tab)." : ".") };
      case "Dropdown": return { explanation: "Pick one choice from a list." + req };
      case "Text field": return { explanation: "Type here." + (c.label ? ` It's for: ${c.label}.` : "") + req };
      case "Field": return { explanation: (c.type === "password" ? "Enter your password. It shows as dots." : c.type === "email" ? "Enter an email address." : "Type your answer here.") + req };
      case "Checkbox": case "Switch": case "Option": return { explanation: "Turn this choice on or off." + req };
      case "File picker": return { explanation: "Choose a file from your device." + req };
      case "Tab": return { explanation: "Switches the view to this section without leaving the page." };
      case "Menu item": return { explanation: "An entry in an open menu." };
      default: return { explanation: c.expanded != null ? "Shows or hides more content." : "Runs an action on this page." };
    }
  }

  function localGuide(data) {
    const count = (k) => data.controls.filter((c) => c.kind === k).length;
    const fields = data.controls.filter((c) => /field|dropdown|checkbox|option|picker/i.test(c.kind)).length;
    const steps = [];
    if (data.dialogOpen) steps.push({ text: "A pop-up is open. Read it, then choose its main button or close it." });
    if (fields) steps.push({ text: `Fill in the ${fields} form field${fields > 1 ? "s" : ""} on this page. Required ones must be completed.` });
    steps.push({ text: "Use the main button, usually the last one below the fields, to save or continue." });
    steps.push({ text: "Hover over an item below to see where it sits on the page." });
    const picked = data.controls.filter((c) => c.label || c.kind !== "Link").slice(0, 30);
    return {
      summary: `“${document.title || "This page"}” has ${count("Button")} buttons, ${count("Link")} links and ${fields} form fields.`,
      steps,
      controls: picked.map((c) => ({ id: c.id, ...describeLocal(c) })),
    };
  }

  /* ---------- overlay shell ---------- */

  const CSS = `
  :host{all:initial;
    --paper:#fbfcfb;--ink:#14202b;--mute:#5b6a75;--line:#d9dfde;--teal:#0e5e6f;--teal-fg:#fff;
    --soft:#eef3f2;--mark:#ffe066;--warn-bg:#fff1d0;--warn-fg:#6b4300;--shadow:0 10px 32px rgba(10,30,40,.18)}
  @media (prefers-color-scheme:dark){:host{
    --paper:#16222b;--ink:#eaf0f1;--mute:#9db0b8;--line:#2b3b46;--teal:#5fc0d3;--teal-fg:#08222a;
    --soft:#1e2d37;--warn-bg:#3a2d12;--warn-fg:#f3cf86;--shadow:0 10px 32px rgba(0,0,0,.5)}}
  *{box-sizing:border-box}
  button{font:inherit;color:inherit;cursor:pointer}
  button:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
  .ui{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}

  .toolbar{position:fixed;display:flex;gap:2px;padding:4px;background:var(--ink);border-radius:10px;box-shadow:var(--shadow)}
  .tb{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:7px;padding:7px 10px;background:transparent;color:var(--paper);font-size:13px;font-weight:550}
  .tb:hover{background:rgba(255,255,255,.14)}
  .tb svg{opacity:.9}

  .card,.panel{position:fixed;background:var(--paper);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
  .card{right:16px;bottom:16px;width:340px;max-width:calc(100vw - 32px);padding:14px 16px 12px}
  .card header,.panel header{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .card h2{margin:0;font-size:13px;font-weight:650;color:var(--mute)}
  .x{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--mute)}
  .x:hover{background:var(--soft);color:var(--ink)}
  .quote{margin:8px 0 10px;padding:0;color:var(--mute);font-size:12.5px;line-height:1.45;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .quote span{background:linear-gradient(transparent 55%,color-mix(in srgb,var(--mark) 75%,transparent) 55%)}
  .mnote{margin:10px 0 0;font-size:12px;color:var(--mute)}
  .out{white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.55;max-height:46vh;overflow:auto}
  .foot{display:flex;gap:6px;margin-top:12px}
  .btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:transparent;border-radius:7px;padding:6px 10px;font-size:12.5px;font-weight:550}
  .btn:hover{background:var(--soft)}

  .panel{top:16px;right:16px;width:384px;max-width:calc(100vw - 24px);max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden}
  .panel>header{padding:12px 12px 12px 16px;border-bottom:1px solid var(--line);cursor:grab;touch-action:none}
  .panel>header:active{cursor:grabbing}
  .brand{display:flex;align-items:baseline;gap:8px}
  .brand strong{font-size:15px;letter-spacing:-.01em}
  .brand span{font-size:12px;color:var(--mute)}
  .badge{margin-left:auto;margin-right:4px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:99px;background:var(--soft);color:var(--mute)}
  .badge.ai{background:var(--mark);color:#3d3200}
  .pbody{padding:16px;overflow:auto}
  .summary{margin:0 0 16px;font-size:16px;line-height:1.5;font-weight:500}
  .note{margin:0 0 14px;padding:9px 12px;border-radius:8px;background:var(--soft);color:var(--mute);font-size:13px}
  .sel{margin:0 0 16px;padding:9px 12px;border-left:3px solid var(--mark);background:var(--soft);border-radius:0 8px 8px 0;font-size:13.5px}
  .pbody h3{margin:18px 0 8px;font-size:13px;font-weight:650;color:var(--mute)}
  ol{margin:0;padding:0;list-style:none;counter-reset:s}
  ol li{counter-increment:s;position:relative;padding:3px 0 3px 30px;margin-bottom:4px;border-radius:6px}
  ol li::before{content:counter(s);position:absolute;left:0;top:4px;width:21px;height:21px;border-radius:50%;
    background:var(--soft);color:var(--mute);font-size:12px;font-weight:650;display:grid;place-items:center}
  ol li.link{cursor:default}
  ol li.link:hover{background:var(--soft)}
  ol li.link:hover::before{background:var(--mark);color:#3d3200}
  .list{display:flex;flex-direction:column;gap:6px}
  .item{width:100%;text-align:left;border:1px solid var(--line);background:transparent;border-radius:9px;padding:9px 11px}
  .item:hover,.item:focus-visible{background:var(--soft);border-color:var(--teal)}
  .name{display:flex;justify-content:space-between;gap:8px;font-weight:650;font-size:13.5px}
  .kind{font-weight:500;font-size:12px;color:var(--mute);white-space:nowrap}
  .exp{margin-top:2px;font-size:13px;color:var(--mute)}
  .warn{margin-top:6px;padding:5px 8px;border-radius:6px;background:var(--warn-bg);color:var(--warn-fg);font-size:12.5px}
  .load{display:flex;align-items:center;gap:10px;padding:10px 0;color:var(--mute)}
  .spin{width:15px;height:15px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--teal);animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.spin{animation-duration:2.5s}}
  .hl{position:fixed;pointer-events:none;display:none;border-radius:5px;background:rgba(255,224,102,.38);
    outline:2px solid #e0b800;box-shadow:0 0 0 4px rgba(255,224,102,.28)}
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    toolbar = card = panel = null;
    host = document.createElement("div");
    host.id = "margin-host";
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    hl = h("div", "hl");
    shadow.append(style, hl);
    document.documentElement.append(host);
  }


  /* ---------- selection toolbar ---------- */

  function removeToolbar() {
    toolbar?.remove();
    toolbar = null;
  }

  function showToolbar(text) {
    removeToolbar();
    const rect = selectionRect();
    if (!rect || (!rect.width && !rect.height)) return;
    ensureHost();
    lastSelection = text;
    toolbar = h("div", "ui toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Margin");
    for (const [key, label] of [["translate", "Translate"], ["explain", "Explain"], ["listen", "Listen"]]) {
      const b = iconButton(key, label, "tb");
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection alive
      b.addEventListener("click", (e) => { e.stopPropagation(); runAction(key, text); });
      toolbar.append(b);
    }
    shadow.append(toolbar);
    const tw = toolbar.offsetWidth, th = toolbar.offsetHeight;
    let top = rect.top - th - 10;
    if (top < 8) top = rect.bottom + 10;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - tw - 8);
    toolbar.style.top = `${top}px`;
    toolbar.style.left = `${left}px`;
  }

  /* ---------- result card ---------- */

  function closeCard() {
    askToken++;
    card?.remove();
    card = null;
  }

  function openCard(title, original) {
    closeCard();
    ensureHost();
    card = h("section", "ui card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", title);
    const head = h("header");
    head.append(h("h2", "", title));
    const x = iconButton("close", "", "x");
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", closeCard);
    head.append(x);
    card.append(head);
    if (original) {
      const q = h("p", "quote");
      q.append(h("span", "", clean(original, 160)));
      card.append(q);
    }
    const out = h("div", "out");
    const foot = h("div", "foot");
    card.append(out, foot);
    shadow.append(card);
    return { out, foot };
  }

  function setLoading(out, text) {
    const l = h("div", "load");
    l.append(h("div", "spin"), h("span", "", text));
    out.replaceChildren(l);
  }

  function resultButtons(foot, text, lang) {
    const listen = iconButton("listen", "Listen");
    listen.addEventListener("click", () => speak(text, lang));
    const copy = iconButton("copy", "Copy");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(text); copy.lastChild.textContent = "Copied"; }
      catch { copy.lastChild.textContent = "Copy failed"; }
      setTimeout(() => { copy.lastChild.textContent = "Copy"; }, 1500);
    });
    foot.append(listen, copy);
  }

  function runAction(action, text) {
    removeToolbar();
    if (action === "listen") {
      const { out, foot } = openCard("Reading aloud", text);
      out.textContent = "Playing the selected text.";
      const stop = iconButton("stop", "Stop");
      stop.addEventListener("click", () => { speechSynthesis.cancel(); closeCard(); });
      foot.append(stop);
      speak(text);
      return;
    }
    runAsk(action, text);
  }

  async function runAsk(task, text) {
    const { out, foot } = openCard(task === "translate" ? "Translation" : "In plain words", text);
    const mine = askToken;
    setLoading(out, task === "translate" ? "Translating…" : "Working it out…");
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "ASK", task, text, pageTitle: document.title });
    } catch {
      resp = { error: "Margin was updated. Reload this tab and try again." };
    }
    if (mine !== askToken) return; // a newer request replaced this card
    out.replaceChildren();
    if (resp?.ok) {
      out.textContent = resp.text;
      if (resp.note) out.after(h("p", "mnote", resp.note));
      resultButtons(foot, resp.text, (await store()).preferredLanguage);
    } else if (resp?.needsKey) {
      out.textContent = resp.message || "This needs an Anthropic API key. Click the Margin icon in your toolbar, open Settings and paste it in.";
    } else {
      out.textContent = resp?.error || "Something went wrong. Try again.";
    }
  }

  /* ---------- page guide panel ---------- */

  function closePanel() {
    cancelAnimationFrame(rafId);
    hoverEl = null;
    panel?.remove();
    panel = null;
    if (hl) hl.style.display = "none";
  }

  function buildPanel() {
    if (panel?.isConnected) return;
    panel = h("div", "ui panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Margin page guide");
    const head = h("header");
    const brand = h("div", "brand");
    brand.append(h("strong", "", "Margin"), h("span", "", "This page, explained"));
    panelBadge = h("span", "badge");
    const x = iconButton("close", "", "x");
    x.setAttribute("aria-label", "Close page guide");
    x.addEventListener("click", closePanel);
    head.append(brand, panelBadge, x);
    panelBody = h("div", "pbody");
    panel.append(head, panelBody);
    shadow.append(panel);
    makeDraggable(head);
  }

  function makeDraggable(handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect();
      drag = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!drag) return;
      panel.style.right = "auto";
      panel.style.left = Math.max(0, Math.min(innerWidth - 80, ox + e.clientX - sx)) + "px";
      panel.style.top = Math.max(0, Math.min(innerHeight - 40, oy + e.clientY - sy)) + "px";
    });
    const end = () => (drag = false);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /* highlighting */

  function track() {
    if (!hoverEl || !hoverEl.isConnected) { hl.style.display = "none"; rafId = 0; return; }
    const r = hoverEl.getBoundingClientRect();
    Object.assign(hl.style, { display: "block", left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" });
    rafId = requestAnimationFrame(track);
  }
  function focusControl(id) {
    const c = controls[id];
    if (!c || !c.el.isConnected) return;
    c.el.scrollIntoView({ block: "center", behavior: "smooth" });
    hoverEl = c.el;
    cancelAnimationFrame(rafId);
    track();
  }
  function blurControl() {
    hoverEl = null;
    cancelAnimationFrame(rafId);
    if (hl) hl.style.display = "none";
  }

  /* rendering */

  function showLoading() {
    panelBadge.textContent = "";
    panelBadge.className = "badge";
    const l = h("div", "load");
    l.append(h("div", "spin"), h("span", "", "Reading the page…"));
    panelBody.replaceChildren(l);
  }

  function render(guide, data, mode, note) {
    panelBody.replaceChildren();
    panelBadge.textContent = mode === "ai" ? "AI guide" : "Basic guide";
    panelBadge.className = "badge" + (mode === "ai" ? " ai" : "");
    if (note) panelBody.append(h("p", "note", note));
    if (guide.summary) panelBody.append(h("p", "summary", String(guide.summary)));
    if (guide.selection_note && data.selection) {
      const s = h("div", "sel");
      s.append(h("strong", "", "About your selection: "), document.createTextNode(String(guide.selection_note)));
      panelBody.append(s);
    }

    const steps = (Array.isArray(guide.steps) ? guide.steps : []).filter((s) => s && s.text);
    if (steps.length) {
      panelBody.append(h("h3", "", "What to do next"));
      const ol = h("ol");
      for (const s of steps) {
        const li = h("li", "", String(s.text));
        if (Number.isInteger(s.id) && controls[s.id]) {
          li.classList.add("link");
          li.addEventListener("mouseenter", () => focusControl(s.id));
          li.addEventListener("mouseleave", blurControl);
        }
        ol.append(li);
      }
      panelBody.append(ol);
    }

    const items = (Array.isArray(guide.controls) ? guide.controls : []).filter((c) => c && controls[c.id] && c.explanation);
    if (items.length) {
      panelBody.append(h("h3", "", "What the controls do"));
      const list = h("div", "list");
      for (const c of items) {
        const info = controls[c.id];
        const btn = h("button", "item");
        btn.type = "button";
        const name = h("div", "name");
        name.append(h("span", "", info.label || "(unlabeled)"), h("span", "kind", info.kind));
        btn.append(name, h("div", "exp", String(c.explanation)));
        if (c.caution) btn.append(h("div", "warn", "Heads up: " + c.caution));
        btn.addEventListener("mouseenter", () => focusControl(c.id));
        btn.addEventListener("focus", () => focusControl(c.id));
        btn.addEventListener("mouseleave", blurControl);
        btn.addEventListener("blur", blurControl);
        list.append(btn);
      }
      panelBody.append(list);
    }
    if (!steps.length && !items.length) panelBody.append(h("p", "", "No buttons, links or form fields were found on this page."));
  }

  function startGuide(selection) {
    ensureHost();
    buildPanel();
    blurControl();
    showLoading();
    const data = collect(selection);
    const fallback = (note) => render(localGuide(data), data, "offline", note);
    try {
      chrome.runtime.sendMessage({ type: "ANALYZE", payload: data }, (resp) => {
        if (chrome.runtime.lastError || !resp) return fallback("Couldn't reach the AI service, so this is the basic guide.");
        if (resp.ok) return render(resp.result, data, "ai");
        if (resp.needsKey) return fallback("Add an API key in Margin's settings (the toolbar icon) for a full explanation written for this page.");
        fallback(resp.error + " Showing the basic guide instead.");
      });
    } catch {
      fallback("Margin was updated. Reload this tab and try again.");
    }
  }

  /* ---------- events ---------- */

  function maybeShowToolbar() {
    const text = selectedText();
    if (text && text.length < 2000) showToolbar(text);
    else removeToolbar();
  }

  document.addEventListener("mouseup", (e) => {
    if (e.target === host) return;
    setTimeout(maybeShowToolbar, 10);
  });
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey && /^Arrow/.test(e.key)) maybeShowToolbar();
  });
  document.addEventListener("mousedown", (e) => {
    if (e.target !== host) removeToolbar();
  });
  window.addEventListener("scroll", removeToolbar, { passive: true, capture: true });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    removeToolbar();
    if (card) { speechSynthesis.cancel(); closeCard(); }
    else if (panel) closePanel();
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "PING": sendResponse({ pong: true }); break;
      case "GET_SELECTION": sendResponse({ text: selectedText() || lastSelection }); break;
      case "SPEAK": speak(msg.text || selectedText() || lastSelection); sendResponse({ ok: true }); break;
      case "EXPLAIN_PAGE": startGuide(msg.selection || selectedText()); sendResponse({ ok: true }); break;
    }
  });
})();
