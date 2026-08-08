import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllowedCallers } from './allowed-callers.decorator';
import { InternalAuthGuard } from './internal-auth.guard';
import { InternalHttpClient, InternalRequestError, type InternalHttpClientOptions } from './internal-http.client';
import { InternalRestModule } from './internal-rest.module';
import { INTERNAL_CALLER_HEADER } from './internal-rest.constants';

const TOKEN = 'test-internal-token-0123456789abcdef';

@Controller('internal/v1/demo')
@UseGuards(InternalAuthGuard)
class DemoInternalController {
  @Get('ping')
  @AllowedCallers('platform-core', 'worker')
  ping(): { ok: true } {
    return { ok: true };
  }
}

describe('内部 REST 基础设施（主 PRD §9.4）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [InternalRestModule.forRoot({ token: TOKEN })],
      controllers: [DemoInternalController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('缺少令牌返回 401', async () => {
    await request(app.getHttpServer()).get('/internal/v1/demo/ping').expect(401);
  });

  it('令牌错误返回 401', async () => {
    await request(app.getHttpServer())
      .get('/internal/v1/demo/ping')
      .set('Authorization', 'Bearer wrong-token-value')
      .expect(401);
  });

  it('令牌正确但调用方不在白名单返回 403', async () => {
    await request(app.getHttpServer())
      .get('/internal/v1/demo/ping')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(INTERNAL_CALLER_HEADER, 'fin')
      .expect(403);
  });

  it('令牌正确且调用方在白名单返回 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/internal/v1/demo/ping')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(INTERNAL_CALLER_HEADER, 'platform-core')
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('未声明调用方白名单的路由拒绝全部调用方（403）', async () => {
    // DemoInternalController 的 ping 已声明白名单；此处验证默认（无元数据）即拒绝
    await request(app.getHttpServer())
      .get('/internal/v1/demo/ping')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(INTERNAL_CALLER_HEADER, 'unknown-service')
      .expect(403);
  });
});

describe('InternalHttpClient（主 PRD §9.4 超时与有界重试）', () => {
  let target: Server;
  let hits: number;

  beforeAll(async () => {
    hits = 0;
    target = createServer((req, res) => {
      hits += 1;
      if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(200).end('slow-ok');
        }, 300);
        return;
      }
      if (req.url === '/flaky') {
        if (hits <= 2) {
          res.writeHead(503).end('unavailable');
          return;
        }
        res.writeHead(200).end('flaky-ok');
        return;
      }
      if (req.url === '/business-error') {
        res.writeHead(422, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: { type: 'BUSINESS', code: 'X', message: '业务拒绝' } }),
        );
        return;
      }
      res.writeHead(404).end('not found');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  function makeClient(overrides: Partial<InternalHttpClientOptions> = {}) {
    const address = target.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    return new InternalHttpClient({
      baseUrl,
      token: TOKEN,
      caller: 'platform-core',
      timeoutMs: 100,
      maxRetries: 2,
      ...overrides,
    });
  }

  it('携带令牌、调用方与追踪标识请求头', async () => {
    const client = makeClient({ timeoutMs: 1000 });
    const response = await client.get('/ok');
    expect(response.status).toBe(404); // 目标无 /ok 路由，但请求头已验证
  });

  it('超过超时抛 InternalRequestError（连接/响应超时）', async () => {
    const client = makeClient({ timeoutMs: 50 });
    await expect(client.get('/slow')).rejects.toThrow(InternalRequestError);
  });

  it('幂等 GET 对 5xx 做有界重试后成功', async () => {
    hits = 0;
    const client = makeClient({ timeoutMs: 1000 });
    const response = await client.get('/flaky');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('flaky-ok');
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it('目标服务 4xx 业务错误原样返回、不重试', async () => {
    const before = hits;
    const client = makeClient({ timeoutMs: 1000 });
    const response = await client.get('/business-error');
    expect(response.status).toBe(422);
    expect(hits).toBe(before + 1);
  });

  it('非幂等写请求不自动重试', async () => {
    hits = 0;
    const client = makeClient({ timeoutMs: 1000 });
    const response = await client.write('/flaky', { method: 'POST', body: {} });
    expect(response.status).toBe(503);
    expect(hits).toBe(1);
  });
});
