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

  it("excludes other companies' projects from the list endpoint", async () => {
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
    expect(list.body.data.some((p: { name: string }) => p.name === 'Globex Only Project')).toBe(
      false,
    );
  });
});
