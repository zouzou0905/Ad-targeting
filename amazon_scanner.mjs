import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { chromium } from "playwright";

const FIXED_SCAN_PAGES = 3;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "headless" || key === "no-setup") {
      args[key] = true;
    } else {
      args[key] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function normalizeBaseUrl(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  return `${url.protocol}//${url.host}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ask(rl, message) {
  if (!rl) return Promise.resolve("");
  return new Promise((resolve) => rl.question(message, resolve));
}

async function detectCaptcha(page) {
  const title = await page.title().catch(() => "");
  if (/robot check|captcha/i.test(title)) return true;
  return page
    .locator('form[action*="validateCaptcha"], input#captchacharacters')
    .first()
    .isVisible()
    .catch(() => false);
}

async function waitForCaptcha(page, rl) {
  while (await detectCaptcha(page)) {
    if (!rl) throw new Error("Amazon returned a CAPTCHA/Robot Check page.");
    console.log("\n检测到亚马逊验证码。请在浏览器中完成验证。完成后回到此窗口。\n");
    await ask(rl, "完成后按 Enter 继续：");
    await page.waitForTimeout(2500);
  }
}

async function navigateWithRetry(page, url, label, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const status = response?.status() || 0;
      if (status >= 500) throw new Error(`HTTP ${status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      console.warn(
        `  ${label}打开失败（第 ${attempt}/${attempts} 次）：${error.message}，稍后自动重试……`,
      );
      await page.waitForTimeout(1500 * attempt);
      await page.goto("about:blank", { waitUntil: "commit", timeout: 10000 }).catch(() => null);
    }
  }
  throw new Error(`${label}连续 ${attempts} 次打开失败：${lastError?.message || "未知网络错误"}`);
}

async function readPageMetrics(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#search") || document;
    const validAsin = (value) => /^[A-Z0-9]{10}$/.test((value || "").trim().toUpperCase());
    const dataAsins = Array.from(root.querySelectorAll("[data-asin]"))
      .map((node) => (node.getAttribute("data-asin") || "").trim().toUpperCase())
      .filter(validAsin);
    const linkAsins = Array.from(root.querySelectorAll("a"))
      .map((link) => {
        const href = (link.href || "").toUpperCase();
        const suffix = href.split("/DP/")[1] || "";
        return suffix.slice(0, 10);
      })
      .filter(validAsin);
    return {
      standardCards: root.querySelectorAll(
        '[data-component-type="s-search-result"][data-asin]',
      ).length,
      uniqueDataAsins: new Set(dataAsins).size,
      uniqueProductLinkAsins: new Set(linkAsins).size,
      scrollHeight: document.body.scrollHeight,
    };
  });
}

async function loadSearchPage(page, url, rl) {
  await navigateWithRetry(page, url, "Amazon 搜索页");
  await waitForCaptcha(page, rl);

  await Promise.race([
    page.waitForSelector('[data-component-type="s-search-result"][data-asin]', {
      timeout: 20000,
    }),
    page.waitForSelector('#search [data-asin]', { timeout: 20000 }),
  ]).catch(() => null);

  await page.evaluate(async () => {
    const distance = Math.max(450, Math.floor(window.innerHeight * 0.7));
    let y = 0;
    while (y < document.body.scrollHeight) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 350));
      y += distance;
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 1800));
  });

  let metrics = await readPageMetrics(page);
  let stableChecks = 0;
  for (let check = 0; check < 4 && stableChecks < 2; check += 1) {
    await page.waitForTimeout(1200);
    const nextMetrics = await readPageMetrics(page);
    const unchanged =
      nextMetrics.standardCards === metrics.standardCards &&
      nextMetrics.uniqueDataAsins === metrics.uniqueDataAsins &&
      nextMetrics.uniqueProductLinkAsins === metrics.uniqueProductLinkAsins &&
      nextMetrics.scrollHeight === metrics.scrollHeight;
    stableChecks = unchanged ? stableChecks + 1 : 0;
    metrics = nextMetrics;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);
  return { ...metrics, stabilized: stableChecks >= 2 };
}

