#!/usr/bin/env node
/**
 * GoMina 360 — network emulation proxy for production-like benchmarking.
 *
 * Sits between the app and PostgreSQL and models a real WAN link:
 *   • LATENCY is paid once per request/response round trip (when the socket has
 *     been idle in that direction, i.e. a new query starts) — not per packet.
 *   • BANDWIDTH throttles a streaming response (large result sets) instead of
 *     charging latency for every 1448-byte segment.
 *
 * That combination makes a local database behave like a remote one (e.g.
 * Vercel in fra1 ↔ Neon in another region: 20–95 ms RTT) while keeping large
 * payload transfer times realistic.
 *
 *   node dev-tooling/latency-proxy.mjs 5433 127.0.0.1:5432 20 [mbps]
 *        listenPort  targetHost:port      RTT/2 ms          bandwidth (default 50)
 *
 * Then start a second app instance against it:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/app_db \
 *     PG_POOL_MAX=8 PORT=3001 npx next start -H 0.0.0.0 -p 3001
 */

import net from "node:net";
import http from "node:http";

const [, , listenArg = "5433", targetArg = "127.0.0.1:5432", delayArg = "20", mbpsArg = "50"] = process.argv;
const listenPort = Number(listenArg);
const [targetHost, targetPort] = targetArg.split(":");
const oneWayDelay = Number(delayArg);
const mbps = Number(mbpsArg);
const BURST_IDLE_MS = 4; // a gap this long = a new round trip
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let connections = 0;
// Instrumentation: a "round trip" is counted whenever the idleness heuristic
// says a new request/response exchange started (i.e. we are about to pay the
// configured latency). Plus byte counters per direction.
const stats = { roundTrips: 0, bytesUp: 0, bytesDown: 0, connections: 0, peakConnections: 0 };

net
  .createServer((client) => {
    const upstream = net.connect(Number(targetPort), targetHost);
    connections += 1;

    stats.connections += 1;
    stats.peakConnections = Math.max(stats.peakConnections, stats.connections);

    const pipe = (from, to, dir) => {
      // ── exact query counting ────────────────────────────────────────────
      // Walk the frontend message stream: every 'Q' (simple query, 0x51) and
      // 'S' (Sync, 0x53) message is one server round trip. Counting chunks by
      // timing was wrong twice over — a streamed 200 KB result looked like 20
      // trips, and a large query split across packets looked like several.
      let upBuf = Buffer.alloc(0);
      let pendingQueries = 0;
      let startupSeen = false;
      // Postgres frontend framing: the connection opens with UNTYPED messages
      // (optional SSLRequest, then StartupMessage: int32 length + payload), and
      // every later message is [type byte][int32 length][payload]. node-postgres
      // then uses the extended protocol, so one `query()` = one Sync ('S').
      const countQueries = (chunk) => {
        upBuf = Buffer.concat([upBuf, chunk]);
        let n = 0;
        if (!startupSeen) {
          if (upBuf.length < 4) return 0;
          const len = upBuf.readInt32BE(0);
          if (len >= 8 && len <= 10000 && upBuf.length >= len) {
            upBuf = upBuf.subarray(len);
            startupSeen = true;
          } else {
            return 0;
          }
        }
        while (upBuf.length >= 5) {
          const type = upBuf[0];
          const len = upBuf.readInt32BE(1);
          if (len < 4 || upBuf.length < 1 + len) break;
          if (type === 0x51 /* 'Q' simple */ || type === 0x53 /* 'S' Sync */) n += 1;
          upBuf = upBuf.subarray(1 + len);
        }
        return n;
      };

      // Writes are serialised through a promise chain: each chunk waits for the
      // previous one, so added latency can never reorder bytes (which would
      // corrupt the Postgres wire protocol).
      let chain = Promise.resolve();
      let debugged = 0;
      from.on("data", (chunk) => {
        chain = chain.then(async () => {
          if (dir === "up" && process.env.EMU_DEBUG && debugged < 3) {
            debugged += 1;
            console.log(`[emu-debug] up chunk ${chunk.length}B: ${chunk.subarray(0, 12).toString("hex")}  ascii="${chunk.subarray(0, 12).toString("latin1").replace(/[^ -~]/g, ".")}"`);
          }
          // one-way delay for the query itself
          if (dir === "up") {
            const queries = countQueries(chunk);
            if (queries > 0) {
              stats.roundTrips += queries;
              pendingQueries += queries;
              if (oneWayDelay > 0) await sleep(oneWayDelay * queries);
            } else {
              // continuation packet of a query already delayed — nothing to charge
            }
            stats.bytesUp += chunk.length;
          } else {
            if (pendingQueries > 0) {
              // first response packet of the last query — pay the return leg once
              if (oneWayDelay > 0) await sleep(oneWayDelay);
              pendingQueries = 0;
            }
            stats.bytesDown += chunk.length;
          }
          // bandwidth: streaming cost for the bytes themselves (both directions)
          if (mbps > 0) await sleep((chunk.length / ((mbps * 1024 * 1024) / 8)) * 1000);
          if (!to.destroyed) to.write(chunk);
        });
      });
      from.on("end", () => { chain = chain.then(() => { if (!to.destroyed) to.end(); }); });
      from.on("error", () => { if (!to.destroyed) to.destroy(); });
    };
    pipe(client, upstream, "up");
    pipe(upstream, client, "down");
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    const close = () => { connections -= 1; stats.connections = connections; };
    client.on("close", close);
    upstream.on("close", close);
  })
  .listen(listenPort, "0.0.0.0", () =>
    console.log(
      `[net-emu] :${listenPort} → ${targetArg}   latency ${oneWayDelay} ms each way (RTT ≈ ${oneWayDelay * 2} ms)   bandwidth ${mbps} Mbps`
    )
  );

// Control/telemetry port: GET /stats returns the counters, /stats?reset=1 zeroes
// them (used by dev-tooling/perf-roundtrips.mjs to attribute DB work per request).
http
  .createServer((req, res) => {
    const u = new URL(req.url || "/", "http://localhost");
    if (u.searchParams.get("reset") === "1") {
      stats.roundTrips = 0;
      stats.bytesUp = 0;
      stats.bytesDown = 0;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...stats, liveConnections: connections, oneWayDelay, mbps }));
  })
  .listen(listenPort + 1, "127.0.0.1", () => console.log(`[net-emu] telemetry on http://127.0.0.1:${listenPort + 1}/stats`));

process.on("SIGTERM", () => {
  console.log(`[net-emu] shutting down (${connections} live connections)`);
  process.exit(0);
});
