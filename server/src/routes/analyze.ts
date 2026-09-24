import { Router, type Request, type Response, type NextFunction } from "express";
import { explainConcept, classifyConcept } from "../services/gemini";
import { retrieveChunks } from "../services/rag";
import { recordInteraction, getStudentProfile } from "../services/misconception";
import { saveInteraction, ensureUserDoc } from "../services/firestore";
import { extractTextFromBase64 } from "../services/ocr";
import { requireFirebaseAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { analyzeSchema } from "../schemas";
import { cacheInvalidate } from "../services/cache";
import { addXP, updateStreak } from "../services/gamification";
import { logger } from "../logger";
import { shouldUseCourseRag } from "../services/ragPolicy";
import { normalizeClassifierTag, resolveConceptNode, listKnownConcepts } from "../services/concepts";

export const analyzeRouter = Router();

analyzeRouter.post("/", requireFirebaseAuth, validate(analyzeSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.user!.uid;
    const { courseId, content, imageBase64 } = req.body ?? {};

    // Accept text content or base64 image (OCR it first)
    let text = typeof content === "string" ? content.trim() : "";
    if (!text && imageBase64) {
      text = await extractTextFromBase64(imageBase64);
    }

    if (!text) {
      return res.status(400).json({ error: "content (string) or imageBase64 is required" });
    }

    await ensureUserDoc(uid, req.user!.email || "", req.user!.name || "");

    // 1. Independent reads: RAG context (only when it makes sense), the student's weak-spot
    //    profile for personalization, and their existing concept ids for the classifier.
    const [chunks, profile, knownConcepts] = await Promise.all([
      shouldUseCourseRag(text) && courseId ? retrieveChunks(uid, courseId, text) : Promise.resolve([]),
      getStudentProfile(uid),
      listKnownConcepts(uid),
    ]);
    const ragContext = chunks.join("\n\n---\n\n");

    // 2. Call Gemini for explanation with RAG context and student history
    const explanation = await explainConcept(text, ragContext, profile);

    // 3. Classify the interaction, then map the label onto an existing SMG node when it
    //    names the same concept, so one weakness is tracked as one node.
    const rawClassifierTag = await classifyConcept(text, explanation.solution, knownConcepts);
    const normalizedTag = normalizeClassifierTag(rawClassifierTag, explanation.mainConcept);
    const resolved = await resolveConceptNode(uid, normalizedTag.conceptNode);
    const classifierTag = { ...normalizedTag, conceptNode: resolved.conceptNode };

    // 4+5. Save interaction event and update SMG in parallel
    const [eventId] = await Promise.all([
      saveInteraction(uid, {
        courseId,
        content: text,
        eventType: "explain",
        response: explanation,
        classifierTag,
        requestMeta: {
          path: req.originalUrl,
          method: req.method,
          ip: req.ip || "",
          userAgent: req.headers["user-agent"] || undefined,
        },
      }),
      // A question is not a graded answer: record exposure and error type, not correctness.
      recordInteraction(uid, classifierTag.conceptNode, {
        errorType: classifierTag.errorType,
        confidence: classifierTag.confidence,
        courseId,
        labelEmbedding: resolved.labelEmbedding,
      }),
    ]);
    cacheInvalidate(`graph:${uid}`);
    cacheInvalidate(`drill:${uid}`);

    addXP(uid, 5, 'explain').catch((err) => logger.warn({ err, uid }, 'addXP failed'));
    updateStreak(uid).catch((err) => logger.warn({ err, uid }, 'updateStreak failed'));

    res.json({
      question: text,
      solution: explanation.solution,
      mainConcept: explanation.mainConcept,
      relevantLecture: explanation.relevantLecture,
      keyFormulas: explanation.keyFormulas,
      personalizedCallout: explanation.personalizedCallout,
      classifierTag,
      eventId,
    });
  } catch (err) {
    next(err);
  }
});
