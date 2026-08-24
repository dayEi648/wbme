import { DataTable } from '../../components/DataTable';
import { catalogFunctionLabel, catalogFunctionOptions } from '../../permission/catalog';

/** 我的操作日志（base PRD §6）：仅展示当前账号的操作记录，支持按系统/功能/操作/时间筛选与导出。 */
export function OperationLogsSection() {
  return (
    <DataTable
      title="我的操作日志"
      service="platform"
      endpoint="/me/operation-logs"
      pageKey="me-operation-logs"
      columns={[
        { key: 'createdAt', title: '时间', sortable: true },
        { key: 'system', title: '系统', enumKind: 'systemCode', sortable: true },
        { key: 'feature', title: '功能', render: (value: unknown) => catalogFunctionLabel(value), sortable: true },
        { key: 'actionType', title: '操作', enumKind: 'operationAction', sortable: true },
        { key: 'summary', title: '摘要', sortable: true },
      ]}
      filterFields={[
        {
          key: 'system',
          title: '系统',
          type: 'enum',
          options: [
            { label: '基础平台', value: 'BASE' },
            { label: '管理后台', value: 'BACKSTAGE' },
            { label: '资产系统', value: 'ASSET' },
            { label: '人事系统', value: 'HR' },
            { label: '财务系统', value: 'FIN' },
          ],
        },
        { key: 'feature', title: '功能', type: 'enum', options: (filters) => catalogFunctionOptions(filters.find((filter) => filter.field === 'system')?.value) },
        {
          key: 'actionType',
          title: '操作',
          type: 'enum',
          options: [
            { label: '新增', value: 'CREATE' },
            { label: '修改', value: 'UPDATE' },
            { label: '删除', value: 'DELETE' },
            { label: '导出', value: 'EXPORT' },
            { label: '查询', value: 'QUERY' },
          ],
        },
        { key: 'createdAt', title: '时间', type: 'date' },
      ]}
      exportConfig={{ allEndpoint: '/me/operation-logs/export', filename: 'my-operation-logs.xlsx' }}
    />
  );
}
