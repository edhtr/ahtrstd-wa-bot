# WhatsApp Gatekeeper Bot

Sistem penyaring tamu otomatis untuk WhatsApp rumah menggunakan [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — library murni NPM, aman dideploy di Railway/Replit/VPS.

---

## 🚀 Deploy ke Railway (dari GitHub)

### Langkah 1 — Fork / Clone repo
Pastikan repo sudah ada di GitHub Anda.

### Langkah 2 — Buat project baru di Railway
1. Buka [railway.app](https://railway.app) → **New Project**
2. Pilih **Deploy from GitHub repo**
3. Pilih repo ini

### Langkah 3 — Set Root Directory
Di halaman service Railway:
- Klik tab **Settings**
- Di bagian **Source**, set **Root Directory** ke: `whatsapp-bot`

### Langkah 4 — Set Environment Variables
Di tab **Variables**, tambahkan:

| Variable    | Nilai                    | Keterangan                                |
|-------------|--------------------------|-------------------------------------------|
| `NOMOR_BOT` | `6285186655283`          | Nomor WA bot (tanpa +)                    |
| `AUTH_DIR`  | `/data/auth` *(opsional)* | Hanya jika pakai Railway Volume (lihat §) |

### Langkah 5 — Deploy
Klik **Deploy** — Railway akan otomatis `npm install` lalu `node index.js`.

### Langkah 6 — Ambil Pairing Code
Buka tab **Deployments → View Logs**. Tunggu muncul:

```
║  KODE: XXXX-XXXX  ║
```

Lalu di HP nomor bot:
1. **Pengaturan → Perangkat Tertaut**
2. **Tautkan dengan Nomor Telepon**
3. Masukkan kode yang muncul di log

---

## 💾 Sesi Persisten dengan Railway Volume (Opsional tapi Dianjurkan)

Tanpa volume, sesi WhatsApp hilang setiap kali redeploy → perlu pairing ulang.

**Cara setup volume:**
1. Di Railway project, klik **+ New** → **Volume**
2. Mount path: `/data`
3. Attach ke service bot
4. Set env var `AUTH_DIR=/data/auth`

Setelah itu sesi tersimpan permanen di volume meskipun redeploy.

---

## ⚡ Menjalankan Lokal

### 1. Install dependensi
```bash
cd whatsapp-bot
npm install
```

### 2. Salin dan edit env
```bash
cp .env.example .env
# Edit .env sesuai nomor bot Anda
```

### 3. Jalankan
```bash
npm start
```

---

## ✏️ Konfigurasi Data Keluarga

Buka `index.js` dan edit bagian **DATABASE ANGGOTA KELUARGA** (sekitar baris 20):

```js
const DATABASE_KELUARGA = [
  {
    namaResmi: 'Budi Santoso',
    panggilanUtama: 'Budi',
    nomor: '6281234567890@s.whatsapp.net',   // format: 628xxx@s.whatsapp.net
    alternatifPanggilan: ['ayah', 'budi', 'bapak'],
  },
  // tambah anggota lainnya...
];
```

---

## 🔄 Alur Bot

```
Tamu kirim pesan
       ↓
[ Formulir 3 langkah ]
  1. Nama lengkap
  2. Ingin bicara dengan siapa?
  3. Keperluan apa?
       ↓
Anggota keluarga diberitahu → jembatan live chat terbuka
       ↓
Keluarga ketik EXIT → akhiri sesi & tawarkan tamu berikutnya
Keluarga ketik Abaikan → lewati tamu ini
```

---

## 🛡️ Fitur

- **Skrining 3 langkah** sebelum terhubung ke anggota keluarga
- **Jembatan live chat** dua arah dengan debounce 2,5 detik
- **Antrian FIFO** jika ada beberapa tamu sekaligus
- **Bypass kurir** — deteksi otomatis pesan pengiriman paket
- **Pairing Code** (tidak butuh scan QR) — aman di server cloud
- **Auto-reconnect** saat koneksi terputus

---

## 📦 Teknologi

| Library | Versi | Keterangan |
|---------|-------|------------|
| `@whiskeysockets/baileys` | `7.0.0-rc13` | WhatsApp client (NPM murni) |
| `pino` | `^9` | Logger ringan |
| Node.js | `>=18` | Runtime |
