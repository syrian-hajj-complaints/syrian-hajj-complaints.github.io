// =======================================================================
//  عامل الخدمة لمنصة الحضور (نطاقه /attendance/ فقط، ولا يتدخل في منصة الشكاوى)
//  - ملفات المنصة: من الإنترنت أولاً (فتصل التحديثات فوراً)، وتُحفظ نسخة تُفتح بدون إنترنت.
//  - المكتبات والخطوط: من النسخة المحفوظة أولاً (روابطها ثابتة الإصدار).
//  - صور الأشخاص: تُحفظ عند أول ظهور، فتظهر بدون إنترنت.
//  - بيانات Supabase لا تمر من هنا: المنصة تحفظ نسختها وتعديلاتها المعلّقة بنفسها.
// =======================================================================

const CACHE = 'attendance-v2';
const IMG_CACHE = 'attendance-images-v1';
const IMG_LIMIT = 600;

const CORE = [
  './', 'index.html', 'app.js', 'styles.css', 'config.js', 'manifest.webmanifest',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4',
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js',
  '../letterhead.jpg',
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap',
];
const LIBS = /^(cdn\.jsdelivr\.net|cdn\.sheetjs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
const SUPABASE = /\.supabase\.co$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(CORE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.startsWith('attendance-') && k !== CACHE && k !== IMG_CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function store(cacheName, req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    const copy = res.clone();
    caches.open(cacheName).then((c) => c.put(req, copy));
  }
  return res;
}

async function trimImages() {
  const c = await caches.open(IMG_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - IMG_LIMIT; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (SUPABASE.test(url.hostname)) return;

  // ملفات المنصة: الإنترنت أولاً (مهلة 4 ثوانٍ)، ثم النسخة المحفوظة
  if (url.origin === self.location.origin) {
    const page = req.mode === 'navigate';
    const cached = () => caches.match(req, { ignoreSearch: true })
      .then((r) => r || (page ? caches.match('index.html') : undefined));
    e.respondWith(new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
      const timer = setTimeout(() => cached().then(finish), 4000);
      fetch(req, { cache: 'no-cache' })
        .then((res) => { clearTimeout(timer); finish(store(CACHE, req, res)); })
        .catch(() => {
          clearTimeout(timer);
          cached().then((r) => {
            if (r) return finish(r);
            if (!done) { done = true; resolve(new Response('', { status: 504, statusText: 'offline' })); }
          });
        });
    }));
    return;
  }

  // المكتبات والخطوط: المحفوظة أولاً
  if (LIBS.test(url.hostname)) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => store(CACHE, req, res))));
    return;
  }

  // صور الأشخاص: المحفوظة أولاً، وتُحدَّث في الخلفية
  if (req.destination === 'image') {
    e.respondWith(caches.open(IMG_CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) { c.put(req, res.clone()); trimImages(); }
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
  }
});
