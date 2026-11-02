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
  let anchor = null;        // () => rect of the text the card points at
  let pendingAnchor = null; // captured when the toolbar appears, handed to the card
  let cardPlace = null;     // "below" | "above"
  let cardBody = null;
  let cardKind = "";
  let cardObserver = null;

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
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
  }
  function iconButton(name, label, cls = "btn") {
    const b = h("button", cls);
    b.type = "button";
    b.innerHTML = icon(name) + (label ? `<span>${label}</span>` : "");
    if (!label) b.setAttribute("aria-hidden", "false");
    return b;
  }

  const store = () => chrome.storage.local.get({ preferredLanguage: "en-US" });

  const LANGUAGES = [
    ["en-US", "English"], ["hi-IN", "Hindi · हिन्दी"], ["es-ES", "Spanish · Español"],
    ["fr-FR", "French · Français"], ["de-DE", "German · Deutsch"], ["bn-IN", "Bengali · বাংলা"],
    ["ta-IN", "Tamil · தமிழ்"], ["te-IN", "Telugu · తెలుగు"], ["mr-IN", "Marathi · मराठी"], ["ur-PK", "Urdu · اردو"],
  ];

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

  // A live "where is the selection now" function. It keeps working after the selection is lost
  // (clicking the toolbar or the card can clear it) and follows the text as the page scrolls.
  function makeAnchor() {
    const c = activeTextControl();
    if (c && c.selectionStart !== c.selectionEnd) {
      return () => {
        const r = c.getBoundingClientRect();
        const x = r.left + r.width / 2;
        return { top: r.top, bottom: r.bottom, firstX: x, lastX: x };
      };
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0).cloneRange();
    return () => {
      const box = range.getBoundingClientRect();
      const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
      const first = rects[0] || box, last = rects[rects.length - 1] || box;
      return { top: box.top, bottom: box.bottom, firstX: first.left + first.width / 2, lastX: last.left + last.width / 2 };
    };
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
    --ink:#0b0b0f;--paper:#fff;--mute:#2d3240;--line:#0b0b0f;
    --blue:#2b59ff;--pink:#ff4d94;--yellow:#ffd60a;--cyan:#6fe6ff;--green:#19e68c;--orange:#ffb23f;
    --shadow:5px 5px 0 var(--ink)}
  *{box-sizing:border-box}
  button{font:inherit;color:inherit;cursor:pointer}
  button:focus-visible,a:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
  .ui{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}

  /* selection toolbar */
  .toolbar{position:fixed;display:flex;gap:6px;padding:6px;background:var(--paper);border:3px solid var(--ink);border-radius:14px;box-shadow:var(--shadow)}
  .tb{display:inline-flex;align-items:center;gap:6px;border:2px solid var(--ink);border-radius:9px;padding:6px 11px;color:var(--ink);font-size:13px;font-weight:800;transition:transform .08s,box-shadow .08s}
  .tb[data-k=translate]{background:var(--blue);color:#fff}
  .tb[data-k=explain]{background:var(--pink)}
  .tb[data-k=listen]{background:var(--yellow)}
  .tb:hover{transform:translate(-1px,-1px);box-shadow:3px 3px 0 var(--ink)}
  .tb:active{transform:translate(1px,1px);box-shadow:none}

  /* shared surfaces */
  .card,.panel{position:fixed;background:var(--paper);border:3px solid var(--ink);border-radius:16px;box-shadow:var(--shadow)}
  .x{display:grid;place-items:center;width:30px;height:30px;border:2px solid var(--ink);border-radius:8px;background:var(--paper);color:var(--ink);flex:none}
  .x:hover{background:var(--ink);color:var(--paper)}
  .btn{display:inline-flex;align-items:center;gap:6px;border:2px solid var(--ink);background:var(--paper);border-radius:9px;padding:5px 11px;font-size:12.5px;font-weight:800;transition:transform .08s,box-shadow .08s,background .08s}
  .btn:hover{background:var(--green);transform:translate(-1px,-1px);box-shadow:2px 2px 0 var(--ink)}
  .load{display:flex;align-items:center;gap:10px;padding:6px 0;font-weight:700}
  .load.small{font-size:12.5px;margin-top:10px}
  .spin{width:18px;height:18px;border-radius:50%;border:3px solid var(--ink);border-top-color:var(--pink);animation:s .8s linear infinite;flex:none}
  .small .spin{width:14px;height:14px;border-width:2px}
  @keyframes s{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.spin{animation-duration:2.5s}.tb,.btn,.item{transition:none}}

  /* result card, sits next to the selected text */
  .card{--ax:30px;--hdr:var(--yellow);width:372px;max-width:calc(100vw - 20px);display:flex;flex-direction:column;visibility:hidden}
  .card.placed{visibility:visible}
  .card.k-translate{--hdr:var(--blue)}
  .card.k-explain{--hdr:var(--pink)}
  .card.k-listen{--hdr:var(--yellow)}
  .card header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 8px 8px 14px;background:var(--hdr);border-bottom:3px solid var(--ink);border-radius:12px 12px 0 0}
  .card.k-translate header{color:#fff}
  .card h2{margin:0;font-size:13.5px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
  .card::before{content:"";display:none;position:absolute;left:var(--ax);width:16px;height:16px;margin-left:-8px;transform:rotate(45deg)}
  .card.below::before{display:block;top:-11px;background:var(--hdr);border-top:3px solid var(--ink);border-left:3px solid var(--ink)}
  .card.above::before{display:block;bottom:-11px;background:var(--paper);border-bottom:3px solid var(--ink);border-right:3px solid var(--ink)}
  .cbody{padding:12px 14px 14px;overflow:auto;max-height:430px}
  .quote{margin:0 0 10px;font-size:13px;line-height:1.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .quote span{background:var(--yellow);padding:1px 5px;border-radius:4px;font-weight:700;box-decoration-break:clone;-webkit-box-decoration-break:clone}
  .out{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:1.5;font-weight:550}
  .mnote{margin:10px 0 0;font-size:12px;font-weight:600;color:var(--mute)}
  .langrow{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:12.5px;font-weight:800}
  .langrow span{white-space:nowrap}
  .langsel{flex:1;min-width:0;padding:5px 8px;border:2px solid var(--ink);border-radius:9px;background:var(--paper);color:var(--ink);font:inherit;font-weight:700}
  .foot{display:flex;gap:8px;padding:10px 14px 12px;border-top:3px solid var(--ink)}
  .foot:empty{display:none}

  /* wiki meaning + tricky words */
  .sec{margin-top:12px;padding:10px 12px;border:2px solid var(--ink);border-radius:10px;background:var(--cyan)}
  .sec.tricky{background:var(--orange)}
  .sec .tag{display:inline-block;margin-bottom:5px;padding:1px 9px;border-radius:99px;background:var(--ink);color:#fff;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
  .sec .desc{margin-bottom:2px;font-size:12px;font-weight:800}
  .sec p{margin:0 0 4px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.5}
  .sec a{color:var(--ink);font-size:12.5px;font-weight:800;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}
  .words{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
  .words li{font-size:14px;line-height:1.7}
  .words b{background:var(--paper);border:2px solid var(--ink);border-radius:7px;padding:0 6px;margin-right:6px;font-weight:800}

  /* page guide panel */
  .panel{top:16px;right:16px;width:392px;max-width:calc(100vw - 24px);max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden}
  .panel>header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 10px 10px 16px;background:var(--blue);color:#fff;border-bottom:3px solid var(--ink);cursor:grab;touch-action:none}
  .panel>header:active{cursor:grabbing}
  .brand{display:flex;align-items:baseline;gap:8px}
  .brand strong{font-size:18px;font-weight:900;letter-spacing:-.01em}
  .brand span{font-size:12px;font-weight:600;opacity:.92}
  .badge{margin-left:auto;margin-right:4px;font-size:11.5px;font-weight:800;padding:2px 9px;border-radius:99px;background:var(--paper);color:var(--ink);border:2px solid var(--ink)}
  .badge:empty{display:none}
  .badge.ai{background:var(--green)}
  .pbody{padding:16px;overflow:auto}
  .summary{margin:0 0 16px;padding:10px 12px;font-size:15.5px;line-height:1.5;font-weight:650;background:var(--yellow);border:2px solid var(--ink);border-radius:10px}
  .note{margin:0 0 14px;padding:9px 12px;border:2px solid var(--ink);border-radius:10px;background:var(--cyan);color:var(--ink);font-size:13px;font-weight:600}
  .sel{margin:0 0 16px;padding:9px 12px;border:2px solid var(--ink);border-left:7px solid var(--pink);background:#ffe0ee;border-radius:0 10px 10px 0;font-size:13.5px}
  .pbody h3{margin:18px 0 8px;font-size:12px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;color:var(--ink)}
  ol{margin:0;padding:0;list-style:none;counter-reset:s}
  ol li{counter-increment:s;position:relative;padding:3px 0 3px 34px;margin-bottom:4px;border-radius:6px;font-weight:550}
  ol li::before{content:counter(s);position:absolute;left:0;top:3px;width:24px;height:24px;border-radius:50%;
    background:var(--pink);color:var(--ink);border:2px solid var(--ink);font-size:12px;font-weight:900;display:grid;place-items:center}
  ol li.link{cursor:default}
  ol li.link:hover{background:var(--yellow)}
  ol li.link:hover::before{background:var(--paper)}
  .list{display:flex;flex-direction:column;gap:8px}
  .item{width:100%;text-align:left;border:2px solid var(--ink);background:var(--paper);border-radius:10px;padding:9px 11px;transition:transform .08s,box-shadow .08s,background .08s}
  .item:hover,.item:focus-visible{background:var(--yellow);transform:translate(-1px,-1px);box-shadow:3px 3px 0 var(--ink)}
  .name{display:flex;justify-content:space-between;align-items:center;gap:8px;font-weight:800;font-size:13.5px}
  .kind{font-weight:800;font-size:11px;color:var(--ink);white-space:nowrap;background:var(--cyan);border:2px solid var(--ink);border-radius:99px;padding:0 8px}
  .exp{margin-top:3px;font-size:13px;color:var(--mute);font-weight:500}
  .warn{margin-top:7px;padding:5px 9px;border:2px solid var(--ink);border-radius:7px;background:var(--orange);color:var(--ink);font-size:12.5px;font-weight:650}
  .hl{position:fixed;pointer-events:none;display:none;border-radius:6px;background:rgba(255,214,10,.5);
    outline:3px solid #0b0b0f;box-shadow:0 0 0 6px #ff4d94}
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
    pendingAnchor = makeAnchor();
    toolbar = h("div", "ui toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Margin");
    for (const [key, label] of [["translate", "Translate"], ["explain", "Explain"], ["listen", "Listen"]]) {
      const b = iconButton(key, label, "tb");
      b.dataset.k = key;
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
    if (cardKind === "listen") speechSynthesis.cancel();
    cardObserver?.disconnect();
    cardObserver = null;
    card?.remove();
    card = null;
    anchor = null;
  }

  // Puts the card beside the selected text: under it when there's room, otherwise above, with an
  // arrow pointing at the text. Called again on scroll, resize and whenever the card changes size.
  function placeCard() {
    if (!card) return;
    const vw = window.innerWidth, vh = window.innerHeight, m = 10, gap = 14;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const a = anchor && anchor();
    if (!a) { // no selection to point at: bottom-right corner
      card.classList.remove("below", "above");
      card.style.left = Math.max(m, vw - cw - 16) + "px";
      card.style.top = Math.max(m, vh - ch - 16) + "px";
      card.classList.add("placed");
      return;
    }
    if (a.bottom < 0 || a.top > vh) { card.classList.remove("placed"); return; } // selection scrolled out of view

    // Pick a side once and stay on it, so the card doesn't jump as its content loads. It only swaps
    // if scrolling leaves almost no room on that side. Whatever room there is, the card body fits
    // into it and scrolls inside.
    const room = { below: vh - a.bottom - gap - m, above: a.top - gap - m };
    const other = { below: "above", above: "below" };
    if (!cardPlace) cardPlace = room.below >= 340 || room.below >= room.above ? "below" : "above";
    else if (room[cardPlace] < 200 && room[other[cardPlace]] > room[cardPlace]) cardPlace = other[cardPlace];
    const chrome = card.offsetHeight - cardBody.offsetHeight; // header, footer and borders
    cardBody.style.maxHeight = Math.max(120, Math.min(430, room[cardPlace] - chrome)) + "px";
    const ch2 = card.offsetHeight;

    const x = cardPlace === "below" ? a.lastX : a.firstX;
    const wanted = cardPlace === "below" ? a.bottom + gap : a.top - gap - ch2;
    const top = Math.min(Math.max(wanted, m), Math.max(m, vh - ch2 - m));
    const left = Math.min(Math.max(x - cw / 2, m), Math.max(m, vw - cw - m));
    const covers = cardPlace === "below" ? top < a.bottom + 4 : top + ch2 > a.top - 4;

    card.style.top = top + "px";
    card.style.left = left + "px";
    card.style.setProperty("--ax", Math.min(Math.max(x - left, 28), cw - 28) + "px");
    card.classList.toggle("below", cardPlace === "below" && !covers);
    card.classList.toggle("above", cardPlace === "above" && !covers);
    card.classList.add("placed");
  }

  function openCard(kind, title, original, withLang = false) {
    closeCard();
    ensureHost();
    cardKind = kind;
    anchor = pendingAnchor;
    cardPlace = null;
    card = h("section", `ui card k-${kind}`);
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", title);
    const head = h("header");
    head.append(h("h2", "", title));
    const x = iconButton("close", "", "x");
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", closeCard);
    head.append(x);
    const body = cardBody = h("div", "cbody");
    if (original) {
      const q = h("p", "quote");
      q.append(h("span", "", clean(original, 160)));
      body.append(q);
    }
    let select = null;
    if (withLang) { // translation card: pick which language to translate into
      const row = h("label", "langrow");
      row.append(h("span", "", "Translate into"));
      select = h("select", "langsel");
      for (const [code, name] of LANGUAGES) select.add(new Option(name, code));
      row.append(select);
      body.append(row);
    }
    const out = h("div", "out");
    const extras = h("div", "extras"); // Wikipedia meaning or tricky words, added after the main answer
    const foot = h("div", "foot");
    body.append(out, extras);
    card.append(head, body, foot);
    shadow.append(card);
    placeCard();
    cardObserver = new ResizeObserver(placeCard);
    cardObserver.observe(card);
    return { out, extras, foot, select };
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
      const { out, foot } = openCard("listen", "Reading aloud", text);
      out.textContent = "Playing the selected text.";
      const stop = iconButton("stop", "Stop");
      stop.addEventListener("click", () => { speechSynthesis.cancel(); closeCard(); });
      foot.append(stop);
      speak(text);
      return;
    }
    runAsk(action, text);
  }

  function wikiSection(it) {
    const s = h("div", "sec wiki");
    s.append(h("span", "tag", it.source));
    if (it.description) s.append(h("div", "desc", it.description));
    s.append(h("p", "", it.text));
    if (it.url) {
      const a = h("a", "", "Read more ↗");
      a.href = it.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      s.append(a);
    }
    return s;
  }

  function wordsSection(words) {
    const s = h("div", "sec tricky");
    s.append(h("span", "tag", "Tricky words"));
    const ul = h("ul", "words");
    for (const w of words) {
      const li = h("li");
      li.append(h("b", "", w.word), document.createTextNode(w.meaning));
      ul.append(li);
    }
    s.append(ul);
    return s;
  }

  // A small "Looking up…" row that is swapped for the result, or quietly removed if nothing came back.
  async function addExtra(extras, mine, label, request, build) {
    const row = h("div", "load small");
    row.append(h("div", "spin"), h("span", "", label));
    extras.append(row);
    let resp = null;
    try { resp = await chrome.runtime.sendMessage(request); } catch {}
    if (mine !== askToken || !extras.isConnected) return;
    const node = resp?.ok ? build(resp) : null;
    node ? row.replaceWith(node) : row.remove();
  }

  async function runAsk(task, text) {
    const translating = task === "translate";
    const { out, extras, foot, select } = openCard(task, translating ? "Translation" : "In plain words", text, translating);
    const body = cardBody;
    const opened = askToken;
    const multi = /\s/.test(text.trim());

    const fetchAnswer = async (target) => {
      const mine = ++askToken; // a newer request (or a closed card) makes older answers stale
      out.replaceChildren();
      extras.replaceChildren();
      foot.replaceChildren();
      body.querySelector(".mnote")?.remove();
      setLoading(out, translating ? "Translating…" : "Working it out…");

      // One word: also fetch its meaning from Wikipedia/Wiktionary, alongside the main request so it never delays it.
      if (!multi) {
        addExtra(extras, mine, "Checking Wikipedia…", { type: "WIKI", text, pageLang: document.documentElement.lang || "" },
          (r) => {
            if (!r.items?.length) return null;
            const box = h("div");
            r.items.forEach((it) => box.append(wikiSection(it)));
            return box;
          });
      }

      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: "ASK", task, text, pageTitle: document.title, targetLang: target });
      } catch {
        resp = { error: "Margin was updated. Reload this tab and try again." };
      }
      if (mine !== askToken) return; // a newer request replaced this one
      out.replaceChildren();
      if (resp?.ok) {
        out.textContent = resp.text;
        if (resp.note) out.after(h("p", "mnote", resp.note));
        resultButtons(foot, resp.text, target || (await store()).preferredLanguage);
        if (multi) {
          // Longer text: difficult words are explained at the end. With an API key they arrive with the answer;
          // in free mode they are looked up in a dictionary.
          if (Array.isArray(resp.words)) { if (resp.words.length) extras.append(wordsSection(resp.words)); }
          else addExtra(extras, mine, "Finding tricky words…", { type: "WORDS", text },
            (r) => (r.words?.length ? wordsSection(r.words) : null));
        }
      } else if (resp?.needsKey) {
        out.textContent = resp.message || "This needs an Anthropic API key. Click the Margin icon in your toolbar, open Settings and paste it in.";
      } else {
        out.textContent = resp?.error || "Something went wrong. Try again.";
      }
    };

    if (!select) return fetchAnswer("");
    // The picker starts on the language chosen in the popup's settings.
    setLoading(out, "Translating…");
    const { preferredLanguage } = await store();
    if (opened !== askToken) return; // card was closed or replaced meanwhile
    select.value = preferredLanguage;
    select.addEventListener("change", () => fetchAnswer(select.value));
    return fetchAnswer(select.value);
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
    if (e.target === host) return;
    removeToolbar();
    if (card) closeCard(); // clicking away from the card dismisses it
  });
  // The card follows its text while the page scrolls or resizes.
  let placeRaf = 0;
  const repositionCard = () => {
    if (!card || placeRaf) return;
    placeRaf = requestAnimationFrame(() => { placeRaf = 0; placeCard(); });
  };
  window.addEventListener("scroll", () => { removeToolbar(); repositionCard(); }, { passive: true, capture: true });
  window.addEventListener("resize", repositionCard);
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
