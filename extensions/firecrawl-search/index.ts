import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Firecrawl, CrawlOptions } from "firecrawl";
import { Type } from "typebox";
import {
  CRAWL_PARAMETER_DESCRIPTIONS,
  CRAWL_PROMPT_GUIDELINES,
  CRAWL_PROMPT_SNIPPET,
  CRAWL_TOOL_DESCRIPTION,
  SCRAPE_PARAMETER_DESCRIPTIONS,
  SCRAPE_PROMPT_GUIDELINES,
  SCRAPE_PROMPT_SNIPPET,
  SCRAPE_TOOL_DESCRIPTION,
  SEARCH_PARAMETER_DESCRIPTIONS,
  SEARCH_PROMPT_GUIDELINES,
  SEARCH_PROMPT_SNIPPET,
  SEARCH_TOOL_DESCRIPTION,
} from "./prompt.ts";

function readEnvValue(name: string) {
  if (process.env[name]) return process.env[name];

  const envPath = join(homedir(), ".pi", "agent", ".env");
  let envText = "";

  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match || match[1] !== name) continue;

    const value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    return value.replace(/\s+#.*$/, "");
  }

  return undefined;
}

async function createClient() {
  const apiKey = readEnvValue("FIRECRAWL_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Missing FIRECRAWL_API_KEY in the environment or ~/.pi/agent/.env",
    );
  }
  const { Firecrawl } = await import("firecrawl");
  return new Firecrawl({ apiKey });
}

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function formatOutput(value: unknown, operation: string) {
  const output = typeof value === "string" ? value : stringify(value);
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return output;
  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-firecrawl-"));
  const outputPath = join(outputDirectory, `${operation}.json`);
  await writeFile(outputPath, output, "utf8");
  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
}

export type CrawlClient = Pick<
  Firecrawl,
  "startCrawl" | "getCrawlStatus" | "cancelCrawl"
>;

function abortable<T>(request: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Request cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function cancelCrawl(client: CrawlClient, id: string) {
  try {
    await abortable(client.cancelCrawl(id), AbortSignal.timeout(10_000));
  } catch {
    // Cleanup is best-effort and must not hide the request's original failure.
  }
}

/** Own the remote job until completion, including a job acquired after cancellation. */
export async function crawlWebsite(
  client: CrawlClient,
  url: string,
  options: CrawlOptions,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const starting = client.startCrawl(url, options);
  const job = await abortable(starting, signal).catch((error) => {
    void starting.then(
      (lateJob) => cancelCrawl(client, lateJob.id),
      () => {},
    );
    throw error;
  });
  let complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await abortable(client.getCrawlStatus(job.id), signal);
      if (result.status === "completed") {
        complete = true;
        return result;
      }
      if (result.status !== "scraping") {
        throw new Error(`Crawl ${job.id} ended with status ${result.status}`);
      }
      await sleep(2_000, undefined, { signal });
    }
  } finally {
    if (!complete) await cancelCrawl(client, job.id);
  }
}

