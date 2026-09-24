import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import type { Request } from "express";
import { env } from "../env";
import { FirestoreRateLimitStore } from "./firestoreRateLimitStore";

const message = { error: "Too many requests — please wait a moment and try again." };

/**
 * Coarse per-IP flood guard for all of /api/v1. Runs before auth, so it can only key on IP.
 * Kept generous: students on campus Wi-Fi share a handful of NAT addresses. Real client IPs behind
 * a load balancer need TRUST_PROXY (see env.ts). In-memory: an approximate cap is fine here.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.rateLimitIpPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message,
});

function aiStore(): Store | undefined {
  return env.rateLimitStore === "firestore" ? new FirestoreRateLimitStore({ prefix: "ai:" }) : undefined;
}

/**
 * Per-user limit on routes that call Gemini (explain, analyze, stream, quiz generation, ingest).
 * Mount AFTER requireFirebaseAuth. With RATE_LIMIT_STORE=firestore the count is shared by all
 * instances; the default memory store is per process. Fails open if the store errors, so a
 * Firestore hiccup degrades to "unlimited" rather than blocking every study request.
 */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.rateLimitAiPerMinute,
  // The IP fallback (unauthenticated misuse) goes through ipKeyGenerator so IPv6 clients are
  // grouped by /56 subnet and cannot rotate addresses to dodge the limit. Express always sets
  // req.ip for a socket-backed request.
  keyGenerator: (req: Request) => req.user?.uid ?? `ip:${ipKeyGenerator(req.ip!)}`,
  store: aiStore(),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  message,
});
