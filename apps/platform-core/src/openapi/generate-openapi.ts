/**
 * OpenAPI 产物生成（主 PRD §9.5/§9.6；构建期生成，不承载运行时 UI）。
 *
 * - 引导 AppModule 生成文档（NestFactory.create + createDocument，不 listen）；
 *   全程离线：Redis 客户端 lazyConnect 从不拨号，数据库客户端仅构造不连接
 *   （PrismaService 惰性），目录对账钩子挂在 onApplicationBootstrap（create 不触发）；
 * - DTO/描述主要来自 @nestjs/swagger 编译器插件（nest build 输出），docstring 即描述；
 * - 统一错误结构 ErrorResponse 注入 components.schemas，type/domain/code 枚举
 *   从 @wbme/contracts 错误目录自动生成（不手抄清单）；
 * - 会话 Cookie + CSRF 头为默认 security；公开路由（@Public）在产物中 security: []。
 *
 * 用法：`pnpm openapi:generate`（nest build 后运行本文件）写入
 * `docs/api-documentations/openapi/platform-core.openapi.json`；
 * `--check` 模式不写入，产物与提交文件不一致时退出码 1（CI 防漂移）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { BUSINESS_DOMAINS, ERROR_CATALOG, ERROR_TYPES } from '@wbme/contracts';
import { createRedisClient } from '@wbme/server';

/** 产物路径（dist/openapi → 仓库根 docs/；src 直跑同深度） */
const OUTPUT_PATH = resolve(__dirname, '../../../../docs/api-documentations/openapi/platform-core.openapi.json');

// 离线引导默认值：模块装饰器求值时即需要（InternalRestModule.forRoot 读取 token；
// InternalAuthGuard 构造校验长度）；生成全程离线，不会被真实连接使用
process.env.DATABASE_URL ??= 'postgresql://openapi:openapi@127.0.0.1:1/openapi-gen';
process.env.COOKIE_SIGNING_KEY ??= 'openapi-generation-offline-key-32+chars';
process.env.INTERNAL_SERVICE_TOKEN ??= 'openapi-generation-internal-token-32+';

/**
 * 公开路由（与控制器 @Public() 标注一一对应；新增公开路由时同步本清单）。
 * 含 /api/v1 全局前缀；健康探针免前缀（main.ts setGlobalPrefix exclude）。
 */
const PUBLIC_PATHS: readonly string[] = [
  '/api/v1/auth/login/password',
  '/api/v1/auth/dingtalk/authorize',
  '/api/v1/auth/dingtalk/callback',
  '/api/v1/auth/activation/redeem',
  '/api/v1/auth/registration/context',
  '/api/v1/auth/registration/confirm',
  '/api/v1/auth/password/reset/initiate',
  '/api/v1/auth/password/reset/redeem',
  '/api/v1/auth/password/reset/confirm',
  '/healthz',
  '/readyz',
];

/** 统一错误结构（主 PRD §9.5）：枚举值从错误目录生成，删码即产物破坏变更 */
function buildErrorResponseSchema(): Record<string, unknown> {
  const codes = [...new Set(Object.values(ERROR_CATALOG).flat().map((entry) => entry.code))].sort();
  return {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['type', 'code', 'message', 'requestId'],
        properties: {
          type: {
            type: 'string',
            enum: [...ERROR_TYPES],
            description: '稳定错误大类（主 PRD §9.5）',
          },
          domain: {
            type: 'string',
            enum: [...BUSINESS_DOMAINS],
            description: '业务域（仅 BUSINESS 类型必须返回）',
          },
          code: {
            type: 'string',
            enum: codes,
            description: '机器可读稳定编码（(type, domain) 内唯一；目录见 @wbme/contracts）',
          },
          message: { type: 'string', description: '服务端控制、可向当前用户展示的文案' },
          details: { type: 'object', additionalProperties: true, description: '白名单结构化详情' },
          requestId: { type: 'string', description: '请求追踪标识' },
        },
      },
    },
  };
}

/** 递归按键名排序对象（数组保持顺序），保证产物确定性 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortKeysDeep(item)]));
  }
  return value;
}

/** 安全模型：默认会话 Cookie + CSRF 头；公开路由清空 security */
function applySecurityModel(document: OpenAPIObject): void {
  const components = (document.components ??= {});
  components.securitySchemes = {
    sessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: 'wbme_session',
      description: '服务端会话 Cookie（HttpOnly；登录/激活成功后下发）',
    },
    csrfHeader: {
      type: 'apiKey',
      in: 'header',
      name: 'X-WBME-CSRF-Token',
      description: 'CSRF 双提交头（状态变更请求必须与 wbme_csrf Cookie 一致）',
    },
  };
  document.security = [{ sessionCookie: [], csrfHeader: [] }];
  const publicSet = new Set(PUBLIC_PATHS);
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!publicSet.has(path)) {
      continue;
    }
    for (const operation of Object.values(pathItem)) {
      (operation as { security?: unknown[] }).security = [];
    }
  }
}

async function generate(): Promise<string> {
  const redis = createRedisClient('redis://127.0.0.1:1');
  // 动态 import：模块装饰器求值（InternalRestModule.forRoot 读取 token 等）须在
  // 顶层 env 默认值设置之后，否则静态 import 在文件顶部先加载、token 为空
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.create(AppModule.register({ redis }), { logger: false });
  try {
    app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'internal/{*path}'] });
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };
    const config = new DocumentBuilder()
      .setTitle('WBME platform-core API')
      .setDescription(
        'platform-core 部署单元（base + backstage）OpenAPI 契约。构建期生成（主 PRD §9.5）：' +
          '统一错误结构见 components.schemas.ErrorResponse；默认会话 Cookie + CSRF 头认证，公开路由无 security。',
      )
      .setVersion(pkg.version)
      .build();
    const document = SwaggerModule.createDocument(app, config);
    const components = (document.components ??= {});
    components.schemas = {
      ...components.schemas,
      ErrorResponse: buildErrorResponseSchema(),
    } as typeof components.schemas;
    applySecurityModel(document);
    return JSON.stringify(sortKeysDeep(document), null, 2) + '\n';
  } finally {
    await app.close();
    await redis.quit();
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const output = await generate();
  if (check) {
    const existing = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (existing !== output) {
      console.error(`[openapi] 产物与提交文件不一致：${OUTPUT_PATH}\n[openapi] 请执行 pnpm --filter @wbme/platform-core openapi:generate 重新生成并提交`);
      process.exit(1);
    }
    console.log('[openapi] 产物与提交文件一致');
    return;
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, output);
  const pathCount = Object.keys((JSON.parse(output) as OpenAPIObject).paths).length;
  console.log(`[openapi] 已生成 ${OUTPUT_PATH}（${pathCount} 个路径）`);
}

void main().catch((error: unknown) => {
  console.error('[openapi] 生成失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
