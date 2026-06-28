const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const https = require('https'); // 【新增】用于代理引擎发起底层 HTTPS 请求

// ==========================================
// 读取环境变量，实现配置与代码分离！
// ==========================================
const WEB_PORT = process.env.WEB_PORT || 3200;
const TUNNEL_PORT = process.env.TUNNEL_PORT || 3100;
const PROXY_PORT = process.env.PROXY_PORT || 3300; // 【新增】代理服务端口

// ==========================================
// 实例化两大服务引擎
// ==========================================
const app = express();           // 负责 3200 Web 端口
const proxyApp = express();      // 负责 3300 代理端口

const server = http.createServer(app);
const io = new Server(server);
let isDeviceReady = false;

// ==========================================
// 【引擎 1】Node.js 动态管理 socat 透传 (端口 3100)
// ==========================================
let socatProcess = null;

function startSocat() {
    if (socatProcess) {
        try { socatProcess.kill(); } catch (e) {}
    }
    console.log(`🔗 正在建立全新的 socat 隧道 (监听端口: ${TUNNEL_PORT})，等待设备接入...`);
    
    socatProcess = spawn('socat', ['pty,link=/dev/ttyV0,raw,echo=0', `tcp-listen:${TUNNEL_PORT},reuseaddr`]);

    socatProcess.stdout.on('data', (data) => console.log(`[socat] ${data}`));
    socatProcess.stderr.on('data', (data) => console.error(`[socat ERROR] ${data}`));

    // 监听死亡事件，自动重生
    socatProcess.on('close', (code) => {
        console.log(`⚠️ socat 隧道已释放 (退出码: ${code})，1秒后准备迎接下一次连接...`);
        setTimeout(startSocat, 1000); 
    });
}
startSocat();

process.on('SIGINT', () => {
    if (socatProcess) socatProcess.kill();
    process.exit();
});

// ==========================================
// 【引擎 2】云端 Web 控制台与 API (端口 3200)
// ==========================================
app.use(express.static('public'));

app.get('/api/device_ready', (req, res) => {
    console.log('🔗 收到底层信号：ESP32 设备已就绪！');
    isDeviceReady = true; 
    io.emit('device_ready', 'ESP32_READY');
    res.status(200).send('OK');
});

app.get('/api/device_disconnect', (req, res) => {
    console.log('🔗 收到底层信号：ESP32 设备已断开！');
    isDeviceReady = false; 
    io.emit('device_disconnected'); 
    if (socatProcess) socatProcess.kill();
    res.status(200).send('OK');
});

function getLpacArgs(cmdType, params = {}) {
    switch (cmdType) {
        case 'info': return ['chip', 'info'];
        case 'list': return ['profile', 'list'];
        case 'download': return ['profile', 'download', '-a', params.activationCode];
        case 'enable': return ['profile', 'enable', params.iccid];
        case 'disable': return ['profile', 'disable', params.iccid];
        case 'delete': return ['profile', 'delete', params.iccid];
        case 'setnickname': return ['profile', 'nickname', params.iccid, params.nickname];
        case 'notifprocess': return ['notification', 'process'];
        default: return [];
    }
}

io.on('connection', (socket) => {
    if (isDeviceReady) socket.emit('device_ready');
    
    socket.on('run_cmd', (payload) => {
        const cmdType = typeof payload === 'string' ? payload : payload.cmdType;
        const params = typeof payload === 'string' ? {} : (payload.params || {});

        if (cmdType === 'download') {
            socket.emit('log', '🚀 收到写卡请求，准备启动 lpac 引擎...\n');
            if (!params.activationCode || !params.activationCode.startsWith('LPA:1$')) {
                socket.emit('log', '❌ 激活码格式错误，必须以 LPA:1$ 开头\n');
                socket.emit('status', 'error');
                return;
            }
        }

        const args = getLpacArgs(cmdType, params);
        if (args.length === 0) {
            socket.emit('log', '❌ 未知的指令参数\n');
            return;
        }

        const lpacProcess = spawn(__dirname + '/lpac', args, {
            cwd: __dirname,
            env: {
                ...process.env,
                LPAC_APDU: 'at',                  // 【修复】：正确指定使用 AT 串口模式
                LPAC_APDU_AT_DEVICE: '/dev/ttyV0' // 【修复】：正确指定虚拟串口路径
            }
        });

        let lpacOutput = ''; 
        lpacProcess.stdout.on('data', (data) => { 
            lpacOutput += data.toString(); 
            socket.emit('log', data.toString()); 
        });
        lpacProcess.stderr.on('data', (data) => { socket.emit('log', '⚠️ ' + data.toString()); });

        lpacProcess.on('close', (code) => {
            if (code === 0) {
                if (cmdType === 'info' || cmdType === 'list') {
                    try {
                        const parsedData = JSON.parse(lpacOutput.trim());
                        socket.emit('lpac_data', { cmdType: cmdType, payload: parsedData.payload });
                    } catch (e) {
                        console.error('无法解析JSON数据:', e);
                    }
                }
                if (cmdType === 'download') {
                    socket.emit('log', '\n✅ 🎉 写卡任务完美结束！配置已成功写入 eSIM 芯片！\n');
                    socket.emit('status', 'success');
                } else {
                    socket.emit('log', `\n✅ 任务执行完毕。\n`);
                    if (['enable', 'disable', 'delete', 'setnickname'].includes(cmdType)) {
                        socket.emit('action_done'); 
                    }
                }
            } else {
                socket.emit('log', `\n❌ 任务执行失败，进程退出码: ${code}\n`);
                if (cmdType === 'download') socket.emit('status', 'error');
            }
        });
    });

    socket.on('start_download', (activationCode) => {
        socket.emit('run_cmd', { cmdType: 'download', params: { activationCode: activationCode } });
    });
});

server.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`===========================================`);
    console.log(`🚀 eSIM 云端 Web 平台启动成功 (Port: ${WEB_PORT})`);
    console.log(`📡 socat 透传隧道已待命 (Port: ${TUNNEL_PORT})`);
});

// ==========================================
// 【引擎 3】独立代理服务，完美取代 esim_proxy.php (端口 3300)
// ==========================================
proxyApp.all('/esim_proxy.php', express.text({ type: '*/*' }), (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");

    // 浏览器直接访问的友好提示
    if (req.method !== 'POST') {
        return res.send(`<h2 style='color: green;'>✅ Node.js 独立代理引擎运行正常！(Port: ${PROXY_PORT})</h2><p>请在 ESP32 代码中使用 POST 方法向此地址发送通知数据。</p>`);
    }

    const targetHost = req.headers['x-target-host'];
    if (!targetHost) return res.status(400).send('Missing X-Target-Host');

    const targetPath = '/gsma/rsp2/es9plus/handleNotification';
    console.log(`🌐 [代理] 正在上报至: https://${targetHost}${targetPath}`);

    const options = {
        hostname: targetHost,
        port: 443,
        path: targetPath,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Admin-Protocol': 'gsma/rsp/v2.2.0',
            'User-Agent': 'gsma-rsp-lpad',
            'Content-Length': Buffer.byteLength(req.body)
        },
        rejectUnauthorized: false // 🔥 强行无视运营商自签证书
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => data += chunk);
        proxyRes.on('end', () => res.status(proxyRes.statusCode).send(data));
    });

    proxyReq.on('error', (e) => res.status(502).send("Proxy Error: " + e.message));
    proxyReq.write(req.body); // 转发原封不动的加密密文
    proxyReq.end();
});

proxyApp.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`🌐 eSIM 通知代理服务启动成功 (Port: ${PROXY_PORT})`);
    console.log(`===========================================`);
});