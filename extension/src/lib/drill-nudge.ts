import { createApiClient, fetchDrillQueue } from "@study-flow/client";
import { storageGet } from "./chrome-storage";
import { readConfiguredApiUrl, type BackgroundRuntimeDeps } from "./background-runtime";
import { STORAGE_KEYS } from "./messages";

/** How often the background worker re-checks the drill queue. */
export const DRILL_NUDGE_ALARM = "drill-nudge";
export const DRILL_NUDGE_PERIOD_MINUTES = 60;
const BADGE_COLOR = "#0f9f94";

/** The slice of chrome.action the nudge uses, so it can be tested without Chrome. */
export interface BadgeApi {
  setBadgeText(details: { text: string }): Promise<void> | void;
  setBadgeBackgroundColor(details: { color: string }): Promise<void> | void;
  setTitle(details: { title: string }): Promise<void> | void;
}

export function badgeTextFor(dueCount: number): string {
  if (dueCount <= 0) return "";
  return dueCount > 9 ? "9+" : String(dueCount);
}

export function badgeTitleFor(dueCount: number): string {
  if (dueCount <= 0) return "Open Study Flow";
  return `Study Flow: ${dueCount} concept${dueCount === 1 ? "" : "s"} due for review`;
}

async function showDueCount(action: BadgeApi, dueCount: number): Promise<void> {
  await action.setBadgeText({ text: badgeTextFor(dueCount) });
  if (dueCount > 0) await action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await action.setTitle({ title: badgeTitleFor(dueCount) });
}

/**
 * Show how many concepts are due for review on the toolbar icon: a quiet, glanceable nudge that
 * brings the student back when FSRS says recall is slipping, without notification spam.
 * Counts only `due` reviews; new, never-studied concepts are not "due".
 * Signed out or failed (e.g. the stored ID token expired) → clear the badge rather than show a
 * stale count; the next alarm or sign-in refreshes it. Returns the count shown.
 */
export async function refreshDrillBadge(
  deps: Pick<BackgroundRuntimeDeps, "localStorage" | "sessionStorage" | "fetchImpl" | "mode"> & { action: BadgeApi },
): Promise<number> {
  const session = await storageGet<{ firebaseIdToken?: string }>(deps.sessionStorage, [STORAGE_KEYS.firebaseIdToken]);
  const token = session.firebaseIdToken;
  if (!token) {
    await showDueCount(deps.action, 0);
    return 0;
  }

  try {
    const apiUrl = await readConfiguredApiUrl(deps.localStorage, undefined, deps.mode);
    const client = createApiClient({ apiUrl, getAuthToken: () => token, fetchImpl: deps.fetchImpl, mode: deps.mode });
    const { queue } = await fetchDrillQueue(client);
    const dueCount = queue.filter((item) => item.due).length;
    await showDueCount(deps.action, dueCount);
    return dueCount;
  } catch {
    await showDueCount(deps.action, 0);
    return 0;
  }
}
