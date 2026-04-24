"use strict";

// ── State ──
let selectors = [];
let columns = [];
let scrapedData = [];
let nextButtonSelector = "";
let evidenceMeta = null;
let scanResults = null;   // full scan multi-category data
let activeCategory = null;

// ── DOM refs ──
const btnSelect = document.getElementById("btn-select");
const btnPickNext = document.getElementById("btn-pick-next");
const selectorList = document.getElementById("selector-list");
const scrapeMode = document.getElementById("scrape-mode");
const paginationOpts = document.getElementById("pagination-opts");
const scrollOpts = document.getElementById("scroll-opts");
const nextSelectorInput = document.getElementById("next-selector");
const btnScrape = document.getElementById("btn-scrape");
const previewSection = document.getElementById("step-preview");
const previewTable = document.getElementById("preview-table");
const rowCount = document.getElementById("row-count");
const columnConfig = document.getElementById("column-config");
const statusEl = document.getElementById("status");
const evidenceMetaEl = document.getElementById("evidence-meta");

// ── Tab navigation ──
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`page-${tab.dataset.tab}`).classList.add("active");
    const preview = document.getElementById("step-preview");
    if (tab.dataset.tab === "scraper") {
      if (scrapedData.length) preview.classList.remove("hidden");
    } else {
      preview.classList.add("hidden");
    }
  });
});

// ── Helpers ──
async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function sendToContent(msg) {
  const tab = await getActiveTab();
  return browser.tabs.sendMessage(tab.id, msg);
}

function showStatus(text, type = "info") {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove("hidden");
  if (type !== "info") {
    setTimeout(() => statusEl.classList.add("hidden"), 3000);
  }
}

function hideStatus() {
  statusEl.classList.add("hidden");
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Evidence chain ──
async function buildEvidence(contentForHash) {
  if (!document.getElementById("opt-evidence").checked) {
    evidenceMeta = null;
    return;
  }
  const tab = await getActiveTab();
  const hash = await sha256(contentForHash || JSON.stringify(scrapedData));
  evidenceMeta = {
    sourceUrl: tab.url,
    pageTitle: tab.title,
    capturedAt: new Date().toISOString(),
    sha256: hash,
    userAgent: navigator.userAgent,
  };
}

function renderEvidence() {
  if (!evidenceMeta) {
    evidenceMetaEl.classList.add("hidden");
    return;
  }
  evidenceMetaEl.classList.remove("hidden");
  evidenceMetaEl.innerHTML = `
    <strong>Source:</strong> ${esc(evidenceMeta.sourceUrl)}<br>
    <strong>Title:</strong> ${esc(evidenceMeta.pageTitle)}<br>
    <strong>Captured:</strong> ${evidenceMeta.capturedAt}<br>
    <strong>SHA-256:</strong> ${evidenceMeta.sha256}
  `;
}

// ── Persist / restore state ──
async function saveState() {
  await browser.storage.local.set({
    ddSelectors: selectors,
    ddColumns: columns,
    ddNextSelector: nextButtonSelector,
  });
}

async function restoreState() {
  const stored = await browser.storage.local.get([
    "ddSelectors", "ddColumns", "ddNextSelector",
  ]);
  if (stored.ddSelectors?.length) {
    selectors = stored.ddSelectors;
    columns = stored.ddColumns || selectors.map((_, i) => ({ name: `Column ${i + 1}`, enabled: true }));
    renderSelectors();
  }
  if (stored.ddNextSelector) {
    nextButtonSelector = stored.ddNextSelector;
    nextSelectorInput.value = nextButtonSelector;
  }
}

// ── Selector management ──
function renderSelectors() {
  selectorList.innerHTML = "";
  selectors.forEach((sel, i) => {
    const div = document.createElement("div");
    div.className = "selector-item";
    div.innerHTML = `
      <span>${i + 1}.</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${sel}</span>
      <button class="remove-sel" data-idx="${i}">&times;</button>
    `;
    selectorList.appendChild(div);
  });

  selectorList.querySelectorAll(".remove-sel").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      selectors.splice(idx, 1);
      columns.splice(idx, 1);
      renderSelectors();
      renderColumns();
      saveState();
    });
  });

  renderColumns();
}

