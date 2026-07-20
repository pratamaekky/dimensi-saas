import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Role } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { assertOwned } from '../common/tenant/assert-owned';
import { getTenantStore } from '../common/tenant/tenant-context';
import { NotificationJobData } from '../jobs/notifications.processor';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    @InjectQueue('notifications') private readonly notifications: Queue<NotificationJobData>,
  ) {}

  async create(projectId: string, dto: CreateTaskDto) {
    await this.projects.findOne(projectId); // 404 if project missing/cross-tenant
    const { companyId } = getTenantStore();
    const task = await this.prisma.scoped.task.create({
      data: { projectId, title: dto.title, assigneeId: dto.assigneeId } as any,
    });
    if (task.assigneeId) {
      await this.notifications.add('task-assigned', {
        companyId,
        taskId: task.id,
        projectId,
        assigneeId: task.assigneeId,
        action: 'created',
      });
    }
    return task;
  }

  async findAll(projectId: string) {
    await this.projects.findOne(projectId);
    return this.prisma.scoped.task.findMany({
      where: { projectId },
      include: { assignee: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(projectId: string, id: string) {
    const { companyId } = getTenantStore();
    await this.projects.findOne(projectId);
    const task = await this.prisma.scoped.task.findFirst({ where: { id, projectId } });
    return assertOwned(task, companyId);
  }

  async update(projectId: string, id: string, dto: UpdateTaskDto) {
    const { userId, role, companyId } = getTenantStore();
    const task = await this.findOne(projectId, id); // 404 if missing/cross-tenant

    // Fine-grained RBAC (spec §6): can't be a route guard — depends on the resource's
    // assignee, not just the caller's role.
    if (role !== Role.ADMIN && task.assigneeId !== userId) {
      throw new ForbiddenException('Only the assignee or an admin can update this task');
    }

    const { version, ...rest } = dto;
    const { count } = await this.prisma.scoped.task.updateMany({
      where: { id, projectId, version },
      data: { ...rest, version: { increment: 1 } },
    });
    if (count === 0) {
      throw new ConflictException('Task was modified by another process');
    }

    const updated = await this.findOne(projectId, id);
    if (dto.assigneeId && dto.assigneeId !== task.assigneeId) {
      await this.notifications.add('task-assigned', {
        companyId,
        taskId: updated.id,
        projectId,
        assigneeId: dto.assigneeId,
        action: 'reassigned',
      });
    }
    return updated;
  }

  async remove(projectId: string, id: string) {
    await this.findOne(projectId, id);
    const { count } = await this.prisma.scoped.task.deleteMany({ where: { id, projectId } });
    if (count === 0) throw new NotFoundException();
  }
}
