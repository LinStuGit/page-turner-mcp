/**
 * Cloudflare Worker - MCP翻页服务器
 * 
 * 架构：
 * AI (MCP客户端) → Worker (MCP服务器) → 网页 (BLE客户端)
 * 
 * 部署：wrangler deploy
 */

// Durable Object 类 - 用于管理WebSocket连接
export class ControlRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.aiSocket = null;
    this.controlSocket = null;
    this.pendingResolver = null;
    
    // 从持久化存储恢复连接
    state.waitUntil(this.loadState());
  }
  
  async loadState() {
    const data = await this.state.storage.get('connections');
    if (data) {
      this.aiSocket = data.aiSocket || null;
      this.controlSocket = data.controlSocket || null;
    }
  }
  
  async saveState() {
    await this.state.storage.put('connections', {
      aiSocket: this.aiSocket ? true : false,
      controlSocket: this.controlSocket ? true : false
    });
  }
  
  // 处理 AI 客户端连接
  async handleAIClient(request) {
    const pair = new WebSocketPair();
    this.aiSocket = pair.server;
    this.aiSocket.accept();
    
    this.aiSocket.addEventListener('message', async (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        // 初始化
        if (msg.method === 'initialize') {
          await this.aiSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'page-turner', version: '1.0.0' }
            }
          }));
          await this.aiSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }));
          this.notifyControl({ type: 'log', message: 'AI已连接' });
          return;
        }
        
        // Ping
        if (msg.method === 'ping') {
          await this.aiSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {}
          }));
          return;
        }
        
        // 工具列表
        if (msg.method === 'tools/list') {
          await this.aiSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [{
                name: 'page_turn',
                description: '执行翻页动作',
                inputSchema: { type: 'object', properties: {}, required: [] }
              }]
            }
          }));
          return;
        }
        
        // 工具调用
        if (msg.method === 'tools/call' && msg.params) {
          const toolName = msg.params.name;
          
          if (toolName === 'page_turn') {
            if (!this.controlSocket) {
              await this.aiSocket.send(JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32603, message: 'No control client connected' }
              }));
              return;
            }
            
            // 通知网页执行翻页
            this.controlSocket.send(JSON.stringify({
              type: 'command',
              action: 'page_turn'
            }));
            
            // 等待结果
            const result = await this.waitForResult(10000);
            
            await this.aiSocket.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: JSON.stringify(result) }] }
            }));
          } else {
            await this.aiSocket.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32601, message: `Unknown tool: ${toolName}` }
            }));
          }
        }
      } catch (e) {
        console.error('AI message error:', e);
      }
    });
    
    this.aiSocket.addEventListener('close', () => {
      this.aiSocket = null;
      this.notifyControl({ type: 'log', message: 'AI已断开' });
    });
    
    return new Response(null, { status: 101, webSocket: pair });
  }
  
  // 处理控制客户端连接
  async handleControlClient(request) {
    const pair = new WebSocketPair();
    this.controlSocket = pair.server;
    this.controlSocket.accept();
    
    this.controlSocket.addEventListener('message', async (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'result' && this.pendingResolver) {
          this.pendingResolver(msg.result);
          this.pendingResolver = null;
        }
        
        if (msg.type === 'log' && this.aiSocket) {
          // 转发日志到AI
          this.aiSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'log',
            params: { message: msg.message }
          }));
        }
      } catch (e) {
        console.error('Control message error:', e);
      }
    });
    
    this.controlSocket.addEventListener('close', () => {
      this.controlSocket = null;
    });
    
    return new Response(null, { status: 101, webSocket: pair });
  }
  
  notifyControl(msg) {
    if (this.controlSocket) {
      this.controlSocket.send(JSON.stringify(msg));
    }
  }
  
  waitForResult(timeout) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResolver = null;
        resolve({ success: true, message: 'timeout' });
      }, timeout);
      
      this.pendingResolver = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
  }
}

