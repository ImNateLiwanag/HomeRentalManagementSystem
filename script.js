let tenants = [];
let payments = [];
let issues = [];
let units = [];
let documents = [];
let stayRequests = [];
let feedbackEntries = [];
let notifications = [];
let auditEntries = [];
const feedbackReplyTargets = { admin: null, tenant: null };
let currentTenant = null;
let currentUser = null;
let currentProfile = null;
let allProfiles = [];
let adminName = "Landlord";
let portalEntryTimer = null;

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
    supabaseClient.from("feedback").select("id,tenant_id,issue_id,author_id,parent_id,message,created_at"),
    supabaseClient.from("notifications").select("id,tenant_id,message,created_at"),
    supabaseClient.from("audit_logs").select("id,actor_id,action,details,created_at").order("created_at", { ascending: false }).limit(500),
    supabaseClient.from("stay_requests").select("id,tenant_id,start_date,end_date,stay_days,monthly_rent,billable_months,estimated_amount,status,reviewed_by,reviewed_at,created_at").order("created_at", { ascending: false })
  ]);
  const [profileRows, unitRows, tenancyRows, paymentRows, issueRows, documentRows, feedbackRows, notificationRows, auditRows, stayRows] = result.map(ensureDb);
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
  issues = issueRows.map(function (i) { const t = tenantById.get(i.tenant_id); return { id: i.id, tenantId: i.tenant_id, tenantName: t ? t.firstName + " " + t.lastName : "Tenant", category: i.category, description: i.description, date: i.created_at.slice(0, 10), createdAt: i.created_at, status: i.status }; });
  const readRows = ensureDb(await supabaseClient.from("notification_reads").select("notification_id,user_id"));
  const readsByNotification = new Map();
  readRows.forEach(function (r) { if (!readsByNotification.has(r.notification_id)) readsByNotification.set(r.notification_id, []); readsByNotification.get(r.notification_id).push(r.user_id); });
  notifications = notificationRows.map(function (n) { return { id: n.id, tenantId: n.tenant_id, message: n.message, time: n.created_at, readBy: readsByNotification.get(n.id) || [] }; });
  documents = await Promise.all(documentRows.map(async function (d) {
    const tenant = tenantById.get(d.tenant_id);
    const signed = await supabaseClient.storage.from("rental-documents").createSignedUrl(d.storage_path, 3600);
    return { id: d.id, tenantId: d.tenant_id, tenantName: tenant ? tenant.firstName + " " + tenant.lastName : "Tenant", title: d.title, type: d.category, name: d.file_name, mimeType: d.content_type, size: d.file_size, version: d.version, date: d.created_at.slice(0, 10), storagePath: d.storage_path, dataUrl: signed.data ? signed.data.signedUrl : "#" };
  }));
  feedbackEntries = feedbackRows.map(function (f) { const author = byId.get(f.author_id); const isAdminAuthor = author ? author.role === "admin" : f.author_id !== currentUser.id; return { id: f.id, tenantId: f.tenant_id, issueId: f.issue_id, parentId: f.parent_id, author: author ? author.full_name : (isAdminAuthor ? "Landlord / Admin" : "Tenant"), role: isAdminAuthor ? "Landlord / Admin" : "Tenant", text: f.message, createdAt: f.created_at }; });
  auditEntries = auditRows.map(function (a) { const actor = byId.get(a.actor_id); return { id: a.id, actor: actor ? actor.full_name : "System", action: a.action, details: a.details, time: a.created_at }; });
  stayRequests = stayRows.map(function (s) { const tenant = tenantById.get(s.tenant_id); return { id: s.id, tenantId: s.tenant_id, tenantName: tenant ? tenant.firstName + " " + tenant.lastName : "Tenant", startDate: s.start_date, endDate: s.end_date, days: Number(s.stay_days), monthlyRent: Number(s.monthly_rent), billableMonths: Number(s.billable_months), estimatedAmount: Number(s.estimated_amount), status: s.status, createdAt: s.created_at }; });
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
  if (!currentUser || !currentProfile || currentProfile.role !== "admin") return;
  supabaseClient.from("audit_logs").insert({ actor_id: currentUser.id, action: action, details: details || "" })
    .then(function (result) { if (result.error) throw result.error; return supabaseClient.from("audit_logs").select("id,actor_id,action,details,created_at").order("created_at", { ascending: false }).limit(500); })
    .then(function (result) { auditEntries = ensureDb(result).map(function (a) { return { id: a.id, actor: currentProfile.full_name || currentProfile.email, action: a.action, details: a.details, time: a.created_at }; }); renderAuditLog(); })
    .catch(function (error) { console.error("Could not save audit entry", error); });
}

