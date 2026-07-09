/**
 * ============================================================
 *  WHATSAPP GATEKEEPER BOT
 *  Sistem Penyaring Tamu Otomatis untuk WhatsApp Rumah
 *  Menggunakan: @whiskeysockets/baileys (NPM murni, tanpa URL git)
 *  Style: CommonJS (require)
 * ============================================================
 */

'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// ============================================================
// 1. DATABASE ANGGOTA KELUARGA
//    Sesuaikan dengan data keluarga Anda yang sebenarnya.
// ============================================================

const DATABASE_KELUARGA = [
  {
    namaResmi: 'M Aidil Alamsyah',
    panggilanUtama: 'Aidil',
    nomor: '6285175281143@s.whatsapp.net',
    alternatifPanggilan: ['aidil', 'edil', 'm aidil', 'm aidil alamsyah', 'edil ahtera'],
  },
];

// ============================================================
// 2. DATABASE PERUSAHAAN KURIR RESMI
// ============================================================

const DATABASE_KURIR = [
  'jne', 'j&t', 'jnt', 'sicepat', 'anteraja', 'gojek', 'grab',
  'shopee', 'shopeeexpress', 'shopee express', 'tiki', 'pos indonesia',
  'pos', 'lion parcel', 'ninja express', 'ninja', 'rpx', 'jalur nugraha',
  'ekakurir', 'wahana', 'first logistics', 'idexpress', 'id express',
  'lalamove', 'borzo', 'instant', 'paxel', 'gosend', 'grab express',
];

// Kata kunci konten yang menandakan pesan dari kurir (minimal 3 harus ada)
const KATA_KUNCI_KURIR = ['dari', 'pengirim', 'tujuan', 'kepada', 'resi', 'nomor resi', 'alamat', 'paket'];

// ============================================================
// 3. NOMOR YANG DIGUNAKAN BOT UNTUK LOGIN
//    Isi dengan nomor WhatsApp yang akan dipakai bot (format: 628xxx)
// ============================================================

const NOMOR_BOT = '6285186655283'; // Nomor WhatsApp bot

// ============================================================
// 4. STATE GLOBAL APLIKASI
// ============================================================

/**
 * State proses skrining tamu:
 * { [guestJid]: { step: 1|2|3|'selesai', namaLengkap?, targetKeluarga?, tujuan? } }
 */
const stateScreening = {};

/**
 * State live chat bridge per anggota keluarga:
 * { [familyJid]: { guestJid: string, active: boolean } | null }
 */
const stateBridge = {};

/**
 * Kunci per-keluarga untuk menghindari race condition saat aktivasi bridge.
 * Tidak ada Promise.lock bawaan JS; kita gunakan flag boolean.
 * { [familyJid]: boolean }
 */
const bridgeLock = {};

/**
 * Antrean tamu per anggota keluarga (FIFO):
 * { [familyJid]: Array<{ guestJid, namaLengkap, tujuan }> }
 */
const antreanTamu = {};

/**
 * Buffer debounce per pasangan arah kirim:
 * { [key: `${fromJid}=>${toJid}`]: { timer: NodeJS.Timeout | null, messages: string[] } | null }
 */
const messageBuffer = {};

// Referensi socket global (satu instance aktif sekaligus)
let sock = null;

// Guard pairing: mencegah requestPairingCode dipanggil lebih dari sekali per sesi
let sudahMintaPairingCode = false;

// Flag reconnect: mencegah loop reconnect ganda
let sedangReconnect = false;

// ============================================================
// 5. HELPER FUNCTIONS
// ============================================================

/** Menunggu sejumlah milidetik (async delay). */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Mengirim pesan teks sederhana ke JID tertentu. */
async function kirimPesan(jid, teks) {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { text: teks });
  } catch (err) {
    console.error(`[ERROR] Gagal mengirim pesan ke ${jid}:`, err.message);
  }
}

/**
 * Mengirim pesan kontak (vCard) ke JID tertentu.
 * @param {string} tujuanJid - Penerima pesan
 * @param {object} anggotaKeluarga - Objek dari DATABASE_KELUARGA
 */