function renderColumns() {
  columnConfig.innerHTML = "";
  selectors.forEach((sel, i) => {
    if (!columns[i]) columns[i] = { name: `Column ${i + 1}`, enabled: true };
    const row = document.createElement("div");
    row.className = "col-row";
    row.innerHTML = `
      <input type="text" value="${columns[i].name}" data-idx="${i}" class="col-name">
      <label><input type="checkbox" ${columns[i].enabled ? "checked" : ""} data-idx="${i}" class="col-toggle"> Show</label>
    `;
    columnConfig.appendChild(row);
  });

  columnConfig.querySelectorAll(".col-name").forEach(inp => {
    inp.addEventListener("input", () => {
      columns[parseInt(inp.dataset.idx)].name = inp.value;
      saveState();
    });
  });

  columnConfig.querySelectorAll(".col-toggle").forEach(cb => {
    cb.addEventListener("change", () => {
      columns[parseInt(cb.dataset.idx)].enabled = cb.checked;
      saveState();
    });
  });
}

// ── Check for pending selector confirmations ──
let pollInterval = null;

async function consumePendingSelectors() {
  const result = await browser.storage.local.get(["lastSelectors", "ddPickingNext"]);
  if (!result.lastSelectors?.length) return false;

  const newSels = result.lastSelectors;
  await browser.storage.local.remove(["lastSelectors", "ddPickingNext"]);

  if (result.ddPickingNext) {
    if (newSels.length) {
      nextButtonSelector = newSels[0];
      nextSelectorInput.value = nextButtonSelector;
      showStatus("Next button selected", "success");
      saveState();
    }
  } else {
    newSels.forEach(s => selectors.push(s));
    renderSelectors();
    showStatus(`${newSels.length} element(s) selected`, "success");
    saveState();
  }
  return true;
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    const found = await consumePendingSelectors();
    if (found) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }, 300);
}

// ── Scraper event handlers ──
btnSelect.addEventListener("click", async () => {
  await browser.storage.local.set({ ddPickingNext: false });
  await sendToContent({ type: "START_SELECT", purpose: "data" });
  showStatus("Selection mode active — pick elements on the page");
  startPolling();
});

btnPickNext.addEventListener("click", async () => {
  await browser.storage.local.set({ ddPickingNext: true });
  await sendToContent({ type: "START_SELECT", purpose: "pagination" });
  showStatus("Click the 'Next' button on the page");
  startPolling();
});

scrapeMode.addEventListener("change", () => {
  paginationOpts.classList.toggle("hidden", scrapeMode.value !== "pagination");
  scrollOpts.classList.toggle("hidden", scrapeMode.value !== "scroll");
});