function addNotification(tenantId, message) {
  if (!currentUser || !currentProfile || currentProfile.role !== "admin") return;
  supabaseClient.from("notifications").insert({ tenant_id: tenantId || null, created_by: currentUser.id, message: message })
    .then(function (result) { if (result.error) throw result.error; return loadCloudData(); })
    .catch(function (error) { console.error("Could not create notification", error); });
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modalId === "tenant-modal") {
    document.getElementById("tenant-email").value = "";
    document.getElementById("tenant-password").value = "";
  }
  modal.classList.add("active");
  const firstField = Array.from(modal.querySelectorAll("input:not([type=hidden])"))
    .find(function (input) { return !input.closest("[hidden]"); });
  if (firstField) window.setTimeout(function () { firstField.focus(); }, 0);
}
function closeModal(modalId) {
  if (modalId === "tenant-modal") {
    document.getElementById("tenant-email").value = "";
    document.getElementById("tenant-password").value = "";
  }
  document.getElementById(modalId).classList.remove("active");
}
function openPortalEntry(modalId) {
  const portalView = document.getElementById("view-portal");
  // Once the doors have opened, reopening either sign-in dialog should not replay them.
  if (portalView.dataset.doorOpened === "true") {
    openModal(modalId);
    return;
  }
  if (portalEntryTimer) window.clearTimeout(portalEntryTimer);
  portalView.classList.remove("is-open");
  portalView.classList.add("is-opening");
  portalEntryTimer = window.setTimeout(function () {
    portalView.classList.remove("is-opening");
    portalView.classList.add("is-open");
    portalView.dataset.doorOpened = "true";
    openModal(modalId);
    portalEntryTimer = null;
  }, window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 720);
}
function openPortalSelection() {
  document.querySelectorAll(".view").forEach(function (view) { view.classList.remove("active"); });
  const portalView = document.getElementById("view-portal");
  portalView.classList.add("active");
  portalView.classList.remove("is-open", "is-opening");
  portalView.dataset.doorOpened = "false";
  syncPortalShell();
}
function syncPortalShell() {
  const activeView = document.querySelector(".view.active");
  const isPortalHome = !activeView || activeView.id === "view-portal";
  document.body.classList.toggle("portal-home", isPortalHome);
  document.getElementById("switch-portal-btn").style.display = isPortalHome ? "none" : "inline-block";
}
function showView(viewId, badge) {
  document.querySelectorAll(".view").forEach(function (view) { view.classList.remove("active"); });
  document.getElementById(viewId).classList.add("active");
  syncPortalShell();
}

// A page restored from the browser's back-forward cache can keep stale body
// classes and inline button styles even though its active view is unchanged.
window.addEventListener("pageshow", syncPortalShell);
document.addEventListener("keydown", function (event) {
  if (event.key !== "Escape") return;
  const activeModal = document.querySelector(".modal-overlay.active");
  if (activeModal) closeModal(activeModal.id);
});

async function loginAdmin(event) {
  event.preventDefault();
  await authenticate("admin", document.getElementById("admin-email").value, document.getElementById("admin-password").value);
}
async function loginTenant(event) {
  event.preventDefault();
  const isSignup = document.getElementById("tenant-modal").dataset.mode === "signup";
  if (isSignup) {
    await registerTenantAccount();
    return;
  }
  await authenticate("tenant", document.getElementById("tenant-email").value, document.getElementById("tenant-password").value);
}
function toggleTenantSignup(mode) {
  const modal = document.getElementById("tenant-modal");
  const nextMode = mode || (modal.dataset.mode === "signup" ? "login" : "signup");
  const isSignup = nextMode === "signup";
  modal.dataset.mode = nextMode;
  const nameField = modal.querySelector(".tenant-signup-field");
  const nameInput = document.getElementById("tenant-signup-name");
  nameField.hidden = !isSignup;
  nameInput.required = isSignup;
  document.getElementById("tenant-login-title").textContent = isSignup ? "Create your resident account" : "Your home, at a glance";
  document.getElementById("tenant-password").autocomplete = isSignup ? "new-password" : "current-password";
  document.getElementById("tenant-submit-btn").textContent = isSignup ? "Create account" : "Sign in to resident portal";
  document.getElementById("tenant-mode-toggle").textContent = isSignup ? "Already have an account? Sign in" : "New resident? Create an account";
}
async function authenticate(expectedRole, email, password) {
  try {
    const auth = ensureDb(await supabaseClient.auth.signInWithPassword({ email: email.trim(), password }));
    currentUser = auth.user;
    currentProfile = ensureDb(await supabaseClient.from("profiles").select("id,email,full_name,role").eq("id", currentUser.id).single());
    if (currentProfile.role !== expectedRole) {
      await supabaseClient.auth.signOut({ scope: "local" });
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
        await supabaseClient.auth.signOut({ scope: "local" });
        currentUser = null;
        currentProfile = null;
        throw new Error("Your account is active, but the landlord has not assigned an active unit yet.");
      }
      showView("view-tenant", "TENANT PORTAL");
      renderTenantDashboard();
    }
    saveAudit("Login", currentProfile.full_name + " signed in.");
  } catch (error) {
    if (expectedRole === "tenant") document.getElementById("tenant-password").value = "";
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
    if (result.session) await supabaseClient.auth.signOut({ scope: "local" });
    document.getElementById("tenant-password").value = "";
    toggleTenantSignup("login");
    if (!result.session) alert("Account created. Check your email to confirm it, then sign in. Ask the landlord to assign your unit.");
    else alert("Account created. Ask the landlord to assign your unit, then sign in.");
  } catch (error) {
    alert(error.message || "Could not create the account.");
  }
}
async function logout() {
  document.getElementById("tenant-email").value = "";
  document.getElementById("tenant-password").value = "";
  try {
    ensureDb(await supabaseClient.auth.signOut({ scope: "local" }));
  } catch (error) {
    alert(error.message || "Could not sign out. Please try again.");
    return;
  }
  currentUser = null;
  currentProfile = null;
  currentTenant = null;
  tenants = []; payments = []; issues = []; units = []; documents = []; feedbackEntries = []; notifications = []; auditEntries = []; stayRequests = [];
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
  if (status === "Rejected" || status === "Declined" || status === "Inactive" || status === "Vacant") return "status-unpaid";
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
  if (!available.length) select.innerHTML = '<option value="">No vacant rooms available</option>';
  const selected = select.options[select.selectedIndex];
  if (selected && selected.dataset.rent) document.getElementById("reg-rent").value = selected.dataset.rent;
}