async function kirimKontakVCard(tujuanJid, anggotaKeluarga) {
  if (!sock) return;
  try {
    const nomorBersih = '+' + anggotaKeluarga.nomor.replace('@s.whatsapp.net', '');

    const vcard =
      `BEGIN:VCARD\n` +
      `VERSION:3.0\n` +
      `FN:${anggotaKeluarga.namaResmi}\n` +
      `TEL;type=CELL;type=VOICE;waid=${anggotaKeluarga.nomor.replace('@s.whatsapp.net', '')}:${nomorBersih}\n` +
      `END:VCARD`;

    await sock.sendMessage(tujuanJid, {
      contacts: {
        displayName: anggotaKeluarga.namaResmi,
        contacts: [{ vcard }],
      },
    });
  } catch (err) {
    console.error(`[ERROR] Gagal mengirim vCard ke ${tujuanJid}:`, err.message);
  }
}

/**
 * Mencari anggota keluarga berdasarkan nama panggilan (case-insensitive).
 * @returns {object|null} Objek anggota keluarga atau null jika tidak ditemukan
 */
function cariKeluarga(namaInput) {
  const input = namaInput.trim().toLowerCase();
  return DATABASE_KELUARGA.find(anggota =>
    anggota.alternatifPanggilan.some(alias => alias.toLowerCase() === input) ||
    anggota.panggilanUtama.toLowerCase() === input ||
    anggota.namaResmi.toLowerCase() === input
  ) || null;
}

/** Mengecek apakah JID adalah anggota keluarga terdaftar. */
function adalahKeluarga(jid) {
  return DATABASE_KELUARGA.some(anggota => anggota.nomor === jid);
}

/**
 * Mendeteksi apakah pesan berasal dari kurir berdasarkan konten teks.
 * @returns {{ adalahKurir: boolean, namaKurir: string, targetKeluarga: object|null } | null}
 */
function deteksiKurir(teks) {
  const lower = teks.toLowerCase();

  // Pesan kurir harus mengandung minimal 3 kata kunci dari daftar
  const kataKunciDitemukan = KATA_KUNCI_KURIR.filter(kata => lower.includes(kata));
  if (kataKunciDitemukan.length < 3) return null;

  // Harus ada nama perusahaan kurir
  const kurirDitemukan = DATABASE_KURIR.find(kurir => lower.includes(kurir));
  if (!kurirDitemukan) return null;

  // Coba cocokkan nama anggota keluarga yang disebut dalam teks
  let targetKeluarga = null;
  for (const anggota of DATABASE_KELUARGA) {
    const semuaNama = [anggota.namaResmi, anggota.panggilanUtama, ...anggota.alternatifPanggilan];
    if (semuaNama.some(nama => lower.includes(nama.toLowerCase()))) {
      targetKeluarga = anggota;
      break;
    }
  }

  return { adalahKurir: true, namaKurir: kurirDitemukan.toUpperCase(), targetKeluarga };
}

// ============================================================
// 6. PEMBATALAN BUFFER DEBOUNCE (dipanggil saat bridge berakhir)
// ============================================================

/**
 * Membatalkan semua buffer debounce yang melibatkan JID tertentu.
 * Mencegah pesan lama terkirim setelah sesi bridge diakhiri.
 * @param {string} jidA - JID pertama (keluarga atau tamu)
 * @param {string} jidB - JID kedua (pasangannya)
 */
function batalkanBuffer(jidA, jidB) {
  const keyAB = `${jidA}=>${jidB}`;
  const keyBA = `${jidB}=>${jidA}`;

  for (const key of [keyAB, keyBA]) {
    if (messageBuffer[key]) {
      if (messageBuffer[key].timer) clearTimeout(messageBuffer[key].timer);
      messageBuffer[key] = null;
    }
  }
}

// ============================================================
// 7. LOGIKA ANTREAN & LIVE CHAT BRIDGE
// ============================================================

/**
 * Memulai sesi live chat bridge antara tamu dan anggota keluarga.
 * Memberikan notifikasi ke kedua pihak.
 */
