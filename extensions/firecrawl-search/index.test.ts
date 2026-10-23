import assert from "node:assert/strict";
import test from "node:test";
import { crawlWebsite, type CrawlClient } from "./index.ts";

test("cancels the remote crawl when polling is interrupted", async () => {
  let pollingStarted!: () => void;
  const startedPolling = new Promise<void>((resolve) => {
    pollingStarted = resolve;
  });
  const cancelledJobs: string[] = [];

  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "crawl-123", url }),
    getCrawlStatus: async () => {
      pollingStarted();
      return new Promise(() => undefined);
    },
    cancelCrawl: async (jobId) => {
      cancelledJobs.push(jobId);
      return true;
    },
  };

  const controller = new AbortController();
  const running = crawlWebsite(
    client,
    "https://example.com",
    { limit: 1 },
    controller.signal,
  );
  const interrupted = assert.rejects(running);

  await startedPolling;
  controller.abort();
  await interrupted;

  assert.deepEqual(cancelledJobs, ["crawl-123"]);
});

test("cancels jobs that finish starting after the caller aborts", async () => {
  let finishStart!: (job: { id: string; url: string }) => void;
  const cancelledJobs: string[] = [];
  const client: CrawlClient = {
    startCrawl: () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
    getCrawlStatus: async () => {
      throw new Error("must not poll");
    },
    cancelCrawl: async (id) => {
      cancelledJobs.push(id);
      return true;
    },
  };
  const controller = new AbortController();
  const running = crawlWebsite(
    client,
    "https://example.com",
    {},
    controller.signal,
  );
  controller.abort();
  await assert.rejects(running);
  finishStart({ id: "late-job", url: "https://example.com" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancelledJobs, ["late-job"]);
});

test("a pre-aborted crawl never creates a remote job", async () => {
  const controller = new AbortController();
  controller.abort();
  const client: CrawlClient = {
    startCrawl: async () => {
      throw new Error("must not start");
    },
    getCrawlStatus: async () => {
      throw new Error("must not poll");
    },
    cancelCrawl: async () => {
      throw new Error("must not cancel");
    },
  };
  await assert.rejects(
    crawlWebsite(client, "https://example.com", {}, controller.signal),
    { name: "AbortError" },
  );
});

test("polling failure cancels the remote job without hiding the original error", async () => {
  let cancelled = false;
  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "failed-job", url }),
    getCrawlStatus: async () => {
      throw new Error("poll failed");
    },
    cancelCrawl: async () => {
      cancelled = true;
      throw new Error("cancel failed");
    },
  };
  await assert.rejects(
    crawlWebsite(
      client,
      "https://example.com",
      {},
      new AbortController().signal,
    ),
    /poll failed/,
  );
  assert.equal(cancelled, true);
});
