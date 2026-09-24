import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireFirebaseAuth } from '../middleware/auth'
import { validate } from '../middleware/validate'
import { explainConceptStream } from '../services/gemini'
import { retrieveChunks } from '../services/rag'
import { getStudentProfile } from '../services/misconception'
import { recordActivity } from '../services/gamification'
import { logger } from '../logger'
import { shouldUseCourseRag } from '../services/ragPolicy'
import { recordQuestionInteraction } from '../services/interactions'

const router = Router()

const schema = z.object({
  question: z.string().min(1).max(2000),
  courseId: z.string().optional(),
})

router.post('/explain', requireFirebaseAuth, validate(schema), async (req: Request, res: Response) => {
  const uid = req.user!.uid
  const { question, courseId } = req.body

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  
  // Express 5.x handles res.flushHeaders() differently or not at all depending on middleware
  // We'll just rely on the headers being sent.

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000)
  // Cancel heartbeat immediately if the client disconnects before the stream ends.
  req.on('close', () => clearInterval(heartbeat))

  let fullAnswer = ''

  try {
    let ragContext = ''
    try {
      if (courseId && shouldUseCourseRag(question)) {
        const chunks = await retrieveChunks(uid, courseId, question)
        ragContext = chunks.join('\n\n---\n\n')
      }
    } catch (ragErr) {
      logger.warn({ ragErr }, 'RAG context unavailable, proceeding without context')
    }

    const profile = await getStudentProfile(uid).catch((err) => {
      logger.warn({ err, uid }, 'student profile unavailable, streaming without personalization')
      return null
    })
    const stream = await explainConceptStream(question, ragContext, profile)

    for await (const chunk of stream) {
      const text = typeof chunk.text === 'function' ? chunk.text() : (chunk as any).text
      if (text) {
        fullAnswer += text
        res.write(`data: ${JSON.stringify({ text })}\n\n`)
      }
    }

    res.write('data: [DONE]\n\n')
  } catch (err) {
    logger.error({ err, uid }, 'SSE stream failed')
    try {
      res.write(`data: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`)
    } catch { /* headers already sent */ }
  } finally {
    clearInterval(heartbeat)

    // The client already has [DONE]; finish the writes before closing so they are not lost when
    // the runtime throttles CPU after the response ends.
    if (fullAnswer.trim()) {
      await Promise.allSettled([
        recordQuestionInteraction(uid, {
          question,
          solution: fullAnswer,
          courseId,
          response: { solution: fullAnswer },
        }).catch((err) => logger.warn({ err, uid }, 'stream side-effects failed')),
        recordActivity(uid, { xp: 5 }),
      ])
    }
    res.end()
  }
})

export const streamRouter = router
