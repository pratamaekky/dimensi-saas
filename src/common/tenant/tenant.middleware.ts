import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NextFunction, Request, Response } from 'express';
import { tenantContext } from './tenant-context';
import { JwtPayload } from '../../auth/auth.service';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly jwt: JwtService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      // No token: public routes proceed with no context; protected routes will be
      // rejected with 401 by JwtAuthGuard (no context bound = not authenticated).
      return next();
    }

    try {
      const payload = this.jwt.verify<JwtPayload>(token);
      tenantContext.run(
        { userId: payload.sub, companyId: payload.companyId, role: payload.role },
        next,
      );
    } catch {
      // Invalid/expired token: proceed without context; guard turns this into 401.
      next();
    }
  }
}
