import { useState, useEffect, type ChangeEvent } from 'react';

interface TestResult {
  input: any;
  expected: string;
  actual: string;
  is_correct: boolean;
  latency: string;
  record_id: string;
}

interface LogEntry {
  time: string;
  message: string;
  level: 'info' | 'error' | 'success';
}

interface DifyConfig {
    dify_api_key: string;
    dify_base_url: string;
    app_id: string;
    langfuse_public_key: string;
    langfuse_secret_key: string;
    langfuse_host: string;
    run_count: number;
    app_type: 'workflow' | 'chat' | 'chatflow';
    concurrency: number;
    feishu_app_id: string;
    feishu_app_secret: string;
    feishu_url: string;
}

interface FeishuField {
    name: string;
    id: string;
    type: number;
}

export default function App() {
  const [config, setConfig] = useState<DifyConfig>({
    dify_api_key: '',
    dify_base_url: 'http://10.82.108.12:31818/v1',
    app_id: '',
    langfuse_public_key: '',
    langfuse_secret_key: '',
    langfuse_host: 'http://10.82.108.12:31814',
    run_count: 1,
    app_type: 'workflow',
    concurrency: 5,
    feishu_app_id: '',
    feishu_app_secret: '',
    feishu_url: ''
  });

  const [feishuFields, setFeishuFields] = useState<FeishuField[]>([]);
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);
  const [showConfig, setShowConfig] = useState(true);
  const [showLogs, setShowLogs] = useState(true);

  const API_BASE = `http://${window.location.hostname}:8000`;

  // Load config from localStorage on mount
  useEffect(() => {
    const savedConfig = localStorage.getItem('dify_tester_config');
    if (savedConfig) {
      try {
        const parsed = JSON.parse(savedConfig);
        setConfig(prev => ({ ...prev, ...parsed }));
      } catch (e) {
        console.error('Failed to parse saved config', e);
      }
    }
  }, []);
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = (message: string, level: 'info' | 'error' | 'success' = 'info') => {
    setLogs(prev => [...prev, {
      time: new Date().toLocaleTimeString(),
      message,
      level
    }].slice(-50));
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setConfig((prev: DifyConfig) => ({ 
      ...prev, 
      [name]: (name === 'run_count' || name === 'concurrency') ? parseInt(value) || 1 : value 
    }));
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) setFile(e.target.files[0]);
  };

  const startTest = async () => {
    if (!file) return alert('请先上传数据集');
    
    // 立即重置 UI 状态，防止新旧任务状态冲突导致轮询不启动
    setJobId(null);
    setStatus(null);
    setLogs([]);
    setLoading(true);
    
    addLog('正在准备启动新一轮批量测试...', 'info');
    
    // 保存配置
    localStorage.setItem('dify_tester_config', JSON.stringify(config));
    
    const formData = new FormData();
    formData.append('file', file);
    Object.entries(config).forEach(([key, value]) => formData.append(key, value.toString()));

    try {
      addLog('正在向服务器发起请求...', 'info');
      const resp = await fetch(`${API_BASE}/start_test`, {
        method: 'POST',
        body: formData
      });
      const data = await resp.json();
      if (resp.ok) {
        setJobId(data.job_id);
        addLog(`任务成功启动, Job ID: ${data.job_id}`, 'success');
      } else {
        addLog(`服务器驳回请求: ${data.error || JSON.stringify(data)}`, 'error');
      }
    } catch (err) {
      addLog('网络异常: 无法连接至后端服务器', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let interval: any;
    const fetchStatus = async () => {
      if (!jobId) return;
      try {
        const resp = await fetch(`${API_BASE}/test_status/${jobId}`);
        const data = await resp.json();
        if (data.status === 'completed' && status?.status !== 'completed') {
          addLog('任务已全部完成！', 'success');
        } else if (data.status === 'running' && (status?.status === 'pending' || !status)) {
          addLog('后端已正式开始跑数...', 'info');
        }
        if (data.data && data.data.length > (status?.data?.length || 0)) {
          addLog(`同步成功: 新增 ${data.data.length - (status?.data?.length || 0)} 条结果`, 'info');
        }
        setStatus(data);
        if (data.status === 'completed' || data.status === 'error') clearInterval(interval);
      } catch (err) {
        addLog('同步状态异常', 'error');
      }
    };
    if (jobId && (!status || (status.status !== 'completed' && status.status !== 'error'))) {
      fetchStatus();
      interval = setInterval(fetchStatus, 3000);
    }
    return () => clearInterval(interval);
  }, [jobId, status?.status, status?.data?.length]);

  const parseFeishuUrl = (url: string) => {
    console.log('--- URL Parsing Start ---');
    console.log('Target:', url);
    try {
      // 提取 App Token (支持 base/app/bitable/wiki)
      const tokenMatch = url.match(/\/(?:base|app|bitable|wiki)\/([a-zA-Z0-9]+)/);
      const appToken = tokenMatch ? tokenMatch[1] : '';
      
      // 提取 Table ID
      let tableId = '';
      const tableParamMatch = url.match(/table=([a-zA-Z0-9]+)/);
      if (tableParamMatch) {
        tableId = tableParamMatch[1];
      } else {
        // 尝试从路径中抓取最后一部分
        const pureUrl = url.split('?')[0].split('#')[0];
        const parts = pureUrl.split('/').filter(p => p.length > 5); // 过滤掉太短的路径段
        const lastPart = parts[parts.length - 1];
        
        // 如果最后一段不是 appToken，且看起来像个 ID
        if (lastPart && lastPart !== appToken) {
          tableId = lastPart;
        }
      }
      
      console.log('Result -> AppToken:', appToken, 'TableId:', tableId);
      return { appToken, tableId };
    } catch (e) {
      console.error('Parse Error:', e);
      return { appToken: '', tableId: '' };
    }
  };

  const fetchFeishuFields = async () => {
    const { appToken, tableId } = parseFeishuUrl(config.feishu_url);
    if (!config.feishu_app_id || !config.feishu_app_secret || !appToken || !tableId) {
      return alert('请先完善飞书配置及正确的链接（链接需包含 AppToken 和 TableID）');
    }
    
    addLog(`正在解析飞书接口: ${appToken} / ${tableId}`, 'info');
    try {
      const resp = await fetch(`${API_BASE}/feishu/fields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: config.feishu_app_id,
          app_secret: config.feishu_app_secret,
          app_token: appToken,
          table_id: tableId
        })
      });
      const data = await resp.json();
      if (resp.ok) {
        setFeishuFields(data.fields);
        addLog(`成功获取 ${data.fields.length} 个飞书字段`, 'success');
      } else {
        const errorMsg = data.error || data.detail || data.msg || JSON.stringify(data);
        addLog(`获取飞书字段失败: ${errorMsg}`, 'error');
      }
    } catch (err) {
      addLog(`连接飞书接口异常: ${(err as Error).message}`, 'error');
    }
  };

  const syncToFeishu = async () => {
    if (!status?.data || status.data.length === 0) return alert('没有可同步的数据');
    const { appToken, tableId } = parseFeishuUrl(config.feishu_url);
    
    setSyncing(true);
    addLog('正在同步数据到飞书多维表格...', 'info');
    try {
      const resp = await fetch(`${API_BASE}/feishu/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: config.feishu_app_id,
          app_secret: config.feishu_app_secret,
          app_token: appToken,
          table_id: tableId,
          mapping: fieldMapping,
          data: status.data
        })
      });
      const data = await resp.json();
      if (resp.ok) {
        addLog(`同步成功: 已同步 ${data.count} 条记录`, 'success');
        alert(`同步成功！已上传 ${data.count} 条记录到飞书`);
      } else {
        const errorMsg = data.error || data.detail || data.msg || JSON.stringify(data);
        addLog(`同步失败: ${errorMsg}`, 'error');
      }
    } catch (err) {
      addLog(`同步过程发生异常: ${(err as Error).message}`, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const updateMapping = (resultKey: string, feishuFieldName: string) => {
    setFieldMapping(prev => ({ ...prev, [resultKey]: feishuFieldName }));
  };

  const exportResults = () => {
    if (!status?.data) return;
    
    // 添加 UTF-8 BOM，防止 Excel 打开中文乱码
    const BOM = '\uFEFF';
    const headers = ["输入(Input)", "预期(Expected)", "实际输出(Actual)", "是否正确(Correct)", "耗时(Latency)", "记录ID(RecordID)"].join(",");
    
    const csvContent = status.data.map((r: TestResult) => [
      JSON.stringify(r.input).replace(/,/g, ';').replace(/"/g, ''),
      String(r.expected).replace(/,/g, ';'),
      String(r.actual).replace(/,/g, ';').replace(/\n/g, ' '),
      r.is_correct ? '通过' : '失败',
      r.latency,
      r.record_id
    ].join(",")).join("\n");

    const fullContent = BOM + headers + "\n" + csvContent;
    const blob = new Blob([fullContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `测试结果_${jobId}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const accuracy = status?.data ? (status.data.filter((r: any) => r.is_correct).length / status.data.length * 100).toFixed(2) : 0;

  return (
    <div className="container">
      <header className="header">
        <h1>Dify工作流自动化测试工具</h1>
        <p>自动化测试工作流与准确率评估工具</p>
      </header>

      <div className="glass-card">
        <div className="section-header">
          <h2>配置参数</h2>
          <button className="icon-btn" onClick={() => setShowConfig(!showConfig)}>
            {showConfig ? '收起配置 ▲' : '展开配置 ▼'}
          </button>
        </div>
        
        {showConfig && (
          <div className="config-grid">
            <div className="input-group">
              <label>Dify API Key</label>
              <input type="password" name="dify_api_key" value={config.dify_api_key} placeholder="Bearer..." onChange={handleInputChange} />
            </div>
            <div className="input-group">
              <label>Dify Base URL</label>
              <input name="dify_base_url" value={config.dify_base_url} onChange={handleInputChange} />
            </div>
            <div className="input-group">
              <label>Dify App ID (Workflow ID)</label>
              <input name="app_id" value={config.app_id} placeholder="app-..." onChange={handleInputChange} />
            </div>
            <div className="input-group">
              <label>运行次数 (每个Case)</label>
              <input type="number" name="run_count" value={config.run_count} min="1" onChange={handleInputChange} />
            </div>
            <div className="input-group">
              <label>并发数 (Concurrency)</label>
              <input type="number" name="concurrency" value={config.concurrency} min="1" max="20" onChange={handleInputChange} />
            </div>
            <div className="input-group">
              <label>应用类型 (App Type)</label>
              <select name="app_type" value={config.app_type} onChange={handleInputChange}>
                <option value="workflow">Workflow (工作流)</option>
                <option value="chat">Chat / Agent (聊天/对话)</option>
                <option value="chatflow">Chatflow (对话型工作流)</option>
              </select>
            </div>
            <div className="input-group">
              <label>Langfuse Public Key</label>
              <input name="langfuse_public_key" value={config.langfuse_public_key} onChange={handleInputChange} />
            </div>
            <div className="input-group">
              <label>Langfuse Secret Key</label>
              <input type="password" name="langfuse_secret_key" value={config.langfuse_secret_key} onChange={handleInputChange} />
            </div>
            <div className="input-group">
              <label>上传 CSV 数据集 (包含 expected_output 列)</label>
              <input type="file" accept=".csv" onChange={handleFileChange} />
            </div>

            <div className="input-group full-width" style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
              <label style={{ color: 'var(--primary)', fontWeight: 'bold' }}>飞书多维表格同步配置 (可选)</label>
            </div>
            <div className="input-group">
              <label>飞书 App ID</label>
              <input name="feishu_app_id" value={config.feishu_app_id} onChange={handleInputChange} placeholder="cli_..." />
            </div>
            <div className="input-group">
              <label>飞书 App Secret</label>
              <input name="feishu_app_secret" type="password" value={config.feishu_app_secret} onChange={handleInputChange} />
            </div>
            <div className="input-group full-width">
              <label>多维表格链接 (自动解析 Token/TableId)</label>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <input name="feishu_url" value={config.feishu_url} onChange={handleInputChange} style={{ flex: 1 }} placeholder="https://xxx.feishu.cn/base/..." />
                <button className="icon-btn" onClick={fetchFeishuFields}>解析并获取字段</button>
              </div>
            </div>

            {feishuFields.length > 0 && (
              <div className="input-group full-width" style={{ marginTop: '1rem' }}>
                <label>字段 Mapping 映射</label>
                <div className="mapping-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '0.5rem' }}>
                   {[
                     { key: 'input', label: '原始输入 (JSON)' },
                     { key: 'expected', label: '预期结果' },
                     { key: 'actual', label: '实际输出' },
                     { key: 'is_correct', label: '测试结论' },
                     { key: 'latency', label: '测试时延' },
                     { key: 'record_id', label: '记录ID (Dify)' }
                   ].map(mapping => (
                     <div key={mapping.key} className="mapping-item" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{mapping.label} →</span>
                        <select 
                          value={fieldMapping[mapping.key] || ''} 
                          onChange={(e) => updateMapping(mapping.key, e.target.value)}
                        >
                          <option value="">-- 请选择多维表格字段 --</option>
                          {feishuFields.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
                        </select>
                     </div>
                   ))}
                </div>
              </div>
            )}
          </div>
        )}

        <button 
          className="btn" 
          onClick={startTest} 
          disabled={loading || status?.status === 'running' || status?.status === 'pending' || !file} 
          style={{ marginTop: '1rem' }}
        >
          {loading || status?.status === 'running' || status?.status === 'pending' ? '进行中~' : '开始测试'}
        </button>

        <div className="section-header" style={{ marginTop: '2rem' }}>
          <h3>实时日志</h3>
          <button className="icon-btn" onClick={() => setShowLogs(!showLogs)}>
            {showLogs ? '收起日志 ▲' : '展开日志 ▼'}
          </button>
        </div>
        
        {showLogs && (
          <div className="log-console">
            {logs.length === 0 && <div style={{ color: '#666' }}>等待任务启动...</div>}
            {logs.map((log, i) => (
              <div key={i} className="log-entry">
                <span className="log-time">[{log.time}]</span>
                <span className={`log-level-${log.level}`}>[{log.level.toUpperCase()}]</span>
                <span className="log-message">{log.message}</span>
              </div>
            ))}
          </div>
        )}

        {status && (
          <div style={{ marginTop: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '1rem' }}>
              <h3>测试状态: {status.status === 'running' ? '运行中...' : '已完成'} | 准确率: {accuracy}%</h3>
              <div style={{ display: 'flex', gap: '1rem' }}>
                {feishuFields.length > 0 && (
                  <button className="btn" onClick={syncToFeishu} disabled={syncing} style={{ background: '#3370ff' }}>
                    {syncing ? '同步中...' : '同步至飞书多维表格'}
                  </button>
                )}
                {status.status === 'completed' && (
                  <button className="btn" onClick={exportResults} style={{ background: 'var(--success)' }}>导出本地 CSV</button>
                )}
              </div>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${status.progress}%` }}></div>
            </div>

            <div className="results-table-container">
              <table>
                <thead>
                  <tr>
                    <th>输入</th>
                    <th>预期</th>
                    <th>输出</th>
                    <th>结果</th>
                    <th>时延</th>
                    <th>记录ID</th>
                  </tr>
                </thead>
                <tbody>
                  {status.data.map((res: TestResult, idx: number) => (
                    <tr key={idx}>
                      <td><pre style={{ fontSize: '0.75rem', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{JSON.stringify(res.input)}</pre></td>
                      <td>{res.expected}</td>
                      <td>{res.actual}</td>
                      <td>
                        <span className={`status-badge ${res.is_correct ? 'badge-success' : 'badge-error'}`}>
                          {res.is_correct ? 'Passed' : 'Failed'}
                        </span>
                      </td>
                      <td>{res.latency}</td>
                      <td style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>{res.record_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {status.data.length === 0 && <div className="empty-state">等待数据生成...</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
