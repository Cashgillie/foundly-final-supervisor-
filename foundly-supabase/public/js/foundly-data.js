/* ============================================================
   FOUNDLY — Data layer (Supabase-backed)
   ------------------------------------------------------------
   Reads go straight to Postgres via supabase-js (fast, RLS-
   filtered at the database). All writes go through RPC calls
   to SECURITY DEFINER Postgres functions, which verify edit
   tokens / admin membership server-side before touching
   anything — see supabase/migrations/0001_init.sql.
   ============================================================ */

import { supabase } from "./supabase-init.js";
import { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY } from "./emailjs-config.js";

const BUCKET = "report-images";

// Postgres columns are snake_case (idiomatic Postgres); we alias them
// back to the camelCase field names the app (and the original spec)
// expects, right in the query, so nothing downstream has to know.
const REPORT_COLUMNS = `
  id,
  type,
  category,
  title,
  description,
  location,
  contact,
  imageUrl:image_url,
  status,
  createdAt:created_at,
  updatedAt:updated_at,
  resolvedAt:resolved_at,
  deletedAt:deleted_at
`;

// ─── CATEGORY ICONS ───────────────────────────────────────────
const ICON_MAP = {
  phones: 'mobile-alt', pets: 'paw', wallets: 'wallet', keys: 'key',
  bags: 'bag-shopping', electronics: 'laptop', jewelry: 'gem', other: 'question-circle'
};
export function getCategoryIcon(cat) { return ICON_MAP[cat] || 'tag'; }

// ─── (bookmark feature removed) ────────────────────────────────

// ─── READS (public, active-only by default) ──────────────────
export async function fetchActiveReports({ type } = {}) {
  let query = supabase.from('reports').select(REPORT_COLUMNS).eq('status', 'active');
  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function fetchReportById(id) {
  const { data, error } = await supabase.from('reports').select(REPORT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export function filterAndSort(items, { category, searchTerm, sort } = {}) {
  let out = [...items];
  if (category) out = out.filter(i => i.category === category);
  if (searchTerm) {
    const term = searchTerm.toLowerCase().trim();
    out = out.filter(i =>
      (i.title || '').toLowerCase().includes(term) ||
      (i.description || '').toLowerCase().includes(term) ||
      (i.location || '').toLowerCase().includes(term)
    );
  }
  const ts = (i) => i.createdAt ? new Date(i.createdAt).getTime() : 0;
  if (sort === 'oldest') out.sort((a, b) => ts(a) - ts(b));
  else if (sort === 'az') out.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'za') out.sort((a, b) => b.title.localeCompare(a.title));
  else out.sort((a, b) => ts(b) - ts(a)); // newest first (default)
  return out;
}

// ─── IMAGE VALIDATION ───────────────────────────────────────────
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png'];

export function validateImageFile(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return { valid: false, error: 'Only JPG or PNG images are allowed.' };
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return { valid: false, error: 'Image must be smaller than 5MB.' };
  }
  return { valid: true };
}

// Reads a File as a data URL for instant local preview, before/without
// uploading it anywhere.
export function readImageAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ─── IMAGE UPLOAD (client SDK -> Supabase Storage) ────────────
export async function uploadReportImage(file) {
  // Safety net: even if a caller forgets to validate before calling this,
  // never let an invalid file reach Storage.
  const check = validateImageFile(file);
  if (!check.valid) throw new Error(check.error);

  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false
  });
  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ─── PUBLIC WRITES (via RPC -> SECURITY DEFINER functions) ────
