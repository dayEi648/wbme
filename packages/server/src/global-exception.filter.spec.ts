import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  INestApplication,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsString } from 'class-validator';
import { Test } from '@nestjs/testing';
import { BusinessException, inventoryErrors } from '@wbme/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GlobalExceptionFilter } from './global-exception.filter';
import { AccessLogInterceptor } from './access-log.interceptor';
import { RequestTimeoutInterceptor } from './request-timeout.interceptor';
import { createRequestContextMiddleware } from './request-context';
import { createValidationPipe } from './validation.pipe';

class EchoDto {
  @IsString()
  name!: string;
}

@Controller()
class TestController {
  @Get('ok')
  ok(): string {
    return 'ok';
  }

  @Get('business')
  business(): never {
    throw new BusinessException(inventoryErrors.INSUFFICIENT_STOCK, {
      currentStock: 0,
      // 白名单外键（防泄露）
      sql: 'select * from stock',
    });
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException();
  }

  @Get('unauthorized')
  unauthorized(): never {
    throw new UnauthorizedException();
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException();
  }

  @Get('unknown')
  unknown(): never {
    throw new Error('internal boom');
  }

  @Get('file-too-large')
  fileTooLarge(): never {
    // MulterError 形状（鸭子类型识别；LIMIT_FILE_SIZE 为 multer 稳定错误码）
    const error = new Error('File too large') as Error & { code: string };
    error.code = 'LIMIT_FILE_SIZE';
    throw error;
  }

  @Get('slow')
  async slow(): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return 'too late';
  }

  @Post('echo')
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }
}

describe('统一请求链路（主 PRD §9.6）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [TestController] }).compile();
    app = moduleRef.createNestApplication();
    app.use(createRequestContextMiddleware('test'));
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalInterceptors(new AccessLogInterceptor(), new RequestTimeoutInterceptor(50));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('正常请求返回 200 并携带 X-Request-Id', async () => {
    const res = await request(app.getHttpServer()).get('/ok').expect(200);
    expect(res.text).toBe('ok');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('BusinessException 按目录映射为统一错误结构（422 BUSINESS INSUFFICIENT_STOCK）', async () => {
    const res = await request(app.getHttpServer()).get('/business').expect(422);
    expect(res.body.error).toMatchObject({
      type: 'BUSINESS',
      domain: 'INVENTORY',
      code: 'INSUFFICIENT_STOCK',
      message: '库存不足',
    });
    expect(res.body.error.details).toEqual({ currentStock: 0 });
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('ForbiddenException 映射为 403 AUTHORIZATION', async () => {
    const res = await request(app.getHttpServer()).get('/forbidden').expect(403);
    expect(res.body.error).toMatchObject({ type: 'AUTHORIZATION', code: 'FORBIDDEN' });
  });

  it('UnauthorizedException 映射为 401 AUTHENTICATION', async () => {
    const res = await request(app.getHttpServer()).get('/unauthorized').expect(401);
    expect(res.body.error).toMatchObject({ type: 'AUTHENTICATION', code: 'UNAUTHORIZED' });
  });

  it('ConflictException 映射为 409 CONFLICT', async () => {
    const res = await request(app.getHttpServer()).get('/conflict').expect(409);
    expect(res.body.error).toMatchObject({ type: 'CONFLICT', code: 'CONFLICT' });
  });

  it('未知异常映射为 500 SYSTEM 通用安全文案，不透传内部消息', async () => {
    const res = await request(app.getHttpServer()).get('/unknown').expect(500);
    expect(res.body.error).toMatchObject({
      type: 'SYSTEM',
      code: 'INTERNAL_ERROR',
      message: '系统处理失败，请稍后重试',
    });
    expect(JSON.stringify(res.body)).not.toContain('internal boom');
  });

  it('DTO 白名单拒绝未声明字段并返回字段级 details', async () => {
    const res = await request(app.getHttpServer())
      .post('/echo')
      .send({ name: '张三', hacker: 'evil' })
      .expect(400);
    expect(res.body.error.type).toBe('VALIDATION');
    expect(res.body.error.details.fields).toBeDefined();
    expect(JSON.stringify(res.body)).toContain('hacker');
  });

  it('超过固定总超时返回 503 TIMEOUT', async () => {
    const res = await request(app.getHttpServer()).get('/slow').expect(503);
    expect(res.body.error).toMatchObject({ type: 'TIMEOUT', code: 'REQUEST_TIMEOUT' });
  });

  it('上传文件超限（MulterError LIMIT_FILE_SIZE）映射为 413 IMPORT_FILE_TOO_LARGE', async () => {
    const res = await request(app.getHttpServer()).get('/file-too-large').expect(413);
    expect(res.body.error).toMatchObject({
      type: 'VALIDATION',
      domain: 'FINANCE',
      code: 'IMPORT_FILE_TOO_LARGE',
    });
  });
});
