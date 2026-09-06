import {
  fetchReportById, uploadReportImage, updateReportByToken,
  resolveReportByToken, deleteReportByToken, showToast,
  validateImageFile, readImageAsDataURL
} from './foundly-data.js';

const params = new URLSearchParams(location.search);
const reportId = params.get('id');
const editToken = params.get('token');

let currentReport = null;
let pendingImageFile = null;
let imageExplicitlyCleared = false;

function show(id) {
  ['loadingState', 'invalidState', 'notFoundState', 'editPanel'].forEach(s => {
    document.getElementById(s).style.display = s === id ? '' : 'none';
  });
}

function populateForm(item) {
  document.getElementById('editType').value = item.type;
  document.getElementById('editTitle').value = item.title;
  document.getElementById('editCategory').value = item.category;
  document.getElementById('editLocation').value = item.location;
  document.getElementById('editDescription').value = item.description;
  document.getElementById('editContact').value = item.contact;

  const pill = document.getElementById('statusPill');
  pill.textContent = item.status.charAt(0).toUpperCase() + item.status.slice(1);
  pill.className = `status-pill status-${item.status}`;

  const preview = document.getElementById('currentImagePreview');
  const removeBtn = document.getElementById('editRemoveImageBtn');
  if (item.imageUrl) {
    preview.src = item.imageUrl;
    preview.style.display = 'block';
    removeBtn.style.display = 'inline-flex';
  } else {
    preview.style.display = 'none';
    removeBtn.style.display = 'none';
  }

  const isDeleted = item.status === 'deleted';
  document.getElementById('deletedNotice').style.display = isDeleted ? 'block' : 'none';
  document.getElementById('saveBtn').disabled = isDeleted;
  document.getElementById('resolveBtn').disabled = isDeleted || item.status === 'resolved';
  document.getElementById('deleteBtn').disabled = isDeleted;
  document.querySelectorAll('#editForm input, #editForm select, #editForm textarea')
    .forEach(el => { el.disabled = isDeleted; });
}

async function loadReport() {
  if (!reportId || !editToken) {
    show('invalidState');
    return;
  }
  try {
    const item = await fetchReportById(reportId);
    if (!item) {
      show('notFoundState');
      return;
    }
    currentReport = item;
    populateForm(item);
    show('editPanel');
  } catch (err) {
    console.error(err);
    show('notFoundState');
  }
}

async function handleSave(event) {
  event.preventDefault();
  const saveBtn = document.getElementById('saveBtn');
  const original = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  try {
    const updates = {
      type: document.getElementById('editType').value,
      title: document.getElementById('editTitle').value,
      category: document.getElementById('editCategory').value,
      location: document.getElementById('editLocation').value,
      description: document.getElementById('editDescription').value,
      contact: document.getElementById('editContact').value
    };
    if (pendingImageFile) {
      updates.imageUrl = await uploadReportImage(pendingImageFile);
    } else if (imageExplicitlyCleared) {
      updates.imageUrl = null;
    }
    await updateReportByToken(reportId, editToken, updates);
    pendingImageFile = null;
    imageExplicitlyCleared = false;
    showToast('✅ Changes saved!', 'success');
    await loadReport();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not save changes. Check your link and try again.', 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = original;
  }
}

async function handleResolve() {
  if (!confirm('Mark this report as resolved? It will be removed from public listings.')) return;
  try {
    await resolveReportByToken(reportId, editToken);
    showToast('🎉 Marked as resolved!', 'success');
    await loadReport();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not update status.', 'error');
  }
}

async function handleDelete() {
  if (!confirm('Delete this report? It will no longer be visible to anyone.')) return;
  try {
    await deleteReportByToken(reportId, editToken);
    showToast('Report deleted.', '');
    await loadReport();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not delete report.', 'error');
  }
}

function handleEditImageChange(e) {
  const file = e.target.files[0];
  if (!file) return;

  const check = validateImageFile(file);
  if (!check.valid) {
    showToast(check.error, 'error');
    e.target.value = '';
    return;
  }

  pendingImageFile = file;
  imageExplicitlyCleared = false;
  document.getElementById('editUploadText').innerHTML =
    `<i class="fas fa-check-circle" style="color:#10b981"></i> ${file.name}`;

  readImageAsDataURL(file).then(dataUrl => {
    const preview = document.getElementById('currentImagePreview');
    preview.src = dataUrl;
    preview.style.display = 'block';
    document.getElementById('editRemoveImageBtn').style.display = 'inline-flex';
  });
}

function clearEditImage() {
  pendingImageFile = null;
  imageExplicitlyCleared = true;
  const input = document.getElementById('editImage');
  if (input) input.value = '';
  const preview = document.getElementById('currentImagePreview');
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  document.getElementById('editUploadText').textContent = 'Click to upload a new photo (optional)';
  document.getElementById('editRemoveImageBtn').style.display = 'none';
}

document.getElementById('editImage')?.addEventListener('change', handleEditImageChange);

document.getElementById('editForm').addEventListener('submit', handleSave);
Object.assign(window, { handleResolve, handleDelete, clearEditImage });

loadReport();