async function extractCards(page) {
  return page.evaluate(() => {
    const cleanText = (value) => (value || "").replace(/\s+/g, " ").trim();
    const root = document.querySelector("#search") || document;
    const validAsin = (value) => /^[A-Z0-9]{10}$/.test(cleanText(value).toUpperCase());
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    // 轮播位与推荐位的容器特征。这类模块的商品不是“一排 N 个”的搜索网格商品，
    // 混进来会把真实搜索顺位整体推后，因此一律排除在顺位之外。
    const CAROUSEL_SELECTOR = [
      ".a-carousel-card",
      ".a-carousel-viewport",
      "[data-a-carousel-options]",
      ".a-carousel",
    ].join(", ");

    // 主搜索网格商品卡片。只有这类卡片参与页内位置与总位置编号。
    const PRIMARY_GRID_SELECTOR = '[data-component-type="s-search-result"]';

    const isPrimaryGridCard = (card) => {
      if (card.closest(CAROUSEL_SELECTOR)) return false;
      return Boolean(card.closest(PRIMARY_GRID_SELECTOR));
    };

    const isSponsored = (card) => {
      const explicitSelectors = [
        '.s-sponsored-label-info-icon',
        '[aria-label="Sponsored"]',
        '[aria-label^="Sponsored"]',
        '[data-component-type="s-sponsored-label-marker"]',
        '[data-csa-c-ad-status]',
        '[data-ad-details]',
        '[aria-label*="Sponsored" i]',
        '[data-component-type="sp-sponsored-result"]',
        '[data-csa-c-cs-type="ads"]',
        '[class*="s-sponsored"]',
        '[class*="AdHolder"]',
      ];
      for (const selector of explicitSelectors) {
        if (card.matches(selector) || card.closest(selector) || card.querySelector(selector)) {
          return { sponsored: true, reason: selector };
        }
      }

      const classAndWidget = [
        card.className,
        card.getAttribute("data-cel-widget"),
        card.getAttribute("data-component-type"),
      ]
        .filter(Boolean)
        .join(" ");
      if (/\bAdHolder\b|s-sponsored|sponsored-products/i.test(classAndWidget)) {
        return { sponsored: true, reason: "card-attribute" };
      }

      const sponsoredLabel = /^(Sponsored|Gesponsert|Sponsorisé|Patrocinado|Sponsorizzato|スポンサー)(?:\s*\|.*)?$/i;
      const exactLabel = Array.from(card.querySelectorAll("span, a, div")).some((node) => {
        if (node.children.length > 0) return false;
        return sponsoredLabel.test(cleanText(node.textContent));
      });
      if (exactLabel) return { sponsored: true, reason: "visible-label" };

      return { sponsored: false, reason: "no-sponsored-marker" };
    };

    const candidates = [];
    const seenCards = new Set();
    for (const node of root.querySelectorAll("[data-asin]")) {
      const asin = cleanText(node.getAttribute("data-asin")).toUpperCase();
      if (!validAsin(asin)) continue;

      let card = node;
      for (let ancestor = node.parentElement; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
        if (cleanText(ancestor.getAttribute("data-asin")).toUpperCase() === asin) card = ancestor;
      }
      if (!isVisible(card) || seenCards.has(card)) continue;
      if (!isPrimaryGridCard(card)) continue;
      seenCards.add(card);
      candidates.push({ card, asin, seedLink: null });
    }

    for (const link of root.querySelectorAll("a")) {
      const href = (link.href || "").toUpperCase();
      const suffix = href.split("/DP/")[1] || "";
      const asin = suffix.slice(0, 10);
      if (!validAsin(asin) || !isVisible(link)) continue;
      if (candidates.some((candidate) => candidate.card.contains(link))) continue;

      const card =
        link.closest("li.a-carousel-card") ||
        link.closest('[role="listitem"]') ||
        link.closest(".s-result-item") ||
        link.closest('[data-csa-c-type="item"]') ||
        link.parentElement;
      if (!card || !isVisible(card) || seenCards.has(card)) continue;
      if (!isPrimaryGridCard(card)) continue;
      seenCards.add(card);
      candidates.push({ card, asin, seedLink: link });
    }

    candidates.sort((left, right) => {
      if (left.card === right.card) return 0;
      const position = left.card.compareDocumentPosition(right.card);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    return candidates
      .map(({ card, asin, seedLink }, index) => {
        const sponsorship = isSponsored(card);
        const titleNode = card.querySelector("h2") || card.querySelector('[data-cy="title-recipe"]');
        const linkNode =
          seedLink ||
          card.querySelector(`a[href*="/dp/${asin}"]`) ||
          card.querySelector('h2 a[href*="/dp/"]') ||
          card.querySelector('a[href*="/dp/"]');
        const href = linkNode?.href || "";
        return {
          asin,
          pagePosition: index + 1,
          sponsored: sponsorship.sponsored,
          sponsoredReason: sponsorship.reason,
          title: cleanText(titleNode?.innerText || titleNode?.textContent),
          url: href,
        };
      })
      .filter((card) => /^[A-Z0-9]{10}$/.test(card.asin));
  });
}

function createTargetResult(asin) {
  return {
    asin,
    found: false,
    adOccurrences: [],
    organicOccurrences: [],
  };
}

function positionsText(occurrences) {
  if (occurrences.length === 0) return "无";
  return occurrences
    .map(
      (item) =>
        `${item.typePosition}（第${item.page}页/页内${item.pagePosition}/总位置${item.overallPosition}）`,
    )
    .join("，");
}

function printTargetLogs(result) {
  for (const target of Object.values(result.targets)) {
    const adText = positionsText(target.adOccurrences);
    const organicText = positionsText(target.organicOccurrences);
    let status = "未找到";
    if (target.adOccurrences.length && target.organicOccurrences.length) status = "广告+自然";
    else if (target.adOccurrences.length) status = "广告位";
    else if (target.organicOccurrences.length) status = "自然位";

    console.log(`  ASIN ${target.asin}｜${status}｜广告排名：${adText}｜自然排名：${organicText}`);
    const occurrences = [...target.adOccurrences, ...target.organicOccurrences].sort(
      (left, right) => left.overallPosition - right.overallPosition,
    );
    if (occurrences[0]) {
      console.log(`    标题：${occurrences[0].title || "（未读取到标题）"}`);
      console.log(`    链接：${occurrences[0].url || "（未读取到链接）"}`);
    }
    if (target.adOccurrences.length) {
      const reasons = [...new Set(target.adOccurrences.map((item) => item.sponsoredReason))];
      console.log(`    广告识别依据：${reasons.join("，")}`);
    }
  }
}

function printFoundSummary(results) {
  console.log("\n========== 有位置的关键词和 ASIN 汇总 ==========");
  let foundCount = 0;
  for (const result of results) {
    for (const target of Object.values(result.targets || {})) {
      if (!target.found) continue;
      foundCount += 1;
      console.log(
        `关键词：${result.keyword}｜ASIN：${target.asin}｜` +
          `广告排名：${positionsText(target.adOccurrences)}｜` +
          `自然排名：${positionsText(target.organicOccurrences)}`,
      );
    }
  }
  if (foundCount === 0) console.log("本次扫描未发现有位置的关键词和 ASIN。");
  console.log(`汇总：共 ${foundCount} 组有位置的关键词/ASIN。`);
  console.log("================================================");
}

async function scanKeyword({ page, baseUrl, keyword, asins, rl }) {
  const targets = Object.fromEntries(asins.map((asin) => [asin, createTargetResult(asin)]));
  let overallPosition = 0;
  let adPosition = 0;
  let organicPosition = 0;
  let pagesScanned = 0;
  const pageSummaries = [];

  for (let pageNumber = 1; pageNumber <= FIXED_SCAN_PAGES; pageNumber += 1) {
    const searchUrl = new URL("/s", baseUrl);
    searchUrl.searchParams.set("k", keyword);
    if (pageNumber > 1) searchUrl.searchParams.set("page", String(pageNumber));

    const loadMetrics = await loadSearchPage(page, searchUrl.toString(), rl);
    const cards = await extractCards(page);
    pagesScanned = pageNumber;

    if (cards.length === 0) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (/no results|did not match any products/i.test(bodyText)) break;
      throw new Error(`第 ${pageNumber} 页未识别到商品卡片，页面结构可能已变化。`);
    }

    const sponsoredCount = cards.filter((card) => card.sponsored).length;
    pageSummaries.push({
      page: pageNumber,
      productCards: cards.length,
      sponsoredCards: sponsoredCount,
      organicCards: cards.length - sponsoredCount,
      standardCards: loadMetrics.standardCards,
      uniqueDataAsins: loadMetrics.uniqueDataAsins,
      uniqueProductLinkAsins: loadMetrics.uniqueProductLinkAsins,
      stabilized: loadMetrics.stabilized,
    });
    console.log(
      `  第 ${pageNumber} 页：计入 ${cards.length} 个商品位置，` +
        `广告 ${sponsoredCount}，自然 ${cards.length - sponsoredCount}；` +
        `标准结果 ${loadMetrics.standardCards}，可见唯一 ASIN ${loadMetrics.uniqueDataAsins}，` +
        `商品链接唯一 ASIN ${loadMetrics.uniqueProductLinkAsins}，` +
        `加载${loadMetrics.stabilized ? "已稳定" : "未完全稳定"}。`,
    );

    for (const card of cards) {
      overallPosition += 1;
      if (card.sponsored) adPosition += 1;
      else organicPosition += 1;

      const target = targets[card.asin];
      if (!target) continue;
      target.found = true;
      const occurrence = {
        page: pageNumber,
        pagePosition: card.pagePosition,
        overallPosition,
        typePosition: card.sponsored ? adPosition : organicPosition,
        title: card.title,
        url: card.url,
        sponsoredReason: card.sponsoredReason,
      };
      if (card.sponsored) target.adOccurrences.push(occurrence);
      else target.organicOccurrences.push(occurrence);
    }

    // Always scan all three pages. The same ASIN can appear as an ad on one
    // page and as an organic result on a later page.
  }

  return {
    keyword,
    pagesScanned,
    pageSummaries,
    targets,
    error: null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    throw new Error("Usage: node amazon_scanner.mjs --input tasks.json --output results.json");
  }

  const config = JSON.parse(await fs.readFile(args.input, "utf8"));
  const baseUrl = normalizeBaseUrl(config.baseUrl || "https://www.amazon.com");
  const maxPages = FIXED_SCAN_PAGES;
  const delaySeconds = Math.max(1, Number(config.delaySeconds || 4));
  const profileDir = path.resolve(config.profileDir || ".amazon-browser-profile");
  const headless = Boolean(args.headless || config.headless);

  await fs.mkdir(profileDir, { recursive: true });
  const launchOptions = {
    headless,
    viewport: headless ? { width: 1440, height: 1000 } : null,
    args: ["--disable-quic", ...(headless ? [] : ["--start-maximized"])],
  };
  if (config.chromeExecutable) launchOptions.executablePath = config.chromeExecutable;

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (error) {
    throw new Error(
      "无法启动工具专用浏览器。请先关闭之前由本工具打开的 Chrome 窗口，" +
        `再重新运行。原始错误：${error.message}`,
    );
  }
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  page.setDefaultTimeout(25000);

  const rl = headless
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stdout });

  const results = [];
  try {
    if (!args["no-setup"] && !headless) {
      try {
        await navigateWithRetry(page, baseUrl, "Amazon 首页");
      } catch (error) {
        console.warn(`\n自动打开 Amazon 首页失败：${error.message}`);
        console.warn(`请在已打开的 Chrome 地址栏中手动访问 ${baseUrl}。`);
      }
      console.log("\n浏览器已打开。请确认 Amazon 站点、配送邮编和登录状态。\n");
      await ask(rl, "确认完成后按 Enter 开始扫描：");
    }

    const total = config.tasks.length;
    for (let i = 0; i < total; i += 1) {
      const task = config.tasks[i];
      console.log(`\n[${i + 1}/${total}] 搜索：${task.keyword}（${task.asins.length} 个 ASIN）`);
      try {
        const result = await scanKeyword({
          page,
          baseUrl,
          keyword: task.keyword,
          asins: task.asins,
          rl,
        });
        results.push(result);
        const foundCount = Object.values(result.targets).filter((item) => item.found).length;
        console.log(`完成：找到 ${foundCount}/${task.asins.length}，扫描 ${result.pagesScanned} 页。`);
        printTargetLogs(result);
      } catch (error) {
        console.error(`失败：${error.message}`);
        results.push({
          keyword: task.keyword,
          pagesScanned: 0,
          pageSummaries: [],
          targets: Object.fromEntries(task.asins.map((asin) => [asin, createTargetResult(asin)])),
          error: error.message,
        });
      }

      if (i < total - 1) {
        const jitterMs = Math.floor(Math.random() * 1400);
        await sleep(delaySeconds * 1000 + jitterMs);
      }
    }

    printFoundSummary(results);

    await fs.writeFile(
      args.output,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          baseUrl,
          maxPages,
          results,
        },
        null,
        2,
      ),
      "utf8",
    );
  } finally {
    rl?.close();
    await context.close();
  }
}

main().catch((error) => {
  console.error(`\n扫描程序错误：${error.stack || error.message}`);
  process.exitCode = 1;
});
