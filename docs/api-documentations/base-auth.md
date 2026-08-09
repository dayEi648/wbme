# base 认证链路 API 文档（阶段2）

> 统一前缀 `/api/v1`；错误结构、幂等键、分页遵循主 PRD §9.5。
> 本文档随接口提交同步维护；文档与实现不一致视为任务未完成（实现规划通用任务约定）。

## 认证与会话（auth）

### A1 密码登录 `POST /auth/login/password`
公开。手机号 + 密码 + 可选记住我。
- 入参：`{ phone, password, rememberMe?, idempotencyKey? }`（phone 登录前统一规范化为 `+CC` + 号码）
- 成功：`{ user: { id, name, gender, phoneMasked, status, isSuperAdmin }, sessionExpiresAt }` + `Set-Cookie: wbme_session`（HttpOnly+Secure+SameSite=Lax）+ `wbme_csrf`
- 失败：`INVALID_CREDENTIALS`(401 统一提示，不泄露账号是否存在) / `ACCOUNT_LOCKED`(401，登录保护锁定，统一"尝试过多"提示) / `ACCOUNT_DEACTIVATED`(422 "账号已注销，请联系管理员恢复") / `ACCOUNT_PENDING_ACTIVATION`(422 "账号尚未激活") / `RATE_LIMITED`(429)
- 状态例外（base PRD §2）：已注销与待激活为明确提示的例外；两种状态的前置拒绝计入 IP 锁失败计数、不记账号锁（防撞库探测锁定真实员工）
- 登录保护：账号锁（连续失败达系统设置阈值，默认 10 次/10 分钟）+ IP 锁（窗口内累计失败达阈值，默认 60 分钟/120 次/1 小时）；锁定/解锁写安全日志
- 安全事件：LOGIN_SUCCESS / LOGIN_FAILURE / ACCOUNT_LOCK / IP_LOCK

### A2 登出 `POST /auth/logout`
登录态。删除当前会话 + LOGOUT 安全日志 + 清 Cookie。无入参。

### A3 当前身份 `GET /auth/me`
登录态。`{ user: { id, name, gender, phoneMasked, status, isSuperAdmin }, hasDingtalkBinding }`。

## 钉钉 OAuth（auth/dingtalk）

### A4 授权发起 `GET /auth/dingtalk/authorize?purpose=`
公开（ACTIVATION/RESET 需对应一次性流程 Cookie）。
- purpose：`LOGIN` / `REGISTRATION` / `ACTIVATION` / `RESET`
- 成功：`{ authorizeUrl }`（服务端签名 URL，含一次性 state，TTL 5 分钟；流程类用途的流程标识随 state 携带，钉钉跳转与回调只带 state/nonce 与流程标识，base PRD §2）
- 失败：`DINGTALK_CONFIG_MISSING`(503 未配置) / `FLOW_SESSION_INVALID`(422) / `RATE_LIMITED`(429)
- 限流（base PRD §4 三维）：IP 30 次/分 + 会话（流程 Cookie）10 次/分；回调另按一次性 state 5 次/分计数

### A5 钉钉回调 `GET /auth/dingtalk/callback?code=&state=`
公开 GET（CSRF 由一次性 state 承担）。校验 state（取用即删）→ 授权码换 token → 组织校验（corpId 与部署配置一致 + 组织成员 active）→ 按 purpose 分流。
- 成功：302 到前端（LOGIN 已绑定 → /portal 并下发会话 Cookie；未绑定 → /register；ACTIVATION/RESET → 对应完成页，流程标识由一次性 state 取出，回调路径无需携带流程 Cookie）
- 失败：302 到 `/login?error={code}`（`DINGTALK_ORG_MISMATCH`（含钉钉明确返回"非本组织成员"） / `DINGTALK_STATE_INVALID` / `DINGTALK_ALREADY_BOUND` / `DEPENDENCY_UNAVAILABLE` 等）
- 钉钉超时/5xx/网络错误按依赖不可用处理，不得误报组织不匹配、不得跳过校验；仅钉钉明确拒绝（成员查询 401/403/404 或未返回成员）才提示组织不匹配

## 激活与注册（auth/activation、auth/registration）

### A6 激活凭证兑换 `POST /auth/activation/redeem`
公开 + 限流。入参 `{ token }`（URL fragment 凭证，仅此一次出现在请求体）。
- 成功：`{ user: { id, name, phoneMasked } }` + `Set-Cookie: wbme_flow`（Path=/api/v1/auth，覆盖钉钉授权/回调与激活流程，TTL 30 分钟）+ `wbme_csrf`
- 失败：`INVITATION_INVALID`(422 无效/过期/已使用) / `ACCOUNT_ACTIVATED`(422 已激活) / `RATE_LIMITED`(429)

