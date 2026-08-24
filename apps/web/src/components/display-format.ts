import { formatEnumLabel, type EnumKind } from './enum-display';

/** 北京时间展示格式，保持接口中的 UTC 时间语义不变。 */
const BEIJING_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 常见接口字段的中文展示名；页面可通过 labelMap 覆盖业务专有字段。 */
export const DEFAULT_FIELD_LABELS: Readonly<Record<string, string>> = {
  id: '编号',
  phoneMasked: '手机号',
  isSuperAdmin: '超级管理员',
  permissionVersion: '授权版本',
  createdAt: '创建时间',
  updatedAt: '更新时间',
  deletedAt: '删除时间',
  submittedAt: '提交时间',
  publishedAt: '发布时间',
  completedAt: '完成时间',
  initiatedAt: '发起时间',
  processedAt: '处理时间',
  startedAt: '开始时间',
  endedAt: '结束时间',
  lastSeenAt: '最近发生时间',
  firstSeenAt: '首次发生时间',
  lastFailureAt: '最近失败时间',
  handledAt: '处理时间',
  bucketStart: '聚合时段起始',
  status: '状态',
  name: '名称',
  title: '标题',
  description: '说明',
  message: '消息',
  error: '错误',
  level: '日志级别',
  service: '服务名称',
  source: '来源模块',
  errorCategory: '错误分类',
  deployCommit: '部署版本',
  fingerprint: '异常指纹',
  occurrenceCount: '发生次数',
  handledBy: '处理人 ID',
  firstRequestId: '首次请求 ID',
  lastRequestId: '最近请求 ID',
  sample: '错误样本（已脱敏）',
  remark: '备注',
  data: '数据',
  pagination: '分页信息',
  services: '服务状态',
  dependencies: '依赖状态',
  tasks: '后台任务',
  overview: '概览',
  ready: '就绪状态',
  backupTime: '备份时间',
  fileSize: '文件大小（字节）',
  checksum: '校验和',
  pgVersion: 'PostgreSQL 版本',
  redisConnected: 'Redis 连接状态',
  databaseConnected: '数据库连接状态',
  usageRatio: '使用率',
  failed24h: '近 24 小时失败数',
  total: '总数',
  page: '页码',
  pageSize: '每页条数',
  totalItems: '总条数',
  totalPages: '总页数',
};

const MONEY_FIELD_PATTERN = /(amount|price|cost|fee|settlement|received|invoiced|paid|equity|revenue|profit|budget)/i;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** 判断字段是否为应以千分位展示的金额。 */
export function isMoneyField(key: string): boolean {
  return MONEY_FIELD_PATTERN.test(key);
}

/** 判断值是否为带时刻的 ISO 时间字段，而不是业务日历日期。 */
export function isDateTimeField(key: string, value: unknown): boolean {
  return (key.endsWith('At') || key.endsWith('Time') || key.endsWith('Timestamp'))
    && (value instanceof Date || (typeof value === 'string' && ISO_DATE_TIME_PATTERN.test(value)));
}

/** 将 ISO UTC 时间转换为 YYYY-MM-DD HH:mm（北京时间）。 */
export function formatBeijingDateTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const parts = Object.fromEntries(
    BEIJING_DATE_TIME_FORMATTER
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 十进制字符串金额的千分位格式化；不转为 Number，避免精度丢失。 */
export function formatMoney(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    return text;
  }
  const [, sign, integer, fraction] = match;
  const grouped = (integer ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** 将详情字段名转换为中文；未知字段原样显示，避免猜测业务含义。 */
export function displayLabel(key: string, labelMap?: Readonly<Record<string, string>>): string {
  return labelMap?.[key] ?? DEFAULT_FIELD_LABELS[key] ?? key;
}

/** 递归转换嵌套详情，避免 JSON 块继续泄露内部驼峰字段名。 */
export function formatDetailValue(value: unknown, labelMap?: Readonly<Record<string, string>>): unknown {
  if (value instanceof Date) {
    return formatBeijingDateTime(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatDetailValue(item, labelMap));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (isDateTimeField(key, item)) {
        return [displayLabel(key, labelMap), formatBeijingDateTime(item as string | Date)];
      }
      if (isMoneyField(key)) {
        return [displayLabel(key, labelMap), formatMoney(item)];
      }
      return [displayLabel(key, labelMap), formatDetailValue(item, labelMap)];
    }));
  }
  return value;
}

/** 通用表格/详情值展示。 */
export function formatDisplayValue(value: unknown, key?: string, enumKind?: EnumKind): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  if (enumKind) {
    return formatEnumLabel(enumKind, value);
  }
  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }
  if (key && isDateTimeField(key, value)) {
    return formatBeijingDateTime(value as string | Date);
  }
  if (key && isMoneyField(key)) {
    return formatMoney(value);
  }
  if (typeof value === 'object') {
    return JSON.stringify(formatDetailValue(value), null, 2);
  }
  return String(value);
}