async function mulaiLiveChatBridge(familyJid, tamuData) {
  const { guestJid, namaLengkap, tujuan } = tamuData;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilanKeluarga = keluarga ? keluarga.panggilanUtama : 'Anggota Keluarga';

  // Daftarkan bridge aktif
  stateBridge[familyJid] = { guestJid, active: true };

  await kirimPesan(familyJid,
    `🔔 *[LIVE CHAT AKTIF]*\n\n` +
    `Anda sekarang terhubung dengan:\n` +
    `👤 Nama: *${namaLengkap}*\n` +
    `📌 Keperluan: _${tujuan}_\n\n` +
    `_Ketik pesan Anda dan akan langsung diteruskan._\n` +
    `Ketik *EXIT* untuk mengakhiri sesi.\n` +
    `Ketik *Abaikan* untuk memutus dan menolak tamu ini.`
  );

  await kirimPesan(guestJid,
    `✅ *Anda telah terhubung dengan ${panggilanKeluarga}.*\n\n` +
    `Silakan lanjutkan percakapan Anda.\n` +
    `Ketik *EXIT* untuk mengakhiri sesi kapan saja.`
  );

  console.log(`[BRIDGE] Aktif: ${namaLengkap} (${guestJid}) <-> ${panggilanKeluarga} (${familyJid})`);
}

/**
 * Mengakhiri sesi live chat bridge dan memproses antrean berikutnya.
 * @param {string} familyJid - JID anggota keluarga
 * @param {boolean} diabaikan - Jika true, tamu menerima pesan penolakan sopan
 */
async function akhiriLiveChatBridge(familyJid, diabaikan = false) {
  const bridge = stateBridge[familyJid];
  if (!bridge || !bridge.active) return;

  const { guestJid } = bridge;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilanKeluarga = keluarga ? keluarga.panggilanUtama : 'Anggota Keluarga';

  // Tandai bridge tidak aktif sebelum operasi async lainnya (cegah double-termination)
  stateBridge[familyJid] = null;

  // Batalkan semua buffer debounce yang menggantung antar kedua JID ini
  batalkanBuffer(familyJid, guestJid);

  if (diabaikan) {
    await kirimPesan(guestJid,
      `ℹ️ Mohon maaf, saat ini *${panggilanKeluarga}* tidak dapat melanjutkan percakapan.\n` +
      `Silakan coba hubungi kembali di lain waktu. Terima kasih.`
    );
    await kirimPesan(familyJid, `✅ Sesi dengan tamu telah diputuskan.`);
  } else {
    await kirimPesan(guestJid, `👋 Sesi chat telah berakhir. Terima kasih telah menghubungi kami.`);
    await kirimPesan(familyJid, `✅ Sesi live chat telah berakhir.`);
  }

  console.log(`[BRIDGE] Sesi diakhiri: ${guestJid} <-> ${familyJid}${diabaikan ? ' (diabaikan)' : ''}`);

  // Bersihkan state screening tamu yang baru saja selesai
  delete stateScreening[guestJid];

  // Proses antrean berikutnya
  await prosesAntreanBerikutnya(familyJid);
}

/**
 * Memproses tamu berikutnya dalam antrean (FIFO).
 */
async function prosesAntreanBerikutnya(familyJid) {
  const antrean = antreanTamu[familyJid];
  if (!antrean || antrean.length === 0) return;

  // Ambil tamu pertama
  const tamuBerikutnya = antrean.shift();

  console.log(`[ANTREAN] Memproses tamu berikutnya untuk ${familyJid}: ${tamuBerikutnya.namaLengkap}`);

  await kirimPesan(tamuBerikutnya.guestJid,
    `🎯 *Giliran Anda tiba!*\n` +
    `Anda sekarang akan dihubungkan. Mohon tunggu sebentar...`
  );

  await delay(1000);
  await mulaiLiveChatBridge(familyJid, tamuBerikutnya);

  // Update posisi antrean untuk tamu yang masih menunggu
  for (let i = 0; i < antrean.length; i++) {
    await kirimPesan(antrean[i].guestJid,
      `ℹ️ Update antrean: Anda sekarang berada di posisi *#${i + 1}*.`
    );
  }
}

/**
 * Menambahkan tamu ke antrean dengan penguncian atomik per keluarga.
 * Menggunakan bridgeLock untuk mencegah race condition saat dua tamu
 * menyelesaikan screening bersamaan untuk keluarga yang sama.
 */
