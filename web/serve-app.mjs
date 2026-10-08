/** 独立静态站点及流式 API 反向代理，不持有数据库或解锁状态。 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const role = process.argv[2];
if (!['user', 'admin'].includes(role)) throw new Error('请指定 user 或 admin');
const port = Number(process.env.PORT || (role === 'user' ? 8001 : 8002));
const upstream = new URL(process.env.API_UPSTREAM || 'http://127.0.0.1:8000');
// 与 tgdrive/asgi.py 中 PAGE_SECURITY_HEADERS 保持一致。
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'apps', role, 'dist');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // 用户站点同时承载公开分享（/p/ 直链、/api/public/ 元数据）与访问密钥 API（/api/v1/）。
  const isPublic = role === 'user' && ['/p/', '/api/public/', '/api/v1/'].some(prefix => url.pathname.startsWith(prefix));
  if (url.pathname.startsWith('/api/') || isPublic) {
    if (!isPublic && !url.pathname.startsWith(`/api/${role}/`)) { res.writeHead(404); res.end(); return; }
    const proxy = http.request({ hostname: upstream.hostname, port: upstream.port, method: req.method,
      path: req.url, headers: { ...req.headers, host: upstream.host } }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:'API 服务不可用'}})); });
    res.on('close', () => { if (!res.writableEnded) proxy.destroy(); });
    req.pipe(proxy);
    return;
  }
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  let name;
  try { name = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
  let file = path.resolve(root, '.' + name);
  if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); res.end(); return; }
  if (!path.extname(name)) file = path.join(root, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'}[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, {'Content-Type':mime, 'Cache-Control':path.extname(file)==='.html'?'no-store':'no-cache','X-Content-Type-Options':'nosniff', ...securityHeaders});
  if (req.method==='HEAD') res.end(); else fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`${role} Web: http://127.0.0.1:${port}; API: ${upstream.origin}`));