function renderUnits() {
  const body = document.getElementById("table-admin-units");
  body.innerHTML = "";
  const floors = [
    { label: "1st Floor", min: 1, max: 10 },
    { label: "2nd Floor", min: 11, max: 25 },
    { label: "3rd Floor", min: 26, max: 40 }
  ];
  floors.forEach(function (floor) {
    const floorUnits = units.filter(function (unit) {
      const number = Number(String(unit.name).match(/^Room (\d+)$/)?.[1]);
      return number >= floor.min && number <= floor.max;
    }).sort(function (a, b) {
      return Number(a.name.match(/^Room (\d+)$/)[1]) - Number(b.name.match(/^Room (\d+)$/)[1]);
    });
    const heading = document.createElement("tr");
    heading.className = "unit-floor-heading";
    heading.innerHTML = '<th colspan="5">' + floor.label + ' <span>Rooms ' + floor.min + '–' + floor.max + '</span></th>';
    body.appendChild(heading);
    floorUnits.forEach(function (unit) {
      const occupant = tenants.find(function (tenant) { return tenant.status === "Active" && tenant.unit === unit.name; });
      const unitActions = occupant
        ? '<button class="btn btn-outline btn-sm" disabled title="Room rate is locked while occupied">Rate locked</button>'
        : '<button class="btn btn-outline btn-sm" onclick="editUnit(\'' + escapeHtml(unit.id) + '\')">Edit rate</button>';
      const row = document.createElement("tr");
      row.innerHTML = "<td>" + escapeHtml(unit.name) + "</td><td>PHP " + Number(unit.rent).toLocaleString() +
        '</td><td><span class="status-badge ' + statusClass(occupant ? "Occupied" : "Vacant") + '">' +
        (occupant ? "Occupied" : "Vacant") + "</span></td><td>" +
        (occupant ? escapeHtml(occupant.firstName + " " + occupant.lastName) : "—") + "</td><td>" + unitActions + "</td>";
      body.appendChild(row);
    });
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
    const viewLink = documentRecord.dataUrl && documentRecord.dataUrl !== "#"
      ? '<a class="btn btn-outline btn-sm document-icon-button" href="' + escapeHtml(documentRecord.dataUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="View ' + escapeHtml(documentRecord.name) + '" title="View document"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg></a>'
      : '<span class="subtitle">Unavailable</span>';
    row.innerHTML = "<td>" + escapeHtml(documentRecord.date) + "</td><td>" +
      escapeHtml(documentRecord.tenantName) + "</td><td>" + escapeHtml(documentRecord.title || documentRecord.name) +
      "</td><td>v" + Number(documentRecord.version || 1) + "</td><td>" + escapeHtml(documentRecord.type) + "</td><td>" + viewLink + "</td>";
    adminBody.appendChild(row);
  });
  const tenantList = document.getElementById("tenant-document-list");
  tenantList.innerHTML = "";
  if (!currentTenant) return;
  documents.filter(function (record) { return record.tenantId === currentTenant.id; }).forEach(function (record) {
    const item = document.createElement("li");
    const viewLink = record.dataUrl && record.dataUrl !== "#"
      ? '<a class="btn btn-outline btn-sm document-icon-button" href="' + escapeHtml(record.dataUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="View ' + escapeHtml(record.name) + '" title="View document"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg></a>'
      : '<span class="subtitle">Unavailable</span>';
    item.innerHTML = '<span><strong>' + escapeHtml(record.title || record.type) + " · v" + Number(record.version || 1) +
      "</strong><br>" + escapeHtml(record.name) + " · " + escapeHtml(record.date) +
      '</span><span class="document-actions">' + viewLink + '<button type="button" class="btn btn-outline btn-sm document-icon-button document-delete-button" onclick="deleteTenantDocument(\'' + escapeHtml(record.id) + '\')" aria-label="Delete ' + escapeHtml(record.name) + '" title="Delete document"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 14h12l1-14M9 7V4h6v3"></path></svg></button></span>';
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
  const allIssues = issues.slice().sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); });
  const tenantIssues = currentTenant ? allIssues.filter(function (issue) { return issue.tenantId === currentTenant.id && !isMaintenanceResolved(issue); }) : [];
  function setOptions(select, records, emptyLabel) {
    const previous = select.value;
    select.innerHTML = records.map(function (issue) {
      const tenant = tenantFor(issue.tenantId);
      const owner = tenant ? tenant.firstName + " " + tenant.lastName : issue.tenantName;
      const detail = String(issue.description || "").replace(/\s+/g, " ").trim().slice(0, 72);
      const label = [issue.id.slice(0, 8), owner, issue.category, issue.date, issue.status, detail].filter(Boolean).join(" · ");
      return '<option value="' + escapeHtml(issue.id) + '">' + escapeHtml(label) + "</option>";
    }).join("");
    if (!records.length) select.innerHTML = '<option value="">' + escapeHtml(emptyLabel) + "</option>";
    if (records.some(function (issue) { return issue.id === previous; })) select.value = previous;
  }
  setOptions(adminSelect, allIssues, "No maintenance requests yet");
  setOptions(tenantSelect, tenantIssues, "You have no open maintenance requests");
  updateFeedbackComposer("admin");
  updateFeedbackComposer("tenant");
}
function isMaintenanceResolved(issue) {
  return !issue || ["completed", "resolved", "closed"].includes(String(issue.status).toLowerCase());
}
function updateFeedbackComposer(role) {
  const select = document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue");
  const issue = select && issues.find(function (record) { return record.id === select.value; });
  const resolved = Boolean(issue && isMaintenanceResolved(issue));
  const unavailable = !issue;
  const textarea = document.getElementById(role + "-feedback-text");
  const submit = document.querySelector("#form-" + role + "-feedback [type=submit]");
  textarea.disabled = resolved || unavailable;
  submit.disabled = resolved || unavailable;
  textarea.placeholder = resolved ? "This request is resolved and read-only. Submit a new request if the issue happens again." :
    (unavailable ? "Submit a maintenance request before starting a conversation." :
      (role === "admin" ? "Add an update or ask a follow-up question..." : "Ask a question or add information..."));
}
function selectFeedbackIssue(role) {
  setFeedbackReply(role, null);
  updateFeedbackComposer(role);
  renderFeedbackThread(role);
}
function setFeedbackReply(role, entryId) {
  const select = document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue");
  const selectedIssue = select && issues.find(function (record) { return record.id === select.value; });
  if (entryId && isMaintenanceResolved(selectedIssue)) return;
  const target = entryId ? feedbackEntries.find(function (entry) { return entry.id === entryId; }) : null;
  if (entryId && (!target || target.issueId !== select.value)) return;
  feedbackReplyTargets[role] = target ? target.id : null;
  const context = document.getElementById(role + "-feedback-reply-context");
  context.hidden = !target;
  document.getElementById(role + "-feedback-reply-name").textContent = target ? target.author : "";
  document.getElementById(role + "-feedback-text").placeholder = target ? "Write a reply..." : (role === "admin" ? "Add an update or ask a follow-up question..." : "Ask a question or add information...");
  document.querySelector("#form-" + role + "-feedback [type=submit]").textContent = target ? "Send Reply" : (role === "admin" ? "Post Reply" : "Post Comment");
  if (target) document.getElementById(role + "-feedback-text").focus();
}
function cancelFeedbackReply(role) {
  setFeedbackReply(role, null);
}
function renderFeedbackThread(role) {
  const select = document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue");
  const list = document.getElementById(role === "admin" ? "admin-feedback-thread" : "tenant-feedback-thread");
  if (!select || !list) return;
  const issueId = select.value;
  const clearButton = document.getElementById(role + "-feedback-clear");
  const entries = feedbackEntries.filter(function (entry) { return entry.issueId === issueId; });
  if (clearButton) clearButton.disabled = !issueId || entries.length === 0;
  list.innerHTML = "";
  if (!issueId) {
    list.innerHTML = "<li>Select a maintenance request to view its conversation.</li>";
    return;
  }
  const entryById = new Map(entries.map(function (entry) { return [entry.id, entry]; }));
  const repliesByParent = new Map();
  const roots = [];
  entries.forEach(function (entry) {
    if (entry.parentId && entryById.has(entry.parentId)) {
      if (!repliesByParent.has(entry.parentId)) repliesByParent.set(entry.parentId, []);
      repliesByParent.get(entry.parentId).push(entry);
    } else roots.push(entry);
  });
  function chronological(a, b) { return Date.parse(a.createdAt) - Date.parse(b.createdAt); }
  roots.sort(chronological);
  repliesByParent.forEach(function (replies) { replies.sort(chronological); });
  function appendEntry(entry, depth) {
    const item = document.createElement("li");
    item.className = "feedback-entry" + (depth ? " feedback-entry-reply" : "");
    item.style.setProperty("--reply-depth", Math.min(depth, 4));
    item.innerHTML = '<div class="feedback-meta"><strong>' + escapeHtml(entry.author) +
      '</strong><span class="role-badge">' + escapeHtml(entry.role) + "</span><time>" +
      escapeHtml(new Date(entry.createdAt).toLocaleString()) + '</time></div><p>' + escapeHtml(entry.text) + "</p>";
    list.appendChild(item);
    const actions = document.createElement("div");
    actions.className = "feedback-entry-actions";
    const replyButton = document.createElement("button");
    replyButton.type = "button";
    replyButton.className = "btn btn-outline btn-sm feedback-reply-button";
    replyButton.textContent = "↩ Reply";
    const selectedIssue = issues.find(function (issue) { return issue.id === issueId; });
    replyButton.disabled = isMaintenanceResolved(selectedIssue);
    if (replyButton.disabled) replyButton.title = "Resolved requests are read-only.";
    replyButton.addEventListener("click", function () { setFeedbackReply(role, entry.id); });
    actions.appendChild(replyButton);
    item.appendChild(actions);
    (repliesByParent.get(entry.id) || []).forEach(function (reply) { appendEntry(reply, depth + 1); });
  }
  roots.forEach(function (entry) { appendEntry(entry, 0); });
  if (!list.children.length) list.innerHTML = "<li>No comments on this request yet.</li>";
}
async function submitFeedback(event, role) {
  event.preventDefault();
  if (role === "tenant" && !currentTenant) return;
  const issueId = document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue").value;
  const issue = issues.find(function (record) { return record.id === issueId; });
  const text = document.getElementById(role === "admin" ? "admin-feedback-text" : "tenant-feedback-text").value.trim();
  const parentId = feedbackReplyTargets[role];
  if (!issue || !text || (role === "tenant" && issue.tenantId !== currentTenant.id)) return;
  if (isMaintenanceResolved(issue)) {
    alert("This request is resolved. Submit a new maintenance request if the issue happens again.");
    return;
  }
  if (parentId && !feedbackEntries.some(function (entry) { return entry.id === parentId && entry.issueId === issue.id; })) {
    setFeedbackReply(role, null);
    alert("That comment is no longer available. Choose a message to reply to again.");
    return;
  }
  try { ensureDb(await supabaseClient.from("feedback").insert({ tenant_id: issue.tenantId, issue_id: issue.id, parent_id: parentId, author_id: currentUser.id, message: text })); }
  catch (error) { alert(error.message || "Could not add the comment."); return; }
  await loadCloudData();
  document.getElementById(role === "admin" ? "form-admin-feedback" : "form-tenant-feedback").reset();
  feedbackReplyTargets[role] = null;
  renderFeedbackControls();
  document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue").value = issue.id;
  setFeedbackReply(role, null);
  renderFeedbackThread(role);
  saveAudit("Maintenance comment added", "Comment added to request " + issue.id + ".");
  if (role === "admin") addNotification(issue.tenantId, "The landlord added a comment to maintenance request " + issue.id + ".");
}
async function clearFeedbackConversation(role) {
  if (!currentUser || (role === "tenant" && (!currentTenant || currentProfile.role !== "tenant")) || (role === "admin" && currentProfile.role !== "admin")) return;
  const select = document.getElementById(role === "admin" ? "admin-feedback-issue" : "tenant-feedback-issue");
  const issue = issues.find(function (record) { return record.id === select.value; });
  if (!issue || (role === "tenant" && issue.tenantId !== currentUser.id)) return;
  const messageCount = feedbackEntries.filter(function (entry) { return entry.issueId === issue.id; }).length;
  if (!messageCount) return;
  if (!window.confirm("Clear all " + messageCount + " message(s) for this maintenance request? This cannot be undone.")) return;
  try {
    const deleted = ensureDb(await supabaseClient.from("feedback").delete().eq("issue_id", issue.id).select("id"));
    if (!deleted || deleted.length === 0) {
      alert("No messages were cleared. You may not have permission to clear this conversation.");
      return;
    }
    await loadCloudData();
    feedbackReplyTargets[role] = null;
    renderFeedbackControls();
    select.value = issue.id;
    setFeedbackReply(role, null);
    renderFeedbackThread(role);
    if (role === "admin") saveAudit("Maintenance conversation cleared", "Conversation cleared for request " + issue.id + ".");
  } catch (error) {
    alert(error.message || "Could not clear this conversation.");
  }
}
async function deleteTenantDocument(id) {
  if (!currentUser || !currentTenant || currentProfile.role !== "tenant") return;
  const record = documents.find(function (documentRecord) { return documentRecord.id === id && documentRecord.tenantId === currentUser.id; });
  if (!record) return;
  if (!window.confirm("Do you want to delete \"" + (record.title || record.name) + "\"? This permanently deletes the file.")) return;
  let deletedRows;
  try {
    deletedRows = ensureDb(await supabaseClient.from("documents").delete().eq("id", record.id).eq("tenant_id", currentUser.id).select("*"));
    if (!deletedRows || deletedRows.length === 0) {
      alert("The document could not be deleted. Check that it belongs to your account.");
      return;
    }
  } catch (error) {
    alert(error.message || "Could not delete the document.");
    return;
  }
  const storageResult = await supabaseClient.storage.from("rental-documents").remove([record.storagePath]);
  if (storageResult.error) {
    try {
      ensureDb(await supabaseClient.from("documents").insert(deletedRows[0]));
      await loadCloudData();
      renderDocuments();
      alert("The file could not be removed, so its document record was restored. Please try again.");
    } catch (restoreError) {
      console.error("Could not restore document metadata after storage deletion failed", restoreError);
      await loadCloudData();
      renderDocuments();
      alert("The document record was deleted, but storage cleanup failed. Contact the property team to remove the remaining private file.");
    }
    return;
  }
  await loadCloudData();
  renderDocuments();
  saveAudit("Tenant document deleted", (record.title || record.name) + " was deleted by the tenant.");
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
  saveAudit("Notification marked read", notification.id + " marked read by the admin.");
}
function notificationIsInRange(time, range) {
  if (range === "all") return true;
  const timestamp = new Date(time);
  if (Number.isNaN(timestamp.getTime())) return false;
  const now = new Date();
  if (range === "30days") return timestamp >= new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "today") return timestamp >= today;
  if (range === "month") return timestamp >= new Date(now.getFullYear(), now.getMonth(), 1);
  if (range === "week") {
    const mondayOffset = (today.getDay() + 6) % 7;
    today.setDate(today.getDate() - mondayOffset);
    return timestamp >= today;
  }
  return true;
}
function notificationsForRange(role, records) {
  const select = document.getElementById(role + "-notification-range");
  const range = select ? select.value : "all";
  return records.filter(function (notification) { return notificationIsInRange(notification.time, range); })
    .slice().sort(function (a, b) { return Date.parse(b.time) - Date.parse(a.time); });
}
function renderNotifications() {
  const adminList = document.getElementById("admin-notification-list");
  adminList.innerHTML = "";
  notificationsForRange("admin", notifications).forEach(function (notification) {
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
  if (!adminList.children.length) adminList.innerHTML = "<li>No notifications in this time range.</li>";
  const tenantList = document.getElementById("tenant-notification-list");
  tenantList.innerHTML = "";
  if (!currentTenant) return;
  notificationsForRange("tenant", notifications.filter(function (notification) { return notification.tenantId === currentTenant.id; })).forEach(function (notification) {
    const isRead = (notification.readBy || []).indexOf(currentTenant.id) !== -1;
    const item = document.createElement("li");
    item.innerHTML = "<span>" + escapeHtml(notification.message) + "</span><time>" +
      escapeHtml(new Date(notification.time).toLocaleString()) + "</time>" +
      (isRead ? '<span class="read-label">Read</span>' : '<button class="btn btn-outline btn-sm" onclick="markNotificationRead(\'' + escapeHtml(notification.id) + '\', \'tenant\')">Mark read</button>');
    tenantList.appendChild(item);
  });
  if (!tenantList.children.length) tenantList.innerHTML = "<li>No notifications in this time range.</li>";
}
function calculateStayEstimate(startValue, endValue, monthlyRent) {
  const start = new Date(startValue + "T00:00:00Z");
  const end = new Date(endValue + "T00:00:00Z");
  const nights = Math.round((end.getTime() - start.getTime()) / 86400000);
  if (!Number.isFinite(nights) || nights < 1) return null;
  const billableMonths = Math.max(2, Math.ceil(nights / 15)) / 2;
  return { nights: nights, billableMonths: billableMonths, amount: Math.round(Number(monthlyRent) * billableMonths * 100) / 100 };
}
function updateStayEstimate() {
  const estimate = document.getElementById("stay-estimate");
  const startInput = document.getElementById("stay-start-date");
  const endInput = document.getElementById("stay-end-date");
  if (!estimate || !startInput || !endInput) return;
  const today = new Date();
  const todayValue = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  startInput.min = todayValue;
  if (startInput.value) {
    const nextDay = new Date(startInput.value + "T00:00:00Z");
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    endInput.min = nextDay.toISOString().slice(0, 10);
  } else endInput.min = todayValue;
  if (!startInput.value || !endInput.value) { estimate.textContent = "Choose both dates to see the rent estimate."; return; }
  const result = calculateStayEstimate(startInput.value, endInput.value, currentTenant && currentTenant.rent);
  if (!result) { estimate.textContent = "Departure must be after arrival."; return; }
  const fullMonths = Math.floor(result.nights / 30);
  const partialNights = result.nights % 30;
  const additionalMonths = partialNights ? Math.ceil(partialNights / 15) / 2 : 0;
  const partialMessage = !fullMonths ? " The first 30 days count as one full month." :
    (partialNights ? " The remaining " + partialNights + " night(s) count as " + additionalMonths.toFixed(1).replace(/\.0$/, "") + " additional month(s) under the 15-day billing rule." : "");
  estimate.textContent = result.nights + " nights · " + result.billableMonths.toFixed(1).replace(/\.0$/, "") + " billable month(s) · Estimated rent: PHP " + result.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "." + partialMessage + " The landlord must confirm availability.";
}
function renderStayRequests() {
  const adminBody = document.getElementById("table-admin-stays");
  if (adminBody) {
    adminBody.innerHTML = "";
    stayRequests.forEach(function (request) {
      const row = document.createElement("tr");
      const actions = request.status === "Pending" ? '<button class="btn btn-primary btn-sm" onclick="reviewStayRequest(\'' + escapeHtml(request.id) + '\', \'Approved\')">Approve plan</button> <button class="btn btn-outline btn-sm" onclick="reviewStayRequest(\'' + escapeHtml(request.id) + '\', \'Declined\')">Decline</button>' : "—";
      row.innerHTML = "<td>" + escapeHtml(request.tenantName) + "</td><td>" + escapeHtml(request.startDate) + " – " + escapeHtml(request.endDate) + "</td><td>" + request.days + "</td><td>" + request.billableMonths.toFixed(1).replace(/\.0$/, "") + "</td><td>PHP " + request.estimatedAmount.toLocaleString() + '</td><td><span class="status-badge ' + statusClass(request.status) + '">' + escapeHtml(request.status) + "</span></td><td>" + actions + "</td>";
      adminBody.appendChild(row);
    });
    if (!adminBody.children.length) adminBody.innerHTML = '<tr><td colspan="7">No stay plans have been submitted.</td></tr>';
  }
  const tenantBody = document.getElementById("table-tenant-stays");
  if (tenantBody) {
    tenantBody.innerHTML = "";
    stayRequests.filter(function (request) { return currentTenant && request.tenantId === currentTenant.id; }).forEach(function (request) {
      const row = document.createElement("tr");
      row.innerHTML = "<td>" + escapeHtml(new Date(request.createdAt).toLocaleDateString()) + "</td><td>" + escapeHtml(request.startDate) + " – " + escapeHtml(request.endDate) + "</td><td>" + request.days + "</td><td>" + request.billableMonths.toFixed(1).replace(/\.0$/, "") + "</td><td>PHP " + request.estimatedAmount.toLocaleString() + '</td><td><span class="status-badge ' + statusClass(request.status) + '">' + escapeHtml(request.status) + "</span></td>";
      tenantBody.appendChild(row);
    });
    if (!tenantBody.children.length) tenantBody.innerHTML = '<tr><td colspan="6">No stay plans submitted yet.</td></tr>';
  }
  updateStayEstimate();
}
async function submitStayRequest(event) {
  event.preventDefault();
  if (!currentTenant || !currentUser || currentProfile.role !== "tenant") return;
  const startDate = document.getElementById("stay-start-date").value;
  const endDate = document.getElementById("stay-end-date").value;
  const estimate = calculateStayEstimate(startDate, endDate, currentTenant.rent);
  const today = new Date();
  const todayValue = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  if (!estimate || startDate < todayValue) { alert("Choose a valid future arrival date and a departure date after arrival."); return; }
  if (stayRequests.some(function (request) { return request.tenantId === currentTenant.id && request.status === "Pending" && request.startDate === startDate && request.endDate === endDate; })) {
    alert("This exact date range is already waiting for the landlord to review.");
    return;
  }
  const submitButton = document.querySelector("#form-stay-request [type=submit]");
  if (submitButton.disabled) return;
  submitButton.disabled = true;
  try {
    ensureDb(await supabaseClient.from("stay_requests").insert({ tenant_id: currentUser.id, start_date: startDate, end_date: endDate }).select("id").single());
    document.getElementById("form-stay-request").reset();
    try { await loadCloudData(); renderTenantDashboard(); }
    catch (refreshError) { console.error("Stay plan was submitted, but the dashboard did not refresh.", refreshError); }
    alert("Your stay plan was sent to the landlord. The estimate uses " + estimate.billableMonths.toFixed(1).replace(/\.0$/, "") + " billable month(s), including half-month billing for additional 15-day blocks. This is not a confirmed booking.");
  } catch (error) {
    if (error.code === "23505") alert("This date range is already waiting for the landlord to review.");
    else alert(error.message || "Could not send the stay plan.");
  } finally { submitButton.disabled = false; }
}
async function reviewStayRequest(id, status) {
  if (!currentProfile || currentProfile.role !== "admin" || !["Approved", "Declined"].includes(status)) return;
  const request = stayRequests.find(function (record) { return record.id === id; });
  if (!request || request.status !== "Pending") return;
  try { ensureDb(await supabaseClient.from("stay_requests").update({ status: status, reviewed_by: currentUser.id, reviewed_at: new Date().toISOString() }).eq("id", id)); }
  catch (error) { alert(error.message || "Could not review the stay plan."); return; }
  await loadCloudData();
  renderAdminDashboard();
  saveAudit("Stay plan " + status.toLowerCase(), request.tenantName + " · " + request.startDate + " to " + request.endDate + ".");
  addNotification(request.tenantId, "Your planned stay from " + request.startDate + " to " + request.endDate + " was " + status.toLowerCase() + ". Contact the landlord to confirm availability and terms.");
}
function renderAuditLog() {
  const body = document.getElementById("table-admin-audit");
  body.innerHTML = "";
  auditEntries.forEach(function (entry) {
    const details = entry.action === "Notification marked read"
      ? String(entry.details || "").replace(/marked read by .+$/i, "marked read by the admin.")
      : entry.details;
    const row = document.createElement("tr");
    row.innerHTML = "<td>" + escapeHtml(new Date(entry.time).toLocaleString()) + "</td><td>" +
      escapeHtml(entry.actor) + "</td><td>" + escapeHtml(entry.action) + "</td><td>" +
      escapeHtml(details) + "</td>";
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
  renderStayRequests();
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
  const editingId = document.getElementById("edit-unit-id").value;
  const unit = units.find(function (record) { return record.id === editingId; });
  const rent = Number(document.getElementById("unit-rent").value);
  if (!editingId || !unit) {
    alert("Choose a room from the inventory to edit its rate.");
    return;
  }
  if (tenants.some(function (tenant) { return tenant.status === "Active" && tenant.unit === unit.name; })) {
    alert("This room is occupied. Its rate cannot be changed until it becomes vacant.");
    return;
  }
  if (!Number.isFinite(rent) || rent <= 0) {
    alert("Enter a valid monthly room rate.");
    return;
  }
  try {
    ensureDb(await supabaseClient.from("units").update({ monthly_rent: rent }).eq("id", editingId));
    await loadCloudData();
    renderAdminDashboard();
    cancelUnitEdit();
    saveAudit("Room rate updated", unit.name + " set to PHP " + rent.toLocaleString() + ".");
  } catch (error) { alert(error.message || "Could not save the unit."); }
}
function editUnit(id) {
  const unit = units.find(function (record) { return record.id === id; });
  if (!unit) return;
  if (tenants.some(function (tenant) { return tenant.status === "Active" && tenant.unit === unit.name; })) {
    alert("This room is occupied. Its rate cannot be changed until it becomes vacant.");
    return;
  }
  document.getElementById("edit-unit-id").value = unit.id;
  document.getElementById("unit-name").value = unit.name;
  document.getElementById("unit-rent").value = unit.rent;
  document.getElementById("unit-form-heading").innerText = "Edit Vacant Room Rate";
  document.getElementById("unit-rate-editor").hidden = false;
  document.getElementById("form-register-unit").scrollIntoView({ behavior: "smooth", block: "center" });
}
function cancelUnitEdit() {
  document.getElementById("form-register-unit").reset();
  document.getElementById("edit-unit-id").value = "";
  document.getElementById("unit-rate-editor").hidden = true;
}
async function deleteUnit(id) {
  alert("The 40-room inventory is fixed. Rooms cannot be deleted.");
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
  renderStayRequests();
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
    alert("Document uploaded securely.");
  } catch (error) { alert(error.message || "Could not upload the document."); }
}

document.addEventListener("DOMContentLoaded", async function () {
  // Normalize the initial portal screen before waiting for Supabase Auth.
  openPortalSelection();
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
      await supabaseClient.auth.signOut({ scope: "local" });
      currentUser = null;
      currentProfile = null;
      alert("Your tenant account is active, but no unit has been assigned yet.");
    }
  } catch (error) {
    console.error("Could not restore Supabase session", error);
    alert("Could not load your rental account. Please sign out and try again.");
  }
});
