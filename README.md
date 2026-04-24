# Data Dumper

Data Dumper is a browser extension built for extracting structured data from web pages, aiding investigators in their research. It handles static content, JavaScript-rendered pages, paginated listings, and infinite scroll feeds. Beyond general-purpose scraping, it includes a suite of OSINT tools for reconnaissance and evidence collection.

The extension ships in two versions: one for Firefox (Manifest V2) and one for Chrome (Manifest V3). Both share the same feature set and UI.

---

## Getting Started

### Chrome

1. Navigate to `chrome://extensions`
2. Toggle **Developer mode** on in the top-right corner
3. Click **Load unpacked** and select the `chrome/` directory from this repository

### Firefox

1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the `firefox/manifest.json` file from this repository

Once loaded, the Data Dumper icon appears in the browser toolbar. Click it to open the popup interface.

---

## What It Does

### Scraping

The scraper operates in two modes. **Full Page Scan** runs all extractors at once and returns categorized results without any manual setup. For more targeted extraction, **Manual Selection** lets you click elements on the page to define data columns, then configure how the scraper navigates the site.

Navigation strategies include:

| Mode | Description |
|------|-------------|
| Single Page | Extracts data from the current page only |
| Pagination | Follows a "Next" button across multiple pages, collecting and deduplicating as it goes |
| Infinite Scroll | Scrolls to the bottom of the page repeatedly, waiting for new content to load between each scroll |

The scraper waits for dynamically loaded content to settle before extracting, using a MutationObserver that watches for DOM changes. Once mutations stop for 800ms, the page is considered stable.

Extracted columns can be renamed, reordered, or disabled before export.

### OSINT Tools

The OSINT tab provides standalone tools that work independently of the scraper:

**Entity Extraction** scans the page text and HTML source for structured data using regex patterns. Supported entity types are email addresses, phone numbers, URLs, social media handles, IPv4/IPv6 addresses, and cryptocurrency wallet addresses (Bitcoin and Ethereum). The extractor includes filters to prevent false positives, such as rejecting IP-shaped strings from phone results and validating IP octet ranges.

**Link Harvester** collects all anchor elements on the page and classifies them as internal, external, mailto, or tel links. Results are sorted by domain.

**Table Detection** finds all HTML tables on the page, reports their dimensions, and lets you extract any of them into structured rows with a single click.

**Image Extraction** pulls all image elements with their source URL, alt text, and natural dimensions. Optional filters exclude small images (under 50px) or images without alt text.

**Page Snapshot** captures the full page HTML and a visible-area screenshot simultaneously. Both files are timestamped and the HTML includes a SHA-256 hash of the content for integrity verification.

### Evidence Chain

When enabled, every export includes metadata about the capture: the source URL, page title, timestamp, SHA-256 content hash, and user agent string. This applies across all export formats and provides a basic chain of custody for collected data.

---

## Export Formats

All extracted data can be exported in the following formats:

| Format | Details |
|--------|---------|
| CSV | Standard comma-separated values with proper quoting and escaping |
| Excel | XML Spreadsheet format (`.xls`) compatible with Excel and LibreOffice. Includes a separate Evidence sheet when evidence chain is enabled |
| XML | Structured XML with row elements and tagged fields |
| JSON | Raw JSON with optional evidence metadata. Full page scans export all categories as separate keys |
| Clipboard | Tab-separated text copied directly to the clipboard for pasting into spreadsheets |

---

## Repository Layout

```
chrome/           Chrome extension (Manifest V3)
  manifest.json   Extension manifest with service worker background
  background.js   Service worker for message forwarding
  content.js      Content script injected into all pages
  content.css     Highlight and selector bar styles
  popup/          Popup UI (HTML, CSS, JS)
  icons/          Extension icons (16, 48, 96, 128px)

firefox/          Firefox extension (Manifest V2)
  manifest.json   Extension manifest with event page background
  background.js   Background script for message forwarding
  content.js      Content script injected into all pages
  content.css     Highlight and selector bar styles
  popup/          Popup UI (HTML, CSS, JS)
  icons/          Extension icons (16, 48, 96, 128px)
```

The Chrome and Firefox versions are functionally identical. The differences are limited to the manifest format (V3 vs V2), the background script type (service worker vs event page), and API namespace (`chrome.*` vs `browser.*`).

---

## Who This Is For

Data Dumper is designed for researchers, analysts, and investigators who need to pull structured data from websites quickly without writing custom scripts. Typical workflows include:

- Collecting contact information from directories and professional association sites
- Gathering product pricing and review data from e-commerce platforms
- Extracting search engine results for analysis
- Harvesting links and entities for OSINT investigations
- Capturing page snapshots with integrity hashes for evidence preservation
- Building lead lists from public-facing business pages

---

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
