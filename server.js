const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const { OpenAI } = require('openai');
const { GoogleGenAI } = require('@google/genai');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const winston = require('winston');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Logger ───────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

// ── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Terlalu banyak permintaan. Coba lagi dalam 1 menit.' },
});
const emailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Terlalu banyak pengiriman email. Coba lagi dalam 1 menit.' },
});

// ── Multer (memory storage for images) ──────────────────────────────────
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_CV_MIME = ['application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipe file ${file.mimetype} tidak didukung. Gunakan JPEG, PNG, WebP, atau GIF.`));
    }
  },
});

// CV upload — simpan langsung via buffer (lebih robust dari diskStorage)
const uploadCv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_CV_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File CV harus berupa PDF.'));
    }
  },
});

// ── AI Providers (9Router → GROQ fallback) ──────────────────────────────
const aiProviders = [];

if (process.env['9ROUTER_API_KEY']) {
  aiProviders.push({
    name: '9Router',
    client: new OpenAI({
      baseURL: process.env['9ROUTER_API_BASE'] || 'https://api.9router.ai/v1',
      apiKey: process.env['9ROUTER_API_KEY'],
    }),
    model: process.env['9ROUTER_MODEL'] || 'gpt-4o',
  });
}

if (process.env['GOOGLE_AI_STUDIO_API_KEY']) {
  aiProviders.push({
    name: 'Gemini',
    type: 'native_gemini',
    client: new GoogleGenAI({
      apiKey: process.env['GOOGLE_AI_STUDIO_API_KEY'],
    }),
    model: process.env['GOOGLE_AI_STUDIO_MODEL'] || 'gemini-2.5-flash',
  });
}

function buildAnalysisPrompt(senderName) {
  return `Analisis gambar brosur lowongan kerja ini. Ekstrak informasi berikut dan kembalikan HANYA dalam format JSON murni tanpa markdown:
{
  "email_tujuan": "email untuk mengirim lamaran (string, kosongkan jika tidak ditemukan)",
  "nama_perusahaan": "nama perusahaan",
  "posisi": "posisi yang dibuka",
  "subjek": "subjek email yang ditentukan di brosus (string, kosongkan jika brosur tidak menyebutkan subjek secara spesifik. Contoh: 'IT_NAMA' atau 'Lamaran - Staff IT')",
  "requirements": ["kualifikasi atau requirements pekerjaan yang disebutkan dalam brosur"],
  "kata_pengantar": "Tulis surat lamaran kerja via email yang profesional, sopan, dan berbahasa Indonesia yang baik. Surat harus: (1) memperkenalkan diri sebagai ${senderName}, (2) menyebutkan posisi dan perusahaan yang dilamar, (3) menyebutkan 1-2 kualifikasi atau keahlian pelamar yang relevan dengan kebutuhan perusahaan berdasarkan requirements brosur, (4) menyatakan minat dan kesiapan untuk berkontribusi, (5) menutup dengan harapan dapat diwawancarai. Jangan gunakan template kaku, buatlah sealami mungkin. Akhiri dengan 'Hormat saya,\\n${senderName}' tanpa placeholder lagi."
}`;
}

function parseResponse(rawText, senderName) {
  rawText = rawText.replace(/^```json\s*/i, '').replace(/```$/g, '').trim();
  const parsed = JSON.parse(rawText);
  if (parsed.kata_pengantar) {
    parsed.kata_pengantar = parsed.kata_pengantar
      .replace(/\[Nama Anda\]/gi, senderName)
      .replace(/\[Nama Lengkap\]/gi, senderName)
      .replace(/\[Nama\]/gi, senderName);
  }
  return parsed;
}

