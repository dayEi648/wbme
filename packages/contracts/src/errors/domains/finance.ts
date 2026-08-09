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
  /** 字典项被历史项目引用，批量删除整批拒绝（fin PRD §6） */
  DICT_REFERENCED: {
    code: 'DICT_REFERENCED',
    type: 'CONFLICT',
    domain: 'FINANCE',
    httpStatus: 409,
    message: '字典项已被项目引用，不能删除（可停用后新建替代项）',
    detailsFields: ['referenced'],
  },
  /** 项目进度金额语义被引用后不可修改（fin PRD §6） */
  DICT_SEMANTIC_LOCKED: {
    code: 'DICT_SEMANTIC_LOCKED',
    type: 'CONFLICT',
    domain: 'FINANCE',
    httpStatus: 409,
    message: '该进度选项已被项目引用，金额语义不可修改（请停用并新建选项）',
  },
  /** 业务分类真实字典项不得与系统虚拟分组“未分类”重名（fin PRD §4） */
  UNCLASSIFIED_NAME_CONFLICT: {
    code: 'UNCLASSIFIED_NAME_CONFLICT',
    type: 'VALIDATION',
    domain: 'FINANCE',
    httpStatus: 400,
    message: '业务分类名称不能使用“未分类”（系统虚拟分组保留名）',
  },
  /** 单元格即时保存提交了多个业务字段或未注册字段（fin PRD §4） */
  CELL_FIELD_NOT_ALLOWED: {
    code: 'CELL_FIELD_NOT_ALLOWED',
    type: 'VALIDATION',
    domain: 'FINANCE',
    httpStatus: 400,
    message: '一次只允许提交一个白名单内的业务字段',
  },
  /** 导入工作表结构/列签名与 V2 模板不匹配（fin PRD §4） */
  IMPORT_SHEET_INVALID: {
    code: 'IMPORT_SHEET_INVALID',
    type: 'VALIDATION',
    domain: 'FINANCE',
    httpStatus: 400,
    message: '文件工作表结构与利润分析模板不匹配，请使用平台导出的 V2 模板',
  },
  /** 导入确认引用了预览中不存在或非待选择的行（fin PRD §4） */
  IMPORT_CONFIRM_MISMATCH: {
    code: 'IMPORT_CONFIRM_MISMATCH',
    type: 'VALIDATION',
    domain: 'FINANCE',
    httpStatus: 400,
    message: '确认选择与预览结果不一致，请重新预览',
  },
} as const satisfies Readonly<Record<string, ErrorEntry>>;