export async function createReport(fields) {
  const { data, error } = await supabase.rpc('create_report', {
    p_type: fields.type,
    p_category: fields.category,
    p_title: fields.title,
    p_description: fields.description,
    p_location: fields.location,
    p_contact: fields.contact,
    p_image_url: fields.imageUrl || null
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { id: row.id, editToken: row.edit_token };
}

export async function updateReportByToken(id, token, updates) {
  const { error } = await supabase.rpc('update_report_by_token', {
    p_id: id, p_token: token, p_updates: updates
  });
  if (error) throw error;
  return { success: true };
}

export async function resolveReportByToken(id, token) {
  const { error } = await supabase.rpc('resolve_report_by_token', { p_id: id, p_token: token });
  if (error) throw error;
  return { success: true };
}

export async function deleteReportByToken(id, token) {
  const { error } = await supabase.rpc('delete_report_by_token', { p_id: id, p_token: token });
  if (error) throw error;
  return { success: true };
}

export function buildEditLink(id, token) {
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}edit.html?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
}

// ─── ADMIN AUTH (real Supabase Authentication) ─────────────────
export async function adminSignIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}
export function adminSignOut() {
  return supabase.auth.signOut();
}
// Fires immediately with the current session, then again on every
// sign-in/sign-out — same shape as Firebase's onAuthStateChanged,
// so callers don't need to change.
export function onAdminAuthChanged(cb) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    cb(session?.user ?? null);
  });
  return () => data.subscription.unsubscribe();
}
export async function isCurrentUserAdmin(user) {
  if (!user) return false;
  const { data, error } = await supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (error) return false;
  return !!data;
}

