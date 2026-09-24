import { Router, type Request, type Response, type NextFunction } from 'express'
import { requireFirebaseAuth } from '../middleware/auth'
import { getGamificationData } from '../services/gamification'

const router = Router()

router.get('/', requireFirebaseAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.user!.uid
    // Read-only: viewing the dashboard is not study activity and must not extend the streak.
    const data = await getGamificationData(uid)
    res.json(data)
  } catch (err) {
    next(err)
  }
})

export const gamificationRouter = router
