import { describe, it, expect } from "vitest";
import { Rating, State } from "ts-fsrs";
import { gradeFor, applyEvidence, newCard, retrievability, fromStored, toStored, drillPriority, QUESTION_EVIDENCE_MIN_CONFIDENCE, TARGET_RETENTION } from "./scheduler";

const DAY = 86_400_000;
const t0 = new Date("2026-09-01T12:00:00Z");
const daysUntil = (due: Date, now: Date) => Math.round((due.getTime() - now.getTime()) / DAY);

describe("gradeFor", () => {
  it("grades answers by correctness", () => {
    expect(gradeFor({ isCorrect: true })).toBe(Rating.Good);
    expect(gradeFor({ isCorrect: false })).toBe(Rating.Again);
  });

  it("treats a question that reveals a misconception as a failed recall", () => {
    expect(gradeFor({ errorType: "procedural_error", confidence: 0.8 })).toBe(Rating.Again);
  });

  it("does not reschedule on questions without a (confident) misconception", () => {
    expect(gradeFor({ errorType: "none", confidence: 1 })).toBeNull();
    expect(gradeFor({ errorType: "procedural_error", confidence: QUESTION_EVIDENCE_MIN_CONFIDENCE - 0.01 })).toBeNull();
    expect(gradeFor({})).toBeNull();
  });
});

describe("applyEvidence", () => {
  it("spaces reviews further apart after each correct answer, on day boundaries", () => {
    let now = t0;
    let card: any = null;
    const intervals: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = applyEvidence(card, { isCorrect: true }, now);
      expect(res.reviewed).toBe(true);
      intervals.push(daysUntil(res.card.due, now));
      card = res.card;
      now = res.card.due;
    }
    expect(intervals[0]).toBeGreaterThanOrEqual(1);
    expect(intervals[1]).toBeGreaterThan(intervals[0]);
    expect(intervals[2]).toBeGreaterThan(intervals[1]);
    expect(card.state).toBe(State.Review);
    expect(card.reps).toBe(3);
  });

  it("pulls the review in, counts a lapse and raises difficulty after a wrong answer", () => {
    const first = applyEvidence(null, { isCorrect: true }, t0).card;
    const later = new Date(first.due.getTime());
    const second = applyEvidence(first, { isCorrect: true }, later).card;
    const failAt = second.due;
    const failed = applyEvidence(second, { isCorrect: false }, failAt).card;

    expect(failed.lapses).toBe(1);
    expect(failed.difficulty).toBeGreaterThan(second.difficulty);
    expect(daysUntil(failed.due, failAt)).toBeLessThan(daysUntil(second.due, later));
  });

  it("leaves the schedule untouched for exposure-only questions", () => {
    const card = applyEvidence(null, { isCorrect: true }, t0).card;
    const res = applyEvidence(card, { errorType: "none", confidence: 0.9 }, new Date(t0.getTime() + DAY));
    expect(res.reviewed).toBe(false);
    expect(res.card).toEqual(card);
  });

  it("starts nodes scheduled by SM-2 from a fresh card but keeps their due date", () => {
    const legacyDue = new Date("2026-09-10T00:00:00Z");
    const res = applyEvidence(null, { errorType: "none" }, t0, { toDate: () => legacyDue });
    expect(res.card.state).toBe(State.New);
    expect(res.card.due).toEqual(legacyDue);
  });
});

describe("storage round trip and retrievability", () => {
  it("round-trips through the Firestore shape, including Timestamp-like dates", () => {
    const card = applyEvidence(null, { isCorrect: true }, t0).card;
    const firestoreLike = {
      ...card,
      due: { toDate: () => card.due },
      lastReview: { toDate: () => card.lastReview },
    };
    expect(toStored(fromStored(firestoreLike, t0))).toEqual(card);
  });

  it("tolerates missing or malformed fields", () => {
    const card = fromStored({ due: "not a date", stability: "x" }, t0);
    expect(card.due).toEqual(t0);
    expect(card.stability).toBe(0);
    expect(card.state).toBe(State.New);
  });

  it("predicts recall decaying over time, and 0 for never-reviewed nodes", () => {
    const card = applyEvidence(null, { isCorrect: true }, t0).card;
    const soon = retrievability(card, new Date(t0.getTime() + DAY));
    const late = retrievability(card, new Date(t0.getTime() + 60 * DAY));
    expect(soon).toBeGreaterThan(late);
    expect(soon).toBeLessThanOrEqual(1);
    expect(late).toBeGreaterThan(0);
    expect(retrievability(newCard(t0), t0)).toBe(0);
    expect(retrievability(null, t0)).toBe(0);
  });
});

describe("drillPriority", () => {
  const reviewedOn = (day: Date, correct = true) => applyEvidence(null, { isCorrect: correct }, day).card;

  it("ranks a forgotten studied concept above new concepts from ingestion", () => {
    const now = new Date(t0.getTime() + 30 * DAY);
    const forgotten = drillPriority({ fsrs: reviewedOn(t0), accuracyRate: 1, interactionCount: 1 }, now);
    const ingested = drillPriority({ fsrs: newCard(t0), isInitializedOnly: true }, now);
    const asked = drillPriority({ fsrs: newCard(t0), interactionCount: 2 }, now);

    expect(forgotten.due).toBe(true);
    expect(forgotten.retrievability).toBeLessThan(TARGET_RETENTION);
    expect(forgotten.urgency).toBeGreaterThan(asked.urgency);
    expect(asked.urgency).toBeGreaterThan(ingested.urgency);
    expect(ingested).toEqual({ urgency: 5, due: false });
    expect(asked).toEqual({ urgency: 6, due: false });
  });

  it("puts reviews that are not yet due after new material, weaker concepts first", () => {
    const now = new Date(t0.getTime() + 1000);
    const fresh = drillPriority({ fsrs: reviewedOn(t0), accuracyRate: 1 }, now);
    const shaky = drillPriority({ fsrs: reviewedOn(t0), accuracyRate: 0.2 }, now);
    expect(fresh.due).toBe(false);
    expect(fresh.urgency).toBeLessThan(5);
    expect(shaky.urgency).toBeGreaterThan(fresh.urgency);
    expect(shaky.urgency).toBeLessThan(5);
  });

  it("orders due reviews by how much has been forgotten", () => {
    const card = reviewedOn(t0);
    const a = drillPriority({ fsrs: card, accuracyRate: 0.5 }, new Date(t0.getTime() + 10 * DAY));
    const b = drillPriority({ fsrs: card, accuracyRate: 0.5 }, new Date(t0.getTime() + 60 * DAY));
    expect(a.due && b.due).toBe(true);
    expect(b.urgency).toBeGreaterThan(a.urgency);
  });

  it("keeps the legacy overdue formula for nodes still on SM-2", () => {
    const now = new Date(t0.getTime() + 3 * DAY);
    expect(drillPriority({ nextReviewDate: { toDate: () => t0 }, accuracyRate: 0.5 }, now)).toEqual({ urgency: 3 * 2 + 2.5, due: true });
    expect(drillPriority({ nextReviewDate: new Date(now.getTime() + DAY) }, now)).toEqual({ urgency: 5, due: false });
    expect(drillPriority({}, now)).toEqual({ urgency: 5, due: true });
  });
});
