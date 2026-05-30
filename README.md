# AI Job Application Automator 🚀

Upload brosur lowongan kerja → Analisis AI → Review & edit → Kirim email + CV dalam satu klik.

## Fitur

- **Bulk upload** — upload banyak brosur gambar sekaligus (JPEG, PNG, WebP, GIF)
- **Analisis AI** — ekstrak otomatis: email tujuan, nama perusahaan, posisi, requirements, dan kata pengantar
- **Review & edit** — lihat hasil AI, edit teks sebelum kirim
- **Dark mode** 🌙
- **Kirim individu atau batch** — kirim satu per satu atau semua sekaligus
- **CV otomatis** — lampirkan CV PDF ke setiap email
- **Atur nama & CV dari UI** — panel pengaturan ⚙️ tanpa perlu edit file

## Prasyarat

- [Node.js](https://nodejs.org/) v18 atau lebih baru
- API key **9Router** (primer) atau **Google AI Studio** (fallback) — salah satu harus diisi
- Akun email dengan **App Password** (untuk Gmail) atau SMTP server lain

## Setup Cepat

### 1. Clone & Install

```bash
git clone https://github.com/Fattan-malva/cv-autosend.git
cd cv-autosend
cp .env.example .env
npm install
```

### 2. Konfigurasi AI Provider

Aplikasi mencoba **9Router** terlebih dahulu. Jika gagal (timeout / error), otomatis fallback ke **Google AI Studio (Gemini)**.

#### Opsi A: 9Router (primer)

1. Setup AI dari [9Router](https://github.com/decolua/9router.git)
2. Buat API Key dari dashboard
3. Isi di `.env`:
   ```env
   9ROUTER_API_KEY=sk-xxxxxxxxxxxxxxxxxxxx
   9ROUTER_MODEL=ai-picture
   ```

> Model `ai-picture` dikhususkan untuk analisis gambar. Bisa juga pakai `gpt-4o` atau `free-models`.

#### Opsi B: Google AI Studio (fallback)

Google AI Studio (Gemini) otomatis dipakai jika 9Router tidak dikonfigurasi atau sedang error.

1. Buka [Google AI Studio](https://aistudio.google.com/apikey) → klik **Get API Key**
2. Buat API Key (gratis, ada free quota)
3. Isi di `.env`:
   ```env
   GOOGLE_AI_STUDIO_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   GOOGLE_AI_STUDIO_MODEL=gemma-4-31b-it
   ```

> Model yang didukung: `gemma-4-31b-it` (cepat, ringan), `gemini-2.0-flash-exp` (lebih baru). Pastikan support **vision** (bisa baca gambar).

### 3. Setup App Password Gmail

Gmail **tidak menerima password biasa** untuk akses SMTP. Kamu harus membuat *App Password*:

1. Buka [Google Account](https://myaccount.google.com/) → **Security**
2. Aktifkan **2-Step Verification** (wajib)
3. Klik **App Passwords** (cari di kolom search jika tidak muncul)
4. Pilih **Mail** sebagai app dan **Other (Windows Computer)** sebagai device
5. Copy password 16 karakter yang muncul (format: `xxxx xxxx xxxx xxxx`)
6. Isi di `.env`:
   ```env
   SMTP_SERVER=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SENDER_EMAIL=emailkamu@gmail.com
   SENDER_PASSWORD=xxxx xxxx xxxx xxxx
   SENDER_NAME=Nama Lengkap Kamu
   ```

> Untuk provider email lain (Outlook, Yahoo, dll), isi SMTP_SERVER dan PORT sesuai provider masing-masing.

### 4. Siapkan CV

Letakkan file CV PDF kamu di folder:

```
resource/cv.pdf
```

Atau upload dari UI setelah server jalan (panel ⚙️ → Upload CV).

### 5. Jalankan

```bash
npm start
```

Buka browser: **http://localhost:3000**

## Cara Pakai

1. **Upload brosur** — seret gambar atau klik "Pilih File", bisa pilih banyak sekaligus
2. **Klik "Analisis dengan AI"** — AI akan membaca brosur dan mengisi form secara otomatis
3. **Review & edit** — periksa email tujuan, subjek, dan kata pengantar. Edit jika perlu
4. **Kirim** — klik "Kirim Lamaran" per brosur, atau "Kirim Semua" untuk batch

### Pengaturan (⚙️)

- **Nama Pengirim** — ubah nama yang muncul di body email (tersimpan ke `.env`)
- **Upload CV** — upload file PDF langsung dari browser

## Struktur Proyek

```
├── .env                  # Konfigurasi (tidak di-commit)
├── .env.example          # Template konfigurasi
├── .gitignore
├── package.json
├── server.js             # Backend Express
├── README.md
├── public/
│   └── index.html        # Frontend Tailwind
└── resource/
    └── cv.pdf            # CV kamu
```

## API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET | `/api/health` | Health check |
| GET | `/api/config` | Ambil konfigurasi (SENDER_NAME, dll) |
| POST | `/api/config` | Update SENDER_NAME |
| POST | `/api/upload-cv` | Upload file CV (PDF) |
| POST | `/api/analyze` | Upload & analisis brosur (max 20 file) |
| POST | `/api/send-email` | Kirim 1 email |
| POST | `/api/send-batch` | Kirim banyak email sekaligus |

## Environment Variables

| Variable | Wajib | Default | Deskripsi |
|----------|-------|---------|-----------|
| `9ROUTER_MODEL` | — | `gpt-4o` | Model 9Router untuk analisis |
| `9ROUTER_API_BASE` | — | `https://api.9router.ai/v1` | Base URL 9Router |
| `9ROUTER_API_KEY` | — | — | API Key 9Router |
| `GOOGLE_AI_STUDIO_API_KEY` | — | — | API Key Google AI Studio (fallback) |
| `GOOGLE_AI_STUDIO_MODEL` | — | `gemma-4-31b-it` | Model Gemini (harus support vision) |
| `SMTP_SERVER` | ✅ | — | Server SMTP (contoh: `smtp.gmail.com`) |
| `SMTP_PORT` | ✅ | `587` | Port SMTP |
| `SMTP_SECURE` | — | `false` | `true` untuk port 465 |
| `SENDER_EMAIL` | ✅ | — | Alamat email pengirim |
| `SENDER_PASSWORD` | ✅ | — | App Password email |
| `SENDER_NAME` | — | `Job Applicant` | Nama pengirim untuk body surat |

## Tech Stack

- **Backend:** Express.js, Multer, Nodemailer, Winston
- **AI:** OpenAI SDK → 9Router API (primer) / Google AI Studio Gemini (fallback otomatis)
- **Frontend:** Tailwind CSS (CDN)
- **Rate limiting:** express-rate-limit
