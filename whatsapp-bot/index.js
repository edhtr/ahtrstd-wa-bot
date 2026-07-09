/**
 * ============================================================
 *  WHATSAPP GATEKEEPER BOT
 *  Sistem Penyaring Tamu Otomatis untuk WhatsApp Rumah
 *  Menggunakan: @whiskeysockets/baileys v7 (NPM murni, tanpa git URL)
 *  Style: ESM (import/export)
 * ============================================================
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';

// ============================================================
// 1. DATABASE ANGGOTA KELUARGA
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

// Kata kunci konten pesan kurir (minimal 3 harus ada)
const KATA_KUNCI_KURIR = ['dari', 'pengirim', 'tujuan', 'kepada', 'resi', 'nomor resi', 'alamat', 'paket'];

// ============================================================
// 3. NOMOR BOT
// ============================================================

const NOMOR_BOT = '6285186655283';

// ============================================================
// 4. STATE GLOBAL
// ============================================================

/** State skrining: { [guestJid]: { step, namaLengkap?, targetKeluarga?, tujuan? } } */
const stateScreening = {};

/** Bridge aktif per keluarga: { [familyJid]: { guestJid, active } | null } */
const stateBridge = {};

/** Kunci atomik per keluarga untuk cegah race condition: { [familyJid]: boolean } */
const bridgeLock = {};

/** Antrean tamu FIFO: { [familyJid]: Array<{ guestJid, namaLengkap, tujuan }> } */
const antreanTamu = {};

/** Buffer debounce: { [`${from}=>${to}`]: { timer, messages[] } | null } */
const messageBuffer = {};

// Referensi socket aktif (satu instance)
let sock = null;

// Guard pairing: mencegah requestPairingCode dipanggil lebih dari sekali
let sudahMintaPairingCode = false;

// Guard reconnect: mencegah loop ganda
let sedangReconnect = false;

// ============================================================
// 5. HELPER FUNCTIONS
// ============================================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function kirimPesan(jid, teks) {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { text: teks });
  } catch (err) {
    console.error(`[ERROR] Gagal kirim ke ${jid}:`, err.message);
  }
}

async function kirimKontakVCard(tujuanJid, anggota) {
  if (!sock) return;
  try {
    const nomorBersih = '+' + anggota.nomor.replace('@s.whatsapp.net', '');
    const waid = anggota.nomor.replace('@s.whatsapp.net', '');
    const vcard =
      `BEGIN:VCARD\nVERSION:3.0\nFN:${anggota.namaResmi}\n` +
      `TEL;type=CELL;type=VOICE;waid=${waid}:${nomorBersih}\nEND:VCARD`;
    await sock.sendMessage(tujuanJid, {
      contacts: { displayName: anggota.namaResmi, contacts: [{ vcard }] },
    });
  } catch (err) {
    console.error(`[ERROR] Gagal kirim vCard ke ${tujuanJid}:`, err.message);
  }
}

function cariKeluarga(namaInput) {
  const input = namaInput.trim().toLowerCase();
  return DATABASE_KELUARGA.find(a =>
    a.alternatifPanggilan.some(alias => alias.toLowerCase() === input) ||
    a.panggilanUtama.toLowerCase() === input ||
    a.namaResmi.toLowerCase() === input
  ) || null;
}

function adalahKeluarga(jid) {
  return DATABASE_KELUARGA.some(a => a.nomor === jid);
}

function deteksiKurir(teks) {
  const lower = teks.toLowerCase();
  const kataKunciDitemukan = KATA_KUNCI_KURIR.filter(k => lower.includes(k));
  if (kataKunciDitemukan.length < 3) return null;
  const kurirDitemukan = DATABASE_KURIR.find(k => lower.includes(k));
  if (!kurirDitemukan) return null;
  let targetKeluarga = null;
  for (const anggota of DATABASE_KELUARGA) {
    const semuaNama = [anggota.namaResmi, anggota.panggilanUtama, ...anggota.alternatifPanggilan];
    if (semuaNama.some(n => lower.includes(n.toLowerCase()))) {
      targetKeluarga = anggota;
      break;
    }
  }
  return { adalahKurir: true, namaKurir: kurirDitemukan.toUpperCase(), targetKeluarga };
}

