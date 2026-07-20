import { NotFoundException } from '@nestjs/common';

/**
 * Layer 2 explicit isolation check (spec §4.2). Redundant with the Prisma extension's
 * auto-injected companyId filter by construction, but intentional: makes the isolation
 * guarantee readable at the call site instead of relying purely on extension "magic"
 * (spec §8.2). 404 (not 403) so a guessed cross-tenant ID isn't distinguishable from a
 * nonexistent one (spec §4.3).
 */
export function assertOwned<T extends { companyId: string }>(
  record: T | null,
  companyId: string,
): T {
  if (!record || record.companyId !== companyId) {
    throw new NotFoundException();
  }
  return record;
}
