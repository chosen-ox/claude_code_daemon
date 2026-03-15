// CC-Daemon GUI Application

// State
let tasks = [];
let tmuxSessions = [];
let activeSessions = [];
let statusFilter = 'active';
let sortBy = 'created-desc';
let searchQuery = '';
let tagFilter = '';  // Current tag filter
let availableTags = new Set();  // All available tags from tasks
let refreshInterval = null;
let selectMode = false;
let selectedTasks = new Set();
let currentDetailTab = 'overview';
let currentDetailTask = null;
let isDarkMode = true;
let currentSessionOutput = null;  // For session output modal
let userIsScrolling = false;  // Track if user is manually scrolling
let scrollTimeout = null;  // Timeout to reset userIsScrolling
let starredTasks = new Set();  // Starred/pinned tasks
let taskTemplates = [];  // Task templates
let webSocket = null;  // WebSocket connection for real-time updates
let wsReconnectAttempts = 0;  // WebSocket reconnection attempts
const WS_MAX_RECONNECT_ATTEMPTS = 5;  // Maximum reconnection attempts
const WS_RECONNECT_DELAY = 3000;  // Delay between reconnection attempts (ms)

// Modal drag detection - prevent accidental closing when dragging from inputs
let modalMouseDownPos = null;  // Track mouse position on mousedown
const DRAG_THRESHOLD = 5;  // Pixels - if mouse moves more than this, it's a drag not a click

// Settings state
let settings = {
  refreshInterval: 10000,  // 10 seconds
  contextWarningThreshold: 75,  // 75%
  contextDangerThreshold: 90,  // 90%
  defaultMaxIterations: 100,
  defaultThresholdPercent: 80,
  defaultUseTmux: true,
  defaultRalphLoop: false,
  notifications: true,
  autoTriggerEnabled: false,
  autoTriggerInterval: 60  // seconds
};

// DOM Elements
const tasksList = document.getElementById('tasks-list');
const tmuxSessionsList = document.getElementById('tmux-sessions');
const activeSessionsList = document.getElementById('active-sessions');
const workSessionsList = document.getElementById('work-sessions');
const otherSessionsList = document.getElementById('other-sessions');
const contextDisplay = document.getElementById('context-display');
const lastUpdateEl = document.getElementById('last-update');
const statusFilterSelect = document.getElementById('status-filter');
const taskModal = document.getElementById('task-modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalFooter = document.getElementById('modal-footer');
const createTaskModal = document.getElementById('create-task-modal');
const createTaskForm = document.getElementById('create-task-form');
const confirmModal = document.getElementById('confirm-modal');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmInputContainer = document.getElementById('confirm-input-container');
const confirmInput = document.getElementById('confirm-input');
const confirmInputLabel = document.getElementById('confirm-input-label');
const confirmOkBtn = document.getElementById('confirm-ok');
const confirmCancelBtn = document.getElementById('confirm-cancel');
const helpModal = document.getElementById('help-modal');
const exportModal = document.getElementById('export-modal');
const settingsModal = document.getElementById('settings-modal');
const batchActionBar = document.getElementById('batch-action-bar');
const selectedCountEl = document.getElementById('selected-count');

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    const tabName = tab.dataset.tab;
    document.getElementById(`${tabName}-tab`).classList.add('active');

    if (tabName === 'sessions') {
      loadSessions();
    } else if (tabName === 'context') {
      loadContext();
    } else if (tabName === 'dashboard') {
      loadDashboard();
    }
  });
});

// Detail tab switching
document.querySelectorAll('.detail-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentDetailTab = tab.dataset.detailTab;
    if (currentDetailTask) {
      renderDetailContent(currentDetailTask);
    }
  });
});

// Event Listeners
document.getElementById('refresh-btn').addEventListener('click', refreshAll);
document.getElementById('refresh-sessions-btn')?.addEventListener('click', loadSessions);
document.getElementById('refresh-context-btn')?.addEventListener('click', loadContext);
document.getElementById('refresh-dashboard-btn')?.addEventListener('click', loadDashboard);

document.getElementById('create-task-btn').addEventListener('click', () => {
  populateDependenciesDropdown();
  createTaskModal.classList.add('active');
});

// Search input listener
document.getElementById('task-search')?.addEventListener('input', (e) => {
  searchQuery = e.target.value.toLowerCase().trim();
  renderTasks();
});

// Sort select listener
document.getElementById('sort-select')?.addEventListener('change', (e) => {
  sortBy = e.target.value;
  renderTasks();
});

document.getElementById('select-mode-btn')?.addEventListener('click', toggleSelectMode);
document.getElementById('export-btn')?.addEventListener('click', () => exportModal.classList.add('active'));
document.getElementById('settings-btn')?.addEventListener('click', () => {
  populateSettingsForm();
  settingsModal.classList.add('active');
});
document.getElementById('theme-toggle-btn')?.addEventListener('click', toggleTheme);

statusFilterSelect?.addEventListener('change', (e) => {
  statusFilter = e.target.value;
  renderTasks();
});

// Tag filter listener
document.getElementById('tag-filter')?.addEventListener('change', (e) => {
  tagFilter = e.target.value;
  renderTasks();
});

// Modal close handlers
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal');
    modal.classList.remove('active');
  });
});

// Track mousedown position for drag detection
[taskModal, createTaskModal, confirmModal, helpModal, exportModal, settingsModal].forEach(modal => {
  if (!modal) return;
  modal.addEventListener('mousedown', (e) => {
    modalMouseDownPos = { x: e.clientX, y: e.clientY };
  });
});

taskModal.addEventListener('click', (e) => {
  if (e.target === taskModal && !isDragAction(e)) closeTaskModal();
});

createTaskModal.addEventListener('click', (e) => {
  if (e.target === createTaskModal && !isDragAction(e)) closeCreateTaskModal();
});

confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal && !isDragAction(e)) closeConfirmModal();
});

helpModal?.addEventListener('click', (e) => {
  if (e.target === helpModal && !isDragAction(e)) closeHelpModal();
});

exportModal?.addEventListener('click', (e) => {
  if (e.target === exportModal && !isDragAction(e)) closeExportModal();
});

settingsModal?.addEventListener('click', (e) => {
  if (e.target === settingsModal && !isDragAction(e)) closeSettingsModal();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Don't trigger shortcuts when typing in inputs
  const isInputFocused = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';

  if (e.key === 'Escape') {
    closeTaskModal();
    closeCreateTaskModal();
    closeConfirmModal();
    closeHelpModal();
    closeExportModal();
    closeSettingsModal();
    if (selectMode) toggleSelectMode();
  }

  if (isInputFocused) return;

  if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    refreshAll();
    showToast('Refreshed', 'info');
  }

  if (e.key === 'n' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    createTaskModal.classList.add('active');
  }

  if (e.key === 'f' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    statusFilterSelect.focus();
    statusFilterSelect.click();
  }

  if (e.key === '?') {
    e.preventDefault();
    helpModal.classList.add('active');
  }

  if (e.key === 'd' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleTheme();
  }

  if (e.key === 'e' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    exportModal.classList.add('active');
  }

  if (e.key === 's' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleSelectMode();
  }
});

// Create Task Form
createTaskForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = new FormData(createTaskForm);
  let goal = formData.get('goal').trim();
  const completionPromise = formData.get('completionPromise').trim() || undefined;
  const maxIterations = parseInt(formData.get('maxIterations')) || 100;
  const thresholdPercent = parseInt(formData.get('thresholdPercent')) || 80;
  const stepsText = formData.get('steps').trim();
  const steps = stepsText ? stepsText.split('\n').map(s => s.trim()).filter(s => s) : undefined;
  const tmux = formData.get('tmux') === 'on';
  const ralphLoop = document.getElementById('task-ralph-loop')?.checked || false;
  const enableVerification = document.getElementById('task-enable-verification')?.checked || false;
  const enableAutoTrigger = document.getElementById('task-enable-auto-trigger')?.checked || false;

  // Handle tags
  const tagsText = formData.get('tags')?.trim() || '';
  const tags = tagsText ? tagsText.split(',').map(t => t.trim()).filter(t => t) : undefined;

  // Handle dependencies
  const dependsOnSelect = document.getElementById('task-depends-on');
  const dependsOn = dependsOnSelect ? Array.from(dependsOnSelect.selectedOptions).map(opt => opt.value).filter(v => v) : undefined;

  if (!goal) {
    showToast('Goal is required', 'error');
    return;
  }

  try {
    // Get working directory from form field
    const workingDir = (formData.get('workingDir') || '').trim() || './workspace/';

    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal,
        completionPromise,
        maxIterations,
        thresholdPercent,
        steps,
        tmux,
        ralphLoop,
        enableVerification,
        enableAutoTrigger,
        tags,
        dependsOn,
        workingDir
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to create task');
    }

    showToast(`Task created: ${result.taskId}`, 'success');
    closeCreateTaskModal();
    createTaskForm.reset();
    // Reset checkbox to default
    document.getElementById('task-tmux').checked = true;
    await loadTasks();

    // Browser notification
    showBrowserNotification('Task Created', `Task ${result.taskId} has been created successfully.`);
  } catch (error) {
    showToast(error.message, 'error');
  }
});

// API Functions
async function fetchAPI(endpoint, options = {}) {
  const response = await fetch(endpoint, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(error.error || 'API error');
  }
  return response.json();
}

async function loadTasks() {
  try {
    tasksList.innerHTML = '<div class="loading">Loading tasks...</div>';
    tasks = await fetchAPI('/api/tasks');
    updateAvailableTags();
    renderTasks();
  } catch (error) {
    tasksList.innerHTML = `<div class="empty-state">Error loading tasks: ${error.message}</div>`;
  }
}

