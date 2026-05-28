/**
 * 酷狗音乐 API 代理服务
 *
 * 功能：
 * 1. /login - 密码验证 → 微信扫码登录 → 自动保存 token 到 .env
 * 2. 其他所有请求：自动附加 token 转发到酷狗 API
 *
 * 解决问题：多设备使用同一个 token，避免因多设备登录导致 token 失效
 */

const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 加载 .env
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const app = express();
const PORT = process.env.PORT || 3456;
const UPSTREAM = process.env.UPSTREAM || 'https://kg.ajx.lol';

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================================================================
// 辅助函数：更新 .env 文件
// ================================================================
function updateEnv(key, value) {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }
  const lines = content.split('\n');
  let found = false;
  const newLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    newLines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
  process.env[key] = value;
}

// ================================================================
// 辅助函数：构建带登录凭证的请求头
// 注意：不注入平台标识（GUID/MID），让上游自行处理以确保签名一致
// ================================================================
function buildUpstreamCookies() {
  const cookieParts = [];

  // 只注入登录凭证，不注入平台标识（上游会自行生成正确的签名）
  if (process.env.KUGOU_TOKEN) cookieParts.push(`token=${process.env.KUGOU_TOKEN}`);
  if (process.env.KUGOU_USERID) cookieParts.push(`userid=${process.env.KUGOU_USERID}`);

  return cookieParts.join('; ');
}

