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
