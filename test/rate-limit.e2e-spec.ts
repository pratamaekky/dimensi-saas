import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp, registerCompany } from './utils/test-app';

// Own spec file = own Nest app instance = own in-memory ThrottlerStorage, so firing
// enough requests here to trip the limit can't bleed into other spec files' counters.
describe('Rate limiting on auth endpoints (stricter than the global default)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks the 11th /auth/login attempt within the window with 429', async () => {
    const admin = await registerCompany(app);

    for (let i = 0; i < 10; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: admin.password });
      expect(res.status).toBe(201);
    }

    const eleventh = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual({
      success: false,
      error: { code: 'RATE_LIMITED', message: expect.any(String) },
    });
  });

  it("doesn't rate-limit a normal handful of business-endpoint requests", async () => {
    const admin = await registerCompany(app);
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .get('/api/v1/projects')
        .set('authorization', `Bearer ${admin.token}`);
      expect(res.status).toBe(200);
    }
  });
});