// ================================================================
// 辅助函数：存储当前登录会话状态
// ================================================================
const loginSessions = new Map();

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ================================================================
// 页面：登录密码输入页
// ================================================================
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>酷狗登录</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh;
  }
  .card {
    background: #fff; border-radius: 12px;
    padding: 40px 32px; width: 360px;
    box-shadow: 0 4px 24px rgba(0,0,0,.08);
    text-align: center;
  }
  h2 { font-size: 22px; margin-bottom: 8px; color: #333; }
  .sub { color: #999; font-size: 14px; margin-bottom: 24px; }
  input {
    width: 100%; padding: 12px 16px;
    border: 1px solid #e0e0e0; border-radius: 8px;
    font-size: 16px; outline: none; transition: border .2s;
  }
  input:focus { border-color: #ff6b35; }
  button {
    width: 100%; padding: 12px; margin-top: 16px;
    background: #ff6b35; color: #fff; border: none;
    border-radius: 8px; font-size: 16px; cursor: pointer;
    transition: background .2s;
  }
  button:hover { background: #e55a2b; }
  .error { color: #e74c3c; font-size: 14px; margin-top: 12px; display: none; }
</style>
</head>
<body>
<div class="card">
  <h2>🔐 酷狗音乐代理</h2>
  <p class="sub">请输入管理密码以登录酷狗账号</p>
  <form id="form">
    <input type="password" id="pwd" placeholder="管理密码" autofocus>
    <button type="submit">验证并扫码登录</button>
  </form>
  <p class="error" id="error">密码错误</p>
</div>
<script>
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = document.getElementById('pwd').value;
  const resp = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd })
  });
  const data = await resp.json();
  if (data.error) {
    document.getElementById('error').style.display = 'block';
    document.getElementById('error').textContent = data.error;
    return;
  }
  window.location.href = '/login/qr?session=' + data.session;
});
</script>
</body>
</html>`);
});

// ================================================================
// API：验证密码并创建登录会话
// ================================================================
app.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPwd = process.env.ADMIN_PASSWORD;

  if (!adminPwd) {
    return res.json({ error: '服务器未配置 ADMIN_PASSWORD，请先在 .env 中设置' });
  }
  if (password !== adminPwd) {
    return res.json({ error: '密码错误' });
  }

  const session = generateSessionToken();
  loginSessions.set(session, { status: 'verified', createdAt: Date.now() });
  res.json({ success: true, session });
});

// ================================================================
// 页面：显示登录二维码
// ================================================================
app.get('/login/qr', async (req, res) => {
  const { session } = req.query;
  if (!session || !loginSessions.has(session)) {
    return res.status(403).send('<h2>无效或已过期的会话，请重新 <a href="/login">登录</a></h2>');
  }

  const sess = loginSessions.get(session);
  if (!sess.qrKey) {
    try {
      const cookieStr = buildUpstreamCookies();
      // Step 1: 获取 qr key
      const keyResp = await axios({
        method: 'get',
        url: `${UPSTREAM}/login/qr/key`,
        headers: { cookie: cookieStr },
        params: { type: 'android', timestamp: Date.now() },
      });
      const qrKey = keyResp.data?.data?.qrcode || keyResp.data?.data?.key || keyResp.data?.qrcode;

      if (!qrKey) {
        return res.status(500).send(`<h2>获取二维码失败</h2><pre>${JSON.stringify(keyResp.data, null, 2)}</pre><a href="/login">返回</a>`);
      }

      // Step 2: 生成二维码
      const qrResp = await axios({
        method: 'get',
        url: `${UPSTREAM}/login/qr/create`,
        headers: { cookie: cookieStr },
        params: { key: qrKey, qrimg: true, timestamp: Date.now() },
      });
      const qrData = qrResp.data?.data || qrResp.data;
      const qrBase64 = qrData?.base64;

      sess.qrKey = qrKey;
      sess.qrBase64 = qrBase64;
      sess.qrStatus = 'waiting';
    } catch (e) {
      console.error('获取二维码失败:', e.message);
      return res.status(500).send('<h2>请求酷狗 API 失败，请稍后重试</h2><a href="/login">返回</a>');
    }
  }

  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>扫码登录</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh;
  }
  .card {
    background: #fff; border-radius: 12px;
    padding: 40px 32px; width: 380px;
    box-shadow: 0 4px 24px rgba(0,0,0,.08);
    text-align: center;
  }
  h2 { font-size: 20px; margin-bottom: 16px; color: #333; }
  .qr-wrap { margin: 16px 0; }
  .qr-wrap img { width: 240px; height: 240px; border-radius: 8px; border: 1px solid #eee; }
  .status { font-size: 15px; color: #666; margin-top: 16px; }
  .status.success { color: #27ae60; font-weight: bold; }
  .status.expired { color: #e74c3c; }
  .info { font-size: 13px; color: #aaa; margin-top: 12px; }
  .back { display: block; margin-top: 20px; color: #ff6b35; text-decoration: none; font-size: 14px; }
</style>
</head>
<body>
<div class="card">
  <h2>📱 微信扫码登录酷狗</h2>
  <div class="qr-wrap">
    <img src="${sess.qrBase64}" alt="QR Code" id="qr">
  </div>
  <p class="status" id="status">请使用微信扫描二维码</p>
  <p class="info">扫码后此页面会自动检测登录状态</p>
  <a class="back" href="/login">← 返回</a>
</div>
<script>
  const session = '${session}';
  const qrKey = '${sess.qrKey}';
  let stopped = false;

  async function checkStatus() {
    if (stopped) return;
    try {
      const resp = await fetch('/login/check?session=' + session + '&key=' + qrKey);
      const data = await resp.json();
      const el = document.getElementById('status');

      if (data.status === 1) {
        el.textContent = '⏳ 等待扫码...';
      } else if (data.status === 2) {
        el.textContent = '✅ 已扫码，请在手机上确认登录';
      } else if (data.status === 4) {
        el.className = 'status success';
        el.textContent = '🎉 登录成功！Token 已保存';
        if (data.username) el.textContent += '，欢迎 ' + data.username;
        stopped = true;
        return;
      } else if (data.status === 0 || data.status === -2) {
        el.className = 'status expired';
        el.textContent = '⚠️ 二维码已过期，请刷新页面';
        stopped = true;
        return;
      }

      setTimeout(checkStatus, 2000);
    } catch(e) {
      document.getElementById('status').textContent = '网络异常，正在重试...';
      setTimeout(checkStatus, 3000);
    }
  }

  checkStatus();
</script>
</body>
</html>`);
});

