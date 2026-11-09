// Marathon & running events · S5 — what a participant (and the desk) is told about the kit. Pure.
//   kitStateOf   the COMPUTED state (spec §4.6): the stored `collected` / `exception`, else `ready` when the place is
//                confirmed, its ticket is active and the event hands out a kit, else `not_ready`. No backfill needed.
//   scanningOf   `scanning` is true only with EVENTS_KIT_OPS on, a kit to hand out and an event that is open for it.
export const KIT_OPEN_STATUSES = Object.freeze(['published', 'registration_closed', 'in_progress']);

export function kitStateOf({ reg, hasActiveTicket, event }) {
  if (reg.kitStatus === 'collected' || reg.kitStatus === 'exception') return reg.kitStatus;
  return reg.status === 'confirmed' && hasActiveTicket && event?.kitProvided === true ? 'ready' : 'not_ready';
}

export const scanningOf = (event, kitOpsOn) => kitOpsOn === true && event?.kitProvided === true && KIT_OPEN_STATUSES.includes(event?.status);

/** What a participant sees: a staff-recorded exception reads as "not ready" (they are told to ask the organizer). */
export const participantKitState = state => (state === 'exception' ? 'not_ready' : state);

/** Is `at` inside any of the point's opening windows? A point with no windows never warns. */
export function insideWindows(windows, at) {
  const list = Array.isArray(windows) ? windows.filter(w => w?.opensAt && w?.closesAt) : [];
  if (!list.length) return true;
  const t = +new Date(at);
  return list.some(w => +new Date(w.opensAt) <= t && t <= +new Date(w.closesAt));
}
