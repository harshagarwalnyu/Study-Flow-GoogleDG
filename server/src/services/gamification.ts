import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { logger } from '../logger'
import { GamificationResponse } from '@study-flow/shared'

const db = getFirestore()

function xpForLevel(level: number): number {
  return Math.floor(100 * Math.pow(1.5, level - 1))
}

function levelFromXP(xp: number): { level: number, xpIntoLevel: number, nextLevelXP: number } {
  let level = 1
  let accumulated = 0
  while (accumulated + xpForLevel(level) <= xp) {
    accumulated += xpForLevel(level)
    level++
  }
  return { level, xpIntoLevel: xp - accumulated, nextLevelXP: xpForLevel(level) }
}

interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  check: (data: AchievementData) => boolean;
}

interface AchievementData {
  streak: number;
  conceptCount: number;
  maxAccuracy: number;
  quizCount: number;
}

const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_quiz', name: 'First Step', description: 'Complete your first quiz', icon: '⚡', check: (d) => (d.quizCount || 0) >= 1 },
  { id: 'streak_7',   name: 'Week Warrior', description: '7-day streak', icon: '🔥', check: (d) => (d.streak || 0) >= 7 },
  { id: 'streak_30',  name: 'Month Master', description: '30-day streak', icon: '🏆', check: (d) => (d.streak || 0) >= 30 },
  { id: 'concepts_10', name: 'Explorer',  description: '10 concepts tracked', icon: '🧭', check: (d) => (d.conceptCount || 0) >= 10 },
  { id: 'concepts_50', name: 'Scholar',   description: '50 concepts tracked', icon: '📚', check: (d) => (d.conceptCount || 0) >= 50 },
  { id: 'accuracy_90', name: 'Precision', description: '90%+ accuracy on a concept', icon: '🎯', check: (d) => (d.maxAccuracy || 0) >= 0.9 },
]

export async function getGamificationData(uid: string): Promise<GamificationResponse> {
  try {
    const userRef = db.collection('users').doc(uid)
    const gamSnap = await userRef.collection('gamification').doc('stats').get()
    const gam = gamSnap.exists ? (gamSnap.data() as any) : {}
    const conceptCount = gam.conceptCount || 0
    const maxAccuracy = gam.maxAccuracy || 0
    // Compute streak from the already-fetched document — avoids a second Firestore read.
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const streak = (gam.lastActivityDate === today || gam.lastActivityDate === yesterday)
      ? (gam.streak || 0) : 0
    const xp = gam.xp || 0
    const { level, xpIntoLevel, nextLevelXP } = levelFromXP(xp)

    const unlocked = new Set<string>(gam.unlockedAchievements || [])
    const achievementData: AchievementData = { streak, conceptCount, maxAccuracy, quizCount: gam.quizCount || 0 }
    const newlyUnlocked: string[] = []

    for (const a of ACHIEVEMENTS) {
      if (!unlocked.has(a.id) && a.check(achievementData)) {
        unlocked.add(a.id)
        newlyUnlocked.push(a.id)
      }
    }

    if (newlyUnlocked.length > 0) {
      // arrayUnion + a nested merge: two concurrent reads cannot drop each other's unlocks.
      const now = new Date().toISOString()
      const newDates = Object.fromEntries(newlyUnlocked.map((id) => [id, now]))
      await userRef.collection('gamification').doc('stats').set(
        { unlockedAchievements: FieldValue.arrayUnion(...newlyUnlocked), achievementDates: newDates },
        { merge: true }
      )
      // So the response reports unlockedAt for achievements unlocked by this very request.
      gam.achievementDates = { ...(gam.achievementDates || {}), ...newDates }
    }

    return {
      xp,
      level,
      xpIntoLevel,
      nextLevelXP,
      streak,
      achievements: ACHIEVEMENTS.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        icon: a.icon,
        unlocked: unlocked.has(a.id),
        unlockedAt: unlocked.has(a.id) ? (gam.achievementDates?.[a.id] ?? null) : null,
      })),
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, uid }, 'getGamificationData failed')
    return {
      xp: 0, level: 1, xpIntoLevel: 0, nextLevelXP: 100, streak: 0,
      achievements: ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, description: a.description, icon: a.icon, unlocked: false, unlockedAt: null })),
    }
  }
}

/** XP for the first activity of each day. */
export const DAILY_STREAK_XP = 20

export interface ActivityInput {
  /** XP earned by this action (e.g. 5 for an explanation, 10 for a correct quiz answer). */
  xp?: number
  /** A quiz question answered correctly (counts towards the First Step achievement). */
  quizCorrect?: boolean
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Record one study action: its XP, the quiz count, and the daily streak, in a single transaction.
 *
 * Replaces addXP + updateStreak, which read-then-wrote the stats doc separately: two requests at
 * the start of a day both saw "not active today" and each granted the streak bonus. Callers await
 * this before responding so the write is not lost when the runtime throttles CPU after a response.
 * Best-effort: failures are logged, never thrown, so gamification cannot fail a study request.
 * Days are UTC.
 */
export async function recordActivity(uid: string, { xp = 0, quizCorrect = false }: ActivityInput = {}, now: Date = new Date()): Promise<void> {
  try {
    const ref = db.collection('users').doc(uid).collection('gamification').doc('stats')
    await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref)
      const current = snap.exists ? (snap.data() as any) : {}
      const today = utcDay(now)
      const yesterday = utcDay(new Date(now.getTime() - 86_400_000))
      const firstToday = current.lastActivityDate !== today

      const updates: Record<string, unknown> = { lastActivity: now.toISOString() }
      const points = xp + (firstToday ? DAILY_STREAK_XP : 0)
      if (points > 0) updates.xp = FieldValue.increment(points)
      if (quizCorrect) updates.quizCount = FieldValue.increment(1)
      if (firstToday) {
        updates.lastActivityDate = today
        updates.streak = current.lastActivityDate === yesterday ? (current.streak || 0) + 1 : 1
      }
      txn.set(ref, updates, { merge: true })
    })
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, uid }, 'recordActivity failed (non-critical)')
  }
}
