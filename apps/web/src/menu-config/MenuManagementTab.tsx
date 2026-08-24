import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, Modal, Space, Spin, Tree, Typography } from 'antd';
import type { TreeDataNode, TreeProps } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NavigationItem } from '../components/AppShell';
import { ConfirmAction } from '../components/ConfirmAction';
import { useFeedback } from '../request/feedback';
import { http } from '../request/http';
import {
  buildEditorState,
  collectGroupSubtreeKeys,
  createGroupNode,
  deleteGroupNode,
  moveEditorNode,
  moveEditorNodeByOffset,
  renameEditorNode,
  serializeEditorState,
  type EditorDragRef,
  type EditorDropTarget,
  type EditorGroupNode,
  type EditorItemNode,
  type EditorNode,
  type EditorRenameRef,
  type MenuEditorState,
} from './editor-state';
import { EMPTY_MENU_CONFIG, groupDefaultName } from './merge';
import type { MenuSystemCode, SystemMenuConfig } from './types';

interface MenuManagementTabProps {
  systemCode: MenuSystemCode;
  /** 代码默认导航（菜单项默认名/path 的唯一事实） */
  defaults: NavigationItem[];
  /** 保存/恢复默认成功后回调（让当前页面的 sidebar 立即生效） */
  onSaved: () => void;
}

/** 节点所在容器（allowDrop/onDrop 规则判定用） */
type NodeContainer =
  | { kind: 'top' }
  | { kind: 'group'; groupKey: string };

interface MenuTreeNode extends TreeDataNode {
  nodeType: 'group' | 'item';
  container: NodeContainer;
  payload: EditorNode;
  children?: MenuTreeNode[];
}

interface RenameState {
  ref: EditorRenameRef;
  /** 代码默认名（placeholder 与辅助文案） */
  defaultName: string;
}

/**
 * 菜单管理 tab（主 PRD §2.1）：当前系统导航的排序/分组层级/中文名维护。
 *
 * 仅调整代码已定义的菜单项与现有分组（不新建/删除分组）；拖拽或每行右侧的上移/下移
 * 按钮调整顺序；菜单项与分组均可在顶层与任意分组之间自由移动（分组可嵌套到任意深度，
 * 唯一限制：分组不能落入自身或其后代）。整树编辑后一次性保存（PUT 全量替换），或恢复
 * 默认（DELETE 清空配置行）。改名留空 = 恢复默认名。
 */
