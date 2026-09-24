import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getGamificationData, recordActivity, DAILY_STREAK_XP } from './gamification';

const { mockDb, mockBatch, mockFieldValue, mockTxn } = vi.hoisted(() => {
  const mockDb = {
    collection: vi.fn(),
    doc: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    batch: vi.fn(),
    runTransaction: vi.fn(),
  };
  const mockTxn = { get: vi.fn(), set: vi.fn() };
  const mockBatch = {
    set: vi.fn(),
    commit: vi.fn().mockResolvedValue(true),
  };
  mockDb.collection.mockReturnValue(mockDb);
  mockDb.doc.mockReturnValue(mockDb);
  mockDb.batch.mockReturnValue(mockBatch);

  return { 
    mockDb, 
    mockBatch,
    mockTxn,
    mockFieldValue: {
      increment: vi.fn((n) => ({ type: 'increment', value: n })),
      arrayUnion: vi.fn((...v) => v),
    }
  };
});

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => mockDb),
  FieldValue: mockFieldValue
}));

describe('gamification service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.collection.mockReturnValue(mockDb);
    mockDb.doc.mockReturnValue(mockDb);
    mockDb.runTransaction.mockImplementation(async (fn: any) => fn(mockTxn));
  });

  describe('getGamificationData', () => {
    it('returns default data if user has no stats', async () => {
      mockDb.get.mockResolvedValue({ exists: false });
      const data = await getGamificationData('user1');
      expect(data.xp).toBe(0);
      expect(data.level).toBe(1);
      expect(data.achievements).toHaveLength(6);
      expect(data.achievements.every(a => !a.unlocked)).toBe(true);
    });

    it('calculates level and streak correctly', async () => {
      const today = new Date().toISOString().slice(0, 10);
      mockDb.get.mockResolvedValue({
        exists: true,
        data: () => ({
          xp: 150,
          streak: 5,
          lastActivityDate: today,
          unlockedAchievements: ['first_quiz'],
          achievementDates: { first_quiz: '2023-01-01' }
        })
      });

      const data = await getGamificationData('user1');
      expect(data.level).toBe(2);
      expect(data.xpIntoLevel).toBe(50);
      expect(data.streak).toBe(5);
      expect(data.achievements.find(a => a.id === 'first_quiz')?.unlocked).toBe(true);
    });

    it('defaults streak to 0 when the stored streak field is missing on an active day', async () => {
      const today = new Date().toISOString().slice(0, 10);
      mockDb.get.mockResolvedValue({
        exists: true,
        data: () => ({ xp: 0, lastActivityDate: today, unlockedAchievements: [] }),
      });

      const data = await getGamificationData('user1');
      expect(data.streak).toBe(0);
    });

    it('reports unlockedAt as null for a previously-unlocked achievement missing from achievementDates', async () => {
      mockDb.get.mockResolvedValue({
        exists: true,
        data: () => ({
          xp: 0,
          // Already unlocked in a prior request, but the dates map is missing this entry
          // (e.g. legacy data) — no achievements are newly unlocked this call.
          unlockedAchievements: ['first_quiz'],
        }),
      });

      const data = await getGamificationData('user1');
      expect(data.achievements.find((a) => a.id === 'first_quiz')).toMatchObject({ unlocked: true, unlockedAt: null });
      expect(mockDb.set).not.toHaveBeenCalled();
    });

    it('unlocks new achievements', async () => {
      mockDb.get.mockResolvedValue({
        exists: true,
        data: () => ({
          xp: 0,
          quizCount: 1, // Should unlock first_quiz
          unlockedAchievements: []
        })
      });

      const data = await getGamificationData('user1');
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ unlockedAchievements: expect.arrayContaining(['first_quiz']) }),
        { merge: true }
      );
      expect(data.achievements.find(a => a.id === 'first_quiz')?.unlocked).toBe(true);
    });

    it('handles errors gracefully', async () => {
      mockDb.get.mockRejectedValue(new Error('Firestore down'));
      const data = await getGamificationData('user1');
      expect(data.xp).toBe(0);
      expect(data.level).toBe(1);
    });

    it('handles a non-Error rejection gracefully too', async () => {
      mockDb.get.mockRejectedValue('firestore string rejection');
      const data = await getGamificationData('user1');
      expect(data.xp).toBe(0);
      expect(data.level).toBe(1);
    });
  });

  describe('recordActivity', () => {
    const now = new Date('2026-09-24T15:00:00Z');
    const stats = (data: any) => mockTxn.get.mockResolvedValue({ exists: data !== null, data: () => data });
    const written = () => mockTxn.set.mock.calls[0][1];

    it('grants the action XP plus the daily bonus and extends the streak on the first activity of a day', async () => {
      stats({ lastActivityDate: '2026-09-23', streak: 4 });
      await recordActivity('u1', { xp: 5 }, now);
      expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
      expect(written()).toEqual({
        lastActivity: now.toISOString(),
        xp: { type: 'increment', value: 5 + DAILY_STREAK_XP },
        lastActivityDate: '2026-09-24',
        streak: 5,
      });
      expect(mockTxn.set.mock.calls[0][2]).toEqual({ merge: true });
    });

    it('grants only the action XP later the same day, so concurrent requests cannot double the bonus', async () => {
      stats({ lastActivityDate: '2026-09-24', streak: 5 });
      await recordActivity('u1', { xp: 10, quizCorrect: true }, now);
      expect(written()).toEqual({
        lastActivity: now.toISOString(),
        xp: { type: 'increment', value: 10 },
        quizCount: { type: 'increment', value: 1 },
      });
    });

    it('restarts the streak after a missed day, and starts one for a new user', async () => {
      stats({ lastActivityDate: '2026-09-20', streak: 9 });
      await recordActivity('u1', {}, now);
      expect(written()).toMatchObject({ streak: 1, xp: { value: DAILY_STREAK_XP } });

      mockTxn.set.mockClear();
      stats(null);
      await recordActivity('u1', {}, now);
      expect(written()).toMatchObject({ streak: 1, lastActivityDate: '2026-09-24' });
    });

    it('writes no XP field for a zero-XP action on an already-active day', async () => {
      stats({ lastActivityDate: '2026-09-24' });
      await recordActivity('u1', {}, now);
      expect(written()).toEqual({ lastActivity: now.toISOString() });
    });

    it('defaults the continued streak to 1 when the prior streak field is missing', async () => {
      const yesterday = '2026-09-23';
      stats({ lastActivityDate: yesterday }); // no `streak` field at all
      await recordActivity('u1', {}, now);
      expect(written()).toMatchObject({ streak: 1 });
    });

    it('never throws: gamification must not fail a study request', async () => {
      mockDb.runTransaction.mockRejectedValueOnce(new Error('contention'));
      await expect(recordActivity('u1', { xp: 5 }, now)).resolves.toBeUndefined();
    });

    it('never throws for a non-Error rejection either', async () => {
      mockDb.runTransaction.mockRejectedValueOnce('string rejection, not an Error instance');
      await expect(recordActivity('u1', { xp: 5 }, now)).resolves.toBeUndefined();
    });
  });
});
