import os
import json
import time
import requests
import pandas as pd
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from langfuse import Langfuse

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage for test results
test_results = {}
results_lock = threading.Lock()

class TestConfig(BaseModel):
    dify_api_key: str
    dify_base_url: str
    app_id: str
    langfuse_public_key: str
    langfuse_secret_key: str
    langfuse_host: str
    run_count: int = 1
    app_type: str = "workflow"
    concurrency: int = 5

class FeishuFieldRequest(BaseModel):
    app_id: str
    app_secret: str
    app_token: str
    table_id: str

class FeishuSyncRequest(BaseModel):
    app_id: str
    app_secret: str
    app_token: str
    table_id: str
    mapping: Dict[str, str]
    data: List[Dict[str, Any]]

def get_feishu_access_token(app_id: str, app_secret: str):
    url = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal"
    resp = requests.post(url, json={"app_id": app_id, "app_secret": app_secret})
    data = resp.json()
    if data.get("code") != 0:
        raise Exception(f"获取飞书 Token 失败: {data.get('msg')} (Code: {data.get('code')})")
    return data.get("app_access_token")

@app.post("/feishu/fields")
async def get_feishu_fields(req: FeishuFieldRequest):
    try:
        print(f"--- [Feishu Diagnostics] AppToken: {req.app_token} | TableId: {req.table_id} ---")
        if not req.app_token or not req.table_id:
            return JSONResponse(status_code=400, content={"error": "解析失败：AppToken 或 TableID 不能为空，请检查链接格式"})
            
        token = get_feishu_access_token(req.app_id, req.app_secret)
        url = f"https://open.feishu.cn/open-apis/bitable/v1/apps/{req.app_token}/tables/{req.table_id}/fields"
        headers = {"Authorization": f"Bearer {token}"}
        resp = requests.get(url, headers=headers)
        
        data = resp.json()
        if data.get("code") != 0:
            print(f"!!! Feishu API Error: {data}")
            return JSONResponse(status_code=400, content={"error": f"飞书接口报错: {data.get('msg')} (Code: {data.get('code')})"})
            
        fields = data.get("data", {}).get("items", [])
        return {"fields": [{"name": f["field_name"], "id": f["field_id"], "type": f["type"]} for f in fields]}
    except Exception as e:
        print(f"!!! [Feishu] 异常: {str(e)}")
        return JSONResponse(status_code=400, content={"error": str(e)})

@app.post("/feishu/sync")
async def sync_to_feishu(req: FeishuSyncRequest):
    try:
        token = get_feishu_access_token(req.app_id, req.app_secret)
        url = f"https://open.feishu.cn/open-apis/bitable/v1/apps/{req.app_token}/tables/{req.table_id}/records/batch_create"
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        
        records = []
        for item in req.data:
            fields = {}
            for result_key, feishu_field in req.mapping.items():
                if not feishu_field: continue
                # 把数据映射到飞书字段
                val = item.get(result_key, "")
                if result_key == "input" and isinstance(val, dict):
                    val = json.dumps(val, ensure_ascii=False)
                elif result_key == "is_correct":
                    val = "通过" if val else "失败"
                fields[feishu_field] = str(val)
            records.append({"fields": fields})

        # 飞书批量创建限制 100 条
        for i in range(0, len(records), 100):
            batch = records[i:i+100]
            resp = requests.post(url, headers=headers, json={"records": batch})
            resp.raise_for_status()
            
        return {"status": "success", "count": len(records)}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

# --- Dify Testing Core (Keep previous logic) ---

def call_dify_api_smart(config: TestConfig, raw_inputs: Dict[str, Any], user: str = "tester") -> Dict[str, Any]:
    base_url = config.dify_base_url.rstrip('/')
    if not base_url.startswith("http"): base_url = f"http://{base_url}"
    safe_inputs = {str(k): str(v) for k, v in raw_inputs.items() if v is not None and str(v).lower() != 'nan'}
    def do_call(mode: str):
        path = "/workflows/run" if mode == "workflow" else "/chat-messages"
        url = f"{base_url}{path}" if "/v1" in base_url else f"{base_url}/v1{path}"
        headers = {"Authorization": f"Bearer {config.dify_api_key}", "Content-Type": "application/json"}
        if mode == "workflow":
            payload = {"inputs": safe_inputs, "response_mode": "blocking", "user": user}
        else:
            q_keys = ['query', 'question', 'text', 'input', '问题', '内容']
            main_query = "Hello"
            for k in q_keys:
                match = next((orig_k for orig_k in safe_inputs.keys() if orig_k.lower() == k), None)
                if match:
                    main_query = safe_inputs[match]
                    break
            else:
                if safe_inputs: main_query = list(safe_inputs.values())[0]
            payload = {"inputs": safe_inputs, "query": main_query, "response_mode": "blocking", "user": user}
        return requests.post(url, headers=headers, json=payload, timeout=120)

    response = do_call(config.app_type)
    if response.status_code == 400 and ("not_workflow_app" in response.text or "not_chat_app" in response.text):
        retry_mode = "chat" if config.app_type == "workflow" else "workflow"
        response = do_call(retry_mode)
    if response.status_code != 200: response.raise_for_status()
    return response.json()

