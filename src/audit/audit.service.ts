import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantStore } from '../common/tenant/tenant-context';

interface RecordInput {
  action: string; // e.g. "project.create", "task.update"
  entity: 'Project' | 'Task';
  entityId: string;
  // Simple delta of the mutating DTO, not a full before/after diff (spec §9).
  changes?: unknown;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(input: RecordInput) {
    const { userId } = getTenantStore();
    return this.prisma.scoped.auditLog.create({
      data: {
        actorId: userId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        changes: input.changes as any,
      } as any,
    });
  }
}
