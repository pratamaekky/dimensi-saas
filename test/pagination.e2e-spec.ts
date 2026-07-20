import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp, registerCompany } from './utils/test-app';

describe('Pagination on list endpoints', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('paginates GET /projects with correct meta', async () => {
    const admin = await registerCompany(app);
    for (const name of ['Project A', 'Project B', 'Project C']) {
      await request(app.getHttpServer())
        .post('/api/v1/projects')
        .set('authorization', `Bearer ${admin.token}`)
        .send({ name });
    }

    const page1 = await request(app.getHttpServer())
      .get('/api/v1/projects?page=1&limit=2')
      .set('authorization', `Bearer ${admin.token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });

    const page2 = await request(app.getHttpServer())
      .get('/api/v1/projects?page=2&limit=2')
      .set('authorization', `Bearer ${admin.token}`);
    expect(page2.body.data.items).toHaveLength(1);
  });

  it('defaults to page=1, limit=20 when no query params given', async () => {
    const admin = await registerCompany(app);
    const res = await request(app.getHttpServer())
      .get('/api/v1/projects')
      .set('authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.meta.page).toBe(1);
    expect(res.body.data.meta.limit).toBe(20);
  });

  it('rejects an out-of-range limit with 400', async () => {
    const admin = await registerCompany(app);
    const res = await request(app.getHttpServer())
      .get('/api/v1/projects?limit=1000')
      .set('authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(400);
  });

  it('paginates GET /projects/:projectId/tasks with correct meta', async () => {
    const admin = await registerCompany(app);
    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('authorization', `Bearer ${admin.token}`)
      .send({ name: 'Task Pagination Project' });
    const projectId = projectRes.body.data.id;

    for (const title of ['Task A', 'Task B', 'Task C']) {
      await request(app.getHttpServer())
        .post(`/api/v1/projects/${projectId}/tasks`)
        .set('authorization', `Bearer ${admin.token}`)
        .send({ title });
    }

    const res = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/tasks?page=1&limit=2`)
      .set('authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });
  });
});