async function tambahAtauBridgeTamu(familyJid, tamuData) {
  // Tunggu jika kunci sedang aktif (loop polling sederhana, aman untuk single-thread Node.js)
  while (bridgeLock[familyJid]) {
    await delay(50);
  }

  // Kunci bagian kritis
  bridgeLock[familyJid] = true;

  try {
    const bridgeAktif = stateBridge[familyJid];

    if (!bridgeAktif || !bridgeAktif.active) {
      // KONDISI A: Kosong — langsung aktifkan bridge
      await mulaiLiveChatBridge(familyJid, tamuData);
    } else {
      // KONDISI B: Sibuk — masukkan ke antrean
      if (!antreanTamu[familyJid]) antreanTamu[familyJid] = [];
      antreanTamu[familyJid].push(tamuData);

      const posisi = antreanTamu[familyJid].length;
      const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
      const panggilanKeluarga = keluarga ? keluarga.panggilanUtama : 'Anggota Keluarga';

      await kirimPesan(tamuData.guestJid,
        `⏳ *${panggilanKeluarga}* sedang melayani tamu lain.\n\n` +
        `Anda telah dimasukkan ke antrean.\n` +
        `📋 Posisi Antrean Anda: *#${posisi}*\n\n` +
        `Kami akan menghubungi Anda segera setelah giliran tiba.`
      );

      // Notifikasi interupsi senyap ke anggota keluarga
      await kirimPesan(familyJid,
        `🔔 *[INFO ANTREAN]*\n` +
        `Tamu baru *${tamuData.namaLengkap}* menunggu di antrean #${posisi}.\n` +
        `Keperluan: _${tamuData.tujuan}_`
      );

      console.log(`[ANTREAN] ${tamuData.namaLengkap} (${tamuData.guestJid}) di antrean #${posisi} untuk ${familyJid}`);
    }
  } finally {
    // Selalu lepaskan kunci
    bridgeLock[familyJid] = false;
  }
}

// ============================================================
// 8. MESSAGE BUFFER (DEBOUNCE ANTI-SPAM 2.5 DETIK)
// ============================================================

/**
 * Buffer pesan dengan debounce 2.5 detik.
 * Mengumpulkan pesan pendek berturut-turut dan mengirimnya sekaligus
 * agar tidak terjadi spam notifikasi.
 * @param {string} fromJid       - Pengirim asli
 * @param {string} toJid         - Penerima pesan gabungan
 * @param {string} teks          - Isi pesan
 * @param {string} labelPengirim - Label prefix pesan (misal: "💬 *Budi:*")
 */
function bufferDanKirimPesan(fromJid, toJid, teks, labelPengirim) {
  const key = `${fromJid}=>${toJid}`;

  if (!messageBuffer[key]) {
    messageBuffer[key] = { timer: null, messages: [] };
  }

  messageBuffer[key].messages.push(teks);

  // Reset timer setiap kali pesan baru masuk (debounce)
  if (messageBuffer[key].timer) clearTimeout(messageBuffer[key].timer);

  messageBuffer[key].timer = setTimeout(async () => {
    const entry = messageBuffer[key];
    messageBuffer[key] = null; // Kosongkan entry sebelum async agar tidak duplikat

    if (!entry || entry.messages.length === 0) return;

    const gabungan = entry.messages.join('\n');
    const pesanAkhir = labelPengirim ? `${labelPengirim}\n${gabungan}` : gabungan;
    await kirimPesan(toJid, pesanAkhir);
  }, 2500);
}

// ============================================================
// 9. LOGIKA GATEKEEPER — FORMULIR SKRINING 3 LANGKAH
// ============================================================

