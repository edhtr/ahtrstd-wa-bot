# WhatsApp Gatekeeper Bot

Sistem penyaring tamu otomatis untuk WhatsApp rumah menggunakan [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — library murni NPM, aman dideploy di Railway/Replit/VPS.

---

## ⚡ Cara Setup & Menjalankan

### 1. Instal Dependensi
```bash
cd whatsapp-bot
npm install
```

### 2. Konfigurasi Data Keluarga
Buka `index.js` dan edit bagian **DATABASE ANGGOTA KELUARGA** (sekitar baris 20):
```js
const DATABASE_KELUARGA = [
  {
    namaResmi: 'Budi Santoso',          // Nama lengkap
    panggilanUtama: 'Budi',              // Nama yang ditampilkan ke tamu
    nomor: '6281234567890@s.whatsapp.net', // Nomor WhatsApp (format: 628xxx)
    alternatifPanggilan: ['ayah', 'budi', 'bapak'], // Nama yang tamu bisa ketik
  },
  // ... tambah anggota keluarga lainnya
];
```

### 3. Set Nomor Bot
Ganti konstanta `NOMOR_BOT` dengan nomor WhatsApp yang akan digunakan bot:
```js
const NOMOR_BOT = '628xxxxxxxxxx'; // Tanpa + dan tanpa spasi
```

### 4. Jalankan Bot
```bash
npm start
```

### 5. Pairing dengan WhatsApp
Bot menggunakan metode **Pairing Code** (bukan QR Code). Setelah bot berjalan:
1. Tunggu kode 8 digit muncul di console
2. Buka WhatsApp di HP Anda
3. Masuk ke **Pengaturan → Perangkat Tertaut → Tautkan dengan Nomor Telepon**
4. Masukkan kode yang tampil di console

Sesi tersimpan di folder `auth_info_baileys/` — tidak perlu pairing ulang setelah restart.

---

## 🔧 Fitur Lengkap

| Fitur | Keterangan |
|-------|-----------|
| **Formulir Skrining 3 Langkah** | Tamu baru harus menjawab: nama lengkap, nama keluarga yang dituju (divalidasi), dan tujuan |
| **Live Chat Bridge** | Setelah skrining, pesan tamu diteruskan dua arah ke anggota keluarga |
| **Sistem Antrean FIFO** | Jika keluarga sedang bicara dengan tamu lain, tamu baru masuk antrean dengan notifikasi posisi |
| **Anti-Spam (Debounce)** | Pesan pendek berturut-turut digabung dalam jeda 2.5 detik sebelum dikirim |
| **Perintah EXIT** | Ketik `EXIT` (keluarga atau tamu) untuk mengakhiri sesi |
| **Perintah Abaikan** | Keluarga ketik `Abaikan` → tamu mendapat pesan penolakan sopan, sesi langsung putus |
| **Bypass Kurir Otomatis** | Pesan berformat kurir langsung dideteksi, keluarga dinotifikasi, vCard dikirim ke kurir |
| **Reconnect Otomatis** | Bot otomatis konek ulang jika terputus, tanpa duplikasi listener |

---

## 📁 Struktur File

```
whatsapp-bot/
├── index.js              # Kode utama bot (satu file lengkap)
├── package.json          # Dependensi NPM
├── README.md             # Dokumentasi ini
└── auth_info_baileys/    # Folder sesi (dibuat otomatis saat pairing)
```

---

## 🚀 Deploy ke Railway / Replit

Bot ini menggunakan NPM murni tanpa URL GitHub, sehingga aman untuk semua platform cloud.

**Penting:** Setelah deploy, pastikan folder `auth_info_baileys/` bersifat **persistent** (tidak terhapus saat restart). Di Railway, gunakan volume storage. Di Replit, file sudah otomatis persisten.

---

## 🛠 Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Bot tidak bisa pairing | Pastikan nomor bot benar di `NOMOR_BOT`, hapus folder `auth_info_baileys/` lalu coba ulang |
| Sesi habis / logged out | Hapus folder `auth_info_baileys/`, jalankan ulang, dan pairing ulang |
| Pesan tidak terkirim | Cek koneksi internet server dan pastikan nomor keluarga di database sudah benar (format `628xxx@s.whatsapp.net`) |
