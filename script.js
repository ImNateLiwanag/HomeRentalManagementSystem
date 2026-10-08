let tenants = [];
let payments = [];
let issues = [];
let units = [];
let documents = [];
let feedbackEntries = [];
let notifications = [];
let auditEntries = [];
let currentTenant = null;
let currentUser = null;
let currentProfile = null;
let allProfiles = [];
let adminName = "Landlord";

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

function ensureDb(result) {
  if (result.error) throw result.error;
  return result.data;
}

function fullNameParts(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", middleName: parts.length > 2 ? parts.slice(1, -1).join(" ") : "", lastName: parts.length > 1 ? parts[parts.length - 1] : "" };
}

async function loadCloudData() {
  const admin = currentProfile.role === "admin";
  const result = await Promise.all([
    supabaseClient.from("profiles").select("id,email,full_name,role"),
    supabaseClient.from("units").select("id,name,monthly_rent,is_active,updated_at"),
    supabaseClient.from("tenancies").select("id,tenant_id,unit_id,monthly_rent,due_day,start_date,end_date"),
    supabaseClient.from("payments").select("id,submission_id,tenant_id,amount,billing_period,paid_on,method,reference,proof_storage_path,proof_file_name,status,reviewed_by,reviewed_at,created_at"),
    supabaseClient.from("maintenance_requests").select("id,tenant_id,category,description,status,created_at,updated_at"),
    supabaseClient.from("documents").select("id,tenant_id,title,category,storage_path,file_name,content_type,file_size,version,created_at"),
    supabaseClient.from("feedback").select("id,tenant_id,issue_id,author_id,message,created_at"),
    supabaseClient.from("notifications").select("id,tenant_id,message,created_at"),
    supabaseClient.from("audit_logs").select("id,actor_id,action,details,created_at").order("created_at", { ascending: false }).limit(500)
  ]);
  const [profileRows, unitRows, tenancyRows, paymentRows, issueRows, documentRows, feedbackRows, notificationRows, auditRows] = result.map(ensureDb);
  allProfiles = profileRows;
  const byId = new Map(profileRows.map(function (p) { return [p.id, p]; }));
  const unitById = new Map(unitRows.map(function (u) { return [u.id, u]; }));
  const latestTenancyByTenant = new Map();
  tenancyRows.slice().sort(function (a, b) {
    if ((a.end_date === null) !== (b.end_date === null)) return a.end_date === null ? -1 : 1;
    return String(b.start_date).localeCompare(String(a.start_date));
  }).forEach(function (tenancy) { if (!latestTenancyByTenant.has(tenancy.tenant_id)) latestTenancyByTenant.set(tenancy.tenant_id, tenancy); });
  tenants = Array.from(latestTenancyByTenant.values()).map(function (tenancy) {
    const profile = byId.get(tenancy.tenant_id);
    const unit = unitById.get(tenancy.unit_id);
    if (!profile || !unit) return null;
    const name = fullNameParts(profile.full_name);
    return { id: profile.id, profileId: profile.id, tenancyId: tenancy.id, email: profile.email, firstName: name.firstName, middleName: name.middleName, lastName: name.lastName, unit: unit.name, unitId: unit.id, status: tenancy.end_date ? "Inactive" : "Active", rent: Number(tenancy.monthly_rent), dueDay: tenancy.due_day };
  }).filter(Boolean);
  units = unitRows.map(function (u) { return { id: u.id, name: u.name, rent: Number(u.monthly_rent), isActive: u.is_active }; });
  const tenantById = new Map(tenants.map(function (t) { return [t.id, t]; }));
  payments = await Promise.all(paymentRows.map(async function (p) {
    const t = tenantById.get(p.tenant_id);
    let proofUrl = "";
    if (p.proof_storage_path) {
      const signed = await supabaseClient.storage.from("rental-documents").createSignedUrl(p.proof_storage_path, 3600);
      if (!signed.error && signed.data) proofUrl = signed.data.signedUrl;
    }
    return { id: p.id, submissionId: p.submission_id, tenantId: p.tenant_id, tenantName: t ? t.firstName + " " + t.lastName : "Tenant", amount: Number(p.amount), period: p.billing_period, date: p.paid_on, method: p.method, proofName: p.proof_file_name, proofUrl: proofUrl, status: p.status };
  }));
  issues = issueRows.map(function (i) { const t = tenantById.get(i.tenant_id); return { id: i.id, tenantId: i.tenant_id, tenantName: t ? t.firstName + " " + t.lastName : "Tenant", category: i.category, description: i.description, date: i.created_at.slice(0, 10), status: i.status }; });
  const readRows = ensureDb(await supabaseClient.from("notification_reads").select("notification_id,user_id"));
  const readsByNotification = new Map();
  readRows.forEach(function (r) { if (!readsByNotification.has(r.notification_id)) readsByNotification.set(r.notification_id, []); readsByNotification.get(r.notification_id).push(r.user_id); });
  notifications = notificationRows.map(function (n) { return { id: n.id, tenantId: n.tenant_id, message: n.message, time: n.created_at, readBy: readsByNotification.get(n.id) || [] }; });
  documents = await Promise.all(documentRows.map(async function (d) {
    const tenant = tenantById.get(d.tenant_id);
    const signed = await supabaseClient.storage.from("rental-documents").createSignedUrl(d.storage_path, 3600);
    return { id: d.id, tenantId: d.tenant_id, tenantName: tenant ? tenant.firstName + " " + tenant.lastName : "Tenant", title: d.title, type: d.category, name: d.file_name, mimeType: d.content_type, size: d.file_size, version: d.version, date: d.created_at.slice(0, 10), dataUrl: signed.data ? signed.data.signedUrl : "#" };
  }));
  feedbackEntries = feedbackRows.map(function (f) { const author = byId.get(f.author_id); const isAdminAuthor = author ? author.role === "admin" : f.author_id !== currentUser.id; return { id: f.id, tenantId: f.tenant_id, issueId: f.issue_id, author: author ? author.full_name : (isAdminAuthor ? "Landlord / Admin" : "Tenant"), role: isAdminAuthor ? "Landlord / Admin" : "Tenant", text: f.message, createdAt: f.created_at }; });
  auditEntries = auditRows.map(function (a) { const actor = byId.get(a.actor_id); return { id: a.id, actor: actor ? actor.full_name : "System", action: a.action, details: a.details, time: a.created_at }; });
  if (admin) {
    renderAdminDashboard();
    renderAuditLog();
  } else {
    currentTenant = tenants.find(function (t) { return t.id === currentUser.id && t.status === "Active"; }) || null;
  }
}

