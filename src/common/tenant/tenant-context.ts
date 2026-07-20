import { AsyncLocalStorage } from 'node:async_hooks';
import { Role } from '@prisma/client';

export interface TenantStore {
  companyId: string;
  userId: string;
  role: Role;
}

export const tenantContext = new AsyncLocalStorage<TenantStore>();

/** Throws if called outside a request bound to tenant context — fail loud, per spec §4.2 Layer 1. */
export function getTenantStore(): TenantStore {
  const store = tenantContext.getStore();
  if (!store) {
    throw new Error(
      'No tenant context bound. prisma.scoped must only be used inside a request that passed through TenantMiddleware.',
    );
  }
  return store;
}

export function getTenantStoreOrNull(): TenantStore | undefined {
  return tenantContext.getStore();
}