// ============================================================
// 6. PEMBATALAN BUFFER DEBOUNCE
// ============================================================

function batalkanBuffer(jidA, jidB) {
  for (const key of [`${jidA}=>${jidB}`, `${jidB}=>${jidA}`]) {
    if (messageBuffer[key]) {
      if (messageBuffer[key].timer) clearTimeout(messageBuffer[key].timer);
      messageBuffer[key] = null;
    }
  }
}

// ============================================================
// 7. LIVE CHAT BRIDGE & ANTREAN
// ============================================================

async function mulaiLiveChatBridge(familyJid, tamuData) {
  const { guestJid, namaLengkap, tujuan } = tamuData;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

  stateBridge[familyJid] = { guestJid, active: true };

  await kirimPesan(familyJid,
    `🔔 *[LIVE CHAT AKTIF]*\n\n` +
    `Terhubung dengan:\n👤 *${namaLengkap}*\n📌 _${tujuan}_\n\n` +
    `Ketik *EXIT* untuk akhiri sesi.\nKetik *Abaikan* untuk putus & tolak tamu.`
  );
  await kirimPesan(guestJid,
    `✅ *Anda terhubung dengan ${panggilan}.*\n\nSilakan kirim pesan Anda.\nKetik *EXIT* untuk mengakhiri sesi.`
  );
  console.log(`[BRIDGE] Aktif: ${namaLengkap} (${guestJid}) <-> ${panggilan} (${familyJid})`);
}

async function akhiriLiveChatBridge(familyJid, diabaikan = false) {
  const bridge = stateBridge[familyJid];
  if (!bridge || !bridge.active) return;

  const { guestJid } = bridge;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

  stateBridge[familyJid] = null;
  batalkanBuffer(familyJid, guestJid);

  if (diabaikan) {
    await kirimPesan(guestJid,
      `ℹ️ Maaf, *${panggilan}* tidak dapat melanjutkan percakapan saat ini. Terima kasih.`
    );
    await kirimPesan(familyJid, `✅ Sesi diputuskan.`);
  } else {
    await kirimPesan(guestJid, `👋 Sesi chat berakhir. Terima kasih!`);
    await kirimPesan(familyJid, `✅ Sesi live chat berakhir.`);
  }

  console.log(`[BRIDGE] Berakhir: ${guestJid} <-> ${familyJid}${diabaikan ? ' (diabaikan)' : ''}`);
  delete stateScreening[guestJid];
  await prosesAntreanBerikutnya(familyJid);
}

async function prosesAntreanBerikutnya(familyJid) {
  const antrean = antreanTamu[familyJid];
  if (!antrean || antrean.length === 0) return;

  const tamuBerikutnya = antrean.shift();
  console.log(`[ANTREAN] Proses berikutnya untuk ${familyJid}: ${tamuBerikutnya.namaLengkap}`);

  await kirimPesan(tamuBerikutnya.guestJid, `🎯 *Giliran Anda tiba!* Menghubungkan...`);
  await delay(1000);
  await mulaiLiveChatBridge(familyJid, tamuBerikutnya);

  for (let i = 0; i < antrean.length; i++) {
    await kirimPesan(antrean[i].guestJid, `ℹ️ Update antrean: posisi Anda sekarang *#${i + 1}*.`);
  }
}

