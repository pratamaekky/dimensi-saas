import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { JobsModule } from '../jobs/jobs.module';
import { AuditModule } from '../audit/audit.module';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';

@Module({
  imports: [ProjectsModule, JobsModule, AuditModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
