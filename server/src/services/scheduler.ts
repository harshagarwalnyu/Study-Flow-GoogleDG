/**
 * Spaced-repetition scheduling for SMG concept nodes, using FSRS (ts-fsrs).
 *
 * FSRS models each concept's memory with stability (how slowly it is forgotten) and
 * difficulty, and schedules the next review for when recall probability falls to the target
 * retention. It replaced SM-2, whose fixed ease-factor arithmetic ignores elapsed time.
 *
 * Concepts are reviewed across days, not drilled like flashcards, so short-term (minute-level)
 * learning steps are disabled and every review lands on a day boundary.
 */
import { fsrs, createEmptyCard, Rating, State, type Card, type Grade } from "ts-fsrs";

export const scheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 365,
  enable_fuzz: false,
  enable_short_term: false,
});

/** Shape persisted at users/{uid}/smg/{node}.fsrs (Firestore-friendly camelCase). */
export interface StoredCard {
  due: Date;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: State;
  lastReview: Date | null;
}

/** What an interaction tells us about the student's recall of a concept. */
export interface ReviewEvidence {
  /** true/false for a graded answer; undefined for a question. */
  isCorrect?: boolean;
  errorType?: string;
  confidence?: number;
}

/** Below this classifier confidence, a question's error type is too uncertain to reschedule on. */
export const QUESTION_EVIDENCE_MIN_CONFIDENCE = 0.5;

/**
 * Map evidence to an FSRS grade, or null when the interaction is not a recall test.
 * - A graded answer is a recall test: correct → Good, wrong → Again.
 * - A question that reveals a misconception shows the concept was not retained → Again.
 * - Any other question is exposure only and must not move the schedule (treating it as a
 *   pass would push the review of a concept the student is actively confused about further out).
 */
export function gradeFor({ isCorrect, errorType, confidence = 0 }: ReviewEvidence): Grade | null {
  if (isCorrect === true) return Rating.Good;
  if (isCorrect === false) return Rating.Again;
  if (errorType && errorType !== "none" && confidence >= QUESTION_EVIDENCE_MIN_CONFIDENCE) return Rating.Again;
  return null;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof (value as any).toDate === "function") return (value as any).toDate();
  const d = new Date(value as any);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toStored(card: Card): StoredCard {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review ?? null,
  };
}

/** Rebuild a card from Firestore; Timestamps come back as objects with toDate(). */
export function fromStored(stored: Record<string, any>, now: Date): Card {
  const lastReview = toDate(stored.lastReview);
  const elapsed = lastReview ? Math.max(0, Math.floor((now.getTime() - lastReview.getTime()) / 86_400_000)) : 0;
  return {
    due: toDate(stored.due) ?? now,
    stability: Number(stored.stability) || 0,
    difficulty: Number(stored.difficulty) || 0,
    elapsed_days: elapsed,
    scheduled_days: Number(stored.scheduledDays) || 0,
    learning_steps: Number(stored.learningSteps) || 0,
    reps: Number(stored.reps) || 0,
    lapses: Number(stored.lapses) || 0,
    state: (stored.state ?? State.New) as State,
    ...(lastReview ? { last_review: lastReview } : {}),
  };
}

/** A fresh card, optionally keeping an existing due date (for nodes scheduled by SM-2). */
export function newCard(now: Date, due?: unknown): StoredCard {
  const card = toStored(createEmptyCard(now));
  const keep = toDate(due);
  return keep ? { ...card, due: keep } : card;
}

/**
 * Apply one interaction. Returns the updated card and whether the schedule changed.
 * `stored` is the node's existing fsrs field, or null for a node without one.
 */
export function applyEvidence(
  stored: Record<string, any> | null,
  evidence: ReviewEvidence,
  now: Date,
  legacyDue?: unknown,
): { card: StoredCard; reviewed: boolean } {
  const current = stored ? toStored(fromStored(stored, now)) : newCard(now, legacyDue);
  const grade = gradeFor(evidence);
  if (grade === null) return { card: current, reviewed: false };
  const { card } = scheduler.next(fromStored(current, now), now, grade);
  return { card: toStored(card), reviewed: true };
}

/** Probability the student can recall the concept now (0–1); 0 for never-reviewed nodes. */
export function retrievability(stored: Record<string, any> | null | undefined, now: Date): number {
  if (!stored) return 0;
  const card = fromStored(stored, now);
  if (card.state === State.New) return 0;
  return scheduler.get_retrievability(card, now, false);
}
