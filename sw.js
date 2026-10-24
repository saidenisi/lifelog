/* lifelog Service Worker —— 只为两件事存在：断网也能打开、更新能可靠到达。
 *
 * 三条铁律（2026-10-14 定，改这个文件前先读一遍）：
 *   1) 页面(HTML) 一律「网络优先」：在线永远取最新，只有网络真的失败才回退缓存。
 *      绝不能改成缓存优先 —— 已安装的 App 没有 Ctrl+F5，缓存优先会导致「改了却看不到」。
 *   2) 同源静态文件（highlights.js / 图标 / manifest）走「先给缓存、后台更新」。
 *   3) 跨域请求（Supabase 数据、Google 字体）完全不拦截、不缓存 —— 数据必须实时。
 *
 * BUILD 必须与 lifelog.html 里的 build 号完全一致（deploy-lifelog.js 会强制校验，
 * 不一致直接拒绝部署）。每次部署换一个新缓存名，activate 时清掉旧的 lifelog-* 缓存。
 */
const BUILD = '20261022f';
const CACHE = 'lifelog-' + BUILD;
const BASE = new URL('./', self.location).href;
const HTML_URL = BASE + 'lifelog.html';
const SW_URL = BASE + 'sw.js';
const CORE = [
  HTML_URL,
  BASE + 'highlights.js',
  BASE + 'manifest.webmanifest',
  BASE + 'icon-192.png',
  BASE + 'icon-512.png',
  BASE + 'apple-touch-icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 单个文件失败不能让整体安装失败（否则 SW 被丢弃、离线能力全废）
    await Promise.all(CORE.map((u) =>
      c.add(new Request(u, { cache: 'reload' }))
        .catch((err) => console.warn('[sw] 预缓存跳过', u, err && err.message))
    ));
  })());
  // 故意不自动 skipWaiting：新版本先「待命」，由页面提示用户点「立即更新」再接管。
  // 这样即使新版本有毛病，也不会在用户没察觉时自动换掉正在用的版本。
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // 只清理本应用自己的缓存（同一域名下可能有其它项目）
    await Promise.all(
      keys.filter((k) => k.indexOf('lifelog-') === 0 && k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ?nosw=1 救援会话会把它置为 true：此后本次 SW 运行期间不再写任何缓存。
// 没有这个开关的话，页面刚把缓存删掉，SW 又会在处理后续请求时把它写回来。
let rescueMode = false;

self.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data.type === 'RESCUE') {
    rescueMode = true;
    console.log('[sw] 进入救援模式：本次运行不再写入任何缓存');
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // 写请求（Supabase）绝不碰
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 跨域：数据、字体 → 直接放行
  if (url.href.split('?')[0] === SW_URL) return;          // sw.js 自身必须走网络，否则永远拿不到新版本

  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req));
    return;
  }
  e.respondWith(staleWhileRevalidate(req));
});

// 把 HTML 存成一份「干净的」响应：不带 Vary / 重定向等会让 cache.match 失配的头部，
// 保证断网时一定匹配得上。
// 注意：只在这里（真的有成功响应要写）才打开缓存 —— caches.open() 会「创建」缓存，
// 无条件调用会让 ?nosw=1 刚清掉的缓存又被重建出来。
async function cacheHtml(res) {
  if (rescueMode) return;   // 救援会话：绝不写缓存
  try {
    const body = await res.arrayBuffer();
    const cache = await caches.open(CACHE);
    await cache.put(HTML_URL, new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }));
  } catch (err) {
    console.warn('[sw] HTML 缓存失败（不影响在线使用）', err && err.message);
  }
}

async function networkFirst(req) {
  // 救援导航(?nosw=1) 本身也不写缓存：页面马上要把缓存全删掉，写了就是白费。
  // 注意只跳过「写」，仍然保留「断网回退缓存」——否则断网时救援页会白屏。
  const isRescueNav = /[?&]nosw=1\b/.test(new URL(req.url).search);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      // 不 await：先让页面开始渲染，缓存副本在后台写（避免等整份 HTML 下载完才显示）
      if (!isRescueNav) cacheHtml(fresh.clone());
      return fresh;
    }
    // 服务端返回错误页（如 Pages 构建空窗期）→ 优先给缓存里可用的那一版
    const cached = await caches.match(HTML_URL);
    return cached || fresh;
  } catch (err) {
    const cached = await caches.match(HTML_URL);
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><title>离线</title>' +
      '<body style="font:16px/1.6 system-ui,-apple-system,sans-serif;padding:40px;color:#333">' +
      '<h2>离线，且本机还没有缓存</h2>' +
      '<p>请联网后重新打开一次，之后就能离线使用了。</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(req) {
  // caches.match 不会创建缓存；只有真拿到成功响应才去 open+put
  const cached = await caches.match(req);
  const network = fetch(req).then(async (res) => {
    if (res && res.ok && !rescueMode) {
      try {
        const c = await caches.open(CACHE);
        c.put(req, res.clone()).catch(() => {});
      } catch (_) {}
    }
    return res;
  }).catch(() => null);

  if (cached) {
    network.catch(() => {});   // 后台更新，不阻塞
    return cached;
  }
  const res = await network;
  return res || new Response('', { status: 504, statusText: 'Offline' });
}