// Worker 主入口
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 获取或创建 Durable Object
    const roomId = env.CONTROL_ROOM.idFromName('main');
    const room = env.CONTROL_ROOM.get(roomId);
    
    // MCP 端点
    if (url.pathname === '/mcp') {
      return room.handleAIClient(request);
    }
    
    // 控制端点
    if (url.pathname === '/control') {
      return room.handleControlClient(request);
    }
    
    // 主页
    if (url.pathname === '/') {
      return new Response(await fetchStaticHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

// 内嵌的HTML页面
async function fetchStaticHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>翻页机械臂控制</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            padding: 15px;
            color: #fff;
        }
        .container { max-width: 480px; margin: 0 auto; }
        .header { text-align: center; padding: 20px 0; }
        .header h1 {
            font-size: 22px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .card {
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            padding: 20px;
            margin-bottom: 15px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .card-title {
            font-size: 12px;
            color: #888;
            margin-bottom: 15px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .btn {
            width: 100%;
            padding: 15px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .btn:last-child { margin-bottom: 0; }
        .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
        }
        .btn-primary:hover { opacity: 0.9; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-secondary {
            background: rgba(255,255,255,0.1);
            color: #fff;
        }
        .btn-secondary:hover { background: rgba(255,255,255,0.2); }
        .status { font-size: 14px; }
        .status.connected { color: #28a745; }
        .status.disconnected { color: #888; }
        .log-container {
            max-height: 200px;
            overflow-y: auto;
            background: rgba(0,0,0,0.3);
            border-radius: 8px;
            padding: 10px;
            font-family: monospace;
            font-size: 12px;
        }
        .log-line { padding: 2px 0; }
        .log-line.info { color: #888; }
        .log-line.success { color: #28a745; }
        .log-line.error { color: #dc3545; }
        .mcp-url {
            background: rgba(0,0,0,0.3);
            padding: 8px 12px;
            border-radius: 6px;
            font-family: monospace;
            font-size: 12px;
            margin-top: 10px;
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header"><h1>翻页机械臂控制</h1></div>
        
        <div class="card">
            <div class="card-title">设备连接</div>
            <button class="btn btn-secondary" id="garyBtn" onclick="toggleGary()">
                <span>🔵 Gary Hub</span>
                <span id="garyStatus" class="status disconnected">未连接</span>
            </button>
            <button class="btn btn-secondary" id="hc02Btn" onclick="toggleHC02()">
                <span>🔧 HC-02 电机</span>
                <span id="hc02Status" class="status disconnected">未连接</span>
            </button>
        </div>
        
        <div class="card">
            <div class="card-title">操作</div>
            <button class="btn btn-primary" id="pageBtn" onclick="triggerPageTurn()" disabled>
                <span>📖 执行翻页</span>
            </button>
        </div>
        
        <div class="card">
            <div class="card-title">MCP 服务器</div>
            <div class="mcp-url" id="mcpUrl">连接中...</div>
        </div>
        
        <div class="card">
            <div class="card-title">日志</div>
            <div class="log-container" id="logContainer"></div>
        </div>
    </div>

    <script>
        const PYBRICKS_SERVICE = 'c5f50001-8280-46da-89f4-6d8051e4aeef';
        const PYBRICKS_CHAR = 'c5f50002-8280-46da-89f4-6d8051e4aeef';
        const UART_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
        const HC02_RX = '49535343-8841-43f4-a8d4-ecbe34729bb3';
        
        let garyDevice, garyChar, garyConnected = false;
        let hc02Device, hc02Rx, hc02Connected = false;
        let controlWs = null;
        
        function getBase() {
            return location.protocol === 'https:' ? 'wss://' : 'ws://' + location.host;
        }
        
        function addLog(msg, level = 'info') {
            const lc = document.getElementById('logContainer');
            const el = document.createElement('div');
            el.className = 'log-line ' + level;
            el.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
            lc.appendChild(el);
            lc.scrollTop = lc.scrollHeight;
        }
        
        function updateUI() {
            document.getElementById('garyStatus').textContent = garyConnected ? '已连接' : '未连接';
            document.getElementById('garyStatus').className = 'status ' + (garyConnected ? 'connected' : 'disconnected');
            document.getElementById('hc02Status').textContent = hc02Connected ? '已连接' : '未连接';
            document.getElementById('hc02Status').className = 'status ' + (hc02Connected ? 'connected' : 'disconnected');
            document.getElementById('pageBtn').disabled = !(garyConnected && hc02Connected);
            document.getElementById('mcpUrl').textContent = getBase() + '/mcp';
        }
        
        async function toggleGary() {
            if (garyConnected) { garyDevice.gatt.disconnect(); }
            else { await connectGary(); }
            updateUI();
        }
        
        async function toggleHC02() {
            if (hc02Connected) { hc02Device.gatt.disconnect(); }
            else { await connectHC02(); }
            updateUI();
        }
        
        async function connectGary() {
            try {
                addLog('连接 Gary Hub...');
                garyDevice = await navigator.bluetooth.requestDevice({
                    filters: [{ namePrefix: 'Gary' }],
                    optionalServices: [PYBRICKS_SERVICE]
                });
                garyDevice.addEventListener('gattserverdisconnected', () => {
                    garyConnected = false;
                    updateUI();
                    addLog('Gary 断开', 'error');
                });
                const server = await garyDevice.gatt.connect();
                const service = await server.getPrimaryService(PYBRICKS_SERVICE);
                garyChar = await service.getCharacteristic(PYBRICKS_CHAR);
                garyConnected = true;
                addLog('Gary 已连接', 'success');
            } catch (e) { addLog('连接失败: ' + e.message, 'error'); }
        }
        
        async function connectHC02() {
            try {
                addLog('连接 HC-02...');
                hc02Device = await navigator.bluetooth.requestDevice({
                    filters: [{ namePrefix: '=ATTiny85-Motor' }],
                    optionalServices: [UART_SERVICE]
                });
                hc02Device.addEventListener('gattserverdisconnected', () => {
                    hc02Connected = false;
                    updateUI();
                    addLog('HC-02 断开', 'error');
                });
                const server = await hc02Device.gatt.connect();
                const service = await server.getPrimaryService(UART_SERVICE);
                hc02Rx = await service.getCharacteristic(HC02_RX);
                hc02Connected = true;
                addLog('HC-02 已连接', 'success');
            } catch (e) { addLog('连接失败: ' + e.message, 'error'); }
        }
        
        async function sendCmd(cmd) {
            if (!garyChar) return;
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
            await garyChar.writeValue(packet);
        }
        
        async function triggerPageTurn() {
            if (!garyConnected || !hc02Connected) {
                addLog('请先连接设备', 'error');
                return;
            }
            addLog('执行翻页...');
            await sendCmd('goInit');
            setTimeout(async () => {
                await sendCmd('goFinal');
                addLog('翻页完成', 'success');
                if (controlWs) {
                    controlWs.send(JSON.stringify({ type: 'result', result: { success: true } }));
                }
            }, 1500);
        }
        
        function connectControl() {
            const wsUrl = getBase() + '/control';
            controlWs = new WebSocket(wsUrl);
            controlWs.onopen = () => addLog('已连接MCP服务器', 'success');
            controlWs.onmessage = async (e) => {
                const msg = JSON.parse(e.data);
                if (msg.type === 'log') addLog(msg.message);
                else if (msg.type === 'command' && msg.action === 'page_turn') {
                    addLog('收到AI翻页指令');
                    await triggerPageTurn();
                }
            };
            controlWs.onclose = () => {
                addLog('服务器断开，重连中...', 'error');
                setTimeout(connectControl, 5000);
            };
        }
        
        if (!navigator.bluetooth) addLog('浏览器不支持蓝牙', 'error');
        else { addLog('准备就绪'); connectControl(); }
        updateUI();
    </script>
</body>
</html>`;
}
