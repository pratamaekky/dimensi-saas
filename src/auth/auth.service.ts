import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantStore } from '../common/tenant/tenant-context';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';

export interface JwtPayload {
  sub: string;
  companyId: string;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const REFRESH_TOKEN_BYTES = 40;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<TokenPair> {
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

    return this.issueTokens(user.id, user.companyId, user.role);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    // Base (unscoped) client: no tenant context exists yet at login time.
    // Email is unique per-company, not globally (spec §8.1) — first match wins.
    // This is a documented compromise, not a bug: see README §8.1.
    const user = await this.prisma.base.user.findFirst({ where: { email: dto.email } });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issueTokens(user.id, user.companyId, user.role);
  }

  async refresh(dto: RefreshDto): Promise<TokenPair> {
    // Same reasoning as login: no tenant context yet, identity comes from the
    // refresh token itself, so this goes through prisma.base.
    const tokenHash = this.hashToken(dto.refreshToken);
    const record = await this.prisma.base.refreshToken.findFirst({
      where: { tokenHash, revokedAt: null },
      include: { user: true },
    });
    if (!record || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotate: revoke the token that was just used so it can't be replayed.
    await this.prisma.base.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(record.user.id, record.user.companyId, record.user.role);
  }

  async logout(): Promise<void> {
    const { userId } = getTenantStore();
    // Revokes every active refresh token for this user (all devices/sessions) —
    // simplest correct semantics for "logout" without per-device session tracking.
    // The access token already in the client's hands stays valid until it expires
    // naturally (stateless JWT, no blacklist) — bounded to JWT_EXPIRES (15m default).
    await this.prisma.base.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(userId: string, companyId: string, role: Role): Promise<TokenPair> {
    const payload: JwtPayload = { sub: userId, companyId, role };
    const accessToken = this.jwt.sign(payload);

    const rawRefreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const ttlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS', 30);
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    await this.prisma.base.refreshToken.create({
      data: { userId, tokenHash: this.hashToken(rawRefreshToken), expiresAt },
    });

    return { accessToken, refreshToken: rawRefreshToken };
  }

  // Refresh tokens are opaque random bytes, not JWTs — only the hash is persisted,
  // so a DB leak alone doesn't hand out usable tokens (mirrors password hashing intent).
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