async function loadSessions() {
  try {
    tmuxSessionsList.innerHTML = '<div class="loading">Loading tmux sessions...</div>';
    workSessionsList.innerHTML = '<div class="loading">Loading work sessions...</div>';
    otherSessionsList.innerHTML = '<div class="loading">Loading other sessions...</div>';

    const [tmux, active] = await Promise.all([
      fetchAPI('/api/sessions/tmux'),
      fetchAPI('/api/sessions/active')
    ]);

    tmuxSessions = tmux;
    activeSessions = active;

    renderTmuxSessions();
    renderWorkSessions();
    renderOtherSessions();
  } catch (error) {
    tmuxSessionsList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
    workSessionsList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
    otherSessionsList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
  }
}

async function loadContext() {
  try {
    contextDisplay.innerHTML = '<div class="loading">Loading context data...</div>';
    activeSessions = await fetchAPI('/api/context');
    renderContext();
  } catch (error) {
    contextDisplay.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
  }
}

// Task Actions
async function cancelTask(taskId) {
  showConfirmDialog({
    title: 'Cancel Task',
    message: `Are you sure you want to cancel task ${taskId}?`,
    inputLabel: 'Reason (optional)',
    showInput: true,
    onConfirm: async (reason) => {
      try {
        await fetchAPI(`/api/tasks/${taskId}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason })
        });
        showToast('Task cancelled successfully', 'success');
        await loadTasks();
      } catch (error) {
        showToast(`Failed to cancel task: ${error.message}`, 'error');
      }
    }
  });
}

async function resumeTask(taskId) {
  showConfirmDialog({
    title: 'Resume Task',
    message: `Are you sure you want to resume task ${taskId}?`,
    onConfirm: async () => {
      try {
        await fetchAPI(`/api/tasks/${taskId}/resume`, { method: 'POST' });
        showToast('Task resumed successfully', 'success');
        await loadTasks();
        closeTaskModal();
      } catch (error) {
        showToast(`Failed to resume task: ${error.message}`, 'error');
      }
    }
  });
}

async function verifyTask(taskId) {
  showConfirmDialog({
    title: 'Verify Task',
    message: `Start verification for task ${taskId}? This will run a clean session to verify completion.`,
    onConfirm: async () => {
      try {
        await fetchAPI(`/api/tasks/${taskId}/verify`, { method: 'POST' });
        showToast('Verification started', 'info');
        closeTaskModal();
      } catch (error) {
        showToast(`Failed to start verification: ${error.message}`, 'error');
      }
    }
  });
}

async function deleteTask(taskId) {
  showConfirmDialog({
    title: 'Delete Task',
    message: `Are you sure you want to DELETE task ${taskId}? This action cannot be undone.`,
    confirmText: 'Delete',
    danger: true,
    onConfirm: async () => {
      try {
        await fetchAPI(`/api/tasks/${taskId}`, { method: 'DELETE' });
        showToast('Task deleted successfully', 'success');
        await loadTasks();
        closeTaskModal();
      } catch (error) {
        showToast(`Failed to delete task: ${error.message}`, 'error');
      }
    }
  });
}

// Batch Operations
function toggleSelectMode() {
  selectMode = !selectMode;
  selectedTasks.clear();
  updateBatchActionBar();

  const btn = document.getElementById('select-mode-btn');
  if (selectMode) {
    btn.classList.add('btn-primary');
    btn.classList.remove('btn-secondary');
    document.body.classList.add('select-mode-active');
  } else {
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-secondary');
    document.body.classList.remove('select-mode-active');
  }

  renderTasks();
}

function toggleTaskSelection(taskId) {
  if (selectedTasks.has(taskId)) {
    selectedTasks.delete(taskId);
  } else {
    selectedTasks.add(taskId);
  }
  updateBatchActionBar();

  // Update visual state
  const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
  if (card) {
    if (selectedTasks.has(taskId)) {
      card.classList.add('selected', 'selectable');
    } else {
      card.classList.remove('selected');
    }
  }
}

function updateBatchActionBar() {
  if (selectedTasks.size > 0) {
    batchActionBar.style.display = 'flex';
    selectedCountEl.textContent = `${selectedTasks.size} selected`;
  } else {
    batchActionBar.style.display = 'none';
  }
}

// Tag functions
function filterByTag(tag) {
  tagFilter = tag;
  const tagFilterSelect = document.getElementById('tag-filter');
  if (tagFilterSelect) {
    tagFilterSelect.value = tag;
  }
  renderTasks();
}

function updateAvailableTags() {
  const tags = new Set();
  tasks.forEach(task => {
    const taskTags = task.metadata?.tags || [];
    taskTags.forEach(tag => tags.add(tag));
  });
  availableTags = tags;

  const tagFilterSelect = document.getElementById('tag-filter');
  if (tagFilterSelect) {
    const currentValue = tagFilterSelect.value;
    tagFilterSelect.innerHTML = '<option value="">All Tags</option>' +
      [...tags].sort().map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
    tagFilterSelect.value = currentValue;
  }
}

// Populate dependencies dropdown with available tasks
function populateDependenciesDropdown() {
  const dependsOnSelect = document.getElementById('task-depends-on');
  if (!dependsOnSelect) return;

  // Get tasks that can be dependencies (completed or active tasks)
  const availableTasks = tasks.filter(task =>
    task.metadata?.status === 'completed' || task.metadata?.status === 'active'
  );

  dependsOnSelect.innerHTML = '<option value="">Select task...</option>' +
    availableTasks.map(task =>
      `<option value="${task.metadata.id}">${task.metadata.id.slice(0, 8)} - ${escapeHtml(task.plan?.goal?.slice(0, 50) || 'No goal')} (${task.metadata.status})</option>`
    ).join('');
}

async function batchCancel() {
  if (selectedTasks.size === 0) return;

  showConfirmDialog({
    title: 'Cancel Selected Tasks',
    message: `Are you sure you want to cancel ${selectedTasks.size} tasks?`,
    confirmText: 'Cancel All',
    danger: true,
    onConfirm: async () => {
      let successCount = 0;
      let failCount = 0;

      for (const taskId of selectedTasks) {
        try {
          await fetchAPI(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
          successCount++;
        } catch {
          failCount++;
        }
      }

      showToast(`Cancelled ${successCount} tasks${failCount > 0 ? `, failed: ${failCount}` : ''}`, successCount > 0 ? 'success' : 'error');
      selectedTasks.clear();
      updateBatchActionBar();
      await loadTasks();
    }
  });
}

async function batchDelete() {
  if (selectedTasks.size === 0) return;

  showConfirmDialog({
    title: 'Delete Selected Tasks',
    message: `Are you sure you want to DELETE ${selectedTasks.size} tasks? This action cannot be undone.`,
    confirmText: 'Delete All',
    danger: true,
    onConfirm: async () => {
      let successCount = 0;
      let failCount = 0;

      for (const taskId of selectedTasks) {
        try {
          await fetchAPI(`/api/tasks/${taskId}`, { method: 'DELETE' });
          successCount++;
        } catch {
          failCount++;
        }
      }

      showToast(`Deleted ${successCount} tasks${failCount > 0 ? `, failed: ${failCount}` : ''}`, successCount > 0 ? 'success' : 'error');
      selectedTasks.clear();
      updateBatchActionBar();
      await loadTasks();
    }
  });
}

function clearSelection() {
  selectedTasks.clear();
  updateBatchActionBar();
  renderTasks();
}

// Theme Toggle
function toggleTheme() {
  isDarkMode = !isDarkMode;
  document.body.classList.toggle('light-mode', !isDarkMode);

  const btn = document.getElementById('theme-toggle-btn');
  btn.textContent = isDarkMode ? '🌙' : '☀️';

  // Save preference
  localStorage.setItem('darkMode', isDarkMode);
}

function loadThemePreference() {
  const saved = localStorage.getItem('darkMode');
  if (saved !== null) {
    isDarkMode = saved === 'true';
    document.body.classList.toggle('light-mode', !isDarkMode);
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) btn.textContent = isDarkMode ? '🌙' : '☀️';
  }
}

// Settings Functions
function loadSettings() {
  const saved = localStorage.getItem('cc-daemon-settings');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      settings = { ...settings, ...parsed };
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }
}

async function saveSettings() {
  // Get values from form
  settings.refreshInterval = parseInt(document.getElementById('setting-refresh-interval').value) * 1000;
  settings.contextWarningThreshold = parseInt(document.getElementById('setting-context-warning').value);
  settings.contextDangerThreshold = parseInt(document.getElementById('setting-context-danger').value);
  settings.defaultMaxIterations = parseInt(document.getElementById('setting-max-iterations').value);
  settings.defaultThresholdPercent = parseInt(document.getElementById('setting-threshold').value);
  settings.defaultUseTmux = document.getElementById('setting-use-tmux').checked;
  settings.defaultRalphLoop = document.getElementById('setting-ralph-loop').checked;
  settings.notifications = document.getElementById('setting-notifications').checked;
  settings.autoTriggerEnabled = document.getElementById('setting-auto-trigger').checked;
  settings.autoTriggerInterval = parseInt(document.getElementById('setting-auto-trigger-interval').value) || 60;

  // Save to localStorage
  localStorage.setItem('cc-daemon-settings', JSON.stringify(settings));

  // Apply settings
  applySettings();

  // Update auto-trigger monitor via API
  try {
    const response = await fetch('/api/auto-trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: settings.autoTriggerEnabled,
        interval: settings.autoTriggerInterval
      })
    });
    const result = await response.json();
    if (!result.success) {
      console.error('Failed to update auto-trigger:', result);
    }
  } catch (error) {
    console.error('Failed to update auto-trigger:', error);
  }

  closeSettingsModal();
  showToast('Settings saved', 'success');
}

function resetSettings() {
  settings = {
    refreshInterval: 10000,
    contextWarningThreshold: 75,
    contextDangerThreshold: 90,
    defaultMaxIterations: 100,
    defaultThresholdPercent: 80,
    defaultUseTmux: true,
    defaultRalphLoop: false,
    notifications: true,
    autoTriggerEnabled: false,
    autoTriggerInterval: 60
  };
  populateSettingsForm();
  showToast('Settings reset to defaults', 'info');
}

function populateSettingsForm() {
  document.getElementById('setting-refresh-interval').value = settings.refreshInterval / 1000;
  document.getElementById('setting-context-warning').value = settings.contextWarningThreshold;
  document.getElementById('setting-context-danger').value = settings.contextDangerThreshold;
  document.getElementById('setting-max-iterations').value = settings.defaultMaxIterations;
  document.getElementById('setting-threshold').value = settings.defaultThresholdPercent;
  document.getElementById('setting-use-tmux').checked = settings.defaultUseTmux;
  document.getElementById('setting-ralph-loop').checked = settings.defaultRalphLoop;
  document.getElementById('setting-notifications').checked = settings.notifications;
  document.getElementById('setting-auto-trigger').checked = settings.autoTriggerEnabled;
  document.getElementById('setting-auto-trigger-interval').value = settings.autoTriggerInterval;
}

function applySettings() {
  // Update refresh interval
  startAutoRefresh();

  // Update create task form defaults
  const maxIterationsInput = document.getElementById('task-max-iterations');
  const thresholdInput = document.getElementById('task-threshold');
  const tmuxCheckbox = document.getElementById('task-tmux');
  const ralphLoopCheckbox = document.getElementById('task-ralph-loop');

  if (maxIterationsInput) maxIterationsInput.value = settings.defaultMaxIterations;
  if (thresholdInput) thresholdInput.value = settings.defaultThresholdPercent;
  if (tmuxCheckbox) tmuxCheckbox.checked = settings.defaultUseTmux;
  if (ralphLoopCheckbox) ralphLoopCheckbox.checked = settings.defaultRalphLoop;
}

function closeSettingsModal() {
  settingsModal?.classList.remove('active');
}

// Auto-Trigger Monitor Functions
async function loadAutoTriggerStatus() {
  try {
    const response = await fetch('/api/auto-trigger');
    const data = await response.json();
    settings.autoTriggerEnabled = data.enabled || false;
    // Update the form if it's open
    const checkbox = document.getElementById('setting-auto-trigger');
    if (checkbox) {
      checkbox.checked = settings.autoTriggerEnabled;
    }
  } catch (error) {
    console.error('Failed to load auto-trigger status:', error);
  }
}

// Starred Tasks Functions
function loadStarredTasks() {
  const saved = localStorage.getItem('cc-daemon-starred-tasks');
  if (saved) {
    try {
      starredTasks = new Set(JSON.parse(saved));
    } catch (e) {
      console.error('Failed to load starred tasks:', e);
    }
  }
}

function saveStarredTasks() {
  localStorage.setItem('cc-daemon-starred-tasks', JSON.stringify([...starredTasks]));
}

function toggleStarTask(taskId) {
  if (starredTasks.has(taskId)) {
    starredTasks.delete(taskId);
    showToast('Task unstarred', 'info');
  } else {
    starredTasks.add(taskId);
    showToast('Task starred', 'success');
  }
  saveStarredTasks();
  renderTasks();
}

function isTaskStarred(taskId) {
  return starredTasks.has(taskId);
}

// Task Templates Functions
function loadTaskTemplates() {
  const saved = localStorage.getItem('cc-daemon-task-templates');
  if (saved) {
    try {
      taskTemplates = JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load task templates:', e);
    }
  }
}

function saveTaskTemplates() {
  localStorage.setItem('cc-daemon-task-templates', JSON.stringify(taskTemplates));
}

function saveCurrentTaskAsTemplate() {
  const goal = document.getElementById('task-goal').value;
  const completionPromise = document.getElementById('task-completion-promise').value;
  const maxIterations = document.getElementById('task-max-iterations').value;
  const thresholdPercent = document.getElementById('task-threshold').value;
  const steps = document.getElementById('task-steps').value;
  const tmux = document.getElementById('task-tmux').checked;
  const ralphLoop = document.getElementById('task-ralph-loop').checked;

  if (!goal.trim()) {
    showToast('Please enter a goal first', 'warning');
    return;
  }

  const templateName = prompt('Enter template name:', 'My Template');
  if (!templateName) return;

  const template = {
    id: Date.now().toString(),
    name: templateName,
    goal: goal.trim(),
    completionPromise: completionPromise.trim() || undefined,
    maxIterations: parseInt(maxIterations) || 100,
    thresholdPercent: parseInt(thresholdPercent) || 80,
    steps: steps.trim() ? steps.split('\n').map(s => s.trim()).filter(s => s) : undefined,
    tmux,
    ralphLoop,
    createdAt: new Date().toISOString()
  };

  taskTemplates.push(template);
  saveTaskTemplates();
  updateTemplateDropdown();
  showToast(`Template "${templateName}" saved`, 'success');
}

function loadTemplate(templateId) {
  const template = taskTemplates.find(t => t.id === templateId);
  if (!template) return;

  document.getElementById('task-goal').value = template.goal || '';
  document.getElementById('task-completion-promise').value = template.completionPromise || '';
  document.getElementById('task-max-iterations').value = template.maxIterations || 100;
  document.getElementById('task-threshold').value = template.thresholdPercent || 80;
  document.getElementById('task-steps').value = template.steps ? template.steps.join('\n') : '';
  document.getElementById('task-tmux').checked = template.tmux !== false;
  document.getElementById('task-ralph-loop').checked = template.ralphLoop || false;

  showToast(`Template "${template.name}" loaded`, 'success');
}

function deleteTemplate(templateId) {
  const index = taskTemplates.findIndex(t => t.id === templateId);
  if (index !== -1) {
    const name = taskTemplates[index].name;
    taskTemplates.splice(index, 1);
    saveTaskTemplates();
    updateTemplateDropdown();
    showToast(`Template "${name}" deleted`, 'info');
  }
}

function updateTemplateDropdown() {
  const select = document.getElementById('template-select');
  if (!select) return;

  select.innerHTML = '<option value="">Select template...</option>' +
    taskTemplates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
}

// Browser Notifications
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showBrowserNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🤖</text></svg>' });
  }
}

// Export Functions
function exportData() {
  const format = document.getElementById('export-format').value;
  const scope = document.getElementById('export-scope').value;

  let dataToExport = [];

  if (scope === 'selected') {
    dataToExport = tasks.filter(t => selectedTasks.has(t.metadata.id));
  } else if (scope === 'filtered') {
    if (statusFilter === 'active') {
      dataToExport = tasks.filter(t => t.metadata.status === 'active' || t.metadata.status === 'pending');
    } else if (statusFilter !== 'all') {
      dataToExport = tasks.filter(t => t.metadata.status === statusFilter);
    } else {
      dataToExport = tasks;
    }
  } else {
    dataToExport = tasks;
  }

  if (dataToExport.length === 0) {
    showToast('No tasks to export', 'warning');
    return;
  }

  let content, filename, mimeType;

  if (format === 'json') {
    content = JSON.stringify(dataToExport, null, 2);
    filename = `tasks-export-${Date.now()}.json`;
    mimeType = 'application/json';
  } else {
    // CSV format
    const headers = ['ID', 'Status', 'Goal', 'Created', 'Sessions', 'Tokens', 'Cost'];
    const rows = dataToExport.map(t => [
      t.metadata.id,
      t.metadata.status,
      `"${t.plan.goal.replace(/"/g, '""')}"`,
      t.metadata.createdAt,
      t.metadata.totalSessions,
      t.metadata.totalTokens,
      t.metadata.totalCost.toFixed(4)
    ]);
    content = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    filename = `tasks-export-${Date.now()}.csv`;
    mimeType = 'text/csv';
  }

  // Download file
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  closeExportModal();
  showToast(`Exported ${dataToExport.length} tasks`, 'success');
}

