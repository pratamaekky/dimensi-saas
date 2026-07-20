import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantExtension } from '../common/tenant/prisma-tenant.extension';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly base: PrismaClient;
  readonly scoped;

  constructor() {
    this.base = new PrismaClient();
    this.scoped = this.base.$extends(tenantExtension);
  }

  async onModuleInit() {
    await this.base.$connect();
  }

  async onModuleDestroy() {
    await this.base.$disconnect();
  }
}