// ================================================================
// API：检查二维码登录状态
// ================================================================
app.get('/login/check', async (req, res) => {
  const { session, key } = req.query;
  if (!session || !loginSessions.has(session)) {
    return res.status(403).json({ error: '无效会话' });
  }

  try {
    const cookieStr = buildUpstreamCookies();
    const resp = await axios({
      method: 'get',
      url: `${UPSTREAM}/login/qr/check`,
      headers: { cookie: cookieStr },
      params: { key, timestamp: Date.now() },
    });
    const data = resp.data?.data || resp.data;
    const status = data?.status;

    // status: 0=过期, 1=等待扫码, 2=已扫码待确认, 4=成功, -2=过期
    const result = { status };

    if (status === 4) {
      const token = data?.token;
      const userid = data?.userid;

      if (token) updateEnv('KUGOU_TOKEN', token);
      if (userid) updateEnv('KUGOU_USERID', String(userid));
      if (data?.vip) updateEnv('KUGOU_VIP', String(data.vip));

      result.success = true;
      result.token = token;

      // 获取用户信息
      try {
        const userResp = await axios({
          method: 'get',
          url: `${UPSTREAM}/user/detail`,
          headers: { cookie: buildUpstreamCookies() },
          params: { userid, timestamp: Date.now() },
        });
        const userData = userResp.data?.data || userResp.data;
        if (userData?.user_name) {
          updateEnv('KUGOU_USERNAME', userData.user_name);
          result.username = userData.user_name;
        }
      } catch (e) {
        console.error('获取用户信息失败:', e.message);
      }

      loginSessions.delete(session);
    }

    res.json(result);
  } catch (e) {
    console.error('检查二维码状态失败:', e.message);
    res.json({ status: -1, error: '请求失败' });
  }
});

// ================================================================
// 代理：所有其他请求 → 转发到酷狗 API
// ================================================================
app.use(async (req, res, next) => {
  if (req.path.startsWith('/login')) return next();

  const accessToken = process.env.ACCESS_TOKEN;
  const requestToken = req.query.token || req.headers['x-access-token'];

  if (!accessToken) {
    return res.status(500).json({ error: '服务器未配置 ACCESS_TOKEN' });
  }

  if (requestToken !== accessToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // token 仅用于本代理鉴权，不转发给上游
  const upstreamQuery = { ...req.query };
  delete upstreamQuery.token;

  const targetUrl = `${UPSTREAM}${req.path}`;

  // 构建请求头
  const headers = {
    'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
    'Accept': req.headers['accept'] || '*/*',
    'Content-Type': req.headers['content-type'] || 'application/json',
  };

  // 注入平台标识 + 登录凭证
  headers['cookie'] = buildUpstreamCookies();

  try {
    const resp = await axios({
      method: req.method,
      url: targetUrl,
      headers,
      params: req.method === 'GET' ? upstreamQuery : undefined,
      data: req.method !== 'GET' ? req.body : undefined,
      responseType: 'stream',
      validateStatus: () => true,
    });

    // 转发响应头
    Object.entries(resp.headers).forEach(([key, value]) => {
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        res.set(key, value);
      }
    });

    res.status(resp.status);
    resp.data.pipe(res);
  } catch (e) {
    console.error(`代理请求失败 [${req.method} ${req.originalUrl}]:`, e.message);
    res.status(502).json({ error: '上游服务不可用', detail: e.message });
  }
});

// ================================================================
// 启动
// ================================================================
app.listen(PORT, () => {
  console.log(`🚀 酷狗代理服务已启动: http://localhost:${PORT}`);
  console.log(`📡 上游API: ${UPSTREAM}`);
  console.log(`🔑 登录入口: http://localhost:${PORT}/login`);

  if (!process.env.ADMIN_PASSWORD) {
    console.warn('⚠️  未配置 ADMIN_PASSWORD，请在 .env 中设置管理密码');
  }
  if (process.env.KUGOU_TOKEN) {
    console.log(`✅ 已登录，token: ${process.env.KUGOU_TOKEN.substring(0, 8)}...`);
  } else {
    console.log('⚠️  未登录，请访问 /login 扫码登录');
  }
  if (process.env.ACCESS_TOKEN) {
    console.log(`🛡️  代理访问 token: ${process.env.ACCESS_TOKEN}`);
  } else {
    console.warn('⚠️  未配置 ACCESS_TOKEN，代理 API 将拒绝访问');
  }
});