/** Memulai proses skrining untuk tamu baru. */
async function mulaiSkrining(guestJid) {
  stateScreening[guestJid] = { step: 1 };

  await kirimPesan(guestJid,
    `👋 *Selamat datang!*\n\n` +
    `Anda telah menghubungi sistem Gatekeeper rumah ini.\n` +
    `Untuk dapat terhubung, mohon jawab beberapa pertanyaan berikut.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `*Pertanyaan 1 dari 3:*\n` +
    `Siapa *Nama Lengkap* Anda?`
  );
}

/** Memproses jawaban formulir skrining secara bertahap. */
async function prosesJawabanSkrining(guestJid, teks) {
  const state = stateScreening[guestJid];
  if (!state) return;

  if (state.step === 1) {
    // Simpan nama lengkap
    state.namaLengkap = teks.trim();
    state.step = 2;

    await kirimPesan(guestJid,
      `Terima kasih, *${state.namaLengkap}*.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `*Pertanyaan 2 dari 3:*\n` +
      `Siapa nama anggota keluarga di rumah ini yang ingin Anda hubungi?\n\n` +
      `_(Ketik nama panggilan, contoh: Budi, Ibu, Rizki, dll.)_`
    );

  } else if (state.step === 2) {
    // Validasi nama keluarga
    const keluargaDitemukan = cariKeluarga(teks);

    if (!keluargaDitemukan) {
      const daftarPanggilan = DATABASE_KELUARGA.map(a => a.panggilanUtama).join(', ');
      await kirimPesan(guestJid,
        `❌ Maaf, nama "*${teks.trim()}*" tidak ditemukan dalam daftar keluarga kami.\n\n` +
        `Silakan ketik ulang nama yang benar.\n` +
        `_Contoh nama yang valid: ${daftarPanggilan}_`
      );
      return; // Tetap di step 2
    }

    state.targetKeluarga = keluargaDitemukan;
    state.step = 3;

    await kirimPesan(guestJid,
      `✅ Baik, Anda ingin menghubungi *${keluargaDitemukan.panggilanUtama}*.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `*Pertanyaan 3 dari 3:*\n` +
      `Apa *Tujuan/Kepentingan* Anda menghubungi *${keluargaDitemukan.panggilanUtama}*?`
    );

  } else if (state.step === 3) {
    // Simpan tujuan dan proses masuk ke bridge/antrean
    state.tujuan = teks.trim();
    state.step = 'selesai';

    const keluarga = state.targetKeluarga;

    const tamuData = {
      guestJid,
      namaLengkap: state.namaLengkap,
      tujuan: state.tujuan,
    };

    await kirimPesan(guestJid,
      `✅ *Formulir selesai diisi!*\n\n` +
      `📋 Ringkasan:\n` +
      `• Nama: ${state.namaLengkap}\n` +
      `• Ingin bicara dengan: ${keluarga.panggilanUtama}\n` +
      `• Keperluan: ${state.tujuan}\n\n` +
      `_Mohon tunggu, kami sedang menghubungkan Anda..._`
    );

    await delay(1000);

    // Masukkan ke bridge atau antrean (dengan kunci atomik)
    await tambahAtauBridgeTamu(keluarga.nomor, tamuData);
  }
}

// ============================================================
// 10. HANDLER PESAN MASUK (ROUTER UTAMA)
// ============================================================

/** Handler utama untuk semua pesan masuk. */
async function handlePesanMasuk(message) {
  const jid = message.key.remoteJid;

  // Abaikan pesan dari grup, broadcast status, atau pesan dari bot sendiri
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || message.key.fromMe) return;

  // Ekstrak isi teks dari berbagai tipe pesan
  const msg = message.message;
  const teks =
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    '';

  if (!teks) return; // Abaikan pesan non-teks (stiker, audio, dll.)

  const teksUpper = teks.trim().toUpperCase();

  console.log(`[PESAN] Dari: ${jid} | "${teks.substring(0, 80)}"`);

  // ────────────────────────────────────────────────
  // BLOK A: Pesan dari ANGGOTA KELUARGA
  // ────────────────────────────────────────────────
  if (adalahKeluarga(jid)) {
    const familyJid = jid;
    const bridge = stateBridge[familyJid];

    // Jika tidak ada bridge aktif, abaikan pesan
    if (!bridge || !bridge.active) return;

    const guestJid = bridge.guestJid;

    // Kata kunci "Abaikan" — putuskan tamu dengan pesan penolakan sopan
    if (teks.trim().toLowerCase() === 'abaikan') {
      await akhiriLiveChatBridge(familyJid, true);
      return;
    }

    // Kata kunci "EXIT" — akhiri sesi normal
    if (teksUpper === 'EXIT') {
      await akhiriLiveChatBridge(familyJid, false);
      return;
    }

    // Teruskan pesan keluarga ke tamu (dengan buffer debounce)
    const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
    bufferDanKirimPesan(familyJid, guestJid, teks, `💬 *${keluarga?.panggilanUtama || 'Keluarga'}:*`);
    return;
  }

  // ────────────────────────────────────────────────
  // BLOK B: Pesan dari TAMU (nomor asing)
  // ────────────────────────────────────────────────
  const guestJid = jid;

  // Cek apakah tamu sedang dalam bridge aktif
  const bridgeEntry = Object.entries(stateBridge).find(
    ([, val]) => val && val.active && val.guestJid === guestJid
  );

  if (bridgeEntry) {
    const [familyJid] = bridgeEntry;

    // Tamu ketik EXIT — akhiri sesi
    if (teksUpper === 'EXIT') {
      await akhiriLiveChatBridge(familyJid, false);
      return;
    }

    // Teruskan pesan tamu ke anggota keluarga (dengan buffer debounce)
    const screenState = stateScreening[guestJid];
    const namaLabel = screenState?.namaLengkap || 'Tamu';
    bufferDanKirimPesan(guestJid, familyJid, teks, `📩 *${namaLabel}:*`);
    return;
  }

  // Cek apakah tamu sedang dalam antrean
  const dalamAntrean = Object.values(antreanTamu).some(antrean =>
    antrean && antrean.some(t => t.guestJid === guestJid)
  );

  if (dalamAntrean) {
    // Beritahu posisi antrean saat ini
    for (const [familyJid, antrean] of Object.entries(antreanTamu)) {
      if (!antrean) continue;
      const posisi = antrean.findIndex(t => t.guestJid === guestJid) + 1;
      if (posisi > 0) {
        await kirimPesan(guestJid,
          `⏳ Anda masih dalam antrean posisi *#${posisi}*. Mohon bersabar.`
        );
        break;
      }
    }
    return;
  }

  // ────────────────────────────────────────────────
  // DETEKSI KURIR — Bypass formulir skrining
  // ────────────────────────────────────────────────
  const deteksi = deteksiKurir(teks);

  if (deteksi) {
    console.log(`[KURIR] Terdeteksi dari ${guestJid}. Kurir: ${deteksi.namaKurir}`);

    if (deteksi.targetKeluarga) {
      const keluarga = deteksi.targetKeluarga;

      // Notifikasi ke anggota keluarga yang dituju
      await kirimPesan(keluarga.nomor,
        `📦 *[NOTIFIKASI PAKET]*\n\n` +
        `Ada paket masuk dari kurir *${deteksi.namaKurir}*!\n\n` +
        `📋 Pesan kurir:\n_${teks}_\n\n` +
        `Kontak kurir: ${guestJid.replace('@s.whatsapp.net', '')}`
      );

      // Konfirmasi ke kurir + kirim vCard anggota keluarga
      await kirimPesan(guestJid,
        `✅ *Konfirmasi Diterima*\n\n` +
        `Terima kasih! Pesan untuk *${keluarga.namaResmi}* telah diterima.\n` +
        `Berikut kontak WhatsApp yang dapat Anda hubungi langsung:`
      );
      await delay(500);
      await kirimKontakVCard(guestJid, keluarga);

    } else {
      // Kurir terdeteksi tapi nama keluarga tidak ada dalam teks
      await kirimPesan(guestJid,
        `✅ Pesan kurir Anda telah diterima.\n` +
        `Mohon sebutkan nama penerima paket agar kami dapat menghubungi yang bersangkutan.`
      );

      // Notifikasi umum ke semua anggota keluarga
      for (const anggota of DATABASE_KELUARGA) {
        await kirimPesan(anggota.nomor,
          `📦 *[NOTIFIKASI PAKET]*\n\n` +
          `Ada kurir *${deteksi.namaKurir}* — nama penerima tidak terdeteksi otomatis.\n\n` +
          `📋 Pesan kurir:\n_${teks}_`
        );
      }
    }

    return;
  }

  // ────────────────────────────────────────────────
  // PROSES SKRINING 3 LANGKAH
  // ────────────────────────────────────────────────
  const screeningState = stateScreening[guestJid];

  if (!screeningState) {
    // Tamu baru — mulai skrining
    console.log(`[GATEKEEPER] Tamu baru: ${guestJid}`);
    await mulaiSkrining(guestJid);
    return;
  }

  if (screeningState.step === 'selesai') {
    // Formulir sudah selesai, tamu mungkin mengirim pesan sambil menunggu
    await kirimPesan(guestJid, `ℹ️ Formulir Anda sudah diterima. Mohon tunggu giliran Anda.`);
    return;
  }

  // Lanjutkan langkah skrining
  await prosesJawabanSkrining(guestJid, teks);
}

