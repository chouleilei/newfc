import { Button, Space, Typography } from 'antd';
import { useAssistant } from '../../assistant/AssistantProvider';
export function ListSelectionActions({ count, mode, onQuery, onRefs, onClear }: { count: number; mode: 'refs' | 'query' | null; onQuery: () => void; onRefs: () => void; onClear: () => void }) {
  const assistant = useAssistant();
  return <Space wrap>
    <Typography.Text type="secondary">{mode === 'query' ? '范围：全部筛选结果（包含分页外）' : count ? '已选 ' + count + ' 项' : '可勾选对象向助手提问'}</Typography.Text>
    <Button disabled={!count} onClick={() => { onRefs(); assistant.openDock(); }}>分析选中项</Button>
    <Button onClick={() => { onQuery(); assistant.openDock(); }}>分析当前筛选结果</Button>
    <Button disabled={!mode && !count} onClick={onClear}>清空选择</Button>
  </Space>;
}
