# Mini Project Management SaaS (Multi-Tenant) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the backend described in `docs/TECH_SPEC-pm-saas.md` — a multi-tenant mini
Asana/Trello backend (NestJS + Prisma + PostgreSQL + BullMQ/Redis) with defense-in-depth tenant
isolation, RBAC, optimistic locking, audit trail, and a background notification job.

**Architecture:** Row-level multi-tenancy enforced in three layers (AsyncLocalStorage tenant
context → Prisma Client Extension auto-scoping → explicit `assertOwned`/`updateMany+count`
checks in services). Thin controllers, all logic in services. Two Prisma clients: `prisma.base`
(unscoped, only for login/seed/worker) and `prisma.scoped` (auto-injects `companyId`, used by all
business services).

**Tech Stack:** NestJS 10, TypeScript, Prisma 5 + PostgreSQL, BullMQ + `@nestjs/bullmq` + Redis,
`@nestjs/jwt` (manual guard, no Passport), `class-validator`/`class-transformer`, `bcrypt`, Jest +
Supertest for e2e.

## Global Constraints

- Source of truth is `docs/TECH_SPEC-pm-saas.md`. Do not change Prisma schema field/index names
  (spec §3.2) or the cross-tenant response code (**404**, never 403 — spec §4.3) or the
  same-tenant RBAC response code (**403** — spec §6).
- `companyId` is **never** read from URL param / body / query string — only from the JWT via the
  AsyncLocalStorage tenant context (spec §4.2 Layer 0).
- All three tenant-isolation layers must exist (context, Prisma extension, explicit assert) — spec
  §4.2, §16. Do not implement only one.
- Tenant-scoped services (`Project`, `Task`, `User`, `AuditLog`) always go through
  `prisma.scoped`. `prisma.base` is only used by: login (find user by email pre-context), seed,
  and the BullMQ worker (spec §4.2, §10).
- `PATCH .../tasks/:id` requires `version` in the body; mismatch → **409 Conflict**, not 404/400
  (spec §7).
- Response envelope: `{ success: true, data }` / `{ success: false, error: { code, message } }`
  (spec §7), applied globally via interceptor + exception filter.
- Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` — an
  unknown field (e.g. a client-supplied `companyId`) must be rejected with 400 (spec Test 3, §11).
- Node/npm already available locally (v26.4.0 / npm 11.17), Postgres 18 and Redis running
  locally (confirmed reachable at default ports). No Docker binary on this machine — the
  Dockerfile/docker-compose deliverables (spec §13) are written but cannot be locally verified by
  running them; note this in the README.
- Package manager: npm. Commit after each task, following spec §15's sequence (two intentional
  adjustments noted in Task 6 and Task 9 below, flagged here per spec §16's instruction to
  surface any assumption affecting isolation/RBAC — these two do not affect isolation/RBAC, only
  commit grouping).
- **Assumption (flag per spec §16):** the spec's commit plan (§15) has no dedicated step for the
  `/users` endpoints (spec §7, §6). Placed in Task 7 (RBAC) since the spec explicitly says
  `POST /users` "diperlukan agar RBAC ... bisa diuji" (§6) and Task 7 is where role guards are
  wired up. Document this placement decision in the README as an explicit assumption.
- **Deviation from spec §15 wording (flag per spec §16):** spec's commit 6 is "tasks crud nested
  under projects" and commit 9 is "audit trail + optimistic locking on task update" — implying
  optimistic locking is added *after* the base CRUD. Since §7 states the `PATCH` task contract
  **requires** `version` in the body from the start ("Update Task wajib optimistic locking"),
  shipping Task 6 without it would mean the endpoint temporarily violates its own documented
  contract. This plan implements optimistic locking as part of Task 6 (tasks CRUD) and keeps
  Task 9 scoped to audit trail only. This does not change any tenant-isolation or RBAC decision,
  only commit grouping — documented here as required by spec §16.

---

## Task 1: Init NestJS + Prisma + Docker Compose scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`
- Create: `src/main.ts`, `src/app.module.ts`
- Create: `.env.example`, `.env`, `.gitignore`
- Create: `docker-compose.yml`
- Create: `prisma/schema.prisma` (placeholder, replaced fully in Task 2)

**Interfaces:**
- Produces: running `npm run start:dev` boots a NestJS app on `PORT` (default 3000) with global
  prefix `api/v1`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "pm-saas",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main.js",
    "lint": "eslint \"{src,test}/**/*.ts\" --fix",
    "test": "jest",
    "test:e2e": "jest --config ./test/jest-e2e.json",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:deploy": "prisma migrate deploy",
    "prisma:seed": "ts-node prisma/seed.ts"
  },
  "dependencies": {
    "@nestjs/bullmq": "^10.2.0",
    "@nestjs/common": "^10.4.0",
    "@nestjs/config": "^3.3.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/jwt": "^10.2.0",
    "@nestjs/mapped-types": "^2.0.6",
    "@nestjs/platform-express": "^10.4.0",
    "@prisma/client": "^5.20.0",
    "bcrypt": "^5.1.1",
    "bullmq": "^5.13.0",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.0",
    "@nestjs/schematics": "^10.2.0",
    "@nestjs/testing": "^10.4.0",
    "@types/bcrypt": "^5.0.2",
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.13",
    "@types/node": "^20.16.0",
    "@types/supertest": "^6.0.2",
    "jest": "^29.7.0",
    "prisma": "^5.20.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.5",
    "ts-loader": "^9.5.1",
    "ts-node": "^10.9.2",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2021",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": true,
    "noImplicitAny": true,
    "strictBindCallApply": false,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": false
  }
}
```

- [ ] **Step 3: Write `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

- [ ] **Step 4: Write `nest-cli.json`**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true }
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 6: Write `.env.example` and `.env`**

```
# .env.example
DATABASE_URL="postgresql://postgres@localhost:5432/pm_saas?schema=public"
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=change-me-in-production
JWT_EXPIRES=1d
PORT=3000
```

Copy the same content into `.env`, but set `DATABASE_URL` to match the local Postgres role
actually available (check with `psql -l` / `whoami`; on this machine the default superuser role
is the OS user, so `postgresql://$(whoami)@localhost:5432/pm_saas` — no password). Create the
database itself: `createdb pm_saas`.