/** Masukkan ke bridge atau antrean dengan penguncian atomik per keluarga. */
async function tambahAtauBridgeTamu(familyJid, tamuData) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;

  try {
    const bridgeAktif = stateBridge[familyJid];

    if (!bridgeAktif || !bridgeAktif.active) {
      await mulaiLiveChatBridge(familyJid, tamuData);
    } else {
      if (!antreanTamu[familyJid]) antreanTamu[familyJid] = [];
      antreanTamu[familyJid].push(tamuData);
      const posisi = antreanTamu[familyJid].length;
      const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
      const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

      await kirimPesan(tamuData.guestJid,
        `⏳ *${panggilan}* sedang melayani tamu lain.\nPosisi antrean Anda: *#${posisi}*\nKami hubungi saat giliran tiba.`
      );
      await kirimPesan(familyJid,
        `🔔 *[INFO ANTREAN]*\nTamu baru *${tamuData.namaLengkap}* menunggu di antrean #${posisi}.\nKeperluan: _${tamuData.tujuan}_`
      );
      console.log(`[ANTREAN] ${tamuData.namaLengkap} di antrean #${posisi} untuk ${familyJid}`);
    }
  } finally {
    bridgeLock[familyJid] = false;
  }
}

// ============================================================
// 8. MESSAGE BUFFER (DEBOUNCE ANTI-SPAM 2.5 DETIK)
// ============================================================

function bufferDanKirimPesan(fromJid, toJid, teks, labelPengirim) {
  const key = `${fromJid}=>${toJid}`;
  if (!messageBuffer[key]) messageBuffer[key] = { timer: null, messages: [] };
  messageBuffer[key].messages.push(teks);

  if (messageBuffer[key].timer) clearTimeout(messageBuffer[key].timer);

  messageBuffer[key].timer = setTimeout(async () => {
    const entry = messageBuffer[key];
    messageBuffer[key] = null;
    if (!entry || entry.messages.length === 0) return;
    const gabungan = entry.messages.join('\n');
    const pesanAkhir = labelPengirim ? `${labelPengirim}\n${gabungan}` : gabungan;
    await kirimPesan(toJid, pesanAkhir);
  }, 2500);
}

// ============================================================
// 9. FORMULIR SKRINING 3 LANGKAH
// ============================================================

async function mulaiSkrining(guestJid) {
  stateScreening[guestJid] = { step: 1 };
  await kirimPesan(guestJid,
    `👋 *Selamat datang!*\n\nAnda menghubungi sistem Gatekeeper rumah ini.\nMohon jawab beberapa pertanyaan singkat.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n*Pertanyaan 1 dari 3:*\nSiapa *Nama Lengkap* Anda?`
  );
}

async function prosesJawabanSkrining(guestJid, teks) {
  const state = stateScreening[guestJid];
  if (!state) return;

  if (state.step === 1) {
    state.namaLengkap = teks.trim();
    state.step = 2;
    await kirimPesan(guestJid,
      `Terima kasih, *${state.namaLengkap}*.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n*Pertanyaan 2 dari 3:*\n` +
      `Siapa nama anggota keluarga yang ingin Anda hubungi?\n_(Ketik nama panggilan)_`
    );

  } else if (state.step === 2) {
    const keluargaDitemukan = cariKeluarga(teks);
    if (!keluargaDitemukan) {
      const daftar = DATABASE_KELUARGA.map(a => a.panggilanUtama).join(', ');
      await kirimPesan(guestJid,
        `❌ Nama "*${teks.trim()}*" tidak ditemukan.\nSilakan ketik ulang.\n_Contoh: ${daftar}_`
      );
      return;
    }
    state.targetKeluarga = keluargaDitemukan;
    state.step = 3;
    await kirimPesan(guestJid,
      `✅ Ingin hubungi *${keluargaDitemukan.panggilanUtama}*.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n*Pertanyaan 3 dari 3:*\n` +
      `Apa *Tujuan/Kepentingan* Anda menghubungi *${keluargaDitemukan.panggilanUtama}*?`
    );

  } else if (state.step === 3) {
    state.tujuan = teks.trim();
    state.step = 'selesai';
    const keluarga = state.targetKeluarga;
    const tamuData = { guestJid, namaLengkap: state.namaLengkap, tujuan: state.tujuan };

    await kirimPesan(guestJid,
      `✅ *Formulir selesai!*\n\n📋 Ringkasan:\n• Nama: ${state.namaLengkap}\n` +
      `• Bicara dengan: ${keluarga.panggilanUtama}\n• Keperluan: ${state.tujuan}\n\n_Menghubungkan..._`
    );
    await delay(1000);
    await tambahAtauBridgeTamu(keluarga.nomor, tamuData);
  }
}

