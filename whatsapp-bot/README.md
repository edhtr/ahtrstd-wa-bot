# WhatsApp Gatekeeper Bot v2

Sistem penyaring tamu otomatis untuk WhatsApp rumah dengan Gemini AI,
menggunakan [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys).

---

## Fitur v2

- **Gemini AI** — tamu berbicara dengan AI sebelum terhubung ke keluarga
- **Skrining cerdas** — 3 pertanyaan hanya muncul saat tamu ingin menghubungi keluarga
- **Tolak panggilan otomatis** — panggilan masuk ditolak dan pemanggil diberi tahu
- **Nama tampilan fleksibel** — tamu muncul dengan nama yang mereka pakai, bukan nomor telepon
- **Chat keluar dengan nama** — saat keluarga menghubungi kontak baru, bisa pilih nama tampilan
- **Verifikasi file** — blokir .apk dan file berbahaya; hanya terima PDF, Word, Excel, PPT
- **Verifikasi link** — link mencurigakan diblokir sebelum diteruskan ke keluarga
- **Verifikasi teks** — cegah pesan acak/spam dari tamu
- **Read receipt** — pesan otomatis ditandai dibaca di sesi live chat
- **Reaksi & edit pesan** — reaksi dan edit diteruskan ke sisi lain sesi chat
- **GIF & stiker** — diteruskan otomatis di sesi live chat

---

## Deploy ke Railway

### Langkah 1 — Pastikan repo ada di GitHub

### Langkah 2 — Buat project baru di Railway
1. Buka [railway.app](https://railway.app) > **New Project**
2. Pilih **Deploy from GitHub repo**
3. Pilih repo ini

### Langkah 3 — Set Root Directory
Di halaman service Railway > tab **Settings** > **Source**:
- Set **Root Directory** ke: `whatsapp-bot`

### Langkah 4 — Set Environment Variables
Di tab **Variables**, tambahkan:

| Variable        | Nilai              | Keterangan                                        |
|-----------------|--------------------|---------------------------------------------------|
| `NOMOR_BOT`     | `6285186655283`    | Nomor WA bot (tanpa +) — **WAJIB**                |
| `GEMINI_API_KEY`| `AIza...`          | API Key Gemini dari Google AI Studio — **SANGAT DIANJURKAN** |
| `AUTH_DIR`      | `/data/auth`       | Hanya jika pakai Railway Volume (opsional)        |
| `NAMA_BOT`      | `Islah`            | Nama persona bot (opsional)                       |
| `NAMA_KELUARGA` | `Dil Familie`      | Nama keluarga (opsional)                          |

**Cara dapat GEMINI_API_KEY (gratis):**
1. Buka [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Login dengan akun Google
3. Klik **Create API Key**
4. Salin key dan set sebagai env var di Railway

### Langkah 5 — Deploy
Klik **Deploy**. Railway otomatis `npm install` lalu `node index.js`.

### Langkah 6 — Ambil Pairing Code
Buka tab **Deployments > View Logs**. Tunggu muncul:

```
+------------------------------------------+
|  KODE: XXXX-XXXX                         |
+------------------------------------------+
```

Lalu di HP nomor bot:
1. **Pengaturan > Perangkat Tertaut**
2. **Tautkan dengan Nomor Telepon**
3. Masukkan kode yang muncul di log

---

## Sesi Persisten dengan Railway Volume (Dianjurkan)

Tanpa volume, sesi WhatsApp hilang setiap redeploy. Setup:
1. Di Railway project > **+ New** > **Volume**
2. Mount path: `/data`
3. Attach ke service bot
4. Set env var `AUTH_DIR=/data/auth`

---

## Menjalankan Lokal

```bash
cd whatsapp-bot
npm install
cp .env.example .env
# Edit .env sesuai nomor bot dan API key Anda
npm start
```

---

## Konfigurasi Anggota Keluarga

Buka `index.js` dan edit bagian **DATABASE ANGGOTA KELUARGA** (sekitar baris 20):

```js
const DATABASE_KELUARGA = [
  {
    namaResmi: 'Budi Santoso',
    panggilanUtama: 'Budi',
    nomor: '6281234567890@s.whatsapp.net',
    alternatifPanggilan: ['ayah', 'budi', 'bapak', 'pak budi'],
  },
  // tambah anggota lainnya...
];
```

---

## Alur Bot (dengan Gemini AI aktif)

```
Tamu kirim pesan
      |
      v
Gemini AI merespons (percakapan bebas)
      |
      v
Tamu ingin hubungi anggota keluarga?
      |
     YA
      |
      v
Formulir singkat:
  1. Nama lengkap Anda?
  2. Keperluan dengan [anggota keluarga]?
      |
      v
Anggota keluarga diberitahu → Y untuk terima, N untuk tolak
      |
     YA
      |
      v
Sesi live chat aktif (ketik N untuk mengakhiri)
```

## Perintah Keluarga

| Perintah          | Fungsi                                              |
|-------------------|-----------------------------------------------------|
| `Y`               | Terima tamu yang menunggu konfirmasi                |
| `N`               | Tolak tamu (saat konfirmasi) / akhiri sesi (saat live chat) |
| `Chat 08123456789`| Hubungi nomor baru (bot akan minta nama tampilan)   |
| `#1NAMATGL`       | Hubungi kembali tamu lama via kode                  |

---

## Teknologi

| Library | Versi | Keterangan |
|---------|-------|------------|
| `@whiskeysockets/baileys` | `7.0.0-rc13` | WhatsApp client |
| `@google/generative-ai` | `^0.21.0` | Gemini AI |
| `pino` | `^9` | Logger |
| Node.js | `>=18` | Runtime |
