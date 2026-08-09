import 'reflect-metadata';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InternalRestModule } from '@wbme/server';
import { InternalBackupController } from './internal-backup.controller';
import { BackupService } from './backup.service';

const TOKEN = 'test-internal-token-0123456789abcdef';

describe('InternalBackupController HTTP 集成（主 PRD §9.4 / backstage PRD §10）', () => {
  let app: INestApplication;
  let backupService: BackupService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [InternalRestModule.forRoot({ token: TOKEN })],
      controllers: [InternalBackupController],
      providers: [
        {
          provide: BackupService,
          useValue: {
            triggerImmediateBackupInternal: vi.fn(),
            findBackupById: vi.fn(),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    backupService = moduleRef.get(BackupService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /internal/v1/backups/immediate：migration-runner 可触发立即备份', async () => {
    vi.mocked(backupService.triggerImmediateBackupInternal).mockResolvedValue({
      backupId: 7,
      taskUuid: '11111111-2222-3333-4444-555555555555',
    });
    const res = await request(app.getHttpServer())
      .post('/internal/v1/backups/immediate')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-WBME-Caller', 'migration-runner')
      .send({ idempotencyKey: 'pre-migration:test' })
      .expect(201);
    expect(res.body).toEqual({
      backupId: 7,
      taskUuid: '11111111-2222-3333-4444-555555555555',
    });
    expect(backupService.triggerImmediateBackupInternal).toHaveBeenCalledWith('migration-runner', {
      idempotencyKey: 'pre-migration:test',
    });
  });

  it('GET /internal/v1/backups/immediate/status/:backupId：migration-runner 可轮询状态', async () => {
    vi.mocked(backupService.findBackupById).mockResolvedValue({ status: 'SUCCEEDED' });
    const res = await request(app.getHttpServer())
      .get('/internal/v1/backups/immediate/status/7')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-WBME-Caller', 'migration-runner')
      .expect(200);
    expect(res.body).toEqual({ status: 'SUCCEEDED' });
  });

  it('缺少令牌返回 401', async () => {
    await request(app.getHttpServer()).post('/internal/v1/backups/immediate').send({}).expect(401);
  });

  it('调用方不在白名单返回 403', async () => {
    await request(app.getHttpServer())
      .post('/internal/v1/backups/immediate')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-WBME-Caller', 'worker')
      .send({})
      .expect(403);
  });
});