// ============================================================
// 10. HANDLER PESAN MASUK
// ============================================================

async function handlePesanMasuk(message) {
  const jid = message.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || message.key.fromMe) return;

  const msg = message.message;
  const teks =
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption || '';

  if (!teks) return;

  const teksUpper = teks.trim().toUpperCase();
  console.log(`[PESAN] ${jid}: "${teks.substring(0, 80)}"`);

  // ── BLOK A: Anggota Keluarga ──
  if (adalahKeluarga(jid)) {
    const bridge = stateBridge[jid];
    if (!bridge || !bridge.active) return;

    if (teks.trim().toLowerCase() === 'abaikan') {
      await akhiriLiveChatBridge(jid, true);
      return;
    }
    if (teksUpper === 'EXIT') {
      await akhiriLiveChatBridge(jid, false);
      return;
    }

    const keluarga = DATABASE_KELUARGA.find(a => a.nomor === jid);
    bufferDanKirimPesan(jid, bridge.guestJid, teks, `💬 *${keluarga?.panggilanUtama || 'Keluarga'}:*`);
    return;
  }

  // ── BLOK B: Tamu (nomor asing) ──

  // Cek apakah tamu sedang dalam bridge aktif
  const bridgeEntry = Object.entries(stateBridge).find(
    ([, val]) => val && val.active && val.guestJid === jid
  );
  if (bridgeEntry) {
    const [familyJid] = bridgeEntry;
    if (teksUpper === 'EXIT') {
      await akhiriLiveChatBridge(familyJid, false);
      return;
    }
    const namaLabel = stateScreening[jid]?.namaLengkap || 'Tamu';
    bufferDanKirimPesan(jid, familyJid, teks, `📩 *${namaLabel}:*`);
    return;
  }

  // Cek apakah tamu dalam antrean
  const dalamAntrean = Object.values(antreanTamu).some(a => a?.some(t => t.guestJid === jid));
  if (dalamAntrean) {
    for (const [, antrean] of Object.entries(antreanTamu)) {
      const posisi = antrean?.findIndex(t => t.guestJid === jid) + 1;
      if (posisi > 0) {
        await kirimPesan(jid, `⏳ Anda masih di antrean posisi *#${posisi}*. Mohon bersabar.`);
        break;
      }
    }
    return;
  }

  // ── Deteksi Kurir (bypass skrining) ──
  const deteksi = deteksiKurir(teks);
  if (deteksi) {
    console.log(`[KURIR] Terdeteksi dari ${jid}. Kurir: ${deteksi.namaKurir}`);
    if (deteksi.targetKeluarga) {
      const k = deteksi.targetKeluarga;
      await kirimPesan(k.nomor,
        `📦 *[NOTIFIKASI PAKET]*\n\nKurir *${deteksi.namaKurir}*\n📋 Pesan kurir:\n_${teks}_\n\nKontak: ${jid.replace('@s.whatsapp.net', '')}`
      );
      await kirimPesan(jid,
        `✅ *Konfirmasi Diterima*\nPesan untuk *${k.namaResmi}* diterima. Berikut kontak yang bisa dihubungi langsung:`
      );
      await delay(500);
      await kirimKontakVCard(jid, k);
    } else {
      await kirimPesan(jid, `✅ Pesan kurir diterima. Mohon sebutkan nama penerima paket.`);
      for (const anggota of DATABASE_KELUARGA) {
        await kirimPesan(anggota.nomor,
          `📦 *[NOTIFIKASI PAKET]*\nKurir *${deteksi.namaKurir}* — nama penerima tidak terdeteksi.\n📋 _${teks}_`
        );
      }
    }
    return;
  }

  // ── Skrining 3 Langkah ──
  const screenState = stateScreening[jid];
  if (!screenState) {
    console.log(`[GATEKEEPER] Tamu baru: ${jid}`);
    await mulaiSkrining(jid);
    return;
  }
  if (screenState.step === 'selesai') {
    await kirimPesan(jid, `ℹ️ Formulir sudah diterima. Mohon tunggu giliran Anda.`);
    return;
  }
  await prosesJawabanSkrining(jid, teks);
}

