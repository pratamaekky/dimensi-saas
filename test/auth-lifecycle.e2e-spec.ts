import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp, registerCompany } from './utils/test-app';

describe('Refresh token, logout, and password policy', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('register and login both return an accessToken and a refreshToken', async () => {
    const admin = await registerCompany(app);
    const registerRes = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      companyName: admin.companyName,
      name: admin.name,
      email: `second-${Date.now()}@test.com`,
      password: admin.password,
    });
    expect(registerRes.body.data.accessToken).toEqual(expect.any(String));
    expect(registerRes.body.data.refreshToken).toEqual(expect.any(String));

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });
    expect(loginRes.body.data.accessToken).toEqual(expect.any(String));
    expect(loginRes.body.data.refreshToken).toEqual(expect.any(String));
  });

  it('refresh rotates the token: old refreshToken becomes unusable, new pair works', async () => {
    const admin = await registerCompany(app);
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });
    const oldRefreshToken = loginRes.body.data.refreshToken;

    const refreshRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: oldRefreshToken });
    expect(refreshRes.status).toBe(201);
    expect(refreshRes.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshRes.body.data.refreshToken).not.toBe(oldRefreshToken);

    const reuseOldRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: oldRefreshToken });
    expect(reuseOldRes.status).toBe(401);
  });

  it('rejects an unknown/garbage refresh token with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });

  it('logout revokes the refresh token; a subsequent refresh attempt 401s', async () => {
    const admin = await registerCompany(app);
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });
    const { accessToken, refreshToken } = loginRes.body.data;

    const logoutRes = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('authorization', `Bearer ${accessToken}`);
    expect(logoutRes.status).toBe(201);

    const refreshRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it('logout requires a valid access token (401 without one)', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/logout');
    expect(res.status).toBe(401);
  });

  it('rejects a weak password on register (no uppercase/special char) with 400', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      companyName: 'Weak Password Co',
      name: 'Someone',
      email: `weak-${Date.now()}@test.com`,
      password: 'alllowercase',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a weak password on POST /users too', async () => {
    const admin = await registerCompany(app);
    const res = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('authorization', `Bearer ${admin.token}`)
      .send({ name: 'Weak Member', email: `weakmember-${Date.now()}@test.com`, password: 'nouppercase1!' });
    expect(res.status).toBe(400);
  });

  it('accepts a password meeting the policy', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      companyName: 'Strong Password Co',
      name: 'Someone',
      email: `strong-${Date.now()}@test.com`,
      password: 'Str0ng!Pass',
    });
    expect(res.status).toBe(201);
  });
});
