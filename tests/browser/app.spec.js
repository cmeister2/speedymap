import { test, expect } from "@playwright/test";

async function stubBasemapTiles(page) {
  // Basemap tiles are external presentation only; keep verification deterministic.
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lD8AAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
}

// This exercises the committed UK database and compiled worker, including a
// repository subpath like GitHub Pages. No routing or graph responses are mocked.
test("UK routes, road labels, mode comparison, local search, GPX, sharing and mobile layout", async ({
  page,
}, testInfo) => {
  const errors = [],
    graphRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/graph-\d+(?:[.-][a-f0-9]+)?\.bin\.gz/.test(request.url()))
      graphRequests.push(request.url());
  });
  await stubBasemapTiles(page);
  await page.goto(
    "./?from=52.628600,1.292300&fromName=Norwich&to=52.573900,-0.242900&toName=Peterborough&mode=numbered",
  );
  await expect(page.locator("#status")).toContainText("Search");
  await expect(page.locator("#error")).toBeHidden();
  await page
    .getByRole("button", { name: "Find my route", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#results").hidden ||
      !document.querySelector("#error").hidden,
    null,
    { timeout: 120_000 },
  );
  expect(
    await page.locator("#error").isVisible(),
    await page.locator("#error").textContent(),
  ).toBe(false);
  await expect(page.locator("#results")).toBeVisible();
  await expect(page.locator("#route-button")).toBeEnabled();
  await expect(page.locator(".route-badge")).toHaveText("NUMBER LIMITS");
  // The optimal detour may leave the A47; assert a numbered road breakdown
  // rather than fixing the expected path independently of the actual data.
  await expect(page.locator(".road-table")).toContainText(/(?:A|B|M)\d+/);
  await page.locator("#more-segments").click();
  expect(await page.locator(".road-table tbody tr").count()).toBeGreaterThan(
    10,
  );
  const roadLabels = page.locator(".route-road-label");
  const numberedLabel = roadLabels.first();
  await expect(numberedLabel).toBeVisible();
  await expect(numberedLabel).toHaveText(/^(?:A|B|C|M|U)\s*\d+/i);
  await expect(numberedLabel).toHaveAttribute("role", "button");
  await expect(numberedLabel).toHaveAttribute("tabindex", "0");
  await expect(numberedLabel).toHaveAttribute("title", /.+/);
  await expect(numberedLabel).toHaveAttribute("data-mode", "numbered");
  const labelledRef = await numberedLabel.getAttribute("data-road-ref");
  expect(labelledRef).toBeTruthy();
  await expect(numberedLabel).toHaveAttribute(
    "aria-label",
    `View road details for ${labelledRef}`,
  );
  await expect(page.locator(".road-table")).toContainText(labelledRef);
  const roadDetail = page.locator(".route-road-detail");
  await numberedLabel.hover();
  await expect(roadDetail).toBeVisible();
  await expect(roadDetail).toContainText(labelledRef);
  await expect(roadDetail).toContainText("Your max");
  await expect(roadDetail).toContainText("Road limit");
  await expect(roadDetail).toContainText(/\d+(?:\.\d+)?\s*mph/);
  await page.screenshot({ path: testInfo.outputPath("road-labels.png") });
  await page.locator(".brand").hover();
  await expect(roadDetail).toBeHidden();
  await numberedLabel.click();
  await expect(roadDetail).toBeVisible();
  // Clicking a road shield opens its details without selecting a new endpoint.
  await expect(page.locator("#from-input")).toHaveValue("Norwich");
  await expect(page.locator("#to-input")).toHaveValue("Peterborough");
  await expect(page.locator("#results")).toBeVisible();
  await expect(page.locator(".comparison")).toContainText(
    "With normal speed limits",
  );
  expect(graphRequests.length).toBeGreaterThan(0);
  const initialGraphRequests = graphRequests.length;
  const numberedTime = await page.locator(".main-stat strong").textContent();
  await page.getByLabel("Normal limits", { exact: true }).check();
  await expect(page.locator(".route-badge")).toHaveText("NORMAL LIMITS");
  await expect(page.locator("#route-button")).toBeEnabled();
  expect(graphRequests.length).toBe(initialGraphRequests);
  await expect(page.locator("#comparison-key")).toHaveText(
    "Number limit route",
  );
  await expect(page.locator(".comparison")).toContainText(numberedTime);
  const normalLabel = roadLabels.first();
  await expect(normalLabel).toBeVisible();
  expect(
    await roadLabels.evaluateAll((labels) =>
      labels.every((label) => label.dataset.mode === "normal"),
    ),
  ).toBe(true);
  await normalLabel.hover();
  // Cached mode changes can finish before the previous tooltip's fade-out.
  await expect(roadDetail).toHaveCount(1);
  await expect(roadDetail).toBeVisible();
  await expect(roadDetail).toContainText("Normal max");
  await expect(roadDetail).toContainText("Road limit");
  await page.locator(".leaflet-control-zoom-in").click();
  await expect(roadLabels.first()).toBeVisible();
  await expect(roadLabels.first()).toHaveAttribute("data-mode", "normal");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download GPX" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe(
    "speedymap-journey.gpx",
  );
  await page.locator("#result-share").click();
  expect(new URL(page.url()).searchParams.get("mode")).toBe("normal");
  expect(new URL(page.url()).searchParams.get("fromName")).toBe("Norwich");
  await page.locator("#from-input").fill("Cambridge");
  await expect(roadLabels).toHaveCount(0);
  await expect(roadDetail).toBeHidden();
  await expect(page.locator("#from-suggestions")).toBeVisible();
  await page.locator("#from-input").press("ArrowDown");
  await page.locator("#from-input").press("Enter");
  await expect(page.locator("#from-input")).toHaveValue("Cambridge");
  await expect(page.locator("#results")).toBeHidden();
  await page.getByRole("button", { name: "How it works" }).click();
  await expect(page.locator("dialog")).toBeVisible();
  await expect(page.locator("#dataset-details")).toContainText(
    "Northern Ireland",
  );
  await page.getByRole("button", { name: "Close explanation" }).click();
  let releasePostcode;
  const heldPostcode = new Promise((resolve) => {
    releasePostcode = resolve;
  });
  await page.route("https://api.postcodes.io/postcodes/**", async (route) => {
    await heldPostcode;
    await route.fulfill({
      json: {
        status: 200,
        result: { postcode: "SW1A 1AA", latitude: 51.5014, longitude: -0.1419 },
      },
    });
  });
  await page.locator("#from-input").fill("SW1A 1AA");
  const postcodeRequest = page.waitForRequest((request) =>
    request.url().includes("api.postcodes.io"),
  );
  await page
    .getByRole("button", { name: "Find my route", exact: true })
    .click();
  await postcodeRequest;
  await page.getByRole("button", { name: "Cancel calculation" }).click();
  await page.locator("#from-input").fill("Norwich");
  const postcodeResponse = page.waitForResponse((response) =>
    response.url().includes("api.postcodes.io"),
  );
  releasePostcode();
  await postcodeResponse;
  await expect(page.locator("#from-input")).toHaveValue("Norwich");
  await expect(page.locator("#results")).toBeHidden();
  await expect(page.locator("#error")).toBeHidden();
  await page.getByLabel("Road number limits", { exact: true }).check();
  for (const [example, from, to] of [
    ["m1", "Nottingham", "Sheffield"],
    ["a1", "Doncaster", "Newcastle upon Tyne"],
  ]) {
    // Editing an endpoint makes the example picker available again.
    await page.locator("#from-input").fill("52.9534193, -1.1496461");
    await page.locator(`[data-example="${example}"]`).click();
    await expect(page.locator("#from-input")).toHaveValue(from);
    await expect(page.locator("#to-input")).toHaveValue(to);
    await page
      .getByRole("button", { name: "Find my route", exact: true })
      .click();
    await expect(page.locator("#results")).toBeVisible();
    await expect(page.locator("#route-button")).toBeEnabled();
    await expect(page.locator("#error")).toBeHidden();
    await expect(page.locator(".route-badge")).toHaveText("NUMBER LIMITS");
    await expect(page.locator("#map-state")).toHaveText(`${from} → ${to}`);
    await expect(roadLabels.first()).toBeVisible();
  }
  const numberOnlyToggle = page.locator("#number-only-toggle");
  await numberOnlyToggle.check();
  await expect(page.locator(".route-badge")).toHaveText("ROAD NUMBER SPEEDS");
  await expect(page.locator("#results")).toBeVisible();
  await expect(page.locator("#route-button")).toBeEnabled();
  await expect(page.locator("#error")).toBeHidden();
  expect(graphRequests.length).toBe(initialGraphRequests);
  await expect(roadLabels.first()).toBeVisible();
  expect(
    await roadLabels.evaluateAll((labels) =>
      labels.every((label) => label.dataset.mode === "number-only"),
    ),
  ).toBe(true);
  await roadLabels.first().hover();
  await expect(roadDetail).toBeVisible();
  await expect(roadDetail).toContainText("Your max");
  await expect(roadDetail).toContainText(/\d+(?:\.\d+)?\s*mph/);
  await page.screenshot({
    path: testInfo.outputPath("road-number-speeds.png"),
  });
  await page.locator("#result-share").click();
  expect(new URL(page.url()).searchParams.get("numberOnly")).toBe("1");
  await numberOnlyToggle.uncheck();
  await expect(page.locator(".route-badge")).toHaveText("NUMBER LIMITS");
  await expect(page.locator("#route-button")).toBeEnabled();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#status")).toContainText(/Cached journey/i);
  expect(graphRequests.length).toBe(initialGraphRequests);
  await expect(roadLabels.first()).toBeVisible();
  expect(
    await roadLabels.evaluateAll((labels) =>
      labels.every((label) => label.dataset.mode === "numbered"),
    ),
  ).toBe(true);
  await page.locator("#result-share").click();
  expect(new URL(page.url()).searchParams.get("numberOnly")).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator("#route-button")).toBeVisible();
  await expect(roadLabels.first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("road-labels-mobile.png"),
    fullPage: true,
  });
  // A calculated journey also survives a fresh page and its new worker.
  await page.reload();
  await expect(page.locator("#results")).toBeVisible();
  await expect(page.locator("#route-button")).toBeEnabled();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#from-input")).toHaveValue("Doncaster");
  await expect(page.locator("#to-input")).toHaveValue("Newcastle upon Tyne");
  await expect(page.locator(".route-badge")).toHaveText("NUMBER LIMITS");
  await expect(roadLabels.first()).toBeVisible();
  await expect(page.locator("#status")).toContainText(/Cached journey/i);
  expect(graphRequests.length).toBe(initialGraphRequests);
  expect(errors).toEqual([]);
});

