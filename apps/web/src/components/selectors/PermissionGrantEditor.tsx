import { Checkbox, Radio, Select, Space, Table, Typography } from 'antd';
import { PERMISSION_CATALOG } from '../../permission/catalog';

/** 与主 PRD §3.1 / contracts DataScope 对齐的授权范围。 */
type DataScope = 'SELF' | 'DEPARTMENT' | 'COMPANY';

export interface GrantItem {
  functionCode: string;
  dataScope: DataScope;
}

const SCOPE_LABELS: Readonly<Record<DataScope, string>> = {
  SELF: '本人',
  DEPARTMENT: '部门',
  COMPANY: '公司',
};

const ALL_SCOPES: readonly DataScope[] = ['SELF', 'DEPARTMENT', 'COMPANY'];

interface PermissionGrantEditorProps {
  value?: GrantItem[];
  onChange?: (value: GrantItem[]) => void;
  /** tree：员工授权（勾选 + 范围下拉）；matrix：权限组矩阵点选。 */
  variant?: 'tree' | 'matrix';
  /** 非超管不可授予 permission_manage。 */
  hidePermissionManage?: boolean;
}

/**
 * 功能授权可视化编辑器：禁止手写 JSON。
 *
 * - tree：按系统/板块分组列出功能，勾选后为每项选择数据范围
 * - matrix：功能为行、数据范围为列的矩阵点选（权限组）
 *
 * @param props 受控授权列表与展示形态
 */
export function PermissionGrantEditor({
  value = [],
  onChange,
  variant = 'tree',
  hidePermissionManage = false,
}: PermissionGrantEditorProps) {
  const grants = Array.isArray(value) ? value : [];
  const grantMap = new Map(grants.map((item) => [item.functionCode, item.dataScope]));

  const setGrant = (functionCode: string, dataScope: DataScope | null) => {
    const next = grants.filter((item) => item.functionCode !== functionCode);
    if (dataScope) next.push({ functionCode, dataScope });
    onChange?.(next);
  };

  if (variant === 'matrix') {
    return <PermissionGrantMatrix grantMap={grantMap} setGrant={setGrant} hidePermissionManage={hidePermissionManage} />;
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {PERMISSION_CATALOG.map((system) => (
        <section key={system.code}>
          <Typography.Title level={5} style={{ margin: '0 0 8px' }}>{system.name}</Typography.Title>
          {system.sections.map((section) => (
            <div key={`${system.code}-${section.code}`} style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(0,0,0,0.02)', borderRadius: 6 }}>
              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{section.name}</Typography.Text>
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                {section.functions
                  .filter((fn) => !(hidePermissionManage && fn.code === 'permission_manage'))
                  .map((fn) => {
                    const checked = grantMap.has(fn.code);
                    const scopes = fn.dataScopeOptions;
                    const currentScope = grantMap.get(fn.code) ?? scopes[0] ?? 'COMPANY';
                    return (
                      <div key={fn.code} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Checkbox
                          checked={checked}
                          onChange={(event) => {
                            if (event.target.checked) {
                              setGrant(fn.code, scopes[0] ?? 'COMPANY');
                            } else {
                              setGrant(fn.code, null);
                            }
                          }}
                        >
                          <span title={fn.description}>{fn.name}</span>
                        </Checkbox>
                        {checked ? (
                          scopes.length <= 1 ? (
                            <Typography.Text type="secondary">{SCOPE_LABELS[scopes[0] ?? 'COMPANY']}</Typography.Text>
                          ) : (
                            <Select
                              size="small"
                              style={{ width: 120 }}
                              value={currentScope}
                              options={scopes.map((scope) => ({ label: SCOPE_LABELS[scope], value: scope }))}
                              onChange={(scope: DataScope) => setGrant(fn.code, scope)}
                            />
                          )
                        ) : null}
                      </div>
                    );
                  })}
              </Space>
            </div>
          ))}
        </section>
      ))}
    </Space>
  );
}

/** 权限组矩阵：行=功能，列=数据范围；每行至多选一档。 */
function PermissionGrantMatrix({
  grantMap,
  setGrant,
  hidePermissionManage,
}: {
  grantMap: Map<string, DataScope>;
  setGrant: (functionCode: string, dataScope: DataScope | null) => void;
  hidePermissionManage: boolean;
}) {
  const rows = PERMISSION_CATALOG.flatMap((system) =>
    system.sections.flatMap((section) =>
      section.functions
        .filter((fn) => !(hidePermissionManage && fn.code === 'permission_manage'))
        .map((fn) => ({
          key: fn.code,
          systemName: system.name,
          sectionName: section.name,
          name: fn.name,
          description: fn.description,
          scopes: fn.dataScopeOptions,
        })),
    ),
  );

  const columns = [
    {
      title: '系统',
      dataIndex: 'systemName',
      width: 100,
      onCell: (record: (typeof rows)[number], index?: number) => {
        const firstIndex = rows.findIndex((row) => row.systemName === record.systemName);
        if (index !== firstIndex) return { rowSpan: 0 };
        const span = rows.filter((row) => row.systemName === record.systemName).length;
        return { rowSpan: span };
      },
    },
    {
      title: '板块',
      dataIndex: 'sectionName',
      width: 100,
      onCell: (record: (typeof rows)[number], index?: number) => {
        const firstIndex = rows.findIndex((row) => row.systemName === record.systemName && row.sectionName === record.sectionName);
        if (index !== firstIndex) return { rowSpan: 0 };
        const span = rows.filter((row) => row.systemName === record.systemName && row.sectionName === record.sectionName).length;
        return { rowSpan: span };
      },
    },
    {
      title: '功能',
      dataIndex: 'name',
      render: (name: string, record: (typeof rows)[number]) => <span title={record.description}>{name}</span>,
    },
    ...ALL_SCOPES.map((scope) => ({
      title: SCOPE_LABELS[scope],
      key: scope,
      width: 88,
      align: 'center' as const,
      render: (_: unknown, record: (typeof rows)[number]) => {
        if (!record.scopes.includes(scope)) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }
        if (record.scopes.length === 1) {
          const checked = grantMap.get(record.key) === scope;
          return (
            <Checkbox
              checked={checked}
              onChange={(event) => setGrant(record.key, event.target.checked ? scope : null)}
            >
              启用
            </Checkbox>
          );
        }
        return (
          <Radio
            checked={grantMap.get(record.key) === scope}
            onClick={() => {
              if (grantMap.get(record.key) === scope) setGrant(record.key, null);
              else setGrant(record.key, scope);
            }}
          />
        );
      },
    })),
  ];

  return (
    <Table
      size="small"
      pagination={false}
      rowKey="key"
      dataSource={rows}
      scroll={{ x: 720, y: 420 }}
      columns={columns}
    />
  );
}
