import { Button, Checkbox, Col, Drawer, Row, Select, Space, Spin, Tabs, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { PERMISSION_CATALOG } from '../../permission/catalog';
import { useFeedback } from '../../request/feedback';
import { http } from '../../request/http';
import type { GrantItem } from './PermissionGrantEditor';

type DataScope = GrantItem['dataScope'];

const SCOPE_LABELS: Readonly<Record<DataScope, string>> = {
  SELF: '本人',
  DEPARTMENT: '部门',
  COMPANY: '公司',
};

interface PermissionGrantDrawerProps {
  /** 目标员工；null 时抽屉关闭。 */
  target: { id: number; name: string } | null;
  /** 非超管不可授予 permission_manage。 */
  hidePermissionManage: boolean;
  onClose: () => void;
  /** 保存成功后回调（外层刷新列表）。 */
  onSaved: () => void;
}

interface GrantsPayload {
  permissionVersion?: number;
  grants?: Array<{ functionCode?: unknown; dataScope?: unknown }>;
}

/**
 * 修改员工权限抽屉：按系统分 tab，系统内按业务板块分组、每行 3 个功能紧凑排布；
 * 勾选多范围功能后在其旁选择数据范围（本人/部门/公司），底部保存（乐观锁沿用 permissionVersion）。
 */
export function PermissionGrantDrawer({ target, hidePermissionManage, onClose, onSaved }: PermissionGrantDrawerProps) {
  const feedback = useFeedback();
  const [permissionVersion, setPermissionVersion] = useState<number | null>(null);
  const [grants, setGrants] = useState<GrantItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!target) {
      setPermissionVersion(null);
      setGrants([]);
      return;
    }
    setLoading(true);
    void http.get<GrantsPayload>(`/permission/employees/${target.id}/grants`, { active: true })
      .then((result) => {
        setPermissionVersion(typeof result.permissionVersion === 'number' ? result.permissionVersion : null);
        setGrants(
          (Array.isArray(result.grants) ? result.grants : [])
            .filter((grant) => typeof grant.functionCode === 'string' && typeof grant.dataScope === 'string')
            .map((grant) => ({ functionCode: String(grant.functionCode), dataScope: grant.dataScope as DataScope })),
        );
      })
      .catch((error) => feedback.error(error, '员工授权加载失败'))
      .finally(() => setLoading(false));
  }, [feedback, target]);

  const grantMap = new Map(grants.map((item) => [item.functionCode, item.dataScope]));
  const setGrant = (functionCode: string, dataScope: DataScope | null) => {
    const next = grants.filter((item) => item.functionCode !== functionCode);
    if (dataScope) {
      next.push({ functionCode, dataScope });
    }
    setGrants(next);
  };

  const save = async () => {
    if (!target || permissionVersion === null) {
      return;
    }
    setSaving(true);
    try {
      await http.put(`/permission/employees/${target.id}/grants`, { permissionVersion, grants });
      feedback.success('员工授权已保存');
      onSaved();
      onClose();
    } catch (error) {
      feedback.error(error, '保存员工授权失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title={target ? `修改权限：${target.name}` : '修改权限'}
      open={target !== null}
      onClose={onClose}
      width="min(92vw, 760px)"
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} disabled={loading || permissionVersion === null} onClick={() => void save()}>保存</Button>
        </Space>
      }
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin />正在加载授权...</div>
      ) : (
        <Tabs
          items={PERMISSION_CATALOG.map((system) => ({
            key: system.code,
            label: system.name,
            children: (
              <div>
                {system.sections.map((section) => {
                  const functions = section.functions.filter((fn) => !(hidePermissionManage && fn.code === 'permission_manage'));
                  if (functions.length === 0) {
                    return null;
                  }
                  return (
                    <div key={section.code} style={{ marginBottom: 16 }}>
                      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{section.name}</Typography.Text>
                      <Row gutter={[8, 8]}>
                        {functions.map((fn) => {
                          const checked = grantMap.has(fn.code);
                          const currentScope = grantMap.get(fn.code) ?? fn.dataScopeOptions[0] ?? 'COMPANY';
                          return (
                            <Col span={8} key={fn.code}>
                              <Space size={4} wrap={false}>
                                <Checkbox
                                  checked={checked}
                                  onChange={(event) => setGrant(fn.code, event.target.checked ? (fn.dataScopeOptions[0] ?? 'COMPANY') : null)}
                                >
                                  <span title={fn.description}>{fn.name}</span>
                                </Checkbox>
                                {checked ? (
                                  fn.dataScopeOptions.length > 1 ? (
                                    <Select
                                      size="small"
                                      style={{ width: 76 }}
                                      value={currentScope}
                                      options={fn.dataScopeOptions.map((scope) => ({ label: SCOPE_LABELS[scope], value: scope }))}
                                      onChange={(scope: DataScope) => setGrant(fn.code, scope)}
                                    />
                                  ) : (
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{SCOPE_LABELS[fn.dataScopeOptions[0] ?? 'COMPANY']}</Typography.Text>
                                  )
                                ) : null}
                              </Space>
                            </Col>
                          );
                        })}
                      </Row>
                    </div>
                  );
                })}
              </div>
            ),
          }))}
        />
      )}
    </Drawer>
  );
}
