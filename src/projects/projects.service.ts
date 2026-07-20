import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertOwned } from '../common/tenant/assert-owned';
import { getTenantStore } from '../common/tenant/tenant-context';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { paginate } from '../common/pagination/paginate';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateProjectDto) {
    // `data` statically requires `companyId`/`company`, which the tenant extension injects
    // at runtime and Prisma's generated types can't see — see prisma-tenant.extension.ts.
    const project = await this.prisma.scoped.project.create({ data: dto as any });
    await this.audit.record({ action: 'project.create', entity: 'Project', entityId: project.id, changes: dto });
    return project;
  }

  async findAll({ page, limit }: PaginationQueryDto) {
    const [items, total] = await Promise.all([
      this.prisma.scoped.project.findMany({
        include: { _count: { select: { tasks: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.scoped.project.count(),
    ]);
    return paginate(items, total, page, limit);
  }

  async findOne(id: string) {
    const { companyId } = getTenantStore();
    const project = await this.prisma.scoped.project.findFirst({ where: { id } });
    return assertOwned(project, companyId);
  }

  async update(id: string, dto: UpdateProjectDto) {
    await this.findOne(id); // 404 if missing/cross-tenant, via Layer 2 assert
    const { count } = await this.prisma.scoped.project.updateMany({ where: { id }, data: dto });
    if (count === 0) throw new NotFoundException();
    await this.audit.record({ action: 'project.update', entity: 'Project', entityId: id, changes: dto });
    return this.findOne(id);
  }

  async remove(id: string) {
    await this.findOne(id);
    const { count } = await this.prisma.scoped.project.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException();
    await this.audit.record({ action: 'project.delete', entity: 'Project', entityId: id });
  }
}