// ============================================================
// 11. KONEKSI BAILEYS (PAIRING CODE — STABIL CLOUD)
// ============================================================

async function mulaiKoneksi() {
  sudahMintaPairingCode = false;

  const { state: authState, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: authState,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // Saat QR event muncul = server siap autentikasi.
    // Di sinilah kita harus minta Pairing Code (bukan setelah 'open').
    // Jeda 7 detik agar Noise Protocol matang sebelum request kode.
    if (qr && !authState.creds.registered && !sudahMintaPairingCode) {
      sudahMintaPairingCode = true;
      console.log('[PAIRING] Koneksi siap. Menunggu 7 detik agar jalur enkripsi matang...');
      await delay(7000);
      if (!sock) return;

      try {
        const nomorBersih = NOMOR_BOT.replace(/[^0-9]/g, '');
        const pairingCode = await sock.requestPairingCode(nomorBersih);

        console.log('\n╔════════════════════════════════════════╗');
        console.log('║        KODE PAIRING WHATSAPP            ║');
        console.log('╠════════════════════════════════════════╣');
        console.log(`║  KODE: ${pairingCode}                    ║`);
        console.log('╠════════════════════════════════════════╣');
        console.log('║  1. Buka WhatsApp di HP                 ║');
        console.log('║  2. Pengaturan → Perangkat Tertaut       ║');
        console.log('║  3. Tautkan dengan Nomor Telepon         ║');
        console.log('║  4. Masukkan kode di atas               ║');
        console.log('╚════════════════════════════════════════╝\n');
      } catch (err) {
        console.error('[PAIRING] Gagal minta kode:', err.message);
        sudahMintaPairingCode = false;
      }
    }

    if (connection === 'open') {
      console.log('\n✅ [KONEKSI] Bot terhubung ke WhatsApp!\n');
      sedangReconnect = false;
    }

    if (connection === 'close') {
      const statusKode = lastDisconnect?.error?.output?.statusCode;
      const alasan = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusKode) || `Kode ${statusKode}`;
      console.log(`⚠️ [KONEKSI] Terputus: ${alasan}`);

      sock.ev.removeAllListeners();
      sock = null;

      if (statusKode === DisconnectReason.loggedOut) {
        console.log('[KONEKSI] Logged out. Hapus folder auth_info_baileys dan jalankan ulang.');
        process.exit(1);
      }

      if (!sedangReconnect) {
        sedangReconnect = true;
        console.log('[KONEKSI] Reconnect dalam 5 detik...');
        await delay(5000);
        mulaiKoneksi();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      try {
        await handlePesanMasuk(message);
      } catch (err) {
        console.error('[ERROR] Proses pesan gagal:', err.message);
      }
    }
  });
}

// ============================================================
// 12. ENTRY POINT
// ============================================================

console.log('╔════════════════════════════════════════╗');
console.log('║    WHATSAPP GATEKEEPER BOT DIMULAI      ║');
console.log(`║    Nomor Bot: ${NOMOR_BOT}            ║`);
console.log('╚════════════════════════════════════════╝\n');

mulaiKoneksi().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
