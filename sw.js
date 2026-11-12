// =======================================================================
//  الملف: sw.js  (Service Worker)
//  المشروع: منصة الشكاوى — إدارة الحج والعمرة، قسم الشكاوى
//  الوصف: عامل خدمة يجعل المنصة قابلة للتثبيت (APK عبر PWABuilder)، وتُفتح شاشاتها بلا إنترنت.
//  ملاحظات:
//    - ملفات المنصة: من الإنترنت أولاً (فلا تتأخر التحديثات)، وتُحفظ نسخة منها؛ إن انقطع الإنترنت
//      أو تأخر ٣ ثوانٍ تُفتح النسخة المحفوظة.
//    - المكتبات والخطوط (روابط بأرقام إصدار ثابتة): من النسخة المحفوظة أولاً.
//    - بيانات الشكاوى (طلبات Supabase) لا تُحفظ أبداً: تبقى على الخادم فقط.
//  سجل التعديلات:
//    2026-10-04  الإصدار الأول (بلا تخزين).
//    2026-11-12  الفتح بلا إنترنت: حفظ ملفات المنصة والمكتبات، وصفحة عربية بدل صفحة خطأ المتصفح.
// =======================================================================

// اسم مخزن النسخ (يكفي اسم ثابت: كل فتح بالإنترنت يحدّث النسخة المحفوظة)
var CACHE = "complaints-v1";

// ملفات تُحفظ عند التثبيت، حتى تُفتح المنصة بلا إنترنت من أول مرة بعد تثبيتها
var CORE = ["./", "index.html", "main.html", "admin.html", "reports.html", "app.js", "config.js", "logo.png",
  "manifest.webmanifest", "manifest-admin.webmanifest", "manifest-reports.webmanifest", "apple-touch-icon.png", "icon-192.png", "icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4"];

// المواقع الخارجية التي تُحفظ ملفاتها (مكتبات وخطوط فقط، لا بيانات)
var LIBS = /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

// التثبيت: كل ملف يُحفظ وحده (فشل ملف لا يمنع البقية)، والصفحة الرئيسية شرط
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(CORE.map(function (u) { return c.add(new Request(u, { cache: "reload" })).catch(function () {}); }))
      .then(function () { return c.match("main.html"); })
      .then(function (r) { if (!r) throw new Error("main.html not stored"); });
  }).then(function () { return self.skipWaiting(); }));
});

// التفعيل: حذف المخازن القديمة إن تغيّر الاسم، والعمل على الصفحات المفتوحة فوراً
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys()
    .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
    .then(function () { return self.clients.claim(); }));
});

// حفظ نسخة من رد ناجح
function store(req, res) {
  if (res && (res.ok || res.type === "opaque")) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
  }
  return res;
}

// الصفحة التي تظهر إن لم تُحفظ أي نسخة بعد (فُتحت المنصة أول مرة بلا إنترنت)
function offlinePage() {
  return new Response('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>منصة الشكاوى</title><body style="font-family:Tahoma,sans-serif;text-align:center;padding:48px 20px;color:#333132;background:#e3ddd2">' +
    '<h1 style="font-size:1.3rem;color:#00594f">لا يوجد اتصال بالإنترنت</h1><p>افتح المنصة مرة والإنترنت متصل، فتُحفظ على جهازك وتُفتح بعدها بلا إنترنت.</p>' +
    '<p><button onclick="location.reload()" style="font-size:1rem;padding:10px 22px;border-radius:10px;border:0;background:#00594f;color:#fff">حاول من جديد</button></p></body></html>',
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // ملفات المنصة نفسها: الإنترنت أولاً، ثم النسخة المحفوظة (بتجاهل ما بعد ? مثل app.js?v=...)
  if (url.origin === self.location.origin) {
    var page = req.mode === "navigate";
    var cached = function () {
      return caches.match(req, { ignoreSearch: true }).then(function (r) {
        if (r || !page) return r;
        return caches.match("main.html", { ignoreSearch: true });
      });
    };
    e.respondWith(new Promise(function (resolve, reject) {
      var done = false, finish = function (r) { if (!done && r) { done = true; resolve(r); } };
      // شبكة ضعيفة قد تعلق طويلاً: بعد ٣ ثوانٍ تُفتح النسخة المحفوظة
      var timer = setTimeout(function () { cached().then(finish); }, 3000);
      var fresh;
      try { fresh = page ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(req, { cache: "no-cache" }); }
      catch (err) { fresh = fetch(req); }
      fresh.then(function (res) { return store(req, res); }).then(function (res) { clearTimeout(timer); finish(res); }, function () {
        clearTimeout(timer);
        cached().then(function (r) {
          if (r) finish(r);
          else if (page) finish(offlinePage());
          else if (!done) { done = true; reject(new Error("offline")); }
        });
      });
    }));
    return;
  }

  // المكتبات والخطوط: النسخة المحفوظة أولاً (روابطها لا يتغير محتواها)
  if (LIBS.test(url.hostname)) {
    e.respondWith(caches.match(req).then(function (r) {
      return r || fetch(req).then(function (res) { return store(req, res); });
    }));
  }
  // غير ذلك (بيانات Supabase): يمر إلى الإنترنت كما هو، ولا يُحفظ
});
