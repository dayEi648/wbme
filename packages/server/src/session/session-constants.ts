/**
 * 会话与认证 Cookie 契约（主 PRD §9.7/§9.8、base PRD §3）。
 *
 * - 会话 Cookie：`HttpOnly + Secure(按部署配置) + SameSite=Lax + Path=/`；
 *   SameSite=Lax 允许钉钉 top-level 授权回跳仍携带 Cookie，同时挡住跨站 POST。
 * - CSRF Cookie：双提交 Cookie + 自定义头（X-WBME-CSRF-Token），非 HttpOnly 供前端读取。
 * - 流程 Cookie：激活/注册/重置/换绑的一次性流程会话，Path 仅覆盖对应流程路由。
 */

/** 服务端会话 Cookie 名 */
export const SESSION_COOKIE = 'wbme_session';

/** CSRF 双提交 Cookie 名（非 HttpOnly，前端请求层读取后放入自定义头） */
export const CSRF_COOKIE = 'wbme_csrf';

/** 一次性流程会话 Cookie 名 */
export const FLOW_COOKIE = 'wbme_flow';

/** CSRF 自定义请求头（前端双提交回传） */
export const CSRF_HEADER = 'x-wbme-csrf-token';

/** 有效交互标记头：写请求默认携带，读请求仅页面导航/用户查询携带；轮询/预取不携带（base PRD §3） */
export const ACTIVE_INTERACTION_HEADER = 'x-wbme-active';

/** 会话 Cookie 最短安全长度（字节） */
export const SESSION_ID_BYTES = 16;

/** 流程 Cookie 值（flowSessionId）长度（字节） */
export const FLOW_SESSION_ID_BYTES = 16;
