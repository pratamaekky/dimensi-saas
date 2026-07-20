import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';

@Controller('projects/:projectId/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  @Roles(Role.ADMIN)
  create(@Param('projectId') projectId: string, @Body() dto: CreateTaskDto) {
    return this.tasks.create(projectId, dto);
  }

  @Get()
  findAll(@Param('projectId') projectId: string, @Query() pagination: PaginationQueryDto) {
    return this.tasks.findAll(projectId, pagination);
  }

  @Get(':id')
  findOne(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.tasks.findOne(projectId, id);
  }

  @Patch(':id')
  update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasks.update(projectId, id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.tasks.remove(projectId, id);
  }
}
