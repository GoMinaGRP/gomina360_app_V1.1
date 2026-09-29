import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const CHROMIUM_PATH = "/tmp/al2023/chromium";

async function runAudit() {
  console.log("=== STARTING COMPREHENSIVE CUSTOMER ORDER PAGE AUDIT ===");
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition, name) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✓ PASS [${totalTests}]: ${name}`);
    } else {
      console.error(`  ✗ FAIL [${totalTests}]: ${name}`);
      throw new Error(`Assertion failed: ${name}`);
    }
  }

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. DESKTOP VIEWPORT AUDIT (1280x800)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n--- SECTION 1: DESKTOP AUDIT (1280x800) ---");
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1.1 Load /order page
    await page.goto("http://localhost:3000/order", { waitUntil: "networkidle0" });
    const title = await page.title();
    assert(title.length > 0, "Page loads successfully with a title");

    // 1.2 Header Elements
    const headerExists = await page.$('[data-testid="oo-header"]');
    assert(headerExists !== null, "Storefront header is rendered");

    const trackBtn = await page.$('[data-testid="oo-track-link"]');
    assert(trackBtn !== null, "Track order header button is present");

    const helpBtn = await page.$('[data-testid="oo-help"]');
    assert(helpBtn !== null, "Customer support / Help header button is present");

    // 1.3 Help Modal Open / Dismiss
    await page.click('[data-testid="oo-help"]');
    await page.waitForSelector('[data-testid="oo-help-modal"]', { timeout: 3000 });
    const helpPanelVisible = await page.$('[data-testid="oo-help-modal"]');
    assert(helpPanelVisible !== null, "Help modal opens on click");
    // Press Escape to dismiss
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 200));
    const helpPanelClosed = (await page.$('[data-testid="oo-help-modal"]')) === null;
    assert(helpPanelClosed, "Help modal dismisses cleanly with Escape key");

    // 1.4 Business Switcher & Catalogue Browsing
    // Pick the Poultry Farm branch (businessId 1)
    const bizChip = await page.$('[data-testid="oo-biz-1"]');
    assert(bizChip !== null, "Branch business chips are displayed");
    await page.click('[data-testid="oo-biz-1"]');
    await new Promise((r) => setTimeout(r, 400));

    // Check category chips
    const catChips = await page.$$('[data-testid^="oo-cat-"]');
    assert(catChips.length > 0, `Category filter chips are rendered (${catChips.length} found)`);

    // Check product cards
    const prodCards = await page.$$('[data-testid^="oo-prod-"]');
    assert(prodCards.length > 0, `Product cards are rendered (${prodCards.length} found)`);

    // 1.5 Cart Stepper and Quantity Management
    // Add product 1 to cart
    await page.click('[data-testid="oo-add-1"]');
    await page.waitForSelector('[data-testid="oo-header-cart-count"]', { timeout: 3000 });

    // Cart counter in header should show 1
    const cartBadge = await page.$eval('[data-testid="oo-header-cart-count"]', (el) => el.textContent.trim());
    assert(cartBadge === "1", `Cart header counter displays 1 (got: ${cartBadge})`);

    // Stepper + button
    await page.waitForSelector('[data-testid="oo-plus-1"]', { timeout: 3000 });
    await page.$eval('[data-testid="oo-plus-1"]', (el) => el.click());
    await new Promise((r) => setTimeout(r, 300));
    const cartBadge2 = await page.$eval('[data-testid="oo-header-cart-count"]', (el) => el.textContent.trim());
    assert(cartBadge2 === "2", `Cart header counter displays 2 after plus tap (got: ${cartBadge2})`);

    // Stepper typed input
    const qtyInput = await page.$('[data-testid="oo-qty-1"]');
    assert(qtyInput !== null, "Direct quantity input box exists");
    await page.$eval('[data-testid="oo-qty-1"]', (el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "5");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
    });
    await new Promise((r) => setTimeout(r, 200));
    const cartBadge5 = await page.$eval('[data-testid="oo-header-cart-count"]', (el) => el.textContent.trim());
    assert(cartBadge5 === "5", `Cart header counter updates to 5 after typing (got: ${cartBadge5})`);

    // 1.6 Fulfillment Toggle (Delivery vs Pickup)
    const delivTab = await page.$('[data-testid="oo-delivery"]');
    const pickupTab = await page.$('[data-testid="oo-pickup"]');
    assert(delivTab !== null && pickupTab !== null, "Delivery and Pickup options are both present");

    // 1.7 Delivery Address & Map Pin Synchronization
    // Click Delivery option
    await page.click('[data-testid="oo-delivery"]');
    await new Promise((r) => setTimeout(r, 200));

    // Check Address Autocomplete input
    const addrInput = await page.$('[data-testid="oo-dest-input"]');
    assert(addrInput !== null, "Delivery Address Autocomplete input is rendered");

    // Check Map Container rendered
    const mapRoot = await page.$('[data-testid="oo-pin-root"]');
    assert(mapRoot !== null, "LocationPinPicker root is rendered");

    // Test Map Style Toggle (Standard vs Satellite)
    const satBtn = await page.$('[data-testid="oo-pin-style-sat"]');
    assert(satBtn !== null, "Satellite map style toggle button is present");
    await satBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    const isSatActive = await page.$eval('[data-testid="oo-pin-style-sat"]', (el) => el.classList.contains("bg-cyan-500"));
    assert(isSatActive, "Map style successfully switched to SATELLITE");

    const stdBtn = await page.$('[data-testid="oo-pin-style-std"]');
    await stdBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    const isStdActive = await page.$eval('[data-testid="oo-pin-style-std"]', (el) => el.classList.contains("bg-cyan-500"));
    assert(isStdActive, "Map style successfully switched back to STANDARD");

    // Test Zoom buttons
    const zoomInBtn = await page.$('[data-testid="oo-pin-zoom-in"]');
    const zoomOutBtn = await page.$('[data-testid="oo-pin-zoom-out"]');
    assert(zoomInBtn !== null && zoomOutBtn !== null, "Zoom In and Zoom Out controls are present");
    await zoomInBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    // Test Manual Coordinates Entry
    const manualToggle = await page.$('[data-testid="oo-pin-manual-toggle"]');
    assert(manualToggle !== null, "Enter coordinates toggle link is present");
    await manualToggle.click();
    await new Promise((r) => setTimeout(r, 150));

    const latInput = await page.$('[data-testid="oo-pin-manual-lat"]');
    const lngInput = await page.$('[data-testid="oo-pin-manual-lng"]');
    const applyCoordsBtn = await page.$('[data-testid="oo-pin-manual-apply"]');
    assert(latInput !== null && lngInput !== null && applyCoordsBtn !== null, "Manual coordinate inputs and Set button are visible");

    // Enter a delivery coordinate in Accra: 5.6100, -0.1900
    await latInput.click({ clickCount: 3 });
    await latInput.type("5.610000");
    await lngInput.click({ clickCount: 3 });
    await lngInput.type("-0.190000");
    await applyCoordsBtn.click();
    await new Promise((r) => setTimeout(r, 500));

    const coordsDisplay = await page.$eval('[data-testid="oo-pin-coords"]', (el) => el.textContent.trim());
    assert(coordsDisplay.includes("5.610000") && coordsDisplay.includes("-0.190000"), `Pin coordinates successfully updated manually (${coordsDisplay})`);

    // Test Nudge arrows with step size
    const stepSelect = await page.$('[data-testid="oo-pin-step"]');
    assert(stepSelect !== null, "Step size selector is present");
    await page.select('[data-testid="oo-pin-step"]', "25");

    const northBtn = await page.$('[data-testid="oo-pin-n"]');
    assert(northBtn !== null, "Nudge North button is present");
    await northBtn.click();
    await new Promise((r) => setTimeout(r, 300));

    const nudgedCoords = await page.$eval('[data-testid="oo-pin-coords"]', (el) => el.textContent.trim());
    assert(nudgedCoords !== coordsDisplay, `Pin coordinates changed after nudging North (${nudgedCoords})`);

    // 1.8 Form Validation and Order Submission
    const nameInput = await page.$('[data-testid="oo-name"]');
    const phoneInput = await page.$('[data-testid="oo-phone"]');
    const placeOrderBtn = await page.$('[data-testid="oo-place"]');
    assert(nameInput !== null && phoneInput !== null && placeOrderBtn !== null, "Customer name, phone, and Place Order button exist");

    // Try submitting without name and phone
    await page.$eval('[data-testid="oo-place"]', (el) => el.click());
    await page.waitForSelector('[data-testid="oo-error"]', { timeout: 3000 });
    const err1 = await page.$eval('[data-testid="oo-error"]', (el) => el.textContent.trim());
    assert(err1.includes("Please enter your name"), `Name validation triggered (${err1})`);

    // Fill name and invalid phone
    await nameInput.type("Kofi Mensah");
    await phoneInput.type("123");
    await page.$eval('[data-testid="oo-place"]', (el) => el.click());
    await page.waitForSelector('[data-testid="oo-error"]', { timeout: 3000 });
    const err2 = await page.$eval('[data-testid="oo-error"]', (el) => el.textContent.trim());
    assert(err2.includes("10 digits") || err2.includes("Phone"), `Phone validation triggered for short number (${err2})`);

    // Correct phone number (10 Ghana digits)
    await page.$eval('[data-testid="oo-phone"]', (el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "0244123456");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Ensure Destination address is filled
    await page.$eval('[data-testid="oo-dest-input"]', (el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "House 14, Ring Road Central, Nima, Accra");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Select Pay On Delivery
    const codRadio = await page.$('[data-testid="oo-pay-cod"]');
    if (codRadio) await codRadio.click();

    // Place the order!
    await page.$eval('[data-testid="oo-place"]', (el) => el.click());
    await page.waitForSelector('[data-testid="oo-success"]', { timeout: 8000 });
    assert(true, "Order successfully placed and confirmation screen is displayed");

    // Verify confirmation details
    const orderCode = await page.$eval('[data-testid="oo-code"]', (el) => el.textContent.trim());
    assert(orderCode.length > 0, `Order confirmation code generated: ${orderCode}`);

    const trackLink = await page.$('[data-testid="oo-track-my-order"]');
    assert(trackLink !== null, "Tracking link is present on confirmation screen");

    const confMap = await page.$('[data-testid="oo-success-map"]');
    assert(confMap !== null, "Delivery point mini-map is rendered on confirmation screen");

    await page.close();

    // ═══════════════════════════════════════════════════════════════════════
    // 2. MOBILE VIEWPORT AUDIT (390x844 - iPhone / Smartphone)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n--- SECTION 2: MOBILE AUDIT (390x844) ---");
    const mPage = await browser.newPage();
    await mPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

    await mPage.goto("http://localhost:3000/order", { waitUntil: "networkidle0" });

    // Verify mobile header
    const mHeader = await mPage.$('[data-testid="oo-header"]');
    assert(mHeader !== null, "Mobile header rendered properly");

    // Select a business
    await mPage.click('[data-testid="oo-biz-1"]');
    await new Promise((r) => setTimeout(r, 400));

    // Add item to cart
    await mPage.click('[data-testid="oo-add-1"]');
    await new Promise((r) => setTimeout(r, 200));

    // Switch to delivery on mobile
    await mPage.click('[data-testid="oo-delivery"]');
    await new Promise((r) => setTimeout(r, 200));

    // Check delivery address field on mobile
    const mAddrInput = await mPage.$('[data-testid="oo-dest-input"]');
    assert(mAddrInput !== null, "Mobile address autocomplete input is rendered");

    // Check mobile map container and style controls
    const mMap = await mPage.$('[data-testid="oo-pin-root"]');
    assert(mMap !== null, "Mobile LocationPinPicker map is rendered");

    const mSat = await mPage.$('[data-testid="oo-pin-style-sat"]');
    const mStd = await mPage.$('[data-testid="oo-pin-style-std"]');
    assert(mSat !== null && mStd !== null, "Mobile Standard / Satellite toggle buttons present");

    // Drop pin and fill customer details on mobile
    const mDropPin = await mPage.$('[data-testid="oo-pin-set"]');
    if (mDropPin) {
      await mDropPin.click();
      await new Promise((r) => setTimeout(r, 300));
    }

    await mPage.$eval('[data-testid="oo-name"]', (el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "Ama Serwaa");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await mPage.$eval('[data-testid="oo-phone"]', (el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "0551234567");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await mPage.$eval('[data-testid="oo-dest-input"]', (el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "Plot 8, Airport Hills, East Legon");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Place mobile order
    await mPage.$eval('[data-testid="oo-place"]', (el) => el.click());
    await mPage.waitForSelector('[data-testid="oo-success"]', { timeout: 8000 });
    assert(true, "Mobile order submission successful and confirmation card displayed");

    const mCode = await mPage.$eval('[data-testid="oo-code"]', (el) => el.textContent.trim());
    assert(mCode.length > 0, `Mobile confirmation code generated: ${mCode}`);

    await mPage.close();

    console.log(`\n========================================`);
    console.log(`AUDIT COMPLETE: ${passedTests}/${totalTests} TESTS PASSED WITH 100% SUCCESS.`);
    console.log(`========================================\n`);
  } finally {
    await browser.close();
  }
}

runAudit().catch((err) => {
  console.error("Audit failed with error:", err);
  process.exit(1);
});
