import type { ErrorEntry } from '../types';

/** FINANCE 域错误目录：工程合同、利润分析、Excel 导入导出（fin PRD） */
export const financeErrors = {
  /** 项目业务键（规范化项目名称 + 年度）冲突（fin PRD §3） */
  PROJECT_KEY_CONFLICT: {
    code: 'PROJECT_KEY_CONFLICT',
    type: 'CONFLICT',
    domain: 'FINANCE',
    httpStatus: 409,
    message: '同名项目已存在（含已删除项目），请改名或恢复原项目',
  },
  /** 项目 dataRevision 前置条件失败（fin PRD §4） */
  DATA_REVISION_STALE: {
    code: 'DATA_REVISION_STALE',
    type: 'CONFLICT',
    domain: 'FINANCE',
    httpStatus: 409,
    message: '数据已被其他操作更新，请重新加载',
  },
  /** 导入文件超过 20 MiB 固定上限（fin PRD §4：413） */
  IMPORT_FILE_TOO_LARGE: {
    code: 'IMPORT_FILE_TOO_LARGE',
    type: 'VALIDATION',
    domain: 'FINANCE',
    httpStatus: 413,
    message: '上传文件超过 20 MiB 大小上限',
  },
  /** 项目数据行超过 10,000 行上限（fin PRD §4） */
  IMPORT_ROW_LIMIT_EXCEEDED: {
    code: 'IMPORT_ROW_LIMIT_EXCEEDED',
    type: 'VALIDATION',
    domain: 'FINANCE',
    httpStatus: 400,
    message: '项目数据行超过 10,000 行上限',
  },
  /** ZIP 解压体积/条目数超过固定安全上限（fin PRD §4） */
  IMPORT_ARCHIVE_LIMIT_EXCEEDED: {
    code: 'IMPORT_ARCHIVE_LIMIT_EXCEEDED',
    type: 'VALIDATION',
    domain: 'FINANCE',
    httpStatus: 400,
    message: '文件压缩内容超过安全上限',
  },
  /** 可导入手工字段出现公式（fin PRD §4） */
  IMPORT_FORMULA_NOT_ALLOWED: {
    code: 'IMPORT_FORMULA_NOT_ALLOWED',
    type: 'VALIDATION',
    domain: 'FINANCE',
    httpStatus: 400,
    message: '手工字段不允许包含公式',
  },
  /** 空年度行无法定位新增项目（fin PRD §4） */
  IMPORT_YEAR_REQUIRED_FOR_NEW: {
    code: 'IMPORT_YEAR_REQUIRED_FOR_NEW',
    type: 'VALIDATION',
    domain: 'FINANCE',
    httpStatus: 400,
    message: '新增项目必须提供年度',
  },
  /** 同名跨年度记录导致空年度行匹配歧义（fin PRD §4） */
  IMPORT_YEAR_AMBIGUOUS: {
    code: 'IMPORT_YEAR_AMBIGUOUS',
    type: 'CONFLICT',
    domain: 'FINANCE',
    httpStatus: 409,
    message: '存在多条同名跨年度记录，无法匹配，请补充年度',
  },
  /** 预览后数据变化，确认事务的 dataRevision 前置失败（fin PRD §4） */
  IMPORT_PREVIEW_STALE: {
    code: 'IMPORT_PREVIEW_STALE',
    type: 'CONFLICT',
    domain: 'FINANCE',
    httpStatus: 409,
    message: '预览期间项目数据已变化，请重新预览',
  },
  /** 导入命中软删除项目（fin PRD §3） */
  IMPORT_PROJECT_DELETED: {
    code: 'IMPORT_PROJECT_DELETED',
    type: 'CONFLICT',
    domain: 'FINANCE',
    httpStatus: 409,
    message: '项目已被删除，请进入已删除项目视图恢复或改名',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
