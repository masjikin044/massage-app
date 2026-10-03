/* user-addon.js — ditambahkan tanpa mengubah index.html (disisipkan nginx). */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement('div'); d.innerText = s == null ? '' : String(s); return d.innerHTML; };
  const H = () => ({ Authorization: 'Bearer ' + token });
  const J = () => ({ ...H(), 'Content-Type': 'application/json' });
  const STICKERS = ['😀','😂','😍','👍','🙏','🔥','🎉','😢','😡','❤️','🤝','👏'];
  let activeGroup = null, pending = [], recorder = null, voiceBlob = null, view = 'chat', groups = [];

  async function api(url, opt) {
    const r = await fetch(url, opt); const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Terjadi kesalahan.'); return d;
  }
  const fileUrl = (a, dl) => `/api/files/${a.id}?token=${token}${dl ? '&download=1' : ''}`;

  function renderBody(m) {
    if (m.deleted_at) return '<p class="msg-text text-sm italic opacity-70">Pesan ini telah dihapus.</p>';
    if (m.kind === 'sticker') return `<p class="msg-text" style="font-size:3rem;line-height:1">${esc(m.message)}</p>`;
    let h = '';
    (m.attachments || []).forEach((a) => {
      if (a.kind === 'image') h += `<a href="${fileUrl(a)}" target="_blank"><img src="${fileUrl(a)}" class="rounded mb-1 max-h-60"></a>`;
      else if (a.kind === 'video') h += `<video src="${fileUrl(a)}" controls class="rounded mb-1 max-h-60"></video>`;
      else if (a.kind === 'voice' || a.kind === 'audio') h += `<audio src="${fileUrl(a)}" controls class="mb-1 max-w-full"></audio>`;
      else h += `<a href="${fileUrl(a, 1)}" class="block text-xs underline mb-1">${esc(a.name)} (${Math.round(a.size / 1024)} KB)</a>`;
    });
    if (m.message) h += `<p class="msg-text text-sm whitespace-pre-wrap break-words">${esc(m.message)}</p>`;
    return h;
  }

  // Override: render pesan (aman dari XSS, mendukung media/sticker/voice/grup)
  window.appendMessage = function (msg) {
    const isMe = msg.sender_id === currentUser.id;
    const history = $('messageHistory');
    if ($(`msg-${msg.group_id ? 'g' : ''}${msg.id}`)) return;
    const div = document.createElement('div');
    div.id = `msg-${msg.group_id ? 'g' : ''}${msg.id}`;
    div.className = `flex flex-col ${isMe ? 'items-end' : 'items-start'}`;
    const del = isMe && !msg.deleted_at ? `<button onclick="addonDelete(${msg.id},${msg.group_id || 'null'})" class="text-xs text-red-300 hover:text-red-100 mt-1 block">Hapus</button>` : '';
    div.innerHTML = `<div class="max-w-xs md:max-w-md p-3 rounded-lg ${isMe ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-200'}">
      ${!isMe && msg.sender_name ? `<span class="text-[11px] font-semibold text-indigo-300 block mb-1">${esc(msg.sender_name)}</span>` : ''}
      ${renderBody(msg)}
      <span class="text-[10px] opacity-70 block text-right mt-1">${new Date(msg.created_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>${del}</div>`;
    history.appendChild(div); history.scrollTop = history.scrollHeight;
  };
  window.addonDelete = async function (id, gid) {
    if (!confirm('Hapus pesan ini?')) return;
    try {
      await api(gid ? `/api/groups/${gid}/messages/${id}` : `/api/messages/${id}`, { method: 'DELETE', headers: H() });
      const el = $(`msg-${gid ? 'g' : ''}${id}`); if (el) el.querySelector('div').innerHTML = '<p class="text-sm italic opacity-70">Pesan ini telah dihapus.</p>';
    } catch (e) { alert(e.message); }
  };

  window.loadMessages = async function () {
    const h = $('messageHistory'); h.innerHTML = '';
    try {
      const url = activeGroup ? `/api/groups/${activeGroup.id}/messages` : `/api/messages?with=${activeChatUser.id}`;
      (await api(url, { headers: H() })).forEach(window.appendMessage);
      h.scrollTop = h.scrollHeight;
    } catch (e) { h.innerHTML = `<p class="text-red-400 text-sm">${esc(e.message)}</p>`; }
  };

  const origSelect = window.selectUser;
  window.selectUser = function (id, name) { activeGroup = null; showView('chat'); return origSelect(id, name); };
  window.loadUsers = async function () {
    const l = $('userList'); if (!l) return;
    const q = (($('searchUser') || {}).value || '').toLowerCase();
    let users = [];
    try { users = await api('/api/contacts', { headers: H() }); }
    catch (e) { l.innerHTML = `<p class="text-xs text-red-400 p-2">${esc(e.message)}</p>`; return; }
    users = users.filter((u) => u.username.toLowerCase().includes(q));
    l.innerHTML = users.map((u) => `<div class="usr-item p-3 bg-slate-700/50 hover:bg-slate-700 rounded cursor-pointer" data-id="${u.id}" data-name="${esc(u.username)}">${esc(u.username)}</div>`).join('') ||
      '<p class="text-xs text-slate-400 p-2">Belum ada kontak. Buka halaman Kontak untuk menambahkan user.</p>';
    l.querySelectorAll('.usr-item').forEach((el) => { el.onclick = () => window.selectUser(+el.dataset.id, el.dataset.name); });
    renderGroupsInSidebar();
  };
  async function loadGroups() { try { groups = await api('/api/groups', { headers: H() }); } catch { groups = []; } renderGroupsInSidebar(); if (view === 'groups') renderGroupsPage(); }
  function renderGroupsInSidebar() {
    const l = $('userList'); if (!l) return; l.querySelectorAll('.grp-item,.grp-title').forEach((e) => e.remove());
    if (!groups.length) return;
    l.insertAdjacentHTML('beforeend', '<p class="grp-title text-xs uppercase text-slate-400 pt-3">Grup</p>' + groups.map((g) =>
      `<div class="grp-item p-3 bg-slate-700/50 hover:bg-slate-700 rounded cursor-pointer" onclick="addonOpenGroup(${g.id})">${esc(g.name)} <span class="text-xs text-slate-400">(${g.member_count})</span></div>`).join(''));
  }
  window.addonOpenGroup = function (id) {
    const g = groups.find((x) => x.id === id); if (!g) return;
    activeGroup = g; activeChatUser = null; showView('chat');
    $('chatHeader').innerText = `Grup: ${g.name}`; $('messageForm').classList.remove('hidden'); window.loadMessages();
  };

  /* ---------- Kirim: teks / file / voice / sticker / terjadwal ---------- */
  async function post(fd) {
    const url = activeGroup ? `/api/groups/${activeGroup.id}/messages` : '/api/messages';
    if (!activeGroup) fd.append('receiver_id', activeChatUser.id);
    return api(url, { method: 'POST', headers: H(), body: fd });
  }
  async function doSend(extra) {
    if (!activeChatUser && !activeGroup) return;
    const input = $('messageInput'), fd = new FormData();
    const text = extra && extra.sticker ? extra.sticker : input.value.trim();
    if (!text && !pending.length && !voiceBlob) return;
    fd.append('message', text);
    if (extra && extra.sticker) fd.append('kind', 'sticker');
    pending.forEach((f) => fd.append('files', f));
    if (voiceBlob) fd.append('voice', voiceBlob, 'voice-note.webm');
    const when = $('schedAt').value;
    if (when) fd.append('deliver_at', new Date(when).toISOString());
    try {
      const d = await post(fd);
      if (d.scheduled) alert('Pesan dijadwalkan: ' + new Date(d.deliver_at).toLocaleString());
      else window.appendMessage(d);
      input.value = ''; pending = []; voiceBlob = null; $('schedAt').value = ''; updateChips(); if (d.scheduled) loadScheduled();
    } catch (e) { alert(e.message); }
  }
  window.sendMessage = function (e) { e.preventDefault(); input_required_fix(); doSend(); };
  function input_required_fix() { /* input text 'required' dilewati bila ada lampiran */ }

  function updateChips() {
    $('chips').innerText = [pending.length ? `${pending.length} file` : '', voiceBlob ? 'voice note siap' : ''].filter(Boolean).join('  •  ');
  }
  function buildToolbar() {
    const form = $('messageForm'); if (!form || $('addonBar')) return;
    $('messageInput').removeAttribute('required');
    form.insertAdjacentHTML('afterend', `<div id="addonBar" class="hidden flex flex-wrap items-center gap-2 mt-2 text-sm">
      <label class="px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded cursor-pointer">Lampirkan<input id="fileIn" type="file" multiple class="hidden"></label>
      <button type="button" id="stkBtn" class="px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded">Sticker</button>
      <button type="button" id="micBtn" class="px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded">Voice</button>
      <label class="text-xs text-slate-400">Jadwalkan: <input id="schedAt" type="datetime-local" class="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white"></label>
      <span id="chips" class="text-xs text-indigo-300"></span>
      <div id="stkBox" class="hidden w-full flex flex-wrap gap-2 p-2 bg-slate-900 rounded">${STICKERS.map((s) => `<button type="button" class="text-3xl" data-s="${s}">${s}</button>`).join('')}</div></div>`);
    $('fileIn').onchange = (e) => { pending = pending.concat([...e.target.files]).slice(0, 20); e.target.value = ''; updateChips(); };
    $('stkBtn').onclick = () => $('stkBox').classList.toggle('hidden');
    $('stkBox').onclick = (e) => { const s = e.target.dataset.s; if (s) { $('stkBox').classList.add('hidden'); doSend({ sticker: s }); } };
    $('micBtn').onclick = async () => {
      if (recorder) { recorder.stop(); return; }
      try {
        const st = await navigator.mediaDevices.getUserMedia({ audio: true }); const chunks = [];
        recorder = new MediaRecorder(st);
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = () => { voiceBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }); st.getTracks().forEach((t) => t.stop()); recorder = null; $('micBtn').innerText = 'Voice'; updateChips(); };
        recorder.start(); $('micBtn').innerText = 'Stop rekam';
      } catch { alert('Mikrofon tidak tersedia / izin ditolak (butuh HTTPS atau localhost).'); }
    };
    new MutationObserver(() => $('addonBar').classList.toggle('hidden', form.classList.contains('hidden'))).observe(form, { attributes: true, attributeFilter: ['class'] });
  }

  /* ---------- Halaman terpisah: Chat | Kontak | Grup | Terjadwal ---------- */
  function buildPages() {
    if ($('addonNav')) return;
    $('chatSection').insertAdjacentHTML('beforebegin', `<div id="addonNav" class="flex gap-2 mb-4">
      ${[['chat', 'Chat'], ['contacts', 'Kontak'], ['groups', 'Grup'], ['sched', 'Terjadwal']].map(([k, l]) => `<button data-v="${k}" class="addon-tab px-4 py-2 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700">${l}</button>`).join('')}</div>
      <div id="addonWarn" class="space-y-2 mb-4"></div><div id="addonPage" class="hidden bg-slate-800 rounded-lg p-4 border border-slate-700 min-h-[50vh]"></div>`);
    $('addonNav').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; if (v === 'chat' && view !== 'chat') resetChat(); showView(v); };
    showView('chat');
  }
  function resetChat() {
    activeGroup = null; activeChatUser = null;
    $('chatHeader').innerText = 'Pilih user untuk memulai percakapan';
    $('messageHistory').innerHTML = ''; $('messageForm').classList.add('hidden');
  }
  function showView(v) {
    view = v; if (!$('addonPage')) return;
    $('chatSection').classList.toggle('hidden', v !== 'chat'); $('addonPage').classList.toggle('hidden', v === 'chat');
    document.querySelectorAll('.addon-tab').forEach((b) => b.classList.toggle('bg-indigo-600', b.dataset.v === v));
    if (v === 'contacts') renderContactsPage(); if (v === 'groups') loadGroups(); if (v === 'sched') loadScheduled();
  }
  async function renderContactsPage() {
    const p = $('addonPage'); let list = [], me = {};
    try { [list, me] = await Promise.all([api('/api/contacts', { headers: H() }), api('/api/me', { headers: H() })]); } catch (e) {}
    const cls = 'bg-slate-900 border border-slate-700 rounded px-3 py-2';
    p.innerHTML = `<h2 class="text-lg font-bold mb-3">Kontak</h2>
      <form id="addContact" class="flex gap-2 mb-2"><input id="acQuery" placeholder="Username atau email user" class="flex-1 ${cls}"><button class="bg-indigo-600 hover:bg-indigo-700 px-4 rounded">Tambah</button></form>
      <p class="text-xs text-slate-400 mb-4">Setelah Anda mengirim pesan, Anda otomatis tersimpan juga di kontak penerima.</p>
      <div class="space-y-2 mb-8">${list.map((c) => `<div class="flex justify-between p-3 bg-slate-700/50 rounded"><span>${esc(c.username)} <span class="text-xs text-slate-400">${esc(c.email)}</span></span><span><button class="text-indigo-300 mr-3" onclick="addonChatWith(${c.id},'${esc(c.username).replace(/'/g, '')}')">Chat</button><button class="text-red-400" onclick="addonDelContact(${c.id})">Hapus</button></span></div>`).join('') || '<p class="text-slate-400 text-sm">Belum ada kontak.</p>'}</div>
      <div class="border-t border-slate-700 pt-4"><h3 class="font-semibold mb-1">Notifikasi Email</h3>
        <p class="text-xs text-slate-400 mb-3">Email tujuan saat ini: <b>${esc(me.notify_email || me.email || '-')}</b>${me.notify_email ? '' : ' (email akun)'}</p>
        <label class="text-sm block mb-3"><input id="myNotif" type="checkbox" ${me.email_notifications !== false ? 'checked' : ''}> Aktifkan notifikasi email</label>
        <form id="mailForm" class="flex gap-2 mb-2"><input id="newMail" type="email" placeholder="Email lain untuk notifikasi" class="flex-1 ${cls}"><button class="bg-slate-600 hover:bg-slate-500 px-4 rounded">Kirim Kode</button></form>
        <form id="codeForm" class="hidden flex gap-2 mb-2"><input id="mailCode" placeholder="Kode 6 digit dari email" class="flex-1 ${cls}"><button class="bg-indigo-600 px-4 rounded">Verifikasi</button></form>
        <button id="mailReset" class="text-xs text-slate-400 underline">Kembali ke email akun</button></div>`;
    $('addContact').onsubmit = async (e) => { e.preventDefault(); try { const d = await api('/api/contacts', { method: 'POST', headers: J(), body: JSON.stringify({ query: $('acQuery').value }) }); alert(d.message); renderContactsPage(); window.loadUsers(); } catch (x) { alert(x.message); } };
    $('myNotif').onchange = () => api('/api/me', { method: 'PATCH', headers: J(), body: JSON.stringify({ email_notifications: $('myNotif').checked }) }).catch((x) => alert(x.message));
    $('mailForm').onsubmit = async (e) => { e.preventDefault(); try { const d = await api('/api/me/notify-email', { method: 'POST', headers: J(), body: JSON.stringify({ email: $('newMail').value }) }); alert(d.message); if (d.verified) renderContactsPage(); else $('codeForm').classList.remove('hidden'); } catch (x) { alert(x.message); } };
    $('codeForm').onsubmit = async (e) => { e.preventDefault(); try { alert((await api('/api/me/notify-email/verify', { method: 'POST', headers: J(), body: JSON.stringify({ code: $('mailCode').value }) })).message); renderContactsPage(); } catch (x) { alert(x.message); } };
    $('mailReset').onclick = async () => { try { await api('/api/me/notify-email', { method: 'POST', headers: J(), body: JSON.stringify({ email: me.email }) }); renderContactsPage(); } catch (x) { alert(x.message); } };
  }
  window.addonChatWith = (id, n) => { showView('chat'); window.selectUser(id, n); };
  window.addonDelContact = async (id) => { if (!confirm('Hapus kontak ini?')) return; await api('/api/contacts/' + id, { method: 'DELETE', headers: H() }); renderContactsPage(); window.loadUsers(); };

  async function renderGroupsPage() {
    const contacts = await api('/api/contacts', { headers: H() }).catch(() => []);
    $('addonPage').innerHTML = `<h2 class="text-lg font-bold mb-3">Grup</h2>
      <form id="newGrp" class="mb-3 space-y-2"><input id="gName" placeholder="Nama grup baru" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2">
      <div class="flex flex-wrap gap-3 text-sm">${contacts.map((c) => `<label><input type="checkbox" class="gm" value="${c.id}"> ${esc(c.username)}</label>`).join('')}</div><button class="bg-indigo-600 px-4 py-2 rounded">Buat Grup</button></form>
      <form id="joinGrp" class="flex gap-2 mb-4"><input id="gCode" placeholder="Kode undangan grup" class="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2"><button class="bg-slate-600 px-4 rounded">Gabung</button></form>
      <div class="space-y-2">${groups.map((g) => `<div class="flex justify-between p-3 bg-slate-700/50 rounded"><span>${esc(g.name)} <span class="text-xs text-slate-400">${g.member_count} anggota • kode: <b>${esc(g.invite_code)}</b></span></span><span><button class="text-indigo-300 mr-3" onclick="addonOpenGroup(${g.id})">Buka</button><button class="text-red-400" onclick="addonLeave(${g.id})">Keluar</button></span></div>`).join('')}</div>`;
    $('newGrp').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/groups', { method: 'POST', headers: J(), body: JSON.stringify({ name: $('gName').value, member_ids: [...document.querySelectorAll('.gm:checked')].map((x) => +x.value) }) }); loadGroups(); } catch (x) { alert(x.message); } };
    $('joinGrp').onsubmit = async (e) => { e.preventDefault(); try { alert((await api('/api/groups/join', { method: 'POST', headers: J(), body: JSON.stringify({ code: $('gCode').value }) })).message); loadGroups(); } catch (x) { alert(x.message); } };
  }
  window.addonLeave = async (id) => { if (confirm('Keluar dari grup?')) { await api(`/api/groups/${id}/leave`, { method: 'POST', headers: H() }); if (activeGroup && activeGroup.id === id) activeGroup = null; loadGroups(); } };

  async function loadScheduled() {
    if (view !== 'sched') return;
    const l = await api('/api/scheduled', { headers: H() }).catch(() => []);
    $('addonPage').innerHTML = `<h2 class="text-lg font-bold mb-1">Pesan Terjadwal</h2><p class="text-xs text-slate-400 mb-3">Buat dari halaman Chat dengan mengisi kolom "Jadwalkan". Jam mengikuti zona waktu perangkat Anda.</p>` +
      (l.map((s) => `<div class="flex justify-between p-3 bg-slate-700/50 rounded mb-2"><span>Ke <b>${esc(s.receiver_name || s.group_name)}</b>: ${esc(s.message || '[lampiran]')}<br><span class="text-xs text-slate-400">${new Date(s.deliver_at).toLocaleString()} • ${esc(s.status)} ${esc(s.error || '')}</span></span>${s.status === 'pending' ? `<button class="text-red-400" onclick="addonCancel(${s.id})">Batalkan</button>` : ''}</div>`).join('') || '<p class="text-slate-400 text-sm">Tidak ada pesan terjadwal.</p>');
  }
  window.addonCancel = async (id) => { await api('/api/scheduled/' + id, { method: 'DELETE', headers: H() }).catch((e) => alert(e.message)); loadScheduled(); };

  /* ---------- Peringatan admin (banner, hilang otomatis saat kedaluwarsa) ---------- */
  const warnTimers = {};
  function showWarning(w) {
    const box = $('addonWarn'); if (!box || $('warn-' + w.id)) return;
    box.insertAdjacentHTML('afterbegin', `<div id="warn-${w.id}" class="bg-amber-900/60 border border-amber-500 rounded p-3 text-sm"><b>Peringatan Admin:</b> ${esc(w.message)}</div>`);
    if (w.expires_at) warnTimers[w.id] = setTimeout(() => hideWarning(w.id), Math.max(0, new Date(w.expires_at) - Date.now()));
  }
  function hideWarning(id) { const e = $('warn-' + id); if (e) e.remove(); }

  /* ---------- Inisialisasi setelah login ---------- */
  function wireSocket() {
    if (typeof socket === 'undefined' || !socket) return false;
    const s = socket;
    const auth = () => s.emit('auth', token);
    s.on('connect', auth); if (s.connected) auth();
    s.on('group_msg', (m) => { if (activeGroup && activeGroup.id === m.group_id) window.appendMessage(m); else showToast('' + m.sender_name, m.message || '[lampiran]'); });
    s.on('group_msg_deleted', (d) => { const el = $('msg-g' + d.id); if (el) el.querySelector('div').innerHTML = '<p class="text-sm italic opacity-70">Pesan ini telah dihapus.</p>'; });
    s.on('group_update', loadGroups);
    s.on('warning:new', showWarning); s.on('warning:expired', (d) => hideWarning(d.id));
    return true;
  }
  function boot() {
    if (!token || !currentUser || !$('chatSection') || $('chatSection').classList.contains('hidden')) return false;
    buildPages(); buildToolbar(); resetChat(); window.loadUsers(); loadGroups();
    api('/api/warnings', { headers: H() }).then((l) => l.forEach(showWarning)).catch(() => {});
    wireSocket(); return true;
  }
  const t = setInterval(() => { if (boot()) clearInterval(t); }, 500);
  // Setelah login manual (initChat dipanggil) boot() akan menangkapnya lewat polling di atas.
})();
