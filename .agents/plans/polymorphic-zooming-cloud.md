# 阶段2 实现计划:base 认证链路(T2-1 ~ T2-7)

## Context

阶段0(工程基座)与阶段1(81 张表建模)已通过核查并修复,CI 已转绿(d11762d/dec2554)。
本阶段实现 base 逻辑模块认证与账号全链路——平台全访问前提,检查点2 要求"登录/激活/会话/门户端到端可用;安全事件全部落库"。

**用户决策**:
1. 钉钉**直接对接真实 API**(凭证环境变量注入;单测用依赖注入的 `DingtalkGateway` 抽象注入 fake,不改变生产路径)。
2. **不遗留任务**:后端 + 最小可用前端(登录/激活/门户/个人中心页 + 请求层)全部交付。

## 已核实的钉钉官方接口(2026-08,集中收敛在 `DingtalkGatewayImpl` 常量)

- 授权页:`https://login.dingtalk.io/oauth2/auth?redirect_uri&response_type=code&client_id=AppKey&scope=openid%20corpid&prompt=consent&state&corpId`(scope 含 corpid 时 corpId 必传;域名历史有 .com/.io 两种表述,集中常量可配)
- 换 token:`POST https://api.dingtalk.io/v1.0/oauth2/userAccessToken` body `{clientId, clientSecret, code, grantType:"authorization_code"}` → `{accessToken, refreshToken, expireIn, corpId}`
- 用户信息:`GET https://api.dingtalk.io/v1.0/oauth2/userinfo`(Bearer userAccessToken)→ unionId/openId/nick/mobile/stateCode
- 组织成员:`GET https://api.dingtalk.io/v1.0/contact/users/{unionId}`(app 级令牌,`POST /v1.0/oauth2/accessToken {appKey, appSecret}`)→ active/mobile/stateCode
- 组织校验:token 响应的 `corpId === DINGTALK_CORP_ID` 且组织成员接口成功且 active;钉钉超时 → `DEPENDENCY_UNAVAILABLE`,不得误报组织不匹配
- 权限点:应用需 `Contact.User.Read`(企业内部应用可拿完整手机号)
- 内嵌二维码 JS SDK 同源要求 → 本期用链接跳转形态

## 既有资产(复用)

- contracts:ACCOUNT 域 10 错误码、framework 域(401/403/429/503 系)、DTO 基类、`redisKey()`、REDIS_NAMESPACE(SESSION/RATE_LIMIT/CONFIG...)
- @wbme/server:请求上下文(可写 userId)、GlobalExceptionFilter、RedisModule
- 数据库:手机号部分唯一索引、邀请 VALID 唯一、绑定双唯一、资料修改待审批唯一、CHECK(ACTIVE 必有密码)已落地;SecurityEventType 20 事件枚举已定名
- 前端:theme.json 主题就绪;web 骨架可构建
- .env.example 已预留 DINGTALK_APP_KEY/SECRET/CORP_ID

## 设计决策(实现必须遵守)

