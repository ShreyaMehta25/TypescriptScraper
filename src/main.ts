import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { scrapeSite } from "./scraper";
import { convertMdToJson } from "./converter";
import { SiteConfig, Grant } from "./types";

// Load .env from project root
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const SITES_FILE = path.join(__dirname, "..", "sites.json");
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const MD_DIR = path.join(OUTPUT_DIR, "md");
const JSON_DIR = path.join(OUTPUT_DIR, "json");
const FINAL_OUTPUT = path.join(JSON_DIR, "all_grants.json");

async function run(): Promise<void> {
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace(/[T:]/g, "-");

  console.log(`\n${"#".repeat(60)}`);
  console.log(`  SCRAPER RUN — ${timestamp}`);
  console.log(`${"#".repeat(60)}`);

  fs.mkdirSync(MD_DIR, { recursive: true });
  fs.mkdirSync(JSON_DIR, { recursive: true });

  const allSites: SiteConfig[] = JSON.parse(
    fs.readFileSync(SITES_FILE, "utf-8")
  );

  const args = process.argv;
  const scrapeOnly = args.includes("--scrape-only");
  const convertOnly = args.includes("--convert-only");
  const runAll = args.includes("--all");

  // Determine which day to run
  const dayArg = args.find((a) => a.startsWith("--day="));
  let today: number | null;

  if (runAll) {
    today = null;
  } else if (dayArg) {
    today = parseInt(dayArg.split("=")[1], 10);
  } else {
    today = now.getDate();
  }

  // Filter sites for today
  const sites = runAll
    ? allSites
    : allSites.filter((s) => s.day === today);

  if (sites.length === 0) {
    console.log(`\n  No sites scheduled for day ${today}. Nothing to do.`);
    console.log(`  Use --all to run all sites, or --day=N to pick a day.\n`);
    return;
  }

  console.log(
    `\n  Day: ${today ?? "ALL"} — Running ${sites.length}/${allSites.length} sites\n`
  );

  // Load existing grants from previous runs
  let existingGrants: Grant[] = [];
  if (fs.existsSync(FINAL_OUTPUT)) {
    try {
      existingGrants = JSON.parse(fs.readFileSync(FINAL_OUTPUT, "utf-8"));
      console.log(
        `  Loaded ${existingGrants.length} existing grants from previous runs`
      );
    } catch {}
  }

  // Remove old grants from sites we're about to re-scrape
  const siteIds = sites.map((s) => s.id);
  existingGrants = existingGrants.filter((g) => !siteIds.includes(g.source!));

  const newGrants: Grant[] = [];

  for (const site of sites) {
    const mdPath = path.join(MD_DIR, site.output || `${site.id}.md`);

    // Step 1: Scrape
    if (!convertOnly) {
      try {
        await scrapeSite(site.url, mdPath, site.scroll);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`SCRAPE FAILED for ${site.id}: ${msg}`);
        continue;
      }
    }

    // Step 2: Convert
    if (!scrapeOnly) {
      try {
        const grants = await convertMdToJson(mdPath, site.id);
        newGrants.push(...grants);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`CONVERT FAILED for ${site.id}: ${msg}`);
        continue;
      }
    }
  }

  // Step 3: Merge, deduplicate, write single output
  if (!scrapeOnly) {
    const allGrants = [...existingGrants, ...newGrants];

    const seen = new Set<string>();
    const deduped = allGrants.filter((g) => {
      const key = (g.name || "").toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    deduped.forEach((g, idx) => (g.id = String(idx + 1)));
    fs.writeFileSync(FINAL_OUTPUT, JSON.stringify(deduped, null, 2), "utf-8");

    console.log(`\n${"#".repeat(60)}`);
    console.log(
      `  DONE — ${newGrants.length} new + ${existingGrants.length} existing = ${deduped.length} total`
    );
    console.log(`  Output: ${FINAL_OUTPUT}`);
    console.log(`${"#".repeat(60)}\n`);
  }
}

run().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