export function MenuManagementTab({ systemCode, defaults, onSaved }: MenuManagementTabProps) {
  const feedback = useFeedback();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [state, setState] = useState<MenuEditorState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);

  const defaultsByKey = useMemo(() => new Map(defaults.map((item) => [item.key, item])), [defaults]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const config = await http.get<SystemMenuConfig>(`/system-menu-configs/${systemCode}`, { active: true });
        if (!cancelled) {
          setState(buildEditorState(defaults, { groups: config.groups ?? [], items: config.items ?? [] }));
          setDirty(false);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadFailed(true);
          feedback.error(error, '菜单配置加载失败');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [systemCode, defaults, feedback, reloadVersion]);

  const openRename = useCallback((ref: EditorRenameRef, defaultName: string) => {
    setRename({ ref, defaultName });
    setRenameValue('');
  }, []);

  const applyMove = useCallback(
    (ref: EditorDragRef, delta: -1 | 1) => {
      if (!state) {
        return;
      }
      const next = moveEditorNodeByOffset(state, ref, delta);
      if (next) {
        setState(next);
        setDirty(true);
      }
    },
    [state],
  );

  const handleAddGroup = () => {
    if (!state) {
      return;
    }
    const created = createGroupNode(state, null);
    if (!created) {
      return;
    }
    setState(created.next);
    setDirty(true);
    openRename({ kind: 'group', nodeKey: created.nodeKey }, groupDefaultName(created.nodeKey));
  };

  const handleDeleteGroup = (nodeKey: string) => {
    if (!state) {
      return;
    }
    const next = deleteGroupNode(state, nodeKey);
    if (!next) {
      feedback.error('仅可删除空分组，请先移出其中的菜单项或子分组');
      return;
    }
    setState(next);
    setDirty(true);
  };

  const treeData = useMemo((): MenuTreeNode[] => {
    if (!state) {
      return [];
    }
    const titleOf = (
      ref: EditorRenameRef,
      defaultName: string,
      nameOverride: string | null,
      canMoveUp: boolean,
      canMoveDown: boolean,
      canDelete: boolean,
    ) => {
      const displayName = nameOverride ?? defaultName;
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <Space size={4}>
            <span>{displayName}</span>
            {nameOverride !== null ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                默认：{defaultName}
              </Typography.Text>
            ) : null}
          </Space>
          <Space size={0}>
            <Button
              type="text"
              size="small"
              icon={<ArrowUpOutlined />}
              aria-label={`上移 ${displayName}`}
              disabled={!canMoveUp}
              onClick={(event) => {
                event.stopPropagation();
                applyMove(ref, -1);
              }}
            />
            <Button
              type="text"
              size="small"
              icon={<ArrowDownOutlined />}
              aria-label={`下移 ${displayName}`}
              disabled={!canMoveDown}
              onClick={(event) => {
                event.stopPropagation();
                applyMove(ref, 1);
              }}
            />
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              aria-label={`重命名 ${displayName}`}
              onClick={(event) => {
                event.stopPropagation();
                openRename(ref, defaultName);
              }}
            />
            {canDelete ? (
              <ConfirmAction title={`确认删除分组“${displayName}”？`} description="仅可删除空分组；删除后未保存前可通过不保存放弃本次修改。" okText="删除" danger onConfirm={() => handleDeleteGroup(ref.kind === 'group' ? ref.nodeKey : '')}>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`删除分组 ${displayName}`}
                  onClick={(event) => event.stopPropagation()}
                />
              </ConfirmAction>
            ) : null}
          </Space>
        </div>
      );
    };
    const buildNode = (node: EditorNode, container: NodeContainer, canMoveUp: boolean, canMoveDown: boolean): MenuTreeNode => {
      if (node.kind === 'item') {
        const defaultName = defaultsByKey.get(node.itemKey)?.label ?? node.itemKey;
        return {
          key: `item:${node.itemKey}`,
          title: titleOf({ kind: 'item', itemKey: node.itemKey }, defaultName, node.nameOverride, canMoveUp, canMoveDown, false),
          nodeType: 'item',
          container,
          payload: node,
        };
      }
      const groupContainer: NodeContainer = { kind: 'group', groupKey: node.nodeKey };
      return {
        key: `group:${node.nodeKey}`,
        // 默认名与层级无关：nodeKey 取末段（移动到任意层级后仍显示原默认名）
        title: titleOf({ kind: 'group', nodeKey: node.nodeKey }, groupDefaultName(node.nodeKey), node.nameOverride, canMoveUp, canMoveDown, node.children.length === 0),
        nodeType: 'group',
        container,
        payload: node,
        children: node.children.map((child, index) =>
          buildNode(child, groupContainer, index > 0, index < node.children.length - 1),
        ),
      };
    };
    return state.top.map((node, index) =>
      buildNode(node, { kind: 'top' }, index > 0, index < state.top.length - 1),
    );
  }, [state, defaultsByKey, openRename, applyMove, handleDeleteGroup]);

  /** 拖放准入（antd 6：dropPosition 已是相对值，0 = 落入内部，±1 = 前后空隙）：
   * item 可落入分组内部或任意空隙（落到目标所在容器）；
   * group 可落入其他分组内部或任意空隙（任意嵌套），唯一限制是不能落入自身或其后代子树 */
  const allowDrop: TreeProps['allowDrop'] = ({ dragNode, dropNode, dropPosition }) => {
    const drag = dragNode as unknown as MenuTreeNode;
    const target = dropNode as unknown as MenuTreeNode;
    const gap = dropPosition !== 0;
    if (drag.nodeType === 'item') {
      return gap || target.nodeType === 'group';
    }
    const subtreeKeys = collectGroupSubtreeKeys(drag.payload as EditorGroupNode);
    if (!gap) {
      return target.nodeType === 'group' && !subtreeKeys.has((target.payload as EditorGroupNode).nodeKey);
    }
    // 空隙：落到目标所在容器；容器不能是拖拽分组自身或后代
    return target.container.kind === 'top' || !subtreeKeys.has(target.container.groupKey);
  };

  /** 树节点与编辑器节点的同键匹配（item 按 itemKey，group 按 nodeKey） */
  const sameNode = (candidate: EditorNode, target: MenuTreeNode): boolean =>
    target.nodeType === 'item'
      ? candidate.kind === 'item' && candidate.itemKey === (target.payload as EditorItemNode).itemKey
      : candidate.kind === 'group' && candidate.nodeKey === (target.payload as EditorGroupNode).nodeKey;

  const handleDrop: TreeProps['onDrop'] = (info) => {
    if (!state) {
      return;
    }
    const drag = info.dragNode as unknown as MenuTreeNode;
    const target = info.node as unknown as MenuTreeNode & { pos: string };
    const dropPos = target.pos.split('-');
    // antd 官方换算：-1 = 目标节点之前；0 = 目标节点内部；1 = 目标节点之后
    const relative = info.dropPosition - Number(dropPos[dropPos.length - 1]);

    let dropTarget: EditorDropTarget | null = null;
    if (!info.dropToGap) {
      // 落入分组内部 → 追加到末尾
      if (target.nodeType === 'group') {
        dropTarget = { type: 'children', groupKey: (target.payload as EditorGroupNode).nodeKey, index: Number.MAX_SAFE_INTEGER };
      }
    } else if (relative !== 0) {
      const offset = relative === 1 ? 1 : 0;
      if (target.container.kind === 'top') {
        const index = state.top.findIndex((node) => sameNode(node, target));
        dropTarget = index === -1 ? null : { type: 'top', index: index + offset };
      } else {
        const groupKey = target.container.groupKey;
        const findChildren = (nodes: EditorNode[]): EditorNode[] | null => {
          for (const node of nodes) {
            if (node.kind !== 'group') {
              continue;
            }
            if (node.nodeKey === groupKey) {
              return node.children;
            }
            const found = findChildren(node.children);
            if (found) {
              return found;
            }
          }
          return null;
        };
        const children = findChildren(state.top);
        const index = children?.findIndex((node) => sameNode(node, target)) ?? -1;
        dropTarget = !children || index === -1 ? null : { type: 'children', groupKey, index: index + offset };
      }
    }

    if (!dropTarget) {
      return;
    }
    const dragRef: EditorDragRef =
      drag.nodeType === 'item'
        ? { kind: 'item', itemKey: (drag.payload as EditorItemNode).itemKey }
        : { kind: 'group', nodeKey: (drag.payload as EditorGroupNode).nodeKey };
    const next = moveEditorNode(state, dragRef, dropTarget);
    if (next) {
      setState(next);
      setDirty(true);
    }
  };

  const confirmRename = () => {
    if (!state || !rename) {
      return;
    }
    const next = renameEditorNode(state, rename.ref, renameValue);
    if (next) {
      setState(next);
      setDirty(true);
    }
    setRename(null);
  };

  const handleSave = async () => {
    if (!state) {
      return;
    }
    const confirmed = await feedback.confirm({
      title: '确认保存菜单配置？',
      content: '保存后将对本系统所有用户生效。',
      okText: '保存',
    });
    if (!confirmed) {
      return;
    }
    setSaving(true);
    try {
      await http.put(`/system-menu-configs/${systemCode}`, serializeEditorState(state));
      setDirty(false);
      feedback.success('菜单配置已保存，对本系统所有用户生效');
      onSaved();
    } catch (error) {
      feedback.error(error, '菜单配置保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const confirmed = await feedback.confirmDanger(
      '恢复默认菜单',
      '将清空当前系统的菜单自定义（排序、分组归属、名称），恢复为默认结构。',
      '恢复默认',
    );
    if (!confirmed) {
      return;
    }
    setResetting(true);
    try {
      await http.delete(`/system-menu-configs/${systemCode}`);
      setState(buildEditorState(defaults, EMPTY_MENU_CONFIG));
      setDirty(false);
      feedback.success('已恢复默认菜单');
      onSaved();
    } catch (error) {
      feedback.error(error, '恢复默认失败');
    } finally {
      setResetting(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {loading ? (
        <Spin />
      ) : loadFailed || !state ? (
        <Space>
          <Typography.Text type="danger">菜单配置加载失败。</Typography.Text>
          <Button onClick={() => setReloadVersion((current) => current + 1)}>重试</Button>
        </Space>
      ) : (
        <>
          <Tree
            blockNode
            draggable
            selectable={false}
            defaultExpandAll
            allowDrop={allowDrop}
            onDrop={handleDrop}
            treeData={treeData}
          />
          <Space>
            <Button icon={<PlusOutlined />} disabled={saving} onClick={handleAddGroup}>
              新建分组
            </Button>
            <Button type="primary" disabled={!dirty} loading={saving} onClick={() => void handleSave()}>
              保存
            </Button>
            <Button danger disabled={saving} loading={resetting} onClick={() => void handleReset()}>
              恢复默认
            </Button>
            {dirty ? <Typography.Text type="warning">有未保存的修改</Typography.Text> : null}
          </Space>
        </>
      )}
      <Modal
        open={rename !== null}
        title="修改显示名称"
        okText="确定"
        cancelText="取消"
        onOk={confirmRename}
        onCancel={() => setRename(null)}
        destroyOnHidden
      >
        <Input
          value={renameValue}
          maxLength={50}
          placeholder={`默认名：${rename?.defaultName ?? ''}（留空恢复默认）`}
          onChange={(event) => setRenameValue(event.target.value)}
          onPressEnter={confirmRename}
        />
      </Modal>
    </Space>
  );
}
