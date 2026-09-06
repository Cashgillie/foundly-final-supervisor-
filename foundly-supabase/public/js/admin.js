import {
  adminSignIn, adminSignOut, onAdminAuthChanged, isCurrentUserAdmin,
  fetchAllReportsAdmin, computeStats, adminSetStatus, adminUpdateReport,
  adminCreateReport, adminDeletePermanently, uploadReportImage,
  getCategoryIcon, escapeHtml, showToast, formatDateTime, formatDate,
  validateImageFile, readImageAsDataURL, sendResolutionNotification
} from './foundly-data.js';

let currentTab = 'all';
let currentEditId = null;
window.currentPreviewId = null; // read by the inline "Edit" button in the preview modal
let pendingImageUrl = null;
let allItems = [];

// ─── Auth flow ──────────────────────────────────────────────
function showGate(id) {
  ['loginGate', 'notAdminGate', 'adminContent'].forEach(s => {
    document.getElementById(s).style.display = s === id ? (s === 'adminContent' ? 'block' : 'flex') : 'none';
  });
}

onAdminAuthChanged(async (user) => {
  if (!user) {
    showGate('loginGate');
    return;
  }
  const isAdmin = await isCurrentUserAdmin(user);
  if (!isAdmin) {
    showGate('notAdminGate');
    return;
  }
  document.getElementById('adminEmailLabel').textContent = user.email;
  showGate('adminContent');
  reloadAdminData();
});

document.getElementById('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('gateEmail').value;
  const password = document.getElementById('gatePassword').value;
  const btn = document.getElementById('gateSubmitBtn');
  const errorEl = document.getElementById('gateError');
  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';

  try {
    await adminSignIn(email, password);
    // onAdminAuthChanged handles the rest
  } catch (err) {
    errorEl.textContent = err.message || 'Sign-in failed. Check your email and password.';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-right-to-bracket"></i> Sign In';
  }
});

function handleSignOut() {
  adminSignOut().then(() => window.location.href = 'index.html');
}

function handleSignOutAndReload() {
  adminSignOut().then(() => window.location.reload());
}

// ─── Data loading ────────────────────────────────────────────
async function reloadAdminData() {
  const tbody = document.getElementById('adminTableBody');
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:48px;color:var(--gray)">
    <i class="fas fa-spinner fa-spin" style="font-size:24px;display:block;margin-bottom:12px"></i>Loading reports…
  </td></tr>`;
  try {
    allItems = await fetchAllReportsAdmin();
    renderStats();
    renderTable();
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:48px;color:var(--danger)">
      Couldn't load reports. ${escapeHtml(err.message || '')}
    </td></tr>`;
  }
}

function renderStats() {
  const s = computeStats(allItems);
  document.getElementById('statTotal').textContent = s.total;
  document.getElementById('statActiveCount').textContent = s.active;
  document.getElementById('statFoundCount').textContent = s.found;
  document.getElementById('statResolvedCount').textContent = s.resolved;
  document.getElementById('statDeletedCount').textContent = s.deleted;
}

function getFilteredAdminItems() {
  let items = allItems;
  if (currentTab !== 'all') items = items.filter(i => i.status === currentTab);

  const type = document.getElementById('adminTypeFilter')?.value || 'all';
  if (type !== 'all') items = items.filter(i => i.type === type);

  const cat = document.getElementById('adminCategoryFilter')?.value || '';
  if (cat) items = items.filter(i => i.category === cat);

  const term = (document.getElementById('adminSearchInput')?.value || '').toLowerCase().trim();
  if (term) items = items.filter(i =>
    i.title.toLowerCase().includes(term) ||
    i.description.toLowerCase().includes(term) ||
    i.location.toLowerCase().includes(term)
  );
  return items;
}

function applyAdminFilters() { renderTable(); }

