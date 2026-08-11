import { Tooltip, Typography } from 'antd';

interface EllipsisLinesProps {
  items: string[];
  /** 每行最多字符数（按 Unicode 码点计）。 */
  lineChars: number;
  /** 最多行数，缺省 3。 */
  maxRows?: number;
}

/**
 * 逐行排版字符串列表（顿号连接、贪心折行）：超出 maxRows 时末行省略并以 Tooltip 展示全量。
 * 用于表格内压缩展示"可进系统""可用功能"等长列表，空列表显示占位符。
 */
export function EllipsisLines({ items, lineChars, maxRows = 3 }: EllipsisLinesProps) {
  const lines = packLines(items, lineChars);
  if (lines.length === 0) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  const truncated = lines.length > maxRows;
  const visible = truncated ? lines.slice(0, maxRows) : lines;
  const content = (
    <div>
      {visible.map((line, index) => (
        <div key={index} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {truncated && index === visible.length - 1 ? `${line} …` : line}
        </div>
      ))}
    </div>
  );
  if (!truncated) {
    return content;
  }
  return <Tooltip title={items.join('、')}>{content}</Tooltip>;
}

/** 贪心拼行：逐项（含顿号分隔）追加到当前行，超宽则换行；单项超宽时独占一行（渲染层再省略）。 */
export function packLines(items: string[], lineChars: number): string[] {
  const charLength = (value: string) => Array.from(value).length;
  const lines: string[] = [];
  let current = '';
  for (const raw of items) {
    const item = raw.trim();
    if (!item) {
      continue;
    }
    const candidate = current ? `${current}、${item}` : item;
    if (current && charLength(candidate) > lineChars) {
      lines.push(current);
      current = item;
    } else {
      current = candidate;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}
