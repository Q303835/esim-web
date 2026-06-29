const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const https = require('https');

// ==========================================
// 读取环境变量
// ==========================================
const WEB_PORT = process.env.WEB_PORT || 3200;
const TUNNEL_PORT = process.env.TUNNEL_PORT || 3100;
const PROXY_PORT = process.env.PROXY_PORT || 3300;

// 【新增】安全验证 Token（你以后可以在 pm2 中修改它，默认是 esim123）
const API_TOKEN = process.env.API_TOKEN || 'esim123';

const app = express();
const proxyApp = express();
const server = http.createServer(app);
const io = new Server(server);
let isDeviceReady = false;

// ==========================================
// 【引擎 1】Node.js 动态管理 socat (带 Token 与静默销毁)
// ==========================================
let socatProcess = null;
let idleTimeout = null;
const IDLE_TIME_MS = 5 * 60 * 1000; // 5分钟无操作超时

// 彻底释放隧道函数
function killSocat() {
    if (socatProcess) {
        try { socatProcess.kill('SIGKILL'); } catch (e) {}
        socatProcess = null;
        console.log('🛑 socat 隧道已强制释放，串口控制权已归还给模组！');
    }
    if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
    }
}

// 重置 5 分钟静默倒计时
function resetIdleTimeout() {
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
        console.log('⏳ 触发静默保护：超过 5 分钟无操作，自动断开透传');
        killSocat();
        io.emit('log', '\n⏳ [系统保护] 超过 5 分钟无任何写卡/查询操作，云端已自动彻底释放透传隧道，归还串口！\n');
        io.emit('device_disconnected'); // 通知前端更新 UI 状态
    }, IDLE_TIME_MS);
}

// 启动隧道
function startSocat() {
    killSocat(); // 启动前先清理干净旧进程
    console.log(`🔗 Token 验证通过！正在建立全新的 socat 隧道 (端口: ${TUNNEL_PORT})...`);

    socatProcess = spawn('socat', ['-d', '-d', 'pty,link=/dev/ttyV0,raw,echo=0', `tcp-listen:${TUNNEL_PORT},reuseaddr`]);

    socatProcess.stdout.on('data', (data) => console.log(`[socat] ${data}`));
    
    socatProcess.stderr.on('data', (data) => console.error(`[socat ERROR] ${data}`)); //调试才开启，打印详细日志

    //     socatProcess.stderr.on('data', (data) => {
    //     const msg = data.toString();
    //     // 过滤：如果日志里带有 " N " (Notice) 或 " I " (Info)，就作为普通日志打印或直接忽略
    //     if (msg.includes(' N ') || msg.includes(' I ')) {
    //         // 如果你想彻底清净，可以把下面这行注释掉
    //         // console.log(`[socat TRACE] ${msg.trim()}`); 
    //     } else {
    //         // 只有真正的警告 (W) 或错误 (E/F) 才显示为 ERROR
    //         console.error(`[socat ERROR] ${msg.trim()}`);
    //     }
    // });


    socatProcess.on('close', (code) => {
        console.log(`⚠️ socat 隧道已退出 (代码: ${code})`);
        socatProcess = null;
    });

    resetIdleTimeout(); // 隧道一旦启动，立刻开始 5 分钟倒计时
}

// ==========================================
// 【新增】网页端 API：提供给按钮触发隧道启停
// ==========================================
app.get('/api/start_tunnel', (req, res) => {
    const userToken = req.query.token;
    if (userToken !== API_TOKEN) {
        console.log(`❌ 拒绝未授权的启动请求 (尝试 Token: ${userToken})`);
        return res.status(401).send('TOKEN_INVALID');
    }
    startSocat();
    res.status(200).send('TUNNEL_STARTED');
});

app.get('/api/stop_tunnel', (req, res) => {
    killSocat();
    res.status(200).send('TUNNEL_STOPPED');
});

// ==========================================
// 【引擎 2】云端 Web 控制台交互逻辑
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
    killSocat(); // 设备主动断开时，顺手彻底释放隧道
    res.status(200).send('OK');
});

function getLpacArgs(cmdType, params = {}) {
    switch (cmdType) {
        // === 芯片管理 ===
        case 'info': return ['chip', 'info'];
        case 'defaultsmdp': return ['chip', 'defaultsmdp', params.smdp]; // 修改芯片默认的 SM-DP+ 服务器

        // === Profile (配置) 管理 ===
        case 'list': return ['profile', 'list'];
        case 'enable': return ['profile', 'enable', params.iccid];
        case 'disable': return ['profile', 'disable', params.iccid];
        case 'delete': return ['profile', 'delete', params.iccid];
        case 'setnickname': return ['profile', 'nickname', params.iccid, params.nickname];
        
        // 优化：支持 SM-DS 自动拉取
        case 'discover': return ['profile', 'discover']; 

        // 优化：下载功能更加健壮，支持 IMEI 和 确认码
        case 'download': {
            let args = ['profile', 'download', '-a', params.activationCode];
            if (params.imei) {
                args.push('-i', params.imei);
            }
            if (params.confirmCode) {
                args.push('-c', params.confirmCode);
            }
            return args;
        }

        // === Notification (通知) 管理 ===
        case 'notiflist': return ['notification', 'list']; // 获取所有待处理的通知序列号(seq)
        
        // 优化：支持处理单条(传入seq)或全部处理
        case 'notifprocess': {
            return params.seq !== undefined 
                ? ['notification', 'process', String(params.seq)] 
                : ['notification', 'process'];
        }
        
        case 'notifremove': return ['notification', 'remove', String(params.seq)]; // 强行清理卡死的通知

        default: return [];
    }
}

io.on('connection', (socket) => {
    if (isDeviceReady) socket.emit('device_ready');
    
    socket.on('run_cmd', (payload) => {
        // 🔥 【核心功能】只要网页端发起了查询或写卡指令，立刻给倒计时“续杯” 5 分钟！
        if (socatProcess) resetIdleTimeout(); 

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
                LPAC_APDU: 'at',                 
                LPAC_APDU_AT_DEVICE: '/dev/ttyV0'
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
                if (cmdType === 'info' || cmdType === 'list' || cmdType === 'notiflist') {
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
    console.log(`🚀 eSIM 云端 Web 平台已升级启动 (VPS_IP:${WEB_PORT})`);
    console.log(`🔒 安全模式已开启：必须通过 Token 验证才能触发 socat 隧道！`);
});

// ==========================================
// 【引擎 3】独立代理服务 (保持不变)
// ==========================================
proxyApp.all('/esim_proxy', express.text({ type: '*/*' }), (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");

    if (req.method !== 'POST') {
        return res.send(`<h2 style='color: green;'>✅ Node.js 独立代理引擎运行正常！(Port: ${PROXY_PORT})</h2><p>请在 ESP32 代码中使用 POST 方法向此地址发送通知数据。</p>`);
    }

    const targetHost = req.headers['x-target-host'];
    if (!targetHost) return res.status(400).send('Missing X-Target-Host');

    const targetPath = '/gsma/rsp2/es9plus/handleNotification';
    
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
        rejectUnauthorized: false 
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => data += chunk);
        proxyRes.on('end', () => res.status(proxyRes.statusCode).send(data));
    });

    proxyReq.on('error', (e) => res.status(502).send("Proxy Error: " + e.message));
    proxyReq.write(req.body); 
    proxyReq.end();
});

proxyApp.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`🌐 eSIM 通知代理服务启动成功 (VPS_IP:${PROXY_PORT}/esim_proxy)`);
    console.log(`===========================================`);
});