- [ ] **Step 7: Write `docker-compose.yml`** (spec §13 nilai plus — written for grading /
  reviewer use; not run locally since Docker isn't installed on this machine)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: pm_saas
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pg_data:
```

- [ ] **Step 8: Write `src/main.ts`**

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

- [ ] **Step 9: Write placeholder `src/app.module.ts`** (filled in fully task-by-task; minimal
  bootable shell for now)

```typescript
import { Module } from '@nestjs/common';

@Module({})
export class AppModule {}
```

- [ ] **Step 10: Write placeholder `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

- [ ] **Step 11: Install dependencies and verify boot**

Run: `npm install`
Then run: `npm run build`
Expected: compiles with no errors (empty `AppModule` is valid).

- [ ] **Step 12: Commit**

```bash
git add package.json tsconfig.json tsconfig.build.json nest-cli.json .gitignore .env.example docker-compose.yml src/main.ts src/app.module.ts prisma/schema.prisma
git commit -m "chore: init nestjs + prisma + docker-compose (postgres, redis)"
```

(`.env` and `package-lock.json` are also created; `.env` is gitignored, `package-lock.json` should
be committed too — add it in the same commit.)

---

## Task 2: Prisma schema — company, user, project, task, audit

**Files:**
- Modify: `prisma/schema.prisma` (replace placeholder with spec §3.2 verbatim)
- Create: `prisma/seed.ts`

**Interfaces:**
- Produces: `Company`, `User`, `Project`, `Task`, `AuditLog` Prisma models; `Role` (`ADMIN`,
  `MEMBER`) and `TaskStatus` (`TODO`, `DOING`, `DONE`) enums — exact shape as spec §3.2, consumed
  by every later task via `@prisma/client` generated types.

- [ ] **Step 1: Replace `prisma/schema.prisma` with the exact schema from spec §3.2**

Copy verbatim from `docs/TECH_SPEC-pm-saas.md` lines 58–167 (the full `Company`, `User`,
`Project`, `Task`, `AuditLog` models, `Role` and `TaskStatus` enums, `datasource`/`generator`
blocks). Do not rename fields, columns (`@map`), or indexes.

- [ ] **Step 2: Generate client and create the first migration**

Run: `npx prisma generate`
Run: `npx prisma migrate dev --name init`
Expected: migration folder `prisma/migrations/<timestamp>_init/migration.sql` created, applied to
local `pm_saas` database, `@prisma/client` types generated.

- [ ] **Step 3: Write `prisma/seed.ts`**

```typescript
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);

  const companyA = await prisma.company.create({ data: { name: 'Acme Corp' } });
  await prisma.user.create({
    data: {
      companyId: companyA.id,
      email: 'admin@acme.test',
      passwordHash,
      name: 'Acme Admin',
      role: Role.ADMIN,
    },
  });

  const companyB = await prisma.company.create({ data: { name: 'Globex Inc' } });
  await prisma.user.create({
    data: {
      companyId: companyB.id,
      email: 'admin@globex.test',
      passwordHash,
      name: 'Globex Admin',
      role: Role.ADMIN,
    },
  });

  console.log('Seeded: admin@acme.test / admin@globex.test, password: password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 4: Run the seed and verify**

Run: `npx prisma db seed` (add `"prisma": { "seed": "ts-node prisma/seed.ts" }` to `package.json`
first)
Expected: console prints the seeded credentials; `npx prisma studio` (or a quick
`psql pm_saas -c 'select email, role from users;'`) shows 2 companies, 2 admin users.

- [ ] **Step 5: Commit**

```bash
git add prisma/ package.json
git commit -m "feat: prisma schema — company, user, project, task, audit"
```

---

## Task 3: Auth — register & login with JWT

**Files:**
- Create: `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`
- Create: `src/common/decorators/public.decorator.ts`
- Create: `src/auth/dto/register.dto.ts`, `src/auth/dto/login.dto.ts`
- Create: `src/auth/auth.service.ts`, `src/auth/auth.controller.ts`, `src/auth/auth.module.ts`
- Create: `src/common/interceptors/response.interceptor.ts`
- Create: `src/common/filters/http-exception.filter.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Produces: `PrismaService` with `.base: PrismaClient` (scoped client added in Task 4, typed as
  `PrismaClient` for now so Task 3 compiles standalone — Task 4 replaces the field type).
  `AuthService.register(dto): Promise<{ accessToken: string }>`,
  `AuthService.login(dto): Promise<{ accessToken: string }>`.
- Consumes: `@prisma/client` models from Task 2.

- [ ] **Step 1: Write `src/prisma/prisma.service.ts`**

```typescript
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
```

(The `.scoped` extended client is added in Task 4 — kept out of this task so auth, which
legitimately needs the *unscoped* client for login, doesn't depend on tenant-context code yet.)

- [ ] **Step 2: Write `src/prisma/prisma.module.ts`**

```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **Step 3: Write `src/common/decorators/public.decorator.ts`**

```typescript
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

- [ ] **Step 4: Write `src/auth/dto/register.dto.ts`**

```typescript
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class RegisterDto {
  @IsNotEmpty()
  companyName: string;

  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @MinLength(8)
  password: string;
}
```

- [ ] **Step 5: Write `src/auth/dto/login.dto.ts`**

```typescript
import { IsEmail, IsNotEmpty } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  password: string;
}
```

- [ ] **Step 6: Write `src/auth/auth.service.ts`**

```typescript
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
```

- [ ] **Step 7: Write `src/auth/auth.controller.ts`**

```typescript
import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
}
```

- [ ] **Step 8: Write `src/auth/auth.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES', '1d') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
```

- [ ] **Step 9: Write `src/common/interceptors/response.interceptor.ts`**

```typescript
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => ({ success: true, data })));
  }
}
```

- [ ] **Step 10: Write `src/common/filters/http-exception.filter.ts`**

```typescript
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  500: 'INTERNAL_ERROR',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Internal server error';
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      message =
        typeof body === 'string'
          ? body
          : Array.isArray((body as { message?: unknown }).message)
            ? ((body as { message: string[] }).message.join('; '))
            : ((body as { message?: string }).message ?? exception.message);
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    }

    response.status(status).json({
      success: false,
      error: { code: CODE_BY_STATUS[status] ?? 'ERROR', message },
    });
  }
}
```

- [ ] **Step 11: Wire up `src/app.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
```

- [ ] **Step 12: Manual verification**

Run: `npm run start:dev`
Run: `curl -s -X POST localhost:3000/api/v1/auth/register -H 'content-type: application/json' -d '{"companyName":"Test Co","name":"Alice","email":"alice@test.com","password":"password123"}'`
Expected: `{"success":true,"data":{"accessToken":"..."}}`
Run: `curl -s -X POST localhost:3000/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"alice@test.com","password":"password123"}'`
Expected: same shape, valid token.
Run: `curl -s -X POST localhost:3000/api/v1/auth/register -H 'content-type: application/json' -d '{}'`
Expected: `{"success":false,"error":{"code":"VALIDATION_ERROR", ...}}`, HTTP 400.

- [ ] **Step 13: Commit**

```bash
git add src/prisma src/auth src/common package-lock.json
git commit -m "feat: auth — register & login with jwt"
```

---

## Task 4: Tenant context (AsyncLocalStorage) + Prisma auto-scope extension

**Files:**
- Create: `src/common/tenant/tenant-context.ts`
- Create: `src/common/tenant/tenant.middleware.ts`
- Create: `src/common/tenant/prisma-tenant.extension.ts`
- Create: `src/common/tenant/assert-owned.ts`
- Create: `src/common/guards/jwt-auth.guard.ts`
- Modify: `src/prisma/prisma.service.ts` (add `.scoped`)
- Modify: `src/app.module.ts` (register middleware + global guard)

**Interfaces:**
- Produces: `getTenantStore(): TenantStore` (throws if unbound), `getTenantStoreOrNull()`,
  `tenantContext: AsyncLocalStorage<TenantStore>`, `assertOwned<T>(record, companyId): T` (throws
  `NotFoundException` — 404), `prisma.scoped` — extended client auto-injecting `companyId` on
  `User`/`Project`/`Task`/`AuditLog` for `findMany`/`findFirst`/`count`/`aggregate`/`groupBy`/
  `create`/`createMany`/`update`/`delete`/`updateMany`/`deleteMany`.
- Consumes: `JwtService` (Task 3), `PrismaService.base` (Task 3).

- [ ] **Step 1: Write `src/common/tenant/tenant-context.ts`**

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import { Role } from '@prisma/client';

export interface TenantStore {
  companyId: string;
  userId: string;
  role: Role;
}

export const tenantContext = new AsyncLocalStorage<TenantStore>();

/** Throws if called outside a request bound to tenant context — fail loud, per spec §4.2 Layer 1. */
export function getTenantStore(): TenantStore {
  const store = tenantContext.getStore();
  if (!store) {
    throw new Error(
      'No tenant context bound. prisma.scoped must only be used inside a request that passed through TenantMiddleware.',
    );
  }
  return store;
}

export function getTenantStoreOrNull(): TenantStore | undefined {
  return tenantContext.getStore();
}
```

- [ ] **Step 2: Write `src/common/tenant/prisma-tenant.extension.ts`**

```typescript
import { Prisma } from '@prisma/client';
import { getTenantStore } from './tenant-context';

// ponytail: services must use findFirst (not findUnique) for id lookups on these models.
// findUnique's `where` only accepts unique-field combinations; adding companyId there is
// version-dependent Prisma behavior. findFirst avoids the ambiguity entirely — one fewer
// edge case to reason about for a security-critical extension.
const TENANT_MODELS = new Set(['User', 'Project', 'Task', 'AuditLog']);

const READ_OPS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);
const WRITE_MANY_OPS = new Set(['updateMany', 'deleteMany']);
const WRITE_ONE_OPS = new Set(['update', 'delete']);

export const tenantExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: 'tenant-scoping',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODELS.has(model)) {
            return query(args);
          }

          const { companyId } = getTenantStore(); // throws if no context bound — fail loud

          if (operation === 'create') {
            args.data = { ...(args.data as object), companyId };
          } else if (operation === 'createMany') {
            const data = (args as { data: unknown }).data;
            (args as { data: unknown }).data = Array.isArray(data)
              ? data.map((row) => ({ ...(row as object), companyId }))
              : { ...(data as object), companyId };
          } else if (
            READ_OPS.has(operation) ||
            WRITE_MANY_OPS.has(operation) ||
            WRITE_ONE_OPS.has(operation)
          ) {
            args.where = { ...((args as { where?: object }).where ?? {}), companyId };
          }

          return query(args);
        },
      },
    },
  }),
);
```

- [ ] **Step 3: Write `src/common/tenant/assert-owned.ts`**

```typescript
import { NotFoundException } from '@nestjs/common';