### A7 激活确认 `POST /auth/activation/confirm`
激活流程 Cookie。入参 `{ name, gender, password, confirmPassword, idempotencyKey? }`（confirmPassword 必填且必须与 password 一致，后端强制）。
- 单事务：绑钉钉（unionId 未绑定）+ 手机号改为钉钉返回（占用则拒绝）+ 写密码（Argon2id）+ ACTIVE + 邀请标记 USED
- 成功：自动登录，同 A1 响应（会话 Cookie + CSRF Cookie）
- 失败：`PASSWORD_CONFIRM_MISMATCH`(422 两次输入不一致) / `PASSWORD_POLICY_FAILED`(422 策略不符) / `FLOW_SESSION_INVALID` / `PHONE_TAKEN` / `DINGTALK_ALREADY_BOUND` / `PHONE_MISSING_FROM_DINGTALK` / `RATE_LIMITED`
- 安全事件：ACCOUNT_ACTIVATED / PHONE_SYNCED（脱敏前后值）

### A8 注册确认 `POST /auth/registration/confirm`
注册流程 Cookie。入参同 A7（confirmPassword 必填且必须与 password 一致）。
- 单事务：创建账号（普通员工，ACTIVE）+ 绑钉钉 + 手机号 = 钉钉返回
- 失败：`PASSWORD_CONFIRM_MISMATCH`(422) / `PASSWORD_POLICY_FAILED`(422) / `PENDING_ACCOUNT_EXISTS`(422 待激活基础账号占用) / `PHONE_TAKEN` / `DINGTALK_ALREADY_BOUND` / `FLOW_SESSION_INVALID`

### 注册上下文 `GET /auth/registration/context`
注册流程 Cookie。`{ phone }`（钉钉授权返回的手机号，只读展示用）。

## 密码（auth/password）

### A9 修改密码 `POST /auth/password/change`
登录态。入参 `{ currentPassword, newPassword, confirmPassword, idempotencyKey? }`（confirmPassword 必填且必须与 newPassword 一致）。
- 成功：`{ ok: true }`；session_version 递增 → 全部会话立即失效（重新登录）
- 失败：`OLD_PASSWORD_INCORRECT`(401) / `PASSWORD_CONFIRM_MISMATCH`(422 两次输入不一致) / `PASSWORD_POLICY_FAILED`(422 策略不符)
- 安全事件：PASSWORD_CHANGED（成功/失败）

### A10' 自助重置发起 `POST /auth/password/reset/initiate`
公开 + 限流。入参 `{ phone, idempotencyKey? }`（已绑定钉钉账号凭手机号自助发起；base PRD §2"已绑定钉钉的用户可重新扫码完成钉钉验证后重置密码"）。
- 成功：`{ authorizeUrl }`（同源相对路径 `/api/v1/auth/dingtalk/authorize?purpose=RESET`）+ `wbme_flow`（Path=/api/v1/auth）+ `wbme_csrf`；回调后走 A10 完成
- 失败：`RESET_SELF_UNAVAILABLE`(422 账号不存在或未绑定钉钉，统一提示不泄露手机号是否注册) / `RATE_LIMITED`(429)
- 安全事件：PASSWORD_RESET_ISSUED（reason=自助发起）

### 重置凭证兑换 `POST /auth/password/reset/redeem`
公开 + 限流。入参 `{ token }`（M2 生成的 fragment 凭证）。
- 成功：`{ user: { id, name } }` + `wbme_flow`（Path=/api/v1/auth）+ `wbme_csrf`
- 失败：`INVITATION_INVALID` / `USER_NOT_ACTIVE`(422)

### A10 重置确认 `POST /auth/password/reset/confirm`
重置流程 Cookie。入参 `{ newPassword, confirmPassword, idempotencyKey? }`（confirmPassword 必填且必须与 newPassword 一致）。
- 校验：钉钉 unionId 与账号现有绑定一致（不一致 → `DINGTALK_ORG_MISMATCH`）；管理员凭证路径消费邀请（无效/过期/已使用 → `INVITATION_INVALID`），自助路径（A10' 发起）不消费邀请
- 成功：新密码 + session_version 递增（全会话失效）+ 手机号按钉钉返回同步（占用则跳过）
- 失败：`PASSWORD_CONFIRM_MISMATCH`(422) / `PASSWORD_POLICY_FAILED`(422) / `INVITATION_INVALID` / `FLOW_SESSION_INVALID` / `DINGTALK_ORG_MISMATCH` / `USER_NOT_ACTIVE`
- 安全事件：PASSWORD_RESET_COMPLETED / PHONE_SYNCED / PHONE_SYNC_CONFLICT（凭证路径另记 INVITATION_USED）

## 管理操作（users，权限"用户管理"最小校验：超管或 user_manage 授权）

