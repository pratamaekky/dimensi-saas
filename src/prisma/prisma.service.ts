import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly base: PrismaClient;

  constructor() {
    this.base = new PrismaClient();
  }

  async onModuleInit() {
    await this.base.$connect();
  }

  async onModuleDestroy() {
    await this.base.$disconnect();
  }
}