async function runFirecrawl<T>(
  operation: string,
  status: string,
  timeout: number,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<T | undefined> | undefined,
  request: (
    client: Firecrawl,
    signal: AbortSignal,
  ) => Promise<{ details: T; output: unknown }>,
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Firecrawl ${operation} timed out`)),
    timeout,
  );
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    combined.throwIfAborted();
    const client = await abortable(createClient(), combined);
    onUpdate?.({
      content: [{ type: "text", text: status }],
      details: undefined,
    });
    const { details, output } = await abortable(
      request(client, combined),
      combined,
    );
    const formatted = await formatOutput(output, operation);
    return {
      content: [{ type: "text" as const, text: formatted }],
      details,
    } satisfies AgentToolResult<T | undefined>;
  } catch (cause) {
    throw new Error(`Firecrawl ${operation} failed: ${errorMessage(cause)}`, {
      cause,
    });
  } finally {
    clearTimeout(timer);
  }
}

export default function firecrawlTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search Web",
    description: SEARCH_TOOL_DESCRIPTION,
    promptSnippet: SEARCH_PROMPT_SNIPPET,
    promptGuidelines: SEARCH_PROMPT_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({
        description: SEARCH_PARAMETER_DESCRIPTIONS.query,
      }),
      limit: Type.Optional(
        Type.Number({
          description: SEARCH_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: 20,
        }),
      ),
      source: Type.Optional(StringEnum(["web", "news", "images"] as const)),
      scrapeResults: Type.Optional(
        Type.Boolean({
          description: SEARCH_PARAMETER_DESCRIPTIONS.scrapeResults,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        "search",
        `Searching Firecrawl for: ${params.query}`,
        35_000,
        signal,
        onUpdate,
        async (client) => {
          const result = await client.search(params.query, {
            limit: params.limit ?? 5,
            sources: [params.source ?? "web"],
            scrapeOptions: params.scrapeResults
              ? { formats: ["markdown"], timeout: 30_000 }
              : undefined,
            timeout: 30_000,
          });
          return { details: result, output: result };
        },
      ),
  });

  pi.registerTool({
    name: "crawl",
    label: "Crawl Website",
    description: CRAWL_TOOL_DESCRIPTION,
    promptSnippet: CRAWL_PROMPT_SNIPPET,
    promptGuidelines: CRAWL_PROMPT_GUIDELINES,
    parameters: Type.Object({
      url: Type.String({ description: CRAWL_PARAMETER_DESCRIPTIONS.url }),
      limit: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: 100,
        }),
      ),
      maxDiscoveryDepth: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.maxDiscoveryDepth,
          minimum: 0,
        }),
      ),
      includePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: CRAWL_PARAMETER_DESCRIPTIONS.includePaths,
        }),
      ),
      excludePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: CRAWL_PARAMETER_DESCRIPTIONS.excludePaths,
        }),
      ),
      crawlEntireDomain: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.crawlEntireDomain,
        }),
      ),
      allowSubdomains: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.allowSubdomains,
        }),
      ),
      sitemap: Type.Optional(StringEnum(["include", "skip", "only"] as const)),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.onlyMainContent,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.timeout,
          minimum: 1,
          maximum: 600,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        "crawl",
        `Crawling up to ${params.limit ?? 20} pages from: ${params.url}`,
        ((params.timeout ?? 120) + 5) * 1_000,
        signal,
        onUpdate,
        async (client, requestSignal) => {
          const result = await crawlWebsite(
            client,
            params.url,
            {
              limit: params.limit ?? 20,
              maxDiscoveryDepth: params.maxDiscoveryDepth,
              includePaths: params.includePaths,
              excludePaths: params.excludePaths,
              crawlEntireDomain: params.crawlEntireDomain,
              allowSubdomains: params.allowSubdomains,
              sitemap: params.sitemap,
              scrapeOptions: {
                formats: ["markdown"],
                onlyMainContent: params.onlyMainContent ?? true,
              },
            },
            requestSignal,
          );
          return { details: result, output: result };
        },
      ),
  });

  pi.registerTool({
    name: "scrape",
    label: "Scrape Page",
    description: SCRAPE_TOOL_DESCRIPTION,
    promptSnippet: SCRAPE_PROMPT_SNIPPET,
    promptGuidelines: SCRAPE_PROMPT_GUIDELINES,
    parameters: Type.Object({
      url: Type.String({ description: SCRAPE_PARAMETER_DESCRIPTIONS.url }),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.onlyMainContent,
        }),
      ),
      waitFor: Type.Optional(
        Type.Number({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.waitFor,
          minimum: 0,
          maximum: 60_000,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.timeout,
          minimum: 1,
          maximum: 120_000,
        }),
      ),
      includeMetadata: Type.Optional(
        Type.Boolean({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.includeMetadata,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        "scrape",
        `Scraping page with Firecrawl: ${params.url}`,
        (params.timeout ?? 30_000) + 5_000,
        signal,
        onUpdate,
        async (client) => {
          const document = await client.scrape(params.url, {
            formats: ["markdown"],
            onlyMainContent: params.onlyMainContent ?? true,
            waitFor: params.waitFor,
            timeout: params.timeout ?? 30_000,
          });
          const metadata =
            params.includeMetadata && document.metadata
              ? `\n\nMetadata:\n${stringify(document.metadata)}`
              : "";
          const markdown =
            document.markdown?.trim() || "No markdown content returned.";
          return { details: document, output: `${markdown}${metadata}` };
        },
      ),
  });
}