### M1 生成激活邀请 `POST /users/{id}/activation-invitations`
入参 `IdempotentDto`。仅待激活账号；重新生成旧邀请立即失效。
- 成功：`{ activationUrl, activationQr }`——`activationUrl`（`PUBLIC_ORIGIN/activate#<token>`，凭证放 fragment，库中只存 SHA-256）+ `activationQr`（同链接的 QR 编码 PNG data URL，base PRD §2 二维码与链接两种交付方式，指向同一凭证：任一使用后另一同步失效）；二维码含凭证原文，仅返回持有"用户管理"权限者，不写任何日志
- 失败：`USER_NOT_PENDING`(422) / `RESOURCE_NOT_FOUND`(404) / `FORBIDDEN`(403)
- 安全事件：INVITATION_ISSUED；操作日志（CREATE）

### M2 生成重置邀请 `POST /users/{id}/password-reset-invitations`
入参 `IdempotentDto`。仅 ACTIVE；超管目标仅另一超管或本人钉钉验证（backstage PRD §3）。
- 成功：`{ resetUrl }`；失败：`USER_NOT_ACTIVE` / `FORBIDDEN`

### M4 解锁账号 `POST /users/{id}/unlock`
入参 `IdempotentDto`。幂等（未锁定也成功）。清除账号锁计数与账号锁，并解除该账号触发过的 IP 锁（存在时），立即恢复可登录（base PRD §4）。
- 安全事件：ACCOUNT_UNLOCK；顺带解除 IP 锁时另记 IP_UNLOCK（backstage PRD §8 事件清单）

## 门户与个人中心

### P1 门户 `GET /portal`
登录态。`{ brand, user: { id, name, phoneMasked }, systems: [{ code, name, productStatus, hasPermission, entryUrl }], announcement: { title, content, publishedAt } | null, badgeCount: 0 }`。
- 入口可见：拥有该系统至少一项功能授权（超管全可见）；"即将上线"展示状态但不可进入
- 公告：仅当前唯一"正在展示"（PUBLISHING）的公告，无则 null；待办角标本期恒 0（T5/6/7 联调后接入）

### P2 个人中心 `GET /me`
登录态。`{ user, departments: [], positions: [], canApplyPositionChange: false, pendingProfileChange }`（部门/岗位 T6 填充）。

### P3 资料修改 `PUT /me/profile`
登录态。入参 `{ name?, gender?, idempotencyKey? }`（至少一项）。
- 超管：直接生效 `{ applied: true }`；员工：创建 PROFILE_CHANGE 审批单 `{ applied: false, requestId }`
- 失败：`PROFILE_CHANGE_PENDING_EXISTS`(409 单待审批限制，条件唯一索引兜底) / `VALIDATION_FAILED`

### P4 岗位变更申请 `POST /me/position-applications`
契约先行：hr 侧校验（单部门限制/岗位启用+自助+适用部门）T6-6 落地；本期返回 `POSITION_APPLICATION_INELIGIBLE`(422)。

### P5 我的岗位申请记录 `GET /me/position-applications`
分页契约就位，本期空分页（T6-6 接通）。

### P6 我的操作日志 `GET /me/operation-logs`
登录态。仅返回当前用户的操作日志（`operator_id = 当前用户`），分页；走操作日志联合视图查询（主 PRD §3.3）。

## 资料修改审批处理

### X1 审批处理 `POST /approval-requests/{id}/process`
权限"用户管理"。入参 `{ action: APPROVE | REJECT, opinion?, idempotencyKey? }`。
- APPROVE：状态+版本条件更新，同一事务生效姓名/性别修改；REJECT：不改正式资料
- 失败：`FORBIDDEN` / `RESOURCE_NOT_FOUND`(404) / `CONFLICT`(409 非 PENDING 或并发处理)
- 边界：本期仅 PROFILE_CHANGE 类型最小实现；完整审批内核 T5-1/T5-3 接管

## 会话与安全契约（实现约定）

- 会话：Redis 服务端会话 `session:{sessionId}`；Cookie `wbme_session`（HttpOnly + Secure + SameSite=Lax + Path=/）；登录成功即轮换标识（防会话固定）
- 双时限：空闲超时（滑动续期，仅"有效交互" X-WBME-Active 头续期）+ 绝对过期；记住我仅延长时限，且会话 Cookie 随绝对过期时限持久化（maxAge；未勾选为浏览器会话级，base PRD §3）
- 失效机制：改密/重置/注销 → session_version 递增，旧会话下次请求立即失效
- CSRF：双提交 Cookie `wbme_csrf` + 请求头 `X-WBME-CSRF-Token`（状态变更且携带会话 Cookie 时校验）
- 流程凭证：激活/重置凭证 = 32B 密码学随机值，库中只存 SHA-256，默认 7 天（系统设置可调）；URL fragment 承载，兑换后立即清除
- 手机号：平台标准格式 `+CC` + 纯数字；脱敏展示保留国家码与前 3 后 4（如 `+86 138****8000`）；唯一性仅"待激活+正常"间强制
- 安全日志：16 类事件逐条写 backstage.security_logs；不落密码/凭证/会话标识/邀请原文；手机号仅脱敏形式；写失败退 stderr 不阻断认证
- 系统设置键名：见 base PRD §7 同步清单（会话时限/登录保护/邀请有效期）