1. **会话**:Redis 键 `session:{sessionId}`(JSON:u/sv/pv/ov/otv/dv/rm/abs),TTL=min(绝对剩余,空闲超时);`sessionId=randomBytes(16).base64url`;Cookie `wbme_session`(HttpOnly+Secure+SameSite=Lax+Path=/);登录成功即轮换;改密/重置/换绑/注销递增 session_version 全失效;pv/ov/otv/dv 预留 0(T3 比较)。
2. **CSRF**:双提交 Cookie + 自定义头;`wbme_csrf`(非 HttpOnly)= `nonce.HMAC-SHA256(COOKIE_SIGNING_KEY, nonce)`;CsrfGuard 对非 GET/HEAD/OPTIONS 且带会话 Cookie 的请求校验 header===cookie 且签名有效;钉钉回调(GET+state)豁免。
3. **空闲续期**:前端请求层写请求默认带 `X-WBME-Active: 1`;读请求仅页面导航/用户查询带;轮询/预取/静默刷新/后台标签页不带;守卫见头才 EXPIRE。
4. **守卫**:全局 SessionGuard + `@Public()`;校验流程:Redis 会话 → DB 加载(user 存在/未软删/ACTIVE/`sessionVersion===sv`)→ 写 RequestContext.userId;失败删键并 401(SESSION_EXPIRED)或对应业务码;Redis 故障天然 DEPENDENCY。
5. **流程凭证**:激活/重置/换绑凭证=randomBytes(32) 密码学随机,库存 SHA-256,默认 7 天(设置可调);凭证放 URL fragment → body 提交兑换(`POST .../redeem`)→ 发 Path 限定(如 `/api/v1/auth/activation`)的一次性流程 Cookie + `wbme_csrf`;重新生成=条件更新旧 VALID 行 REVOKED;任何日志不记录完整凭证。
6. **流程会话**:Redis `flowtoken:{id}`={purpose,userId?,unionId?,verifiedFlags,expiresAt},TTL 30 分钟,一次性(确认成功/失败即删);钉钉跳转/回调只带 state+purpose。
7. **钉钉 state**:Redis `dtstate:{state}`={purpose,returnTo},TTL 5 分钟,取用即删;回调校验存在/purpose/redirect_uri 与配置一致(防开放重定向);REDIS_NAMESPACE 新增 DINGTALK_STATE/FLOW_TOKEN。
8. **登录保护**:账号锁 `ratelimit:acct_fail/{userId}`+`acct_lock/{userId}`;IP 锁 `ratelimit:ip_fail/{ip}`+`ip_lock/{ip}`;账号计数需先按规范化手机号解析 userId(未注册号不记账号锁);成功登录清 acct_fail 不清 ip_fail;锁定/解锁写安全日志;管理员解锁(M4)幂等删键。
9. **手机号**:规范化存储 `+CC`+纯数字(对接钉钉 stateCode/mobile);唯一仅限待激活+正常;每次钉钉授权返回与账号不一致 → 事务内更新+PHONE_SYNCED(脱敏前后值);被占用 → 跳过+PHONE_SYNC_CONFLICT;脱敏规则 `+CC NNN****NNNN`(保留国家码+前3后4);任何角色无手工修改入口。
10. **密码**:Argon2id(`@node-rs/argon2` 2.x,预编译二进制,国内镜像可用),8~32 字符无组合要求。
11. **安全日志**:写 backstage.security_logs(跨 schema 例外),20 类事件逐条;不落密码/凭证/会话标识/邀请原文;手机号仅脱敏形式;写失败退 stderr 不阻断认证响应;本期实现在 platform-core(T4-4 迁入 @wbme/logging 时仅换写入通道)。
12. **系统设置键名清单**(本阶段敲定,同步回 PRD/表设计):`session.idle.timeout.seconds`(86400)/`session.idle.remember.seconds`(2592000)/`session.abs.timeout.seconds`(604800)/`session.abs.remember.seconds`(7776000)/`login.account.max.attempts`(10)/`login.account.lock.seconds`(600)/`login.ip.window.seconds`(3600)/`login.ip.max.attempts`(120)/`login.ip.lock.seconds`(3600)/`invitation.valid.seconds`(604800);本期仅读取侧(默认值+DB 覆盖+进程内秒级缓存),管理界面 T4-5。
13. **操作日志**:激活/邀请生成/审批处理等 base 写操作记 base.operation_logs(表已存在,基础写入+幂等唯一约束可用),T4-1 完善模板。
14. **权限**:入口推导读 employee_grants(超管豁免全部可见);资料修改审批/解锁接口的 user_manage 授权校验用最小实现(功能授权查询),完整守卫 T3。
15. **新依赖**:platform-core 加 `@node-rs/argon2`;web 加 `react-router-dom`;环境变量补充 DINGTALK_REDIRECT_URI/COOKIE_SIGNING_KEY/COOKIE_SECURE(默认 true,本地 http 设 false)/PUBLIC_ORIGIN。

## API 契约(前缀 /api/v1;错误结构/幂等/分页遵循主 PRD §9.5)

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| POST /auth/login/password | 公开 | 手机号+密码+rememberMe;返回 user+Set-Cookie(会话+csrf) |
| POST /auth/logout | 登录 | 删会话+LOGOUT 安全日志 |
| GET /auth/me | 登录 | 当前身份(手机号脱敏) |
| GET /auth/dingtalk/authorize?purpose= | 公开(流程类需流程 cookie) | 返回钉钉授权 URL(带 state) |
| GET /auth/dingtalk/callback | 公开 GET | 校验 state/组织/绑定 → 302 分流登录/注册/激活/重置/换绑 |
| POST /auth/activation/redeem | 公开 | body token 兑换 → 流程 cookie(Path 限定) |
| POST /auth/activation/confirm | 激活流程 | 姓名/性别/密码 → 事务:绑钉钉+改手机号+写密码+ACTIVE+自动登录 |
| POST /auth/registration/confirm | 注册流程 | 扫码注册完善 |
| POST /auth/password/change | 登录 | 旧密码校验+新密码;session_version++ 全失效 |
| POST /auth/password/reset/confirm | 重置流程 | 设新密码+手机号同步+全失效 |
| POST /auth/rebind/self-initiate | 登录 | 验旧密码→钉钉授权 URL |
| POST /auth/rebind/confirm | 换绑流程 | 原子替换绑定(新 BOUND+旧 UNBOUND)+手机号同步+全失效 |
| POST /users/{id}/activation-invitations | user_manage | 生成激活邀请(仅待激活),返回 URL |
| POST /users/{id}/password-reset-invitations | user_manage | 生成重置邀请(仅 ACTIVE;超管目标仅另一超管或本人钉钉验证) |
| POST /users/{id}/rebind-invitations | 仅超管 | 生成换绑邀请 |
| POST /users/{id}/unlock | user_manage | 解锁(幂等) |
| GET /portal | 登录 | 系统入口(hasPermission+productStatus)+公告(PUBLISHING 唯一)+badgeCount=0 |
| GET /me | 登录 | 身份+部门/岗位(本期空)+canApplyPositionChange |
| PUT /me/profile | 登录 | 超管直改生效;员工创建 PROFILE_CHANGE 审批单(单待审批 409) |
| POST/GET /me/position-applications | 登录 | 契约先行(hr T6-6 闭环;未就绪 DEPENDENCY) |
| GET /me/operation-logs | 登录 | 契约预留(依赖 T4-1,前端"即将开放") |
| POST /approval-requests/{id}/process | user_manage | 资料修改审批最小实现(APPROVE 生效/REJECT;状态+版本条件更新;T5 接管完整规则) |