// ─── ADMIN READS (all statuses) ────────────────────────────────
export async function fetchAllReportsAdmin() {
  const { data, error } = await supabase
    .from('reports')
    .select(REPORT_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export function computeStats(items) {
  return {
    total: items.length,
    active: items.filter(i => i.status === 'active').length,
    found: items.filter(i => i.type === 'found').length,
    deleted: items.filter(i => i.status === 'deleted').length,
    resolved: items.filter(i => i.status === 'resolved').length
  };
}

// ─── ADMIN WRITES (via RPC, require admin_users membership) ───
export async function adminSetStatus(id, status) {
  const { error } = await supabase.rpc('admin_set_status', { p_id: id, p_status: status });
  if (error) throw error;
  return { success: true };
}
export async function adminUpdateReport(id, updates) {
  const { error } = await supabase.rpc('admin_update_report', { p_id: id, p_updates: updates });
  if (error) throw error;
  return { success: true };
}
export async function adminCreateReport(fields) {
  const { data, error } = await supabase.rpc('admin_create_report', {
    p_type: fields.type,
    p_category: fields.category,
    p_title: fields.title,
    p_description: fields.description,
    p_location: fields.location,
    p_contact: fields.contact,
    p_image_url: fields.imageUrl || null,
    p_status: fields.status || 'active'
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { id: row.id, editToken: row.edit_token };
}
export async function adminDeletePermanently(id) {
  const { error } = await supabase.rpc('admin_delete_permanently', { p_id: id });
  if (error) throw error;
  return { success: true };
}

// ─── NOTIFICATIONS (owner gets emailed when their report is resolved) ─
let emailjsInitialized = false;
function isEmailjsConfigured() {
  return EMAILJS_SERVICE_ID && !EMAILJS_SERVICE_ID.startsWith('YOUR_')
      && EMAILJS_TEMPLATE_ID && !EMAILJS_TEMPLATE_ID.startsWith('YOUR_')
      && EMAILJS_PUBLIC_KEY && !EMAILJS_PUBLIC_KEY.startsWith('YOUR_');
}

// Sends an email to the report's owner letting them know their report was
// marked resolved. This is the "Owner receives notification" step of the
// Lost -> Found -> Notification workflow: an admin recognizes that a Found
// report matches someone's Lost report, marks the Lost report resolved,
// and this fires automatically as a result.
//
// Silently no-ops (with a console warning) if EmailJS hasn't been
// configured yet — nothing else in the app depends on this succeeding.
export async function sendResolutionNotification(item) {
  if (!isEmailjsConfigured()) {
    console.warn('EmailJS is not configured (see js/emailjs-config.js) — skipping notification email.');
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const { default: emailjs } = await import("https://esm.sh/@emailjs/browser@4");
    if (!emailjsInitialized) {
      emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
      emailjsInitialized = true;
    }
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email: item.contact,
      item_title: item.title,
      item_type: item.type,
      item_category: item.category,
      item_location: item.location
    });
    return { sent: true };
  } catch (err) {
    console.error('Failed to send resolution notification email:', err);
    return { sent: false, reason: err?.message || 'unknown_error' };
  }
}

// ─── SHARED UI: cards, modals, toast ───────────────────────────
export function formatDate(item) {
  if (!item.createdAt) return '—';
  return new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Date + time, used in the admin dashboard's "Reported" column so admins
// can see exactly when a report came in, not just the day.
export function formatDateTime(item) {
  if (!item.createdAt) return '—';
  const d = new Date(item.createdAt);
  const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

export function buildCardHTML(item) {
  const icon = getCategoryIcon(item.category);
  const badgeClass = item.type === 'lost' ? 'badge-lost' : 'badge-found';
  const badgeText = item.type === 'lost' ? 'Lost' : 'Found';
  const fmt = formatDate(item);
  const imgHTML = item.imageUrl
    ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}" onerror="this.style.display='none';this.parentNode.querySelector('i').style.display='block';">`
    : '';

  return `
    <div class="item-card" data-id="${item.id}" data-type="${item.type}" data-category="${item.category}">
      <span class="card-badge ${badgeClass}">${badgeText}</span>
      <div class="card-image">
        ${imgHTML}
        <i class="fas fa-${icon}" style="${item.imageUrl ? 'display:none' : ''}"></i>
      </div>
      <div class="card-content">
        <span class="card-category">${escapeHtml(item.category)}</span>
        <h3 class="card-title">${escapeHtml(item.title)}</h3>
        <p class="card-desc">${escapeHtml(item.description)}</p>
        <div class="card-meta">
          <span><i class="fas fa-map-marker-alt"></i> ${escapeHtml(item.location)}</span>
          <span><i class="fas fa-calendar"></i> ${fmt}</span>
        </div>
        <div class="card-footer">
          <a href="mailto:${item.contact}" class="contact-btn" style="flex:1;justify-content:center">
            <i class="fas fa-envelope"></i> Contact
          </a>
        </div>
      </div>
    </div>`;
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderItems(items, gridId = 'itemsGrid') {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-box-open"></i>
        <h3>No items found</h3>
        <p>Try adjusting your filters or report a new item.</p>
        <button class="btn btn-primary" onclick="openReportModal('lost')">
          <i class="fas fa-plus-circle"></i> Report an Item
        </button>
      </div>`;
    return;
  }

  grid.innerHTML = items.map(buildCardHTML).join('');
  attachCardClickListeners(grid, items);
}

function attachCardClickListeners(container, items) {
  container.querySelectorAll('.item-card').forEach(card => {
    card.addEventListener('click', function (e) {
      if (e.target.closest('.contact-btn')) return;
      const id = this.dataset.id;
      const item = items.find(i => i.id === id);
      if (item) openDetailModal(item);
    });
  });
}

// ─── REPORT MODAL ──────────────────────────────────────────────
export function openReportModal(type) {
  const modal = document.getElementById('reportModal');
  const modalTitle = document.getElementById('modalTitle');
  const submitBtnText = document.getElementById('submitBtnText');
  const itemTypeInput = document.getElementById('itemType');
  if (!modal) return;

  if (type === 'lost') {
    modalTitle.textContent = '🔍 Report Lost Item';
    submitBtnText.textContent = 'Report Lost Item';
    itemTypeInput.value = 'lost';
  } else {
    modalTitle.textContent = '🎉 Report Found Item';
    submitBtnText.textContent = 'Report Found Item';
    itemTypeInput.value = 'found';
  }
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

export function closeModal() {
  const modal = document.getElementById('reportModal');
  if (modal) {
    modal.classList.remove('active');
    document.body.style.overflow = 'auto';
  }
  const form = document.getElementById('reportForm');
  if (form) form.reset();
  const uploadP = document.querySelector('#reportModal .file-upload p');
  if (uploadP) uploadP.textContent = 'Click to upload or drag and drop';
}

export function openDetailModal(item) {
  const modal = document.getElementById('detailModal');
  if (!modal) return;

  const icon = getCategoryIcon(item.category);
  const badgeClass = item.type === 'lost' ? 'badge-lost' : 'badge-found';
  const badgeText = item.type === 'lost' ? 'Lost' : 'Found';
  const fmt = formatDate(item);

  const detailImage = document.getElementById('detailImage');
  detailImage.innerHTML = item.imageUrl
    ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}">`
    : `<i class="fas fa-${icon}"></i>`;

  const detailBadge = document.getElementById('detailBadge');
  detailBadge.className = `card-badge ${badgeClass}`;
  detailBadge.textContent = badgeText;

  document.getElementById('detailTitle').textContent = item.title;
  document.getElementById('detailCategory').textContent = item.category;
  document.getElementById('detailLocation').textContent = item.location;
  document.getElementById('detailDate').textContent = fmt;
  document.getElementById('detailDescription').textContent = item.description;

  const contactBtn = document.getElementById('detailContactBtn');
  contactBtn.href = `mailto:${item.contact}`;
  const contactEmailEl = document.getElementById('detailContactEmail');
  if (contactEmailEl) contactEmailEl.textContent = item.contact;

  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

export function closeDetailModal() {
  const modal = document.getElementById('detailModal');
  if (modal) {
    modal.classList.remove('active');
    document.body.style.overflow = 'auto';
  }
}

// ─── EDIT-LINK SUCCESS MODAL ────────────────────────────────────
export function openEditLinkModal(editLink, contactEmail) {
  const modal = document.getElementById('editLinkModal');
  if (!modal) return;
  document.getElementById('editLinkInput').value = editLink;
  const mailBtn = document.getElementById('editLinkEmailBtn');
  if (mailBtn) {
    const subject = encodeURIComponent('Your Foundly report — save this edit link');
    const body = encodeURIComponent(
      `Here's the link to edit, resolve, or delete your Foundly report:\n\n${editLink}\n\nKeep it safe — anyone with this link can manage this report.`
    );
    mailBtn.href = `mailto:${contactEmail || ''}?subject=${subject}&body=${body}`;
  }
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

export function closeEditLinkModal() {
  const modal = document.getElementById('editLinkModal');
  if (modal) {
    modal.classList.remove('active');
    document.body.style.overflow = 'auto';
  }
}

// ─── TOAST ───────────────────────────────────────────────────
export function showToast(message, type = '') {
  let toast = document.getElementById('foundlyToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'foundlyToast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.className = `toast ${type ? 'toast-' + type : ''}`;
  const iconClass = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';
  toast.innerHTML = `<i class="fas ${iconClass}"></i><span>${message}</span>`;
  requestAnimationFrame(() => { toast.classList.add('show'); });
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ─── REPORT SUBMISSION (image upload -> RPC) ───────────────────
export async function submitReportForm({ type, category, title, description, location, contact, imageFile }) {
  let imageUrl = null;
  if (imageFile) {
    imageUrl = await uploadReportImage(imageFile);
  }
  const { id, editToken } = await createReport({ type, category, title, description, location, contact, imageUrl });
  return { id, editToken, editLink: buildEditLink(id, editToken) };
}

// ─── GLOBAL LISTENERS ───────────────────────────────────────────
document.addEventListener('click', function (e) {
  const modal = document.getElementById('reportModal');
  if (modal && e.target === modal) closeModal();
  const detailModal = document.getElementById('detailModal');
  if (detailModal && e.target === detailModal) closeDetailModal();
  const editLinkModal = document.getElementById('editLinkModal');
  if (editLinkModal && e.target === editLinkModal) closeEditLinkModal();
});