function setTab(tab, el) {
  currentTab = tab;
  document.querySelectorAll('#statusTabs .pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  renderTable();
}

function filterFromStatCard(tab, type) {
  currentTab = tab;
  document.getElementById('adminTypeFilter').value = type || 'all';
  document.querySelectorAll('#statusTabs .pill').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  renderTable();
  document.querySelector('.admin-table-wrapper').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderTable() {
  const items = getFilteredAdminItems();
  const tbody = document.getElementById('adminTableBody');
  document.getElementById('adminResultCount').textContent = items.length;

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:48px;color:var(--gray)">
      <i class="fas fa-box-open" style="font-size:32px;display:block;margin-bottom:12px"></i>
      No items match your filters.
    </td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(buildAdminRow).join('');
}

function buildAdminRow(item) {
  const icon = getCategoryIcon(item.category);
  const badgeClass = item.type === 'lost' ? 'badge-lost' : 'badge-found';
  const badgeText = item.type === 'lost' ? 'Lost' : 'Found';
  const status = item.status || 'active';
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  const thumb = item.imageUrl ? `<img src="${item.imageUrl}" alt="">` : `<i class="fas fa-${icon}"></i>`;

  let menuItems = `<button onclick="openItemModal('edit', '${item.id}')"><i class="fas fa-pen"></i> Edit</button>`;

  if (status === 'deleted') {
    menuItems += `<button class="success-item" onclick="restoreRow('${item.id}')"><i class="fas fa-rotate-left"></i> Restore</button>`;
    menuItems += `<hr>`;
    menuItems += `<button class="danger-item" onclick="permanentlyDeleteRow('${item.id}')"><i class="fas fa-trash-can"></i> Delete Permanently</button>`;
  } else {
    if (status !== 'resolved') {
      menuItems += `<button class="success-item" onclick="resolveRow('${item.id}')"><i class="fas fa-handshake"></i> Mark Resolved</button>`;
    }
    menuItems += `<hr>`;
    menuItems += `<button class="danger-item" onclick="deleteRow('${item.id}')"><i class="fas fa-trash"></i> Delete</button>`;
  }

  return `
    <tr data-id="${item.id}">
      <td onclick="openPreviewModal('${item.id}')" style="cursor:pointer"><div class="admin-thumb">${thumb}</div></td>
      <td onclick="openPreviewModal('${item.id}')" style="cursor:pointer">
        <div class="admin-item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="admin-item-sub"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(item.location)}</div>
      </td>
      <td><span class="card-badge ${badgeClass}" style="position:static;display:inline-block">${badgeText}</span></td>
      <td>${capitalize(item.category)}</td>
      <td>${formatDateTime(item)}</td>
      <td><span class="status-pill status-${status}">${statusLabel}</span></td>
      <td class="admin-actions">
        <div class="dropdown">
          <button class="dropdown-toggle" onclick="toggleActionsMenu(event, '${item.id}')" title="Actions">
            <i class="fas fa-ellipsis-vertical"></i>
          </button>
          <div class="dropdown-menu" id="menu-${item.id}">${menuItems}</div>
        </div>
      </td>
    </tr>`;
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

// ─── Item preview modal ──────────────────────────────────────
function openPreviewModal(id) {
  const item = allItems.find(i => i.id === id);
  if (!item) return;
  window.currentPreviewId = id;

  const icon = getCategoryIcon(item.category);
  const badgeClass = item.type === 'lost' ? 'badge-lost' : 'badge-found';
  const badgeText = item.type === 'lost' ? 'Lost' : 'Found';
  const status = item.status || 'active';

  const previewImage = document.getElementById('previewImage');
  previewImage.innerHTML = item.imageUrl
    ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}">`
    : `<i class="fas fa-${icon}"></i>`;

  const badge = document.getElementById('previewBadge');
  badge.className = `card-badge ${badgeClass}`;
  badge.textContent = badgeText;

  const statusPill = document.getElementById('previewStatusPill');
  statusPill.className = `status-pill status-${status}`;
  statusPill.textContent = status.charAt(0).toUpperCase() + status.slice(1);

  document.getElementById('previewTitle').textContent = item.title;
  document.getElementById('previewCategory').textContent = item.category;
  document.getElementById('previewLocation').textContent = item.location;
  document.getElementById('previewDate').textContent = formatDateTime(item);
  document.getElementById('previewDescription').textContent = item.description;
  document.getElementById('previewContactBtn').href = `mailto:${item.contact}`;
  document.getElementById('previewContactEmail').textContent = item.contact;

  document.getElementById('adminPreviewModal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closePreviewModal() {
  document.getElementById('adminPreviewModal').classList.remove('active');
  document.body.style.overflow = 'auto';
}

// ─── Actions dropdown ────────────────────────────────────────
function closeAllActionMenus(except) {
  document.querySelectorAll('.dropdown-menu.open').forEach(m => {
    if (m !== except) m.classList.remove('open');
  });
}

function toggleActionsMenu(event, id) {
  event.stopPropagation();
  const menu = document.getElementById(`menu-${id}`);
  const wasOpen = menu.classList.contains('open');
  closeAllActionMenus();
  if (!wasOpen) menu.classList.add('open');
}

document.addEventListener('click', () => closeAllActionMenus());

// ─── Row actions ─────────────────────────────────────────────
async function withRowAction(id, status, successMsg, toastType) {
  try {
    await adminSetStatus(id, status);
    showToast(successMsg, toastType);
    await reloadAdminData();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Action failed.', 'error');
  }
}

const restoreRow = (id) => withRowAction(id, 'active', 'Item restored', 'success');

async function resolveRow(id) {
  const item = allItems.find(i => i.id === id);
  try {
    await adminSetStatus(id, 'resolved');
    showToast('Marked as resolved', 'success');
    await reloadAdminData();

    if (item) {
      const result = await sendResolutionNotification(item);
      if (result.sent) {
        showToast(`📧 Notified ${item.contact}`, 'success');
      } else if (result.reason === 'not_configured') {
        showToast('Marked resolved (email notifications not set up yet)', '');
      } else {
        showToast('Marked resolved, but the notification email failed to send', 'error');
      }
    }
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Action failed.', 'error');
  }
}

function deleteRow(id) {
  if (!confirm('Move this item to Deleted? You can restore it later.')) return;
  withRowAction(id, 'deleted', 'Item deleted', '');
}

async function permanentlyDeleteRow(id) {
  if (!confirm('Permanently delete this item? This cannot be undone.')) return;
  try {
    await adminDeletePermanently(id);
    showToast('Item permanently deleted', 'error');
    await reloadAdminData();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Delete failed.', 'error');
  }
}

// ─── Create / Edit modal ─────────────────────────────────────
function openItemModal(mode, id) {
  currentEditId = mode === 'edit' ? id : null;

  const form = document.getElementById('adminItemForm');
  form.reset();
  document.getElementById('adminFileUploadText').textContent = 'Click to upload or drag and drop';
  document.getElementById('adminCurrentImagePreview').style.display = 'none';
  document.getElementById('adminRemoveImageBtn').style.display = 'none';
  pendingImageUrl = undefined; // undefined = no change; null = explicitly cleared

  if (mode === 'edit') {
    const item = allItems.find(i => i.id === id);
    if (!item) return;
    document.getElementById('adminModalTitle').textContent = 'Edit Item';
    document.getElementById('adminSubmitBtnText').textContent = 'Save Changes';
    document.getElementById('adminItemId').value = item.id;
    document.getElementById('adminItemType').value = item.type;
    document.getElementById('adminItemStatus').value = item.status || 'active';
    document.getElementById('adminItemTitle').value = item.title;
    document.getElementById('adminItemCategory').value = item.category;
    document.getElementById('adminItemLocation').value = item.location;
    document.getElementById('adminItemDescription').value = item.description;
    document.getElementById('adminItemEmail').value = item.contact;
    if (item.imageUrl) {
      const preview = document.getElementById('adminCurrentImagePreview');
      preview.src = item.imageUrl;
      preview.style.display = 'block';
      document.getElementById('adminRemoveImageBtn').style.display = 'inline-flex';
    }
  } else {
    document.getElementById('adminModalTitle').textContent = 'Add New Item';
    document.getElementById('adminSubmitBtnText').textContent = 'Add Item';
    document.getElementById('adminItemId').value = '';
    document.getElementById('adminItemStatus').value = 'active';
  }

  document.getElementById('adminItemModal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeItemModal() {
  document.getElementById('adminItemModal').classList.remove('active');
  document.body.style.overflow = 'auto';
  currentEditId = null;
  pendingImageUrl = null;
}

function clearAdminImage() {
  pendingImageUrl = null; // explicit clear — will remove the image on save
  const input = document.getElementById('adminItemImage');
  if (input) input.value = '';
  const preview = document.getElementById('adminCurrentImagePreview');
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  document.getElementById('adminFileUploadText').textContent = 'Click to upload or drag and drop';
  document.getElementById('adminRemoveImageBtn').style.display = 'none';
}

document.getElementById('adminItemImage').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const check = validateImageFile(file);
  if (!check.valid) {
    showToast(check.error, 'error');
    e.target.value = '';
    return;
  }

  // Instant local preview while the real upload happens in the background.
  try {
    const previewUrl = await readImageAsDataURL(file);
    const preview = document.getElementById('adminCurrentImagePreview');
    preview.src = previewUrl;
    preview.style.display = 'block';
    document.getElementById('adminRemoveImageBtn').style.display = 'inline-flex';
  } catch (_) { /* preview is best-effort, not fatal */ }

  document.getElementById('adminFileUploadText').innerHTML = `<i class="fas fa-spinner fa-spin"></i> Uploading...`;
  try {
    pendingImageUrl = await uploadReportImage(file);
    document.getElementById('adminFileUploadText').innerHTML =
      `<i class="fas fa-check-circle" style="color:#10b981"></i> ${escapeHtml(file.name)}`;
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Error uploading image.', 'error');
    document.getElementById('adminFileUploadText').textContent = 'Click to upload or drag and drop';
  }
});

async function submitItemForm(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');
  const original = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  const fields = {
    type: document.getElementById('adminItemType').value,
    status: document.getElementById('adminItemStatus').value,
    title: document.getElementById('adminItemTitle').value.trim(),
    category: document.getElementById('adminItemCategory').value,
    location: document.getElementById('adminItemLocation').value.trim(),
    description: document.getElementById('adminItemDescription').value.trim(),
    contact: document.getElementById('adminItemEmail').value.trim()
  };
  if (pendingImageUrl !== undefined) fields.imageUrl = pendingImageUrl;

  // Was this item already resolved before this save? Only notify on the
  // active/etc -> resolved transition, not on every subsequent edit.
  const previousItem = currentEditId ? allItems.find(i => i.id === currentEditId) : null;
  const justResolved = fields.status === 'resolved' && previousItem?.status !== 'resolved';

  try {
    if (currentEditId) {
      await adminUpdateReport(currentEditId, fields);
      showToast('✅ Item updated', 'success');
    } else {
      await adminCreateReport(fields);
      showToast('✅ Item created', 'success');
    }
    closeItemModal();
    await reloadAdminData();

    if (justResolved) {
      const result = await sendResolutionNotification({ ...previousItem, ...fields });
      if (result.sent) showToast(`📧 Notified ${fields.contact}`, 'success');
    }
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Error saving item. Please try again.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = original;
  }
}

document.addEventListener('click', function (e) {
  const modal = document.getElementById('adminItemModal');
  if (modal && e.target === modal) closeItemModal();
});

Object.assign(window, {
  handleSignOut, handleSignOutAndReload, reloadAdminData,
  applyAdminFilters, setTab, filterFromStatCard,
  resolveRow, restoreRow, deleteRow, permanentlyDeleteRow,
  openItemModal, closeItemModal, submitItemForm, toggleActionsMenu, clearAdminImage,
  openPreviewModal, closePreviewModal
});

document.addEventListener('click', function (e) {
  const modal = document.getElementById('adminPreviewModal');
  if (modal && e.target === modal) closePreviewModal();
});
