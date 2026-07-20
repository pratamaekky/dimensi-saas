import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUserDto) {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.scoped.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        passwordHash,
        role: dto.role ?? Role.MEMBER,
      } as any,
    });
    const { passwordHash: _omit, ...safe } = user as { passwordHash: string } & Record<string, unknown>;
    return safe;
  }

  async findAll() {
    const users = await this.prisma.scoped.user.findMany({ orderBy: { createdAt: 'desc' } });
    return (users as ({ passwordHash: string } & Record<string, unknown>)[]).map(
      ({ passwordHash: _omit, ...safe }) => safe,
    );
  }
}
