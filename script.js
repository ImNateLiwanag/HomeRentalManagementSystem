const defaultTenants = [
  { id: "TNT-001", firstName: "JUAN", lastName: "DELA CRUZ", middleName: "SANTOS", unit: "Unit 101 - Studio", status: "Active", password: "TN-1001", rent: 8500, dueDay: 5 },
  { id: "TNT-002", firstName: "MARIA", lastName: "CLARA", middleName: "SILANG", unit: "Unit 202 - 1BR", status: "Active", password: "TN-1002", rent: 12000, dueDay: 15 }
];
const defaultPayments = [
  { id: "PAY-901", tenantId: "TNT-001", tenantName: "JUAN DELA CRUZ", amount: 8500, date: "2026-09-01", method: "GCash", status: "Approved", receipt: "Ref #882104" },
  { id: "PAY-902", tenantId: "TNT-002", tenantName: "MARIA CLARA", amount: 12000, date: "2026-09-02", method: "Bank Transfer", status: "Approved", receipt: "Ref #991042" }
];
const defaultIssues = [
  { id: "ISS-101", tenantId: "TNT-001", tenantName: "JUAN DELA CRUZ", category: "Plumbing", description: "May tulo ang sink sa kitchen", date: "2026-09-10", status: "Pending" }
];
const defaultUnits = [
  { id: "UNT-001", name: "Unit 101 - Studio", rent: 8500 },
  { id: "UNT-002", name: "Unit 202 - 1BR", rent: 12000 },
  { id: "UNT-003", name: "Unit 303 - 1BR", rent: 10500 }
];

function readStore(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.warn("Could not read stored " + key, error);
    return fallback;
  }
}

let tenants = readStore("tulatok_tenants", defaultTenants);
let payments = readStore("tulatok_payments", defaultPayments);
let issues = readStore("tulatok_issues", defaultIssues);
let units = readStore("tulatok_units", defaultUnits);
let documents = readStore("tulatok_documents", []);
let feedbackEntries = readStore("tulatok_feedback", []);
let notifications = readStore("tulatok_notifications", []);
let auditEntries = readStore("tulatok_audit", []);
let currentTenant = null;
const adminName = "Christian Gal";

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

function saveData() {
  try {
    localStorage.setItem("tulatok_tenants", JSON.stringify(tenants));
    localStorage.setItem("tulatok_payments", JSON.stringify(payments));
    localStorage.setItem("tulatok_issues", JSON.stringify(issues));
    localStorage.setItem("tulatok_units", JSON.stringify(units));
    localStorage.setItem("tulatok_documents", JSON.stringify(documents));
    localStorage.setItem("tulatok_feedback", JSON.stringify(feedbackEntries));
    localStorage.setItem("tulatok_notifications", JSON.stringify(notifications));
    localStorage.setItem("tulatok_audit", JSON.stringify(auditEntries));
    return true;
  } catch (error) {
    alert("Browser storage is full or unavailable. The latest change could not be saved.");
    console.error("Could not save rental data", error);
    return false;
  }
}