test("default London to Edinburgh opens and persists without loading the routing graph", async ({
  page,
}, testInfo) => {
  const errors = [],
    graphRequests = [],
    defaultRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/graph-\d+(?:[.-][a-f0-9]+)?\.bin\.gz/.test(request.url()))
      graphRequests.push(request.url());
    if (/\/default-route\.json\.gz(?:\?|$)/.test(request.url()))
      defaultRequests.push(request.url());
  });
  await stubBasemapTiles(page);
  await page.goto("./");
  await expect(page.locator("#results")).toBeVisible();
  await expect(page.locator("#route-button")).toBeEnabled();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#from-input")).toHaveValue("London");
  await expect(page.locator("#to-input")).toHaveValue("Edinburgh");
  await expect(page.locator("#number-only-toggle")).toBeChecked();
  await expect(page.locator(".route-badge")).toHaveText("ROAD NUMBER SPEEDS");
  await expect(page.locator(".comparison")).toContainText(
    "With normal speed limits",
  );
  await expect(page.locator(".route-road-label").first()).toBeVisible();
  await expect(page.locator("#status")).toContainText(/Cached journey/i);
  expect(graphRequests).toEqual([]);
  expect(defaultRequests).toHaveLength(1);
  await page.screenshot({
    path: testInfo.outputPath("default-london-edinburgh.png"),
  });

  // The bundle includes the normal comparison, so switching which route is
  // primary also needs no graph download or calculation.
  await page.getByLabel("Normal limits", { exact: true }).check();
  await expect(page.locator(".route-badge")).toHaveText("NORMAL LIMITS");
  await expect(page.locator(".comparison")).toContainText(
    "With road number speeds",
  );
  await expect(page.locator(".route-road-label").first()).toHaveAttribute(
    "data-mode",
    "normal",
  );
  await expect(page.locator("#status")).toContainText(/Cached journey/i);
  expect(graphRequests).toEqual([]);
  await page.getByLabel("Road number limits", { exact: true }).check();
  await expect(page.locator(".route-badge")).toHaveText("ROAD NUMBER SPEEDS");
  await expect(page.locator(".route-road-label").first()).toHaveAttribute(
    "data-mode",
    "number-only",
  );
  await expect(page.locator("#status")).toContainText(/Cached journey/i);
  expect(graphRequests).toEqual([]);

  // Reload with the bundled result unavailable to prove IndexedDB reuse rather
  // than an HTTP-cache hit, without mocking any routing result or graph file.
  const requestsBeforeReload = defaultRequests.length;
  await page.route("**/default-route.json.gz*", (route) => route.abort());
  await page.reload();
  await expect(page.locator("#results")).toBeVisible();
  await expect(page.locator("#route-button")).toBeEnabled();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#from-input")).toHaveValue("London");
  await expect(page.locator("#to-input")).toHaveValue("Edinburgh");
  await expect(page.locator("#number-only-toggle")).toBeChecked();
  await expect(page.locator(".route-badge")).toHaveText("ROAD NUMBER SPEEDS");
  await expect(page.locator(".route-road-label").first()).toBeVisible();
  await expect(page.locator("#status")).toContainText(/Cached journey/i);
  expect(defaultRequests).toHaveLength(requestsBeforeReload);
  expect(graphRequests).toEqual([]);
  expect(errors).toEqual([]);
});
