import * as v from "valibot";
import {
  jobRequestSchema,
  replySchema,
  errorMessage,
  type Reply,
  type JobResult,
} from "./contracts.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
type Job = {
  outcome: JobResult;
  controller: AbortController;
  seen: number;
  timer?: ReturnType<typeof setTimeout>;
};
import http from "node:http";

/** Match only the start route and opaque reply IDs shared by both servers. */
export function isJobPath(pathname: string) {
  return (
    pathname === "/api/chat/jobs" ||
    /^\/api\/chat\/jobs\/[a-f0-9]{32}$/.test(pathname)
  );
}

/** Keep remote HTTP requests short while the local model completes its answer. */
export function createJobs({
  modelPort,
  deadlineMs = 20 * 60_000,
  retentionMs = 10 * 60_000,
  leaseMs = 3 * 60_000,
}: {
  modelPort: number;
  deadlineMs?: number;
  retentionMs?: number;
  leaseMs?: number;
}) {
  const jobs = new Map<string, Job>();
  /** Send short, uncached job status responses through the tunnel. */
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(body));
  };

  /** Keep the model connection local and abortable while its completed JSON is pending. */
  function generate(body: object, signal: AbortSignal) {
    return new Promise<Reply>((resolve, reject) => {
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: modelPort,
          path: "/v1/chat/completions",
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
        },
        async (response) => {
          try {
            const chunks = [];
            let bytes = 0;
            for await (const chunk of response) {
              bytes += chunk.length;
              if (bytes > 2 * 1024 * 1024)
                throw new Error("The model reply is too large.");
              chunks.push(chunk);
            }
            let result;
            try {
              result = v.parse(
                replySchema,
                JSON.parse(Buffer.concat(chunks).toString()),
              );
            } catch {
              result = null;
            }
            if (response.statusCode !== 200 || result?.error)
              throw new Error(
                result?.error?.message ||
                  `Model request failed (${response.statusCode})`,
              );
            if (!result)
              throw new Error("The model returned an unreadable reply.");
            resolve(result);
          } catch (error) {
            upstream.destroy();
            reject(error);
          }
        },
      );
      upstream.on("error", reject);
      upstream.end(JSON.stringify({ ...body, stream: false }));
    });
  }

  /** Reclaim an unpolled reply only when another browser needs the model. */
  function busy() {
    for (const job of jobs.values()) {
      if (job.outcome.state !== "pending") continue;
      if (Date.now() - job.seen <= leaseMs) return true;
      job.outcome = {
        state: "error",
        error: {
          message:
            "The browser stopped checking this reply. Retry your message.",
        },
      };
      job.controller.abort(new Error(job.outcome.error.message));
    }
    return false;
  }

  /** Start, inspect, or cancel a bounded in-memory remote reply. */
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ) {
    if (pathname === "/api/chat/jobs") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      if (!String(req.headers["content-type"]).startsWith("application/json")) {
        send(res, 415, { error: { message: "Send JSON chat messages." } });
        return;
      }
      if (busy()) {
        send(res, 429, {
          error: {
            message:
              "A remote reply is already running. Retry after it finishes.",
          },
        });
        return;
      }
      let body;
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) throw new Error("Request too large.");
          chunks.push(chunk);
        }
        body = v.parse(
          jobRequestSchema,
          JSON.parse(Buffer.concat(chunks).toString()),
        );
      } catch {
        send(res, 400, {
          error: { message: "Send a valid chat request under 1 MiB." },
        });
        return;
      }
      // Recheck after reading the body: two uploads may arrive together.
      if (busy()) {
        send(res, 429, {
          error: { message: "A remote reply is already running." },
        });
        return;
      }
      while (jobs.size >= 16) {
        const entry = jobs.entries().next().value;
        if (!entry) break;
        const [oldest, job] = entry;
        clearTimeout(job.timer);
        jobs.delete(oldest);
      }
      const { id, ...request } = body;
      if (jobs.has(id)) {
        send(res, 409, {
          error: { message: "This request ID is already in use." },
        });
        return;
      }
      const controller = new AbortController();
      const job: Job = {
        outcome: { state: "pending" },
        controller,
        seen: Date.now(),
      };
      jobs.set(id, job);
      job.timer = setTimeout(
        () =>
          controller.abort(
            new Error("Reply exceeded the 20-minute time limit."),
          ),
        deadlineMs,
      ).unref();
      generate(request, controller.signal)
        .then((result) => {
          job.outcome = { state: "done", result };
        })
        .catch((error) => {
          job.outcome = {
            state: "error",
            error: { message: errorMessage(controller.signal.reason ?? error) },
          };
        })
        .finally(() => {
          clearTimeout(job.timer);
          if (jobs.has(id))
            job.timer = setTimeout(() => jobs.delete(id), retentionMs).unref();
        });
      send(res, 202, { id });
      return;
    }
    const id = pathname.slice("/api/chat/jobs/".length);
    const job = jobs.get(id);
    if (!job) {
      send(res, 404, {
        error: {
          message:
            "This remote reply expired or the chat server restarted. Retry your message.",
        },
      });
      return;
    }
    if (req.method === "DELETE") {
      jobs.delete(id);
      clearTimeout(job.timer);
      job.controller.abort();
      res.writeHead(204, { "Cache-Control": "no-store" }).end();
    } else if (req.method === "GET") {
      job.seen = Date.now();
      send(res, 200, job.outcome);
    } else res.writeHead(405, { Allow: "GET, DELETE" }).end();
  }

  return {
    handle,
    /** Abort model work and remove timers when its server closes. */
    close() {
      for (const job of jobs.values()) {
        clearTimeout(job.timer);
        job.controller.abort();
      }
      jobs.clear();
    },
  };
}
