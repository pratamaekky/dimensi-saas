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
