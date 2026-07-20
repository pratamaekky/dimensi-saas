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
    password: overrides.password ?? 'Password123!',
  };
  const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(body);
  return { token: res.body.data.accessToken as string, ...body };
}

export async function createMember(app: INestApplication, adminToken: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `member-${suffix}@test.com`;
  const password = 'Password123!';
  await request(app.getHttpServer())
    .post('/api/v1/users')
    .set('authorization', `Bearer ${adminToken}`)
    .send({ name: 'Member', email, password });
  const loginRes = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password });
  return { token: loginRes.body.data.accessToken as string, email, password };
}
