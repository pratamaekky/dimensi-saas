import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

export interface JwtPayload {
  sub: string;
  companyId: string;
  role: Role;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<{ accessToken: string }> {
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.base.$transaction(async (tx) => {
      const company = await tx.company.create({ data: { name: dto.companyName } });
      return tx.user.create({
        data: {
          companyId: company.id,
          email: dto.email,
          passwordHash,
          name: dto.name,
          role: Role.ADMIN,
        },
      });
    });

    return this.sign(user.id, user.companyId, user.role);
  }

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    // Base (unscoped) client: no tenant context exists yet at login time.
    // Email is unique per-company, not globally (spec §8.1) — first match wins.
    // This is a documented compromise, not a bug: see README §8.1.
    const user = await this.prisma.base.user.findFirst({ where: { email: dto.email } });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.sign(user.id, user.companyId, user.role);
  }

  private sign(sub: string, companyId: string, role: Role): { accessToken: string } {
    const payload: JwtPayload = { sub, companyId, role };
    return { accessToken: this.jwt.sign(payload) };
  }
}