// ============================================================
// 11. KONEKSI BAILEYS (PAIRING CODE — STABIL UNTUK CLOUD)
// ============================================================

async function mulaiKoneksi() {
  // Reset guard pairing untuk sesi koneksi baru
  sudahMintaPairingCode = false;

  // Muat atau buat state autentikasi dari folder lokal
  const { state: authState, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  // Buat instance socket Baileys dengan konfigurasi optimal untuk cloud
  sock = makeWASocket({
    auth: authState,
    logger: pino({ level: 'silent' }),  // Sembunyikan log internal Baileys
    printQRInTerminal: false,            // JANGAN gunakan QR code
    connectTimeoutMs: 60000,             // Timeout koneksi: 60 detik
    keepAliveIntervalMs: 30000,          // Keep-alive setiap 30 detik
    syncFullHistory: false,              // Tidak perlu riwayat penuh
    markOnlineOnConnect: false,          // Tidak tampak online saat konek
  });

  // ── Simpan kredensial setiap kali ada perubahan ──
  sock.ev.on('creds.update', saveCreds);

  // ── Handler Status Koneksi ──
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('\n✅ [KONEKSI] Bot berhasil terhubung ke WhatsApp!\n');
      sedangReconnect = false;

      // Minta Pairing Code hanya jika belum teregistrasi dan belum pernah diminta
      // Jeda 7 detik setelah connection open agar Noise Protocol (enkripsi biner)
      // matang sepenuhnya — ini krusial untuk stabilitas di server cloud.
      if (!authState.creds.registered && !sudahMintaPairingCode) {
        sudahMintaPairingCode = true; // Kunci guard sebelum async dimulai

        console.log('[PAIRING] Menunggu 7 detik agar jalur enkripsi matang...');
        await delay(7000);

        // Pastikan socket masih sama (belum disconnect saat menunggu)
        if (!sock || !sudahMintaPairingCode) return;

        try {
          const nomorBersih = NOMOR_BOT.replace(/[^0-9]/g, '');
          const pairingCode = await sock.requestPairingCode(nomorBersih);

          console.log('\n');
          console.log('╔════════════════════════════════════════╗');
          console.log('║        KODE PAIRING WHATSAPP            ║');
          console.log('╠════════════════════════════════════════╣');
          console.log(`║  KODE: ${pairingCode.padEnd(8)}                     ║`);
          console.log('╠════════════════════════════════════════╣');
          console.log('║  Cara pairing:                          ║');
          console.log('║  1. Buka WhatsApp di HP Anda            ║');
          console.log('║  2. Pengaturan > Perangkat Tertaut       ║');
          console.log('║  3. Tautkan dengan Nomor Telepon         ║');
          console.log('║  4. Masukkan kode di atas               ║');
          console.log('╚════════════════════════════════════════╝');
          console.log('\n');
        } catch (err) {
          console.error('[PAIRING] Gagal meminta kode:', err.message);
          sudahMintaPairingCode = false; // Reset agar bisa coba lagi saat reconnect
        }
      }
    }

    if (connection === 'close') {
      const statusKode = lastDisconnect?.error?.output?.statusCode;
      const alasanDisconnect = Object.keys(DisconnectReason).find(
        k => DisconnectReason[k] === statusKode
      ) || `Kode ${statusKode}`;

      console.log(`⚠️ [KONEKSI] Terputus. Alasan: ${alasanDisconnect} (${statusKode})`);

      // Hentikan semua event listener socket lama sebelum membuat yang baru
      sock.ev.removeAllListeners();
      sock = null;

      const harus_logout = statusKode === DisconnectReason.loggedOut;

      if (harus_logout) {
        console.log('[KONEKSI] Sesi dikeluarkan (logged out). Hapus folder auth_info_baileys dan jalankan ulang.');
        process.exit(1);
      }

      // Reconnect otomatis dengan guard agar tidak ada dua proses reconnect berjalan
      if (!sedangReconnect) {
        sedangReconnect = true;
        console.log('[KONEKSI] Mencoba menghubungkan kembali dalam 5 detik...');
        await delay(5000);
        mulaiKoneksi(); // Buat instance socket baru yang bersih
      }
    }
  });

  // ── Handler Pesan Masuk ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // Hanya proses notifikasi pesan baru

    for (const message of messages) {
      try {
        await handlePesanMasuk(message);
      } catch (err) {
        console.error('[ERROR] Gagal memproses pesan:', err.message);
      }
    }
  });
}

// ============================================================
// 12. ENTRY POINT
// ============================================================

console.log('╔════════════════════════════════════════╗');
console.log('║    WHATSAPP GATEKEEPER BOT DIMULAI      ║');
console.log('╚════════════════════════════════════════╝');
console.log(`[INFO] Nomor Bot : ${NOMOR_BOT}`);
console.log('[INFO] Memulai koneksi ke WhatsApp...\n');

mulaiKoneksi().catch(err => {
  console.error('[FATAL] Error tidak tertangani:', err);
  process.exit(1);
});