function actorName() {
  return currentTenant ? currentTenant.firstName + " " + currentTenant.lastName : adminName;
}

function saveAudit(action, details) {
  if (!currentUser) return;
  supabaseClient.from("audit_logs").insert({ actor_id: currentUser.id, action: action, details: details || "" })
    .then(function (result) { if (result.error) throw result.error; return supabaseClient.from("audit_logs").select("id,actor_id,action,details,created_at").order("created_at", { ascending: false }).limit(500); })
    .then(function (result) { auditEntries = ensureDb(result).map(function (a) { return { id: a.id, actor: currentProfile.full_name || currentProfile.email, action: a.action, details: a.details, time: a.created_at }; }); renderAuditLog(); })
    .catch(function (error) { console.error("Could not save audit entry", error); });
}

function addNotification(tenantId, message) {
  if (!currentUser) return;
  supabaseClient.from("notifications").insert({ tenant_id: tenantId || null, created_by: currentUser.id, message: message })
    .then(function (result) { if (result.error) throw result.error; return loadCloudData(); })
    .catch(function (error) { console.error("Could not create notification", error); });
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

async function loginAdmin(event) {
  event.preventDefault();
  await authenticate("admin", document.getElementById("admin-email").value, document.getElementById("admin-password").value);
}
async function loginTenant(event) {
  event.preventDefault();
  await authenticate("tenant", document.getElementById("tenant-email").value, document.getElementById("tenant-password").value);
}
async function authenticate(expectedRole, email, password) {
  try {
    const auth = ensureDb(await supabaseClient.auth.signInWithPassword({ email: email.trim(), password }));
    currentUser = auth.user;
    currentProfile = ensureDb(await supabaseClient.from("profiles").select("id,email,full_name,role").eq("id", currentUser.id).single());
    if (currentProfile.role !== expectedRole) {
      await supabaseClient.auth.signOut();
      currentUser = null;
      currentProfile = null;
      throw new Error("This account does not have " + expectedRole + " access.");
    }
    adminName = currentProfile.full_name || currentProfile.email;
    if (expectedRole === "admin") currentTenant = null;
    closeModal(expectedRole === "admin" ? "admin-modal" : "tenant-modal");
    await loadCloudData();
    if (expectedRole === "admin") {
      currentTenant = null;
      showView("view-admin", "ADMIN PORTAL");
      renderAdminDashboard();
    } else {
      if (!currentTenant) {
        await supabaseClient.auth.signOut();
        currentUser = null;
        currentProfile = null;
        throw new Error("Your account is active, but the landlord has not assigned an active unit yet.");
      }
      showView("view-tenant", "TENANT PORTAL");
      renderTenantDashboard();
    }
    saveAudit("Login", currentProfile.full_name + " signed in.");
  } catch (error) {
    alert(error.message || "Sign in failed. Check your email and password.");
  }
}
async function registerTenantAccount() {
  const email = document.getElementById("tenant-email").value.trim();
  const password = document.getElementById("tenant-password").value;
  const fullName = document.getElementById("tenant-signup-name").value.trim();
  if (!email || !password || !fullName) {
    alert("Enter your name, email, and password, then choose Create tenant account.");
    return;
  }
  try {
    const result = ensureDb(await supabaseClient.auth.signUp({ email, password, options: { data: { full_name: fullName }, emailRedirectTo: window.location.origin + window.location.pathname } }));
    if (result.session) await supabaseClient.auth.signOut();
    if (!result.session) alert("Account created. Check your email to confirm it, then sign in. Ask the landlord to assign your unit.");
    else alert("Account created. Ask the landlord to assign your unit, then sign in.");
  } catch (error) {
    alert(error.message || "Could not create the account.");
  }
}
async function logout() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  currentTenant = null;
  tenants = []; payments = []; issues = []; units = []; documents = []; feedbackEntries = []; notifications = []; auditEntries = [];
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
    if (unit.isActive === false) return false;
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
      '</td><td>' + escapeHtml(tenant.email || "") + '</td><td><span class="status-badge ' +
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
    row.innerHTML = "<td>" + escapeHtml(payment.submissionId) + "</td><td>" + escapeHtml(payment.tenantName) +
      '</td><td class="money">PHP ' + Number(payment.amount).toLocaleString() + "</td><td>" +
      escapeHtml(payment.period ? payment.period.slice(0, 7) : "—") + "</td><td>" + escapeHtml(payment.date || "—") + "</td><td>" + escapeHtml(payment.method) +
      '</td><td>' + (payment.proofUrl ? '<a class="btn btn-outline btn-sm" href="' + escapeHtml(payment.proofUrl) + '" target="_blank" rel="noopener">View proof</a>' : "—") +
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
  adminRow.innerHTML = "<td>" + escapeHtml(adminName) + '</td><td>' + escapeHtml(currentProfile ? currentProfile.email : "") + '</td><td><span class="role-badge">Landlord / Admin</span></td><td>All units</td><td><span class="status-badge status-completed">Active</span></td>';
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
function fillTenantProfileOptions(selectedId) {
  const select = document.getElementById("reg-profile");
  if (!select) return;
  const activeTenantIds = new Set(tenants.filter(function (t) { return t.status === "Active"; }).map(function (t) { return t.id; }));
  const availableProfiles = allProfiles.filter(function (p) { return p.role === "tenant" && (!activeTenantIds.has(p.id) || p.id === selectedId); });
  select.innerHTML = '<option value="">Choose a registered tenant account</option>' + availableProfiles.map(function (p) {
    return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml((p.full_name || p.email) + " · " + p.email) + "</option>";
  }).join("");
  if (selectedId) select.value = selectedId;
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
async function submitFeedback(event, role) {
  event.preventDefault();
  if (role === "tenant" && !currentTenant) return;
  const issueId = document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue").value;
  const issue = issues.find(function (record) { return record.id === issueId; });
  const text = document.getElementById(role === "admin" ? "admin-feedback-text" : "tenant-feedback-text").value.trim();
  if (!issue || !text || (role === "tenant" && issue.tenantId !== currentTenant.id)) return;
  try { ensureDb(await supabaseClient.from("feedback").insert({ tenant_id: issue.tenantId, issue_id: issue.id, author_id: currentUser.id, message: text })); }
  catch (error) { alert(error.message || "Could not add the comment."); return; }
  await loadCloudData();
  document.getElementById(role === "admin" ? "form-admin-feedback" : "form-tenant-feedback").reset();
  renderFeedbackControls();
  document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue").value = issue.id;
  renderFeedbackThread(role);
  saveAudit("Maintenance comment added", "Comment added to request " + issue.id + ".");
  if (role === "admin") addNotification(issue.tenantId, "The landlord added a comment to maintenance request " + issue.id + ".");
  else addNotification(null, currentProfile.full_name + " commented on a maintenance request.");
}
async function markNotificationRead(id, role) {
  const notification = notifications.find(function (record) { return record.id === id; });
  if (!notification) return;
  const readerId = currentUser && currentUser.id;
  if (!readerId || (role === "tenant" && notification.tenantId !== readerId)) return;
  if ((notification.readBy || []).indexOf(readerId) !== -1) return;
  try { ensureDb(await supabaseClient.from("notification_reads").insert({ notification_id: id, user_id: readerId })); }
  catch (error) { alert(error.message || "Could not mark this notification read."); return; }
  await loadCloudData();
  renderNotifications();
  saveAudit("Notification marked read", notification.id + " marked read by " + (role === "admin" ? adminName : actorName()) + ".");
}
function renderNotifications() {
  const adminList = document.getElementById("admin-notification-list");
  adminList.innerHTML = "";
  notifications.forEach(function (notification) {
    const tenant = tenantFor(notification.tenantId);
    const audience = tenant ? "Tenant: " + tenant.firstName + " " + tenant.lastName : "Admin";
    const isRead = (notification.readBy || []).indexOf(currentUser && currentUser.id) !== -1;
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
  fillTenantProfileOptions();
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

async function registerTenant(event) {
  event.preventDefault();
  if (!currentProfile || currentProfile.role !== "admin") return;
  const unitName = document.getElementById("reg-unit").value;
  const unit = units.find(function (candidate) { return candidate.name === unitName; });
  const editingId = document.getElementById("reg-tenant-id").value;
  const profileId = document.getElementById("reg-profile").value;
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
  const dueDay = Math.min(28, Number(document.getElementById("reg-dueday").value) || 5);
  const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ");
  try {
    const targetId = editingId || profileId;
    if (!targetId) throw new Error("Choose a tenant who has created a portal account first.");
    ensureDb(await supabaseClient.from("profiles").update({ full_name: fullName }).eq("id", targetId));
    if (editingId) {
      const tenant = tenantFor(editingId);
      ensureDb(await supabaseClient.from("tenancies").update({ unit_id: unit.id, monthly_rent: rent, due_day: dueDay }).eq("id", tenant.tenancyId));
    } else {
      ensureDb(await supabaseClient.from("tenancies").insert({ tenant_id: targetId, unit_id: unit.id, monthly_rent: rent, due_day: dueDay }));
    }
    await loadCloudData();
    cancelTenantEdit();
    renderAdminDashboard();
    saveAudit(editingId ? "Tenant updated" : "Tenant registered", fullName + " assigned to " + unit.name + ".");
    if (!editingId) addNotification(targetId, "Welcome to the rental portal. Your assigned unit is " + unit.name + ".");
  } catch (error) { alert(error.message || "Could not save the tenant record."); }
}
function editTenant(id) {
  const tenant = tenantFor(id);
  if (!tenant || tenant.status !== "Active") return;
  document.getElementById("reg-tenant-id").value = tenant.id;
  fillTenantProfileOptions(tenant.id);
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
  document.getElementById("tenant-form-submit").innerText = "Assign Tenant & Unit";
  document.getElementById("tenant-form-cancel").style.display = "none";
  fillTenantProfileOptions();
  fillUnitOptions();
}
async function registerUnit(event) {
  event.preventDefault();
  const name = document.getElementById("unit-name").value.trim();
  const rent = Number(document.getElementById("unit-rent").value);
  const editingId = document.getElementById("edit-unit-id").value;
  if (units.some(function (unit) { return unit.id !== editingId && unit.name.toLowerCase() === name.toLowerCase(); })) {
    alert("A unit with that name already exists.");
    return;
  }
  try {
    if (editingId) ensureDb(await supabaseClient.from("units").update({ name: name, monthly_rent: rent }).eq("id", editingId));
    else ensureDb(await supabaseClient.from("units").insert({ name: name, monthly_rent: rent }));
    await loadCloudData();
    renderAdminDashboard();
    cancelUnitEdit();
    saveAudit(editingId ? "Unit updated" : "Unit added", name + " saved at PHP " + rent.toLocaleString() + ".");
  } catch (error) { alert(error.message || "Could not save the unit."); }
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
async function deleteUnit(id) {
  const unit = units.find(function (record) { return record.id === id; });
  if (!unit) return;
  if (tenants.some(function (tenant) { return tenant.unit === unit.name; })) {
    alert("This unit has tenancy history and cannot be deleted. Keep it to preserve the rental record.");
    return;
  }
  if (!confirm("Delete vacant unit " + unit.name + "?")) return;
  try {
    ensureDb(await supabaseClient.from("units").delete().eq("id", id));
    await loadCloudData();
    cancelUnitEdit();
    renderAdminDashboard();
    saveAudit("Unit deleted", unit.name + " was removed from the inventory.");
  } catch (error) { alert("Could not delete the unit. Units with tenancy history are retained."); }
}
async function deactivateTenant(id) {
  const tenant = tenantFor(id);
  if (!tenant || !confirm("End the tenancy for " + tenant.firstName + " " + tenant.lastName + "? Historical records will be kept.")) return;
  try {
    ensureDb(await supabaseClient.from("tenancies").update({ end_date: new Date().toISOString().slice(0, 10) }).eq("id", tenant.tenancyId));
    await loadCloudData();
    renderAdminDashboard();
    saveAudit("Tenancy ended", tenant.firstName + " " + tenant.lastName + " vacated " + tenant.unit + ".");
    addNotification(tenant.id, "Your tenancy has been marked inactive. Contact the landlord if this is unexpected.");
  } catch (error) { alert(error.message || "Could not end the tenancy."); }
}
async function reviewPayment(id, status) {
  const payment = payments.find(function (record) { return record.id === id; });
  if (!payment || payment.status !== "Pending" || (status !== "Approved" && status !== "Rejected")) return;
  try { ensureDb(await supabaseClient.from("payments").update({ status: status, reviewed_by: currentUser.id, reviewed_at: new Date().toISOString() }).eq("id", id)); }
  catch (error) { alert(error.message || "Could not review payment."); return; }
  await loadCloudData();
  renderAdminDashboard();
  saveAudit("Payment " + status.toLowerCase(), payment.id + " for PHP " + Number(payment.amount).toLocaleString() + ".");
  addNotification(payment.tenantId, "Your payment " + payment.id + " was " + status.toLowerCase() + ".");
}
async function updateIssueStatus(id, status) {
  const issue = issues.find(function (record) { return record.id === id; });
  if (!issue || ["Pending", "In Progress", "Completed"].indexOf(status) === -1) return;
  try { ensureDb(await supabaseClient.from("maintenance_requests").update({ status: status }).eq("id", id)); }
  catch (error) { alert(error.message || "Could not update the request."); return; }
  await loadCloudData();
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
  document.getElementById("pay-amount").value = Number(currentTenant.rent);
  const periodInput = document.getElementById("pay-period");
  if (!periodInput.value) {
    const now = new Date();
    periodInput.value = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  }
  const paymentsBody = document.getElementById("table-tenant-payments");
  paymentsBody.innerHTML = "";
  payments.filter(function (payment) { return payment.tenantId === currentTenant.id; }).slice().reverse().forEach(function (payment) {
    const row = document.createElement("tr");
    row.innerHTML = "<td>" + escapeHtml(payment.date || "—") + "</td><td>PHP " + Number(payment.amount).toLocaleString() +
      "</td><td>" + escapeHtml(payment.method) + "</td><td>" + escapeHtml(payment.submissionId) +
      '</td><td>' + (payment.proofUrl ? '<a class="btn btn-outline btn-sm" href="' + escapeHtml(payment.proofUrl) + '" target="_blank" rel="noopener">View proof</a>' : "—") +
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

async function submitTenantPayment(event) {
  event.preventDefault();
  if (!currentTenant) return;
  const amount = Number(currentTenant.rent);
  const period = document.getElementById("pay-period").value;
  const method = document.getElementById("pay-method").value;
  const fileInput = document.getElementById("pay-proof");
  const file = fileInput.files && fileInput.files[0];
  const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
  if (!Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}$/.test(period) || !file) {
    alert("Choose the rent month and attach payment proof.");
    return;
  }
  if (payments.some(function (payment) { return payment.tenantId === currentUser.id && payment.status !== "Rejected" && payment.period && payment.period.slice(0, 7) === period; })) {
    alert("A payment submission already exists for this rent month.");
    return;
  }
  if (!allowedTypes.includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024) {
    alert("Payment proof must be a PDF, JPG, or PNG file no larger than 10 MB.");
    return;
  }
  const extension = file.type === "application/pdf" ? "pdf" : (file.type === "image/png" ? "png" : "jpg");
  const storagePath = currentUser.id + "/payment-proofs/" + crypto.randomUUID() + "." + extension;
  let proofUploaded = false;
  let submissionId;
  try {
    ensureDb(await supabaseClient.storage.from("rental-documents").upload(storagePath, file, { contentType: file.type, upsert: false }));
    proofUploaded = true;
    const inserted = ensureDb(await supabaseClient.from("payments").insert({
      tenant_id: currentUser.id,
      amount: amount,
      billing_period: period + "-01",
      method: method,
      proof_storage_path: storagePath,
      proof_file_name: file.name,
      proof_content_type: file.type,
      proof_file_size: file.size
    }).select("id,submission_id").single());
    submissionId = inserted.submission_id;
  } catch (error) {
    if (proofUploaded) await supabaseClient.storage.from("rental-documents").remove([storagePath]);
    if (error.code === "23505") alert("A payment submission already exists for this rent month.");
    else alert(error.message || "Could not submit payment.");
    return;
  }
  document.getElementById("form-tenant-payment").reset();
  await loadCloudData();
  renderTenantDashboard();
  saveAudit("Payment submitted", submissionId + " submitted for landlord review.");
  addNotification(null, currentProfile.full_name + " submitted a payment for review.");
  alert("Payment submitted for review. Your tracking ID is " + submissionId + ". It remains pending until the landlord reviews it.");
}
async function submitTenantIssue(event) {
  event.preventDefault();
  if (!currentTenant) return;
  const category = document.getElementById("issue-category").value;
  const description = document.getElementById("issue-desc").value.trim();
  if (!description) return;
  let issueId;
  try {
    const inserted = ensureDb(await supabaseClient.from("maintenance_requests").insert({ tenant_id: currentUser.id, category: category, description: description }).select("id").single());
    issueId = inserted.id;
  } catch (error) { alert(error.message || "Could not submit the request."); return; }
  await loadCloudData();
  renderTenantDashboard();
  document.getElementById("form-tenant-issue").reset();
  saveAudit("Maintenance request submitted", issueId + " (" + category + ") submitted.");
  addNotification(null, currentProfile.full_name + " submitted a maintenance request.");
  alert("Maintenance request sent to the landlord.");
}

async function submitTenantDocument(event) {
  event.preventDefault();
  if (!currentTenant) return;
  const fileInput = document.getElementById("document-file");
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const uploadingTenant = currentTenant;
  const title = document.getElementById("document-title").value.trim();
  const type = document.getElementById("document-type").value;
  if (["application/pdf", "image/jpeg", "image/png"].indexOf(file.type) === -1) {
    alert("Choose a PDF, JPG, or PNG file.");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    alert("Files must be 10 MB or smaller.");
    return;
  }
  const version = documents.filter(function (record) { return record.tenantId === uploadingTenant.id && record.type === type && record.title.toLowerCase() === title.toLowerCase(); })
    .reduce(function (maximum, record) { return Math.max(maximum, Number(record.version) || 1); }, 0) + 1;
  const storagePath = currentUser.id + "/" + crypto.randomUUID() + "/" + file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  try {
    ensureDb(await supabaseClient.storage.from("rental-documents").upload(storagePath, file, { contentType: file.type || "application/octet-stream", upsert: false }));
    ensureDb(await supabaseClient.from("documents").insert({ tenant_id: currentUser.id, title: title, category: type, storage_path: storagePath, file_name: file.name, content_type: file.type || "application/octet-stream", file_size: file.size, version: version }));
    await loadCloudData();
    renderDocuments();
    document.getElementById("form-tenant-document").reset();
    saveAudit("Document uploaded", file.name + " uploaded by " + uploadingTenant.firstName + " " + uploadingTenant.lastName + ".");
    addNotification(null, uploadingTenant.firstName + " " + uploadingTenant.lastName + " uploaded a document.");
    alert("Document uploaded securely.");
  } catch (error) { alert(error.message || "Could not upload the document."); }
}

document.addEventListener("DOMContentLoaded", async function () {
  document.getElementById("reg-unit").addEventListener("change", function () {
    const option = this.options[this.selectedIndex];
    if (option && option.dataset.rent) document.getElementById("reg-rent").value = option.dataset.rent;
  });
  if (!window.supabaseClient) {
    alert("Supabase failed to load. Check your network connection and reload the page.");
    return;
  }
  try {
    const sessionData = ensureDb(await supabaseClient.auth.getSession());
    if (!sessionData.session) return;
    currentUser = sessionData.session.user;
    currentProfile = ensureDb(await supabaseClient.from("profiles").select("id,email,full_name,role").eq("id", currentUser.id).single());
    adminName = currentProfile.full_name || currentProfile.email;
    await loadCloudData();
    if (currentProfile.role === "admin") {
      showView("view-admin", "ADMIN PORTAL");
      renderAdminDashboard();
    } else if (currentProfile.role === "tenant" && currentTenant) {
      showView("view-tenant", "TENANT PORTAL");
      renderTenantDashboard();
    } else {
      await supabaseClient.auth.signOut();
      currentUser = null;
      currentProfile = null;
      alert("Your tenant account is active, but no unit has been assigned yet.");
    }
  } catch (error) {
    console.error("Could not restore Supabase session", error);
    alert("Could not load your rental account. Please sign out and try again.");
  }
});