/**
 * Layer 2 explicit isolation check (spec §4.2). Redundant with the Prisma extension's
 * auto-injected companyId filter by construction, but intentional: makes the isolation
 * guarantee readable at the call site instead of relying purely on extension "magic"
 * (spec §8.2). 404 (not 403) so a guessed cross-tenant ID isn't distinguishable from a
 * nonexistent one (spec §4.3).
 */
export function assertOwned<T extends { companyId: string }>(
  record: T | null,
  companyId: string,
): T {
  if (!record || record.companyId !== companyId) {
    throw new NotFoundException();
  }
  return record;
}
```

- [ ] **Step 4: Modify `src/prisma/prisma.service.ts`** to add the scoped client

```typescript
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantExtension } from '../common/tenant/prisma-tenant.extension';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly base: PrismaClient;
  readonly scoped: ReturnType<typeof this.extend>;

  constructor() {
    this.base = new PrismaClient();
    this.scoped = this.extend();
  }

  private extend() {
    return this.base.$extends(tenantExtension);
  }

  async onModuleInit() {
    await this.base.$connect();
  }

  async onModuleDestroy() {
    await this.base.$disconnect();
  }
}
```

(TypeScript needs `scoped`'s type before `extend` is called in the constructor — if
`ReturnType<typeof this.extend>` doesn't work in your TS version, declare
`readonly scoped: ReturnType<PrismaClient['$extends']>;` explicitly instead.)

- [ ] **Step 5: Write `src/common/tenant/tenant.middleware.ts`**

```typescript
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
```

- [ ] **Step 6: Write `src/common/guards/jwt-auth.guard.ts`**

```typescript
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { getTenantStoreOrNull } from '../tenant/tenant-context';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (!getTenantStoreOrNull()) {
      throw new UnauthorizedException('Missing or invalid token');
    }
    return true;
  }
}
```

- [ ] **Step 7: Wire up `src/app.module.ts`** (add middleware + global guard)

```typescript
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { TenantMiddleware } from './common/tenant/tenant.middleware';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
```

- [ ] **Step 8: Manual verification**

Run: `npm run start:dev`
Login with a seeded/registered user, then:
Run: `curl -s localhost:3000/api/v1/auth/register` with no `Authorization` header hitting any
not-yet-existing protected route isn't possible yet (no other modules exist) — verify instead
that `npm run build` compiles clean, and that register/login (both `@Public()`) still work
unauthenticated exactly as in Task 3's manual check.

- [ ] **Step 9: Commit**

```bash
git add src/common/tenant src/common/guards src/prisma/prisma.service.ts src/app.module.ts
git commit -m "feat: tenant context (AsyncLocalStorage) + prisma auto-scope extension"
```

---

## Task 5: Projects CRUD with tenant scoping (Layer 2 assert)

**Files:**
- Create: `src/common/decorators/roles.decorator.ts`
- Create: `src/common/guards/roles.guard.ts` (wired but not yet applied to routes — full RBAC
  wiring happens in Task 7; created now since Projects' write routes need it. Applying `@Roles`
  here is not a deviation: spec §7's endpoint table already assigns roles per route from the
  start, RBAC guard just needs to exist to enforce it.)
- Create: `src/projects/dto/create-project.dto.ts`, `src/projects/dto/update-project.dto.ts`
- Create: `src/projects/projects.service.ts`, `src/projects/projects.controller.ts`,
  `src/projects/projects.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Produces: `ProjectsService.create/findAll/findOne/update/remove`, all tenant-scoped.