def run_single_test_item(job_id: str, config: TestConfig, row_data: Dict[str, Any], expected: str, client: Optional[Langfuse]):
    start_time = time.time()
    trace_id = ""
    try:
        trace_obj = None
        if client and hasattr(client, 'trace'):
            trace_obj = client.trace(name=f"Parallel-Test-{job_id}", input=row_data)
            trace_id = trace_obj.id

        resp = call_dify_api_smart(config, row_data)
        
        # 提取执行记录的唯一值 (Workflow: workflow_run_id, Chat: message_id)
        record_id = resp.get("workflow_run_id") or resp.get("message_id") or "N/A"
        
        actual = resp.get("data", {}).get("outputs", {}).get("text", "") 
        if not actual: actual = resp.get("answer", "")
        if not actual: actual = str(resp)

        latency = time.time() - start_time
        is_correct = (expected.lower() in str(actual).lower()) if expected else True
        if trace_obj: trace_obj.update(output=actual, metadata={"is_correct": is_correct, "latency": latency, "record_id": record_id})
        
        result = {
            "input": row_data, "expected": expected, "actual": actual,
            "is_correct": is_correct, "latency": f"{latency:.2f}s",
            "record_id": record_id
        }
    except Exception as e:
        err_detail = str(e)
        if hasattr(e, 'response') and e.response is not None:
            err_detail = f"Dify Error ({e.response.status_code}): {e.response.text}"
        result = {"input": row_data, "expected": expected, "actual": err_detail, "is_correct": False, "latency": "0s", "trace_url": ""}
    if client: client.flush()
    return result

def run_batch_test(job_id: str, config: TestConfig, dataset: List[Dict[str, Any]]):
    try:
        client = None
        if config.langfuse_public_key and config.langfuse_secret_key:
            try: client = Langfuse(public_key=config.langfuse_public_key, secret_key=config.langfuse_secret_key, host=config.langfuse_host)
            except: pass
        test_results[job_id]["status"] = "running"
        test_results[job_id]["progress"] = 1
        all_tasks = []
        for item in dataset:
            row_data = item.copy()
            expected = ""
            for ek in ['expected_output', 'expected', '预期', '答案', 'output']:
                if ek in row_data:
                    expected = str(row_data.pop(ek)).strip()
                    break
            for _ in range(config.run_count): all_tasks.append((row_data.copy(), expected))

        total_tasks = len(all_tasks)
        completed_tasks = 0
        results = []
        with ThreadPoolExecutor(max_workers=config.concurrency) as executor:
            future_to_task = {executor.submit(run_single_test_item, job_id, config, task[0], task[1], client): task for task in all_tasks}
            for future in as_completed(future_to_task):
                task_result = future.result()
                with results_lock:
                    results.append(task_result)
                    completed_tasks += 1
                    test_results[job_id]["progress"] = int((completed_tasks / total_tasks) * 100)
                    test_results[job_id]["data"] = list(results)
                    
        test_results[job_id]["status"] = "completed"
    except Exception:
        if job_id in test_results: test_results[job_id]["status"] = "error"

@app.post("/start_test")
async def start_test(
    background_tasks: BackgroundTasks,
    dify_api_key: str = Form(...), dify_base_url: str = Form(...), app_id: str = Form(...),
    langfuse_public_key: str = Form(...), langfuse_secret_key: str = Form(...),
    langfuse_host: str = Form(...), run_count: int = Form(1),
    app_type: str = Form("workflow"), concurrency: int = Form(5),
    file: UploadFile = File(...)
):
    try:
        content = await file.read()
        import charset_normalizer
        encoding = charset_normalizer.from_bytes(content).best().encoding or 'utf-8'
        df = pd.read_csv(pd.io.common.BytesIO(content), encoding=encoding)
        dataset = df.to_dict(orient="records")
        job_id = f"job_{int(time.time())}"
        test_results[job_id] = {"status": "pending", "progress": 0, "data": []}
        config = TestConfig(
            dify_api_key=dify_api_key, dify_base_url=dify_base_url, app_id=app_id,
            langfuse_public_key=langfuse_public_key, langfuse_secret_key=langfuse_secret_key,
            langfuse_host=langfuse_host, run_count=run_count, app_type=app_type, concurrency=concurrency
        )
        background_tasks.add_task(run_batch_test, job_id, config, dataset)
        return {"job_id": job_id}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

@app.get("/test_status/{job_id}")
async def get_test_status(job_id: str):
    return test_results.get(job_id, {"status": "not_found"})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
