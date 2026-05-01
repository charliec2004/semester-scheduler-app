/**
 * Shared Constants
 * Values shared between main and renderer processes
 */

// Days of the week
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
export type DayName = typeof DAY_NAMES[number];

export const SLOT_MINUTES = 10;
export const LEGACY_SLOT_MINUTES = 30;
export const MINUTES_PER_HOUR = 60;
const MINUTE_ALIGNMENT_TOLERANCE = 0.01;
export const SLOTS_PER_HOUR = MINUTES_PER_HOUR / SLOT_MINUTES;
export const DAY_START_MINUTES = 8 * MINUTES_PER_HOUR;
export const DAY_END_MINUTES = 17 * MINUTES_PER_HOUR;
export const TRAVEL_BUFFER_MINUTES = 10;

function format24Hour(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

export function minutesToSlots(minutes: number): number {
  if (minutes % SLOT_MINUTES !== 0) {
    throw new Error(`${minutes} is not divisible by the slot duration (${SLOT_MINUTES})`);
  }
  return minutes / SLOT_MINUTES;
}

export function hoursToSlots(hours: number): number {
  const minutes = hours * MINUTES_PER_HOUR;
  const roundedMinutes = Math.round(minutes);
  if (Math.abs(minutes - roundedMinutes) > MINUTE_ALIGNMENT_TOLERANCE || roundedMinutes % SLOT_MINUTES !== 0) {
    throw new Error(`${hours} hours is not aligned to the ${SLOT_MINUTES}-minute slot grid`);
  }
  return roundedMinutes / SLOT_MINUTES;
}

export function slotsToHours(slots: number): number {
  return slots / SLOTS_PER_HOUR;
}

export function isSlotAlignedHours(hours: number): boolean {
  const minutes = hours * MINUTES_PER_HOUR;
  const roundedMinutes = Math.round(minutes);
  return (
    Math.abs(minutes - roundedMinutes) <= MINUTE_ALIGNMENT_TOLERANCE &&
    roundedMinutes % SLOT_MINUTES === 0
  );
}

export interface DayTravelBuffer {
  beforeNextCommitment: boolean;
  afterPreviousCommitment: boolean;
}

function buildTimeSlotStarts(slotMinutes: number): string[] {
  const slotCount = (DAY_END_MINUTES - DAY_START_MINUTES) / slotMinutes;
  return Array.from(
    { length: slotCount },
    (_, index) => format24Hour(DAY_START_MINUTES + index * slotMinutes),
  );
}

// Time slots (10-minute increments, 8am-5pm)
export const TIME_SLOT_STARTS = buildTimeSlotStarts(SLOT_MINUTES);
export const LEGACY_TIME_SLOT_STARTS = buildTimeSlotStarts(LEGACY_SLOT_MINUTES);

export type TimeSlot = string;

// Generate all availability column names
export const AVAILABILITY_COLUMNS = DAY_NAMES.flatMap(day =>
  TIME_SLOT_STARTS.map(time => `${day}_${time}`)
);
export const LEGACY_AVAILABILITY_COLUMNS = DAY_NAMES.flatMap(day =>
  LEGACY_TIME_SLOT_STARTS.map(time => `${day}_${time}`)
);
export const TRAVEL_BUFFER_BEFORE_COLUMNS = Object.fromEntries(
  DAY_NAMES.map(day => [day, `${day}_before_next_commitment`]),
) as Record<DayName, string>;
export const TRAVEL_BUFFER_AFTER_COLUMNS = Object.fromEntries(
  DAY_NAMES.map(day => [day, `${day}_after_previous_commitment`]),
) as Record<DayName, string>;
export const TRAVEL_BUFFER_COLUMNS = DAY_NAMES.flatMap(day => [
  TRAVEL_BUFFER_BEFORE_COLUMNS[day],
  TRAVEL_BUFFER_AFTER_COLUMNS[day],
]);

export function createDefaultTravelBuffers(): Record<DayName, DayTravelBuffer> {
  return Object.fromEntries(
    DAY_NAMES.map(day => [day, { beforeNextCommitment: false, afterPreviousCommitment: false }]),
  ) as Record<DayName, DayTravelBuffer>;
}

export function createDefaultAvailability(): Record<string, boolean> {
  return Object.fromEntries(AVAILABILITY_COLUMNS.map(column => [column, false]));
}

function hasOwnAvailabilityKey(
  availability: Record<string, boolean>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(availability, key);
}

export function normalizeAvailabilityMap(
  availability?: Record<string, boolean> | null,
): Record<string, boolean> {
  const normalized = createDefaultAvailability();
  if (!availability) {
    return normalized;
  }

  const currentKeyCount = AVAILABILITY_COLUMNS.filter(column => hasOwnAvailabilityKey(availability, column)).length;
  const legacyKeyCount = LEGACY_AVAILABILITY_COLUMNS.filter(column => hasOwnAvailabilityKey(availability, column)).length;

  const hasCompleteCurrentGrid = currentKeyCount === AVAILABILITY_COLUMNS.length;
  const hasCompleteLegacyGrid = legacyKeyCount === LEGACY_AVAILABILITY_COLUMNS.length;

  if (hasCompleteCurrentGrid || (currentKeyCount > 0 && !hasCompleteLegacyGrid)) {
    for (const column of AVAILABILITY_COLUMNS) {
      if (hasOwnAvailabilityKey(availability, column)) {
        normalized[column] = Boolean(availability[column]);
      }
    }
    return normalized;
  }

  if (legacyKeyCount === 0) {
    return normalized;
  }

  const legacyStride = LEGACY_SLOT_MINUTES / SLOT_MINUTES;
  for (const day of DAY_NAMES) {
    for (const [legacyIndex, time] of LEGACY_TIME_SLOT_STARTS.entries()) {
      const legacyColumn = `${day}_${time}`;
      if (!availability[legacyColumn]) {
        continue;
      }
      for (let offset = 0; offset < legacyStride; offset += 1) {
        const currentTime = TIME_SLOT_STARTS[legacyIndex * legacyStride + offset];
        normalized[`${day}_${currentTime}`] = true;
      }
    }
  }

  return normalized;
}

// Common roles - only front_desk is hard-coded; other roles come from departments
export const COMMON_ROLES: readonly string[] = ['front_desk'];

export type Role = typeof COMMON_ROLES[number] | string;

// Solver defaults
export const DEFAULT_SOLVER_MAX_TIME = 180; // seconds
export const DEFAULT_MIN_SLOTS = hoursToSlots(2); // 2 hours
export const DEFAULT_MAX_SLOTS = hoursToSlots(4); // 4 hours

// Validation limits
export const MAX_HOURS_PER_WEEK = 40;
export const MIN_HOURS_PER_WEEK = 0;
export const MAX_YEAR = 6;
export const MIN_YEAR = 1;
