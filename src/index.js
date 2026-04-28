/**
 * Cloudflare Worker - MCP翻页服务器 (完整版)
 * 
 * 功能：
 * - MCP 协议支持（AI 调用）
 * - SSE 推送（服务器通知）
 * - 完整控制页面（蓝牙设备控制、翻页、电机控制）
 */

const MCP_VERSION = '2024-11-05';

// 工具定义
const TOOLS = [
  {
    name: 'page_turn',
    description: '执行翻页动作，让机械臂翻到下一页',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_status',
    description: '获取当前控制状态',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

// 全局 SSE 客户端
if (!globalThis.sseClients) globalThis.sseClients = [];

// SSE 连接
async function handleSSE(request) {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));
      
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch (e) {
          clearInterval(heartbeat);
        }
      }, 30000);
      
      globalThis.sseClients.push(controller);
      
      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        const idx = globalThis.sseClients.indexOf(controller);
        if (idx > -1) globalThis.sseClients.splice(idx, 1);
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}

// 广播消息
function broadcast(msg) {
  if (!globalThis.sseClients) return;
  const encoder = new TextEncoder();
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  
  globalThis.sseClients = globalThis.sseClients.filter(controller => {
    try {
      controller.enqueue(encoder.encode(data));
      return true;
    } catch (e) {
      return false;
    }
  });
}

// MCP JSON-RPC 响应
function jsonRpcResponse(id, result) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id,
    result
  }), { headers: { 'Content-Type': 'application/json' } });
}

function jsonRpcError(id, code, message) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message }
  }), { headers: { 'Content-Type': 'application/json' } });
}

// MCP 端点
async function handleMCP(request) {
  try {
    const body = await request.json();
    const { method, id, params } = body;

    switch (method) {
      case 'initialize':
        return jsonRpcResponse(id, {
          protocolVersion: MCP_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'page-turner-mcp', version: '1.0.0' }
        });

      case 'notifications/initialized':
        broadcast({ type: 'log', message: 'AI 客户端已就绪' });
        return new Response(null, { status: 202 });

      case 'ping':
        return jsonRpcResponse(id, {});

      case 'tools/list':
        return jsonRpcResponse(id, { tools: TOOLS });

      case 'tools/call':
        if (!params || !params.name) {
          return jsonRpcError(id, -32602, 'Invalid params');
        }

        const toolName = params.name;

        if (toolName === 'page_turn') {
          broadcast({ type: 'command', action: 'page_turn' });
          broadcast({ type: 'log', message: 'AI 请求执行翻页...' });
          
          return jsonRpcResponse(id, {
            content: [{ type: 'text', text: JSON.stringify({ success: true, message: '翻页命令已发送' }) }],
            isError: false
          });
        }

        if (toolName === 'get_status') {
          return jsonRpcResponse(id, {
            content: [{ type: 'text', text: JSON.stringify({ sseClients: globalThis.sseClients.length }) }],
            isError: false
          });
        }

        return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }

  } catch (e) {
    return jsonRpcError(null, -32700, `Parse error: ${e.message}`);
  }
}