- Consumes: `prisma.scoped` (Task 4), `assertOwned` (Task 4), `getTenantStore` (Task 4).

- [ ] **Step 1: Write `src/common/decorators/roles.decorator.ts`**

```typescript
import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 2: Write `src/common/guards/roles.guard.ts`**

```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { getTenantStore } from '../tenant/tenant-context';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true; // no @Roles = any authenticated role

    const { role } = getTenantStore();
    if (!required.includes(role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
```

- [ ] **Step 3: Write `src/projects/dto/create-project.dto.ts`**

```typescript
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateProjectDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}
```

- [ ] **Step 4: Write `src/projects/dto/update-project.dto.ts`**

```typescript
import { PartialType } from '@nestjs/mapped-types';
import { CreateProjectDto } from './create-project.dto';

export class UpdateProjectDto extends PartialType(CreateProjectDto) {}
```

- [ ] **Step 5: Write `src/projects/projects.service.ts`**

```typescript
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
    return this.prisma.scoped.project.create({ data: dto });
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
```

- [ ] **Step 6: Write `src/projects/projects.controller.ts`**

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateProjectDto) {
    return this.projects.create(dto);
  }

  @Get()
  findAll() {
    return this.projects.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.projects.findOne(id);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.projects.remove(id);
  }
}
```

- [ ] **Step 7: Write `src/projects/projects.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
```

- [ ] **Step 8: Register `RolesGuard` globally and import `ProjectsModule` in `src/app.module.ts`**

Add `ProjectsModule` to `imports`, and add `{ provide: APP_GUARD, useClass: RolesGuard }` after
the `JwtAuthGuard` provider (order: `JwtAuthGuard` first, then `RolesGuard` — auth must resolve
before role checks run).

- [ ] **Step 9: Manual verification**

Run: `npm run start:dev`. Register a user (becomes ADMIN of a fresh company), grab the token,
then:
Run: `curl -s -X POST localhost:3000/api/v1/projects -H "authorization: Bearer <token>" -H 'content-type: application/json' -d '{"name":"Website Revamp"}'`
Expected: 201, `{"success":true,"data":{"id":"...","name":"Website Revamp",...}}`.
Run: `curl -s localhost:3000/api/v1/projects -H "authorization: Bearer <token>"`
Expected: list includes the created project with `_count.tasks: 0`.
Run the same `GET /projects/:id` with a random UUID that doesn't exist.
Expected: 404 `NOT_FOUND`.

- [ ] **Step 10: Commit**

```bash
git add src/common/decorators/roles.decorator.ts src/common/guards/roles.guard.ts src/projects src/app.module.ts
git commit -m "feat: projects crud with tenant scoping (layer 2 assert)"
```

---

## Task 6: Tasks CRUD nested under projects (incl. optimistic locking)

**Files:**
- Create: `src/tasks/dto/create-task.dto.ts`, `src/tasks/dto/update-task.dto.ts`
- Create: `src/tasks/tasks.service.ts`, `src/tasks/tasks.controller.ts`, `src/tasks/tasks.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/projects/projects.module.ts` (export `ProjectsService` — already done in Task 5)

**Interfaces:**
- Produces: `TasksService.create/findAll/findOne/update/remove`, all tenant + project scoped;
  `update` enforces `version` optimistic lock → 409 on mismatch.
- Consumes: `ProjectsService.findOne` (Task 5, to assert the parent project exists/belongs to
  tenant before touching tasks), `prisma.scoped`, `assertOwned`, `getTenantStore` (Task 4).

- [ ] **Step 1: Write `src/tasks/dto/create-task.dto.ts`**

```typescript
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateTaskDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;
}
```

- [ ] **Step 2: Write `src/tasks/dto/update-task.dto.ts`**

```typescript
import { IsEnum, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';
import { TaskStatus } from '@prisma/client';

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsInt()
  version: number;
}
```

- [ ] **Step 3: Write `src/tasks/tasks.service.ts`**

```typescript
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { assertOwned } from '../common/tenant/assert-owned';
import { getTenantStore } from '../common/tenant/tenant-context';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async create(projectId: string, dto: CreateTaskDto) {
    await this.projects.findOne(projectId); // 404 if project missing/cross-tenant
    return this.prisma.scoped.task.create({
      data: { projectId, title: dto.title, assigneeId: dto.assigneeId },
    });
  }

  async findAll(projectId: string) {
    await this.projects.findOne(projectId);
    return this.prisma.scoped.task.findMany({
      where: { projectId },
      include: { assignee: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(projectId: string, id: string) {
    const { companyId } = getTenantStore();
    await this.projects.findOne(projectId);
    const task = await this.prisma.scoped.task.findFirst({ where: { id, projectId } });
    return assertOwned(task, companyId);
  }

  async update(projectId: string, id: string, dto: UpdateTaskDto) {
    const { userId, role } = getTenantStore();
    const task = await this.findOne(projectId, id); // 404 if missing/cross-tenant

    // Fine-grained RBAC (spec §6): can't be a route guard — depends on the resource's
    // assignee, not just the caller's role.
    if (role !== Role.ADMIN && task.assigneeId !== userId) {
      throw new ForbiddenException('Only the assignee or an admin can update this task');
    }

    const { version, ...rest } = dto;
    const { count } = await this.prisma.scoped.task.updateMany({
      where: { id, projectId, version },
      data: { ...rest, version: { increment: 1 } },
    });
    if (count === 0) {
      throw new ConflictException('Task was modified by another process');
    }
    return this.findOne(projectId, id);
  }

  async remove(projectId: string, id: string) {
    await this.findOne(projectId, id);
    const { count } = await this.prisma.scoped.task.deleteMany({ where: { id, projectId } });
    if (count === 0) throw new NotFoundException();
  }
}
```

- [ ] **Step 4: Write `src/tasks/tasks.controller.ts`**

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
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
  findAll(@Param('projectId') projectId: string) {
    return this.tasks.findAll(projectId);
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
```

(No `@Roles` on `update` — spec §7 note: "endpoint tidak dibatasi guard role; pembatasan ada di
service".)

- [ ] **Step 5: Write `src/tasks/tasks.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';

@Module({
  imports: [ProjectsModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
```

- [ ] **Step 6: Add `TasksModule` to `src/app.module.ts` imports**

- [ ] **Step 7: Manual verification**

Using the same ADMIN token from Task 5, create a task on the existing project:
Run: `curl -s -X POST localhost:3000/api/v1/projects/<projectId>/tasks -H "authorization: Bearer <token>" -H 'content-type: application/json' -d '{"title":"Set up CI"}'`
Expected: 201, `version: 0`.
Run: `PATCH` the task with the correct `version: 0` → 200, `version` becomes 1.
Run: the same `PATCH` again reusing `version: 0` (now stale) → 409 `CONFLICT`.
Run: `GET` a task under a random nonexistent `projectId` → 404.

- [ ] **Step 8: Commit**

```bash
git add src/tasks src/app.module.ts
git commit -m "feat: tasks crud nested under projects"
```

---

## Task 7: RBAC — role guard wiring, fine-grained task ownership, users module

**Files:**
- Create: `src/users/dto/create-user.dto.ts`
- Create: `src/users/users.service.ts`, `src/users/users.controller.ts`, `src/users/users.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Produces: `UsersService.create/findAll` (ADMIN-only, scoped to caller's company).
- Consumes: `prisma.scoped`, `getTenantStore` (Task 4). `RolesGuard`/`@Roles` already exist from
  Task 5; the route-level piece of RBAC (spec §6 "Kasar (route-level)") is already enforced on
  Projects/Tasks controllers. This task adds the Users resource specifically because spec §6
  states it's "diperlukan agar RBAC ... bisa diuji" — see Global Constraints assumption note.
  The fine-grained data-level piece (spec §6 "Halus (data-level)") was already implemented in
  Task 6's `TasksService.update`.

- [ ] **Step 1: Write `src/users/dto/create-user.dto.ts`**

```typescript
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, MinLength } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateUserDto {
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @MinLength(8)
  password: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
```

- [ ] **Step 2: Write `src/users/users.service.ts`**

```typescript
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
      },
    });
    const { passwordHash: _omit, ...safe } = user;
    return safe;
  }

  async findAll() {
    const users = await this.prisma.scoped.user.findMany({ orderBy: { createdAt: 'desc' } });
    return users.map(({ passwordHash: _omit, ...safe }) => safe);
  }
}
```

- [ ] **Step 3: Write `src/users/users.controller.ts`**

```typescript
import { Body, Controller, Get, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';

@Controller('users')
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Get()
  findAll() {
    return this.users.findAll();
  }
}
```

- [ ] **Step 4: Write `src/users/users.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 5: Add `UsersModule` to `src/app.module.ts` imports**

- [ ] **Step 6: Manual verification**

Using the ADMIN token: `POST /users` with `{"name":"Bob","email":"bob@test.com","password":"password123"}`
Expected: 201, no `passwordHash` in response, `role: "MEMBER"`.
Log in as Bob, then `POST /projects` with Bob's token → 403 `FORBIDDEN`.
`GET /users` with Bob's token → 403 `FORBIDDEN`.

- [ ] **Step 7: Commit**

```bash
git add src/users src/app.module.ts
git commit -m "feat: rbac guard — admin vs member + fine-grained task ownership"
```

---

## Task 8: BullMQ notification job on task assignment

**Files:**
- Create: `src/jobs/notifications.processor.ts`
- Create: `src/jobs/jobs.module.ts`
- Modify: `src/app.module.ts` (register `BullModule.forRootAsync`)
- Modify: `src/tasks/tasks.service.ts`, `src/tasks/tasks.module.ts` (enqueue on assignment)

**Interfaces:**
- Produces: queue `notifications`, job name `task-assigned`, payload
  `{ companyId, taskId, projectId, assigneeId, action: 'created' | 'reassigned' }`.
- Consumes: `Queue` from `@nestjs/bullmq` (producer, injected into `TasksService`),
  `PrismaService.base` (worker — spec §10: no ALS context in the worker).

- [ ] **Step 1: Write `src/jobs/notifications.processor.ts`**

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export interface NotificationJobData {
  companyId: string;
  taskId: string;
  projectId: string;
  assigneeId: string;
  action: 'created' | 'reassigned';
}

@Processor('notifications')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { companyId, taskId, assigneeId, action } = job.data;

    // No AsyncLocalStorage tenant context out here (spec §10) — filter companyId
    // manually from the job payload, using the base (unscoped) client.
    const [task, assignee] = await Promise.all([
      this.prisma.base.task.findFirst({ where: { id: taskId, companyId } }),
      this.prisma.base.user.findFirst({ where: { id: assigneeId, companyId } }),
    ]);

    if (!task || !assignee) {
      this.logger.warn(`Skipping notification: task or assignee not found for company ${companyId}`);
      return;
    }

    this.logger.log(
      `[mock email] To: ${assignee.email} — you were ${action === 'created' ? 'assigned' : 're-assigned'} to task "${task.title}"`,
    );
  }
}
```

- [ ] **Step 2: Write `src/jobs/jobs.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsProcessor } from './notifications.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'notifications' })],
  providers: [NotificationsProcessor],
  exports: [BullModule],
})
export class JobsModule {}
```

- [ ] **Step 3: Register `BullModule.forRootAsync` in `src/app.module.ts`**

Add to imports, before `JobsModule`:

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: {
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    },
  }),
}),
JobsModule,
```

(Import `ConfigService` alongside the existing `ConfigModule` import.)

- [ ] **Step 4: Modify `src/tasks/tasks.module.ts`** to import `JobsModule`

```typescript
import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { JobsModule } from '../jobs/jobs.module';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';

@Module({
  imports: [ProjectsModule, JobsModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
```

- [ ] **Step 5: Modify `src/tasks/tasks.service.ts`** to enqueue on create/reassignment

Add imports and constructor param:

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationJobData } from '../jobs/notifications.processor';
```

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    @InjectQueue('notifications') private readonly notifications: Queue<NotificationJobData>,
  ) {}
```

Modify `create` to enqueue when `assigneeId` is present (producer only calls `queue.add` — spec
§10: never awaits delivery):

```typescript
  async create(projectId: string, dto: CreateTaskDto) {
    await this.projects.findOne(projectId);
    const { companyId } = getTenantStore();
    const task = await this.prisma.scoped.task.create({
      data: { projectId, title: dto.title, assigneeId: dto.assigneeId },
    });
    if (task.assigneeId) {
      await this.notifications.add('task-assigned', {
        companyId,
        taskId: task.id,
        projectId,
        assigneeId: task.assigneeId,
        action: 'created',
      });
    }
    return task;
  }
```

Modify `update` to enqueue when `assigneeId` changes to a new value:

```typescript
  async update(projectId: string, id: string, dto: UpdateTaskDto) {
    const { userId, role, companyId } = getTenantStore();
    const task = await this.findOne(projectId, id);

    if (role !== Role.ADMIN && task.assigneeId !== userId) {
      throw new ForbiddenException('Only the assignee or an admin can update this task');
    }

    const { version, ...rest } = dto;
    const { count } = await this.prisma.scoped.task.updateMany({
      where: { id, projectId, version },
      data: { ...rest, version: { increment: 1 } },
    });
    if (count === 0) {
      throw new ConflictException('Task was modified by another process');
    }

    const updated = await this.findOne(projectId, id);
    if (dto.assigneeId && dto.assigneeId !== task.assigneeId) {
      await this.notifications.add('task-assigned', {
        companyId,
        taskId: updated.id,
        projectId,
        assigneeId: dto.assigneeId,
        action: 'reassigned',
      });
    }
    return updated;
  }
```

- [ ] **Step 6: Manual verification**

Run: `npm run start:dev` (Redis already running locally per environment check).
Create a task with `assigneeId` set to a real user id → watch server logs for
`[mock email] To: ... — you were assigned to task "..."`.
`PATCH` the task changing `assigneeId` to a different user → log line with "re-assigned".

- [ ] **Step 7: Commit**

```bash
git add src/jobs src/tasks src/app.module.ts
git commit -m "feat: bullmq notification job on task assignment"
```

---

## Task 9: Audit trail

**Files:**
- Create: `src/audit/audit.service.ts`, `src/audit/audit.module.ts`
- Modify: `src/projects/projects.service.ts`, `src/projects/projects.module.ts`
- Modify: `src/tasks/tasks.service.ts`, `src/tasks/tasks.module.ts`

**Interfaces:**
- Produces: `AuditService.record({ action, entity, entityId, changes? })` — reads `companyId`/
  `actorId` from `getTenantStore()` internally, so callers don't pass them.
- Consumes: `prisma.scoped` (Task 4), `getTenantStore` (Task 4).

- [ ] **Step 1: Write `src/audit/audit.service.ts`**

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantStore } from '../common/tenant/tenant-context';

interface RecordInput {
  action: string; // e.g. "project.create", "task.update"
  entity: 'Project' | 'Task';
  entityId: string;
  changes?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(input: RecordInput) {
    const { userId } = getTenantStore();
    return this.prisma.scoped.auditLog.create({
      data: {
        actorId: userId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        changes: input.changes,
      },
    });
  }
}
```

- [ ] **Step 2: Write `src/audit/audit.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

- [ ] **Step 3: Modify `src/projects/projects.module.ts`** to import `AuditModule`

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

@Module({
  imports: [AuditModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
```

- [ ] **Step 4: Modify `src/projects/projects.service.ts`** to record audit entries

Add `private readonly audit: AuditService` to the constructor (import from `'../audit/audit.service'`),
then wrap the three mutating methods:

```typescript
  async create(dto: CreateProjectDto) {
    const project = await this.prisma.scoped.project.create({ data: dto });
    await this.audit.record({ action: 'project.create', entity: 'Project', entityId: project.id, changes: dto });
    return project;
  }
```

```typescript
  async update(id: string, dto: UpdateProjectDto) {
    await this.findOne(id);
    const { count } = await this.prisma.scoped.project.updateMany({ where: { id }, data: dto });
    if (count === 0) throw new NotFoundException();
    await this.audit.record({ action: 'project.update', entity: 'Project', entityId: id, changes: dto });
    return this.findOne(id);
  }
```

```typescript
  async remove(id: string) {
    await this.findOne(id);
    const { count } = await this.prisma.scoped.project.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException();
    await this.audit.record({ action: 'project.delete', entity: 'Project', entityId: id });
  }
```

- [ ] **Step 5: Modify `src/tasks/tasks.module.ts`** to import `AuditModule`

```typescript
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
```

- [ ] **Step 6: Modify `src/tasks/tasks.service.ts`** to record audit entries

Add `private readonly audit: AuditService` to the constructor, then record after each mutation:
after `create` (action `'task.create'`, `changes: dto`), after the version-checked update in
`update` (action `'task.update'`, `changes: rest`), after `remove` (action `'task.delete'`, no
`changes`) — same pattern as Projects above, inserted right before each method's `return`.

- [ ] **Step 7: Manual verification**

Create/update/delete a project and a task, then inspect directly:
Run: `psql pm_saas -c "select action, entity, entity_id, actor_id from audit_logs order by created_at;"`
Expected: one row per mutation, correct `action`/`entity`, `actor_id` matching the caller.

- [ ] **Step 8: Commit**

```bash
git add src/audit src/projects src/tasks
git commit -m "feat: audit trail on project & task mutations"
```

---

## Task 10: Tests — tenant isolation, RBAC, validation (e2e)

**Files:**
- Create: `test/jest-e2e.json`
- Create: `test/utils/test-app.ts`
- Create: `test/tenant-isolation.e2e-spec.ts`
- Create: `test/rbac.e2e-spec.ts`
- Create: `test/validation.e2e-spec.ts`
- Create: `test/race-condition.e2e-spec.ts`

**Interfaces:**
- Consumes: the full app (`AppModule`) via `@nestjs/testing`'s `Test.createTestingModule`, real
  local Postgres/Redis (no mocking — these are integration tests against the tenant-isolation
  guarantee itself, mocking the DB would defeat the point).

- [ ] **Step 1: Write `test/jest-e2e.json`**

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" }
}
```

- [ ] **Step 2: Write `test/utils/test-app.ts`** (shared bootstrap + auth helpers)

```typescript
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  return app;
}

export async function registerCompany(
  app: INestApplication,
  overrides: Partial<{ companyName: string; name: string; email: string; password: string }> = {},
) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const body = {
    companyName: overrides.companyName ?? `Test Co ${suffix}`,
    name: overrides.name ?? 'Admin',
    email: overrides.email ?? `admin-${suffix}@test.com`,
    password: overrides.password ?? 'password123',
  };
  const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(body);
  return { token: res.body.data.accessToken as string, ...body };
}

export async function createMember(app: INestApplication, adminToken: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `member-${suffix}@test.com`;
  const password = 'password123';
  await request(app.getHttpServer())
    .post('/api/v1/users')
    .set('authorization', `Bearer ${adminToken}`)
    .send({ name: 'Member', email, password });
  const loginRes = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password });
  return { token: loginRes.body.data.accessToken as string, email, password };
}
```

- [ ] **Step 3: Write `test/tenant-isolation.e2e-spec.ts`**

```typescript
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp, registerCompany } from './utils/test-app';

