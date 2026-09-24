import { Router, type Request, type Response, type NextFunction } from "express";
import { explainConcept } from "../services/gemini";
import { retrieveChunkRecords } from "../services/rag";
import { getStudentProfile } from "../services/misconception";
import { ensureUserDoc } from "../services/firestore";
import { extractTextFromBase64 } from "../services/ocr";
import { requireFirebaseAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { analyzeSchema } from "../schemas";
import { addXP, updateStreak } from "../services/gamification";
import { logger } from "../logger";
import { shouldUseCourseRag } from "../services/ragPolicy";
import { recordQuestionInteraction, formatContext, sourcesFrom } from "../services/interactions";

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

    // 1. Independent reads: RAG context (only when it makes sense) and the student's
    //    weak-spot profile for personalization.
    const [chunks, profile] = await Promise.all([
      shouldUseCourseRag(text) && courseId ? retrieveChunkRecords(uid, courseId, text) : Promise.resolve([]),
      getStudentProfile(uid),
    ]);

    // 2. Call Gemini for explanation with numbered, file-labelled context and student history
    const explanation = await explainConcept(text, formatContext(chunks), profile);
    const sources = sourcesFrom(chunks);

    // 3. Classify, resolve onto an existing SMG node, log the event and update the node.
    const { classifierTag, eventId } = await recordQuestionInteraction(uid, {
      question: text,
      solution: explanation.solution,
      mainConcept: explanation.mainConcept,
      courseId,
      response: { ...explanation, sources },
      requestMeta: {
        path: req.originalUrl,
        method: req.method,
        ip: req.ip || "",
        userAgent: req.headers["user-agent"] || undefined,
      },
    });

    addXP(uid, 5, 'explain').catch((err) => logger.warn({ err, uid }, 'addXP failed'));
    updateStreak(uid).catch((err) => logger.warn({ err, uid }, 'updateStreak failed'));

    res.json({
      question: text,
      solution: explanation.solution,
      mainConcept: explanation.mainConcept,
      relevantLecture: explanation.relevantLecture,
      keyFormulas: explanation.keyFormulas,
      personalizedCallout: explanation.personalizedCallout,
      sources,
      classifierTag,
      eventId,
    });
  } catch (err) {
    next(err);
  }
});
