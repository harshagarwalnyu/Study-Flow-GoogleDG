import type { Store, Options, IncrementResponse, ClientRateLimitInfo } from "express-rate-limit";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../db/firebase";

/**
 * Fixed-window express-rate-limit store shared by every server instance through Firestore.
 *
 * The in-memory store counts per process, so N instances let a client through N times the limit.
 * Each hit is one transaction on rateLimits/{prefix}{key}; use it for expensive routes, where a
 * ~30 ms write is small next to the work being protected, not for every request.
 *
 * Docs carry `expireAt` (a Timestamp). Enable a TTL policy so old windows are deleted:
 *   gcloud firestore fields ttls update expireAt --collection-group=rateLimits --enable-ttl
 */
export class FirestoreRateLimitStore implements Store {
  localKeys = false;
  prefix: string;
  private collection: string;
  private windowMs = 60_000;

  constructor({ prefix = "rl:", collection = "rateLimits" }: { prefix?: string; collection?: string } = {}) {
    this.prefix = prefix;
    this.collection = collection;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private ref(key: string) {
    // Keys are uids or IPs; encode so ':' and '/' cannot form an invalid document path.
    return db.collection(this.collection).doc(encodeURIComponent(this.prefix + key));
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const snap = await this.ref(key).get();
    if (!snap.exists) return undefined;
    const { hits, resetAt } = snap.data() as { hits: number; resetAt: number };
    if (resetAt <= Date.now()) return undefined;
    return { totalHits: hits, resetTime: new Date(resetAt) };
  }

  async increment(key: string): Promise<IncrementResponse> {
    const ref = this.ref(key);
    return db.runTransaction(async (txn) => {
      const now = Date.now();
      const snap = await txn.get(ref);
      const data = snap.exists ? (snap.data() as { hits: number; resetAt: number }) : null;
      if (!data || data.resetAt <= now) {
        const resetAt = now + this.windowMs;
        txn.set(ref, { hits: 1, resetAt, expireAt: new Date(resetAt) });
        return { totalHits: 1, resetTime: new Date(resetAt) };
      }
      txn.update(ref, { hits: data.hits + 1 });
      return { totalHits: data.hits + 1, resetTime: new Date(data.resetAt) };
    });
  }

  async decrement(key: string): Promise<void> {
    await this.ref(key).update({ hits: FieldValue.increment(-1) }).catch(() => undefined);
  }

  async resetKey(key: string): Promise<void> {
    await this.ref(key).delete();
  }
}
