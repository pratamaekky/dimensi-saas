import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export interface NotificationJobData {
  companyId: string;
  taskId: string;
  projectId: string;
  assigneeId: string;
  action: 'created' | 'reassigned';
}

@Processor('notifications')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { companyId, taskId, assigneeId, action } = job.data;

    // No AsyncLocalStorage tenant context out here (spec §10) — filter companyId
    // manually from the job payload, using the base (unscoped) client.
    const [task, assignee] = await Promise.all([
      this.prisma.base.task.findFirst({ where: { id: taskId, companyId } }),
      this.prisma.base.user.findFirst({ where: { id: assigneeId, companyId } }),
    ]);

    if (!task || !assignee) {
      this.logger.warn(`Skipping notification: task or assignee not found for company ${companyId}`);
      return;
    }

    this.logger.log(
      `[mock email] To: ${assignee.email} — you were ${action === 'created' ? 'assigned' : 're-assigned'} to task "${task.title}"`,
    );
  }
}