btnScrape.addEventListener("click", async () => {
  clearScanState();
  if (!selectors.length) {
    showStatus("No selectors — pick elements first", "error");
    return;
  }

  const enabledIdxs = columns.map((c, i) => c.enabled ? i : -1).filter(i => i >= 0);
  const config = {
    selectors: enabledIdxs.map(i => selectors[i]),
    columns: enabledIdxs.map(i => columns[i].name),
  };

  const delay = parseInt(document.getElementById("delay").value) || 1500;
  const maxWait = parseInt(document.getElementById("max-wait").value) || 5000;

  showStatus("Scraping...");
  btnScrape.disabled = true;

  try {
    let result;
    const mode = scrapeMode.value;

    if (mode === "scroll") {
      const maxScrolls = parseInt(document.getElementById("max-scrolls").value) || 50;
      result = await sendToContent({ type: "EXTRACT_WITH_SCROLL", config, maxScrolls, delay, maxWait });
    } else if (mode === "pagination") {
      const ns = nextSelectorInput.value || nextButtonSelector;
      if (!ns) {
        showStatus("Pick or enter a 'Next' button selector", "error");
        btnScrape.disabled = false;
        return;
      }
      const maxPages = parseInt(document.getElementById("max-pages").value) || 20;
      result = await sendToContent({ type: "EXTRACT_WITH_PAGINATION", config, nextSelector: ns, maxPages, delay, maxWait });
    } else {
      result = await sendToContent({ type: "EXTRACT_DATA", config, maxWait });
    }

    scrapedData = result.data || [];
    await buildEvidence();
    showStatus(`Scraped ${scrapedData.length} rows`, "success");
    renderPreview();
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
  btnScrape.disabled = false;
});

// ══════════════════════════════════════
//  FULL PAGE SCAN
// ══════════════════════════════════════

document.getElementById("btn-full-scan").addEventListener("click", async () => {
  showStatus("Full page scan — waiting for dynamic content...");
  document.getElementById("btn-full-scan").disabled = true;

  try {
    const maxWait = parseInt(document.getElementById("max-wait").value) || 5000;
    const result = await sendToContent({ type: "FULL_PAGE_SCAN", maxWait });

    // Build category map
    const categories = {};

    if (result.entities?.length) {
      categories["Entities"] = result.entities;
    }
    if (result.links?.length) {
      categories["Links"] = result.links;
    }
    if (result.images?.length) {
      categories["Images"] = result.images;
    }
    // Flatten all tables into named categories
    if (result.tables?.length) {
      result.tables.forEach((t, i) => {
        if (t.data?.length) {
          categories[`Table ${i + 1} (${t.meta.rows}r × ${t.meta.cols}c)`] = t.data;
        }
      });
    }

    const catKeys = Object.keys(categories);
    if (!catKeys.length) {
      showStatus("No data found on page", "error");
      document.getElementById("btn-full-scan").disabled = false;
      return;
    }

    // Build combined "All" category
    const allRows = [];
    if (result.entities?.length) {
      result.entities.forEach(e => allRows.push({ Category: "Entity", Type: e.Type, Value: e.Value, Extra: "" }));
    }
    if (result.links?.length) {
      result.links.forEach(l => allRows.push({ Category: "Link", Type: l.Type, Value: l.URL, Extra: l.Text }));
    }
    if (result.images?.length) {
      result.images.forEach(img => allRows.push({ Category: "Image", Type: `${img.Width}×${img.Height}`, Value: img.URL, Extra: img.Alt }));
    }
    if (result.tables?.length) {
      result.tables.forEach((t, i) => {
        t.data?.forEach(row => {
          const vals = Object.values(row);
          allRows.push({ Category: `Table ${i + 1}`, Type: "", Value: vals[0] || "", Extra: vals.slice(1).join(" | ") });
        });
      });
    }
    categories["All"] = allRows;

    scanResults = categories;

    // Count totals
    const total = allRows.length;
    await buildEvidence(JSON.stringify(allRows));
    showStatus(`Scan complete — ${total} items across ${catKeys.length} categories`, "success");

    // Default to "All" view
    activeCategory = "All";
    scrapedData = scanResults[activeCategory];
    renderCategoryBar();
    renderPreview();
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
  document.getElementById("btn-full-scan").disabled = false;
});

function renderCategoryBar() {
  const bar = document.getElementById("category-bar");
  if (!scanResults) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = "";

  // Put "All" first
  const keys = ["All", ...Object.keys(scanResults).filter(k => k !== "All")];
  keys.forEach(cat => {
    const btn = document.createElement("button");
    btn.className = `cat-btn${cat === activeCategory ? " active" : ""}`;
    btn.innerHTML = `${esc(cat)} <span class="cat-count">(${scanResults[cat].length})</span>`;
    btn.addEventListener("click", () => {
      activeCategory = cat;
      scrapedData = scanResults[cat];
      renderCategoryBar();
      renderPreview();
    });
    bar.appendChild(btn);
  });
}

// ══════════════════════════════════════
//  OSINT TOOLS
// ══════════════════════════════════════

// ── Entity extraction ──
document.getElementById("btn-extract-entities").addEventListener("click", async () => {
  clearScanState();
  const types = [];
  if (document.getElementById("ent-emails").checked) types.push("emails");
  if (document.getElementById("ent-phones").checked) types.push("phones");
  if (document.getElementById("ent-urls").checked) types.push("urls");
  if (document.getElementById("ent-socials").checked) types.push("socials");
  if (document.getElementById("ent-ips").checked) types.push("ips");
  if (document.getElementById("ent-crypto").checked) types.push("crypto");

  if (!types.length) {
    showStatus("Select at least one entity type", "error");
    return;
  }

  showStatus("Extracting entities...");
  try {
    const result = await sendToContent({ type: "EXTRACT_ENTITIES", entityTypes: types });
    scrapedData = result.data || [];
    await buildEvidence();
    showStatus(`Found ${scrapedData.length} entities`, "success");
    renderPreview();
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
});

// ── Page snapshot ──
document.getElementById("btn-snapshot").addEventListener("click", async () => {
  showStatus("Capturing snapshot...");
  try {
    const tab = await getActiveTab();

    // Get page HTML from content script
    const htmlResult = await sendToContent({ type: "GET_PAGE_HTML" });
    const pageHtml = htmlResult.html;

    // Capture screenshot via extension API
    const screenshotDataUrl = await browser.tabs.captureVisibleTab(null, { format: "png" });

    // Build evidence
    const hash = await sha256(pageHtml);
    const timestamp = new Date().toISOString();
    const safeTitle = (tab.title || "page").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
    const ts = Date.now();

    const htmlContent = [
      `<!-- Data Dumper Evidence Snapshot -->\n`,
      `<!-- Source: ${tab.url} -->\n`,
      `<!-- Captured: ${timestamp} -->\n`,
      `<!-- SHA-256: ${hash} -->\n`,
      `<!-- User-Agent: ${navigator.userAgent} -->\n\n`,
      pageHtml,
    ].join("");

    // Download via content script (Firefox blocks data URLs in downloads API)
    await sendToContent({ type: "SAVE_FILE", content: htmlContent, filename: `snapshot_${safeTitle}_${ts}.html`, mimeType: "text/html" });
    await sendToContent({ type: "SAVE_FILE", dataUrl: screenshotDataUrl, filename: `snapshot_${safeTitle}_${ts}.png` });

    showStatus("Snapshot saved (HTML + PNG)", "success");
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
});

// ── Link harvester ──
document.getElementById("btn-harvest-links").addEventListener("click", async () => {
  clearScanState();
  const opts = {
    external: document.getElementById("links-external").checked,
    internal: document.getElementById("links-internal").checked,
    mailto: document.getElementById("links-mailto").checked,
    tel: document.getElementById("links-tel").checked,
    protocol: document.getElementById("links-protocol").checked,
  };

  showStatus("Harvesting links...");
  try {
    const result = await sendToContent({ type: "HARVEST_LINKS", opts });
    scrapedData = result.data || [];
    await buildEvidence();
    showStatus(`Found ${scrapedData.length} links`, "success");
    renderPreview();
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
});

// ── Auto-detect tables ──
document.getElementById("btn-detect-tables").addEventListener("click", async () => {
  showStatus("Detecting tables...");
  try {
    const result = await sendToContent({ type: "DETECT_TABLES" });
    const tables = result.tables || [];

    if (!tables.length) {
      showStatus("No tables found", "error");
      return;
    }

    const tableList = document.getElementById("table-list");
    tableList.innerHTML = "";
    tables.forEach((t, i) => {
      const div = document.createElement("div");
      div.className = "table-pick-item";
      div.innerHTML = `
        <span>Table ${i + 1}: ${t.rows} rows, ${t.cols} cols</span>
        <button data-idx="${i}">Extract</button>
      `;
      div.querySelector("button").addEventListener("click", async () => {
        showStatus("Extracting table...");
        const res = await sendToContent({ type: "EXTRACT_TABLE", tableIndex: i });
        scrapedData = res.data || [];
        await buildEvidence();
        showStatus(`Extracted ${scrapedData.length} rows`, "success");
        renderPreview();
      });
      tableList.appendChild(div);
    });

    showStatus(`Found ${tables.length} table(s)`, "success");
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
});

// ── Image extraction ──
document.getElementById("btn-extract-images").addEventListener("click", async () => {
  clearScanState();
  const opts = {
    minSize: document.getElementById("img-min-size").checked ? 50 : 0,
    altOnly: document.getElementById("img-with-alt").checked,
  };

  showStatus("Extracting images...");
  try {
    const result = await sendToContent({ type: "EXTRACT_IMAGES", opts });
    scrapedData = result.data || [];
    await buildEvidence();
    showStatus(`Found ${scrapedData.length} images`, "success");
    renderPreview();
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  }
});

// ══════════════════════════════════════
//  PREVIEW + EXPORT
// ══════════════════════════════════════

function clearScanState() {
  scanResults = null;
  activeCategory = null;
  document.getElementById("category-bar").classList.add("hidden");
}

function renderPreview() {
  if (!scrapedData.length) {
    previewSection.classList.add("hidden");
    return;
  }
  previewSection.classList.remove("hidden");
  renderEvidence();
  if (scanResults) renderCategoryBar();
  rowCount.textContent = `(${scrapedData.length} rows)`;

  const keys = Object.keys(scrapedData[0]);
  let html = "<thead><tr>";
  keys.forEach(k => { html += `<th>${esc(k)}</th>`; });
  html += "</tr></thead><tbody>";
  scrapedData.slice(0, 100).forEach(row => {
    html += "<tr>";
    keys.forEach(k => { html += `<td title="${esc(row[k] || "")}">${esc(row[k] || "")}</td>`; });
    html += "</tr>";
  });
  if (scrapedData.length > 100) {
    html += `<tr><td colspan="${keys.length}" style="text-align:center;color:var(--text-dim)">...and ${scrapedData.length - 100} more rows</td></tr>`;
  }
  html += "</tbody>";
  previewTable.innerHTML = html;
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = String(str);
  return d.innerHTML;
}

// ── Evidence header for exports ──
function evidenceHeader(format) {
  if (!evidenceMeta) return "";
  const m = evidenceMeta;
  if (format === "csv") {
    return `# Source: ${m.sourceUrl}\n# Title: ${m.pageTitle}\n# Captured: ${m.capturedAt}\n# SHA-256: ${m.sha256}\n# User-Agent: ${m.userAgent}\n`;
  }
  if (format === "xml") {
    return `  <evidence>\n    <source>${xmlEsc(m.sourceUrl)}</source>\n    <title>${xmlEsc(m.pageTitle)}</title>\n    <captured>${m.capturedAt}</captured>\n    <sha256>${m.sha256}</sha256>\n    <userAgent>${xmlEsc(m.userAgent)}</userAgent>\n  </evidence>\n`;
  }
  return "";
}

// ── Export: CSV ──
document.getElementById("btn-csv").addEventListener("click", () => {
  if (!scrapedData.length) return;
  const keys = Object.keys(scrapedData[0]);
  const lines = [evidenceHeader("csv"), keys.map(csvCell).join(",")];
  scrapedData.forEach(row => {
    lines.push(keys.map(k => csvCell(row[k] || "")).join(","));
  });
  downloadFile(lines.join("\n"), "data-dump.csv", "text/csv");
});

function csvCell(val) {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── Export: Excel ──
document.getElementById("btn-excel").addEventListener("click", () => {
  if (!scrapedData.length) return;
  const keys = Object.keys(scrapedData[0]);

  let xml = '<?xml version="1.0"?>\n';
  xml += '<?mso-application progid="Excel.Sheet"?>\n';
  xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n';
  xml += ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';

  // Evidence sheet
  if (evidenceMeta) {
    xml += '<Worksheet ss:Name="Evidence"><Table>\n';
    for (const [k, v] of Object.entries(evidenceMeta)) {
      xml += `<Row><Cell><Data ss:Type="String">${xmlEsc(k)}</Data></Cell><Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell></Row>\n`;
    }
    xml += "</Table></Worksheet>\n";
  }

  xml += '<Worksheet ss:Name="Data"><Table>\n';
  xml += "<Row>";
  keys.forEach(k => { xml += `<Cell><Data ss:Type="String">${xmlEsc(k)}</Data></Cell>`; });
  xml += "</Row>\n";
  scrapedData.forEach(row => {
    xml += "<Row>";
    keys.forEach(k => {
      xml += `<Cell><Data ss:Type="String">${xmlEsc(row[k] || "")}</Data></Cell>`;
    });
    xml += "</Row>\n";
  });
  xml += "</Table></Worksheet></Workbook>";
  downloadFile(xml, "data-dump.xls", "application/vnd.ms-excel");
});

// ── Export: XML ──
document.getElementById("btn-xml").addEventListener("click", () => {
  if (!scrapedData.length) return;
  const keys = Object.keys(scrapedData[0]);

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<data>\n';
  xml += evidenceHeader("xml");
  xml += "  <rows>\n";
  scrapedData.forEach(row => {
    xml += "    <row>\n";
    keys.forEach(k => {
      const tag = k.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1");
      xml += `      <${tag}>${xmlEsc(row[k] || "")}</${tag}>\n`;
    });
    xml += "    </row>\n";
  });
  xml += "  </rows>\n</data>";
  downloadFile(xml, "data-dump.xml", "application/xml");
});

function xmlEsc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Export: JSON ──
document.getElementById("btn-json").addEventListener("click", () => {
  if (!scrapedData.length) return;
  let output;
  if (scanResults) {
    // Full scan — export all categories
    const cats = {};
    for (const [k, v] of Object.entries(scanResults)) {
      if (k !== "All") cats[k] = v;
    }
    output = {
      ...(evidenceMeta ? { evidence: evidenceMeta } : {}),
      ...cats,
    };
  } else {
    output = {
      ...(evidenceMeta ? { evidence: evidenceMeta } : {}),
      data: scrapedData,
    };
  }
  downloadFile(JSON.stringify(output, null, 2), "data-dump.json", "application/json");
});

// ── Export: Copy to clipboard ──
document.getElementById("btn-copy").addEventListener("click", () => {
  if (!scrapedData.length) return;
  const keys = Object.keys(scrapedData[0]);
  const lines = [];
  if (evidenceMeta) {
    lines.push(`Source: ${evidenceMeta.sourceUrl}`);
    lines.push(`Captured: ${evidenceMeta.capturedAt}`);
    lines.push(`SHA-256: ${evidenceMeta.sha256}`);
    lines.push("");
  }
  lines.push(keys.join("\t"));
  scrapedData.forEach(row => {
    lines.push(keys.map(k => row[k] || "").join("\t"));
  });
  navigator.clipboard.writeText(lines.join("\n")).then(() => {
    showStatus("Copied to clipboard", "success");
  });
});

// ── Download helper ──
async function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  // Convert to data URL — blob URLs from popup context fail in Firefox downloads API
  const dataUrl = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
  try {
    await browser.downloads.download({ url: dataUrl, filename, saveAs: true });
  } catch {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// ── Init ──
(async () => {
  await restoreState();
  const found = await consumePendingSelectors();
  if (!found) {
    startPolling();
    setTimeout(() => {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }, 10000);
  }
})();
