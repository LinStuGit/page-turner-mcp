/**
 * Cloudflare Worker - MCP翻页服务器
 * 
 * MCP接入点通过Cloudflare Secret配置
 * AI通过固定地址连接MCP服务器
 */

// Durable Object - 管理WebSocket连接
export class ControlRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.aiSocket = null;
    this.controlSocket = null;
    this.pendingResolver = null;
  }

  // 处理AI客户端连接
  async handleAIClient(request) {
    const pair = new WebSocketPair();
    this.aiSocket = pair.server;
    this.aiSocket.accept();

    this.aiSocket.addEventListener('message', async (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.method === 'initialize') {
          await this.aiSocket.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'page-turner', version: '1.0.0' }
            }
          }));
          await this.aiSocket.send(JSON.stringify({
            jsonrpc: '2.0', method: 'notifications/initialized'
          }));
          this.notifyControl({ type: 'log', message: 'AI已连接' });
          return;
        }

        if (msg.method === 'ping') {
          await this.aiSocket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
          return;
        }

        if (msg.method === 'tools/list') {
          await this.aiSocket.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
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

        if (msg.method === 'tools/call' && msg.params) {
          const toolName = msg.params.name;

          if (toolName === 'page_turn') {
            if (!this.controlSocket) {
              await this.aiSocket.send(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                error: { code: -32603, message: 'No control client connected' }
              }));
              return;
            }

            this.controlSocket.send(JSON.stringify({ type: 'command', action: 'page_turn' }));
            const result = await this.waitForResult(10000);

            await this.aiSocket.send(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: JSON.stringify(result) }] }
            }));
          } else {
            await this.aiSocket.send(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
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

  // 处理控制客户端连接（网页）
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
          this.aiSocket.send(JSON.stringify({
            jsonrpc: '2.0', method: 'log', params: { message: msg.message }
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
    
    // Durable Objects
    const roomId = env.CONTROL_ROOM.idFromName('main');
    const room = env.CONTROL_ROOM.get(roomId);

    // MCP 端点 (AI固定连接)
    if (url.pathname === '/mcp') {
      return room.handleAIClient(request);
    }

    // 控制端点 (网页连接)
    if (url.pathname === '/control') {
      return room.handleControlClient(request);
    }

    // 主页
    if (url.pathname === '/') {
      return new Response(getControlPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// 简化版控制页面
function getControlPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>翻页机械臂控制</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            padding: 20px;
            color: #fff;
        }
        .container { max-width: 400px; margin: 0 auto; text-align: center; }
        h1 {
            font-size: 24px;
            margin-bottom: 30px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .btn {
            width: 100%;
            padding: 18px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            cursor: pointer;
            margin-bottom: 15px;
            transition: all 0.3s;
        }
        .btn-bt {
            background: rgba(255,255,255,0.1);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .btn-bt:hover { background: rgba(255,255,255,0.2); }
        .btn-bt:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-connect {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
        }
        .btn-connect:hover { opacity: 0.9; }
        .status {
            padding: 15px;
            background: rgba(255,255,255,0.05);
            border-radius: 12px;
            margin-bottom: 15px;
            font-size: 14px;
        }
        .status.connected { color: #28a745; }
        .status.disconnected { color: #888; }
        .log {
            height: 150px;
            overflow-y: auto;
            background: rgba(0,0,0,0.3);
            border-radius: 8px;
            padding: 10px;
            text-align: left;
            font-family: monospace;
            font-size: 12px;
        }
        .log div { padding: 2px 0; }
        .log .info { color: #888; }
        .log .success { color: #28a745; }
        .log .error { color: #dc3545; }
    </style>
</head>
<body>
    <div class="container">
        <h1>翻页机械臂</h1>
        
        <div id="statusConn" class="status disconnected">服务器: 未连接</div>
        
        <button class="btn btn-connect" id="connectBtn" onclick="connectServer()">
            连接服务器
        </button>
        
        <div id="deviceSection" style="display:none;">
            <button class="btn btn-bt" id="garyBtn" onclick="toggleGary()">
                🔵 Gary Hub: <span id="garyStatus">未连接</span>
            </button>
            <button class="btn btn-bt" id="hc02Btn" onclick="toggleHC02()">
                🔧 HC-02: <span id="hc02Status">未连接</span>
            </button>
        </div>
    </div>

    <script>
        const PYBRICKS_SVC = 'c5f50001-8280-46da-89f4-6d8051e4aeef';
        const PYBRICKS_CHAR = 'c5f50002-8280-46da-89f4-6d8051e4aeef';
        const UART_SVC = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
        const HC02_RX = '49535343-8841-43f4-a8d4-ecbe34729bb3';

        let ws = null, garyDev, garyChar, garyOn = false;
        let hc02Dev, hc02Rx, hc02On = false;

        function log(msg, type = 'info') {
            const el = document.getElementById('statusConn');
            el.textContent = msg;
            el.className = 'status ' + (type === 'success' ? 'connected' : type === 'error' ? 'disconnected' : 'disconnected');
        }

        function connectServer() {
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(proto + '//' + location.host + '/control');
            ws.onopen = () => {
                log('服务器: 已连接', 'success');
                document.getElementById('connectBtn').textContent = '已连接';
                document.getElementById('connectBtn').disabled = true;
                document.getElementById('deviceSection').style.display = 'block';
            };
            ws.onmessage = e => {
                const msg = JSON.parse(e.data);
                if (msg.type === 'log') addLog(msg.message);
                else if (msg.type === 'command' && msg.action === 'page_turn') {
                    addLog('收到AI翻页指令');
                    pageTurn();
                }
            };
            ws.onclose = () => {
                log('服务器: 断开', 'error');
                document.getElementById('connectBtn').disabled = false;
                document.getElementById('connectBtn').textContent = '重新连接';
            };
        }

        function addLog(msg) {
            const el = document.getElementById('statusConn');
            const prev = el.textContent;
            el.textContent = msg;
            el.className = 'status ' + (msg.includes('完成') ? 'connected' : 'disconnected');
        }

        async function toggleGary() {
            if (garyOn) { garyDev.gatt.disconnect(); return; }
            try {
                garyDev = await navigator.bluetooth.requestDevice({
                    filters: [{ namePrefix: 'Gary' }], optionalServices: [PYBRICKS_SVC]
                });
                garyDev.addEventListener('gattserverdisconnected', () => {
                    garyOn = false;
                    document.getElementById('garyStatus').textContent = '未连接';
                });
                const svc = await garyDev.gatt.connect().getPrimaryService(PYBRICKS_SVC);
                garyChar = await svc.getCharacteristic(PYBRICKS_CHAR);
                garyOn = true;
                document.getElementById('garyStatus').textContent = '已连接';
            } catch (e) { addLog('Gary: ' + e.message, 'error'); }
        }

        async function toggleHC02() {
            if (hc02On) { hc02Dev.gatt.disconnect(); return; }
            try {
                hc02Dev = await navigator.bluetooth.requestDevice({
                    filters: [{ namePrefix: '=ATTiny85-Motor' }], optionalServices: [UART_SVC]
                });
                hc02Dev.addEventListener('gattserverdisconnected', () => {
                    hc02On = false;
                    document.getElementById('hc02Status').textContent = '未连接';
                });
                const svc = await hc02Dev.gatt.connect().getPrimaryService(UART_SVC);
                hc02Rx = await svc.getCharacteristic(HC02_RX);
                hc02On = true;
                document.getElementById('hc02Status').textContent = '已连接';
            } catch (e) { addLog('HC-02: ' + e.message, 'error'); }
        }

        async function sendCmd(cmd) {
            if (!garyChar) return;
            const enc = new TextEncoder();
            let bytes = enc.encode(cmd);
            if (bytes.length < 4) { const p = new Uint8Array(4); p.set(bytes); bytes = p; }
            const pkt = new Uint8Array(5);
            pkt[0] = 0x06;
            pkt.set(bytes, 1);
            await garyChar.writeValue(pkt);
        }

        async function pageTurn() {
            if (!garyOn || !hc02On) { addLog('请先连接设备', 'error'); return; }
            await sendCmd('goInit');
            setTimeout(async () => {
                await sendCmd('goFinal');
                addLog('翻页完成', 'success');
                if (ws) ws.send(JSON.stringify({ type: 'result', result: { success: true } }));
            }, 1500);
        }

        if (!navigator.bluetooth) log('浏览器不支持蓝牙', 'error');
        else log('准备就绪');
    </script>
</body>
</html>`;
}