// Render Functions
function renderTasks() {
  let filtered = tasks;

  // Filter by status
  if (statusFilter === 'active') {
    // Active only shows tasks that are actively running (not pending)
    filtered = filtered.filter(t => t.metadata.status === 'active');
  } else if (statusFilter !== 'all') {
    filtered = filtered.filter(t => t.metadata.status === statusFilter);
  }

  // Filter by tag
  if (tagFilter) {
    filtered = filtered.filter(t => {
      const tags = t.metadata?.tags || [];
      return tags.includes(tagFilter);
    });
  }

  // Filter by search query
  if (searchQuery) {
    filtered = filtered.filter(t => {
      const goal = (t.plan?.goal || '').toLowerCase();
      const id = (t.metadata?.id || '').toLowerCase();
      const projectPath = (t.metadata?.projectPath || '').toLowerCase();
      return goal.includes(searchQuery) || id.includes(searchQuery) || projectPath.includes(searchQuery);
    });
  }

  // Sort tasks
  filtered = sortTasks(filtered);

  if (filtered.length === 0) {
    tasksList.innerHTML = `<div class="empty-state">
      No ${statusFilter === 'active' ? 'active' : statusFilter} tasks found${searchQuery ? ' matching search' : ''}.
      <br><br>
      Click "+ Create Task" to create a new task.
    </div>`;
    return;
  }

  tasksList.innerHTML = filtered.map(task => {
    const completedSteps = task.plan.steps.filter(s => s.completed).length;
    const totalSteps = task.plan.steps.length;
    const progressPercent = totalSteps > 0 ? (completedSteps / totalSteps * 100) : 0;
    const isSelected = selectedTasks.has(task.metadata.id);
    const isStarred = starredTasks.has(task.metadata.id);
    const selectableClass = selectMode ? 'selectable' : '';
    const selectedClass = isSelected ? 'selected' : '';
    const starredClass = isStarred ? 'starred' : '';

    // Calculate runtime duration for active tasks
    let runtime = '';
    if (task.metadata.status === 'active' && task.metadata.updatedAt) {
      const duration = Date.now() - new Date(task.metadata.updatedAt).getTime();
      runtime = formatDuration(duration);
    }

    // Get last activity time
    const lastActivity = task.metadata.updatedAt ? formatAge(task.metadata.updatedAt) : 'N/A';

    // Get current step description
    const currentStep = task.plan.steps.find(s => !s.completed);
    const currentStepDesc = currentStep ? currentStep.description : null;

    // Get blocker/error preview
    const blocker = task.progress?.blockers?.length > 0 ? task.progress.blockers[task.progress.blockers.length - 1] : null;

    // Context warning class
    const contextWarning = task.contextPercent !== undefined && task.contextPercent >= settings.contextWarningThreshold;
    const contextDanger = task.contextPercent !== undefined && task.contextPercent >= settings.contextDangerThreshold;

    return `
      <div class="task-card ${selectableClass} ${selectedClass} ${starredClass}" data-task-id="${task.metadata.id}">
        <div class="task-header">
          <div class="task-header-left">
            <button class="star-btn ${isStarred ? 'starred' : ''}" onclick="event.stopPropagation(); toggleStarTask('${task.metadata.id}')" title="${isStarred ? 'Unstar' : 'Star'} task">
              ${isStarred ? '⭐' : '☆'}
            </button>
            <span class="task-id">${task.metadata.id}</span>
          </div>
          <span class="task-status status-${task.metadata.status}">${task.metadata.status}</span>
        </div>
        <div class="task-goal">${escapeHtml(task.plan.goal)}</div>
        ${task.metadata.tags && task.metadata.tags.length > 0 ? `
          <div class="task-tags">
            ${task.metadata.tags.map(tag => `<span class="task-tag" onclick="event.stopPropagation(); filterByTag('${escapeHtml(tag)}')">${escapeHtml(tag)}</span>`).join('')}
          </div>
        ` : ''}
        ${currentStepDesc && task.metadata.status === 'active' ? `
          <div class="task-current-step">
            <span class="task-meta-label">Current:</span>
            <span class="task-meta-value">${escapeHtml(truncate(currentStepDesc, 60))}</span>
          </div>
        ` : ''}
        ${blocker ? `
          <div class="task-blocker">
            <span class="blocker-icon">⚠️</span>
            <span class="blocker-text">${escapeHtml(truncate(blocker, 80))}</span>
          </div>
        ` : ''}
        ${task.metadata.dependsOn && task.metadata.dependsOn.length > 0 ? `
          <div class="task-dependencies">
            <span class="task-meta-label">Depends on:</span>
            ${task.metadata.dependsOn.map(depId => {
              const depTask = tasks.find(t => t.metadata.id === depId);
              const depStatus = depTask?.metadata?.status || 'unknown';
              const statusClass = depStatus === 'completed' ? 'dep-completed' : depStatus === 'failed' ? 'dep-failed' : 'dep-pending';
              return `<span class="task-dep ${statusClass}" title="${depStatus}">${depId.slice(0, 8)}</span>`;
            }).join('')}
          </div>
        ` : ''}
        <div class="task-meta">
          <div class="task-meta-item">
            <span class="task-meta-label">Created:</span>
            <span class="task-meta-value">${formatAge(task.metadata.createdAt)}</span>
          </div>
          ${runtime ? `
            <div class="task-meta-item">
              <span class="task-meta-label">Runtime:</span>
              <span class="task-meta-value runtime-active">${runtime}</span>
            </div>
          ` : ''}
          <div class="task-meta-item">
            <span class="task-meta-label">Last Activity:</span>
            <span class="task-meta-value">${lastActivity}</span>
          </div>
          <div class="task-meta-item">
            <span class="task-meta-label">Sessions:</span>
            <span class="task-meta-value">${task.metadata.totalSessions}</span>
          </div>
          <div class="task-meta-item">
            <span class="task-meta-label">Tokens:</span>
            <span class="task-meta-value">${formatNumber(task.metadata.totalTokens)}</span>
          </div>
          <div class="task-meta-item">
            <span class="task-meta-label">Cost:</span>
            <span class="task-meta-value">$${task.metadata.totalCost.toFixed(4)}</span>
          </div>
          <div class="task-meta-item">
            <span class="task-meta-label">Project:</span>
            <span class="task-meta-value" title="${escapeHtml(task.metadata.projectPath)}">${truncate(task.metadata.projectPath, 30)}</span>
          </div>
          ${task.tmuxSession ? `
            <div class="task-meta-item">
              <span class="task-meta-label">tmux:</span>
              <span class="task-meta-value">${task.tmuxSession}</span>
            </div>
          ` : ''}
          ${task.contextPercent !== undefined ? `
            <div class="task-meta-item">
              <span class="task-meta-label">Context:</span>
              <span class="task-meta-value ${contextDanger ? 'context-danger' : contextWarning ? 'context-warning' : ''}">${task.contextPercent.toFixed(1)}%</span>
            </div>
          ` : ''}
        </div>
        <div class="task-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progressPercent}%"></div>
          </div>
          <div class="progress-text">${completedSteps}/${totalSteps} steps completed</div>
        </div>
        <div class="task-actions">
          <button class="btn btn-small btn-secondary" onclick="event.stopPropagation(); copyToClipboard('${task.taskDir}')">📁 Path</button>
          ${task.tmuxAttachedCommand ? `
            <button class="btn btn-small btn-primary" onclick="event.stopPropagation(); copyToClipboard('${task.tmuxAttachedCommand}')">🔗 tmux</button>
          ` : ''}
          ${getTaskActionButtons(task)}
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  document.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', (e) => {
      const taskId = card.dataset.taskId;

      if (selectMode) {
        // In select mode, toggle selection
        if (!e.target.closest('.btn')) {
          toggleTaskSelection(taskId);
        }
      } else {
        // Normal mode, show detail
        const task = tasks.find(t => t.metadata.id === taskId);
        if (task) showTaskDetail(task);
      }
    });
  });
}

function getTaskActionButtons(task) {
  const status = task.metadata.status;
  const buttons = [];

  if (status === 'active' || status === 'pending' || status === 'paused') {
    buttons.push(`<button class="btn btn-small btn-danger" onclick="event.stopPropagation(); cancelTask('${task.metadata.id}')">Cancel</button>`);
  }

  if (status === 'paused' || status === 'failed' || status === 'cancelled') {
    buttons.push(`<button class="btn btn-small btn-success" onclick="event.stopPropagation(); resumeTask('${task.metadata.id}')">Resume</button>`);
  }

  if (status === 'completed') {
    buttons.push(`<button class="btn btn-small btn-warning" onclick="event.stopPropagation(); verifyTask('${task.metadata.id}')">Verify</button>`);
  }

  if (status === 'completed' || status === 'cancelled' || status === 'failed') {
    buttons.push(`<button class="btn btn-small btn-secondary" onclick="event.stopPropagation(); deleteTask('${task.metadata.id}')">Delete</button>`);
  }

  return buttons.join('');
}

// Sort tasks based on current sortBy value (starred tasks always first)
function sortTasks(taskList) {
  const sorted = [...taskList];

  // First, sort by starred status
  sorted.sort((a, b) => {
    const aStarred = starredTasks.has(a.metadata.id) ? 1 : 0;
    const bStarred = starredTasks.has(b.metadata.id) ? 1 : 0;
    return bStarred - aStarred;  // Starred first
  });

  // Then apply the selected sort within each group
  sorted.sort((a, b) => {
    // Keep starred order first
    const aStarred = starredTasks.has(a.metadata.id) ? 1 : 0;
    const bStarred = starredTasks.has(b.metadata.id) ? 1 : 0;
    if (aStarred !== bStarred) return bStarred - aStarred;

    // Then apply the selected sort
    switch (sortBy) {
      case 'created-desc':
        return new Date(b.metadata.createdAt) - new Date(a.metadata.createdAt);
      case 'created-asc':
        return new Date(a.metadata.createdAt) - new Date(b.metadata.createdAt);
      case 'updated-desc':
        return new Date(b.metadata.updatedAt) - new Date(a.metadata.updatedAt);
      case 'cost-desc':
        return (b.metadata.totalCost || 0) - (a.metadata.totalCost || 0);
      case 'tokens-desc':
        return (b.metadata.totalTokens || 0) - (a.metadata.totalTokens || 0);
      case 'status-asc':
        return a.metadata.status.localeCompare(b.metadata.status);
      default:
        return 0;
    }
  });

  return sorted;
}

// Dashboard functions
async function loadDashboard() {
  const dashboardContent = document.getElementById('dashboard-content');
  dashboardContent.innerHTML = '<div class="loading">Loading dashboard...</div>';

  try {
    const stats = await fetchAPI('/api/stats');
    renderDashboard(stats);
  } catch (error) {
    dashboardContent.innerHTML = `<div class="empty-state">Error loading dashboard: ${error.message}</div>`;
  }
}

function renderDashboard(stats) {
  const dashboardContent = document.getElementById('dashboard-content');

  dashboardContent.innerHTML = `
    <div class="dashboard-stats">
      <div class="stat-card stat-active">
        <div class="stat-number">${stats.active}</div>
        <div class="stat-label">Active</div>
      </div>
      <div class="stat-card stat-completed">
        <div class="stat-number">${stats.completed}</div>
        <div class="stat-label">Completed</div>
      </div>
      <div class="stat-card stat-failed">
        <div class="stat-number">${stats.failed}</div>
        <div class="stat-label">Failed</div>
      </div>
      <div class="stat-card stat-cancelled">
        <div class="stat-number">${stats.cancelled}</div>
        <div class="stat-label">Cancelled</div>
      </div>
    </div>

    <div class="dashboard-summary">
      <div class="summary-item">
        <span class="summary-label">Total Tasks:</span>
        <span class="summary-value">${stats.total}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Total Tokens:</span>
        <span class="summary-value">${formatNumber(stats.totalTokens)}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Total Cost:</span>
        <span class="summary-value">$${stats.totalCost.toFixed(4)}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Active Claude Sessions:</span>
        <span class="summary-value">${stats.activeClaudeSessions}</span>
      </div>
    </div>

    <div class="dashboard-actions">
      <button class="btn btn-primary" onclick="document.querySelector('[data-tab=tasks]').click()">📋 View All Tasks</button>
      <button class="btn btn-secondary" onclick="document.querySelector('[data-tab=sessions]').click()">🖥️ View Sessions</button>
    </div>
  `;
}

function renderTmuxSessions() {
  if (tmuxSessions.length === 0) {
    tmuxSessionsList.innerHTML = '<div class="empty-state">No active tmux sessions.<br>Start a task with <code>cc-daemon ralph --tmux</code></div>';
    return;
  }

  tmuxSessionsList.innerHTML = tmuxSessions.map(session => {
    // Show short session ID for matching (first 8 chars)
    const shortClaudeId = session.claudeSessionId ? session.claudeSessionId.slice(0, 8) : null;

    return `
    <div class="session-card">
      <div class="session-info">
        <div class="session-name">${session.name}</div>
        <div class="session-command">
          <code>${session.attachCommand}</code>
          <button class="copy-btn" onclick="copyToClipboard('${session.attachCommand}')" title="Copy">📋</button>
        </div>
        ${session.claudeSessionId ? `
          <div class="session-claude-binding" style="margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-secondary); border-radius: 4px; border-left: 3px solid var(--success-color);">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span style="color: var(--success-color); font-weight: 500;">🤖 Claude:</span>
              <code style="font-size: 0.85rem; color: var(--text-color);">${shortClaudeId}</code>
              <span style="color: var(--text-muted); font-size: 0.75rem;">(session id)</span>
            </div>
          </div>
        ` : `
          <div class="session-meta" style="margin-top: 0.5rem; color: var(--text-muted); font-style: italic;">
            No Claude session bound
          </div>
        `}
        ${session.claudePrompt ? `
          <div class="session-meta" style="margin-top: 0.25rem;">
            <span style="color: var(--text-muted);">Prompt: ${escapeHtml(session.claudePrompt)}</span>
          </div>
        ` : ''}
        ${session.contextPercent !== undefined ? `
          <div class="session-meta" style="margin-top: 0.25rem;">
            <span>Context: ${session.contextPercent.toFixed(1)}%</span>
          </div>
        ` : ''}
      </div>
      <div class="session-status">
        <span class="status-indicator ${session.exists ? 'active' : 'inactive'}"></span>
        <span>${session.exists ? 'Running' : 'Stopped'}</span>
      </div>
      <div class="session-actions" style="margin-top: 0.5rem; display: flex; gap: 0.5rem;">
        <button class="btn btn-small btn-secondary" onclick="viewSessionOutput('${session.name}')">👁️ View Output</button>
        <button class="btn btn-small btn-primary" onclick="attachToSession('${session.name}')">🖥️ Attach</button>
        ${session.exists ? `<button class="btn btn-small btn-danger" onclick="killTmuxSessionFromUI('${session.name}')">⛔ Kill</button>` : ''}
      </div>
    </div>
  `;
  }).join('');
}

function renderActiveSessions() {
  if (activeSessions.length === 0) {
    activeSessionsList.innerHTML = '<div class="empty-state">No active Claude sessions detected.</div>';
    return;
  }

  activeSessionsList.innerHTML = activeSessions.map(session => {
    // Show session ID (first 8 chars for easy matching with tmux)
    const shortSessionId = session.sessionId.slice(0, 8);

    return `
    <div class="session-card">
      <div class="session-info">
        <div class="session-header-row" style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
          <div class="session-name" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${session.firstPrompt ? escapeHtml(session.firstPrompt) : 'Claude Session'}
          </div>
          <div class="session-id-badge" style="font-family: monospace; font-size: 0.75rem; background: var(--bg-secondary); padding: 0.15rem 0.4rem; border-radius: 4px; color: var(--text-muted);">
            ${shortSessionId}
          </div>
        </div>
        <div class="session-meta" style="margin-top: 0.5rem;">
          <span>Modified: ${new Date(session.modifiedAt).toLocaleTimeString()}</span>
        </div>
        ${session.tmuxSessionName ? `
          <div class="session-tmux-binding" style="margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-secondary); border-radius: 4px; border-left: 3px solid var(--primary-color);">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
              <span style="color: var(--primary-color); font-weight: 500;">🔗 tmux:</span>
              <code style="font-size: 0.85rem; color: var(--text-color);">${session.tmuxSessionName}</code>
            </div>
            ${session.tmuxAttachCommand ? `
              <button class="btn btn-small btn-primary" onclick="copyToClipboard('${session.tmuxAttachCommand}')" title="Copy attach command">
                📋 Copy attach cmd
              </button>
            ` : ''}
          </div>
        ` : `
          <div class="session-meta" style="margin-top: 0.5rem; color: var(--text-muted); font-style: italic;">
            No tmux session bound
          </div>
        `}
      </div>
      <div class="session-status">
        <span class="status-indicator active"></span>
        <span>${session.contextPercent.toFixed(1)}%</span>
      </div>
    </div>
  `;
  }).join('');
}

function renderWorkSessions() {
  const workSessions = activeSessions.filter(s => s.isCcDaemonWorkSession);

  if (workSessions.length === 0) {
    workSessionsList.innerHTML = '<div class="empty-state">No cc-daemon work sessions detected.</div>';
    return;
  }

  workSessionsList.innerHTML = workSessions.map(session => {
    const shortSessionId = session.sessionId.slice(0, 8);
    const shortTaskId = session.taskId ? session.taskId.slice(0, 8) : '';

    return `
    <div class="session-card">
      <div class="session-info">
        <div class="session-header-row" style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
          <div class="session-name" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${session.taskGoal ? escapeHtml(session.taskGoal.slice(0, 80)) : (session.firstPrompt ? escapeHtml(session.firstPrompt) : 'Work Session')}
          </div>
          <div class="session-id-badge" style="font-family: monospace; font-size: 0.75rem; background: var(--primary-color); color: white; padding: 0.15rem 0.4rem; border-radius: 4px;">
            ${shortSessionId}
          </div>
        </div>
        <div class="session-meta" style="margin-top: 0.5rem;">
          <span>Task: ${shortTaskId}</span>
          <span style="margin-left: 1rem;">Modified: ${new Date(session.modifiedAt).toLocaleTimeString()}</span>
        </div>
        ${session.tmuxSessionName ? `
          <div class="session-tmux-binding" style="margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-secondary); border-radius: 4px; border-left: 3px solid var(--primary-color);">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
              <span style="color: var(--primary-color); font-weight: 500;">🔗 tmux:</span>
              <code style="font-size: 0.85rem; color: var(--text-color);">${session.tmuxSessionName}</code>
            </div>
            ${session.tmuxAttachCommand ? `
              <button class="btn btn-small btn-primary" onclick="copyToClipboard('${session.tmuxAttachCommand}')" title="Copy attach command">
                📋 Copy attach cmd
              </button>
            ` : ''}
          </div>
        ` : ''}
      </div>
      <div class="session-status">
        <span class="status-indicator active"></span>
        <span>${session.contextPercent.toFixed(1)}%</span>
      </div>
    </div>
  `;
  }).join('');
}

function renderOtherSessions() {
  const otherSessions = activeSessions.filter(s => !s.isCcDaemonWorkSession);

  if (otherSessions.length === 0) {
    otherSessionsList.innerHTML = '<div class="empty-state">No other sessions detected.</div>';
    return;
  }

  otherSessionsList.innerHTML = otherSessions.map(session => {
    const shortSessionId = session.sessionId.slice(0, 8);

    return `
    <div class="session-card" style="opacity: 0.9;">
      <div class="session-info">
        <div class="session-header-row" style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
          <div class="session-name" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${session.firstPrompt ? escapeHtml(session.firstPrompt) : 'Other Session'}
          </div>
          <div class="session-id-badge" style="font-family: monospace; font-size: 0.75rem; background: var(--bg-secondary); padding: 0.15rem 0.4rem; border-radius: 4px; color: var(--text-muted);">
            ${shortSessionId}
          </div>
        </div>
        <div class="session-meta" style="margin-top: 0.5rem;">
          <span>Modified: ${new Date(session.modifiedAt).toLocaleTimeString()}</span>
        </div>
        ${session.tmuxSessionName ? `
          <div class="session-tmux-binding" style="margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-secondary); border-radius: 4px; border-left: 3px solid var(--text-muted);">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
              <span style="color: var(--text-muted); font-weight: 500;">🔗 tmux:</span>
              <code style="font-size: 0.85rem; color: var(--text-color);">${session.tmuxSessionName}</code>
            </div>
            ${session.tmuxAttachCommand ? `
              <button class="btn btn-small btn-secondary" onclick="copyToClipboard('${session.tmuxAttachCommand}')" title="Copy attach command">
                📋 Copy attach cmd
              </button>
            ` : ''}
          </div>
        ` : ''}
      </div>
      <div class="session-status">
        <span class="status-indicator ${session.contextPercent >= 90 ? 'danger' : 'active'}"></span>
        <span>${session.contextPercent.toFixed(1)}%</span>
      </div>
    </div>
  `;
  }).join('');
}

function renderContext() {
  if (activeSessions.length === 0) {
    contextDisplay.innerHTML = '<div class="empty-state">No active Claude sessions found.<br><br>Start a Claude Code session first.</div>';
    return;
  }

  // Separate work sessions from other sessions
  const workSessions = activeSessions.filter(s => s.isCcDaemonWorkSession);
  const otherSessions = activeSessions.filter(s => !s.isCcDaemonWorkSession);

  // Check for context warnings
  const warningSessions = activeSessions.filter(s => s.contextPercent >= settings.contextWarningThreshold);
  let warningBanner = '';

  if (warningSessions.length > 0) {
    const hasDanger = warningSessions.some(s => s.contextPercent >= settings.contextDangerThreshold);
    const bannerClass = hasDanger ? 'danger' : 'warning';
    const icon = hasDanger ? '🚨' : '⚠️';
    const title = hasDanger ? 'Context Critical' : 'Context Warning';
    const message = hasDanger
      ? `${warningSessions.length} session(s) at critical context level (>=${settings.contextDangerThreshold}%). Rotation will occur soon.`
      : `${warningSessions.length} session(s) approaching context limit (>=${settings.contextWarningThreshold}%).`;

    warningBanner = `
      <div class="context-warning-banner ${bannerClass}">
        <span class="warning-icon">${icon}</span>
        <div class="warning-text">
          <h4>${title}</h4>
          <p>${message}</p>
        </div>
      </div>
    `;
  }

  const renderSessionCard = (session) => {
    const percent = session.contextPercent;
    const status = percent >= settings.contextDangerThreshold ? 'danger' : percent >= settings.contextWarningThreshold ? 'warning' : 'safe';
    const usedK = formatNumber(session.contextUsed || (session.tokens.inputTokens + session.tokens.cacheReadInputTokens));
    const limitK = formatNumber(session.contextLimit || 200000);

    // Use firstPrompt as title, fallback to truncated sessionId
    const sessionTitle = session.firstPrompt ? escapeHtml(session.firstPrompt) : session.sessionId.slice(0, 16) + '...';
    const hasFullPrompt = !!session.fullPrompt;
    const pid = session.sessionId.replace(/-/g, '_');
    const fullEscaped = session.fullPrompt ? escapeHtml(session.fullPrompt) : '';

    return `
      <div class="context-card">
        <div class="context-header">
          ${hasFullPrompt ? `
            <div class="context-session-id prompt-expandable"
                 onclick="togglePrompt('${pid}')"
                 title="Click to expand full prompt"
                 data-short="${sessionTitle}"
                 data-full="${fullEscaped}">
              <span id="prompt-text-${pid}">${sessionTitle}</span>
              <span class="prompt-expand-hint" id="prompt-hint-${pid}">···</span>
            </div>
          ` : `
            <div class="context-session-id">${sessionTitle}</div>
          `}
          <div class="context-percent ${status}">${percent.toFixed(1)}% (${usedK}/${limitK})</div>
        </div>
        <div class="context-bar">
          <div class="context-bar-fill ${status}" style="width: ${Math.min(percent, 100)}%"></div>
        </div>
        <div class="context-stats">
          <div class="stat-item">
            <div class="stat-label">Input Tokens</div>
            <div class="stat-value">${formatNumber(session.tokens.inputTokens)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Output Tokens</div>
            <div class="stat-value">${formatNumber(session.tokens.outputTokens)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Cache Read</div>
            <div class="stat-value">${formatNumber(session.tokens.cacheReadInputTokens)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Cache Created</div>
            <div class="stat-value">${formatNumber(session.tokens.cacheCreationInputTokens)}</div>
          </div>
        </div>
        ${session.workingDir ? `
          <div class="detail-item" style="margin-top: 1rem;">
            <div class="detail-label">Working Directory</div>
            <div class="detail-value" style="font-family: monospace; font-size: 0.85rem;">${escapeHtml(session.workingDir)}</div>
          </div>
        ` : ''}
        ${session.tmuxSessionName ? `
          <div class="detail-item" style="margin-top: 0.5rem;">
            <div class="detail-label">Tmux Session</div>
            <div class="session-command">
              <code>${session.tmuxSessionName}</code>
              <button class="copy-btn" onclick="copyToClipboard('${session.tmuxAttachCommand}')" title="Copy attach command">📋</button>
            </div>
          </div>
        ` : ''}
        ${session.taskId ? `
          <div class="detail-item" style="margin-top: 0.5rem;">
            <div class="detail-label">Task</div>
            <div class="detail-value" style="font-family: monospace; font-size: 0.85rem;">${session.taskId.slice(0, 8)}</div>
          </div>
        ` : ''}
        <details style="margin-top: 0.5rem;">
          <summary style="cursor: pointer; color: var(--text-muted); font-size: 0.85rem;">Technical Details</summary>
          <div class="detail-item" style="margin-top: 0.5rem;">
            <div class="detail-label">Session ID</div>
            <div class="detail-value" style="font-family: monospace; font-size: 0.85rem;">${session.sessionId}</div>
          </div>
          <div class="detail-item" style="margin-top: 0.5rem;">
            <div class="detail-label">JSONL Path</div>
            <div class="detail-value" style="font-family: monospace; font-size: 0.85rem; word-break: break-all;">${session.jsonlPath}</div>
          </div>
        </details>
      </div>
    `;
  };

  let html = warningBanner;

  // Render Work Sessions section
  html += `
    <div class="context-section">
      <h3 class="context-section-title">🤖 CC-Daemon Work Sessions</h3>
      <p class="context-section-subtitle">Sessions created by cc-daemon for task execution</p>
  `;
  if (workSessions.length === 0) {
    html += `<div class="empty-state">No cc-daemon work sessions.</div>`;
  } else {
    html += workSessions.map(renderSessionCard).join('');
  }
  html += `</div>`;

  // Render Other Sessions section
  html += `
    <div class="context-section" style="margin-top: 2rem;">
      <h3 class="context-section-title">👤 Other Sessions</h3>
      <p class="context-section-subtitle">User-created sessions, fix sessions, and verification sessions</p>
  `;
  if (otherSessions.length === 0) {
    html += `<div class="empty-state">No other sessions.</div>`;
  } else {
    html += otherSessions.map(renderSessionCard).join('');
  }
  html += `</div>`;

  contextDisplay.innerHTML = html;
}

function togglePrompt(pid) {
  const textEl = document.getElementById('prompt-text-' + pid);
  const hintEl = document.getElementById('prompt-hint-' + pid);
  if (!textEl) return;
  const container = textEl.closest('.prompt-expandable');
  const isExpanded = container.dataset.expanded === 'true';
  textEl.textContent = isExpanded ? container.dataset.short : container.dataset.full;
  hintEl.textContent = isExpanded ? '···' : '▲';
  container.dataset.expanded = isExpanded ? 'false' : 'true';
  container.title = isExpanded ? 'Click to expand full prompt' : 'Click to collapse';
}

function renderDetailContent(task) {
  if (currentDetailTab === 'logs') {
    renderLogsTab(task);
  } else {
    renderOverviewTab(task);
  }
}

function renderOverviewTab(task) {
  const completedSteps = task.plan.steps.filter(s => s.completed).length;
  const totalSteps = task.plan.steps.length;
  const status = task.metadata.status;

  modalBody.innerHTML = `
    <div class="detail-section">
      <h4>📊 Overview</h4>
      <div class="detail-grid">
        <div class="detail-item">
          <div class="detail-label">Status</div>
          <div class="detail-value"><span class="task-status status-${status}">${status}</span></div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Created</div>
          <div class="detail-value">${new Date(task.metadata.createdAt).toLocaleString()}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Updated</div>
          <div class="detail-value">${new Date(task.metadata.updatedAt).toLocaleString()}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Progress</div>
          <div class="detail-value">${completedSteps}/${totalSteps} steps</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Total Sessions</div>
          <div class="detail-value">${task.metadata.totalSessions}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Total Tokens</div>
          <div class="detail-value">${formatNumber(task.metadata.totalTokens)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Total Cost</div>
          <div class="detail-value">$${task.metadata.totalCost.toFixed(4)}</div>
        </div>
        ${task.metadata.completionPromise ? `
          <div class="detail-item">
            <div class="detail-label">Completion Promise</div>
            <div class="detail-value">${escapeHtml(task.metadata.completionPromise)}</div>
          </div>
        ` : ''}
        ${task.metadata.maxIterations ? `
          <div class="detail-item">
            <div class="detail-label">Max Iterations</div>
            <div class="detail-value">${task.metadata.maxIterations}</div>
          </div>
        ` : ''}
      </div>
    </div>

    <div class="detail-section">
      <h4>🎯 Goal</h4>
      <div class="code-block">${escapeHtml(task.plan.goal)}</div>
    </div>

    <div class="detail-section">
      <h4>📁 Task Directory</h4>
      <div class="session-command">
        <code>${task.taskDir}</code>
        <button class="copy-btn" onclick="copyToClipboard('${task.taskDir}')" title="Copy">📋</button>
      </div>
      ${task.tmuxAttachedCommand ? `
        <div class="session-command" style="margin-top: 0.5rem;">
          <code>${task.tmuxAttachedCommand}</code>
          <button class="copy-btn" onclick="copyToClipboard('${task.tmuxAttachedCommand}')" title="Copy">📋</button>
        </div>
      ` : ''}
    </div>

    <div class="detail-section">
      <h4>✅ Steps</h4>
      <ul class="steps-list">
        ${task.plan.steps.map(step => `
          <li class="step-item">
            <div class="step-checkbox ${step.completed ? 'completed' : ''}"></div>
            <div class="step-content">
              <div class="step-id">${step.id}</div>
              <div class="step-description ${step.completed ? 'completed' : ''}">${escapeHtml(step.description)}</div>
              ${step.completedAt ? `<div style="font-size: 0.75rem; color: var(--text-muted);">Completed: ${new Date(step.completedAt).toLocaleString()}</div>` : ''}
            </div>
          </li>
        `).join('')}
      </ul>
    </div>

    ${task.plan.acceptanceCriteria && task.plan.acceptanceCriteria.length > 0 ? `
      <div class="detail-section">
        <h4>📋 Acceptance Criteria</h4>
        <ul class="steps-list">
          ${task.plan.acceptanceCriteria.map(criterion => `
            <li class="step-item">
              <div class="step-checkbox"></div>
              <div class="step-content">${escapeHtml(criterion)}</div>
            </li>
          `).join('')}
        </ul>
      </div>
    ` : ''}

    ${task.progress.completedSteps && task.progress.completedSteps.length > 0 ? `
      <div class="detail-section">
        <h4>🏁 Completed Steps</h4>
        <div class="code-block">${task.progress.completedSteps.map(s =>
          `${s.stepId} at ${s.completedAt}${s.notes ? ` - ${s.notes}` : ''}`
        ).join('\n')}</div>
      </div>
    ` : ''}

    ${task.progress.sessionHistory && task.progress.sessionHistory.length > 0 ? `
      <div class="detail-section">
        <h4>📜 Session History</h4>
        <div class="code-block">Session ID   | Started              | Duration  | Steps | Input  | Output | Cost
${task.progress.sessionHistory.map(s =>
          `${s.sessionId.slice(0, 8)} | ${s.startedAt} | ${(s.duration || 0) + 'ms'} | ${s.stepsCompleted} | ${s.inputTokens} | ${s.outputTokens} | $${s.cost.toFixed(4)}`
        ).join('\n')}</div>
      </div>
    ` : ''}

    ${task.progress.keyDecisions && task.progress.keyDecisions.length > 0 ? `
      <div class="detail-section">
        <h4>💡 Key Decisions</h4>
        <ul class="steps-list">
          ${task.progress.keyDecisions.map(decision => `
            <li class="step-item">
              <div class="step-content">${escapeHtml(decision)}</div>
            </li>
          `).join('')}
        </ul>
      </div>
    ` : ''}

    ${task.progress.blockers && task.progress.blockers.length > 0 ? `
      <div class="detail-section">
        <h4>⚠️ Blockers</h4>
        <ul class="steps-list">
          ${task.progress.blockers.map(blocker => `
            <li class="step-item" style="border-left: 3px solid var(--danger-color); padding-left: 1rem;">
              <div class="step-content">${escapeHtml(blocker)}</div>
            </li>
          `).join('')}
        </ul>
      </div>
    ` : ''}
  `;

  // Render action buttons in footer
  modalFooter.innerHTML = getTaskActionButtons(task);
}

function renderLogsTab(task) {
  // For now, show session history as logs since we don't have real-time logs yet
  const logs = task.progress.sessionHistory || [];

  if (logs.length === 0) {
    modalBody.innerHTML = `
      <div class="log-viewer">
        <div class="log-empty">
          No logs available yet.<br>
          Logs will appear here when the task starts running.
        </div>
      </div>
    `;
  } else {
    modalBody.innerHTML = `
      <div class="log-viewer">
        ${logs.map(log => `
          <div class="log-entry">
            <span class="log-time">${log.startedAt}</span>
            <span class="log-level info">SESSION</span>
            <span class="log-message">Session ${log.sessionId.slice(0, 8)}: ${log.stepsCompleted} steps, ${formatNumber(log.inputTokens)} in / ${formatNumber(log.outputTokens)} out tokens, $${log.cost.toFixed(4)}</span>
          </div>
        `).join('')}
        ${task.progress.blockers && task.progress.blockers.length > 0 ? task.progress.blockers.map(blocker => `
          <div class="log-entry">
            <span class="log-time">${new Date().toISOString()}</span>
            <span class="log-level error">BLOCKER</span>
            <span class="log-message">${escapeHtml(blocker)}</span>
          </div>
        `).join('') : ''}
      </div>
    `;
  }

  // Export button in footer
  modalFooter.innerHTML = `
    <button class="btn btn-secondary" onclick="exportTaskLogs('${task.metadata.id}')">📤 Export Logs</button>
    ${getTaskActionButtons(task)}
  `;
}

function exportTaskLogs(taskId) {
  const task = tasks.find(t => t.metadata.id === taskId);
  if (!task) return;

  const logs = {
    taskId: task.metadata.id,
    exportedAt: new Date().toISOString(),
    sessionHistory: task.progress.sessionHistory || [],
    blockers: task.progress.blockers || [],
    keyDecisions: task.progress.keyDecisions || []
  };

  const content = JSON.stringify(logs, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `task-${taskId}-logs.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast('Logs exported', 'success');
}

function showTaskDetail(task) {
  modalTitle.textContent = `Task: ${task.metadata.id}`;
  currentDetailTask = task;
  currentDetailTab = 'overview';

  // Reset tab state
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.detail-tab[data-detail-tab="overview"]')?.classList.add('active');

  renderDetailContent(task);
  taskModal.classList.add('active');
}

function closeTaskModal() {
  taskModal.classList.remove('active');
  currentDetailTask = null;
}

function closeCreateTaskModal() {
  createTaskModal.classList.remove('active');
}

function closeConfirmModal() {
  confirmModal.classList.remove('active');
}

function closeHelpModal() {
  helpModal.classList.remove('active');
}

function closeExportModal() {
  exportModal.classList.remove('active');
}

// Session Output Modal
const sessionOutputModal = document.getElementById('session-output-modal');
const sessionOutputTitle = document.getElementById('session-output-title');
const sessionOutputContent = document.getElementById('session-output-content');
const sessionInputDiv = document.getElementById('session-input-div');
const sessionInput = document.getElementById('session-input');
const sessionSendBtn = document.getElementById('session-send-btn');

sessionOutputModal?.addEventListener('click', (e) => {
  if (e.target === sessionOutputModal) closeSessionOutputModal();
});

// Track user scrolling - only auto-scroll if at bottom
if (sessionOutputContent) {
  sessionOutputContent.addEventListener('scroll', () => {
    const isAtBottom = sessionOutputContent.scrollHeight - sessionOutputContent.scrollTop <= sessionOutputContent.clientHeight + 50;

    // If user is NOT at bottom, they're manually scrolling - keep flag true until they scroll to bottom
    if (!isAtBottom) {
      userIsScrolling = true;
    } else {
      userIsScrolling = false;
    }
  });
}

// Send command to tmux session
if (sessionSendBtn) {
  sessionSendBtn.addEventListener('click', sendSessionCommand);
}

if (sessionInput) {
  sessionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendSessionCommand();
    }
  });
}

async function sendSessionCommand() {
  if (!sessionInput || !currentSessionOutput) return;

  const command = sessionInput.value.trim();
  if (!command) return;

  sessionSendBtn.disabled = true;
  sessionSendBtn.textContent = 'Sending...';

  try {
    await fetchAPI(`/api/sessions/tmux/${encodeURIComponent(currentSessionOutput)}/send`, {
      method: 'POST',
      body: JSON.stringify({ command })
    });
    sessionInput.value = '';
    showToast('Command sent', 'success');
  } catch (error) {
    showToast(`Failed to send command: ${error.message}`, 'error');
  } finally {
    sessionSendBtn.disabled = false;
    sessionSendBtn.textContent = 'Send';
  }
}

async function viewSessionOutput(sessionName) {
  currentSessionOutput = sessionName;
  sessionOutputTitle.textContent = `Session Output: ${sessionName}`;
  sessionOutputContent.textContent = 'Loading...';
  sessionOutputModal.classList.add('active');

  // Subscribe to real-time output via WebSocket if connected
  if (isWebSocketConnected()) {
    webSocket.send(JSON.stringify({
      type: 'subscribeSession',
      sessionName: sessionName
    }));
  }

  // Also fetch initial content via HTTP
  await refreshSessionOutput();
}

async function refreshSessionOutput() {
  if (!currentSessionOutput) return;

  try {
    // Save scroll state BEFORE any content changes
    const oldScrollHeight = sessionOutputContent.scrollHeight;
    const oldScrollTop = sessionOutputContent.scrollTop;
    const wasAtBottom = oldScrollHeight - oldScrollTop <= sessionOutputContent.clientHeight + 50;
    
    const result = await fetchAPI(`/api/sessions/tmux/${encodeURIComponent(currentSessionOutput)}/output`);

    // Update content (this will reset scroll position)
    sessionOutputContent.textContent = result.content || '(empty)';

    // ALWAYS restore scroll position
    if (wasAtBottom && !userIsScrolling) {
      // User was at bottom and not scrolling - show new content
      sessionOutputContent.scrollTop = sessionOutputContent.scrollHeight;
    } else if (!wasAtBottom || userIsScrolling) {
      // User was not at bottom OR is actively scrolling - preserve their position
      const newScrollHeight = sessionOutputContent.scrollHeight;
      const scrollRatio = oldScrollTop / oldScrollHeight;
      sessionOutputContent.scrollTop = Math.min(
        Math.floor(scrollRatio * newScrollHeight),
        newScrollHeight - sessionOutputContent.clientHeight
      );
    }
  } catch (error) {
    sessionOutputContent.textContent = `Error: ${error.message}`;
  }
}

function closeSessionOutputModal() {
  // Unsubscribe from real-time output via WebSocket
  if (currentSessionOutput && isWebSocketConnected()) {
    webSocket.send(JSON.stringify({
      type: 'unsubscribeSession',
      sessionName: currentSessionOutput
    }));
  }

  sessionOutputModal?.classList.remove('active');
  currentSessionOutput = null;
}

// Attach to tmux session
async function attachToSession(sessionName) {
  try {
    const result = await fetchAPI(`/api/sessions/tmux/${encodeURIComponent(sessionName)}/attach`, {
      method: 'POST'
    });

    if (result.openedTerminal) {
      showToast('Terminal window opened', 'success');
    } else {
      // Copy command to clipboard and show message
      copyToClipboard(result.attachCommand);
      showToast('Command copied! Run it in a terminal to attach.', 'info');
    }
  } catch (error) {
    showToast(`Failed to attach: ${error.message}`, 'error');
  }
}

async function killTmuxSessionFromUI(sessionName) {
  showConfirmDialog({
    title: 'Kill Session',
    message: `Kill tmux session "${sessionName}"? This will terminate the process immediately.`,
    confirmText: 'Kill',
    danger: true,
    onConfirm: async () => {
      try {
        await fetchAPI(`/api/sessions/tmux/${encodeURIComponent(sessionName)}/kill`, { method: 'POST' });
        showToast(`Session "${sessionName}" killed`, 'success');
        await loadSessions();
      } catch (error) {
        showToast(`Failed to kill session: ${error.message}`, 'error');
      }
    }
  });
}

// Confirm Dialog
let confirmCallback = null;

function showConfirmDialog({ title, message, showInput = false, inputLabel = '', confirmText = 'Confirm', danger = false, onConfirm }) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmInputContainer.style.display = showInput ? 'block' : 'none';
  confirmInputLabel.textContent = inputLabel;
  confirmInput.value = '';
  confirmOkBtn.textContent = confirmText;
  confirmOkBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
  confirmCallback = onConfirm;
  confirmModal.classList.add('active');
  if (showInput) {
    confirmInput.focus();
  }
}

confirmOkBtn.addEventListener('click', () => {
  const value = confirmInput.value;
  closeConfirmModal();
  if (confirmCallback) {
    confirmCallback(value);
    confirmCallback = null;
  }
});

confirmCancelBtn.addEventListener('click', () => {
  closeConfirmModal();
  confirmCallback = null;
});

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// Utility Functions
function formatAge(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'just now';
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// Check if a click event is actually a drag action (mouse moved significantly between mousedown and mouseup)
function isDragAction(e) {
  if (!modalMouseDownPos) return false;
  const dx = e.clientX - modalMouseDownPos.x;
  const dy = e.clientY - modalMouseDownPos.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  // Reset for next click
  modalMouseDownPos = null;
  return distance > DRAG_THRESHOLD;
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return '...' + str.slice(-maxLen + 3);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  // Also escape quotes for use in HTML attributes
  return div.innerHTML.replace(/"/g, '&quot;');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

// Refresh functions
async function refreshAll() {
  updateLastUpdate();
  await Promise.all([loadTasks(), loadSessions(), loadContext()]);
}

function updateLastUpdate() {
  lastUpdateEl.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
}

// Auto-refresh (using settings.refreshInterval when tab is visible)
// Initialize WebSocket connection for real-time updates
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    webSocket = new WebSocket(wsUrl);

    webSocket.onopen = () => {
      console.log('WebSocket connected');
      wsReconnectAttempts = 0;
      showToast('Real-time updates connected', 'success');
    };

    webSocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    webSocket.onclose = (event) => {
      console.log('WebSocket disconnected:', event.code, event.reason);
      webSocket = null;

      // Attempt to reconnect
      if (wsReconnectAttempts < WS_MAX_RECONNECT_ATTEMPTS) {
        wsReconnectAttempts++;
        console.log(`WebSocket reconnecting in ${WS_RECONNECT_DELAY}ms (attempt ${wsReconnectAttempts}/${WS_MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(initWebSocket, WS_RECONNECT_DELAY);
      } else {
        console.warn('WebSocket max reconnection attempts reached');
        showToast('Real-time updates disconnected. Refresh manually.', 'warning');
      }
    };

    webSocket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  } catch (error) {
    console.error('Failed to create WebSocket:', error);
  }
}

// Handle incoming WebSocket messages
function handleWebSocketMessage(message) {
  const { type, data, timestamp } = message;

  switch (type) {
    case 'stats':
      // Update dashboard stats in real-time
      updateDashboardStats(data);
      break;

    case 'taskCreated':
      // New task created
      if (!tasks.find(t => t.id === data.id)) {
        tasks.unshift(data);
        renderTasks();
        showToast(`New task created: ${data.id.slice(0, 8)}`, 'info');
      }
      break;

    case 'taskUpdated':
      // Task status or data updated
      const updateIndex = tasks.findIndex(t => t.id === data.id);
      if (updateIndex !== -1) {
        tasks[updateIndex] = { ...tasks[updateIndex], ...data };
        renderTasks();
        // Update detail modal if open for this task
        if (currentDetailTask && currentDetailTask.id === data.id) {
          currentDetailTask = tasks[updateIndex];
          if (currentDetailTab === 'overview') {
            renderTaskOverview(currentDetailTask);
          }
        }
      }
      break;

    case 'taskDeleted':
      // Task deleted
      tasks = tasks.filter(t => t.id !== data.id);
      selectedTasks.delete(data.id);
      starredTasks.delete(data.id);
      renderTasks();
      break;

    case 'sessionsUpdated':
      // Sessions list updated
      tmuxSessions = data.tmux || [];
      activeSessions = data.claude || [];
      renderTmuxSessions();
      renderActiveSessions();
      break;

    case 'contextUpdated':
      // Context data updated
      if (typeof renderContext === 'function') {
        // Fetch fresh context data
        fetch('/api/context')
          .then(res => res.json())
          .then(data => renderContextDisplay(data))
          .catch(err => console.error('Failed to refresh context:', err));
      }
      break;

    case 'sessionOutput':
      // Real-time session output streaming
      if (data.sessionName === currentSessionOutput) {
        // Save scroll state BEFORE any content changes
        const oldScrollHeight = sessionOutputContent.scrollHeight;
        const oldScrollTop = sessionOutputContent.scrollTop;
        const wasAtBottom = oldScrollHeight - oldScrollTop <= sessionOutputContent.clientHeight + 50;
        
        // Update content (this will reset scroll position)
        sessionOutputContent.textContent = data.content || '(empty)';

        // ALWAYS restore scroll position
        if (wasAtBottom && !userIsScrolling) {
          // User was at bottom and not scrolling - show new content
          sessionOutputContent.scrollTop = sessionOutputContent.scrollHeight;
        } else if (!wasAtBottom || userIsScrolling) {
          // User was not at bottom OR is actively scrolling - preserve their position
          const newScrollHeight = sessionOutputContent.scrollHeight;
          const scrollRatio = oldScrollTop / oldScrollHeight;
          sessionOutputContent.scrollTop = Math.min(
            Math.floor(scrollRatio * newScrollHeight),
            newScrollHeight - sessionOutputContent.clientHeight
          );
        }
      }
      break;

    default:
      console.log('Unknown WebSocket message type:', type);
  }
}

// Update dashboard stats without full page reload
function updateDashboardStats(stats) {
  const dashboardContent = document.getElementById('dashboard-content');
  if (!dashboardContent) return;

  // Update stat cards if they exist (using .stat-number class)
  const statNumbers = dashboardContent.querySelectorAll('.stat-number');
  if (statNumbers.length >= 4) {
    statNumbers[0].textContent = stats.active || 0;
    statNumbers[1].textContent = stats.completed || 0;
    statNumbers[2].textContent = stats.failed || 0;
    statNumbers[3].textContent = stats.cancelled || 0;
  }

  // Update summary values
  const summaryValues = dashboardContent.querySelectorAll('.summary-value');
  if (summaryValues.length >= 3) {
    summaryValues[0].textContent = stats.total || 0;
    summaryValues[1].textContent = formatNumber(stats.totalTokens || 0);
    summaryValues[2].textContent = `$${(stats.totalCost || 0).toFixed(2)}`;
  }
}

// Check if WebSocket is connected
function isWebSocketConnected() {
  return webSocket && webSocket.readyState === WebSocket.OPEN;
}

function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);

  refreshInterval = setInterval(() => {
    if (document.visibilityState === 'visible') {
      // Only refresh if WebSocket is not connected
      if (!isWebSocketConnected()) {
        refreshAll();
      }
    }
  }, settings.refreshInterval);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Reconnect WebSocket if disconnected
      if (!isWebSocketConnected() && wsReconnectAttempts < WS_MAX_RECONNECT_ATTEMPTS) {
        initWebSocket();
      }
      // Always refresh when tab becomes visible
      refreshAll();
    }
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadThemePreference();
  loadSettings();
  loadStarredTasks();
  loadTaskTemplates();
  loadAutoTriggerStatus();  // Load auto-trigger status from API
  requestNotificationPermission();
  applySettings();
  updateTemplateDropdown();
  refreshAll();
  startAutoRefresh();
  initWebSocket();  // Initialize WebSocket for real-time updates
});

// Export functions for onclick handlers
window.copyToClipboard = copyToClipboard;
window.cancelTask = cancelTask;
window.resumeTask = resumeTask;
window.verifyTask = verifyTask;
window.deleteTask = deleteTask;
window.closeCreateTaskModal = closeCreateTaskModal;
window.closeHelpModal = closeHelpModal;
window.closeExportModal = closeExportModal;
window.closeSettingsModal = closeSettingsModal;
window.saveSettings = saveSettings;
window.resetSettings = resetSettings;
window.closeSessionOutputModal = closeSessionOutputModal;
window.refreshSessionOutput = refreshSessionOutput;
window.viewSessionOutput = viewSessionOutput;
window.attachToSession = attachToSession;
window.exportData = exportData;
window.exportTaskLogs = exportTaskLogs;
window.toggleSelectMode = toggleSelectMode;
window.toggleTaskSelection = toggleTaskSelection;
window.toggleStarTask = toggleStarTask;
window.filterByTag = filterByTag;
window.saveCurrentTaskAsTemplate = saveCurrentTaskAsTemplate;
window.loadTemplate = loadTemplate;
window.deleteTemplate = deleteTemplate;
window.batchCancel = batchCancel;
window.batchDelete = batchDelete;
window.clearSelection = clearSelection;
