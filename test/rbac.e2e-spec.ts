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

  it("member gets 403 deleting a project, 403 editing others' tasks, 200 editing own task", async () => {
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
