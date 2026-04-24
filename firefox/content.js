(() => {
  "use strict";

  let selectMode = false;
  let selectorBar = null;
  let hoveredEl = null;
  let selectedSelectors = [];
  let scrapedData = [];
  let paginationConfig = null;
  let scrollObserver = null;
  let dynamicObserver = null;

  // ── Unique CSS selector for element ──
  function getSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    while (el && el !== document.body && el !== document.documentElement) {
      let sel = el.tagName.toLowerCase();
      if (el.className && typeof el.className === "string") {
        const classes = el.className.trim().split(/\s+/).filter(c => c && !c.startsWith("dd-"));
        if (classes.length) sel += "." + classes.map(c => CSS.escape(c)).join(".");
      }
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          s => s.tagName === el.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(el) + 1;
          sel += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(sel);
      el = parent;
    }
    return parts.join(" > ");
  }

  // ── Generalize selector to match similar elements ──
  function generalizeSelector(selector) {
    // Strip nth-of-type from the last segment to get all siblings
    return selector.replace(/:nth-of-type\(\d+\)$/, "");
  }

  // ── Selection mode UI ──
  function showSelectorBar(msg) {
    if (selectorBar) selectorBar.remove();
    selectorBar = document.createElement("div");
    selectorBar.className = "dd-selector-bar";
    selectorBar.innerHTML = `
      <span>${msg || "Click an element to select it"}</span>
      <span class="dd-selector-text"></span>
      <button class="dd-confirm">Confirm</button>
      <button class="dd-cancel">Cancel</button>
    `;
    document.body.appendChild(selectorBar);
    selectorBar.querySelector(".dd-cancel").addEventListener("click", stopSelectMode);
    selectorBar.querySelector(".dd-confirm").addEventListener("click", confirmSelection);
  }

  function startSelectMode(purpose) {
    selectMode = true;
    showSelectorBar(
      purpose === "pagination"
        ? "Click the 'Next' button or link"
        : "Click an element containing data to scrape"
    );
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("mouseout", onHoverOut, true);
    document.addEventListener("click", onSelect, true);
  }

  function stopSelectMode() {
    selectMode = false;
    if (selectorBar) { selectorBar.remove(); selectorBar = null; }
    if (hoveredEl) { hoveredEl.classList.remove("dd-highlight"); hoveredEl = null; }
    document.querySelectorAll(".dd-selected").forEach(el => el.classList.remove("dd-selected"));
    document.removeEventListener("mouseover", onHover, true);
    document.removeEventListener("mouseout", onHoverOut, true);
    document.removeEventListener("click", onSelect, true);
  }

  function onHover(e) {
    if (!selectMode) return;
    if (selectorBar && selectorBar.contains(e.target)) return;
    if (hoveredEl) hoveredEl.classList.remove("dd-highlight");
    hoveredEl = e.target;
    hoveredEl.classList.add("dd-highlight");
    const sel = getSelector(hoveredEl);
    const text = selectorBar?.querySelector(".dd-selector-text");
    if (text) text.textContent = sel;
  }

  function onHoverOut(e) {
    if (e.target === hoveredEl) {
      hoveredEl.classList.remove("dd-highlight");
      hoveredEl = null;
    }
  }

  function onSelect(e) {
    if (!selectMode) return;
    if (selectorBar && selectorBar.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    el.classList.remove("dd-highlight");
    el.classList.add("dd-selected");
    const sel = getSelector(el);
    selectedSelectors.push(sel);
  }

  function confirmSelection() {
    const sels = [...selectedSelectors];
    selectedSelectors = [];
    stopSelectMode();
    browser.runtime.sendMessage({ type: "SELECTORS_CONFIRMED", selectors: sels });
  }

  // ── Data extraction ──
  function extractData(config) {
    const { selectors, columns } = config;
    const rows = [];

    // Find common parent pattern — use first selector generalized
    if (!selectors.length) return [];

    // For each selector, generalize and find all matching elements
    const colData = selectors.map((sel, i) => {
      const gen = generalizeSelector(sel);
      if (!gen) return { name: columns?.[i] || `Column ${i + 1}`, elements: [], selector: "" };
      const els = Array.from(document.querySelectorAll(gen));
      return {
        name: columns?.[i] || `Column ${i + 1}`,
        elements: els,
        selector: gen,
      };
    });

    const maxRows = Math.max(...colData.map(c => c.elements.length));
    for (let r = 0; r < maxRows; r++) {
      const row = {};
      colData.forEach(col => {
        const el = col.elements[r];
        row[col.name] = el ? (el.textContent || "").trim() : "";
      });
      rows.push(row);
    }
    return rows;
  }

  // ── Dynamic content detection ──
  function waitForDynamic(timeout = 10000) {
    return new Promise(resolve => {
      let settled = false;
      let timer = null;
      const maxTimer = setTimeout(() => finish(), timeout);

      function finish() {
        settled = true;
        clearTimeout(maxTimer);
        if (timer) clearTimeout(timer);
        if (dynamicObserver) { dynamicObserver.disconnect(); dynamicObserver = null; }
        resolve();
      }

      dynamicObserver = new MutationObserver(() => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        // Wait 800ms of no mutations = content settled
        timer = setTimeout(() => finish(), 800);
      });

      dynamicObserver.observe(document.body, {
        childList: true, subtree: true, characterData: true
      });

      // If nothing changes in 2s, assume static
      timer = setTimeout(() => finish(), 2000);
    });
  }

  // ── Infinite scroll handling ──
  function handleInfiniteScroll(config) {
    const { maxScrolls = 50, delay = 1000, extractConfig } = config;
    let scrollCount = 0;
    let allData = [];
    let prevHeight = 0;

    return new Promise(resolve => {
      function scrollStep() {
        if (scrollCount >= maxScrolls) {
          return resolve(allData);
        }
        prevHeight = document.body.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        scrollCount++;

        setTimeout(async () => {
          await waitForDynamic(config.maxWait || 5000);
          const newData = extractData(extractConfig);
          // Merge — deduplicate by row content
          const existing = new Set(allData.map(r => JSON.stringify(r)));
          newData.forEach(r => {
            const key = JSON.stringify(r);
            if (!existing.has(key)) { allData.push(r); existing.add(key); }
          });

          if (document.body.scrollHeight === prevHeight) {
            // No new content loaded
            return resolve(allData);
          }
          scrollStep();
        }, delay);
      }
      scrollStep();
    });
  }

  // ── Pagination handling ──
  async function handlePagination(config) {
    const { nextSelector, maxPages = 20, delay = 1500, extractConfig } = config;
    let allData = [];
    let page = 0;

    while (page < maxPages) {
      await waitForDynamic(config.maxWait || 5000);
      const pageData = extractData(extractConfig);
      const existing = new Set(allData.map(r => JSON.stringify(r)));
      pageData.forEach(r => {
        const key = JSON.stringify(r);
        if (!existing.has(key)) { allData.push(r); existing.add(key); }
      });

      page++;
      const nextBtn = document.querySelector(nextSelector);
      if (!nextBtn) break;

      // Check if disabled
      if (
        nextBtn.disabled ||
        nextBtn.classList.contains("disabled") ||
        nextBtn.getAttribute("aria-disabled") === "true"
      ) break;

      nextBtn.click();
      await new Promise(r => setTimeout(r, delay));
    }
    return allData;
  }

  // ══════════════════════════════════════
  //  OSINT: Entity extraction
  // ══════════════════════════════════════
  const ENTITY_PATTERNS = {
    emails: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    phones: /(?:\+\d[\d\s\-().]{6,20}\d)|(?:\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/g,
    urls: /https?:\/\/[^\s<>"')\]]+/g,
    socials: /(?:@[a-zA-Z0-9_]{1,50})|(?:(?:twitter|x|instagram|facebook|linkedin|github|tiktok|youtube|reddit)\.com\/[a-zA-Z0-9_.\/\-]+)/gi,
    ips: /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g,
    crypto: /\b(?:1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{25,90}|0x[a-fA-F0-9]{40})\b/g,
  };

  // IP pattern for pre-filtering phone matches
  const IP_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

  function extractEntities(types) {
    const text = document.body.innerText;
    const htmlStr = document.body.innerHTML;
    const results = [];
    const seen = new Set();

    // Extract IPs first so we can exclude them from phone matches
    const knownIPs = new Set();
    if (types.includes("ips")) {
      const ipMatches = text.match(new RegExp(ENTITY_PATTERNS.ips.source, "g")) || [];
      ipMatches.forEach(m => {
        const val = m.trim();
        if (!val) return;
        if (val.includes(".")) {
          const parts = val.split(".");
          if (parts.length === 4 && parts.every(p => parseInt(p) <= 255)) {
            knownIPs.add(val);
          }
        } else {
          knownIPs.add(val); // IPv6
        }
      });
    }

    // Process types in order: ips first, then rest — prevents phone consuming IPs
    const orderedTypes = [...types].sort((a, b) => {
      if (a === "ips") return -1;
      if (b === "ips") return 1;
      return 0;
    });

    orderedTypes.forEach(type => {
      const pattern = ENTITY_PATTERNS[type];
      if (!pattern) return;
      // Emails: search HTML too (catches mailto hrefs)
      // URLs/socials: search HTML (catches href values)
      const source = (type === "urls" || type === "socials" || type === "emails") ? htmlStr : text;
      const matches = source.match(new RegExp(pattern.source, pattern.flags)) || [];
      matches.forEach(match => {
        const val = match.trim();
        if (!val || seen.has(val.toLowerCase())) return;

        // Phone-specific filters
        if (type === "phones") {
          const digits = val.replace(/\D/g, "");
          if (digits.length < 7 || digits.length > 15) return;
          // Reject if it looks like an IP address
          if (IP_PATTERN.test(val)) return;
          // Reject if every digit group looks like IP octet (e.g. 192.168.1.100)
          if (knownIPs.has(val)) return;
          // Reject dates (YYYY-MM-DD pattern)
          if (/^\d{4}[\-\/]\d{2}[\-\/]\d{2}$/.test(val)) return;
        }

        // IP-specific filters
        if (type === "ips") {
          if (val.includes(".")) {
            const parts = val.split(".");
            if (parts.length !== 4 || parts.some(p => parseInt(p) > 255)) return;
          }
        }

        seen.add(val.toLowerCase());
        results.push({ Type: type, Value: val });
      });
    });

    return results;
  }

  // ══════════════════════════════════════
  //  OSINT: Link harvester
  // ══════════════════════════════════════
  function harvestLinks(opts) {
    const links = Array.from(document.querySelectorAll("a[href]"));
    const pageHost = location.hostname;
    const results = [];
    const seen = new Set();

    links.forEach(a => {
      const href = a.href;
      if (!href || seen.has(href)) return;
      seen.add(href);

      const text = (a.textContent || "").trim().slice(0, 200);
      let type;
      let domain = "";

      if (href.startsWith("mailto:")) {
        type = "mailto";
      } else if (href.startsWith("tel:")) {
        type = "tel";
      } else {
        try {
          const u = new URL(href);
          domain = u.hostname;
          type = domain === pageHost ? "internal" : "external";
        } catch { return; }
      }

      if (!opts[type]) return;

      results.push({
        URL: href,
        Text: text,
        Type: type,
        Domain: domain,
      });
    });

    // Sort by domain
    results.sort((a, b) => a.Domain.localeCompare(b.Domain));
    return results;
  }

  // ══════════════════════════════════════
  //  OSINT: Table detection
  // ══════════════════════════════════════
  function detectTables() {
    const tables = Array.from(document.querySelectorAll("table"));
    return tables.map((t, i) => {
      const rows = t.querySelectorAll("tr");
      const firstRow = rows[0];
      const cols = firstRow ? firstRow.querySelectorAll("th, td").length : 0;
      return { index: i, rows: rows.length, cols };
    }).filter(t => t.rows > 1 && t.cols > 0);
  }

  function extractTable(index) {
    const tables = Array.from(document.querySelectorAll("table"));
    const table = tables[index];
    if (!table) return [];

    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return [];

    // Try to get headers from first row
    const headerRow = rows[0];
    const headerCells = Array.from(headerRow.querySelectorAll("th, td"));
    const hasHeaders = headerRow.querySelectorAll("th").length > 0;
    const headers = headerCells.map((c, i) =>
      hasHeaders ? (c.textContent || "").trim() || `Column ${i + 1}` : `Column ${i + 1}`
    );

    const dataRows = hasHeaders ? rows.slice(1) : rows;
    return dataRows.map(row => {
      const cells = Array.from(row.querySelectorAll("th, td"));
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = cells[i] ? (cells[i].textContent || "").trim() : "";
      });
      return obj;
    });
  }

  // ══════════════════════════════════════
  //  OSINT: Image extraction
  // ══════════════════════════════════════
  function extractImages(opts) {
    const imgs = Array.from(document.querySelectorAll("img"));
    const seen = new Set();
    return imgs.filter(img => {
      const src = img.src || img.dataset.src || "";
      if (!src || seen.has(src)) return false;
      seen.add(src);
      if (opts.minSize && (img.naturalWidth < opts.minSize || img.naturalHeight < opts.minSize)) return false;
      if (opts.altOnly && !img.alt) return false;
      return true;
    }).map(img => ({
      URL: img.src || img.dataset.src || "",
      Alt: (img.alt || "").trim(),
      Width: img.naturalWidth || img.width || 0,
      Height: img.naturalHeight || img.height || 0,
    }));
  }

  // ══════════════════════════════════════
  //  Full page scan — runs all extractors
  // ══════════════════════════════════════
  function fullPageScan() {
    const allTypes = ["emails", "phones", "urls", "socials", "ips", "crypto"];
    const entities = extractEntities(allTypes);
    const links = harvestLinks({ external: true, internal: true, mailto: true, tel: true });
    const tablesMeta = detectTables();
    const tables = tablesMeta.map((t) => ({
      meta: t,
      data: extractTable(t.index),
    }));
    const images = extractImages({ minSize: 0, altOnly: false });

    return { entities, links, tables, images };
  }

  // ══════════════════════════════════════
  //  Message handling
  // ══════════════════════════════════════
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case "START_SELECT":
        startSelectMode(msg.purpose);
        return;

      case "STOP_SELECT":
        stopSelectMode();
        return;

      case "EXTRACT_DATA":
        (async () => {
          await waitForDynamic(msg.maxWait || 5000);
          const data = extractData(msg.config);
          sendResponse({ data });
        })();
        return true;

      case "EXTRACT_WITH_SCROLL":
        (async () => {
          const data = await handleInfiniteScroll({
            maxScrolls: msg.maxScrolls || 50,
            delay: msg.delay || 1000,
            maxWait: msg.maxWait || 5000,
            extractConfig: msg.config,
          });
          sendResponse({ data });
        })();
        return true;

      case "EXTRACT_WITH_PAGINATION":
        (async () => {
          const data = await handlePagination({
            nextSelector: msg.nextSelector,
            maxPages: msg.maxPages || 20,
            delay: msg.delay || 1500,
            maxWait: msg.maxWait || 5000,
            extractConfig: msg.config,
          });
          sendResponse({ data });
        })();
        return true;

      case "FULL_PAGE_SCAN":
        (async () => {
          await waitForDynamic(msg.maxWait || 5000);
          sendResponse(fullPageScan());
        })();
        return true;

      case "EXTRACT_ENTITIES":
        sendResponse({ data: extractEntities(msg.entityTypes) });
        return;

      case "GET_PAGE_HTML":
        sendResponse({ html: document.documentElement.outerHTML });
        return;

      case "SAVE_FILE": {
        let url;
        if (msg.dataUrl) {
          url = msg.dataUrl;
        } else {
          const blob = new Blob([msg.content], { type: msg.mimeType || "application/octet-stream" });
          url = URL.createObjectURL(blob);
        }
        const a = document.createElement("a");
        a.href = url;
        a.download = msg.filename || "download";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (!msg.dataUrl) setTimeout(() => URL.revokeObjectURL(url), 5000);
        sendResponse({ ok: true });
        return;
      }

      case "HARVEST_LINKS":
        sendResponse({ data: harvestLinks(msg.opts) });
        return;

      case "DETECT_TABLES":
        sendResponse({ tables: detectTables() });
        return;

      case "EXTRACT_TABLE":
        sendResponse({ data: extractTable(msg.tableIndex) });
        return;

      case "EXTRACT_IMAGES":
        sendResponse({ data: extractImages(msg.opts) });
        return;

      case "PING":
        sendResponse({ ok: true });
        return;
    }
  });
})();
