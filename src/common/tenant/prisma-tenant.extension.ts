import { Prisma } from '@prisma/client';
import { getTenantStore } from './tenant-context';

// ponytail: services must use findFirst (not findUnique) for id lookups on these models.
// findUnique's `where` only accepts unique-field combinations; adding companyId there is
// version-dependent Prisma behavior. findFirst avoids the ambiguity entirely — one fewer
// edge case to reason about for a security-critical extension.
const TENANT_MODELS = new Set(['User', 'Project', 'Task', 'AuditLog']);

const READ_OPS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);
const WRITE_MANY_OPS = new Set(['updateMany', 'deleteMany']);
const WRITE_ONE_OPS = new Set(['update', 'delete']);

export const tenantExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: 'tenant-scoping',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODELS.has(model)) {
            return query(args);
          }

          const { companyId } = getTenantStore(); // throws if no context bound — fail loud

          // Cast to `any`: $allOperations' args type is a union across every model/operation
          // combination, which TypeScript can't narrow from the runtime `model`/`operation`
          // string checks above. The injected shape is still correct per-operation at runtime.
          const mutableArgs = args as any;

          if (operation === 'create') {
            mutableArgs.data = { ...mutableArgs.data, companyId };
          } else if (operation === 'createMany') {
            mutableArgs.data = Array.isArray(mutableArgs.data)
              ? mutableArgs.data.map((row: object) => ({ ...row, companyId }))
              : { ...mutableArgs.data, companyId };
          } else if (
            READ_OPS.has(operation) ||
            WRITE_MANY_OPS.has(operation) ||
            WRITE_ONE_OPS.has(operation)
          ) {
            mutableArgs.where = { ...(mutableArgs.where ?? {}), companyId };
          }

          return query(mutableArgs);
        },
      },
    },
  }),
);
