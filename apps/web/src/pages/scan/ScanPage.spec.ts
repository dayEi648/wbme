import { describe, expect, it } from 'vitest';
import { resolveScanTargetPath } from './ScanPage';

describe('扫码路由', () => {
  it('库存条目二维码保留条目 ID 并进入申领页', () => {
    expect(resolveScanTargetPath('INVENTORY_ITEM', 42, () => false)).toBe('/asset/claims?inventoryItemId=42');
  });

  it('资产二维码按可见范围进入资产详情', () => {
    expect(resolveScanTargetPath('ASSET', 7, (permission) => permission === 'my_assets')).toBe('/asset/my-assets?assetId=7');
    expect(resolveScanTargetPath('ASSET', 7, () => false)).toBe('/asset/assets?assetId=7');
  });

  it('长期申领目录仍进入通用申领页', () => {
    expect(resolveScanTargetPath('SCAN_CATALOG', null, () => false)).toBe('/asset/claims');
  });
});
