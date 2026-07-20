import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertOwned } from '../common/tenant/assert-owned';
import { getTenantStore } from '../common/tenant/tenant-context';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateProjectDto) {
    // `data` statically requires `companyId`/`company`, which the tenant extension injects
    // at runtime and Prisma's generated types can't see — see prisma-tenant.extension.ts.
    return this.prisma.scoped.project.create({ data: dto as any });
  }

  findAll() {
    return this.prisma.scoped.project.findMany({
      include: { _count: { select: { tasks: true } } },
      orderBy: { createdAt: 'desc' },
    });
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
    return this.findOne(id);
  }

  async remove(id: string) {
    await this.findOne(id);
    const { count } = await this.prisma.scoped.project.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException();
  }
}
