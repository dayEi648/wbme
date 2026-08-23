import { Alert, Card, Descriptions, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { useFeedback } from '../request/feedback';
import { http, type ApiService } from '../request/http';
import { displayLabel, formatDetailValue, formatDisplayValue } from './display-format';

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface JsonDetailsProps {
  service: ApiService;
  endpoint: string;
  /** 业务详情的字段中文名；通用字段使用共享映射。 */
  labelMap?: Readonly<Record<string, string>>;
}

/** 只读详情/状态页共用加载器，动态字段以安全文本呈现。 */
export function JsonDetails({ service, endpoint, labelMap }: JsonDetailsProps) {
  const feedback = useFeedback();
  const [data, setData] = useState<RecordValue | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const result = await http.get<unknown>(endpoint, { service, active: true });
        setData(isRecord(result) ? result : { result });
      } catch (error) {
        setData(null);
        feedback.error(error, '详情加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [endpoint, feedback, service]);

  return (
    <>
      <Card>
        {loading ? <Spin tip="正在加载..." /> : data ? <Descriptions bordered column={1} items={Object.entries(data).map(([key, value]) => ({
          key,
          label: displayLabel(key, labelMap),
          children: <span style={{ whiteSpace: 'pre-wrap' }}>{typeof value === 'object' && value !== null ? JSON.stringify(formatDetailValue(value, labelMap), null, 2) : formatDisplayValue(value, key)}</span>,
        }))} /> : <Alert type="error" message="数据暂不可用" />}
      </Card>
    </>
  );
}
