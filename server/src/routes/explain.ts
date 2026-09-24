import { Router, type Request, type Response, type NextFunction } from "express";
import { explainConcept } from "../services/gemini";
import { retrieveChunkRecords } from "../services/rag";
import { getStudentProfile } from "../services/misconception";
import { requireFirebaseAuth } from "../middleware/auth";
import { aiLimiter } from "../middleware/rateLimit";
import { validate } from "../middleware/validate";
import { explainSchema } from "../schemas";
import { recordQuestionInteraction, formatContext, sourcesFrom } from "../services/interactions";
import { logger } from "../logger";

export const explainRouter = Router();

/**
 * POST /api/v1/explain — Explain a concept and return as soon as the explanation is ready.
 *
 * The extension sends every typed question here, so the question still feeds the
 * misconception graph — classification and the SMG update run after the response is sent,
 * keeping the classifier off the latency path. Use POST /api/v1/analyze to wait for the tag.
 */
explainRouter.post("/", requireFirebaseAuth, aiLimiter, validate(explainSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.user!.uid;
    const { question, courseId } = req.body;

    const [chunks, profile] = await Promise.all([
      retrieveChunkRecords(uid, courseId, question),
      getStudentProfile(uid),
    ]);

    const result = await explainConcept(question, formatContext(chunks), profile);
    const sources = sourcesFrom(chunks);

    res.json({
      question,
      solution: result.solution,
      mainConcept: result.mainConcept,
      relevantLecture: result.relevantLecture,
      keyFormulas: result.keyFormulas,
      personalizedCallout: result.personalizedCallout,
      sources,
    });

    recordQuestionInteraction(uid, {
      question,
      solution: result.solution,
      mainConcept: result.mainConcept,
      courseId,
      response: { ...result, sources },
    }).catch((err) => logger.warn({ err, uid }, "explain: recording interaction failed"));
  } catch (err) {
    next(err);
  }
});
