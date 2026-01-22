# Dify & Langfuse 自动化测试工具 🚀

![React](https://img.shields.io/badge/Frontend-React-blue?style=flat-square) ![FastAPI](https://img.shields.io/badge/Backend-FastAPI-green?style=flat-square) ![Dify](https://img.shields.io/badge/Integration-Dify-orange?style=flat-square) ![Langfuse](https://img.shields.io/badge/Integration-Langfuse-purple?style=flat-square)

这是一款专为 **Dify** 工作流和 **Langfuse** 提示词设计的高性能自动化测试工具。它支持大规模数据集的并行运行、准确率自动评估、实时日志监控，并能将测试结果一键同步至 **飞书多维表格 (Bitable)**。

## ✨ 核心特性

- ⚡ **并行测试**：采用 Python `ThreadPoolExecutor` 并发技术，支持设置并发数（最大建议 20），大幅提升测试任务执行效率。
- 🤖 **多模式支持**：
    - **Dify Workflow/Chat**：直接调用 Dify 工作流或对话 API。
    - **Langfuse Prompt Testing**：直接从 Langfuse 提示词仓库拉取 Prompt，并使用 OpenAI/兼容接口进行直接对比测试。
- 📊 **准确率评估**：支持上传包含预期结果的 CSV 数据集，自动计算通过率（Accuracy）。
- 🔗 **飞书同步**：支持将测试结果（输入、输出、耗时、记录 ID 等）映射并同步至飞书多维表格，方便团队协作与归档。
- 🔍 **分布式追踪**：深度集成 Langfuse，自动记录 Trace 数据，支持在 Dify 和 Langfuse 之间通过 `Record ID` 快速跳转。
- 🎨 **现代化 UI**：基于 React 构建的高颜值深色模式界面，支持配置持久化存储。

## 🛠️ 技术栈

- **前端**: React 18, TypeScript, Vite, Vanilla CSS (Glassmorphism design)
- **后端**: Python 3.10+, FastAPI, Uvicorn, Pandas, Requests
- **集成**: Dify API, Langfuse SDK, OpenAI SDK, Feishu Open API

## 🚀 快速开始

### 1. 克隆与环境配置

```bash
# 进入后端目录
cd backend
pip install -r requirements.txt

# 进入前端目录
cd frontend
npm install
```

### 2. 启动服务

**启动后端 (默认端口 8000):**
```bash
cd backend
python main.py
```

**启动前端 (默认端口 5173):**
```bash
cd frontend
npm run dev
```

### 3. 使用步骤

1. **配置参数**：在 UI 界面输入 Dify API Key、Base URL 以及 Langfuse 的配置。
2. **上传数据集**：准备一个 CSV 文件，必须包含测试输入列，建议包含 `expected_output` 列用于准确率计算。
3. **设置并发**：根据 Dify 服务器性能设置并发数（推荐 5-10）。
4. **开始测试**：点击“开始测试”，实时观察日志输出和进度条。
5. **同步结果**：测试完成后，可选择 CSV 下载或配置飞书同步参数将结果写入多维表格。

## 📋 数据集格式示例 (CSV)

| input_query | expected_output | context |
| :--- | :--- | :--- |
| 你好，请介绍一下你自己 | 我是一个人工智能助手 | 助手背景信息... |
| 1+1 等于几？ | 2 | 基础数学 |

*注：工具会自动识别 `预期`、`答案`、`expected` 等列名。*

## 📝 注意事项

- **CSV 编码**：工具支持自动检测编码，推荐使用 UTF-8。
- **并发控制**：测试时请注意 Dify 后端的数据库连接数限制，建议并发不要超过 20。
- **飞书配置**：飞书 App 需要具备“多维表格”的读写权限，且多维表格需要添加该自建应用为“协同人”。

## 📄 开源协议

MIT License