async function analyzeWithRetry(base64Image, mimeType, senderName) {
  const errors = [];

  for (const provider of aiProviders) {
    const retries = provider.name === '9Router' ? 2 : 1;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        let rawText;

        if (provider.type === 'native_gemini') {
          const response = await provider.client.models.generateContent({
            model: provider.model,
            contents: [
              buildAnalysisPrompt(senderName),
              {
                inlineData: {
                  data: base64Image,
                  mimeType: mimeType,
                },
              },
            ],
            config: {
              temperature: 0.2,
              responseMimeType: 'application/json',
            },
          });
          rawText = response.text;
        } else {
          const response = await provider.client.chat.completions.create({
            model: provider.model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: buildAnalysisPrompt(senderName) },
                  { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
                ],
              },
            ],
            temperature: 0.4,
            max_tokens: 3000,
          });
          rawText = response.choices[0].message.content;
        }

        const data = parseResponse(rawText, senderName);
        logger.info(`Analisis berhasil via ${provider.name} (${provider.model})`);
        return data;
      } catch (err) {
        errors.push({ provider: provider.name, attempt: attempt + 1, error: err.message });
        logger.warn(`${provider.name} attempt ${attempt + 1}/${retries + 1} gagal`, { error: err.message });
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    logger.warn(`${provider.name} habis, lanjut ke provider berikutnya...`);
  }

  const summary = errors.map(e => `${e.provider} (${e.error})`).join('; ');
  throw new Error(`Semua AI provider gagal: ${summary}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────
function getBase64Image(file) {
  return { base64: file.buffer.toString('base64'), mime: file.mimetype };
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_SERVER,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SENDER_EMAIL,
      pass: process.env.SENDER_PASSWORD,
    },
  });
}

function getCvAttachment() {
  const cvPath = path.join(__dirname, 'resource', 'cv.pdf');
  if (fs.existsSync(cvPath)) {
    const stat = fs.statSync(cvPath);
    if (stat.size > 0) {
      return [{ filename: 'CV_Lamaran_Kerja.pdf', path: cvPath }];
    }
  }
  logger.warn('File cv.pdf tidak ditemukan atau kosong di resource/. Dikirim tanpa lampiran.');
  return [];
}

function updateEnvFile(changes) {
  const envPath = path.join(__dirname, '.env');
  let content = fs.readFileSync(envPath, 'utf-8');
  for (const [key, val] of Object.entries(changes)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }
  fs.writeFileSync(envPath, content, 'utf-8');
}

// ── API Routes ───────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get config (safe — only expose what frontend needs)
app.get('/api/config', (_req, res) => {
  const cvPath = path.join(__dirname, 'resource', 'cv.pdf');
  const cvExists = fs.existsSync(cvPath) && fs.statSync(cvPath).size > 0;
  res.json({
    SENDER_NAME: process.env.SENDER_NAME || '',
    SENDER_EMAIL: process.env.SENDER_EMAIL || '',
    hasCV: cvExists,
    SMTP_SERVER: process.env.SMTP_SERVER || '',
  });
});

// Update config (only writable fields)
app.post('/api/config', (req, res) => {
  const { SENDER_NAME } = req.body;
  if (SENDER_NAME !== undefined) {
    process.env.SENDER_NAME = SENDER_NAME;
    updateEnvFile({ SENDER_NAME });
  }
  logger.info('Config updated', { SENDER_NAME });
  res.json({ success: true, SENDER_NAME: process.env.SENDER_NAME });
});

// Upload CV — simpan ke resource/cv.pdf dari buffer (atasi lock file)
app.post('/api/upload-cv', (req, res) => {
  uploadCv.single('cv')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Tidak ada file CV yang diupload.' });
    }
    try {
      const cvDir = path.join(__dirname, 'resource');
      const cvPath = path.join(cvDir, 'cv.pdf');
      if (!fs.existsSync(cvDir)) {
        fs.mkdirSync(cvDir, { recursive: true });
      }
      if (fs.existsSync(cvPath)) {
        fs.unlinkSync(cvPath);
      }
      fs.writeFileSync(cvPath, req.file.buffer);
      logger.info('CV uploaded:', req.file.originalname);
      res.json({ success: true, message: 'CV berhasil diupload.', fileName: req.file.originalname });
    } catch (writeErr) {
      logger.error('Gagal menyimpan CV', { error: writeErr.message });
      res.status(500).json({ error: 'Gagal menyimpan CV: ' + writeErr.message });
    }
  });
});

// 1. Analyze uploaded images (parallel)
app.post('/api/analyze', analyzeLimiter, (req, res, next) => {
  upload.array('brosur', 20)(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        const messages = {
          LIMIT_FILE_SIZE: 'Ukuran file terlalu besar (maks 10MB per file).',
          LIMIT_FILE_COUNT: 'Maksimal 20 file dalam sekali upload.',
          LIMIT_UNEXPECTED_FILE: 'Field name harus "brosur".',
        };
        return res.status(400).json({ error: messages[err.code] || err.message });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Tidak ada file yang diunggah.' });
  }

  const senderName = process.env.SENDER_NAME || 'Pelamar';
  logger.info(`Menganalisis ${req.files.length} file sebagai ${senderName}...`);

  const tasks = req.files.map(async (file) => {
    const { base64, mime } = getBase64Image(file);
    try {
      const data = await analyzeWithRetry(base64, mime, senderName);
      return { fileName: file.originalname, status: 'success', data };
    } catch (error) {
      logger.error(`Gagal menganalisis ${file.originalname}`, { error: error.message });
      return { fileName: file.originalname, status: 'error', message: error.message };
    }
  });

  const results = await Promise.allSettled(tasks);
  const mapped = results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason));

  const successCount = mapped.filter((r) => r.status === 'success').length;
  logger.info(`Selesai: ${successCount}/${mapped.length} berhasil`);
  res.json(mapped);
});

// 2. Send single email
app.post('/api/send-email', emailLimiter, async (req, res) => {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Field to, subject, dan body wajib diisi.' });
  }

  const emailList = to
    .split(/[,;]/)
    .map((e) => e.trim())
    .filter(Boolean);

  if (emailList.length === 0) {
    return res.status(400).json({ error: 'Minimal satu email tujuan diperlukan.' });
  }

  const invalid = emailList.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (invalid.length) {
    return res.status(400).json({ error: `Email tidak valid: ${invalid.join(', ')}` });
  }

  const transporter = createTransporter();
  const attachments = getCvAttachment();

  try {
    await transporter.sendMail({
      from: `"${process.env.SENDER_NAME || 'Job Applicant'}" <${process.env.SENDER_EMAIL}>`,
      to: emailList.join(', '),
      subject,
      text: body,
      attachments,
    });
    logger.info(`Email terkirim ke ${emailList.join(', ')}`);
    res.json({ success: true, message: `Email berhasil dikirim ke ${emailList.join(', ')}` });
  } catch (error) {
    logger.error('Gagal kirim email', { error: error.message });
    res.status(500).json({ error: `Gagal mengirim email: ${error.message}` });
  }
});

// 3. Batch send
app.post('/api/send-batch', emailLimiter, async (req, res) => {
  const { emails } = req.body;

  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'Field "emails" harus berupa array dengan minimal 1 item.' });
  }

  const transporter = createTransporter();
  const attachments = getCvAttachment();
  const results = [];

  for (const item of emails) {
    const { to, subject, body } = item;
    if (!to || !subject || !body) {
      results.push({ to, status: 'skipped', reason: 'Data tidak lengkap' });
      continue;
    }
    try {
      await transporter.sendMail({
        from: `"${process.env.SENDER_NAME || 'Job Applicant'}" <${process.env.SENDER_EMAIL}>`,
        to,
        subject,
        text: body,
        attachments,
      });
      results.push({ to, status: 'sent' });
    } catch (error) {
      results.push({ to, status: 'failed', reason: error.message });
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  logger.info(`Batch: ${sent}/${results.length} terkirim`);
  res.json({ results });
});

// ── Multer error handler ─────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Ukuran file terlalu besar (maks 10MB per file).' });
  }
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Terjadi kesalahan internal server.' });
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`Server berjalan di http://localhost:${PORT}`);
  if (aiProviders.length === 0) logger.warn('Tidak ada AI provider (9Router / Gemini) dikonfigurasi di .env');
  if (process.env['9ROUTER_API_KEY']) logger.info(`9Router: ${process.env['9ROUTER_MODEL'] || 'gpt-4o'}`);
  if (process.env['GOOGLE_AI_STUDIO_API_KEY']) logger.info(`Gemini (SDK asli): ${process.env['GOOGLE_AI_STUDIO_MODEL'] || 'gemini-2.5-flash'}`);
  if (!process.env.SMTP_SERVER) logger.warn('Konfigurasi SMTP belum lengkap di .env');
});
