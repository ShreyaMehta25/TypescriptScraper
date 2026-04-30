import { chromium, Page } from "playwright";
import * as cheerio from "cheerio";
import * as fs from "fs";
import { URL } from "url";

function getInternalLinks(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  domain: string
): string[] {
  const links = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#")) return;

    try {
      const full = new URL(href, baseUrl).href;
      const parsed = new URL(full);
      if (parsed.hostname === domain) {
        links.add(full);
      }
    } catch {}
  });

  return [...links];
}

function cleanText($: cheerio.CheerioAPI): string {
  $("script, style, nav, footer, header").remove();
  return $("body")
    .text()
    .replace(/\s+/g, " ")
    .trim();
}

async function scrollPage(page: Page, times: number = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(1000);
  }
}

export async function scrapeSite(
  url: string,
  outputPath: string,
  useScroll: boolean = false
): Promise<void> {
  const domain = new URL(url).hostname;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Scraping: ${url}`);
  console.log(`  Method:   ${useScroll ? "scroll" : "basic"}`);
  console.log(`  Output:   ${outputPath}`);
  console.log(`${"=".repeat(60)}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const lines: string[] = [];

  try {
    // --- Scrape start page ---
    console.log("  Scraping start page...");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    if (useScroll) {
      await scrollPage(page);
    }

    let html = await page.content();
    let $ = cheerio.load(html);
    let text = cleanText($);

    lines.push(`# ${url}\n\n${text}\n\n`);

    // --- Get internal links ---
    const links = getInternalLinks($, url, domain);
    console.log(`  Found ${links.length} internal links`);

    // --- Scrape each link ---
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      console.log(`  [${i + 1}/${links.length}] ${link}`);

      try {
        await page.goto(link, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        html = await page.content();
        $ = cheerio.load(html);
        text = cleanText($);

        lines.push(`# ${link}\n\n${text}\n\n`);
        await page.waitForTimeout(1000);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  Error: ${msg}`);
      }
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(outputPath, lines.join(""), "utf-8");
  console.log(`  Done → ${outputPath}`);
}