**新增错误码**(ACCOUNT 域):DINGTALK_STATE_INVALID/DINGTALK_AUTHORIZATION_FAILED/DINGTALK_CONFIG_MISSING/PHONE_MISSING_FROM_DINGTALK/FLOW_SESSION_INVALID/USER_NOT_PENDING/USER_NOT_ACTIVE/ACCOUNT_ACTIVATED/OLD_PASSWORD_INCORRECT/BINDING_NOT_FOUND/PROFILE_CHANGE_PENDING_EXISTS/POSITION_APPLICATION_INELIGIBLE;新增即同步 API 文档与 PRD。

## 实施里程碑(每步独立可验证)

- **M2.1 契约与共享会话**:contracts 新增错误码+`phone.ts`(规范化/脱敏);@wbme/server 新增 SessionService/SessionGuard/@Public/@CurrentUser/CsrfGuard/RateLimitGuard/Redis 命名空间扩展;platform-core 装配 PrismaService、SettingsService、SecurityLogService、登录保护骨架。验证:单测(phone/session/csrf/错误码唯一)。
- **M2.2 密码登录+登录保护**:A1/A2/A3、LoginProtectionService、M4、登录限流、全局守卫挂载。验证:集成测试登录/锁定/解锁/登出/me;安全日志落库。
- **M2.3 钉钉 OAuth**:DingtalkGateway+Impl+fake、state 服务、A4/A5(LOGIN 分支)、手机号同步。验证:fake 网关单测全分支。
- **M2.4 激活/注册/邀请**:A6/A7/A8、M1、token/flow-session、激活事务。验证:激活全链路集成(双通道一次性、部分唯一索引生效)。
- **M2.5 改密/重置/换绑**:A9/A10/A11/A12、M2/M3;session_version 机制。验证:旧会话有效→完成后全失效;原子替换。
- **M2.6 门户+个人中心+资料审批最小实现**:P1/P2/P3/P4/P5/P6、X1。验证:portal/me 单测;审批通过才生效。
- **M2.7 前端**:请求层(http.ts/errors.ts/session.ts)+ 页面(login/activate/register/reset-password/rebind/portal/me)+ 路由守卫 + theme.json 接入。验证:手工端到端;凭证不入存储。
- **M2.8 文档+检查点2**:API 文档 base-auth.md;PRD 同步(设置键名/脱敏规则/规范格式/会话 CSRF 方案);directory.md;.env.example;全量回归;20 类安全事件逐类核对落库。

## 关键文件

- packages/contracts/src/errors/domains/account.ts(新增错误码)、src/phone.ts(新增)、errors/catalog.spec.ts
- packages/server/src/redis/redis-constants.ts(命名空间)、src/session/(新:service/guard/decorators/csrf/cookie/loader)、src/login-protection/rate-limit.guard.ts(新)
- apps/platform-core/src/prisma.service.ts(新)、modules/base/(auth/dingtalk/flows/login-protection/session/security-log/settings/portal/me/approval-proxy)
- apps/platform-core/src/main.ts(全局守卫挂载)
- apps/web/src/(request/、pages/、main.tsx 主题+路由)

## 边界(不重复实现)

- T3:完整权限守卫/授权管理——本阶段仅认证守卫+入口推导最小授权读+user_manage 最小校验
- T4-1:操作日志模板/幂等/导出——本阶段仅 base 基础写入;P6 契约预留
- T4-4:安全日志迁 @wbme/logging——本期在 platform-core 直接实现,事件/脱敏不重复设计
- T4-5:设置管理界面——本期仅读取侧
- T5:审批内核完整规则(版本/并发/超时扫描/多类型)——本期仅 PROFILE_CHANGE 最小处理
- T6-6:岗位申请 hr 侧校验与数据——本期契约先行

## 验证方式

- 单测+集成测试覆盖各里程碑(Vitest;钉钉 fake 注入)
- 真实钉钉:开发环境配内网穿透,`DINGTALK_REDIRECT_URI` 与钉钉后台一致后手动冒烟(登录/激活/重置/换绑)
- `pnpm dev` 全链路 + CI 顺序(install→generate→build:packages→lint→typecheck→test→build)本地全绿
- 检查点2 验收清单:登录/激活/会话/门户端到端 + 安全事件逐类落库核对
