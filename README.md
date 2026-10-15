# Sobtechno Video Downloader

افزونه کروم برای شناسایی و دانلود ویدیو از هر سایتی، حتی وقتی لینک مستقیم وجود ندارد.
A Chrome (Manifest V3) extension that detects and downloads videos from almost any site — even without a direct link.

**Author:** [Sobtechno](https://github.com/Sobtechno) · **License:** MIT

## چطور کار می‌کند / How it works

| روش | برای چی | خروجی |
|---|---|---|
| **فایل مستقیم** | `mp4`, `webm`, `mkv`… (از تگ video یا ترافیک شبکه) | همان فایل |
| **HLS (m3u8)** | اکثر پلیرهای استریم؛ انتخاب کیفیت، رمزگشایی AES‑128 | `.ts` یا `.mp4` |
| **ضبط** | پلیرهای `blob:` / MSE که هیچ لینکی ندارند | `.webm` |

1. افزونه درخواست‌های شبکه را (فقط داخل مرورگر) برای فایل‌های ویدیو و پلی‌لیست‌ها بررسی می‌کند.
2. پلی‌لیست‌های HLS خوانده می‌شوند و بخش‌ها دانلود، رمزگشایی و به یک فایل تبدیل می‌شوند.
3. اگر هیچ‌کدام ممکن نبود، دکمه «ضبط» ویدیوی در حال پخش را ضبط می‌کند.

## نصب / Install (developer mode)

1. این مخزن را clone یا ZIP کنید.
2. در کروم به `chrome://extensions` بروید و **Developer mode** را روشن کنید.
3. **Load unpacked** را بزنید و پوشه پروژه (جایی که `manifest.json` است) را انتخاب کنید.

حداقل نسخه Chrome: 116.

## محدودیت‌ها / Limitations

- محتوای DRM (Netflix، Widevine و…) پشتیبانی نمی‌شود و نخواهد شد.
- پخش زنده (live HLS) و DASH (`.mpd`) مستقیم دانلود نمی‌شوند؛ از «ضبط» استفاده کنید.
- در HLS با صدای جدا (audio group)، فقط ویدیو دانلود می‌شود. برچسب «صدا جداست» نمایش داده می‌شود.
- ضبط به‌صورت real‑time است و ویدیو نباید mute باشد.
- فقط محتوایی را دانلود کنید که اجازه‌اش را دارید.

## حریم خصوصی / Privacy

هیچ تحلیل، ردیابی یا ارسال داده‌ای وجود ندارد. همه چیز محلی انجام می‌شود. مجوز `<all_urls>` فقط برای شناسایی ویدیو و دانلود بخش‌ها لازم است. برای دانلود، هدر `Referer`/`Origin` موقتاً به آدرس صفحه تنظیم می‌شود تا سایت‌هایی که این را می‌خواهند کار کنند.

## ساختار / Structure

```
manifest.json
background.js        # network sniffing, per-tab list, downloads
hls.js               # m3u8 parsing (shared)
offscreen.html/js    # HLS segment download + merge
content_script.js    # <video> detection + recording fallback
popup/               # UI (red/black theme)
icons/
```

## مشارکت / Contributing

Issue و Pull Request خوش‌آمد است. ایده‌ها: پشتیبانی DASH، ادغام صدا و تصویر جدا (mux)، صف دانلود.

## License

MIT © 2026 Sobtechno