describe('Tenant isolation (spec §11 Test 1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 404 (never 403/200) when Company A guesses Company B project IDs', async () => {
    const companyA = await registerCompany(app);
    const companyB = await registerCompany(app);

    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('authorization', `Bearer ${companyB.token}`)
      .send({ name: 'Globex Secret Project' });
    const projectBId = projectRes.body.data.id;

    const get = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectBId}`)
      .set('authorization', `Bearer ${companyA.token}`);
    expect(get.status).toBe(404);

    const patch = await request(app.getHttpServer())
      .patch(`/api/v1/projects/${projectBId}`)
      .set('authorization', `Bearer ${companyA.token}`)
      .send({ name: 'Hijacked' });
    expect(patch.status).toBe(404);

    const del = await request(app.getHttpServer())
      .delete(`/api/v1/projects/${projectBId}`)
      .set('authorization', `Bearer ${companyA.token}`);
    expect(del.status).toBe(404);
  });

  it('excludes other companies\' projects from the list endpoint', async () => {
    const companyA = await registerCompany(app);
    const companyB = await registerCompany(app);

    await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('authorization', `Bearer ${companyB.token}`)
      .send({ name: 'Globex Only Project' });

    const list = await request(app.getHttpServer())
      .get('/api/v1/projects')
      .set('authorization', `Bearer ${companyA.token}`);

    expect(list.status).toBe(200);
    expect(list.body.data.some((p: { name: string }) => p.name === 'Globex Only Project')).toBe(false);
  });
});
```

- [ ] **Step 4: Write `test/rbac.e2e-spec.ts`**

```typescript
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createMember, createTestApp, registerCompany } from './utils/test-app';

describe('RBAC (spec §11 Test 2)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('member gets 403 deleting a project, 403 editing others\' tasks, 200 editing own task', async () => {
    const admin = await registerCompany(app);
    const member = await createMember(app, admin.token);

    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('authorization', `Bearer ${admin.token}`)
      .send({ name: 'Shared Project' });
    const projectId = projectRes.body.data.id;

    const delRes = await request(app.getHttpServer())
      .delete(`/api/v1/projects/${projectId}`)
      .set('authorization', `Bearer ${member.token}`);
    expect(delRes.status).toBe(403);

    const adminTaskRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set('authorization', `Bearer ${admin.token}`)
      .send({ title: 'Admin-owned task' });
    const adminTaskId = adminTaskRes.body.data.id;

    const forbiddenUpdate = await request(app.getHttpServer())
      .patch(`/api/v1/projects/${projectId}/tasks/${adminTaskId}`)
      .set('authorization', `Bearer ${member.token}`)
      .send({ title: 'hijacked', version: 0 });
    expect(forbiddenUpdate.status).toBe(403);

    // Admin creates a task assigned to the member — need the member's userId. Register
    // response doesn't expose it directly, so fetch it via /users.
    const usersRes = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('authorization', `Bearer ${admin.token}`);
    const memberId = usersRes.body.data.find((u: { email: string }) => u.email === member.email).id;

    const memberTaskRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set('authorization', `Bearer ${admin.token}`)
      .send({ title: 'Member-owned task', assigneeId: memberId });
    const memberTaskId = memberTaskRes.body.data.id;

    const ownUpdate = await request(app.getHttpServer())
      .patch(`/api/v1/projects/${projectId}/tasks/${memberTaskId}`)
      .set('authorization', `Bearer ${member.token}`)
      .send({ title: 'updated by owner', version: 0 });
    expect(ownUpdate.status).toBe(200);
  });
});
```

- [ ] **Step 5: Write `test/validation.e2e-spec.ts`**

```typescript
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp, registerCompany } from './utils/test-app';

describe('Input validation (spec §11 Test 3)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects empty/invalid register body with 400', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects empty create-project body with 400', async () => {
    const admin = await registerCompany(app);
    const res = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('authorization', `Bearer ${admin.token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects a manually-injected companyId field (whitelist validation)', async () => {
    const admin = await registerCompany(app);
    const res = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('authorization', `Bearer ${admin.token}`)
      .send({ name: 'Valid name', companyId: 'some-other-company-uuid' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 6: Write `test/race-condition.e2e-spec.ts`** (spec §11 optional but recommended)

```typescript
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp, registerCompany } from './utils/test-app';

describe('Optimistic locking race condition (spec §11 bonus)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('one concurrent update wins (200), the other loses (409)', async () => {
    const admin = await registerCompany(app);
    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('authorization', `Bearer ${admin.token}`)
      .send({ name: 'Race Project' });
    const taskRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectRes.body.data.id}/tasks`)
      .set('authorization', `Bearer ${admin.token}`)
      .send({ title: 'Race Task' });
    const taskId = taskRes.body.data.id;
    const path = `/api/v1/projects/${projectRes.body.data.id}/tasks/${taskId}`;

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .patch(path)
        .set('authorization', `Bearer ${admin.token}`)
        .send({ title: 'Update A', version: 0 }),
      request(app.getHttpServer())
        .patch(path)
        .set('authorization', `Bearer ${admin.token}`)
        .send({ title: 'Update B', version: 0 }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
```

- [ ] **Step 7: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: all specs pass. If the race-condition test flakes (both requests occasionally land as
200/409 in a different order than expected, or Postgres serializes them making both effectively
sequential), that's acceptable — the assertion only checks the *set* of outcomes is `{200, 409}`,
not which request wins.

- [ ] **Step 8: Commit**

```bash
git add test/
git commit -m "test: tenant isolation, rbac, validation (e2e)"
```

---

## Task 11: CI (GitHub Actions) + Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `.github/workflows/ci.yml`

**Interfaces:** none (deployment/CI scaffolding, no runtime code dependencies).

- [ ] **Step 1: Write `Dockerfile`** (multistage: build → slim runtime, spec §13)

```dockerfile
# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

# --- runtime stage ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules
dist
.env
*.log
.git
```

- [ ] **Step 3: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: pm_saas
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/pm_saas?schema=public
      REDIS_HOST: localhost
      REDIS_PORT: 6379
      JWT_SECRET: ci-test-secret
      JWT_EXPIRES: 1d
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npx prisma migrate deploy
      - run: npm run lint
      - run: npm run build
      - run: npm run test:e2e
```

- [ ] **Step 4: Verify locally as much as possible**

Docker isn't installed on this machine, so `docker build .` can't be run here — visually review
the Dockerfile/workflow for correctness instead (matching stages/paths used in Tasks 1–10:
`dist/main.js`, `prisma/` folder, env vars from `.env.example`). Note in the README that these
are unverified-by-execution deliverables.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore .github/
git commit -m "ci: github actions lint+test; dockerfile"
```

---

## Task 12: README — multi-tenancy strategy & trade-offs

**Files:**
- Create: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Write `README.md`** covering, per spec §14:

1. **How to run** — prerequisites (Node 20+, local Postgres + Redis, or `docker-compose up -d`),
   `cp .env.example .env` (adjust `DATABASE_URL` for local role), `npm install`,
   `npx prisma migrate deploy`, `npx prisma db seed` (optional), `npm run start:dev`,
   `npm run test:e2e`.
2. **Multi-tenancy strategy + trade-offs** — reproduce the decision table from spec §4.1, explain
   the three enforcement layers from §4.2 (context → extension → explicit assert) and why all
   three exist rather than just one (§8.2 trade-off: implicit-but-safe vs explicit-but-forgettable).
3. **What was skipped** — the exact list from spec §9 (refresh token/logout, pagination/filtering,
   rate limiting/stricter password policy, soft delete, audit before/after diff), plus what you'd
   add first given more time (pagination on list endpoints, then refresh tokens).
4. **Doubtful/flagged decisions** — spec §8.1 (email unique per-company, ambiguous login-by-email
   only) and §8.2 (extension + explicit assert double layer) verbatim reasoning, plus the two
   assumptions this plan flagged in its Global Constraints section (users module placed in the
   RBAC commit; optimistic locking implemented alongside base task CRUD instead of a later
   commit) and the Docker-untested note (no Docker binary on the dev machine used to build this).

- [ ] **Step 2: Proofread against spec §14 checklist** — confirm all 4 numbered items present.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: readme — multi-tenancy strategy & trade-offs"
```

---

## Self-Review Notes (writing-plans skill)

- **Spec coverage:** §2 stack → Task 1. §3 schema → Task 2. §4 tenant layers → Task 4 (context +
  extension), Tasks 5/6 (explicit assert). §5 auth → Task 3. §6 RBAC → Tasks 5/7 (route-level),
  Task 6 (data-level). §7 endpoints/envelope/optimistic lock → Tasks 3 (envelope), 5/6/7
  (endpoints), 6 (optimistic lock). §8 flagged decisions → Task 3 login comment, Task 4 extension
  comment, README Task 12. §9 skipped items → README Task 12. §10 job → Task 8. §11 tests → Task
  10 (all 4, including optional race condition). §12 folder structure → matches throughout
  (`common/tenant`, `common/guards`, `common/decorators`, `common/interceptors`, `common/filters`,
  `prisma/`, `auth/ users/ projects/ tasks/ jobs/`, `test/`). §13 nilai plus → indexes already in
  spec's schema (Task 2), `_count`/`include assignee` (Tasks 5/6), audit trail (Task 9), optimistic
  lock (Task 6), reversible migrations via `prisma migrate dev` (Task 2), Dockerfile/compose
  (Tasks 1/11), CI (Task 11). §14 README → Task 12. §15 commit plan → followed with the two
  flagged adjustments. §16 notes → schema untouched, three layers all present, 404 vs 403
  respected everywhere, assumptions documented in Global Constraints and README.
- **Placeholder scan:** no TBD/TODO; every step has runnable code or an exact command.
- **Type consistency:** `TenantStore { companyId, userId, role }` used identically in
  `tenant-context.ts`, `tenant.middleware.ts`, `assert-owned.ts` call sites, `roles.guard.ts`,
  all services. `JwtPayload { sub, companyId, role }` shared between `auth.service.ts` and
  `tenant.middleware.ts`. `NotificationJobData` shape identical between the `tasks.service.ts`
  producer and `notifications.processor.ts` consumer.

---

## Execution Handoff

Given how tightly coupled these tasks are (every later task depends on the tenant-context +
Prisma extension from Task 4, and on Prisma types from Task 2), **inline sequential execution in
this session** is recommended over dispatching independent subagents per task — there's no
parallelism to exploit here, and cross-task consistency (shared types, shared ALS store shape)
is easier to keep correct with continuous context.
