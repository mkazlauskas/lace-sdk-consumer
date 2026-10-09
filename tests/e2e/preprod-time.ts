// Cardano Preprod slot arithmetic. Preprod starts at 2022-06-01T00:00:00Z
// with four Byron epochs of 21600 slots of 20 seconds. From slot 86400 on,
// every slot lasts one second.

export const PREPROD_SYSTEM_START_SECONDS = 1_654_041_600;
export const PREPROD_SHELLEY_START_SLOT = 86_400;
export const PREPROD_SHELLEY_START_SECONDS = PREPROD_SYSTEM_START_SECONDS + PREPROD_SHELLEY_START_SLOT * 20;
export const PREPROD_SHELLEY_EPOCH = 4;
export const PREPROD_EPOCH_LENGTH = 432_000;

/** The Preprod slot that holds the instant `posixMs`. */
export function preprodSlotAt(posixMs: number): number {
  return PREPROD_SHELLEY_START_SLOT + Math.floor(posixMs / 1000 - PREPROD_SHELLEY_START_SECONDS);
}

/** The POSIX milliseconds at which a Preprod slot after the Byron era starts. */
export function preprodSlotStart(slot: number): number {
  return (PREPROD_SHELLEY_START_SECONDS + (slot - PREPROD_SHELLEY_START_SLOT)) * 1000;
}

/** The Preprod epoch that holds a slot after the Byron era. */
export function preprodEpochOf(slot: number): number {
  return PREPROD_SHELLEY_EPOCH + Math.floor((slot - PREPROD_SHELLEY_START_SLOT) / PREPROD_EPOCH_LENGTH);
}