// 命令端点
async function handleCommand(request) {
  try {
    const body = await request.json();
    
    if (body.type === 'result') {
      broadcast({ type: 'result', result: body.result });
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (body.type === 'log') {
      broadcast({ type: 'log', message: body.message });
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown type' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// Worker 主入口
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === '/events' && method === 'GET') {
      return handleSSE(request);
    }

    if (url.pathname === '/mcp' && method === 'POST') {
      return handleMCP(request);
    }

    if ((url.pathname === '/command' || url.pathname === '/control') && method === 'POST') {
      return handleCommand(request);
    }

    if (url.pathname === '/') {
      return new Response(getControlPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// 完整控制页面
function getControlPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>翻页机械臂控制</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            padding: 15px;
            color: #fff;
        }
        .container { max-width: 480px; margin: 0 auto; }
        
        .header { text-align: center; padding: 20px 0; }
        .header h1 {
            font-size: 22px;
            font-weight: 600;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .connection-card {
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            padding: 20px;
            margin-bottom: 15px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .conn-title {
            font-size: 12px;
            color: #888;
            margin-bottom: 15px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .conn-devices { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .device-btn {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 15px;
            cursor: pointer;
            transition: all 0.3s;
            text-align: center;
        }
        .device-btn:hover { background: rgba(255,255,255,0.1); }
        .device-btn.connected { background: rgba(40,167,69,0.2); border-color: #28a745; }
        .device-icon { font-size: 28px; margin-bottom: 8px; }
        .device-name { font-size: 14px; font-weight: 500; }
        .device-status { font-size: 11px; color: #888; margin-top: 4px; }
        .device-btn.connected .device-status { color: #28a745; }
        
        .phase-progress {
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            padding: 15px;
            margin-bottom: 15px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .phase-bar {
            height: 8px;
            background: rgba(255,255,255,0.1);
            border-radius: 4px;
            overflow: hidden;
            margin-bottom: 10px;
        }
        .phase-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            border-radius: 4px;
            transition: width 0.3s ease;
            width: 0%;
        }
        .phase-text { font-size: 13px; color: #888; text-align: center; }
        
        .action-buttons {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 15px;
            transition: all 0.3s ease;
        }
        .action-buttons.collapsed { grid-template-columns: 1fr; }
        .action-buttons.collapsed .btn-secondary { display: none; }
        .btn {
            padding: 16px;
            border: none;
            border-radius: 12px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .btn:active { transform: scale(0.98); }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; }
        .btn-primary {
            background: linear-gradient(135deg, #e94560 0%, #ff6b6b 50%, #feca57 100%);
            color: white;
            grid-column: 1 / -1;
            padding: 28px 20px;
            font-size: 22px;
            font-weight: 700;
            border-radius: 20px;
            text-shadow: 0 2px 4px rgba(0,0,0,0.3);
            box-shadow: 0 6px 20px rgba(233,69,96,0.4);
            letter-spacing: 2px;
        }
        .btn-primary:hover:not(:disabled) { box-shadow: 0 10px 35px rgba(233,69,96,0.5); transform: translateY(-2px); }
        .btn-primary:active:not(:disabled) { transform: translateY(0) scale(0.98); }
        .btn-primary.running { animation: pulse-primary 1.2s infinite; }
        @keyframes pulse-primary {
            0%, 100% { box-shadow: 0 6px 20px rgba(233,69,96,0.4); }
            50% { box-shadow: 0 6px 40px rgba(233,69,96,0.7); }
        }
        .btn-secondary { background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2); }
        .btn-secondary:hover:not(:disabled) { background: rgba(255,255,255,0.15); }
        .btn-server {
            background: rgba(102,126,234,0.2);
            color: #667eea;
            border: 1px solid rgba(102,126,234,0.3);
        }
        .btn-server:hover:not(:disabled) { background: rgba(102,126,234,0.3); }
        .btn-server.connected { background: rgba(102,126,234,0.3); border-color: #667eea; }
        
        .mcp-card {
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            padding: 15px;
            margin-bottom: 15px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .mcp-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .mcp-title { font-size: 14px; font-weight: 500; }
        .mcp-status { font-size: 12px; color: #888; }
        .mcp-status.connected { color: #28a745; }
        .mcp-actions { display: flex; gap: 10px; flex-wrap: wrap; }
        
        .motor-card {
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            padding: 15px;
            margin-bottom: 15px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .motor-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        .motor-title { font-size: 14px; font-weight: 500; }
        .motor-value {
            font-size: 20px;
            font-weight: 600;
            color: #667eea;
            font-family: 'Monaco', monospace;
        }
        .motor-slider {
            width: 100%;
            height: 8px;
            -webkit-appearance: none;
            background: rgba(255,255,255,0.1);
            border-radius: 4px;
            outline: none;
        }
        .motor-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 24px;
            height: 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 50%;
            cursor: pointer;
        }
        
        .position-card {
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            padding: 15px;
            margin-bottom: 15px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .pos-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .pos-row:last-child { border-bottom: none; }
        .pos-label { color: #888; font-size: 14px; }
        .pos-value {
            font-family: 'Monaco', monospace;
            font-size: 13px;
            color: #667eea;
        }
        .pos-value.empty { color: #555; }
        
        .log-card {
            background: rgba(0,0,0,0.3);
            border-radius: 16px;
            padding: 15px;
            border: 1px solid rgba(255,255,255,0.05);
        }
        .log-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .log-title { font-size: 14px; font-weight: 500; }
        .log-clear {
            background: none;
            border: none;
            color: #888;
            font-size: 12px;
            cursor: pointer;
        }
        .log-container {
            height: 150px;
            overflow-y: auto;
            font-family: 'Monaco', monospace;
            font-size: 12px;
        }
        .log-line { padding: 3px 0; color: #888; }
        .log-line.info { color: #4fc3f7; }
        .log-line.success { color: #81c784; }
        .log-line.warning { color: #ffb74d; }
        .log-line.error { color: #ff6b6b; }
        .log-line.motor { color: #ce93d8; }
        
        .toast {
            position: fixed;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.9);
            color: #fff;
            padding: 12px 24px;
            border-radius: 25px;
            font-size: 14px;
            z-index: 1000;
            opacity: 0;
            transition: opacity 0.3s;
        }
        .toast.show { opacity: 1; }
        
        .lang-toggle {
            display: flex;
            gap: 8px;
            justify-content: center;
            margin-bottom: 15px;
        }
        .lang-btn {
            padding: 6px 14px;
            border: 1px solid rgba(255,255,255,0.2);
            background: transparent;
            color: #888;
            border-radius: 15px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.3s;
        }
        .lang-btn.active { background: #667eea; color: #fff; border-color: #667eea; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 id="title">翻页机械臂控制</h1>
        </div>
        
        <div class="lang-toggle">
            <button class="lang-btn active" id="langZh" onclick="setLang('zh')">中文</button>
            <button class="lang-btn" id="langEn" onclick="setLang('en')">English</button>
        </div>
        
        <div class="connection-card">
            <div class="conn-title" id="connTitle">设备连接</div>
            <div class="conn-devices">
                <div class="device-btn" id="garyBtn" onclick="toggleGary()">
                    <div class="device-icon">🤖</div>
                    <div class="device-name">Gary Hub</div>
                    <div class="device-status" id="garyStatus">未连接</div>
                </div>
                <div class="device-btn" id="hc02Btn" onclick="toggleHC02()">
                    <div class="device-icon">📡</div>
                    <div class="device-name">HC-02</div>
                    <div class="device-status" id="hc02Status">未连接</div>
                </div>
            </div>
        </div>
        
        <div class="phase-progress">
            <div class="phase-bar">
                <div class="phase-fill" id="phaseFill"></div>
            </div>
            <div class="phase-text" id="phaseText">待机</div>
        </div>
        
        <div class="action-buttons" id="actionBtns">
            <button class="btn btn-secondary" id="initBtn" onclick="setInit()" disabled>
                <span>📍</span> <span id="initLabel">起始点</span>
            </button>
            <button class="btn btn-secondary" id="finalBtn" onclick="setFinal()" disabled>
                <span>🏁</span> <span id="finalLabel">终点</span>
            </button>
            <button class="btn btn-primary" id="pageBtn" onclick="startPage()" disabled>
                <span>📖</span> <span id="pageLabel">翻页</span>
            </button>
        </div>
        
        <div class="mcp-card">
            <div class="mcp-header">
                <span class="mcp-title" id="serverTitle">服务器连接</span>
                <span class="mcp-status" id="serverStatus">未连接</span>
            </div>
            <div class="mcp-actions">
                <button class="btn btn-server" id="serverBtn" onclick="toggleServer()">
                    <span>🔗</span> <span id="serverBtnText">连接服务器</span>
                </button>
                <button class="btn btn-server" id="aiBtn" onclick="toggleAI()">
                    <span>🤖</span> <span id="aiBtnText">AI 控制</span>
                </button>
            </div>
        </div>
        
        <div class="motor-card">
            <div class="motor-header">
                <span class="motor-title" id="motorTitle">电机转速</span>
                <span class="motor-value" id="motorValue">0</span>
            </div>
            <input type="range" class="motor-slider" id="motorSlider" min="0" max="255" value="0" oninput="updateMotor()">
        </div>
        
        <div class="position-card">
            <div class="pos-row">
                <span class="pos-label" id="startLabel">起始点</span>
                <span class="pos-value empty" id="startPos">未设置</span>
            </div>
            <div class="pos-row">
                <span class="pos-label" id="endLabel">终点</span>
                <span class="pos-value empty" id="endPos">未设置</span>
            </div>
        </div>
        
        <div class="log-card">
            <div class="log-header">
                <span class="log-title" id="logLabel">日志</span>
                <button class="log-clear" onclick="clearLog()">清除</button>
            </div>
            <div class="log-container" id="logContainer"></div>
        </div>
    </div>
    
    <div class="toast" id="toast"></div>

    <script>
        // Pybricks Bluetooth UUIDs
        const PYBRICKS_SERVICE_UUID = 'c5f50001-8280-46da-89f4-6d8051e4aeef';
        const PYBRICKS_COMMAND_CHAR_UUID = 'c5f50002-8280-46da-89f4-6d8051e4aeef';
        
        // HC-02 BLE UUIDs
        const UART_SERVICE_UUID = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
        const HC02_TX_CHAR_UUID = '49535343-1e4d-4bd9-ba61-23c647249616';
        const HC02_RX_CHAR_UUID = '49535343-8841-43f4-a8d4-ecbe34729bb3';
        
        let lang = 'zh';
        let garyDevice = null, garyServer = null, garyCharacteristic = null, garyConnected = false;
        let hc02Device = null, hc02Server = null, hc02RxChar = null, hc02Connected = false;
        let pendingCmd = null;
        let initFlag = null, finalFlag = null;
        let dataBuffer = '';
        let motorSpeed = 0;
        let pageRunning = false;
        let currentPhase = 0;
        let rdyReady = false;
        let pendingStatCmd = null;
        
        // SSE 服务器连接
        let eventSource = null;
        let serverConnected = false;
        
        // MCP AI 控制
        let mcpWs = null;
        let mcpConnected = false;
        
        const i18n = {
            zh: {
                title: '翻页机械臂控制',
                connTitle: '设备连接',
                initLabel: '起始点',
                finalLabel: '终点',
                pageLabel: '翻页',
                motorTitle: '电机转速',
                startLabel: '起始点',
                endLabel: '终点',
                logLabel: '日志',
                serverTitle: '服务器连接',
                notSet: '未设置',
                connected: '已连接',
                disconnected: '未连接',
                connecting: '连接中...',
                toastConnected: '设备连接成功',
                toastDisconnected: '已断开连接',
                toastSetInit: '起始点已设置',
                toastSetFinal: '终点已设置',
                toastNeedBoth: '请先设置起始点和终点',
                toastStartFirst: '请先连接设备',
                toastPageDone: '翻页完成',
                btnConnectServer: '连接服务器',
                btnDisconnectServer: '断开服务器',
                btnAI: 'AI 控制'
            },
            en: {
                title: 'Page Turner Control',
                connTitle: 'Device Connection',
                initLabel: 'Start',
                finalLabel: 'End',
                pageLabel: 'Turn Page',
                motorTitle: 'Motor Speed',
                startLabel: 'Start Point',
                endLabel: 'End Point',
                logLabel: 'Log',
                serverTitle: 'Server Connection',
                notSet: 'Not Set',
                connected: 'Connected',
                disconnected: 'Disconnected',
                connecting: 'Connecting...',
                toastConnected: 'Devices connected',
                toastDisconnected: 'Disconnected',
                toastSetInit: 'Start point set',
                toastSetFinal: 'End point set',
                toastNeedBoth: 'Set start and end points first',
                toastStartFirst: 'Connect devices first',
                toastPageDone: 'Page turned',
                btnConnectServer: 'Connect Server',
                btnDisconnectServer: 'Disconnect',
                btnAI: 'AI Control'
            }
        };
        
        function setLang(l) {
            lang = l;
            document.getElementById('langZh').classList.toggle('active', l === 'zh');
            document.getElementById('langEn').classList.toggle('active', l === 'en');
            updateUI();
        }
        
        function updateUI() {
            const t = i18n[lang];
            document.getElementById('title').textContent = t.title;
            document.getElementById('connTitle').textContent = t.connTitle;
            document.getElementById('initLabel').textContent = t.initLabel;
            document.getElementById('finalLabel').textContent = t.finalLabel;
            document.getElementById('pageLabel').textContent = t.pageLabel;
            document.getElementById('motorTitle').textContent = t.motorTitle;
            document.getElementById('startLabel').textContent = t.startLabel;
            document.getElementById('endLabel').textContent = t.endLabel;
            document.getElementById('logLabel').textContent = t.logLabel;
            document.getElementById('serverTitle').textContent = t.serverTitle;
            
            document.getElementById('garyStatus').textContent = garyConnected ? t.connected : t.disconnected;
            document.getElementById('hc02Status').textContent = hc02Connected ? t.connected : t.disconnected;
            document.getElementById('garyBtn').classList.toggle('connected', garyConnected);
            document.getElementById('hc02Btn').classList.toggle('connected', hc02Connected);
            
            document.getElementById('startPos').textContent = initFlag ? JSON.stringify(initFlag) : t.notSet;
            document.getElementById('startPos').classList.toggle('empty', !initFlag);
            document.getElementById('endPos').textContent = finalFlag ? JSON.stringify(finalFlag) : t.notSet;
            document.getElementById('endPos').classList.toggle('empty', !finalFlag);
            
            document.getElementById('serverStatus').textContent = serverConnected ? t.connected : t.disconnected;
            document.getElementById('serverStatus').classList.toggle('connected', serverConnected);
            document.getElementById('serverBtn').classList.toggle('connected', serverConnected);
            document.getElementById('serverBtnText').textContent = serverConnected ? t.btnDisconnectServer : t.btnConnectServer;
            
            const canControl = garyConnected;
            const bothSet = initFlag && finalFlag;
            
            document.getElementById('actionBtns').classList.toggle('collapsed', bothSet);
            document.getElementById('initBtn').disabled = !canControl || bothSet;
            document.getElementById('finalBtn').disabled = !canControl || bothSet;
            document.getElementById('pageBtn').disabled = !canControl || !initFlag || !finalFlag;
            
            document.getElementById('pageBtn').classList.toggle('running', pageRunning);
        }
        
        function showToast(msg) {
            const toast = document.getElementById('toast');
            toast.textContent = msg;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2000);
        }
        
        function addLog(msg, level = 'info') {
            const lc = document.getElementById('logContainer');
            const line = document.createElement('div');
            line.className = 'log-line ' + level;
            line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
            lc.appendChild(line);
            lc.scrollTop = lc.scrollHeight;
        }
        
        function clearLog() {
            document.getElementById('logContainer').innerHTML = '';
        }
        
        function updateMotor() {
            motorSpeed = parseInt(document.getElementById('motorSlider').value);
            document.getElementById('motorValue').textContent = motorSpeed;
        }
        
        // ========== 服务器 SSE 连接 ==========
        
        function toggleServer() {
            if (serverConnected) {
                disconnectServer();
            } else {
                connectServer();
            }
        }
        
        function connectServer() {
            eventSource = new EventSource('/events');
            eventSource.onopen = () => {
                serverConnected = true;
                addLog('服务器已连接', 'success');
                updateUI();
            };
            eventSource.onmessage = e => {
                const msg = JSON.parse(e.data);
                if (msg.type === 'command' && msg.action === 'page_turn') {
                    addLog('收到 AI 翻页指令', 'info');
                    startPage();
                } else if (msg.type === 'log') {
                    addLog(msg.message, 'info');
                }
            };
            eventSource.onerror = () => {
                serverConnected = false;
                addLog('服务器断开', 'warning');
                updateUI();
                eventSource.close();
            };
        }
        
        function disconnectServer() {
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            serverConnected = false;
            updateUI();
        }
        
        async function notifyServer(type, data) {
            if (!serverConnected) return;
            try {
                await fetch('/command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type, ...data })
                });
            } catch (e) {}
        }
        
        // ========== AI MCP 连接 ==========
        
        function toggleAI() {
            if (mcpConnected) {
                disconnectMCP();
            } else {
                connectMCP();
            }
        }
        
        function connectMCP() {
            // 连接 Worker 自身的 MCP 端点作为示例
            const endpoint = 'wss://' + location.host + '/mcp';
            addLog('连接 AI MCP...', 'info');
            
            try {
                mcpWs = new WebSocket(endpoint);
                
                mcpWs.onopen = () => {
                    addLog('MCP 连接已建立，等待初始化...', 'info');
                    mcpWs.send(JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'initialize',
                        params: {
                            protocolVersion: '2024-11-05',
                            capabilities: { tools: {} },
                            clientInfo: { name: 'page-turner-ui', version: '1.0.0' }
                        }
                    }));
                };
                
                mcpWs.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        
                        if (msg.method === 'ping') {
                            mcpWs.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
                            return;
                        }
                        
                        if (msg.id === 1 && msg.result) {
                            mcpConnected = true;
                            addLog('AI MCP 初始化完成', 'success');
                            document.getElementById('aiBtn').classList.add('connected');
                            document.getElementById('aiBtnText').textContent = 'AI 已连接';
                            mcpWs.send(JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'notifications/initialized'
                            }));
                            return;
                        }
                        
                        if (msg.method === 'tools/call' && msg.params) {
                            const toolName = msg.params.name;
                            addLog('收到工具调用: ' + toolName, 'info');
                            
                            if (toolName === 'page_turn') {
                                startPage();
                                mcpWs.send(JSON.stringify({
                                    jsonrpc: '2.0',
                                    id: msg.id,
                                    result: { content: [{ type: 'text', text: '翻页开始' }] }
                                }));
                            }
                            return;
                        }
                        
                    } catch (e) {
                        addLog('MCP 解析错误: ' + e.message, 'error');
                    }
                };
                
                mcpWs.onerror = () => {
                    addLog('MCP 连接错误', 'error');
                };
                
                mcpWs.onclose = () => {
                    mcpConnected = false;
                    document.getElementById('aiBtn').classList.remove('connected');
                    document.getElementById('aiBtnText').textContent = i18n[lang].btnAI;
                };
            } catch (e) {
                addLog('MCP 连接失败: ' + e.message, 'error');
            }
        }
        
        function disconnectMCP() {
            if (mcpWs) {
                mcpWs.close();
                mcpWs = null;
            }
            mcpConnected = false;
            updateUI();
        }
        
        // ========== 蓝牙设备连接 ==========
        
        async function toggleGary() {
            if (garyConnected) {
                if (garyDevice) garyDevice.gatt.disconnect();
            } else {
                await connectGary();
            }
            updateUI();
        }
        
        async function toggleHC02() {
            if (hc02Connected) {
                if (hc02Device) hc02Device.gatt.disconnect();
            } else {
                await connectHC02();
            }
            updateUI();
        }
        
        async function connectGary() {
            try {
                dataBuffer = '';
                addLog('正在搜索 Gary Hub...', 'info');
                garyDevice = await navigator.bluetooth.requestDevice({
                    filters: [{ namePrefix: 'Gary' }],
                    optionalServices: [PYBRICKS_SERVICE_UUID]
                });
                addLog('发现: ' + garyDevice.name, 'success');
                garyDevice.addEventListener('gattserverdisconnected', () => {
                    garyConnected = false;
                    rdyReady = false;
                    pendingStatCmd = null;
                    updateUI();
                    addLog('Gary 已断开', 'warning');
                });
                garyServer = await garyDevice.gatt.connect();
                const service = await garyServer.getPrimaryService(PYBRICKS_SERVICE_UUID);
                garyCharacteristic = await service.getCharacteristic(PYBRICKS_COMMAND_CHAR_UUID);
                await garyCharacteristic.startNotifications();
                garyCharacteristic.addEventListener('characteristicvaluechanged', onGaryData);
                garyConnected = true;
                rdyReady = false;
                pendingStatCmd = 'stat';
                showToast(i18n[lang].toastConnected);
                addLog('Gary 已连接!', 'success');
            } catch (e) {
                addLog('Gary 错误: ' + e.message, 'error');
            }
        }
        
        async function connectHC02() {
            try {
                addLog('正在搜索 HC-02...', 'info');
                hc02Device = await navigator.bluetooth.requestDevice({
                    filters: [{ namePrefix: '=ATTiny85-Motor' }],
                    optionalServices: [UART_SERVICE_UUID]
                });
                addLog('发现: ' + hc02Device.name, 'success');
                hc02Device.addEventListener('gattserverdisconnected', () => {
                    hc02Connected = false;
                    updateUI();
                    addLog('HC-02 已断开', 'warning');
                });
                hc02Server = await hc02Device.gatt.connect();
                const service = await hc02Server.getPrimaryService(UART_SERVICE_UUID);
                const chars = await service.getCharacteristics();
                for (const c of chars) {
                    if (c.uuid === HC02_RX_CHAR_UUID) hc02RxChar = c;
                    if (c.uuid === HC02_TX_CHAR_UUID) {
                        await c.startNotifications();
                        c.addEventListener('characteristicvaluechanged', e => {
                            const text = new TextDecoder().decode(e.target.value);
                            addLog('HC-02: ' + text.trim(), 'motor');
                        });
                    }
                }
                hc02Connected = true;
                updateUI();
                addLog('HC-02 已连接!', 'success');
            } catch (e) {
                addLog('HC-02 错误: ' + e.message, 'error');
            }
        }
        
        function onGaryData(event) {
            const data = new Uint8Array(event.target.value.buffer);
            if (data[0] !== 0x01) return;
            const text = new TextDecoder().decode(data.slice(1));
            dataBuffer += text;
            const lines = dataBuffer.split('\\n');
            dataBuffer = lines.pop();
            for (const line of lines) {
                const msg = line.trim();
                if (msg) {
                    addLog(msg);
                    parseData(msg);
                    updatePhase(msg);
                    if (msg.includes('Waiting for input')) {
                        rdyReady = true;
                        if (pendingStatCmd) {
                            const cmd = pendingStatCmd;
                            pendingStatCmd = null;
                            sendGaryCmdDirect(cmd);
                        }
                    }
                }
            }
        }
        
        function parseData(text) {
            if (text.includes('The program was stopped') || text.includes('SystemExit') || text.includes('Auto-start')) {
                pageRunning = false;
                updateUI();
                pendingStatCmd = 'stat';
                return;
            }
            
            if (text.startsWith('initFlag:')) {
                const val = text.replace('initFlag:', '').trim();
                if (val !== 'None' && val !== 'False') {
                    try { initFlag = JSON.parse(val); } catch(e) { initFlag = null; }
                } else { initFlag = null; }
                updateUI();
            } else if (text.startsWith('finFlag:')) {
                const val = text.replace('finFlag:', '').trim();
                if (val !== 'None' && val !== 'False') {
                    try { finalFlag = JSON.parse(val); } catch(e) { finalFlag = null; }
                } else { finalFlag = null; }
                updateUI();
            } else if (text.startsWith('[')) {
                try {
                    const arr = JSON.parse(text);
                    if (Array.isArray(arr) && arr.length === 3) {
                        if (pendingCmd === 'init') {
                            initFlag = arr;
                            showToast(i18n[lang].toastSetInit);
                            pendingCmd = null;
                        } else if (pendingCmd === 'final') {
                            finalFlag = arr;
                            showToast(i18n[lang].toastSetFinal);
                            pendingCmd = null;
                        }
                        updateUI();
                    }
                } catch(e) {}
            }
        }
        
        function updatePhase(text) {
            const phase = text.match(/Phase\\s*(\\d+)/);
            if (phase) {
                currentPhase = parseInt(phase[1]);
                document.getElementById('phaseFill').style.width = (currentPhase / 7 * 100) + '%';
                document.getElementById('phaseText').textContent = text;
                
                if (currentPhase === 3 && pageRunning && motorSpeed > 0) {
                    sendToHC02('S' + motorSpeed);
                    addLog('电机启动', 'motor');
                }
                if (currentPhase === 7) {
                    sendToHC02('S0');
                    addLog('电机停止', 'motor');
                    pageRunning = false;
                    updateUI();
                    showToast(i18n[lang].toastPageDone);
                    notifyServer('result', { result: { success: true } });
                }
            }
        }
        
        async function sendToHC02(cmd) {
            if (!hc02Connected || !hc02RxChar) return;
            try {
                const enc = new TextEncoder();
                await hc02RxChar.writeValue(enc.encode(cmd + '\\n'));
            } catch (e) {
                addLog('HC-02 错误: ' + e.message, 'error');
            }
        }
        
        async function setInit() {
            if (!garyConnected) { showToast(i18n[lang].toastStartFirst); return; }
            pendingCmd = 'init';
            await sendGaryCmd('init');
        }
        
        async function setFinal() {
            if (!garyConnected) { showToast(i18n[lang].toastStartFirst); return; }
            pendingCmd = 'final';
            await sendGaryCmd('fina');
        }
        
        async function startPage() {
            if (!garyConnected) { showToast(i18n[lang].toastStartFirst); return; }
            if (!initFlag || !finalFlag) { showToast(i18n[lang].toastNeedBoth); return; }
            pageRunning = true;
            updateUI();
            addLog('开始翻页...', 'success');
            await sendGaryCmd('move');
        }
        
        async function sendGaryCmdDirect(cmd) {
            if (!garyCharacteristic) return;
            try {
                const enc = new TextEncoder();
                let bytes = enc.encode(cmd);
                if (bytes.length < 4) {
                    const padded = new Uint8Array(4);
                    padded.set(bytes);
                    bytes = padded;
                }
                const packet = new Uint8Array(5);
                packet[0] = 0x06;
                packet.set(bytes, 1);
                await garyCharacteristic.writeValue(packet);
                addLog('发送: ' + cmd, 'success');
            } catch (e) {
                addLog('错误: ' + e.message, 'error');
            }
        }
        
        async function sendGaryCmd(cmd) {
            if (!garyConnected) return;
            if (rdyReady) {
                await sendGaryCmdDirect(cmd);
            } else {
                pendingStatCmd = cmd;
            }
        }
        
        // ========== 初始化 ==========
        
        if (!navigator.bluetooth) {
            addLog('浏览器不支持蓝牙!', 'error');
        } else {
            addLog('准备就绪，请连接设备。');
        }
        updateUI();
    </script>
</body>
</html>`;
}
