/* admin-addon.js — menu tambahan admin (Grup, Peringatan, Media & Backup). index.html asli tidak diubah. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeAdminHtml(s);
  const H = () => ({ Authorization: 'Bearer ' + adminToken });
  const J = () => ({ ...H(), 'Content-Type': 'application/json' });
  async function api(url, opt) { const r = await fetch(url, opt); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Gagal.'); return d; }
  const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
  const sel = new Set();
  let mediaPage = 1;

  const nav = document.querySelector('aside nav'), main = document.querySelector('main');
  [['groups', 'Grup'], ['warnings', 'Peringatan'], ['media', 'Media & Backup']].forEach(([k, l]) =>
    nav.insertAdjacentHTML('beforeend', `<button data-tab="${k}" onclick="switchTab('${k}', this); addonLoad('${k}')" class="nav-btn w-full text-left px-4 py-2 rounded hover:bg-slate-700 transition">${l}</button>`));

  const inp = 'bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm';
  main.insertAdjacentHTML('beforeend', `
  <section id="tab-groups" class="space-y-4 hidden"><h1 class="text-2xl font-bold">Grup Chat</h1>
    <div class="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden"><table class="w-full text-left text-sm"><thead class="bg-slate-700 text-slate-300"><tr><th class="p-3">Nama</th><th class="p-3">Pembuat</th><th class="p-3">Anggota</th><th class="p-3">Pesan</th><th class="p-3">Aksi</th></tr></thead><tbody id="grpTable" class="divide-y divide-slate-700"></tbody></table></div>
    <div id="grpDetail" class="bg-slate-800 rounded-lg border border-slate-700 p-4 hidden"></div></section>

  <section id="tab-warnings" class="space-y-4 hidden"><h1 class="text-2xl font-bold">Peringatan Admin</h1>
    <form id="warnForm" class="bg-slate-800 rounded-lg border border-slate-700 p-4 space-y-3">
      <div class="flex flex-wrap gap-3"><select id="warnTarget" class="${inp}"><option value="">Semua user (broadcast)</option></select>
      <label class="text-sm text-slate-300">Hilang otomatis setelah <input id="warnDur" type="number" min="0" value="60" class="${inp} w-24"> menit (0 = tidak hilang)</label>
      <label class="text-sm text-slate-300"><input id="warnMail" type="checkbox" checked> Kirim juga via email</label></div>
      <textarea id="warnMsg" rows="3" required placeholder="Isi peringatan..." class="${inp} w-full"></textarea>
      <button class="px-4 py-2 bg-amber-600 hover:bg-amber-700 rounded text-sm font-semibold">Kirim Peringatan</button></form>
    <div class="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden"><table class="w-full text-left text-sm"><thead class="bg-slate-700 text-slate-300"><tr><th class="p-3">Waktu</th><th class="p-3">Target</th><th class="p-3">Pesan</th><th class="p-3">Kedaluwarsa</th><th class="p-3">Status</th><th class="p-3"></th></tr></thead><tbody id="warnTable" class="divide-y divide-slate-700"></tbody></table></div></section>

  <section id="tab-media" class="space-y-4 hidden"><div class="flex flex-wrap justify-between items-center gap-3"><h1 class="text-2xl font-bold">Media & Backup</h1><span id="mediaTotal" class="text-xs text-slate-400"></span></div>
    <div class="flex flex-wrap gap-2"><input id="mediaSearch" oninput="addonLoadMedia(1)" placeholder="Cari nama file / user..." class="${inp} w-64">
      <select id="mediaKind" onchange="addonLoadMedia(1)" class="${inp}"><option value="">Semua tipe</option><option value="image">Foto</option><option value="video">Video</option><option value="voice">Voice note</option><option value="audio">Audio</option><option value="file">File</option></select>
      <button onclick="addonBackup(false)" class="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 rounded text-sm">Backup file terpilih (<span id="selCount">0</span>)</button>
      <button onclick="addonBackup(true)" class="px-3 py-2 bg-green-600 hover:bg-green-700 rounded text-sm">Backup SEMUA (ZIP)</button></div>
    <div class="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden"><table class="w-full text-left text-sm"><thead class="bg-slate-700 text-slate-300"><tr><th class="p-3"></th><th class="p-3">Waktu</th><th class="p-3">Pengirim → Penerima</th><th class="p-3">File</th><th class="p-3">Ukuran</th><th class="p-3">Aksi</th></tr></thead><tbody id="mediaTable" class="divide-y divide-slate-700"></tbody></table></div>
    <div class="flex justify-between text-sm text-slate-400"><span id="mediaInfo"></span><span><button onclick="addonLoadMedia(Math.max(1,mediaPage-1))" class="px-3 py-1 bg-slate-700 rounded">Sebelumnya</button> <button onclick="addonLoadMedia(mediaPage+1)" class="px-3 py-1 bg-slate-700 rounded">Berikutnya</button></span></div>
    <h2 class="text-lg font-bold pt-4">Arsip Backup</h2>
    <div class="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden"><table class="w-full text-left text-sm"><thead class="bg-slate-700 text-slate-300"><tr><th class="p-3">Waktu</th><th class="p-3">Nama</th><th class="p-3">File</th><th class="p-3">Ukuran</th><th class="p-3">Aksi</th></tr></thead><tbody id="backupTable" class="divide-y divide-slate-700"></tbody></table></div></section>`);

  const loaders = { groups: loadGroups, warnings: loadWarnings, media: () => { addonLoadMedia(1); loadBackups(); } };
  window.addonLoad = (k) => loaders[k] && loaders[k]();
  const toErr = (e) => alert(e.message);

  async function loadGroups() {
    const g = await api('/api/admin/groups', { headers: H() }).catch(() => []);
    $('grpTable').innerHTML = g.map((x) => `<tr><td class="p-3">${esc(x.name)}</td><td class="p-3">${esc(x.created_by_name)}</td><td class="p-3">${x.member_count}</td><td class="p-3">${x.message_count}</td><td class="p-3 space-x-1"><button onclick="addonGrp(${x.id})" class="px-2 py-1 bg-indigo-600 rounded text-xs">Detail</button><button onclick="addonRename(${x.id},'${esc(x.name).replace(/'/g, '')}')" class="px-2 py-1 bg-amber-600 rounded text-xs">Ubah Nama</button></td></tr>`).join('') || '<tr><td class="p-3 text-slate-400" colspan="5">Belum ada grup.</td></tr>';
  }
  window.addonRename = async (id, old) => { const n = prompt('Nama grup baru:', old); if (!n) return; try { await api('/api/admin/groups/' + id, { method: 'PATCH', headers: J(), body: JSON.stringify({ name: n }) }); loadGroups(); } catch (e) { toErr(e); } };
  window.addonGrp = async (id) => {
    const g = await api('/api/admin/groups/' + id, { headers: H() }).catch(toErr); if (!g) return;
    const d = $('grpDetail'); d.classList.remove('hidden');
    d.innerHTML = `<h3 class="font-bold mb-2">${esc(g.name)} <span class="text-xs text-slate-400">kode ${esc(g.invite_code)}</span></h3><p class="text-sm font-semibold">Anggota (${g.members.length})</p><p class="text-sm text-slate-300 mb-3">${g.members.map((m) => esc(m.username) + (m.role === 'owner' ? ' ' : '') + ' &lt;' + esc(m.email) + '&gt;').join(', ')}</p><p class="text-sm font-semibold mb-1">Pesan terbaru</p>` +
      g.messages.map((m) => `<div class="text-sm border-t border-slate-700 py-1 flex justify-between"><span><b>${esc(m.sender_name)}</b>: ${m.deleted_at ? '<i class="text-slate-500">dihapus</i>' : esc(m.message || '') + (m.attachments.length ? ' ' + m.attachments.length : '')}</span>${m.deleted_at ? '' : `<button onclick="addonDelGMsg(${m.id},${id})" class="text-red-400 text-xs">Hapus</button>`}</div>`).join('');
  };
  window.addonDelGMsg = async (mid, gid) => { if (confirm('Hapus pesan grup ini?')) { await api('/api/admin/group-messages/' + mid, { method: 'DELETE', headers: H() }).catch(toErr); addonGrp(gid); } };

  async function loadWarnings() {
    const [u, w] = await Promise.all([api('/api/admin/users?limit=200', { headers: H() }), api('/api/admin/warnings', { headers: H() })]).catch(() => [{ users: [] }, []]);
    $('warnTarget').innerHTML = '<option value="">Semua user (broadcast)</option>' + u.users.filter((x) => x.role !== 'admin' && x.status === 'active').map((x) => `<option value="${x.id}">${esc(x.username)}</option>`).join('');
    $('warnTable').innerHTML = w.map((x) => `<tr><td class="p-3 whitespace-nowrap">${new Date(x.created_at).toLocaleString()}</td><td class="p-3">${esc(x.target || 'Semua')}</td><td class="p-3 max-w-xs truncate">${esc(x.message)}</td><td class="p-3">${x.expires_at ? new Date(x.expires_at).toLocaleString() : '-'}</td><td class="p-3">${esc(x.state)}</td><td class="p-3">${x.deleted_at ? '' : `<button onclick="addonWithdraw(${x.id})" class="px-2 py-1 bg-red-600 rounded text-xs">Tarik</button>`}</td></tr>`).join('');
  }
  $('warnForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/admin/warnings', { method: 'POST', headers: J(), body: JSON.stringify({ user_id: $('warnTarget').value || null, message: $('warnMsg').value, duration_minutes: +$('warnDur').value || 0, send_email: $('warnMail').checked }) }); $('warnMsg').value = ''; loadWarnings(); alert('Peringatan terkirim.'); } catch (x) { toErr(x); }
  };
  window.addonWithdraw = async (id) => { await api('/api/admin/warnings/' + id, { method: 'DELETE', headers: H() }).catch(toErr); loadWarnings(); };

  window.addonLoadMedia = async (p) => {
    mediaPage = Math.max(1, p || 1); window.mediaPage = mediaPage;
    const q = `page=${mediaPage}&limit=20&search=${encodeURIComponent($('mediaSearch').value)}&kind=${$('mediaKind').value}`;
    const d = await api('/api/admin/media?' + q, { headers: H() }).catch(() => ({ media: [], total: 0, total_bytes: 0 }));
    $('mediaTotal').innerText = `Total penyimpanan media: ${mb(d.total_bytes)}`;
    $('mediaInfo').innerText = `Halaman ${mediaPage} (${d.total} file)`;
    $('mediaTable').innerHTML = d.media.map((m) => `<tr><td class="p-3"><input type="checkbox" ${sel.has(m.id) ? 'checked' : ''} onchange="addonSel(${m.id},this.checked)"></td><td class="p-3 whitespace-nowrap">${new Date(m.created_at).toLocaleString()}</td><td class="p-3">${esc(m.sender)} → ${esc(m.receiver || m.group_name || '-')}</td><td class="p-3 max-w-xs truncate">${esc(m.kind)} • ${esc(m.original_name)}</td><td class="p-3">${mb(m.size)}</td><td class="p-3 space-x-1"><a href="/api/files/${m.id}?token=${adminToken}&download=1" class="px-2 py-1 bg-indigo-600 rounded text-xs">Unduh</a><button onclick="addonDelMedia(${m.id})" class="px-2 py-1 bg-red-600 rounded text-xs">Hapus</button></td></tr>`).join('') || '<tr><td class="p-3 text-slate-400" colspan="6">Tidak ada file.</td></tr>';
  };
  window.mediaPage = 1;
  window.addonSel = (id, on) => { on ? sel.add(id) : sel.delete(id); $('selCount').innerText = sel.size; };
  window.addonDelMedia = async (id) => { if (confirm('Hapus file ini permanen dari server?')) { await api('/api/admin/media/' + id, { method: 'DELETE', headers: H() }).catch(toErr); sel.delete(id); addonLoadMedia(mediaPage); } };
  window.addonBackup = async (all) => {
    if (!all && !sel.size) return alert('Centang file yang ingin di-backup terlebih dahulu.');
    try { const b = await api('/api/admin/backups', { method: 'POST', headers: J(), body: JSON.stringify(all ? { all: true } : { ids: [...sel] }) }); alert(`Backup dibuat: ${b.file_count} file (${mb(b.size)}).`); loadBackups(); } catch (e) { toErr(e); }
  };
  async function loadBackups() {
    const b = await api('/api/admin/backups', { headers: H() }).catch(() => []);
    $('backupTable').innerHTML = b.map((x) => `<tr><td class="p-3 whitespace-nowrap">${new Date(x.created_at).toLocaleString()}</td><td class="p-3">${esc(x.filename)}</td><td class="p-3">${x.file_count}</td><td class="p-3">${mb(x.size)}</td><td class="p-3 space-x-1"><a href="/api/admin/backups/${x.id}/download?token=${adminToken}" class="px-2 py-1 bg-green-600 rounded text-xs">Download ZIP</a><button onclick="addonDelBackup(${x.id})" class="px-2 py-1 bg-red-600 rounded text-xs">Hapus</button></td></tr>`).join('') || '<tr><td class="p-3 text-slate-400" colspan="5">Belum ada backup.</td></tr>';
  }
  window.addonDelBackup = async (id) => { if (confirm('Hapus arsip backup ini?')) { await api('/api/admin/backups/' + id, { method: 'DELETE', headers: H() }).catch(toErr); loadBackups(); } };

  // Modal broadcast bawaan: tambahkan input durasi hilang otomatis tanpa mengubah HTML aslinya
  const bf = $('broadcastModal') && $('broadcastModal').querySelector('form');
  if (bf) bf.querySelector('textarea').insertAdjacentHTML('afterend', `<label class="block text-sm text-slate-300 mt-2">Hilang otomatis setelah <input id="bcDur" type="number" min="0" value="60" class="${inp} w-20"> menit (0 = tidak hilang)</label>`);
  const origFetch = window.fetch;
  window.fetch = function (url, opt) {
    if (typeof url === 'string' && url === '/api/admin/broadcast' && opt && opt.body && $('bcDur')) {
      const b = JSON.parse(opt.body); b.duration_minutes = +$('bcDur').value || 0; opt = { ...opt, body: JSON.stringify(b) };
    }
    return origFetch.call(this, url, opt);
  };
})();