function nextId(prefix, records, width) {
  const matcher = new RegExp("^" + prefix + "-(\\d+)$");
  const maximum = records.reduce(function (max, record) {
    const match = String(record.id || "").match(matcher);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return prefix + "-" + String(maximum + 1).padStart(width || 3, "0");
}

function actorName() {
  return currentTenant ? currentTenant.firstName + " " + currentTenant.lastName : adminName;
}

function saveAudit(action, details) {
  auditEntries.unshift({
    id: nextId("LOG", auditEntries, 5),
    time: new Date().toISOString(),
    actor: actorName(),
    action: action,
    details: details || ""
  });
  if (auditEntries.length > 500) auditEntries.length = 500;
  saveData();
  renderAuditLog();
}

function addNotification(tenantId, message) {
  notifications.unshift({
    id: nextId("NTF", notifications, 5),
    tenantId: tenantId || null,
    message: message,
    time: new Date().toISOString(),
    read: false
  });
  if (notifications.length > 500) notifications.length = 500;
  saveData();
  renderNotifications();
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add("active");
}
function closeModal(modalId) {
  document.getElementById(modalId).classList.remove("active");
}
function openPortalSelection() {
  document.querySelectorAll(".view").forEach(function (view) { view.classList.remove("active"); });
  document.getElementById("view-portal").classList.add("active");
  document.getElementById("current-portal-badge").innerText = "PORTAL SELECTION";
  document.getElementById("switch-portal-btn").style.display = "none";
}
function showView(viewId, badge) {
  document.querySelectorAll(".view").forEach(function (view) { view.classList.remove("active"); });
  document.getElementById(viewId).classList.add("active");
  document.getElementById("current-portal-badge").innerText = badge;
  document.getElementById("switch-portal-btn").style.display = "inline-block";
}

function loginAdmin(event) {
  event.preventDefault();
  closeModal("admin-modal");
  currentTenant = null;
  showView("view-admin", "ADMIN PORTAL");
  renderAdminDashboard();
  saveAudit("Admin login", "Admin opened the landlord portal.");
}
function autoFillPassword() {
  const lastName = document.getElementById("tenant-search-lastname").value.trim().toUpperCase();
  const firstName = document.getElementById("tenant-search-firstname").value.trim().toUpperCase();
  const middleName = document.getElementById("tenant-search-middlename").value.trim().toUpperCase();
  const match = tenants.find(function (tenant) {
    return tenant.status === "Active" && tenant.lastName === lastName &&
      tenant.firstName === firstName && (!middleName || tenant.middleName === middleName);
  });
  if (match) {
    document.getElementById("tenant-password-input").value = match.password;
    alert("Demo account found for " + match.firstName + " " + match.lastName + ". This lookup is for prototype use only.");
  } else {
    alert("No active tenant record matched those details.");
  }
}
function loginTenant(event) {
  event.preventDefault();
  const lastName = document.getElementById("tenant-search-lastname").value.trim().toUpperCase();
  const firstName = document.getElementById("tenant-search-firstname").value.trim().toUpperCase();
  const password = document.getElementById("tenant-password-input").value.trim();
  const found = tenants.find(function (tenant) {
    return tenant.status === "Active" && tenant.lastName === lastName &&
      tenant.firstName === firstName && tenant.password === password;
  });
  if (!found) {
    alert("Invalid details. Check the name inputs or use the demo account lookup.");
    return;
  }
  currentTenant = found;
  closeModal("tenant-modal");
  showView("view-tenant", "TENANT PORTAL");
  renderTenantDashboard();
  saveAudit("Tenant login", found.firstName + " " + found.lastName + " opened the tenant portal.");
}
function logout() {
  saveAudit("Logout", "User signed out of the portal.");
  currentTenant = null;
  openPortalSelection();
}

function switchAdminTab(tabId, button) {
  document.querySelectorAll("#view-admin .tab-pane").forEach(function (pane) { pane.classList.remove("active"); });
  document.querySelectorAll("#view-admin .nav-btn").forEach(function (nav) { nav.classList.remove("active"); });
  document.getElementById(tabId).classList.add("active");
  button.classList.add("active");
}
function switchTenantTab(tabId, button) {
  document.querySelectorAll("#view-tenant .tab-pane").forEach(function (pane) { pane.classList.remove("active"); });
  document.querySelectorAll("#view-tenant .nav-btn").forEach(function (nav) { nav.classList.remove("active"); });
  document.getElementById(tabId).classList.add("active");
  button.classList.add("active");
}

function statusClass(status) {
  if (status === "Approved" || status === "Completed" || status === "Active" || status === "Occupied") return "status-completed";
  if (status === "Rejected" || status === "Inactive" || status === "Vacant") return "status-unpaid";
  if (status === "In Progress") return "status-progress";
  return "status-pending";
}
function tenantFor(id) {
  return tenants.find(function (tenant) { return tenant.id === id; });
}
function fillUnitOptions(editTenantId) {
  const select = document.getElementById("reg-unit");
  if (!select) return;
  const available = units.filter(function (unit) {
    return !tenants.some(function (tenant) {
      return tenant.status === "Active" && tenant.unit === unit.name && tenant.id !== editTenantId;
    });
  });
  select.innerHTML = available.map(function (unit) {
    return '<option value="' + escapeHtml(unit.name) + '" data-rent="' + Number(unit.rent) + '">' +
      escapeHtml(unit.name) + " - PHP " + Number(unit.rent).toLocaleString() + "</option>";
  }).join("");
  if (!available.length) select.innerHTML = '<option value="">No vacant units; add a unit first</option>';
  const selected = select.options[select.selectedIndex];
  if (selected && selected.dataset.rent) document.getElementById("reg-rent").value = selected.dataset.rent;
}

function renderUnits() {
  const body = document.getElementById("table-admin-units");
  body.innerHTML = "";
  units.forEach(function (unit) {
    const occupant = tenants.find(function (tenant) { return tenant.status === "Active" && tenant.unit === unit.name; });
    const hasTenantHistory = tenants.some(function (tenant) { return tenant.unit === unit.name; });
    const unitActions = '<button class="btn btn-outline btn-sm" onclick="editUnit(\'' + escapeHtml(unit.id) + '\')">Edit</button> ' +
      '<button class="btn btn-outline btn-sm" ' + (hasTenantHistory ? 'disabled title="Unit has tenancy history"' : '') +
      ' onclick="deleteUnit(\'' + escapeHtml(unit.id) + '\')">Delete</button>';
    const row = document.createElement("tr");
    row.innerHTML = "<td>" + escapeHtml(unit.name) + "</td><td>PHP " + Number(unit.rent).toLocaleString() +
      '</td><td><span class="status-badge ' + statusClass(occupant ? "Occupied" : "Vacant") + '">' +
      (occupant ? "Occupied" : "Vacant") + "</span></td><td>" +
      (occupant ? escapeHtml(occupant.firstName + " " + occupant.lastName) : "—") + "</td><td>" + unitActions + "</td>";
    body.appendChild(row);
  });
  const occupied = units.filter(function (unit) {
    return tenants.some(function (tenant) { return tenant.status === "Active" && tenant.unit === unit.name; });
  }).length;
  const occupancy = units.length ? Math.round(occupied / units.length * 100) : 0;
  document.getElementById("kpi-occupancy").innerText = occupancy + "%";
}

function renderTenants() {
  const body = document.getElementById("table-admin-tenants");
  body.innerHTML = "";
  tenants.forEach(function (tenant) {
    const row = document.createElement("tr");
    row.innerHTML = "<td><strong>" + escapeHtml(tenant.id) + "</strong></td><td>" +
      escapeHtml(tenant.lastName + ", " + tenant.firstName + " " + (tenant.middleName || "")) + "</td><td>" +
      escapeHtml(tenant.unit) + "</td><td>PHP " + Number(tenant.rent).toLocaleString() +
      '</td><td><code>' + escapeHtml(tenant.password) + '</code></td><td><span class="status-badge ' +
      statusClass(tenant.status) + '">' + escapeHtml(tenant.status) + '</span></td><td>' +
      (tenant.status === "Active" ? '<button class="btn btn-outline btn-sm" onclick="editTenant(\'' + escapeHtml(tenant.id) + '\')">Edit</button> ' +
        '<button class="btn btn-outline btn-sm" onclick="deactivateTenant(\'' + escapeHtml(tenant.id) + '\')">End Tenancy</button>' : "—") +
      "</td>";
    body.appendChild(row);
  });
}

function renderPayments() {
  const body = document.getElementById("table-admin-payments");
  body.innerHTML = "";
  payments.slice().reverse().forEach(function (payment) {
    const row = document.createElement("tr");
    let review = "—";
    if (payment.status === "Pending") {
      review = '<button class="btn btn-primary btn-sm" onclick="reviewPayment(\'' + escapeHtml(payment.id) + '\', \'Approved\')">Approve</button> ' +
        '<button class="btn btn-outline btn-sm" onclick="reviewPayment(\'' + escapeHtml(payment.id) + '\', \'Rejected\')">Reject</button>';
    }
    row.innerHTML = "<td>" + escapeHtml(payment.id) + "</td><td>" + escapeHtml(payment.tenantName) +
      '</td><td class="money">PHP ' + Number(payment.amount).toLocaleString() + "</td><td>" +
      escapeHtml(payment.date) + "</td><td>" + escapeHtml(payment.method + " (" + payment.receipt + ")") +
      '</td><td><span class="status-badge ' + statusClass(payment.status) + '">' + escapeHtml(payment.status) +
      "</span></td><td>" + review + "</td>";
    body.appendChild(row);
  });
}
function renderIssues() {
  const body = document.getElementById("table-admin-issues");
  body.innerHTML = "";
  issues.slice().reverse().forEach(function (issue) {
    let action = "—";
    if (issue.status === "Pending") {
      action = '<button class="btn btn-primary btn-sm" onclick="updateIssueStatus(\'' + escapeHtml(issue.id) + '\', \'In Progress\')">Start work</button>';
    } else if (issue.status === "In Progress") {
      action = '<button class="btn btn-primary btn-sm" onclick="updateIssueStatus(\'' + escapeHtml(issue.id) + '\', \'Completed\')">Mark resolved</button>';
    }
    const row = document.createElement("tr");
    row.innerHTML = "<td>" + escapeHtml(issue.id) + "</td><td>" + escapeHtml(issue.tenantName) +
      "</td><td>" + escapeHtml(issue.category) + "</td><td>" + escapeHtml(issue.description) +
      "</td><td>" + escapeHtml(issue.date) + '</td><td><span class="status-badge ' +
      statusClass(issue.status) + '">' + escapeHtml(issue.status) + "</span></td><td>" + action + "</td>";
    body.appendChild(row);
  });
}
function renderDocuments() {
  const adminBody = document.getElementById("table-admin-documents");
  adminBody.innerHTML = "";
  documents.slice().reverse().forEach(function (documentRecord) {
    const row = document.createElement("tr");
    row.innerHTML = "<td>" + escapeHtml(documentRecord.date) + "</td><td>" +
      escapeHtml(documentRecord.tenantName) + "</td><td>" + escapeHtml(documentRecord.title || documentRecord.name) +
      "</td><td>v" + Number(documentRecord.version || 1) + "</td><td>" + escapeHtml(documentRecord.type) + '</td><td><a class="btn btn-outline btn-sm" href="' +
      escapeHtml(documentRecord.dataUrl) + '" download="' + escapeHtml(documentRecord.name) + '">Download</a></td>';
    adminBody.appendChild(row);
  });
  const tenantList = document.getElementById("tenant-document-list");
  tenantList.innerHTML = "";
  if (!currentTenant) return;
  documents.filter(function (record) { return record.tenantId === currentTenant.id; }).forEach(function (record) {
    const item = document.createElement("li");
    item.innerHTML = '<span><strong>' + escapeHtml(record.title || record.type) + " · v" + Number(record.version || 1) +
      "</strong><br>" + escapeHtml(record.name) + " · " + escapeHtml(record.date) +
      '</span><a class="btn btn-outline btn-sm" href="' + escapeHtml(record.dataUrl) +
      '" download="' + escapeHtml(record.name) + '">Download</a>';
    tenantList.appendChild(item);
  });
  if (!tenantList.children.length) tenantList.innerHTML = "<li>No documents uploaded yet.</li>";
}
function renderUsers() {
  const body = document.getElementById("table-admin-users");
  body.innerHTML = "";
  const adminRow = document.createElement("tr");
  adminRow.innerHTML = "<td>" + escapeHtml(adminName) + '</td><td>ADM-001</td><td><span class="role-badge">Landlord / Admin</span></td><td>All units</td><td><span class="status-badge status-completed">Active</span></td>';
  body.appendChild(adminRow);
  tenants.forEach(function (tenant) {
    const row = document.createElement("tr");
    row.innerHTML = "<td>" + escapeHtml(tenant.firstName + " " + tenant.lastName) + "</td><td>" +
      escapeHtml(tenant.id) + '</td><td><span class="role-badge">Tenant</span></td><td>' +
      escapeHtml(tenant.unit) + '</td><td><span class="status-badge ' + statusClass(tenant.status) + '">' +
      escapeHtml(tenant.status) + "</span></td>";
    body.appendChild(row);
  });
}
function renderFeedbackControls() {
  const adminSelect = document.getElementById("admin-feedback-issue");
  const tenantSelect = document.getElementById("tenant-feedback-issue");
  const allIssues = issues.slice().reverse();
  const tenantIssues = currentTenant ? allIssues.filter(function (issue) { return issue.tenantId === currentTenant.id; }) : [];
  function setOptions(select, records, emptyLabel) {
    const previous = select.value;
    select.innerHTML = records.map(function (issue) {
      const tenant = tenantFor(issue.tenantId);
      const owner = tenant ? tenant.firstName + " " + tenant.lastName : issue.tenantName;
      return '<option value="' + escapeHtml(issue.id) + '">' + escapeHtml(issue.id + " · " + owner + " · " + issue.category) + "</option>";
    }).join("");
    if (!records.length) select.innerHTML = '<option value="">' + escapeHtml(emptyLabel) + "</option>";
    if (records.some(function (issue) { return issue.id === previous; })) select.value = previous;
  }
  setOptions(adminSelect, allIssues, "No maintenance requests yet");
  setOptions(tenantSelect, tenantIssues, "You have no maintenance requests yet");
}
function renderFeedbackThread(role) {
  const select = document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue");
  const list = document.getElementById(role === "admin" ? "admin-feedback-thread" : "tenant-feedback-thread");
  if (!select || !list) return;
  const issueId = select.value;
  list.innerHTML = "";
  feedbackEntries.filter(function (entry) { return entry.issueId === issueId; }).slice().reverse().forEach(function (entry) {
    const item = document.createElement("li");
    item.innerHTML = '<div class="feedback-meta"><strong>' + escapeHtml(entry.author) +
      '</strong><span class="role-badge">' + escapeHtml(entry.role) + "</span><time>" +
      escapeHtml(new Date(entry.createdAt).toLocaleString()) + '</time></div><p>' + escapeHtml(entry.text) + "</p>";
    list.appendChild(item);
  });
  if (!list.children.length) list.innerHTML = "<li>No comments on this request yet.</li>";
}
function submitFeedback(event, role) {
  event.preventDefault();
  if (role === "tenant" && !currentTenant) return;
  const issueId = document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue").value;
  const issue = issues.find(function (record) { return record.id === issueId; });
  const text = document.getElementById(role === "admin" ? "admin-feedback-text" : "tenant-feedback-text").value.trim();
  if (!issue || !text || (role === "tenant" && issue.tenantId !== currentTenant.id)) return;
  const entry = {
    id: nextId("FB", feedbackEntries, 4),
    issueId: issue.id,
    tenantId: issue.tenantId,
    author: role === "admin" ? adminName : currentTenant.firstName + " " + currentTenant.lastName,
    role: role === "admin" ? "Landlord / Admin" : "Tenant",
    text: text,
    createdAt: new Date().toISOString()
  };
  feedbackEntries.push(entry);
  if (!saveData()) {
    feedbackEntries.pop();
    return;
  }
  document.getElementById(role === "admin" ? "form-admin-feedback" : "form-tenant-feedback").reset();
  renderFeedbackControls();
  document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue").value = issue.id;
  renderFeedbackThread(role);
  saveAudit("Maintenance comment added", "Comment added to request " + issue.id + ".");
  if (role === "admin") addNotification(issue.tenantId, "The landlord added a comment to maintenance request " + issue.id + ".");
  else addNotification(null, entry.author + " commented on maintenance request " + issue.id + ".");
}
function markNotificationRead(id, role) {
  const notification = notifications.find(function (record) { return record.id === id; });
  if (!notification) return;
  const readerId = role === "admin" ? "ADM-001" : currentTenant && currentTenant.id;
  if (!readerId || (role === "tenant" && notification.tenantId !== readerId)) return;
  notification.readBy = notification.readBy || [];
  if (notification.readBy.indexOf(readerId) !== -1) return;
  notification.readBy.push(readerId);
  saveData();
  renderNotifications();
  saveAudit("Notification marked read", notification.id + " marked read by " + (role === "admin" ? adminName : actorName()) + ".");
}
function renderNotifications() {
  const adminList = document.getElementById("admin-notification-list");
  adminList.innerHTML = "";
  notifications.forEach(function (notification) {
    const tenant = tenantFor(notification.tenantId);
    const audience = tenant ? "Tenant: " + tenant.firstName + " " + tenant.lastName : "Admin";
    const isRead = (notification.readBy || []).indexOf("ADM-001") !== -1;
    const item = document.createElement("li");
    item.innerHTML = "<span><strong>" + escapeHtml(audience) + "</strong><br>" +
      escapeHtml(notification.message) + "</span><time>" +
      escapeHtml(new Date(notification.time).toLocaleString()) + "</time>" +
      (isRead ? '<span class="read-label">Read</span>' : '<button class="btn btn-outline btn-sm" onclick="markNotificationRead(\'' + escapeHtml(notification.id) + '\', \'admin\')">Mark read</button>');
    adminList.appendChild(item);
  });
  if (!adminList.children.length) adminList.innerHTML = "<li>No notifications recorded yet.</li>";
  const tenantList = document.getElementById("tenant-notification-list");
  tenantList.innerHTML = "";
  if (!currentTenant) return;
  notifications.filter(function (notification) { return notification.tenantId === currentTenant.id; }).forEach(function (notification) {
    const isRead = (notification.readBy || []).indexOf(currentTenant.id) !== -1;
    const item = document.createElement("li");
    item.innerHTML = "<span>" + escapeHtml(notification.message) + "</span><time>" +
      escapeHtml(new Date(notification.time).toLocaleString()) + "</time>" +
      (isRead ? '<span class="read-label">Read</span>' : '<button class="btn btn-outline btn-sm" onclick="markNotificationRead(\'' + escapeHtml(notification.id) + '\', \'tenant\')">Mark read</button>');
    tenantList.appendChild(item);
  });
  if (!tenantList.children.length) tenantList.innerHTML = "<li>No notifications yet.</li>";
}
function renderAuditLog() {
  const body = document.getElementById("table-admin-audit");
  body.innerHTML = "";
  auditEntries.forEach(function (entry) {
    const row = document.createElement("tr");
    row.innerHTML = "<td>" + escapeHtml(new Date(entry.time).toLocaleString()) + "</td><td>" +
      escapeHtml(entry.actor) + "</td><td>" + escapeHtml(entry.action) + "</td><td>" +
      escapeHtml(entry.details) + "</td>";
    body.appendChild(row);
  });
}
function renderReports() {
  const summary = document.getElementById("admin-report-summary");
  const activeTenants = tenants.filter(function (tenant) { return tenant.status === "Active"; });
  const pendingPayments = payments.filter(function (payment) { return payment.status === "Pending"; });
  const approvedTotal = payments.filter(function (payment) { return payment.status === "Approved"; })
    .reduce(function (sum, payment) { return sum + Number(payment.amount || 0); }, 0);
  const pendingIssues = issues.filter(function (issue) { return issue.status === "Pending" || issue.status === "In Progress"; }).length;
  const values = [
    ["Active tenants", activeTenants.length],
    ["Registered units", units.length],
    ["Vacant units", Math.max(units.length - activeTenants.length, 0)],
    ["Expected monthly rent", "PHP " + activeTenants.reduce(function (sum, tenant) { return sum + Number(tenant.rent || 0); }, 0).toLocaleString()],
    ["Payments awaiting review", pendingPayments.length],
    ["Approved payment total", "PHP " + approvedTotal.toLocaleString()],
    ["Open maintenance requests", pendingIssues]
  ];
  summary.innerHTML = values.map(function (value) {
    return '<div class="details-item"><label>' + escapeHtml(value[0]) + "</label><span>" + escapeHtml(value[1]) + "</span></div>";
  }).join("");
}
function renderAdminDashboard() {
  const activeTenants = tenants.filter(function (tenant) { return tenant.status === "Active"; });
  document.getElementById("kpi-total-tenants").innerText = activeTenants.length;
  document.getElementById("kpi-total-revenue").innerText = "PHP " + activeTenants.reduce(function (sum, tenant) {
    return sum + Number(tenant.rent || 0);
  }, 0).toLocaleString();
  document.getElementById("kpi-pending-issues").innerText = issues.filter(function (issue) {
    return issue.status === "Pending" || issue.status === "In Progress";
  }).length;
  renderTenants();
  renderUsers();
  renderUnits();
  fillUnitOptions();
  renderPayments();
  renderIssues();
  renderDocuments();
  renderFeedbackControls();
  renderFeedbackThread("admin");
  renderNotifications();
  renderReports();
  renderAuditLog();
}

function registerTenant(event) {
  event.preventDefault();
  const unitName = document.getElementById("reg-unit").value;
  const unit = units.find(function (candidate) { return candidate.name === unitName; });
  const editingId = document.getElementById("reg-tenant-id").value;
  if (!unit || tenants.some(function (tenant) {
    return tenant.status === "Active" && tenant.unit === unitName && tenant.id !== editingId;
  })) {
    alert("Choose an available unit. Add a unit first if none are vacant.");
    return;
  }
  const firstName = document.getElementById("reg-firstname").value.trim().toUpperCase();
  const lastName = document.getElementById("reg-lastname").value.trim().toUpperCase();
  const middleName = document.getElementById("reg-middlename").value.trim().toUpperCase();
  const rent = Number(document.getElementById("reg-rent").value) || Number(unit.rent);
  const dueDay = Number(document.getElementById("reg-dueday").value) || 5;
  if (editingId) {
    const tenant = tenantFor(editingId);
    if (!tenant || tenant.status !== "Active") return;
    const oldSummary = tenant.unit + " at PHP " + Number(tenant.rent).toLocaleString();
    tenant.firstName = firstName;
    tenant.lastName = lastName;
    tenant.middleName = middleName;
    tenant.unit = unit.name;
    tenant.rent = rent;
    tenant.dueDay = dueDay;
    saveData();
    cancelTenantEdit();
    renderAdminDashboard();
    saveAudit("Tenant updated", tenant.firstName + " " + tenant.lastName + ": " + oldSummary + " → " + tenant.unit + " at PHP " + rent.toLocaleString() + ".");
    addNotification(tenant.id, "Your rental account details were updated by the landlord.");
    return;
  }
  const tenant = {
    id: nextId("TNT", tenants, 3), firstName: firstName, lastName: lastName,
    middleName: middleName, unit: unit.name, status: "Active",
    password: "TN-" + Math.floor(1000 + Math.random() * 9000),
    rent: rent, dueDay: dueDay
  };
  tenants.push(tenant);
  saveData();
  cancelTenantEdit();
  renderAdminDashboard();
  saveAudit("Tenant registered", tenant.firstName + " " + tenant.lastName + " assigned to " + tenant.unit + ".");
  addNotification(tenant.id, "Welcome to the rental portal. Your assigned unit is " + tenant.unit + ".");
  alert("Tenant registered. Demo password: " + tenant.password);
}
function editTenant(id) {
  const tenant = tenantFor(id);
  if (!tenant || tenant.status !== "Active") return;
  document.getElementById("reg-tenant-id").value = tenant.id;
  document.getElementById("reg-lastname").value = tenant.lastName;
  document.getElementById("reg-firstname").value = tenant.firstName;
  document.getElementById("reg-middlename").value = tenant.middleName || "";
  fillUnitOptions(tenant.id);
  document.getElementById("reg-unit").value = tenant.unit;
  document.getElementById("reg-rent").value = tenant.rent;
  document.getElementById("reg-dueday").value = tenant.dueDay;
  document.getElementById("tenant-form-heading").innerText = "Edit Tenant Account";
  document.getElementById("tenant-form-submit").innerText = "Save Tenant Changes";
  document.getElementById("tenant-form-cancel").style.display = "block";
  document.getElementById("form-register-tenant").scrollIntoView({ behavior: "smooth", block: "center" });
}
function cancelTenantEdit() {
  document.getElementById("form-register-tenant").reset();
  document.getElementById("reg-tenant-id").value = "";
  document.getElementById("tenant-form-heading").innerText = "Register New Tenant";
  document.getElementById("tenant-form-submit").innerText = "Save Tenant & Generate Password";
  document.getElementById("tenant-form-cancel").style.display = "none";
  fillUnitOptions();
}
function registerUnit(event) {
  event.preventDefault();
  const name = document.getElementById("unit-name").value.trim();
  const rent = Number(document.getElementById("unit-rent").value);
  const editingId = document.getElementById("edit-unit-id").value;
  if (units.some(function (unit) { return unit.id !== editingId && unit.name.toLowerCase() === name.toLowerCase(); })) {
    alert("A unit with that name already exists.");
    return;
  }
  if (editingId) {
    const unit = units.find(function (record) { return record.id === editingId; });
    if (!unit) return;
    const oldName = unit.name;
    unit.name = name;
    unit.rent = rent;
    tenants.forEach(function (tenant) { if (tenant.unit === oldName) tenant.unit = name; });
    saveData();
    cancelUnitEdit();
    renderAdminDashboard();
    saveAudit("Unit updated", oldName + " updated to " + name + " at PHP " + rent.toLocaleString() + ".");
    return;
  }
  units.push({ id: nextId("UNT", units, 3), name: name, rent: rent });
  saveData();
  renderAdminDashboard();
  cancelUnitEdit();
  saveAudit("Unit added", name + " was added to the rental inventory.");
}
function editUnit(id) {
  const unit = units.find(function (record) { return record.id === id; });
  if (!unit) return;
  document.getElementById("edit-unit-id").value = unit.id;
  document.getElementById("unit-name").value = unit.name;
  document.getElementById("unit-rent").value = unit.rent;
  document.getElementById("unit-form-heading").innerText = "Edit Rental Unit";
  document.getElementById("unit-form-submit").innerText = "Save Unit Changes";
  document.getElementById("unit-form-cancel").style.display = "inline-block";
  document.getElementById("form-register-unit").scrollIntoView({ behavior: "smooth", block: "center" });
}
function cancelUnitEdit() {
  document.getElementById("form-register-unit").reset();
  document.getElementById("edit-unit-id").value = "";
  document.getElementById("unit-form-heading").innerText = "Add Rental Unit";
  document.getElementById("unit-form-submit").innerText = "Add Unit";
  document.getElementById("unit-form-cancel").style.display = "none";
}
function deleteUnit(id) {
  const unit = units.find(function (record) { return record.id === id; });
  if (!unit) return;
  if (tenants.some(function (tenant) { return tenant.unit === unit.name; })) {
    alert("This unit has tenancy history and cannot be deleted. Keep it to preserve the rental record.");
    return;
  }
  if (!confirm("Delete vacant unit " + unit.name + "?")) return;
  units = units.filter(function (record) { return record.id !== id; });
  saveData();
  cancelUnitEdit();
  renderAdminDashboard();
  saveAudit("Unit deleted", unit.name + " was removed from the inventory.");
}
function deactivateTenant(id) {
  const tenant = tenantFor(id);
  if (!tenant || !confirm("End the tenancy for " + tenant.firstName + " " + tenant.lastName + "? Historical records will be kept.")) return;
  tenant.status = "Inactive";
  saveData();
  renderAdminDashboard();
  saveAudit("Tenancy ended", tenant.firstName + " " + tenant.lastName + " vacated " + tenant.unit + ".");
  addNotification(tenant.id, "Your tenancy has been marked inactive. Contact the landlord if this is unexpected.");
}
function reviewPayment(id, status) {
  const payment = payments.find(function (record) { return record.id === id; });
  if (!payment || payment.status !== "Pending" || (status !== "Approved" && status !== "Rejected")) return;
  payment.status = status;
  payment.reviewedAt = new Date().toISOString();
  saveData();
  renderAdminDashboard();
  saveAudit("Payment " + status.toLowerCase(), payment.id + " for PHP " + Number(payment.amount).toLocaleString() + ".");
  addNotification(payment.tenantId, "Your payment " + payment.id + " was " + status.toLowerCase() + ".");
}
function updateIssueStatus(id, status) {
  const issue = issues.find(function (record) { return record.id === id; });
  if (!issue || ["Pending", "In Progress", "Completed"].indexOf(status) === -1) return;
  issue.status = status;
  issue.updatedAt = new Date().toISOString();
  saveData();
  renderAdminDashboard();
  saveAudit("Maintenance status updated", issue.id + " changed to " + status + ".");
  addNotification(issue.tenantId, "Maintenance request " + issue.id + " is now " + status.toLowerCase() + ".");
}

function renderTenantDashboard() {
  if (!currentTenant) return;
  const latestTenant = tenantFor(currentTenant.id);
  if (latestTenant) currentTenant = latestTenant;
  document.getElementById("tenant-display-name").innerText = currentTenant.firstName + " " + currentTenant.lastName;
  document.getElementById("tenant-display-unit").innerText = currentTenant.unit;
  document.getElementById("tenant-display-rent").innerText = "PHP " + Number(currentTenant.rent).toLocaleString();
  document.getElementById("tenant-display-duedate").innerText = "Every " + currentTenant.dueDay + "th of the month";
  const paymentsBody = document.getElementById("table-tenant-payments");
  paymentsBody.innerHTML = "";
  payments.filter(function (payment) { return payment.tenantId === currentTenant.id; }).slice().reverse().forEach(function (payment) {
    const row = document.createElement("tr");
    row.innerHTML = "<td>" + escapeHtml(payment.date) + "</td><td>PHP " + Number(payment.amount).toLocaleString() +
      "</td><td>" + escapeHtml(payment.method) + "</td><td>" + escapeHtml(payment.receipt) +
      '</td><td><span class="status-badge ' + statusClass(payment.status) + '">' + escapeHtml(payment.status) + "</span></td>";
    paymentsBody.appendChild(row);
  });
  const issuesBody = document.getElementById("table-tenant-issues");
  issuesBody.innerHTML = "";
  issues.filter(function (issue) { return issue.tenantId === currentTenant.id; }).slice().reverse().forEach(function (issue) {
    const row = document.createElement("tr");
    row.innerHTML = "<td>" + escapeHtml(issue.date) + "</td><td>" + escapeHtml(issue.category) +
      "</td><td>" + escapeHtml(issue.description) + '</td><td><span class="status-badge ' +
      statusClass(issue.status) + '">' + escapeHtml(issue.status) + "</span></td>";
    issuesBody.appendChild(row);
  });
  renderDocuments();
  renderNotifications();
  renderFeedbackControls();
  renderFeedbackThread("tenant");
}

function submitTenantPayment(event) {
  event.preventDefault();
  if (!currentTenant) return;
  const amount = Number(document.getElementById("pay-amount").value);
  const method = document.getElementById("pay-method").value;
  const reference = document.getElementById("pay-ref").value.trim();
  if (!Number.isFinite(amount) || amount <= 0 || !reference) {
    alert("Enter a positive amount and a receipt reference.");
    return;
  }
  const payment = {
    id: nextId("PAY", payments, 3),
    tenantId: currentTenant.id,
    tenantName: currentTenant.firstName + " " + currentTenant.lastName,
    amount: amount,
    date: new Date().toISOString().split("T")[0],
    method: method,
    status: "Pending",
    receipt: reference
  };
  payments.push(payment);
  saveData();
  renderTenantDashboard();
  document.getElementById("form-tenant-payment").reset();
  saveAudit("Payment submitted", payment.id + " submitted for landlord review.");
  addNotification(null, payment.tenantName + " submitted payment " + payment.id + " for review.");
  alert("Payment receipt submitted. It will show as pending until the landlord reviews it.");
}
function submitTenantIssue(event) {
  event.preventDefault();
  if (!currentTenant) return;
  const category = document.getElementById("issue-category").value;
  const description = document.getElementById("issue-desc").value.trim();
  if (!description) return;
  const issue = {
    id: nextId("ISS", issues, 3),
    tenantId: currentTenant.id,
    tenantName: currentTenant.firstName + " " + currentTenant.lastName,
    category: category,
    description: description,
    date: new Date().toISOString().split("T")[0],
    status: "Pending"
  };
  issues.push(issue);
  saveData();
  renderTenantDashboard();
  document.getElementById("form-tenant-issue").reset();
  saveAudit("Maintenance request submitted", issue.id + " (" + category + ") submitted.");
  addNotification(null, issue.tenantName + " submitted maintenance request " + issue.id + ".");
  alert("Maintenance request sent to the landlord.");
}

function submitTenantDocument(event) {
  event.preventDefault();
  if (!currentTenant) return;
  const fileInput = document.getElementById("document-file");
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const uploadingTenant = currentTenant;
  const title = document.getElementById("document-title").value.trim();
  const type = document.getElementById("document-type").value;
  if (file.size > 500 * 1024) {
    alert("This browser prototype supports files up to 500 KB.");
    return;
  }
  const reader = new FileReader();
  reader.onload = function () {
    const versionGroup = uploadingTenant.id + "|" + type + "|" + title.toLocaleLowerCase();
    const version = documents.filter(function (record) { return record.versionGroup === versionGroup; })
      .reduce(function (maximum, record) { return Math.max(maximum, Number(record.version) || 1); }, 0) + 1;
    const record = {
      id: nextId("DOC", documents, 4),
      tenantId: uploadingTenant.id,
      tenantName: uploadingTenant.firstName + " " + uploadingTenant.lastName,
      title: title,
      versionGroup: versionGroup,
      version: version,
      type: type,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      date: new Date().toISOString().split("T")[0],
      dataUrl: reader.result
    };
    documents.push(record);
    if (!saveData()) {
      documents.pop();
      return;
    }
    renderDocuments();
    document.getElementById("form-tenant-document").reset();
    saveAudit("Document uploaded", file.name + " uploaded by " + record.tenantName + ".");
    addNotification(null, record.tenantName + " uploaded " + file.name + ".");
    alert("Document uploaded to this browser's prototype storage.");
  };
  reader.onerror = function () { alert("The selected file could not be read."); };
  reader.readAsDataURL(file);
}

document.addEventListener("DOMContentLoaded", function () {
  document.getElementById("reg-unit").addEventListener("change", function () {
    const option = this.options[this.selectedIndex];
    if (option && option.dataset.rent) document.getElementById("reg-rent").value = option.dataset.rent;
  });
  tenants = tenants.map(function (tenant) {
    tenant.status = tenant.status || "Active";
    return tenant;
  });
  const versionCounts = {};
  documents.slice().sort(function (a, b) { return String(a.date || "").localeCompare(String(b.date || "")); }).forEach(function (record) {
    record.title = record.title || record.type || record.name || "Document";
    const group = record.versionGroup || record.tenantId + "|" + record.type + "|" + record.title.toLocaleLowerCase();
    record.versionGroup = group;
    if (!record.version) record.version = (versionCounts[group] || 0) + 1;
    versionCounts[group] = Math.max(versionCounts[group] || 0, Number(record.version) || 1);
  });
  units = units || [];
  tenants.forEach(function (tenant) {
    if (!units.some(function (unit) { return unit.name === tenant.unit; })) {
      units.push({ id: nextId("UNT", units, 3), name: tenant.unit, rent: Number(tenant.rent) || 0 });
    }
  });
  saveData();
});
