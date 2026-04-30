import Groq from "groq-sdk";
import * as fs from "fs";
import { Grant } from "./types";

const GROQ_MODEL = "llama-3.1-8b-instant";

const SYSTEM_PROMPT = `You are a data extraction assistant. Extract ALL grants/funding opportunities from the text and return ONLY a valid JSON array. No markdown, no explanation, no backticks.

CRITICAL RULES FOR AMOUNT EXTRACTION:
- READ THE FULL TEXT CAREFULLY. Funding amounts are often written in natural language.
- "up to £30,000" → amountMin: null, amountMax: 30000
- "between $5,000 and $50,000" → amountMin: 5000, amountMax: 50000
- "grants of £10,000" → amountMin: 10000, amountMax: 10000
- "funding worth 50k-100k" → amountMin: 50000, amountMax: 100000
- "up to 1 million" → amountMax: 1000000
- "50%" or "80% of costs" → note in description, amounts stay null
- Convert "k" to thousands, "m"/"million" to millions
- ALWAYS extract the currency symbol (£, $, €, ₹, etc.)

Each item must have these fields:
{
  "id": "1",
  "slug": "url-friendly-slug",
  "name": "grant name",
  "provider": "organization providing it",
  "country": "country name",
  "countryCode": "2-letter ISO code lowercase",
  "region": "region or state if mentioned",
  "amountMin": number or null,
  "amountMax": number or null,
  "currency": "currency symbol like £ $ € ₹",
  "deadline": "ISO 8601 datetime if found",
  "daysRemaining": null,
  "description": "1-2 sentence summary INCLUDING the funding amount if known",
  "fullDescription": "longer description with all key details",
  "eligibilitySnapshot": "one-line eligibility summary",
  "tags": ["relevant keywords"],
  "type": "Grant",
  "grantType": "type if mentioned",
  "industry": ["relevant industries/sectors"],
  "eligibility": ["each eligibility criterion as separate string"],
  "whatItCovers": ["what the funding covers, each item separate"],
  "howToApply": ["application steps"],
  "applicationUrl": "url if found in text"
}

Use null for unknown numbers, empty string for unknown strings, empty array for unknown arrays.
If no grants found, return: []
Return ONLY the JSON array.`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryFixJson(raw: string): Grant[] | Grant | null {
  let s = raw.trim();

  if (s.startsWith("```")) {
    s = s.split("\n").slice(1).join("\n");
    if (s.endsWith("```")) s = s.slice(0, -3);
    s = s.trim();
  }

  try {
    return JSON.parse(s);
  } catch {}

  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");

  if (start !== -1 && end !== -1 && end > start) {
    let arr = s.slice(start, end + 1);

    try {
      return JSON.parse(arr);
    } catch {}

    arr = arr.replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]");
    try {
      return JSON.parse(arr);
    } catch {}

    const lastBrace = arr.lastIndexOf("}");
    if (lastBrace !== -1) {
      try {
        return JSON.parse(arr.slice(0, lastBrace + 1) + "]");
      } catch {}
    }
  }

  return null;
}

function splitByPages(content: string, maxChars: number = 8000): string[] {
  const pages = content.split(/(?=^# https?:\/\/)/m);
  const chunks: string[] = [];
  let current = "";

  for (const page of pages) {
    if (current.length + page.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = page;
    } else {
      current += page;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function isValidGrant(grant: Partial<Grant>): boolean {
  if (!grant || typeof grant !== "object") return false;

  const name = (grant.name || "").trim();
  const desc = (grant.description || "").trim();

  if (!name || name.length < 3) return false;
  if (!desc || desc.length < 10) return false;

  let filled = 0;
  if (grant.provider?.trim()) filled++;
  if (grant.country?.trim()) filled++;
  if (grant.amountMin || grant.amountMax) filled++;
  if (grant.deadline?.trim()) filled++;
  if (Array.isArray(grant.eligibility) && grant.eligibility.length > 0)
    filled++;
  if (Array.isArray(grant.whatItCovers) && grant.whatItCovers.length > 0)
    filled++;
  if (Array.isArray(grant.tags) && grant.tags.length > 0) filled++;
  if (Array.isArray(grant.industry) && grant.industry.length > 0) filled++;

  return filled >= 3;
}

function deduplicateGrants(grants: Grant[]): Grant[] {
  const seen = new Set<string>();
  return grants.filter((g) => {
    const key = (g.name || "").toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function callWithRetry(
  client: Groq,
  messages: { role: "system" | "user"; content: string }[],
  maxRetries: number = 3,
): Promise<Groq.Chat.ChatCompletion | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.chat.completions.create({
        model: GROQ_MODEL,
        messages,
        temperature: 0.1,
        max_tokens: 4000,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      if (msg.includes("429") || msg.includes("rate_limit")) {
        const waitMatch = msg.match(/try again in (\d+)m/);
        const waitMin = waitMatch ? parseInt(waitMatch[1], 10) + 1 : 2;
        console.log(`  Rate limited. Waiting ${waitMin} min...`);
        await sleep(waitMin * 60 * 1000);
        continue;
      }

      if (msg.includes("413") || msg.includes("Request too large")) {
        console.log(`  Chunk too large, skipping.`);
        return null;
      }

      if (attempt === maxRetries) throw e;
      console.log(`  Retry ${attempt}/${maxRetries}...`);
      await sleep(5000);
    }
  }

  return null;
}

export async function convertMdToJson(
  mdPath: string,
  siteId: string,
): Promise<Grant[]> {
  console.log(`\n  Converting: ${mdPath} (site: ${siteId})`);
  console.log(`  Model: ${GROQ_MODEL}`);

  const content = fs.readFileSync(mdPath, "utf-8");

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is missing. Add it to your .env file or set it as an environment variable.",
    );
  }

  const client = new Groq({ apiKey });
  const allGrants: Grant[] = [];

  // 8K chars ≈ ~2K tokens, keeps under Groq free tier limits
  const chunks = splitByPages(content, 8000);
  console.log(`  Split into ${chunks.length} chunks (by page boundaries)`);

  for (let i = 0; i < chunks.length; i++) {
    console.log(
      `  [${i + 1}/${chunks.length}] Processing (${chunks[i].length} chars)...`,
    );

    // 15s delay between calls to avoid TPM limits
    if (i > 0) await sleep(15000);

    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Extract grants from this text. Pay special attention to funding amounts — look for phrases like "up to", "worth", "between", "funding of", any currency symbols or numbers that indicate grant value. Return ONLY a JSON array:\n\n${chunks[i]}`,
      },
    ];

    try {
      const response = await callWithRetry(client, messages);
      if (!response) continue;

      const raw = response.choices[0]?.message?.content?.trim() || "";
      const grants = tryFixJson(raw);

      if (grants && Array.isArray(grants)) {
        const valid = (grants as Grant[]).filter(isValidGrant);
        allGrants.push(...valid);
        console.log(
          `  ✓ ${grants.length} raw → ${valid.length} passed quality filter`,
        );
      } else if (
        grants &&
        !Array.isArray(grants) &&
        typeof grants === "object" &&
        isValidGrant(grants)
      ) {
        allGrants.push(grants as Grant);
        console.log(`  ✓ Got 1 grant`);
      } else {
        console.log(`  ✗ No valid grants in this chunk`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  Error on chunk ${i + 1}: ${msg}`);
    }
  }

  allGrants.forEach((g) => (g.source = siteId));

  const final = deduplicateGrants(allGrants);
  console.log(
    `  ✓ ${siteId}: ${final.length} unique grants (from ${allGrants.length} before dedup)`,
  );

  return final;
}
