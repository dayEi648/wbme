import { Alert, Card, Descriptions, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useFeedback } from '../request/feedback';
import { http, type ApiService } from '../request/http';

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

interface JsonDetailsProps {
  title: string;
  service: ApiService;
  endpoint: string;
  description?: string;
}

/** 只读详情/状态页共用加载器，动态字段以安全文本呈现。 */
export function JsonDetails({ title, service, endpoint, description }: JsonDetailsProps) {
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
      <Typography.Title level={3}>{title}</Typography.Title>
      {description ? <Typography.Paragraph type="secondary">{description}</Typography.Paragraph> : null}
      <Card>
        {loading ? <Spin tip="正在加载..." /> : data ? <Descriptions bordered column={1} items={Object.entries(data).map(([label, value]) => ({ key: label, label, children: display(value) }))} /> : <Alert type="error" message="数据暂不可用" />}
      </Card>
    </>
  );
}
