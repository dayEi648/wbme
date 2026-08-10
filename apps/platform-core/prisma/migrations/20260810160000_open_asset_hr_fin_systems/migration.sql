-- 批次 4-4：ASSET/HR/FIN 三业务系统置为「开放」。
-- 目录 productStatus 仅首次注册写入，对账不覆盖已注册行（管理员可调回 COMING_SOON），
-- 存量数据在此一次性同步为 OPEN，与新目录初始状态一致。
UPDATE backstage.systems
SET product_status = 'OPEN'
WHERE code IN ('ASSET', 'HR', 'FIN') AND product_status <> 'OPEN';
