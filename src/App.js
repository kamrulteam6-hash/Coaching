import { useState, useEffect, useRef, useCallback } from "react";

// ─── SUPABASE REST CLIENT (no SDK — pure fetch) ───────────────
const SUPABASE_URL = "https://mvyzzycjsxqwemdtioqu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12eXp6eWNqc3hxd2VtZHRpb3F1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDk5NDcsImV4cCI6MjA5MDUyNTk0N30.360b6tAFmi8AmvQRo2xyuBZemtZVPzDEEiACh8quPQI";

// Tiny Supabase REST wrapper — mirrors the SDK interface used throughout the app
let _authToken = SUPABASE_ANON_KEY; // replaced with JWT after login
let _currentUser = null;

const authHeaders = () => ({
  "Content-Type": "application/json",
  "apikey": SUPABASE_ANON_KEY,
  "Authorization": "Bearer " + _authToken,
});

// ── Auth ──────────────────────────────────────────────────────
const supabase = {
  auth: {
    _session: null,
    signInWithPassword: async function({ email, password }) {
      const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) return { data: null, error: { message: data.error_description || data.msg || "Login failed" } };
      _authToken = data.access_token;
      _currentUser = data.user;
      supabase.auth._session = { user: data.user, access_token: data.access_token };
      try { localStorage.setItem("sb_session", JSON.stringify({ access_token: data.access_token, user: data.user })); } catch(e) {}
      return { data: { user: data.user, session: supabase.auth._session }, error: null };
    },
    signUp: async function({ email, password }) {
      const res = await fetch(SUPABASE_URL + "/auth/v1/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) return { data: null, error: { message: data.error_description || data.msg || "Signup failed" } };
      _authToken = data.access_token || SUPABASE_ANON_KEY;
      _currentUser = data.user;
      supabase.auth._session = { user: data.user };
      return { data: { user: data.user }, error: null };
    },
    signOut: async function() {
      await fetch(SUPABASE_URL + "/auth/v1/logout", {
        method: "POST", headers: authHeaders(),
      }).catch(() => {});
      _authToken = SUPABASE_ANON_KEY;
      _currentUser = null;
      supabase.auth._session = null;
      try { localStorage.removeItem("sb_session"); } catch(e) {}
      if (supabase.auth._authChangeCallback) supabase.auth._authChangeCallback("SIGNED_OUT", null);
    },
    getSession: async function() {
      // Restore from localStorage if available
      try {
        const saved = localStorage.getItem("sb_session");
        if (saved) {
          const parsed = JSON.parse(saved);
          // Refresh token to validate
          const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
            headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + parsed.access_token },
          });
          if (res.ok) {
            _authToken = parsed.access_token;
            _currentUser = parsed.user;
            supabase.auth._session = parsed;
            return { data: { session: parsed }, error: null };
          } else {
            localStorage.removeItem("sb_session");
          }
        }
      } catch(e) {}
      return { data: { session: null }, error: null };
    },
    onAuthStateChange(callback) {
      // Minimal stub — signOut calls SIGNED_OUT manually
      supabase.auth._authChangeCallback = callback;
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
  },

  // ── REST query builder ───────────────────────────────────────
  from(table) {
    const base = SUPABASE_URL + "/rest/v1/" + table;
    let _filters = [];
    let _select = "*";
    let _order = null;
    let _single = false;

    const builder = {
      select(cols) { _select = cols || "*"; return builder; },
      eq(col, val) { _filters.push(`${col}=eq.${val}`); return builder; },
      in(col, vals) { _filters.push(`${col}=in.(${vals.join(",")})`); return builder; },
      order(col) { _order = col; return builder; },
      single() { _single = true; return builder; },

      _fetch: async function(method, body, extra) { extra = extra || {};
        let url = base + "?select=" + encodeURIComponent(_select);
        _filters.forEach(f => { url += "&" + f; });
        if (_order) url += "&order=" + _order;
        const headers = { ...authHeaders(), "Prefer": "return=representation" };
        if (_single) headers["Accept"] = "application/vnd.pgrst.object+json";
        if (extra && extra.upsert) headers["Prefer"] = "resolution=merge-duplicates,return=representation";
        const res = await fetch(url, {
          method, headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        if (res.status === 204 || res.status === 200 && res.headers.get("content-length") === "0") {
          return { data: null, error: null };
        }
        let data;
        try { data = await res.json(); } catch(e) { data = null; }
        if (!res.ok) {
          return { data: null, error: { message: (data?.message || data?.hint || "DB error " + res.status) } };
        }
        return { data: _single ? data : (Array.isArray(data) ? data : [data]), error: null };
      },

      then: function(resolve, reject) { builder._fetch("GET").then(resolve).catch(reject); },

      insert(body) {
        const rows = Array.isArray(body) ? body : [body];
        const ib = {
          select(cols) {
            _select = cols || "*";
            return {
              single() { _single = true; return builder._fetch("POST", rows); },
              then: (r,j) => builder._fetch("POST", rows).then(r,j),
            };
          },
          single() { _single = true; return builder._fetch("POST", rows); },
          then: (r,j) => builder._fetch("POST", rows).then(r,j),
        };
        return ib;
      },

      update(body) {
        return {
          eq(col, val) { _filters.push(`${col}=eq.${val}`); return { then: (r,j) => builder._fetch("PATCH", body).then(r,j) }; },
          then: (r,j) => builder._fetch("PATCH", body).then(r,j),
        };
      },

      upsert(body, opts) {
        opts = opts || {};
        const rows = Array.isArray(body) ? body : [body];
        // Pass on_conflict columns via query param for Supabase REST
        if (opts.onConflict) {
          _filters.push("on_conflict=" + encodeURIComponent(opts.onConflict));
        }
        return builder._fetch("POST", rows, { upsert: true });
      },

      delete() {
        return {
          eq(col, val) { _filters.push(`${col}=eq.${val}`); return { then: (r,j) => builder._fetch("DELETE", undefined).then(r,j) }; },
          in(col, vals) { _filters.push(`${col}=in.(${vals.join(",")})`); return { then: (r,j) => builder._fetch("DELETE", undefined).then(r,j) }; },
        };
      },
    };
    return builder;
  },
};

// ╔══════════════════════════════════════════════════════════╗
// ║              CoachlyBD v16 - Production             ║
// ║         Coaching Center Management Platform (BD)         ║
// ║         Backend: Supabase (mvyzzycjsxqwemdtioqu)        ║
// ║                                                          ║
// ║  Update SUPPORT object below with your real numbers      ║
// ╚══════════════════════════════════════════════════════════╝


let C = {
  primary: "#16A34A", primaryDark: "#15803D", primaryLight: "#DCFCE7",
  accent: "#F59E0B", accentLight: "#FEF3C7",
  success: "#16A34A", successLight: "#DCFCE7",
  danger: "#EF4444", dangerLight: "#FEF2F2",
  warning: "#F59E0B", warningLight: "#FFFBEB",
  info: "#3B82F6", infoLight: "#EFF6FF",
  purple: "#8B5CF6", purpleLight: "#F5F3FF",
  sidebar: "#0F172A",
  bg: "#F8FAFC", card: "#FFFFFF",
  border: "#E2E8F0", borderLight: "#F1F5F9",
  text: "#0F172A", muted: "#64748B", subtle: "#94A3B8",
  white: "#FFFFFF", overlay: "rgba(15,23,42,0.55)"
};
const FONT = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif";

// ─── DARK MODE COLORS ─────────────────────────────────────────
const C_DARK = {
  primary: "#22C55E", primaryDark: "#16A34A", primaryLight: "#14532D",
  accent: "#F59E0B", accentLight: "#451A03",
  success: "#22C55E", successLight: "#14532D",
  danger: "#EF4444", dangerLight: "#450A0A",
  warning: "#F59E0B", warningLight: "#422006",
  info: "#60A5FA", infoLight: "#1E3A5F",
  purple: "#A78BFA", purpleLight: "#2E1065",
  sidebar: "#020617",
  bg: "#0F172A", card: "#1E293B",
  border: "#334155", borderLight: "#1E293B",
  text: "#F1F5F9", muted: "#94A3B8", subtle: "#64748B",
  white: "#1E293B", overlay: "rgba(0,0,10,0.7)"
};

// ─── LANGUAGE STRINGS ─────────────────────────────────────────
const LANG = {
  en: {
    dashboard: "Dashboard", dueList: "Due List 🔴", students: "Students", batches: "Batches",
    teachers: "Teachers", fees: "Fees", exams: "Exams",
    messages: "Messages", settings: "Settings", help: "Help",
    addStudent: "Add Student", addBatch: "New Batch", addTeacher: "Add Teacher",
    markPaid: "Mark Paid", save: "Save Changes", cancel: "Cancel",
    signOut: "Sign Out", search: "Search...", export: "Export",
    feeManagement: "Fee Management", byMonth: "By Month", byStudent: "By Student",
    collected: "Collected", pending: "Pending", expected: "Expected",
    paid: "Paid ✓", due: "Due ⚠️", upcoming: "Upcoming",
    welcome: "Welcome back", signIn: "Sign In", register: "Create Free Account",
    monthlyFee: "Monthly Fee (৳)", studentName: "Student Name",
    guardianPhone: "Guardian Phone", batch: "Batch", subject: "Subject Group",
    fatherName: "Father's Name", motherName: "Mother's Name",
    dob: "Date of Birth", joinDate: "Join Date", rollNo: "Roll No.",
    admissionFee: "Admission Fee (৳) — optional",
    noStudents: "No students found", noTeachers: "No teachers yet", noBatches: "No batches yet",
    loading: "Loading your data…", darkMode: "Dark Mode", language: "Language",
    upgradeToProBtn: "Upgrade to Pro", profile: "Profile", plan: "Plan", account: "Account",
    staffLogin: "Staff Sign In", ownerLogin: "Owner Login",
  },
  bn: {
    dashboard: "ড্যাশবোর্ড", dueList: "বকেয়া তালিকা 🔴", students: "শিক্ষার্থী", batches: "ব্যাচ",
    teachers: "শিক্ষক", fees: "বেতন", exams: "পরীক্ষা",
    messages: "বার্তা", settings: "সেটিংস", help: "সাহায্য",
    addStudent: "শিক্ষার্থী যোগ করুন", addBatch: "নতুন ব্যাচ", addTeacher: "শিক্ষক যোগ করুন",
    markPaid: "পরিশোধ করুন", save: "সংরক্ষণ করুন", cancel: "বাতিল",
    signOut: "সাইন আউট", search: "খুঁজুন...", export: "এক্সপোর্ট",
    feeManagement: "বেতন ব্যবস্থাপনা", byMonth: "মাস অনুযায়ী", byStudent: "শিক্ষার্থী অনুযায়ী",
    collected: "সংগ্রহ", pending: "বাকি", expected: "প্রত্যাশিত",
    paid: "পরিশোধ ✓", due: "বাকি ⚠️", upcoming: "আসছে",
    welcome: "স্বাগতম", signIn: "সাইন ইন", register: "বিনামূল্যে অ্যাকাউন্ট খুলুন",
    monthlyFee: "মাসিক বেতন (৳)", studentName: "শিক্ষার্থীর নাম",
    guardianPhone: "অভিভাবকের ফোন", batch: "ব্যাচ", subject: "বিষয়",
    fatherName: "পিতার নাম", motherName: "মাতার নাম",
    dob: "জন্ম তারিখ", joinDate: "ভর্তির তারিখ", rollNo: "রোল নং",
    admissionFee: "ভর্তি ফি (৳) — ঐচ্ছিক",
    noStudents: "কোনো শিক্ষার্থী পাওয়া যায়নি", noTeachers: "কোনো শিক্ষক নেই", noBatches: "কোনো ব্যাচ নেই",
    loading: "তথ্য লোড হচ্ছে…", darkMode: "ডার্ক মোড", language: "ভাষা",
    upgradeToProBtn: "প্রো আপগ্রেড করুন", profile: "প্রোফাইল", plan: "প্ল্যান", account: "অ্যাকাউন্ট",
    staffLogin: "স্টাফ সাইন ইন", ownerLogin: "মালিক লগইন",
  }
};

// Global theme/lang state — set by root, read everywhere via window
let _darkMode = false;
let _lang = "en";
const getC = () => _darkMode ? C_DARK : C;
const T = (key) => (LANG[_lang] || LANG.en)[key] || key;

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const CURRENT_YEAR = new Date().getFullYear();
const CURRENT_MONTH = new Date().getMonth(); // 0=Jan, 1=Feb, etc.

// ─── SMART FEE DISCOUNTS ──────────────────────────────────────
// Defined early so all components (incl. StudentProfile) can call it
// feeType: "full" | "half" | "custom" | "free"
// feeOverrides: { studentId: { "March-2026": { type, amount } } }
function getEffectiveFee(student, monthKey, feeOverrides) {
  const override = feeOverrides?.[student.id]?.[monthKey];
  if (override) {
    if (override.type === "full") return student.fee;
    if (override.type === "half") return Math.floor(student.fee / 2);
    if (override.type === "custom") return override.amount || 0;
    if (override.type === "free") return 0;
  }
  const def = student.defaultFeeType;
  if (def === "half") return Math.floor(student.fee / 2);
  if (def === "custom") return student.customFeeAmount || 0;
  if (def === "free") return 0;
  return student.fee; // "full" or unset
}


// Returns expected fee for a student in a given month.
// For the student's join month, adds the batch admission fee (one-time).
function getExpectedFee(student, monthKey, feeOverrides, batches) {
  const base = getEffectiveFee(student, monthKey, feeOverrides);
  if (!student.joinDate) return base;
  // joinDate is stored as YYYY-MM-DD from date picker
  const joinDate = new Date(student.joinDate);
  if (isNaN(joinDate)) return base;
  const joinMonthKey = MONTHS[joinDate.getMonth()] + "-" + joinDate.getFullYear();
  if (monthKey === joinMonthKey) {
    const batch = batches ? batches.find(b => b.name === student.batch) : null;
    const admFee = batch?.admissionFee || 0;
    return base + admFee;
  }
  return base;
}

// ─── TINY UTILS ───────────────────────────────────────────────

const initials = (name) => name?.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() || "??";
const fmtTaka = (n) => `৳${Number(n || 0).toLocaleString()}`;


// ─── GLOBAL CSS FOR RESPONSIVE LAYOUT ───────────────────────
const GLOBAL_CSS = `
  .desktop-sidebar { display: block; }
  .mobile-only-btn { display: none !important; }
  .main-content-area { margin-left: 240px; }
  @media (max-width: 768px) {
    .desktop-sidebar { display: none !important; }
    .mobile-only-btn { display: block !important; }
    .main-content-area { margin-left: 0 !important; }
  }
  * { transition: background-color 0.2s, border-color 0.2s, color 0.2s; }
  input, select, textarea { color-scheme: inherit; }
`;
function GlobalStyles({ darkMode }) {
  const dmCSS = darkMode ? `
    input, select, textarea {
      background: #1E293B !important;
      color: #F1F5F9 !important;
      border-color: #334155 !important;
    }
    option { background: #1E293B; color: #F1F5F9; }
  ` : "";
  return <style>{GLOBAL_CSS + dmCSS}</style>;
}

function Av({ label, size = 40, bg = C.primary, color = "#fff" }) {
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: bg, color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.32, fontWeight: 700, flexShrink: 0, fontFamily: FONT }}>
      {label}
    </div>
  );
}

function Badge({ text, type = "neutral", small }) {
  const map = {
    paid: [C.successLight, C.success], due: [C.warningLight, C.warning],
    overdue: [C.dangerLight, C.danger], neutral: [C.borderLight, C.muted],
    active: [C.infoLight, C.info], pro: [C.accentLight, C.accent], purple: [C.purpleLight, C.purple]
  };
  const [bg, col] = map[type] || map.neutral;
  return <span style={{ background: bg, color: col, padding: small ? "2px 8px" : "3px 10px", borderRadius: 6, fontSize: small ? 11 : 12, fontWeight: 600, whiteSpace: "nowrap" }}>{text}</span>;
}

function Btn({ children, onClick, variant = "primary", size = "md", full, disabled, style: sx }) {
  const base = { border: "none", borderRadius: 8, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.15s", opacity: disabled ? 0.5 : 1, fontFamily: FONT, display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "center", whiteSpace: "nowrap" };
  const sz = { sm: { padding: "5px 12px", fontSize: 12 }, md: { padding: "9px 16px", fontSize: 13 }, lg: { padding: "12px 22px", fontSize: 14 } }[size];
  const vars = {
    primary: { background: C.primary, color: "#fff" },
    accent: { background: C.accent, color: "#fff" },
    success: { background: C.success, color: "#fff" },
    danger: { background: C.danger, color: "#fff" },
    ghost: { background: "transparent", color: C.primary, border: "1.5px solid " + C.primary },
    soft: { background: C.borderLight, color: C.text, border: "1px solid " + C.border }
  };
  return <button disabled={disabled} onClick={onClick} style={{ ...base, ...sz, ...vars[variant], width: full ? "100%" : "auto", ...sx }}>{children}</button>;
}

function Input({ label, value, onChange, type = "text", placeholder, required, prefix, note, rows }) {
  const base = { width: "100%", padding: prefix ? "9px 12px 9px 36px" : "9px 12px", borderRadius: 8, border: "1.5px solid " + C.border, fontSize: 13, color: C.text, outline: "none", background: C.white, boxSizing: "border-box", fontFamily: FONT };
  return (
    <div style={{ marginBottom: 12 }}>
      {label && <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.4px" }}>{label}{required && <span style={{ color: C.danger }}> *</span>}</label>}
      <div style={{ position: "relative" }}>
        {prefix && <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 14, pointerEvents: "none" }}>{prefix}</span>}
        {rows ? <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{ ...base, resize: "vertical" }} /> : <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={base} />}
      </div>
      {note && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{note}</div>}
    </div>
  );
}

function Select({ label, value, onChange, options, required }) {
  return (
    <div style={{ marginBottom: 12 }}>
      {label && <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.4px" }}>{label}{required && <span style={{ color: C.danger }}> *</span>}</label>}
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1.5px solid " + C.border, fontSize: 13, color: C.text, outline: "none", background: C.white, boxSizing: "border-box", fontFamily: FONT }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.white, borderRadius: 16, padding: "28px 24px", width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.18)" }}>
        {title && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: C.text }}>{title}</h3>
            <button onClick={onClose} style={{ background: C.borderLight, border: "none", borderRadius: 6, width: 30, height: 30, cursor: "pointer", color: C.muted, fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function Toast({ msg, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3200); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{ position: "fixed", top: 20, right: 20, background: C.text, color: "#fff", padding: "12px 18px", borderRadius: 10, zIndex: 9999, boxShadow: "0 8px 32px rgba(0,0,0,0.2)", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, maxWidth: 340 }}>
      {msg}
      <button onClick={onClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, marginLeft: 4 }}>✕</button>
    </div>
  );
}

function SectionHeader({ title, action }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.text }}>{title}</h2>
      {action}
    </div>
  );
}

function EmptyState({ icon, title, sub }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 20px", color: C.muted }}>
      <div style={{ fontSize: 44, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: C.muted }}>{sub}</div>
    </div>
  );
}

const SUPPORT = {
  whatsapp: "01700-000000", whatsappLink: "https://wa.me/8801700000000",
  phone: "01700-000000", email: "support@coachlybd.app",
  facebook: "https://facebook.com/coachlybd", youtube: "https://youtube.com/@coachlybd", blog: "https://coachlybd.app/blog",
};
// ─── SUPABASE DATA LAYER ─────────────────────────────────────
// All DB operations. Snake_case (DB) ↔ camelCase (app) mapping here.

// Map DB row → app student object
const dbToStudent = (r) => ({
  id: r.id, name: r.name, fatherName: r.father_name || "", motherName: r.mother_name || "",
  guardian: r.guardian || "", phone: r.phone || "", batch: r.batch || "",
  fee: r.fee || 0, subject: r.subject || "", roll: r.roll || "",
  joinDate: r.join_date || "", dob: r.dob || "", bcNumber: r.bc_number || "",
  avatar: r.avatar || initials(r.name), photo: r.photo || null,
  defaultFeeType: r.default_fee_type || "full", customFeeAmount: r.custom_fee_amount || 0,
});

// Map DB row → app batch object
const dbToBatch = (r) => ({
  id: r.id, name: r.name, fullName: r.full_name || r.name,
  time: r.time || "", room: r.room || "", days: r.days || [],
  subject: r.subject || "", color: r.color || "#16A34A",
  admissionFee: r.admission_fee || 0,
});

// Map DB row → app teacher object
const dbToTeacher = (r) => ({
  id: r.id, name: r.name, subject: r.subject || "", salary: r.salary || 0,
  phone: r.phone || "", joinDate: r.join_date || "", avatar: r.avatar || initials(r.name),
  batches: r.batches || [], status: r.status || "active", salaryPaid: r.salary_paid || {},
});

// Map DB payments array → app payments object { studentId: { monthKey: {...} } }
const dbToPayments = (rows) => {
  const p = {};
  rows.forEach(r => {
    if (!p[r.student_id]) p[r.student_id] = {};
    p[r.student_id][r.month_key] = {
      status: r.status, paidDate: r.paid_date || "",
      method: r.method || "", recordedBy: r.recorded_by || "",
      recordedAt: r.recorded_at || null, amount: r.amount || 0,
    };
  });
  return p;
};

// Map DB fee_overrides → app feeOverrides { studentId: { monthKey: { type, amount } } }
const dbToFeeOverrides = (rows) => {
  const fo = {};
  rows.forEach(r => {
    if (!fo[r.student_id]) fo[r.student_id] = {};
    fo[r.student_id][r.month_key] = { type: r.type, amount: r.amount || 0 };
  });
  return fo;
};

// Map DB staff → app staff object
const dbToStaff = (r) => ({
  id: r.id, name: r.name, username: r.username,
  password: r.password, role: r.role || "staff", active: r.active,
});

// Load all data for a coaching center
async function loadCenterData(centerId) {
  const [batches, students, teachers, payments, feeOverrides, staff] = await Promise.all([
    supabase.from("batches").select("*").eq("center_id", centerId).order("created_at"),
    supabase.from("students").select("*").eq("center_id", centerId).order("created_at"),
    supabase.from("teachers").select("*").eq("center_id", centerId).order("created_at"),
    supabase.from("payments").select("*").eq("center_id", centerId),
    supabase.from("fee_overrides").select("*").eq("center_id", centerId),
    supabase.from("staff_accounts").select("*").eq("center_id", centerId),
  ]);
  return {
    batches: (batches.data || []).map(dbToBatch),
    students: (students.data || []).map(dbToStudent),
    teachers: (teachers.data || []).map(dbToTeacher),
    payments: dbToPayments(payments.data || []),
    feeOverrides: dbToFeeOverrides(feeOverrides.data || []),
    staffAccounts: (staff.data || []).map(dbToStaff),
  };
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────
function LoginScreen({ onLogin, staffAccounts = [], onStaffLogin }) {
  const [loginTab, setLoginTab] = useState("owner"); // "owner" | "staff"
  const [mode, setMode] = useState("login"); // "login" | "register" | "registered"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // register fields
  const [rName, setRName] = useState("");
  const [rOwner, setROwner] = useState("");
  const [rPhone, setRPhone] = useState("");
  const [rAddress, setRAddress] = useState("");
  const [rEmail, setREmail] = useState("");
  const [rPassword, setRPassword] = useState("");
  const [rConfirm, setRConfirm] = useState("");
  const [rError, setRError] = useState("");

  const handleLogin = async () => {
    if (!email || !password) { setError("Please enter your email and password."); return; }
    setError(""); setLoading(true);
    try {
      // Sign in with Supabase Auth
      const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
      if (authErr) throw new Error(authErr.message);
      // Load coaching center profile
      const { data: center, error: centerErr } = await supabase
        .from("coaching_centers")
        .select("*")
        .eq("user_id", authData.user.id)
        .single();
      if (centerErr || !center) throw new Error("Coaching center not found. Please contact support.");
      onLogin({
        id: center.id, userId: authData.user.id, email: authData.user.email,
        name: center.name, owner: center.owner, phone: center.phone,
        address: center.address, logo: center.logo, logoImage: center.logo_image,
        plan: center.plan, established: center.established,
        whatsappNumber: center.whatsapp_number,
      });
    } catch (err) {
      setError(err.message || "Invalid email or password. Please try again.");
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    setRError("");
    if (!rName || !rOwner || !rPhone || !rEmail || !rPassword) { setRError("Please fill all required fields."); return; }
    if (rPassword !== rConfirm) { setRError("Passwords do not match."); return; }
    if (rPassword.length < 6) { setRError("Password must be at least 6 characters."); return; }
    setLoading(true);
    try {
      // 1. Create Supabase auth user
      const { data: authData, error: signUpErr } = await supabase.auth.signUp({ email: rEmail, password: rPassword });
      if (signUpErr) throw new Error(signUpErr.message);
      // authData.user can be null if email confirmation is enabled in Supabase
      // In that case, store pending data and show success screen
      const userId = authData && authData.user && authData.user.id;
      if (userId) {
        // Email confirmation OFF — user created immediately, insert center now
        const { error: centerErr } = await supabase.from("coaching_centers").insert({
          user_id: userId,
          name: rName, owner: rOwner, phone: rPhone,
          address: rAddress, logo: rName.split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase(),
          plan: "free",
        });
        if (centerErr) throw new Error(centerErr.message);
      }
      // Whether email confirmation is on or off, show success screen
      setLoading(false);
      setMode("registered");
    } catch (err) {
      setRError(err.message || "Registration failed. Please try again.");
      setLoading(false);
    }
  };

  const gradBg = { minHeight: "100vh", background: `linear-gradient(160deg, ${C.primary} 0%, #1a5c45 55%, #2d7a5e 100%)`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 };

  const Logo = () => (
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <div style={{ width: 64, height: 64, background: C.accent, borderRadius: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, margin: "0 auto 12px", boxShadow: "0 8px 24px rgba(232,160,32,0.4)" }}>📚</div>
      <div style={{ fontSize: 28, fontWeight: 900, color: "#fff", fontFamily: "Georgia, serif", letterSpacing: -0.5 }}>CoachlyBD</div>
      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginTop: 3 }}>Coaching Management Platform</div>
    </div>
  );

  // ── Registration success screen ──
  if (mode === "registered") return (
    <div style={gradBg}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <Logo />
        <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", textAlign: "center" }}>
          <div style={{ fontSize: 52, marginBottom: 12 }}>🎉</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, fontFamily: "Georgia, serif", marginBottom: 8 }}>Registration Received!</div>
          <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.7, marginBottom: 20 }}>
            Thank you! Your request for <strong style={{ color: C.primary }}>{rName}</strong> has been submitted.<br /><br />
            Our team will review your details and activate your account within <strong>24 hours</strong>. We will contact you on <strong>{rPhone}</strong>.
          </div>
          <div style={{ background: C.successLight, borderRadius: 12, padding: "14px 16px", marginBottom: 20, textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.success, marginBottom: 6 }}>✅ What happens next?</div>
            <div style={{ fontSize: 12, color: C.text, lineHeight: 2 }}>
              1. Our team reviews your application<br />
              2. We call/WhatsApp you at {rPhone}<br />
              3. Your account gets activated (Free plan)<br />
              4. You can upgrade to Pro anytime
            </div>
          </div>
          <div style={{ background: "#E8F5E9", borderRadius: 12, padding: "12px 16px", marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: C.success, fontWeight: 700, marginBottom: 4 }}>📞 Need faster activation?</div>
            <div style={{ fontSize: 13, color: C.text }}>Call or WhatsApp us directly:</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.primary, marginTop: 4 }}>{SUPPORT.whatsapp}</div>
          </div>
          <Btn full variant="primary" onClick={() => setMode("login")}>← Back to Sign In</Btn>
        </div>
      </div>
    </div>
  );

  // ── Register form ──
  if (mode === "register") return (
    <div style={{ ...gradBg, justifyContent: "flex-start", paddingTop: 32, paddingBottom: 40 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <Logo />
        <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 4, fontFamily: "Georgia, serif" }}>Register Your Coaching</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Create a free account — takes 1 minute</div>

          <div style={{ fontSize: 12, fontWeight: 700, color: C.primary, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Coaching Details</div>
          <Input label="Coaching Center Name" value={rName} onChange={setRName} placeholder="e.g. Bright Future Coaching" required />
          <Input label="Owner / Principal Name" value={rOwner} onChange={setROwner} placeholder="e.g. Md. Rafiqul Islam" required />
          <Input label="Phone / WhatsApp" value={rPhone} onChange={setRPhone} placeholder="e.g. 01711-234567" required />
          <Input label="Address" value={rAddress} onChange={setRAddress} placeholder="e.g. Mirpur-10, Dhaka" />

          <div style={{ fontSize: 12, fontWeight: 700, color: C.primary, margin: "14px 0 10px", textTransform: "uppercase", letterSpacing: 0.5 }}>Login Credentials</div>
          <Input label="Email Address" value={rEmail} onChange={setREmail} type="email" placeholder="your@email.com" required />
          <Input label="Password" value={rPassword} onChange={setRPassword} type="password" placeholder="Min 6 characters" required />
          <Input label="Confirm Password" value={rConfirm} onChange={setRConfirm} type="password" placeholder="Repeat password" required />

          {rError && <div style={{ background: C.dangerLight, color: C.danger, padding: "10px 14px", borderRadius: 10, fontSize: 13, marginBottom: 14, fontWeight: 500 }}>{rError}</div>}

          <div style={{ background: C.accentLight, borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: C.warning }}>
            🎁 <strong>Free plan includes:</strong> 1 batch, up to 30 students, basic fee management — forever free.
          </div>

          <Btn full variant="primary" size="lg" onClick={handleRegister} disabled={loading} style={{ marginBottom: 10 }}>
            {loading ? "Submitting..." : "Create Free Account →"}
          </Btn>
          <Btn full variant="soft" onClick={() => { setMode("login"); setRError(""); }}>← Back to Sign In</Btn>
        </div>
      </div>
    </div>
  );

  // ── Login form ──
  return (
    <div style={gradBg}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <Logo />

        <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>

          {/* Owner / Staff tab switcher */}
          <div style={{ display: "flex", background: C.bg, borderRadius: 12, padding: 4, marginBottom: 20, gap: 4 }}>
            {[["owner", "🏫 Owner Login"], ["staff", "👔 Staff Login"]].map(([t, l]) => (
              <button key={t} onClick={() => setLoginTab(t)} style={{ flex: 1, padding: "9px 8px", borderRadius: 9, border: "none", fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "all 0.15s", background: loginTab === t ? C.primary : "transparent", color: loginTab === t ? "#fff" : C.muted }}>{l}</button>
            ))}
          </div>

          {loginTab === "owner" ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 4, fontFamily: "Georgia, serif" }}>Welcome back</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Sign in to your coaching dashboard</div>
<Input label="Email Address" value={email} onChange={setEmail} type="email" placeholder="your@email.com" prefix="✉️" />
              <div style={{ position: "relative" }}>
                <Input label="Password" value={password} onChange={setPassword} type={showPw ? "text" : "password"} placeholder="Enter password" prefix="🔒" />
                <button onClick={() => setShowPw(!showPw)} style={{ position: "absolute", right: 12, top: 32, background: "none", border: "none", cursor: "pointer", fontSize: 14, color: C.muted }}>{showPw ? "Hide" : "Show"}</button>
              </div>
              {error && <div style={{ background: C.dangerLight, color: C.danger, padding: "10px 14px", borderRadius: 10, fontSize: 13, marginBottom: 14, fontWeight: 500 }}>{error}</div>}
              <Btn full variant="primary" size="lg" onClick={handleLogin} disabled={loading} style={{ marginBottom: 10 }}>
                {loading ? "Signing in..." : "Sign In →"}
              </Btn>
              <Btn full variant="soft" onClick={() => { setMode("register"); setError(""); }}>
                ✏️ Register New Coaching Center
              </Btn>
            </>
          ) : (
            <StaffLoginPanel staffAccounts={staffAccounts} onStaffLogin={onStaffLogin} />
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
          Need help? <a href={SUPPORT.whatsappLink} style={{ color: C.accent, fontWeight: 700, textDecoration: "none" }}>WhatsApp us</a>
        </div>
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────
function Dashboard({ students, batches, teachers, payments, account, isPro, onUpgrade, setTab, staffMode }) {
  const monthKey = `${MONTHS[CURRENT_MONTH]}-${CURRENT_YEAR}`;
  const totalExpected = students.reduce((a, st) => a + getExpectedFee(st, monthKey, {}, batches), 0);
  const prevMonthKey = `${MONTHS[CURRENT_MONTH - 1]}-${CURRENT_YEAR}`;
  const collected = students.filter(s => payments[s.id]?.[monthKey]?.status === "paid").reduce((a, st) => a + getEffectiveFee(st, monthKey, {}), 0)
    + students.reduce((a, s) => { const ap = payments[s.id]?.["Admission-" + CURRENT_YEAR]; return a + (ap?.status === "paid" && ap?.amount ? ap.amount : 0); }, 0);
  const dueStudents = students.filter(s => payments[s.id]?.[monthKey]?.status === "unpaid");
  const overdueStudents = students.filter(s => payments[s.id]?.[prevMonthKey]?.status === "unpaid");
  const teacherSalary = teachers.reduce((s, t) => s + t.salary, 0);
  const totalSalaryPaid = teachers.filter(t => t.salaryPaid?.[prevMonthKey]).reduce((s, t) => s + t.salary, 0);
  const pct = totalExpected > 0 ? Math.round(collected / totalExpected * 100) : 0;

  // Advance paid counts (paid for future months)
  const advancePaid = students.filter(s =>
    MONTHS.slice(CURRENT_MONTH + 1).some(m => payments[s.id]?.[`${m}-${CURRENT_YEAR}`]?.status === "paid")
  ).length;

  // Monthly income trend (last 5 months)
  const trend = MONTHS.slice(Math.max(0, CURRENT_MONTH - 4), CURRENT_MONTH + 1).map(m => {
    const mk = `${m}-${CURRENT_YEAR}`;
    const amt = students.filter(s => payments[s.id]?.[mk]?.status === "paid").reduce((a, s) => a + s.fee, 0);
    return { m: m.slice(0, 3), amt };
  });
  const maxTrend = Math.max(...trend.map(t => t.amt), 1);

  // Today's schedule — batches with today being a class day
  const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const todayDay = dayNames[new Date().getDay()];
  const todayBatches = batches.filter(b => b.days?.includes(todayDay));

  return (
    <div style={{ paddingBottom: 32 }}>
      {/* Hero */}
      <div style={{ background: `linear-gradient(135deg, ${C.primary} 0%, #1a5c45 100%)`, borderRadius: 20, padding: "22px 20px", marginBottom: 16, color: "#fff", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", right: -20, top: -20, width: 130, height: 130, background: "rgba(255,255,255,0.04)", borderRadius: "50%" }} />
        <div style={{ position: "absolute", right: 30, bottom: -40, width: 90, height: 90, background: "rgba(255,255,255,0.04)", borderRadius: "50%" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 2 }}>👋 Welcome back</div>
            <div style={{ fontSize: 19, fontWeight: 800, fontFamily: "Georgia, serif" }}>{account?.name || "Coaching Center"}</div>
            <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>{account?.address || ""}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <Av label={account?.logo} size={44} bg="rgba(255,255,255,0.15)" />
            {isPro && <div style={{ fontSize: 10, background: C.accent, borderRadius: 6, padding: "2px 6px", marginTop: 4, fontWeight: 700 }}>⭐ PRO</div>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {[
            [students.length, "Students", "👥"],
            [batches.length, "Batches", "📚"],
            [teachers.length, "Teachers", "👨‍🏫"],
            [advancePaid, "Advance", "⏩"]
          ].map(([v, l, ic]) => (
            <div key={l} style={{ background: "rgba(255,255,255,0.11)", borderRadius: 10, padding: "9px 10px", flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 9, opacity: 0.7, marginBottom: 1 }}>{ic}</div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{v}</div>
              <div style={{ fontSize: 9, opacity: 0.75 }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Fee Progress Card */}
      <div style={{ background: C.card, borderRadius: 16, padding: 18, marginBottom: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 14 }}>March 2026 — Fee Collection</div>
            <div style={{ fontSize: 12, color: C.muted }}>{students.length - dueStudents.length} of {students.length} students paid</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: C.success, fontFamily: "Georgia, serif", lineHeight: 1 }}>{pct}%</div>
            <div style={{ fontSize: 10, color: C.muted }}>collected</div>
          </div>
        </div>
        <div style={{ background: "#F0EDE8", borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 10 }}>
          <div style={{ background: `linear-gradient(90deg, ${C.success}, #4ADE80)`, height: "100%", width: `${pct}%`, borderRadius: 8, transition: "width 1.2s ease" }} />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1, background: C.successLight, borderRadius: 10, padding: "9px 12px" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.success }}>{fmtTaka(collected)}</div>
            <div style={{ fontSize: 11, color: C.success }}>Collected</div>
          </div>
          <div style={{ flex: 1, background: C.warningLight, borderRadius: 10, padding: "9px 12px" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.warning }}>{fmtTaka(totalExpected - collected)}</div>
            <div style={{ fontSize: 11, color: C.warning }}>Pending</div>
          </div>
          <div style={{ flex: 1, background: C.infoLight, borderRadius: 10, padding: "9px 12px" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.info }}>{fmtTaka(totalExpected)}</div>
            <div style={{ fontSize: 11, color: C.info }}>Expected</div>
          </div>
        </div>
      </div>

      {/* Income Trend Sparkline */}
      <div style={{ background: C.card, borderRadius: 16, padding: 18, marginBottom: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 14, marginBottom: 12 }}>📈 Monthly Income Trend</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 60 }}>
          {trend.map((t, i) => (
            <div key={t.m} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>{fmtTaka(t.amt).replace("৳","")}</div>
              <div style={{ width: "100%", background: i === trend.length - 1 ? C.success : `${C.primary}55`, borderRadius: "4px 4px 0 0", height: `${Math.max(6, Math.round(t.amt / maxTrend * 42))}px`, transition: "height 0.8s" }} />
              <div style={{ fontSize: 10, color: i === trend.length - 1 ? C.primary : C.muted, fontWeight: i === trend.length - 1 ? 700 : 400 }}>{t.m}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Financial Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div style={{ background: C.card, borderRadius: 14, padding: 14, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, marginBottom: 3, letterSpacing: 0.5 }}>NET INCOME</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: (collected - teacherSalary) >= 0 ? C.success : C.danger, fontFamily: "Georgia, serif" }}>{fmtTaka(collected - teacherSalary)}</div>
          <div style={{ fontSize: 11, color: C.muted }}>collected − salaries</div>
        </div>
        <div style={{ background: C.card, borderRadius: 14, padding: 14, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, marginBottom: 3, letterSpacing: 0.5 }}>SALARY BURDEN</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.purple, fontFamily: "Georgia, serif" }}>{fmtTaka(teacherSalary)}</div>
          <div style={{ fontSize: 11, color: C.muted }}>{fmtTaka(totalSalaryPaid)} paid ({MONTHS[CURRENT_MONTH - 1]?.slice(0,3)})</div>
        </div>
      </div>

      {/* 🔔 Fee Due Reminder System */}
      <FeeDueReminders students={students} payments={payments} batches={batches} isPro={isPro} setTab={setTab} />

      {/* Today's Schedule */}
      <div style={{ background: C.card, borderRadius: 16, padding: 18, marginBottom: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 14, marginBottom: 10 }}>📅 Today's Classes <span style={{ fontWeight: 400, color: C.muted, fontSize: 12 }}>({todayDay})</span></div>
        {todayBatches.length === 0
          ? <div style={{ fontSize: 13, color: C.muted }}>No classes scheduled today.</div>
          : todayBatches.map(b => (
            <div key={b.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ width: 6, height: 36, borderRadius: 3, background: b.color || C.primary, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{b.fullName || b.name}</div>
                <div style={{ fontSize: 12, color: C.muted }}>🕐 {b.time} · 🚪 {b.room || "—"}</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.primary }}>{students.filter(s => s.batch === b.name).length} students</div>
            </div>
          ))
        }
      </div>

      {/* Batch-wise fee status */}
      <div style={{ background: C.card, borderRadius: 16, padding: 18, marginBottom: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 14, marginBottom: 12 }}>🏫 Batch-wise Fee Status ({MONTHS[CURRENT_MONTH]})</div>
        {batches.map(b => {
          const bStudents = students.filter(s => s.batch === b.name);
          const bPaid = bStudents.filter(s => payments[s.id]?.[monthKey]?.status === "paid").length;
          const bPct = bStudents.length > 0 ? Math.round(bPaid / bStudents.length * 100) : 0;
          return (
            <div key={b.id} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                <span style={{ fontWeight: 600, color: C.text }}>{b.fullName || b.name}</span>
                <span style={{ color: C.muted }}>{bPaid}/{bStudents.length} paid · {bPct}%</span>
              </div>
              <div style={{ background: "#F0EDE8", borderRadius: 6, height: 7, overflow: "hidden" }}>
                <div style={{ background: b.color || C.primary, height: "100%", width: `${bPct}%`, borderRadius: 6, transition: "width 1s" }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick actions */}
      <div style={{ background: C.card, borderRadius: 16, padding: 18, marginBottom: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 14, marginBottom: 12 }}>⚡ Quick Actions</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {[
            ...(!staffMode ? [["➕ Add Student", "Students", C.primary]] : []),
            ["💰 Record Fee", "Fees", C.success],
            ["📢 Send Message", "Messages", isPro ? C.accent : C.muted],
            ["📊 View Reports", "Fees", C.info],
          ].map(([label, tab, col]) => (
            <button key={label} onClick={() => setTab(tab)} style={{ padding: "12px 10px", borderRadius: 12, border: `1.5px solid ${col}22`, background: `${col}0D`, color: col, fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "left" }}>
              {label}{!isPro && label === "📢 Send Message" && " 🔒"}
            </button>
          ))}
        </div>
      </div>

      {!isPro && (
        <div onClick={onUpgrade} style={{ background: `linear-gradient(135deg, ${C.accent}, #b56a0a)`, borderRadius: 16, padding: "18px 20px", cursor: "pointer", color: "#fff", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 32 }}>⭐</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Upgrade to Pro</div>
            <div style={{ fontSize: 13, opacity: 0.9 }}>WhatsApp reminders, salary management & more</div>
            <div style={{ fontSize: 15, fontWeight: 800, marginTop: 4 }}>৳299 / month</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── STUDENTS ─────────────────────────────────────────────────
function Students({ students, setStudents, batches, payments, setPayments, feeOverrides = {}, isPro, toast, readOnly, account }) {
  const [search, setSearch] = useState("");
  const [filterBatch, setFilterBatch] = useState("all");
  const [modal, setModal] = useState(null); // null | "add" | {student}
  const [profileStudent, setProfileStudent] = useState(null);
  const [admissionModal, setAdmissionModal] = useState(null); // { student, admissionFee }
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const blankForm = { name: "", fatherName: "", motherName: "", phone: "", batch: "", fee: "", subject: "", roll: "", joinDate: "", dob: "", bcNumber: "", defaultFeeType: "full", customFeeAmount: "", admissionFee: "" };
  const [form, setForm] = useState(blankForm);
  const fld = (k) => (v) => setForm(f => ({ ...f, [k]: v }));

  const filtered = students.filter(s => {
    const q = search.toLowerCase();
    return (s.name.toLowerCase().includes(q) || (s.fatherName||"").toLowerCase().includes(q) || (s.motherName||"").toLowerCase().includes(q) || (s.guardian||"").toLowerCase().includes(q) || s.roll.includes(q)) && (filterBatch === "all" || s.batch === filterBatch);
  });
  const openAdd = () => {
    if (!isPro) { const batchCount = students.filter(s => s.batch === form.batch).length; if (batchCount >= 10) { setShowUpgrade(true); return; } }
    setForm(blankForm); setModal("add");
  };
  const openEdit = (s) => { setForm({ ...s }); setModal(s); };

  const save = async () => {
    if (!form.name || !form.batch || !form.fee) return;
    if (!isPro && modal === "add") { const batchCount = students.filter(s => s.batch === form.batch).length; if (batchCount >= 10) { setShowUpgrade(true); return; } }
    setSaving(true);
    const centerId = account?.id;
    if (modal === "add") {
      const row = {
        center_id: centerId, name: form.name, father_name: form.fatherName || null,
        mother_name: form.motherName || null, guardian: form.fatherName || form.motherName || null,
        phone: form.phone, batch: form.batch, fee: parseInt(form.fee),
        subject: form.subject, roll: form.roll, join_date: form.joinDate,
        dob: form.dob || null, bc_number: form.bcNumber || null,
        avatar: initials(form.name), photo: form.photo || null,
        default_fee_type: form.defaultFeeType || "full",
        custom_fee_amount: parseInt(form.customFeeAmount) || null,
      };
      const { data: newRow, error } = await supabase.from("students").insert(row).select().single();
      if (error) { setSaving(false); toast("❌ " + error.message); return; }
      const newS = dbToStudent(newRow);
      setStudents(s => [...s, newS]);
      // Create payment rows from join month onward (fee renews 1st of each month)
      const joinDate = form.joinDate ? new Date(form.joinDate) : new Date();
      const joinYear = joinDate.getFullYear();
      const joinMonth = joinDate.getMonth(); // 0-indexed
      const payRows = [];
      // Create rows for join year
      MONTHS.forEach((m, i) => {
        if (joinYear === CURRENT_YEAR) {
          if (i >= joinMonth) payRows.push({ center_id: centerId, student_id: newRow.id, month_key: `${m}-${CURRENT_YEAR}`, status: i === joinMonth ? "unpaid" : i > CURRENT_MONTH ? "upcoming" : "unpaid" });
        } else if (joinYear < CURRENT_YEAR) {
          payRows.push({ center_id: centerId, student_id: newRow.id, month_key: `${m}-${CURRENT_YEAR}`, status: i <= CURRENT_MONTH ? "unpaid" : "upcoming" });
        }
      });
      if (payRows.length > 0) await supabase.from("payments").upsert(payRows, { onConflict: "student_id,month_key" });
      setPayments(p => {
        const np = { ...p, [newRow.id]: {} };
        payRows.forEach(r => { np[newRow.id][r.month_key] = { status: r.status }; });
        return np;
      });
      // Save admission fee as a payment record so it appears in daily collection
      const batchAdmFee = batches.find(b => b.name === form.batch)?.admissionFee || 0;
      const admFee = parseInt(form.admissionFee) || batchAdmFee;
      if (admFee > 0) {
        const admKey = "Admission-" + new Date().getFullYear();
        const admRow = { center_id: centerId, student_id: newRow.id, month_key: admKey, status: "paid", paid_date: new Date().toLocaleDateString("en-BD"), method: "Cash", recorded_by: "Owner", recorded_at: new Date().toISOString(), amount: admFee };
        await supabase.from("payments").upsert([admRow], { onConflict: "student_id,month_key" });
        setPayments(p => ({ ...p, [newRow.id]: { ...(p[newRow.id] || {}), [admKey]: { status: "paid", paidDate: admRow.paid_date, method: "Cash", recordedBy: "Owner", recordedAt: admRow.recorded_at, amount: admFee } } }));
        setAdmissionModal({ student: newS, admissionFee: admFee });
      } else {
        toast("✅ Student added!");
      }
    } else {
      const { error } = await supabase.from("students").update({
        name: form.name, father_name: form.fatherName || null, mother_name: form.motherName || null,
        guardian: form.fatherName || form.motherName || null, phone: form.phone, batch: form.batch,
        fee: parseInt(form.fee), subject: form.subject, roll: form.roll, join_date: form.joinDate,
        dob: form.dob || null, bc_number: form.bcNumber || null,
        photo: form.photo || null, default_fee_type: form.defaultFeeType || "full",
        custom_fee_amount: parseInt(form.customFeeAmount) || null,
      }).eq("id", modal.id);
      if (error) { setSaving(false); toast("❌ " + error.message); return; }
      setStudents(s => s.map(x => x.id === modal.id ? { ...x, ...form, fee: parseInt(form.fee) } : x));
      toast("✅ Student updated!");
    }
    setSaving(false);
    setModal(null);
  };

  const del = async (id) => {
    const { error } = await supabase.from("students").delete().eq("id", id);
    if (error) { toast("❌ " + error.message); return; }
    setStudents(s => s.filter(x => x.id !== id));
    setPayments(p => { const np = { ...p }; delete np[id]; return np; });
    toast("🗑️ Student removed");
    setModal(null);
  };

  const exportToCSV = (batchFilter) => {
    const data = batchFilter === "all" ? students : students.filter(s => s.batch === batchFilter);
    if (data.length === 0) { toast("⚠️ No students to export"); return; }
    const headers = ["Roll","Name","Father's Name","Mother's Name","Phone","Date of Birth","BC/NID Number","Batch","Subject","Monthly Fee","Fee Type","Join Date"];
    const rows = data.map(s => [
      s.roll, s.name,
      s.fatherName || s.guardian || "",
      s.motherName || "",
      s.phone,
      s.dob || "",
      s.bcNumber || "",
      s.batch,
      s.subject || "",
      s.fee,
      s.defaultFeeType || "full",
      s.joinDate || ""
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "students-" + (batchFilter === "all" ? "all" : batchFilter) + ".csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("✅ Exported " + data.length + " students to CSV");
  };

  const monthKey = `${MONTHS[CURRENT_MONTH]}-${CURRENT_YEAR}`;

  return (
    <div>
      <SectionHeader title={T("students")} action={
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ position: "relative" }}>
            <Btn variant="soft" onClick={() => setShowExport(v => !v)}>📥 Export</Btn>
            {showExport && (
              <div style={{ position: "absolute", right: 0, top: "110%", background: C.white, borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", border: "1px solid " + C.border, zIndex: 50, minWidth: 180, overflow: "hidden" }}>
                <div style={{ padding: "8px 12px", fontSize: 11, fontWeight: 700, color: C.muted, borderBottom: "1px solid " + C.border }}>Export to Excel/CSV</div>
                <button onClick={() => { exportToCSV("all"); setShowExport(false); }} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", fontSize: 13, color: C.text, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>📊 All Students</button>
                {batches.map(b => (
                  <button key={b.id} onClick={() => { exportToCSV(b.name); setShowExport(false); }} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", fontSize: 13, color: C.text, cursor: "pointer", textAlign: "left", borderTop: "1px solid " + C.border, fontFamily: "inherit" }}>📚 {b.name}</button>
                ))}
              </div>
            )}
          </div>
          {!readOnly && <Btn variant="primary" onClick={openAdd}>{T("addStudent") ? "➕ " + T("addStudent") : "➕ Add Student"}</Btn>}
        </div>
      } />

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search name, guardian, roll…" style={{ flex: 1, minWidth: 200, padding: "9px 14px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", background: C.bg, fontFamily: "inherit" }} />
        <select value={filterBatch} onChange={e => setFilterBatch(e.target.value)} style={{ padding: "9px 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, background: C.bg, color: C.text, outline: "none", fontFamily: "inherit" }}>
          <option value="all">All Batches</option>
          {batches.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
        </select>
      </div>

      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>{filtered.length} students found</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map(s => {
          const st = payments[s.id]?.[monthKey]?.status;
          return (
            <div key={s.id} style={{ background: C.card, borderRadius: 14, padding: "14px 16px", boxShadow: "0 1px 8px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 12 }}>
              <Av label={s.avatar} size={44} bg={st === "paid" ? C.success : C.warning} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {s.name}
                  <Badge text={st === "paid" ? "Paid ✓" : st === "unpaid" ? "Due ⚠️" : "Upcoming"} type={st === "paid" ? "paid" : st === "unpaid" ? "due" : "neutral"} small />
                </div>
                <div style={{ fontSize: 12, color: C.muted }}>Roll: {s.roll} · {s.batch} · {s.subject}</div>
                <div style={{ fontSize: 12, color: C.muted }}>{s.fatherName ? "Father: " + s.fatherName : s.guardian ? "Guardian: " + s.guardian : ""} · 📞 {s.phone}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: C.primary }}>{fmtTaka(s.fee)}</div>
                {s.defaultFeeType && s.defaultFeeType !== "full" && (
                  <Badge text={s.defaultFeeType === "half" ? "50% Disc" : s.defaultFeeType === "free" ? "Free" : "Custom"} type={s.defaultFeeType === "free" ? "purple" : "due"} small />
                )}
                <Btn size="sm" variant="soft" onClick={() => setProfileStudent(s)}>👤</Btn>
                {!readOnly && <Btn size="sm" variant="soft" onClick={() => openEdit(s)}>✏️ Edit</Btn>}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <EmptyState icon="👥" title="No students found" sub="Try a different search or add a new student" />}
      </div>

      {admissionModal && (
        <Modal title="Student Admitted!" onClose={() => { setAdmissionModal(null); toast("Student added!"); }}>
          <div style={{ background: C.successLight, borderRadius: 14, padding: 16, marginBottom: 16, textAlign: "center", border: "1px solid " + C.success + "30" }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🎓</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.success }}>{admissionModal.student.name}</div>
            <div style={{ fontSize: 13, color: C.success, marginTop: 2 }}>Successfully admitted to {admissionModal.student.batch}</div>
            {admissionModal.admissionFee > 0 && (
              <div style={{ fontSize: 20, fontWeight: 900, color: C.primary, marginTop: 8, fontFamily: "Georgia, serif" }}>Admission Fee: {fmtTaka(admissionModal.admissionFee)}</div>
            )}
          </div>
          {admissionModal.admissionFee > 0 && (() => {
            const s = admissionModal.student;
            const parentName = s.fatherName || s.motherName || s.guardian || "Guardian";
            const msgParts = [
              "Dear " + parentName + ",",
              "",
              s.name + " has been admitted to " + s.batch + " batch.",
              "",
              "Admission Fee: " + fmtTaka(admissionModal.admissionFee),
              "Monthly Fee: " + fmtTaka(s.fee || 0),
              "Date: " + new Date().toLocaleDateString("en-BD"),
              "",
              "Welcome to our coaching center! We wish your child the best."
            ];
            const msg = msgParts.join("\n");
            const phone = (s.phone || "").replace(/[^0-9]/g, "").replace(/^0/, "");
            const waURL = "https://wa.me/880" + phone + "?text=" + encodeURIComponent(msg);
            return (
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>📱 Send admission confirmation on WhatsApp:</div>
                <div style={{ background: C.bg, borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 12, color: C.muted, lineHeight: 1.8, fontFamily: "monospace", whiteSpace: "pre-wrap", border: "1px solid " + C.border }}>
                  {msg}
                </div>
                <a href={waURL} target="_blank" rel="noreferrer"
                  onClick={() => { setAdmissionModal(null); toast("✅ Student admitted!"); }}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#25D366", borderRadius: 10, padding: "13px", color: "#fff", fontSize: 14, fontWeight: 700, textDecoration: "none", marginBottom: 8 }}>
                  📱 Send WhatsApp Confirmation
                </a>
              </div>
            );
          })()}
          <Btn full variant="soft" onClick={() => { setAdmissionModal(null); toast("✅ Student admitted!"); }}>Skip / Close</Btn>
        </Modal>
      )}

            {showUpgrade && <UpgradePrompt onClose={() => setShowUpgrade(false)} onUpgrade={() => { setShowUpgrade(false); }} />}
      {profileStudent && (
        <StudentProfile
          student={profileStudent}
          payments={payments}
          batches={batches}
          feeOverrides={feeOverrides}
          onClose={() => setProfileStudent(null)}
          onEdit={!readOnly ? () => { openEdit(profileStudent); setProfileStudent(null); } : null}
          toast={toast}
        />
      )}
      {(modal === "add" || (modal && modal.id)) && (
        <Modal title={modal === "add" ? "Add New Student" : `Edit — ${modal.name}`} onClose={() => setModal(null)}>
          {/* Photo upload */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, padding: "12px 14px", background: C.bg, borderRadius: 10, border: `1px solid ${C.border}` }}>
            <div style={{ position: "relative", flexShrink: 0 }}>
              {form.photo
                ? <img src={form.photo} alt="student" style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", border: `2px solid ${C.primary}` }} />
                : <div style={{ width: 64, height: 64, borderRadius: "50%", background: C.primaryLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700, color: C.primary, border: `2px dashed ${C.primary}` }}>{form.name ? initials(form.name) : "👤"}</div>
              }
              <label title="Upload photo" style={{ position: "absolute", bottom: -2, right: -2, width: 22, height: 22, background: C.accent, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 11 }}>
                📷
                <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => {
                  const file = e.target.files[0]; if (!file) return;
                  const r = new FileReader(); r.onload = ev => setForm(f => ({ ...f, photo: ev.target.result })); r.readAsDataURL(file);
                }} />
              </label>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Student Photo</div>
              <div style={{ fontSize: 11, color: C.muted }}>Appears on Admit Card & ID Card</div>
              {form.photo && <button onClick={() => setForm(f => ({ ...f, photo: null }))} style={{ background: "none", border: "none", color: C.danger, fontSize: 11, cursor: "pointer", padding: 0, marginTop: 2 }}>✕ Remove photo</button>}
            </div>
          </div>
          <Input label="Student Name" value={form.name} onChange={fld("name")} placeholder="e.g. Rahim Uddin" required />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Input label="Roll No." value={form.roll} onChange={fld("roll")} placeholder="e.g. 001" />
            <Input label="Date of Birth" value={form.dob} onChange={fld("dob")} placeholder="e.g. 15 Jan 2010" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Input label="Father's Name" value={form.fatherName} onChange={fld("fatherName")} placeholder="e.g. Abdul Karim" />
            <Input label="Mother's Name" value={form.motherName} onChange={fld("motherName")} placeholder="e.g. Fatema Begum" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Input label="Guardian Phone" value={form.phone} onChange={fld("phone")} placeholder="e.g. 01711-123456" required />
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.4px" }}>Join Date</label>
              <input type="date" value={form.joinDate} onChange={e => setForm(f => ({ ...f, joinDate: e.target.value }))}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1.5px solid " + C.border, fontSize: 13, color: C.text, outline: "none", background: C.white, boxSizing: "border-box", fontFamily: FONT }} />
              <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>Fee auto-renews on 1st of each month from join date</div>
            </div>
          </div>
          <Input label="Birth Certificate / NID Number" value={form.bcNumber} onChange={fld("bcNumber")} placeholder="e.g. 19901234567890123" note="Birth Certificate No. for students · NID for adults" />
          {modal === "add" && (
            <div style={{ background: C.accentLight, borderRadius: 10, padding: 12, marginBottom: 12, border: "1px solid " + C.accent + "30" }}>
              <div style={{ fontSize: 12, color: C.warning, fontWeight: 700, marginBottom: 6 }}>
                💰 Admission Fee — Batch default: {fmtTaka(batches.find(b => b.name === form.batch)?.admissionFee || 0)}
              </div>
              <Input label="Override Admission Fee (৳)" value={form.admissionFee} onChange={fld("admissionFee")} type="number" placeholder={"Leave blank to use batch default (" + (batches.find(b => b.name === form.batch)?.admissionFee || 0) + ")"} note="Only fill if different from batch default." />
            </div>
          )}
          <Select label="Batch" value={form.batch} onChange={fld("batch")} required options={[{ value: "", label: "Select batch…" }, ...batches.map(b => ({ value: b.name, label: `${b.name} — ${b.fullName}` }))]} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Input label="Monthly Fee (৳)" value={form.fee} onChange={fld("fee")} type="number" placeholder="1500" required />
            <Input label="Subject Group" value={form.subject} onChange={fld("subject")} placeholder="Science" />
          </div>
          <Select label="Default Fee Type" value={form.defaultFeeType || "full"} onChange={fld("defaultFeeType")} options={[
            { value: "full", label: "💰 Full Fee" },
            { value: "half", label: "🔰 Half Fee (50%)" },
            { value: "custom", label: "✏️ Custom Amount" },
            { value: "free", label: "🎁 Free (Waiver)" }
          ]} />
          {form.defaultFeeType === "custom" && (
            <Input label="Custom Fee Amount (৳)" value={form.customFeeAmount} onChange={fld("customFeeAmount")} type="number" placeholder="750" />
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <Btn full variant="primary" onClick={save}>{modal === "add" ? "Add Student" : "Save Changes"}</Btn>
            {modal !== "add" && <Btn variant="danger" onClick={() => del(modal.id)}>🗑️</Btn>}
            <Btn variant="soft" onClick={() => setModal(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── BATCHES ──────────────────────────────────────────────────
function UpgradePrompt({ onClose, onUpgrade }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 20, padding: 28, width: "100%", maxWidth: 420, boxShadow: "0 24px 64px rgba(0,0,0,0.25)" }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 48, marginBottom: 10 }}>🔒</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, fontFamily: "Georgia, serif" }}>Free Plan Limit Reached</div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 6, lineHeight: 1.6 }}>
            Your free plan allows <strong>2 batches</strong> and <strong>10 students per batch</strong>.<br/>Upgrade to Pro for unlimited access.
          </div>
        </div>
        <div style={{ background: C.bg, borderRadius: 14, padding: 16, marginBottom: 16 }}>
          {[["👥 Unlimited students", "No cap on growth"], ["📚 Unlimited batches", "Create as many as you need"], ["💰 Advanced reports", "Monthly income & EOD reports"], ["📱 WhatsApp messaging", "Send reminders to guardians"]].map(([t, d]) => (
            <div key={t} style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid " + C.border }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>{t.split(" ")[0]}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t.slice(t.indexOf(" ") + 1)}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{d}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <Btn full variant="accent" size="md" onClick={onUpgrade}>⭐ Monthly ৳399</Btn>
          <Btn full variant="primary" size="md" onClick={onUpgrade}>📅 Yearly ৳4,000</Btn>
        </div>
        <div style={{ fontSize: 11, color: C.muted, textAlign: "center", marginBottom: 10 }}>Yearly saves ৳788 · bKash / Nagad accepted</div>
        <a href={"https://wa.me/" + SUPPORT.whatsapp.replace(/[^0-9]/g, "")} target="_blank" rel="noreferrer"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#25D366", borderRadius: 10, padding: "12px", color: "#fff", fontSize: 13, fontWeight: 700, textDecoration: "none", marginBottom: 10 }}>
          📱 Contact Us on WhatsApp
        </a>
        <Btn full variant="soft" onClick={onClose}>Maybe Later</Btn>
      </div>
    </div>
  );
}

function Batches({ batches, setBatches, students, toast, readOnly, account, isPro, onUpgrade }) {
  const [modal, setModal] = useState(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", fullName: "", time: "", days: [], subject: "", room: "", color: C.primary, admissionFee: "" });
  const blank = { name: "", fullName: "", time: "", days: [], subject: "", room: "", color: C.primary, admissionFee: "" };
  const fld = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const BCOLORS = [C.primary, "#6D28D9", "#0369A1", "#DC2626", "#D97706", "#059669", "#9D174D"];

  const openAdd = () => {
    if (!isPro && batches.length >= 2) { setShowUpgrade(true); return; }
    setForm(blank); setModal("add");
  };
  const openEdit = (b) => { setForm({ ...b, days: Array.isArray(b.days) ? b.days : (b.days ? b.days.split(",").map(d => d.trim()) : []), admissionFee: b.admissionFee || "" }); setModal(b); };

  const save = async () => {
    if (!form.name) return;
    if (!isPro && batches.length >= 2 && modal === "add") { setShowUpgrade(true); return; }
    setSaving(true);
    const centerId = account?.id;
    if (modal === "add") {
      const { data: row, error } = await supabase.from("batches").insert({
        center_id: centerId, name: form.name, full_name: form.fullName,
        time: form.time, room: form.room,
        days: typeof form.days === "string" ? form.days.split(",").map(d => d.trim()) : (form.days || []),
        subject: form.subject, color: form.color,
        admission_fee: parseInt(form.admissionFee) || 0,
      }).select().single();
      if (error) { setSaving(false); toast("❌ " + error.message); return; }
      setBatches(b => [...b, dbToBatch(row)]);
      toast("✅ Batch created!");
    } else {
      const { error } = await supabase.from("batches").update({
        name: form.name, full_name: form.fullName, time: form.time, room: form.room,
        days: typeof form.days === "string" ? form.days.split(",").map(d => d.trim()) : (form.days || []),
        subject: form.subject, color: form.color,
        admission_fee: parseInt(form.admissionFee) || 0,
      }).eq("id", modal.id);
      if (error) { setSaving(false); toast("❌ " + error.message); return; }
      setBatches(b => b.map(x => x.id === modal.id ? { ...x, ...dbToBatch({ ...x, ...form, full_name: form.fullName }) } : x));
      toast("✅ Batch updated!");
    }
    setSaving(false);
    setModal(null);
  };

  const del = async (id) => {
    const { error } = await supabase.from("batches").delete().eq("id", id);
    if (error) { toast("❌ " + error.message); return; }
    setBatches(b => b.filter(x => x.id !== id));
    toast("🗑️ Batch removed");
    setModal(null);
  };

  return (
    <div>
      <SectionHeader title={T("batches")} action={!readOnly && <Btn variant="primary" onClick={openAdd}>➕ New Batch</Btn>} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {batches.map(b => {
          const bSt = students.filter(s => s.batch === b.name).length;
          return (
            <div key={b.id} style={{ background: C.card, borderRadius: 16, overflow: "hidden", boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }}>
              <div style={{ background: b.color || C.primary, padding: "14px 16px", color: "#fff" }}>
                <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "Georgia, serif" }}>{b.fullName || b.name}</div>
                <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{b.subject}</div>
              </div>
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.8 }}>🕐 {b.time}<br />📅 {Array.isArray(b.days) ? b.days.join(", ") : b.days}<br />{b.room && `🚪 ${b.room}`}{b.admissionFee > 0 && <><br />💰 Admission: {fmtTaka(b.admissionFee)}</>}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>👥 {bSt} students</span>
                  {!readOnly && <Btn size="sm" variant="soft" onClick={() => openEdit(b)}>✏️ Edit</Btn>}
                </div>
              </div>
            </div>
          );
        })}
        {batches.length === 0 && <div style={{ gridColumn: "1/-1" }}><EmptyState icon="📚" title="No batches yet" sub="Add your first batch to get started" /></div>}
      </div>

      {showUpgrade && <UpgradePrompt onClose={() => setShowUpgrade(false)} onUpgrade={() => { setShowUpgrade(false); onUpgrade && onUpgrade(); }} />}
      {(modal === "add" || (modal && modal.id)) && (
        <Modal title={modal === "add" ? "Create Batch" : `Edit — ${modal.fullName || modal.name}`} onClose={() => setModal(null)}>
          <Input label="Short Code (used for assignment)" value={form.name} onChange={fld("name")} placeholder="e.g. HSC-A" required />
          <Input label="Full Batch Name" value={form.fullName} onChange={fld("fullName")} placeholder="e.g. HSC Morning Batch" />
          <Input label="Class Time" value={form.time} onChange={fld("time")} placeholder="e.g. 7:00 AM – 9:00 AM" />
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.4px" }}>Class Days</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
              {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day => {
                const days = Array.isArray(form.days) ? form.days : (form.days ? form.days.split(",").map(d => d.trim()) : []);
                const checked = days.includes(day);
                return (
                  <button key={day} type="button" onClick={() => {
                    const cur = Array.isArray(form.days) ? form.days : (form.days ? form.days.split(",").map(d => d.trim()) : []);
                    const next = checked ? cur.filter(d => d !== day) : [...cur, day];
                    setForm(f => ({ ...f, days: next }));
                  }} style={{ padding: "8px 4px", borderRadius: 8, border: "2px solid " + (checked ? C.primary : C.border), background: checked ? C.primaryLight : C.bg, color: checked ? C.primary : C.muted, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                    {checked ? "✓" : ""} {day}
                  </button>
                );
              })}
            </div>
            {Array.isArray(form.days) && form.days.length > 0 && (
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Selected: {form.days.join(", ")}</div>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Input label="Subject" value={form.subject} onChange={fld("subject")} placeholder="e.g. Science" />
            <Input label="Room" value={form.room} onChange={fld("room")} placeholder="e.g. Room 1" />
          </div>
          <Input label="Admission Fee (৳) — one-time per student" value={form.admissionFee} onChange={fld("admissionFee")} type="number" placeholder="e.g. 500 (0 = no admission fee)" note="Added to expected amount for each student's first month only." />
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>Batch Color</label>
            <div style={{ display: "flex", gap: 8 }}>
              {BCOLORS.map(col => (
                <div key={col} onClick={() => setForm(f => ({ ...f, color: col }))} style={{ width: 28, height: 28, borderRadius: "50%", background: col, cursor: "pointer", border: form.color === col ? `3px solid ${C.text}` : "3px solid transparent", transition: "border 0.15s" }} />
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn full variant="primary" onClick={save}>{modal === "add" ? "Create Batch" : "Save Changes"}</Btn>
            {modal !== "add" && <Btn variant="danger" onClick={() => del(modal.id)}>🗑️</Btn>}
            <Btn variant="soft" onClick={() => setModal(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── TEACHERS ─────────────────────────────────────────────────
function Teachers({ teachers, setTeachers, batches, isPro, toast, readOnly, account }) {
  const [modal, setModal] = useState(null);
  const [selMonth, setSelMonth] = useState(MONTHS[CURRENT_MONTH - 1]);
  const blank = { name: "", subject: "", salary: "", phone: "", batches: [], status: "active", joinDate: "" };
  const [form, setForm] = useState(blank);
  const fld = (k) => (v) => setForm(f => ({ ...f, [k]: v }));

  const openEdit = (t) => { setForm({ ...t, salary: String(t.salary) }); setModal(t); };
  const openAdd = () => { setForm(blank); setModal("add"); };

  const toggleBatch = (name) => setForm(f => ({ ...f, batches: f.batches.includes(name) ? f.batches.filter(x => x !== name) : [...f.batches, name] }));

  const save = async () => {
    if (!form.name) return;
    const centerId = account?.id;
    const tData = { ...form, salary: parseInt(form.salary) || 0, avatar: initials(form.name) };
    if (modal === "add") {
      const { data: row, error } = await supabase.from("teachers").insert({
        center_id: centerId, name: tData.name, subject: tData.subject,
        salary: tData.salary, phone: tData.phone, join_date: tData.joinDate,
        avatar: tData.avatar, batches: tData.batches || [], status: tData.status || "active",
      }).select().single();
      if (error) { toast("❌ " + error.message); return; }
      setTeachers(t => [...t, dbToTeacher(row)]);
      toast("✅ Teacher added!");
    } else {
      const { error } = await supabase.from("teachers").update({
        name: tData.name, subject: tData.subject, salary: tData.salary,
        phone: tData.phone, join_date: tData.joinDate, batches: tData.batches || [],
        status: tData.status || "active",
      }).eq("id", modal.id);
      if (error) { toast("❌ " + error.message); return; }
      setTeachers(t => t.map(x => x.id === modal.id ? { ...x, ...tData } : x));
      toast("✅ Teacher updated!");
    }
    setModal(null);
  };

  const del = async (id) => {
    const { error } = await supabase.from("teachers").delete().eq("id", id);
    if (error) { toast("❌ " + error.message); return; }
    setTeachers(t => t.filter(x => x.id !== id));
    toast("🗑️ Teacher removed");
    setModal(null);
  };

  const markSalary = async (tid, mk, paid) => {
    const teacher = teachers.find(t => t.id === tid);
    if (!teacher) return;
    const newSalaryPaid = { ...teacher.salaryPaid, [mk]: paid };
    const { error } = await supabase.from("teachers")
      .update({ salary_paid: newSalaryPaid }).eq("id", tid);
    if (error) { toast("❌ " + error.message); return; }
    setTeachers(t => t.map(x => x.id === tid ? { ...x, salaryPaid: newSalaryPaid } : x));
    toast(paid ? "✅ Salary marked paid!" : "↩️ Salary unmarked");
  };

  const totalSalary = teachers.reduce((s, t) => s + t.salary, 0);

  return (
    <div>
      <SectionHeader title={T("teachers")} action={!readOnly && <Btn variant="primary" onClick={openAdd}>➕ Add Teacher</Btn>} />

      <div style={{ background: `linear-gradient(135deg, ${C.purple}, #4C1D95)`, borderRadius: 14, padding: "16px 20px", color: "#fff", marginBottom: 16 }}>
        <div style={{ fontSize: 12, opacity: 0.8 }}>Total Monthly Salary Obligation</div>
        <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "Georgia, serif" }}>{fmtTaka(totalSalary)}</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{teachers.length} active teachers</div>
      </div>

      {isPro && (
        <div style={{ background: C.card, borderRadius: 14, padding: "14px 16px", marginBottom: 16, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 10 }}>💵 Salary Management</div>
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 12 }}>
            {MONTHS.slice(0, CURRENT_MONTH + 1).map(m => (
              <button key={m} onClick={() => setSelMonth(m)} style={{ padding: "5px 12px", borderRadius: 20, border: "none", fontSize: 12, fontWeight: 600, background: selMonth === m ? C.purple : C.bg, color: selMonth === m ? "#fff" : C.muted, cursor: "pointer", whiteSpace: "nowrap" }}>{m}</button>
            ))}
          </div>
          {teachers.map(t => {
            const mk = `${selMonth}-${CURRENT_YEAR}`;
            const paid = t.salaryPaid?.[mk];
            return (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                <Av label={t.avatar} size={34} bg={C.purple} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t.name}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{fmtTaka(t.salary)}</div>
                </div>
                {paid ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <Badge text="Paid ✓" type="paid" small />
                    <Btn size="sm" variant="soft" onClick={() => markSalary(t.id, mk, false)}>↩️</Btn>
                  </div>
                ) : (
                  <Btn size="sm" variant="success" onClick={() => markSalary(t.id, mk, true)}>{T("markPaid")}</Btn>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {teachers.map(t => (
          <div key={t.id} style={{ background: C.card, borderRadius: 14, padding: "14px 16px", boxShadow: "0 1px 8px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 12 }}>
            <Av label={t.avatar} size={46} bg={C.purple} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{t.name}</div>
              <div style={{ fontSize: 12, color: C.muted }}>{t.subject}</div>
              <div style={{ fontSize: 12, color: C.muted }}>📞 {t.phone} · Joined {t.joinDate}</div>
              <div style={{ fontSize: 12, color: C.muted }}>Batches: {t.batches?.join(", ") || "—"}</div>
            </div>
            <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: C.purple }}>{fmtTaka(t.salary)}</div>
              {!readOnly && <Btn size="sm" variant="soft" onClick={() => openEdit(t)}>✏️ Edit</Btn>}
            </div>
          </div>
        ))}
        {teachers.length === 0 && <EmptyState icon="👨‍🏫" title="No teachers yet" sub="Add your first teacher" />}
      </div>

      {(modal === "add" || (modal && modal.id)) && (
        <Modal title={modal === "add" ? "Add Teacher" : `Edit — ${modal.name}`} onClose={() => setModal(null)}>
          <Input label="Teacher Name" value={form.name} onChange={fld("name")} placeholder="e.g. Mr. Aminul Islam" required />
          <Input label="Subjects" value={form.subject} onChange={fld("subject")} placeholder="e.g. Physics & Math" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Input label="Monthly Salary (৳)" value={form.salary} onChange={fld("salary")} type="number" placeholder="15000" />
            <Input label="Join Date" value={form.joinDate} onChange={fld("joinDate")} placeholder="Jan 2020" />
          </div>
          <Input label="Phone Number" value={form.phone} onChange={fld("phone")} placeholder="01711-123456" />
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>Assigned Batches</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {batches.map(b => (
                <button key={b.id} onClick={() => toggleBatch(b.name)} style={{ padding: "5px 12px", borderRadius: 20, border: `1.5px solid ${form.batches?.includes(b.name) ? C.primary : C.border}`, background: form.batches?.includes(b.name) ? C.primary : C.bg, color: form.batches?.includes(b.name) ? "#fff" : C.text, fontSize: 13, cursor: "pointer", fontWeight: 600 }}>{b.name}</button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn full variant="primary" onClick={save}>{modal === "add" ? "Add Teacher" : "Save Changes"}</Btn>
            {modal !== "add" && <Btn variant="danger" onClick={() => del(modal.id)}>🗑️</Btn>}
            <Btn variant="soft" onClick={() => setModal(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── FEES ─────────────────────────────────────────────────────
// Two views:
//  1. "By Month"  — pick a month, see all students' status for that month
//  2. "By Student" — pick a student, see their full 12-month ledger + pay any month
function Fees({ students, batches, payments, setPayments, isPro, toast, feeOverrides = {}, setFeeOverrides = () => {}, staffMode, staffRole, onPaymentLogged, account, setStudents }) {
  const [view, setView] = useState("month");
  const [overrideModal, setOverrideModal] = useState(null);
  const [overrideType, setOverrideType] = useState("full");
  const [overrideAmt, setOverrideAmt] = useState("");           // "month" | "student"
  const [selMonthIdx, setSelMonthIdx] = useState(CURRENT_MONTH);
  const [filterBatch, setFilterBatch] = useState("all");
  const [selStudentId, setSelStudentId] = useState(null);
  const [payModal, setPayModal] = useState(null);       // { student, monthIdx }
  const [receiptModal, setReceiptModal] = useState(null); // { student, monthIdx, method, amount } — shown after payment
  const [bulkModal, setBulkModal] = useState(null);     // { student }
  const [bulkMonths, setBulkMonths] = useState([]);
  const [bulkMethod, setBulkMethod] = useState("Cash");
  const [search, setSearch] = useState("");
  const searchRef = useRef(null);

  // ── helpers ──
  const monthKey = (idx) => `${MONTHS[idx]}-${CURRENT_YEAR}`;
  const getStatus = (sId, idx) => payments[sId]?.[monthKey(idx)]?.status || "upcoming";
  const statusColor = (st) => st === "paid" ? C.success : st === "unpaid" ? C.danger : st === "overdue" ? C.danger : C.muted;
  const statusBg = (st) => st === "paid" ? C.successLight : st === "unpaid" ? C.warningLight : C.bg;
  const methodIcon = (m) => ({ Cash: "💵", bKash: "📱", Nagad: "🟠", Rocket: "🟣", "Bank Transfer": "🏦" }[m] || "💳");
  const getEffFee = (s, idx) => getEffectiveFee(s, monthKey(idx), feeOverrides);

  const setOverride = async (studentId, idx, type, amount) => {
    const mk = monthKey(idx);
    const { error } = await supabase.from("fee_overrides").upsert({
      center_id: account?.id, student_id: studentId, month_key: mk,
      type, amount: amount || 0,
    }, { onConflict: "student_id,month_key" });
    if (error) { toast("❌ " + error.message); return; }
    setFeeOverrides(prev => ({
      ...prev,
      [studentId]: { ...(prev[studentId] || {}), [mk]: { type, amount: amount || 0 } }
    }));
  };


  const recordPayment = async (studentId, monthIdx, method) => {
    const mk = monthKey(monthIdx);
    const student = students.find(s => s.id === studentId);
    const amt = getEffectiveFee(student, mk, feeOverrides);
    const paidDate = `${MONTHS[monthIdx].slice(0, 3)} ${new Date().getDate()}, ${CURRENT_YEAR}`;
    const recBy = staffMode ? "Staff" : "Owner";
    const recAt = new Date().toISOString();
    // Upsert payment in Supabase
    const { error } = await supabase.from("payments").upsert({
      center_id: account?.id, student_id: studentId, month_key: mk,
      status: "paid", paid_date: paidDate, method, recorded_by: recBy,
      recorded_at: recAt, amount: amt,
    }, { onConflict: "student_id,month_key" });
    if (error) { toast("❌ " + error.message); return; }
    setPayments(p => ({ ...p, [studentId]: { ...p[studentId], [mk]: { status: "paid", paidDate, method, recordedBy: recBy, recordedAt: recAt, amount: amt } } }));
    if (onPaymentLogged) onPaymentLogged({ studentName: student?.name, month: MONTHS[monthIdx], method, amount: amt });
    toast(`✅ ${MONTHS[monthIdx]} fee recorded (${method})!`);
    setPayModal(null);
    setReceiptModal({ student, monthIdx, method, amount: amt });
  };

  const reversePayment = async (studentId, monthIdx) => {
    const mk = monthKey(monthIdx);
    const wasUpcoming = monthIdx > CURRENT_MONTH;
    const newStatus = wasUpcoming ? "upcoming" : "unpaid";
    const { error } = await supabase.from("payments").upsert({
      center_id: account?.id, student_id: studentId, month_key: mk,
      status: newStatus, paid_date: null, method: null, recorded_by: null, recorded_at: null, amount: null,
    }, { onConflict: "student_id,month_key" });
    if (error) { toast("❌ " + error.message); return; }
    setPayments(p => ({ ...p, [studentId]: { ...p[studentId], [mk]: { status: newStatus } } }));
    toast("↩️ Payment reversed");
  };

  const recordBulk = async () => {
    if (!bulkModal || bulkMonths.length === 0) return;
    const recBy = staffMode ? "Staff" : "Owner";
    const recAt = new Date().toISOString();
    const rows = bulkMonths.map(idx => ({
      center_id: account?.id, student_id: bulkModal.id, month_key: monthKey(idx),
      status: "paid",
      paid_date: `${MONTHS[idx].slice(0, 3)} ${new Date().getDate()}, ${CURRENT_YEAR}`,
      method: bulkMethod, recorded_by: recBy, recorded_at: recAt,
      amount: getEffectiveFee(bulkModal, monthKey(idx), feeOverrides),
    }));
    const { error } = await supabase.from("payments").upsert(rows, { onConflict: "student_id,month_key" });
    if (error) { toast("❌ " + error.message); return; }
    setPayments(p => {
      const np = { ...p, [bulkModal.id]: { ...p[bulkModal.id] } };
      bulkMonths.forEach(idx => {
        np[bulkModal.id][monthKey(idx)] = { status: "paid", paidDate: `${MONTHS[idx].slice(0, 3)} ${new Date().getDate()}, ${CURRENT_YEAR}`, method: bulkMethod, recordedBy: recBy, recordedAt: recAt };
      });
      return np;
    });
    const total = bulkMonths.reduce((a, idx) => a + getEffectiveFee(bulkModal, monthKey(idx), feeOverrides), 0);
    if (onPaymentLogged) bulkMonths.forEach(idx => onPaymentLogged({ studentName: bulkModal.name, month: MONTHS[idx], method: bulkMethod, amount: getEffectiveFee(bulkModal, monthKey(idx), feeOverrides), bulk: true }));
    toast(`✅ ${bulkMonths.length} month(s) paid — ${fmtTaka(total)} (${bulkMethod})`);
    setBulkModal(null);
    setBulkMonths([]);
  };

  const toggleBulkMonth = (idx) => setBulkMonths(m => m.includes(idx) ? m.filter(x => x !== idx) : [...m, idx]);

  // ── search + filter ──
  const searchQuery = search.trim().toLowerCase();
  const searchFiltered = searchQuery
    ? students.filter(s =>
        s.name.toLowerCase().includes(searchQuery) ||
        s.roll.toLowerCase().includes(searchQuery) ||
        s.phone.toLowerCase().includes(searchQuery) ||
        s.guardian.toLowerCase().includes(searchQuery)
      )
    : null; // null = no active search

  // ── month-view data ──
  const filtered = (searchFiltered || students).filter(s => filterBatch === "all" || s.batch === filterBatch);
  const mIdx = selMonthIdx;
  const mCollected = filtered.filter(s => getStatus(s.id, mIdx) === "paid").reduce((a, s) => a + getEffFee(s, mIdx), 0);
  const mExpFee = (s, idx) => getExpectedFee(s, monthKey(idx), feeOverrides, batches);
  const mPending = filtered.filter(s => getStatus(s.id, mIdx) === "unpaid").reduce((a, s) => a + mExpFee(s, mIdx), 0);
  const mWaived = filtered.reduce((a, s) => a + Math.max(0, s.fee - getEffFee(s, mIdx)), 0);
  const mTotal = filtered.reduce((a, s) => a + mExpFee(s, mIdx), 0); // expected (incl. first-month admission fee)
  const mPct = mTotal > 0 ? Math.round(mCollected / mTotal * 100) : 0;
  const relLabel = mIdx < CURRENT_MONTH ? "Previous" : mIdx === CURRENT_MONTH ? "Current" : "Advance";
  const relColor = mIdx < CURRENT_MONTH ? C.info : mIdx === CURRENT_MONTH ? C.success : C.purple;

  // ── student-view data ──
  const selStudent = students.find(s => s.id === selStudentId);
  const studentTotalDue = selStudent ? MONTHS.reduce((a, _, i) => {
    const st = getStatus(selStudent.id, i);
    return st === "unpaid" ? a + selStudent.fee : a;
  }, 0) : 0;
  const studentAdvancePaid = selStudent ? MONTHS.slice(CURRENT_MONTH + 1).filter((_, i) => getStatus(selStudent.id, CURRENT_MONTH + 1 + i) === "paid").length : 0;

  return (
    <div>
      {/* Header with view toggle */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text, fontFamily: "Georgia, serif" }}>{T("feeManagement")}</h2>
        <div style={{ display: "flex", background: C.bg, borderRadius: 10, padding: 3, border: `1px solid ${C.border}` }}>
          {[["month", "📅 By Month"], ["student", "👤 By Student"]].map(([v, l]) => (
            <button key={v} onClick={() => setView(v)} style={{ padding: "6px 11px", borderRadius: 8, border: "none", fontSize: 11, fontWeight: 700, background: view === v ? C.primary : "transparent", color: view === v ? "#fff" : C.muted, cursor: "pointer" }}>{l}</button>
          ))}
        </div>
      </div>

      {/* ── Global Search Bar ── */}
      <div style={{ position: "relative", marginBottom: 14 }}>
        <div style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", fontSize: 16, pointerEvents: "none" }}>🔍</div>
        <input
          ref={searchRef}
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            // If exactly one result found, auto-jump to student view
            const q = e.target.value.trim().toLowerCase();
            if (q) {
              const matches = students.filter(s =>
                s.name.toLowerCase().includes(q) ||
                s.roll.toLowerCase().includes(q) ||
                s.phone.toLowerCase().includes(q) ||
                s.guardian.toLowerCase().includes(q)
              );
              if (matches.length === 1) {
                setSelStudentId(matches[0].id);
              }
            }
          }}
          placeholder="Search by name, roll number, or phone…"
          style={{ width: "100%", padding: "11px 40px 11px 40px", borderRadius: 12, border: `2px solid ${search ? C.primary : C.border}`, fontSize: 14, outline: "none", background: C.white, boxSizing: "border-box", fontFamily: "inherit", transition: "border 0.2s", fontWeight: 500 }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: C.muted, border: "none", borderRadius: "50%", width: 20, height: 20, color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>×</button>
        )}
      </div>

      {/* Search results overlay */}
      {search && searchFiltered && (
        <div style={{ marginBottom: 14 }}>
          {searchFiltered.length === 0 ? (
            <div style={{ background: C.dangerLight, borderRadius: 12, padding: "12px 16px", fontSize: 13, color: C.danger, fontWeight: 600 }}>
              😕 No students found for "{search}"
            </div>
          ) : (
            <div style={{ background: C.infoLight, borderRadius: 12, padding: "10px 14px", border: `1px solid ${C.info}30` }}>
              <div style={{ fontSize: 12, color: C.info, fontWeight: 700, marginBottom: searchFiltered.length > 1 ? 8 : 0 }}>
                🔍 {searchFiltered.length} student{searchFiltered.length > 1 ? "s" : ""} found
                {searchFiltered.length === 1 && " — showing full ledger below"}
              </div>
              {searchFiltered.length > 1 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {searchFiltered.map(s => {
                    const st = getStatus(s.id, CURRENT_MONTH);
                    return (
                      <div key={s.id} onClick={() => { setSelStudentId(s.id); setView("student"); setSearch(""); }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: C.white, borderRadius: 10, cursor: "pointer", border: `1px solid ${C.border}` }}>
                        <Av label={s.avatar} size={34} bg={st === "paid" ? C.success : C.warning} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{s.name}</div>
                          <div style={{ fontSize: 11, color: C.muted }}>Roll {s.roll} · {s.batch} · {s.phone}</div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                          <Badge text={st === "paid" ? "Paid ✓" : "Due ⚠️"} type={st === "paid" ? "paid" : "due"} small />
                          <span style={{ fontSize: 11, color: C.primary, fontWeight: 600 }}>View →</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {searchFiltered.length === 1 && (() => {
                // Auto-show student ledger inline when exactly 1 match
                const s = searchFiltered[0];
                const currentStatus = getStatus(s.id, CURRENT_MONTH);
                const due = MONTHS.reduce((a, _, i) => getStatus(s.id, i) === "unpaid" ? a + s.fee : a, 0);
                return (
                  <div style={{ marginTop: 8, background: C.white, borderRadius: 10, padding: "10px 12px", border: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                      <Av label={s.avatar} size={40} bg={currentStatus === "paid" ? C.success : C.warning} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{s.name}</div>
                        <div style={{ fontSize: 12, color: C.muted }}>Roll {s.roll} · {s.batch} · {s.phone}</div>
                        <div style={{ fontSize: 12, color: C.muted }}>Guardian: {s.guardian}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: C.primary }}>{fmtTaka(s.fee)}/mo</div>
                        {due > 0 && <div style={{ fontSize: 12, color: C.danger, fontWeight: 600 }}>Due: {fmtTaka(due)}</div>}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {MONTHS.map((m, i) => {
                        const st = getStatus(s.id, i);
                        const pay = payments[s.id]?.[`${m}-${CURRENT_YEAR}`];
                        return (
                          <div key={m} onClick={() => { if (st !== "paid") setPayModal({ student: s, monthIdx: i }); }} style={{ flex: "0 0 calc(25% - 5px)", background: st === "paid" ? C.successLight : st === "unpaid" ? C.warningLight : C.bg, borderRadius: 8, padding: "7px 4px", textAlign: "center", cursor: st !== "paid" ? "pointer" : "default", border: `1px solid ${st === "paid" ? C.success + "40" : st === "unpaid" ? C.warning + "40" : C.border}` }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: st === "paid" ? C.success : st === "unpaid" ? C.warning : C.muted }}>{m.slice(0, 3)}</div>
                            <div style={{ fontSize: 9, color: st === "paid" ? C.success : st === "unpaid" ? C.danger : C.subtle }}>
                              {st === "paid" ? "✓ Paid" : st === "unpaid" ? "⚠️ Due" : "—"}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                      <Btn full variant="success" size="sm" onClick={() => { setPayModal({ student: s, monthIdx: CURRENT_MONTH }); }}>💰 Pay March</Btn>
                      <Btn full variant="soft" size="sm" onClick={() => { setBulkModal(s); setBulkMonths([]); setBulkMethod("Cash"); }}>⚡ Multi-Month</Btn>
                      <Btn full variant="primary" size="sm" onClick={() => { setSelStudentId(s.id); setView("student"); setSearch(""); }}>📋 Full Ledger</Btn>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}


      {view === "month" && (
        <div>
          {/* Month tabs with type labels */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, fontWeight: 600 }}>
              🔵 Previous &nbsp;|&nbsp; 🟢 Current &nbsp;|&nbsp; 🟣 Advance/Future
            </div>
            <div style={{ display: "flex", gap: 5, overflowX: "auto", paddingBottom: 6 }}>
              {MONTHS.map((m, i) => {
                const isActive = selMonthIdx === i;
                const bg = isActive ? (i < CURRENT_MONTH ? C.info : i === CURRENT_MONTH ? C.success : C.purple) : C.bg;
                const dot = i < CURRENT_MONTH ? "🔵" : i === CURRENT_MONTH ? "🟢" : "🟣";
                return (
                  <button key={m} onClick={() => setSelMonthIdx(i)} style={{ padding: "6px 11px", borderRadius: 20, border: "none", fontSize: 11, fontWeight: 700, background: bg, color: isActive ? "#fff" : C.muted, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>
                    {isActive ? m.slice(0, 3) : m.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Month context banner */}
          <div style={{ background: `${relColor}15`, border: `1px solid ${relColor}30`, borderRadius: 12, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: relColor }}>{MONTHS[mIdx]} {CURRENT_YEAR}</div>
              <div style={{ fontSize: 12, color: C.muted }}>{relLabel} month · {mIdx < CURRENT_MONTH ? "Past due tracking" : mIdx === CURRENT_MONTH ? "Active collection" : "Advance payment accepted"}</div>
            </div>
            <Badge text={relLabel} type={mIdx < CURRENT_MONTH ? "active" : mIdx === CURRENT_MONTH ? "paid" : "purple"} />
          </div>

          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
            {[[fmtTaka(mTotal), "Expected", C.infoLight, C.info], [fmtTaka(mCollected), "Collected", C.successLight, C.success], [fmtTaka(mWaived), "Waived", C.purpleLight, C.purple], [fmtTaka(mPending), "Pending", C.warningLight, C.warning]].map(([val, label, bg, col]) => (
              <div key={label} style={{ background: bg, borderRadius: 10, padding: "8px 4px", textAlign: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: col }}>{val}</div>
                <div style={{ fontSize: 10, color: col, fontWeight: 600 }}>{label}</div>
              </div>
            ))}
          </div>

          <div style={{ background: "#F0EDE8", borderRadius: 6, height: 7, overflow: "hidden", marginBottom: 14 }}>
            <div style={{ background: relColor, height: "100%", width: `${mPct}%`, borderRadius: 6, transition: "width 0.8s" }} />
          </div>

          {/* Batch filter */}
          <select value={filterBatch} onChange={e => setFilterBatch(e.target.value)} style={{ width: "100%", padding: "9px 14px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, background: C.bg, color: C.text, outline: "none", fontFamily: "inherit", marginBottom: 12 }}>
            <option value="all">All Batches ({filtered.length} students)</option>
            {batches.map(b => <option key={b.id} value={b.name}>{b.name} — {b.fullName} ({students.filter(s => s.batch === b.name).length})</option>)}
          </select>

          {/* Student rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map(s => {
              const st = getStatus(s.id, mIdx);
              const pay = payments[s.id]?.[monthKey(mIdx)];
              return (
                <div key={s.id} style={{ background: C.card, borderRadius: 12, padding: "12px 14px", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", borderLeft: `3px solid ${st === "paid" ? C.success : st === "unpaid" ? C.danger : C.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Av label={s.avatar} size={38} bg={st === "paid" ? C.success : st === "unpaid" ? C.warning : C.muted} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: C.muted }}>{s.batch} · Roll {s.roll}</div>
                      {st === "paid" && pay && <div style={{ fontSize: 11, color: C.success }}>✓ {pay.paidDate} · {methodIcon(pay.method)} {pay.method}{pay.recordedBy ? <span style={{ color: C.muted }}> · by {pay.recordedBy}</span> : ""}</div>}
                      {st === "unpaid" && <div style={{ fontSize: 11, color: C.danger }}>⚠️ Not paid yet</div>}
                      {st === "upcoming" && <div style={{ fontSize: 11, color: C.muted }}>Future month — advance payment accepted</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                      <div style={{ textAlign: "right" }}>
                        <span style={{ fontSize: 14, fontWeight: 800, color: statusColor(st) }}>{fmtTaka(mExpFee(s, mIdx))}</span>
                        {getEffFee(s, mIdx) < s.fee && <div style={{ fontSize: 10, color: C.purple, fontWeight: 600 }}>disc. from {fmtTaka(s.fee)}</div>}
                      </div>
                      {st === "paid" && (
                        <div style={{ display: "flex", gap: 4 }}>
                          {!staffMode && <Btn size="sm" variant="soft" onClick={() => reversePayment(s.id, mIdx)}>↩️</Btn>}
                          <Btn size="sm" variant="soft" onClick={() => { setSelStudentId(s.id); setView("student"); }}>📋</Btn>
                        </div>
                      )}
                      {(st === "unpaid" || st === "upcoming") && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          {!staffMode && <Btn size="sm" variant="soft" style={{ fontSize: 10 }} onClick={() => { setOverrideModal({ student: s, monthIdx: mIdx }); setOverrideType(feeOverrides?.[s.id]?.[monthKey(mIdx)]?.type || s.defaultFeeType || "full"); setOverrideAmt(feeOverrides?.[s.id]?.[monthKey(mIdx)]?.amount || ""); }}>🏷️</Btn>}
                          {isPro && st === "unpaid" && <Btn size="sm" variant="accent" onClick={() => {
                            const phone = s.phone.replace(/[^0-9]/g, "");
                            const bdPhone = phone.startsWith("0") ? "880" + phone.slice(1) : phone;
                            const msg = "আদরের অভিভাবক,\n\n" + s.name + "-এর " + MONTHS[mIdx] + " " + CURRENT_YEAR + " মাসের বেতন (৳" + getEffFee(s, mIdx).toLocaleString() + ") এখনও পরিশোধ হয়নি।\n\nঅনুগ্রহ করে দ্রুত পরিশোধ করুন।\n\nধন্যবাদ।";
                            window.open("https://wa.me/" + bdPhone + "?text=" + encodeURIComponent(msg), "_blank");
                          }}>📲</Btn>}
                          <Btn size="sm" variant="success" onClick={() => setPayModal({ student: s, monthIdx: mIdx })}>
                            {st === "upcoming" ? "⏩ Pay Advance" : "Mark Paid"}
                          </Btn>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══════════════ BY STUDENT VIEW ══════════════ */}
      {view === "student" && (
        <div>
          {/* Student picker */}
          <div style={{ marginBottom: 14 }}>
            <select value={selStudentId || ""} onChange={e => setSelStudentId(Number(e.target.value) || null)}
              style={{ width: "100%", padding: "11px 14px", borderRadius: 12, border: `2px solid ${C.primary}40`, fontSize: 14, background: C.bg, color: C.text, outline: "none", fontFamily: "inherit", fontWeight: 600 }}>
              <option value="">— Select a student —</option>
              {searchFiltered && searchFiltered.length > 0 && (
                <optgroup label={`🔍 Search results (${searchFiltered.length})`}>
                  {searchFiltered.map(s => (
                    <option key={s.id} value={s.id}>{s.name} (Roll {s.roll}) — {fmtTaka(s.fee)}/mo</option>
                  ))}
                </optgroup>
              )}
              {batches.map(b => (
                <optgroup key={b.id} label={`${b.name} — ${b.fullName}`}>
                  {students.filter(s => s.batch === b.name).map(s => (
                    <option key={s.id} value={s.id}>{s.name} (Roll {s.roll}) — {fmtTaka(s.fee)}/mo</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {!selStudent && (
            <EmptyState icon="👤" title="Select a student" sub="Choose a student above to view their full fee ledger and make payments for any month — including future months." />
          )}

          {selStudent && (
            <div>
              {/* Student card */}
              <div style={{ background: `linear-gradient(135deg, ${C.primary}, #1a5c45)`, borderRadius: 16, padding: 18, color: "#fff", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <Av label={selStudent.avatar} size={50} bg="rgba(255,255,255,0.15)" />
                    <div>
                      <div style={{ fontSize: 17, fontWeight: 800, fontFamily: "Georgia, serif" }}>{selStudent.name}</div>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>Roll {selStudent.roll} · {selStudent.batch} · {selStudent.subject}</div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>Guardian: {selStudent.guardian} · {selStudent.phone}</div>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <div style={{ flex: 1, background: "rgba(255,255,255,0.12)", borderRadius: 10, padding: "9px 12px", textAlign: "center" }}>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>{fmtTaka(selStudent.fee)}</div>
                    <div style={{ fontSize: 10, opacity: 0.8 }}>Monthly Fee</div>
                  </div>
                  <div style={{ flex: 1, background: "rgba(255,255,255,0.12)", borderRadius: 10, padding: "9px 12px", textAlign: "center" }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: studentTotalDue > 0 ? "#FCA5A5" : "#86EFAC" }}>{fmtTaka(studentTotalDue)}</div>
                    <div style={{ fontSize: 10, opacity: 0.8 }}>Total Due</div>
                  </div>
                  <div style={{ flex: 1, background: "rgba(255,255,255,0.12)", borderRadius: 10, padding: "9px 12px", textAlign: "center" }}>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>{studentAdvancePaid}</div>
                    <div style={{ fontSize: 10, opacity: 0.8 }}>Advance Paid</div>
                  </div>
                </div>
              </div>

              {/* Bulk payment button */}
              <Btn full variant="accent" style={{ marginBottom: 14 }} onClick={() => { setBulkModal(selStudent); setBulkMonths([]); setBulkMethod("Cash"); }}>
                ⚡ Pay Multiple Months at Once
              </Btn>

              {/* 12-month ledger */}
              <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 10 }}>📋 Full Fee Ledger — {CURRENT_YEAR}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {MONTHS.map((m, i) => {
                  const st = getStatus(selStudent.id, i);
                  const pay = payments[selStudent.id]?.[monthKey(i)];
                  const isCurrentOrPast = i <= CURRENT_MONTH;
                  const isFuture = i > CURRENT_MONTH;
                  const typeLabel = i < CURRENT_MONTH ? "Past" : i === CURRENT_MONTH ? "Current" : "Future";
                  const typeBadgeType = i < CURRENT_MONTH ? "active" : i === CURRENT_MONTH ? "paid" : "purple";

                  return (
                    <div key={m} style={{ background: C.card, borderRadius: 12, padding: "11px 14px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", borderLeft: `3px solid ${st === "paid" ? C.success : st === "unpaid" ? C.danger : i === CURRENT_MONTH ? C.success : C.border}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 40, textAlign: "center", flexShrink: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 800, color: st === "paid" ? C.success : C.text }}>{m.slice(0, 3)}</div>
                          <div style={{ fontSize: 9, color: C.muted }}>{typeLabel}</div>
                        </div>
                        <div style={{ flex: 1 }}>
                          {st === "paid" && pay && (
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: C.success }}>✅ Paid</div>
                              <div style={{ fontSize: 11, color: C.muted }}>{pay.paidDate} · {methodIcon(pay.method)} {pay.method}</div>
                            </div>
                          )}
                          {st === "unpaid" && (
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: C.danger }}>⚠️ Not Paid</div>
                              <div style={{ fontSize: 11, color: C.muted }}>{i < CURRENT_MONTH ? "Overdue" : "Due this month"}</div>
                            </div>
                          )}
                          {st === "upcoming" && (
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>⏳ Not yet due</div>
                              <div style={{ fontSize: 11, color: C.muted }}>Advance payment accepted</div>
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: statusColor(st) }}>{fmtTaka(selStudent.fee)}</span>
                          {st === "paid" && !staffMode && <Btn size="sm" variant="soft" onClick={() => reversePayment(selStudent.id, i)}>↩️</Btn>}
                          {(st === "unpaid" || st === "upcoming") && (
                            <Btn size="sm" variant={isFuture ? "soft" : "success"} style={isFuture ? { border: `1.5px solid ${C.purple}`, color: C.purple } : {}} onClick={() => setPayModal({ student: selStudent, monthIdx: i })}>
                              {isFuture ? "⏩ Advance" : "Pay Now"}
                            </Btn>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Year summary */}
              <div style={{ background: C.card, borderRadius: 14, padding: 16, marginTop: 14, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
                <div style={{ fontWeight: 700, color: C.text, fontSize: 14, marginBottom: 12 }}>📊 Year Summary</div>
                {[
                  ["Paid months", MONTHS.filter((_, i) => getStatus(selStudent.id, i) === "paid").length, C.success],
                  ["Unpaid months", MONTHS.filter((_, i) => getStatus(selStudent.id, i) === "unpaid").length, C.danger],
                  ["Advance paid (future)", studentAdvancePaid, C.purple],
                  ["Total collected", MONTHS.filter((_, i) => getStatus(selStudent.id, i) === "paid").length * selStudent.fee, C.success, true],
                  ["Total outstanding", studentTotalDue, C.danger, true],
                ].map(([label, val, col, isMoney]) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                    <span style={{ color: C.text }}>{label}</span>
                    <span style={{ fontWeight: 700, color: col }}>{isMoney ? fmtTaka(val) : val}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Single payment modal ── */}
      {payModal && (
        <Modal title={`Record Payment — ${payModal.student.name}`} onClose={() => setPayModal(null)}>
          <div style={{ background: payModal.monthIdx > CURRENT_MONTH ? C.purpleLight : C.accentLight, borderRadius: 12, padding: 16, marginBottom: 16, textAlign: "center" }}>
            {payModal.monthIdx > CURRENT_MONTH && (
              <div style={{ fontSize: 12, color: C.purple, fontWeight: 700, marginBottom: 4 }}>⏩ ADVANCE PAYMENT</div>
            )}
            <div style={{ fontSize: 12, color: C.muted }}>Month</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.primary, fontFamily: "Georgia, serif" }}>{MONTHS[payModal.monthIdx]} {CURRENT_YEAR}</div>
            {(() => {
              const eff = getEffFee(payModal.student, payModal.monthIdx);
              const orig = payModal.student.fee;
              return (
                <>
                  <div style={{ fontSize: 28, fontWeight: 900, color: payModal.monthIdx > CURRENT_MONTH ? C.purple : C.primary, fontFamily: "Georgia, serif", marginTop: 4 }}>{fmtTaka(eff)}</div>
                  {eff < orig && <div style={{ fontSize: 12, color: C.purple, marginTop: 2 }}>Discounted from {fmtTaka(orig)} · saving {fmtTaka(orig - eff)}</div>}
                </>
              );
            })()}
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{payModal.student.name} · {payModal.student.batch}</div>
          </div>
          <div style={{ fontWeight: 600, fontSize: 13, color: C.text, marginBottom: 10 }}>Select Payment Method:</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
            {["Cash", "bKash", "Nagad", "Rocket", "Bank Transfer"].map(method => (
              <button key={method} onClick={() => recordPayment(payModal.student.id, payModal.monthIdx, method)} style={{ padding: "13px 10px", borderRadius: 12, border: `1.5px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {methodIcon(method)} {method}
              </button>
            ))}
          </div>
          <div style={{ background: "#F0FDF4", borderRadius: 10, padding: "8px 12px", marginBottom: 10, fontSize: 12, color: C.success, border: "1px solid #BBF7D0" }}>
            📱 After selecting method, a WhatsApp receipt option will appear to send to the guardian.
          </div>
          <Btn full variant="soft" onClick={() => setPayModal(null)}>Cancel</Btn>
        </Modal>
      )}

      {/* ── WhatsApp Receipt Modal ── */}
      {receiptModal && (() => {
        const s = receiptModal.student;
        const phone = (s.phone || "").replace(/[^0-9]/g, "");
        const bdPhone = phone.startsWith("0") ? "880" + phone.slice(1) : phone;
        const parentName = s.fatherName || s.motherName || s.guardian || "অভিভাবক";
        const month = MONTHS[receiptModal.monthIdx];
        const receiptLines = [
          "আদরের " + parentName + ",",
          "",
          "আপনার সন্তান " + s.name + "-এর " + month + " " + CURRENT_YEAR + " মাসের বেতন সফলভাবে গ্রহণ করা হয়েছে।",
          "",
          "পরিমাণ: " + (receiptModal.amount || 0).toLocaleString() + " টাকা",
          "পদ্ধতি: " + receiptModal.method,
          "তারিখ: " + new Date().toLocaleDateString("en-BD"),
          "",
          "ধন্যবাদ আপনার সময়মতো পরিশোধের জন্য। 🙏"
        ];
        const msg = receiptLines.join("\n");
        const waURL = "https://wa.me/" + bdPhone + "?text=" + encodeURIComponent(msg);
        return (
          <Modal title="✅ Payment Recorded!" onClose={() => setReceiptModal(null)}>
            {/* Success banner */}
            <div style={{ background: C.successLight, borderRadius: 14, padding: 16, marginBottom: 16, textAlign: "center", border: "1px solid " + C.success + "30" }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: C.success }}>{fmtTaka(receiptModal.amount)}</div>
              <div style={{ fontSize: 13, color: C.success, marginTop: 2 }}>{month} {CURRENT_YEAR} · {receiptModal.method}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{s.name} · {s.batch}</div>
            </div>

            {/* Receipt preview */}
            <div style={{ background: C.bg, borderRadius: 12, padding: 14, marginBottom: 16, border: "1px solid " + C.border }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                <span>📋</span> RECEIPT PREVIEW (will send on WhatsApp)
              </div>
              <div style={{ fontSize: 13, color: C.text, lineHeight: 1.8, whiteSpace: "pre-wrap", fontFamily: "monospace", background: C.white, borderRadius: 8, padding: "10px 12px" }}>
                {receiptLines.join("\n")}
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <a href={waURL} target="_blank" rel="noreferrer" onClick={() => setReceiptModal(null)}
                style={{ flex: 1, background: "#25D366", borderRadius: 10, padding: "13px 10px", color: "#fff", fontSize: 14, fontWeight: 700, textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                📱 Send on WhatsApp
              </a>
              <Btn variant="soft" onClick={() => setReceiptModal(null)}>Skip</Btn>
            </div>
            <div style={{ fontSize: 11, color: C.muted, textAlign: "center", marginTop: 8 }}>
              Opens WhatsApp with receipt pre-filled · Guardian: {parentName} · {s.phone}
            </div>
          </Modal>
        );
      })()}

      {/* ── Fee Override Modal ── */}
      {overrideModal && (
        <Modal title={`Fee Override — ${overrideModal.student.name}`} onClose={() => setOverrideModal(null)}>
          <div style={{ background: C.infoLight, borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 13, color: C.info }}>
            Override this student's fee for <strong>{MONTHS[overrideModal.monthIdx]} {CURRENT_YEAR}</strong> only. Default is {fmtTaka(overrideModal.student.fee)}.
          </div>
          <Select label="Fee Type for This Month" value={overrideType} onChange={setOverrideType} options={[
            { value: "full", label: `💰 Full Fee — ${fmtTaka(overrideModal.student.fee)}` },
            { value: "half", label: `🔰 Half Fee — ${fmtTaka(Math.floor(overrideModal.student.fee / 2))}` },
            { value: "custom", label: "✏️ Custom Amount" },
            { value: "free", label: "🎁 Free (Waiver)" }
          ]} />
          {overrideType === "custom" && (
            <Input label="Amount (৳)" value={overrideAmt} onChange={setOverrideAmt} type="number" placeholder="750" />
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Btn full variant="primary" onClick={() => { setOverride(overrideModal.student.id, overrideModal.monthIdx, overrideType, parseInt(overrideAmt) || 0); toast("✅ Fee override saved!"); setOverrideModal(null); }}>Save Override</Btn>
            <Btn variant="soft" onClick={() => setOverrideModal(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* ── Bulk/multi-month payment modal ── */}
      {bulkModal && (
        <Modal title={`Multi-Month Payment — ${bulkModal.name}`} onClose={() => setBulkModal(null)}>
          <div style={{ background: C.accentLight, borderRadius: 12, padding: 12, marginBottom: 14, fontSize: 13, color: C.warning }}>
            <strong>How it works:</strong> Select one or more months below (any month — past, current, or future). The guardian pays for all selected months at once. Ideal for advance payments or clearing arrears.
          </div>

          <div style={{ fontWeight: 600, fontSize: 13, color: C.text, marginBottom: 8 }}>Select months to pay:</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 14 }}>
            {MONTHS.map((m, i) => {
              const st = getStatus(bulkModal.id, i);
              const alreadyPaid = st === "paid";
              const isSelected = bulkMonths.includes(i);
              const isFuture = i > CURRENT_MONTH;
              return (
                <button key={m} disabled={alreadyPaid} onClick={() => toggleBulkMonth(i)} style={{
                  padding: "9px 6px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: alreadyPaid ? "not-allowed" : "pointer",
                  border: `2px solid ${isSelected ? (isFuture ? C.purple : C.success) : alreadyPaid ? C.success : C.border}`,
                  background: alreadyPaid ? C.successLight : isSelected ? (isFuture ? C.purpleLight : C.successLight) : C.bg,
                  color: alreadyPaid ? C.success : isSelected ? (isFuture ? C.purple : C.success) : C.text,
                  textAlign: "center", opacity: alreadyPaid ? 0.6 : 1
                }}>
                  <div>{m.slice(0, 3)}</div>
                  <div style={{ fontSize: 9, marginTop: 1 }}>
                    {alreadyPaid ? "✓ Paid" : isFuture ? "Advance" : i === CURRENT_MONTH ? "Current" : "Due"}
                  </div>
                </button>
              );
            })}
          </div>

          {bulkMonths.length > 0 && (
            <div style={{ background: C.successLight, borderRadius: 10, padding: "10px 14px", marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                <span style={{ color: C.success, fontWeight: 600 }}>{bulkMonths.length} month(s) selected</span>
                <span style={{ color: C.success, fontWeight: 800 }}>{fmtTaka(bulkMonths.reduce((a, idx) => a + getEffFee(bulkModal, idx), 0))}</span>
              </div>
              <div style={{ fontSize: 12, color: C.success, marginTop: 2 }}>
                {bulkMonths.sort((a, b) => a - b).map(i => MONTHS[i].slice(0, 3)).join(", ")}
              </div>
            </div>
          )}

          <div style={{ fontWeight: 600, fontSize: 13, color: C.text, marginBottom: 8 }}>Payment method:</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
            {["Cash", "bKash", "Nagad", "Rocket", "Bank Transfer"].map(m => (
              <button key={m} onClick={() => setBulkMethod(m)} style={{ padding: "7px 12px", borderRadius: 8, border: `1.5px solid ${bulkMethod === m ? C.primary : C.border}`, background: bulkMethod === m ? C.primary : C.bg, color: bulkMethod === m ? "#fff" : C.text, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                {methodIcon(m)} {m}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <Btn full variant="primary" disabled={bulkMonths.length === 0} onClick={recordBulk}>
              ✅ Confirm {bulkMonths.length > 0 ? `— ${fmtTaka(bulkMonths.reduce((a, idx) => a + getEffFee(bulkModal, idx), 0))}` : ""}
            </Btn>
            <Btn variant="soft" onClick={() => setBulkModal(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── MESSAGES ─────────────────────────────────────────────────
function Messages({ students, batches, isPro, onUpgrade, toast, account }) {
  const [tab, setTab] = useState("broadcast");
  const [msgs, setMsgs] = useState([]);
  const [bForm, setBForm] = useState({ batch: "", msg: "", type: "general" });
  const [dForm, setDForm] = useState({ studentId: "", msg: "", method: "whatsapp" });
  const [sending, setSending] = useState(false);
  const [apiKey, setApiKey] = useState("");

  const msgTypes = [
    { value: "general", label: "📢 General Notice" }, { value: "fee", label: "💰 Fee Reminder" },
    { value: "exam", label: "📝 Exam Notice" }, { value: "homework", label: "📚 Homework" },
    { value: "result", label: "📊 Result" }, { value: "holiday", label: "🏖️ Holiday Notice" }
  ];

  const templates = {
    fee: "আদরের অভিভাবক, {batch} ব্যাচের এই মাসের বেতন এখনও বাকি আছে। অনুগ্রহ করে ১০ তারিখের মধ্যে পরিশোধ করুন। ধন্যবাদ।",
    exam: "আদরের অভিভাবক, {batch} ব্যাচের মাসিক পরীক্ষা এই শনিবার সকাল ৯টায়। আপনার সন্তানকে প্রস্তুত রাখুন।",
    homework: "আদরের অভিভাবক, {batch} ব্যাচের জন্য গৃহকর্ম দেওয়া হয়েছে। পরের ক্লাসের আগে সম্পন্ন করতে বলুন।",
    result: "আদরের অভিভাবক, {batch} ব্যাচের পরীক্ষার ফলাফল প্রস্তুত। সংগ্রহ করতে কোচিং সেন্টারে আসুন।",
    holiday: "আদরের অভিভাবক, আগামীকাল সরকারি ছুটির কারণে {batch} ব্যাচের ক্লাস বন্ধ থাকবে।",
  };

  // ── BROADCAST via API (WhatsApp Business API) ──
  const sendBroadcast = async () => {
    if (!bForm.batch || !bForm.msg) return;
    const batch = batches.find(b => b.name === bForm.batch);
    const batchStudents = students.filter(s => s.batch === bForm.batch);
    if (batchStudents.length === 0) { toast("⚠️ No students in this batch"); return; }
    setSending(true);
    // Simulated API call — replace with real WhatsApp Business API / GreenAPI / WATI call
    // In production: POST to /api/messages/broadcast with { phones, message, apiKey }
    setSending(false);
    setMsgs(m => [{ id: Date.now(), type: "broadcast", to: bForm.batch, toLabel: `${batch?.fullName || bForm.batch} (${batchStudents.length} students)`, text: bForm.msg, time: new Date().toLocaleTimeString("en-BD", { hour: "2-digit", minute: "2-digit" }), sent: batchStudents.length, failed: 0 }, ...m]);
    setBForm(f => ({ ...f, msg: "" }));
    toast(`📢 Sent to ${batchStudents.length} guardians in ${bForm.batch}!`);
  };

  // ── DIRECT via manual WhatsApp / SMS link (no API needed) ──
  const openDirectMessage = () => {
    if (!dForm.studentId || !dForm.msg) return;
    const s = students.find(x => x.id === dForm.studentId || x.id === parseInt(dForm.studentId));
    if (!s) return;
    const phone = s.phone.replace(/[^0-9]/g, "");
    const bdPhone = phone.startsWith("0") ? "880" + phone.slice(1) : phone;
    const encodedMsg = encodeURIComponent(dForm.msg);
    if (dForm.method === "whatsapp") {
      window.open(`https://wa.me/${bdPhone}?text=${encodedMsg}`, "_blank");
    } else {
      window.open(`sms:${s.phone}?body=${encodedMsg}`, "_blank");
    }
    setMsgs(m => [{ id: Date.now(), type: "direct", to: s.phone, toLabel: `${s.guardian} · guardian of ${s.name}`, text: dForm.msg, time: new Date().toLocaleTimeString("en-BD", { hour: "2-digit", minute: "2-digit" }), method: dForm.method }, ...m]);
    toast(`✅ ${dForm.method === "whatsapp" ? "WhatsApp" : "SMS"} opened for ${s.guardian}!`);
  };

  if (!isPro) return (
    <div style={{ textAlign: "center", padding: "32px 16px" }}>
      <div style={{ fontSize: 56, marginBottom: 14 }}>💬</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: C.text, fontFamily: "Georgia, serif", marginBottom: 8 }}>Pro Feature: Messaging</div>
      <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.7, marginBottom: 20 }}>Send WhatsApp messages to guardians directly from the app. Broadcast to entire batches via API, or send individual manual messages instantly.</div>
      <div style={{ background: C.accentLight, borderRadius: 14, padding: 16, marginBottom: 20, textAlign: "left" }}>
        <div style={{ fontWeight: 700, color: C.warning, marginBottom: 8 }}>📱 Two Messaging Modes:</div>
        <div style={{ fontSize: 13, color: C.text, lineHeight: 2 }}>
          📢 <strong>Broadcast:</strong> API-powered, sends to entire batch at once<br/>
          💬 <strong>Direct:</strong> Manual WhatsApp/SMS link for individual guardians<br/>
          ✅ No message composing needed for direct — opens WhatsApp instantly<br/>
          📊 Message history tracked in-app
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
        {["📢 Batch Broadcast", "📲 Fee Reminders", "📝 Exam Notices", "📊 Result Sharing", "📚 Homework Alert", "🏖️ Holiday Notice"].map(f => (
          <div key={f} style={{ background: C.bg, borderRadius: 10, padding: "11px", fontSize: 13, fontWeight: 600, color: C.text }}>{f}</div>
        ))}
      </div>
      <Btn variant="accent" size="lg" full onClick={onUpgrade}>⭐ Upgrade to Pro — ৳399/month</Btn>
    </div>
  );

  const selStudent = dForm.studentId ? students.find(s => s.id === parseInt(dForm.studentId)) : null;

  return (
    <div>
      <SectionHeader title="Messages" />
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {[["broadcast", "📢 Broadcast (API)"], ["direct", "💬 Direct (Manual)"], ["history", "📋 History"]].map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={{ flex: 1, padding: "9px 8px", borderRadius: 10, border: "none", fontSize: 12, fontWeight: 700, background: tab === v ? C.primary : C.bg, color: tab === v ? "#fff" : C.muted, cursor: "pointer" }}>{l}</button>
        ))}
      </div>

      {/* ── BROADCAST TAB ── */}
      {tab === "broadcast" && (
        <div>
          {/* API notice */}
          <div style={{ background: C.infoLight, borderRadius: 12, padding: 14, marginBottom: 14, border: `1px solid ${C.info}25` }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.info, marginBottom: 6 }}>🔌 WhatsApp Business API Mode</div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              This sends messages to all guardians in a batch via API (WATI / GreenAPI / official WhatsApp Business API). Connect your API key in Settings → WhatsApp to go live. In demo mode, sends are simulated.
            </div>
          </div>

          <div style={{ background: C.card, borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
            <Select label="Select Batch" value={bForm.batch} onChange={v => setBForm(f => ({ ...f, batch: v }))} options={[{ value: "", label: "Choose batch…" }, ...batches.map(b => ({ value: b.name, label: `${b.name} — ${b.fullName} (${students.filter(s => s.batch === b.name).length} students)` }))]} />
            <Select label="Message Type" value={bForm.type} onChange={v => { setBForm(f => ({ ...f, type: v, msg: templates[v] ? templates[v].replace("{batch}", f.batch || "আপনার ব্যাচ") : f.msg })); }} options={msgTypes} />

            {/* Quick templates */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>⚡ Quick Templates</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {Object.keys(templates).map(k => (
                  <button key={k} onClick={() => setBForm(f => ({ ...f, type: k, msg: templates[k].replace("{batch}", f.batch || "আপনার ব্যাচ") }))}
                    style={{ padding: "5px 10px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 11, background: C.bg, color: C.text, cursor: "pointer", fontWeight: 500 }}>
                    {msgTypes.find(m => m.value === k)?.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>Message</label>
              <textarea value={bForm.msg} onChange={e => setBForm(f => ({ ...f, msg: e.target.value }))} rows={4} placeholder="Type your message to all guardians in this batch…" style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", resize: "vertical", fontFamily: FONT, boxSizing: "border-box" }} />
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{bForm.msg.length} characters · {bForm.batch ? students.filter(s => s.batch === bForm.batch).length : "—"} recipients</div>
            </div>

            {bForm.batch && bForm.msg && (
              <div style={{ background: C.accentLight, borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: C.warning }}>
                📤 This will send to <strong>{students.filter(s => s.batch === bForm.batch).length} guardian phone numbers</strong> via WhatsApp Business API.
              </div>
            )}
            <Btn full variant="accent" onClick={sendBroadcast} disabled={!bForm.batch || !bForm.msg || sending}>
              {sending ? "⏳ Sending…" : `📤 Send to All Guardians in ${bForm.batch || "Batch"}`}
            </Btn>
          </div>
        </div>
      )}

      {/* ── DIRECT TAB ── */}
      {tab === "direct" && (
        <div>
          {/* Manual mode explanation */}
          <div style={{ background: "#F0FDF4", borderRadius: 12, padding: 14, marginBottom: 14, border: "1px solid #BBF7D0" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.success, marginBottom: 6 }}>📲 Manual Direct Messaging</div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              No API needed. Select a student, write your message, then tap Send — it opens <strong>WhatsApp</strong> or <strong>SMS</strong> directly on your phone with the guardian's number and message pre-filled. You just tap send.
            </div>
          </div>

          <div style={{ background: C.card, borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
            {/* Method toggle */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>Send via</label>
              <div style={{ display: "flex", gap: 8 }}>
                {[["whatsapp", "📱 WhatsApp"], ["sms", "💬 SMS"]].map(([v, l]) => (
                  <button key={v} onClick={() => setDForm(f => ({ ...f, method: v }))} style={{ flex: 1, padding: "9px", borderRadius: 10, border: `1.5px solid ${dForm.method === v ? (v === "whatsapp" ? "#25D366" : C.info) : C.border}`, background: dForm.method === v ? (v === "whatsapp" ? "#25D36615" : C.infoLight) : C.bg, fontSize: 13, fontWeight: 700, cursor: "pointer", color: dForm.method === v ? (v === "whatsapp" ? "#128C7E" : C.info) : C.muted }}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Student search */}
            <Select label="Select Student" value={dForm.studentId} onChange={v => setDForm(f => ({ ...f, studentId: v }))} options={[{ value: "", label: "Choose student…" }, ...students.map(s => ({ value: s.id, label: `${s.name} · ${s.batch} (Guardian: ${s.guardian})` }))]} />

            {/* Guardian info card */}
            {selStudent && (
              <div style={{ background: C.bg, borderRadius: 12, padding: "12px 14px", marginBottom: 14, display: "flex", gap: 12, alignItems: "center", border: `1px solid ${C.border}` }}>
                {selStudent.photo
                  ? <img src={selStudent.photo} alt={selStudent.name} style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover" }} />
                  : <Av label={selStudent.avatar} size={44} bg={C.primary} />}
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{selStudent.name}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>Guardian: <strong>{selStudent.guardian}</strong></div>
                  <div style={{ fontSize: 12, color: dForm.method === "whatsapp" ? "#128C7E" : C.info, fontWeight: 600 }}>
                    {dForm.method === "whatsapp" ? "📱" : "💬"} {selStudent.phone}
                  </div>
                </div>
              </div>
            )}

            {/* Quick message templates for direct */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>⚡ Quick Templates</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  ["fee_reminder", `${selStudent?.name || "আপনার সন্তান"}-এর এই মাসের বেতন এখনও পরিশোধ হয়নি। অনুগ্রহ করে দ্রুত পরিশোধ করুন।`],
                  ["exam_remind", `${selStudent?.name || "আপনার সন্তান"}-এর পরীক্ষা আসছে শনিবার। প্রস্তুতি নিশ্চিত করুন।`],
                  ["absent", `${selStudent?.name || "আপনার সন্তান"} আজ ক্লাসে অনুপস্থিত ছিল। বিষয়টি জানাতে চাইলাম।`],
                  ["custom", ""],
                ].map(([k, t]) => (
                  <button key={k} onClick={() => setDForm(f => ({ ...f, msg: t }))}
                    style={{ padding: "5px 10px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 11, background: C.bg, color: C.text, cursor: "pointer" }}>
                    {k === "fee_reminder" ? "💰 Fee Due" : k === "exam_remind" ? "📝 Exam" : k === "absent" ? "❌ Absent" : "✏️ Custom"}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>Message</label>
              <textarea value={dForm.msg} onChange={e => setDForm(f => ({ ...f, msg: e.target.value }))} rows={4} placeholder="Write your message to this guardian…" style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", resize: "vertical", fontFamily: FONT, boxSizing: "border-box" }} />
            </div>

            <Btn full variant="success" onClick={openDirectMessage} disabled={!dForm.studentId || !dForm.msg}
              style={{ background: dForm.method === "whatsapp" ? "#25D366" : C.info }}>
              {dForm.method === "whatsapp" ? "📱 Open WhatsApp →" : "💬 Open SMS →"}
            </Btn>
            <div style={{ fontSize: 11, color: C.muted, textAlign: "center", marginTop: 6 }}>
              Opens {dForm.method === "whatsapp" ? "WhatsApp" : "SMS app"} with guardian's number and message pre-filled. Just tap Send.
            </div>
          </div>
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {tab === "history" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {msgs.map(m => (
            <div key={m.id} style={{ background: C.card, borderRadius: 14, padding: 14, boxShadow: "0 1px 6px rgba(0,0,0,0.06)", borderLeft: `3px solid ${m.type === "broadcast" ? C.accent : C.success}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <Badge text={m.type === "broadcast" ? "📢 Broadcast" : `💬 Direct · ${m.method === "whatsapp" ? "WhatsApp" : "SMS"}`} type={m.type === "broadcast" ? "pro" : "active"} small />
                </div>
                <span style={{ fontSize: 11, color: C.muted }}>{m.time}</span>
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>To: <strong>{m.toLabel}</strong></div>
              <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>{m.text}</div>
              {m.type === "broadcast" && (
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <span style={{ fontSize: 11, background: C.successLight, color: C.success, borderRadius: 6, padding: "2px 8px", fontWeight: 600 }}>✅ {m.sent} sent</span>
                  {m.failed > 0 && <span style={{ fontSize: 11, background: C.dangerLight, color: C.danger, borderRadius: 6, padding: "2px 8px", fontWeight: 600 }}>❌ {m.failed} failed</span>}
                </div>
              )}
            </div>
          ))}
          {msgs.length === 0 && <EmptyState icon="📭" title="No messages yet" sub="Send your first message above" />}
        </div>
      )}
    </div>
  );
}

// ─── SETTINGS ─────────────────────────────────────────────────
function Settings({ account, setAccount, isPro, onUpgrade, onLogout, toast, staffAccounts, setStaffAccounts, students, setStudents, batches, setBatches, payments, setPayments, teachers, darkMode, setDarkMode, lang, setLang }) {
  const [form, setForm] = useState({ ...account });
  const fld = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const [tab, setTab] = useState("profile");
  const [showRollover, setShowRollover] = useState(false);

  const save = async () => {
    const { error } = await supabase.from("coaching_centers").update({
      name: form.name, owner: form.owner, phone: form.phone,
      address: form.address, logo: form.logo, logo_image: form.logoImage || null,
      established: form.established, whatsapp_number: form.whatsappNumber || null,
    }).eq("id", account.id);
    if (error) { toast("❌ " + error.message); return; }
    setAccount(a => ({ ...a, ...form }));
    toast("✅ Profile saved!");
  };

  return (
    <div>
      <SectionHeader title="Settings" />

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {[["profile", "🏫 Profile"], ["whatsapp", "📱 WhatsApp"], ["staff", "👥 Staff"], ["reports", "📊 Reports"], ["appearance", "🎨 Appearance"], ["plan", "⭐ Plan"], ["account", "👤 Account"]].map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={{ flex: 1, minWidth: 80, padding: "8px 4px", borderRadius: 10, border: "none", fontSize: 11, fontWeight: 700, background: tab === v ? C.primary : C.bg, color: tab === v ? "#fff" : C.muted, cursor: "pointer" }}>{l}</button>
        ))}
      </div>

      {tab === "profile" && (
        <div style={{ background: C.card, borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
          {/* Logo preview + upload */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
            <div style={{ position: "relative" }}>
              {form.logoImage
                ? <img src={form.logoImage} alt="logo" style={{ width: 72, height: 72, borderRadius: 16, objectFit: "cover", border: `2px solid ${C.primary}` }} />
                : <div style={{ width: 72, height: 72, borderRadius: 16, background: C.primary, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, color: "#fff", fontWeight: 800 }}>{form.logo || initials(form.name)}</div>
              }
              <label title="Upload logo" style={{ position: "absolute", bottom: -4, right: -4, width: 24, height: 24, background: C.accent, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 2px 6px rgba(0,0,0,0.2)", fontSize: 12 }}>
                📷
                <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => {
                  const file = e.target.files[0]; if (!file) return;
                  const r = new FileReader(); r.onload = ev => setForm(f => ({ ...f, logoImage: ev.target.result })); r.readAsDataURL(file);
                }} />
              </label>
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{form.name}</div>
              <div style={{ fontSize: 13, color: C.muted }}>{form.address}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Click 📷 to upload your coaching logo</div>
              <Badge text={isPro ? "⭐ Pro Plan" : "Free Plan"} type={isPro ? "pro" : "neutral"} />
            </div>
          </div>
          <Input label="Coaching Center Name" value={form.name} onChange={fld("name")} required />
          <Input label="Owner / Principal Name" value={form.owner} onChange={fld("owner")} />
          <Input label="Contact Phone" value={form.phone} onChange={fld("phone")} />
          <Input label="Address" value={form.address} onChange={fld("address")} />
          <Input label="Established Year" value={form.established} onChange={fld("established")} />
          <Input label="Logo Initials (fallback, 2 letters)" value={form.logo} onChange={fld("logo")} placeholder="e.g. BF" note="Used when no logo image is uploaded" />
          <Btn full variant="primary" onClick={save}>💾 Save Profile</Btn>
        </div>
      )}

      {tab === "whatsapp" && (
        <div>
          <div style={{ background: C.card, borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: C.text }}>📱 WhatsApp Business Setup</div>
            <div style={{ background: "#E7FBE6", borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#166534", marginBottom: 6 }}>How it works:</div>
              <div style={{ fontSize: 12, color: "#166534", lineHeight: 1.8 }}>
                1. Your registered WhatsApp Business number is the sender<br />
                2. Guardians see your coaching center name + your number<br />
                3. Messages look professional and trusted<br />
                4. Replies come back to your WhatsApp directly
              </div>
            </div>
            <Input label="Your WhatsApp Business Number" value={form.whatsappNumber} onChange={fld("whatsappNumber")} placeholder="e.g. 01711-234567" note="This is the number guardians will receive messages from" />
            {!isPro && <div style={{ background: C.warningLight, borderRadius: 10, padding: 12, fontSize: 13, color: C.warning, fontWeight: 600 }}>🔒 WhatsApp messaging requires Pro plan</div>}
            {isPro && <Btn full variant="success" onClick={save}>✅ Save WhatsApp Number</Btn>}
          </div>
          {!isPro && <Btn full variant="accent" onClick={onUpgrade}>⭐ Upgrade to Enable WhatsApp</Btn>}
        </div>
      )}

      {tab === "staff" && (
        <StaffManager staffAccounts={staffAccounts} setStaffAccounts={setStaffAccounts} toast={toast} account={account} />
      )}

      {tab === "appearance" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Dark Mode */}
          <div style={{ background: C.card, borderRadius: 16, padding: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>🌙 Dark Mode</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Switch between light and dark theme</div>
              </div>
              <button onClick={() => { const nd = !darkMode; setDarkMode(nd); try { localStorage.setItem("cbDark", nd ? "1" : "0"); } catch(e){} }}
                style={{ width: 52, height: 28, borderRadius: 14, background: darkMode ? C.primary : C.border, border: "none", cursor: "pointer", position: "relative", transition: "background 0.2s" }}>
                <div style={{ position: "absolute", top: 3, left: darkMode ? 26 : 3, width: 22, height: 22, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 4px rgba(0,0,0,0.2)" }} />
              </button>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              {[["☀️ Light", false], ["🌙 Dark", true]].map(([label, dm]) => (
                <button key={label} onClick={() => { setDarkMode(dm); try { localStorage.setItem("cbDark", dm ? "1" : "0"); } catch(e){} }}
                  style={{ flex: 1, padding: "12px", borderRadius: 12, border: "2px solid " + (darkMode === dm ? C.primary : C.border), background: darkMode === dm ? C.primaryLight : C.bg, color: darkMode === dm ? C.primary : C.muted, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Language */}
          <div style={{ background: C.card, borderRadius: 16, padding: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>🌐 Language / ভাষা</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>Choose display language for the app</div>
            <div style={{ display: "flex", gap: 10 }}>
              {[["en", "🇬🇧 English"], ["bn", "🇧🇩 বাংলা"]].map(([code, label]) => (
                <button key={code} onClick={() => { setLang(code); try { localStorage.setItem("cbLang", code); } catch(e){} }}
                  style={{ flex: 1, padding: "14px", borderRadius: 12, border: "2px solid " + (lang === code ? C.primary : C.border), background: lang === code ? C.primaryLight : C.bg, color: lang === code ? C.primary : C.muted, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "plan" && (
        <div>
          <div style={{ background: isPro ? `linear-gradient(135deg, ${C.primary}, #1a5c45)` : C.bg, borderRadius: 16, padding: 20, marginBottom: 14, color: isPro ? "#fff" : C.text }}>
            <div style={{ fontSize: 14, opacity: isPro ? 0.8 : 1, color: isPro ? "#fff" : C.muted }}>Current Plan</div>
            <div style={{ fontSize: 28, fontWeight: 900, fontFamily: "Georgia, serif" }}>{isPro ? "⭐ Pro Plan" : "Free Plan"}</div>
            {isPro ? (
              <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>৳399/month · All features unlocked · Renews April 1, 2026</div>
            ) : (
              <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>Limited to 1 batch, 30 students, basic features</div>
            )}
          </div>

          {!isPro && (
            <div style={{ background: C.card, borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
              <div style={{ fontWeight: 800, fontSize: 17, color: C.text, marginBottom: 4, fontFamily: "Georgia, serif" }}>Upgrade to Pro</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: C.accent, marginBottom: 14 }}>৳399 <span style={{ fontSize: 14, fontWeight: 400, color: C.muted }}>/ month</span></div>
              {[["📢 WhatsApp Messaging", "Send reminders & notices to guardians"], ["👥 Unlimited Students & Batches", "No cap on your growth"], ["💰 Advanced Financial Reports", "Monthly income, expense charts"], ["👨‍🏫 Salary Management", "Track and pay teacher salaries"], ["🔔 Auto Fee Reminders", "Never chase payments manually"], ["📊 Exam Result Broadcast", "Share results with all guardians at once"]].map(([t, d]) => (
                <div key={t} style={{ display: "flex", gap: 10, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 18 }}>{t.split(" ")[0]}</div>
                  <div><div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t.slice(t.indexOf(" ") + 1)}</div><div style={{ fontSize: 12, color: C.muted }}>{d}</div></div>
                </div>
              ))}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 16 }}>
                <Btn full variant="accent" size="md" onClick={onUpgrade}>⭐ Monthly ৳399</Btn>
                <Btn full variant="primary" size="md" onClick={onUpgrade}>📅 Yearly ৳4,000</Btn>
              </div>
              <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 8 }}>Yearly saves ৳788 · bKash / Nagad accepted</div>
              <a href={"https://wa.me/" + SUPPORT.whatsapp.replace(/[^0-9]/g,"")} target="_blank" rel="noreferrer" style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"#25D366",borderRadius:10,padding:"11px",color:"#fff",fontSize:13,fontWeight:700,textDecoration:"none",marginTop:8 }}>📱 WhatsApp to Upgrade</a>
            </div>
          )}
        </div>
      )}

      {tab === "reports" && (
        <div>
          <div style={{ background: C.card, borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 14 }}>📊 Generate Reports</div>
            <div style={{ background: C.bg, borderRadius: 14, padding: 16, marginBottom: 12, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 4 }}>📋 End of Day (EOD) Handover</div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>Today's collection — cash vs digital, who paid, total in hand. Perfect for daily staff handover to owner.</div>
              <Btn full variant="primary" onClick={() => {
                const openPW = (html) => { const b = new Blob([html],{type:"text/html"}); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href=u; a.target="_blank"; a.rel="noopener"; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(()=>URL.revokeObjectURL(u),10000); };
                generateEODReport(students, payments, batches, account, openPW);
              }}>📋 Generate Today's EOD Report</Btn>
            </div>
            <div style={{ background: C.bg, borderRadius: 14, padding: 16, marginBottom: 0, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 4 }}>📊 Monthly Financial Report</div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>{MONTHS[CURRENT_MONTH]} {CURRENT_YEAR} — Collection by batch, payment methods, net income after salaries.</div>
              <Btn full variant="success" onClick={() => {
                const openPW = (html) => { const b = new Blob([html],{type:"text/html"}); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href=u; a.target="_blank"; a.rel="noopener"; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(()=>URL.revokeObjectURL(u),10000); };
                generateMonthlyReport(students, payments, batches, teachers, account, openPW);
              }}>📊 Generate Monthly Report</Btn>
            </div>
          </div>
          <div style={{ background: C.card, borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", border: `2px solid ${C.warning}30` }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
              <span style={{ fontSize: 28 }}>🔁</span>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, color: C.text }}>Year Rollover — {CURRENT_YEAR + 1} Session</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.6 }}>Promote students to new batches, remove graduates, reset payment records for new academic year. <strong style={{ color: C.danger }}>Cannot be undone.</strong></div>
              </div>
            </div>
            <Btn full variant="accent" onClick={() => setShowRollover(true)}>🔁 Start Year Rollover →</Btn>
          </div>
          {showRollover && <YearRollover students={students} batches={batches} payments={payments} setStudents={setStudents} setPayments={setPayments} setBatches={setBatches} toast={toast} onClose={() => setShowRollover(false)} />}
        </div>
      )}

      {tab === "account" && (
        <div style={{ background: C.card, borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderBottom: `1px solid ${C.border}`, marginBottom: 14 }}>
            <Av label={initials(account?.owner || account?.name)} size={52} bg={C.primary} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{account?.owner}</div>
              <div style={{ fontSize: 13, color: C.muted }}>{account?.email}</div>
              <Badge text={isPro ? "⭐ Pro" : "Free"} type={isPro ? "pro" : "neutral"} />
            </div>
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.6 }}>
            Member since January 2025 · {account?.name}
          </div>
          <Input label="Email Address" value={form.email} onChange={fld("email")} type="email" />
          <Btn full variant="primary" onClick={save} style={{ marginBottom: 10 }}>💾 Save</Btn>
          <Btn full variant="ghost" onClick={() => toast("🔒 Password change email sent!")}>🔒 Change Password</Btn>
          <div style={{ height: 16 }} />
          <Btn full variant="danger" onClick={onLogout}>🚪 Sign Out</Btn>
        </div>
      )}
    </div>
  );
}

// ─── PRO UPGRADE MODAL (manual contact system) ────────────────
function ProModal({ onClose, onActivate }) {
  const [step, setStep] = useState("info"); // "info" | "contact"

  return (
    <Modal title="" onClose={onClose}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 44, marginBottom: 8 }}>⭐</div>
        <div style={{ fontSize: 21, fontWeight: 900, fontFamily: "Georgia, serif", color: C.text, marginBottom: 4 }}>Upgrade to Pro</div>
        <div style={{ background: `linear-gradient(135deg, ${C.accent}, #b56a0a)`, borderRadius: 12, padding: "12px 18px", color: "#fff", marginBottom: 14, display: "inline-block" }}>
          <span style={{ fontSize: 26, fontWeight: 900, fontFamily: "Georgia, serif" }}>৳299</span>
          <span style={{ fontSize: 13, opacity: 0.9 }}> / month</span>
        </div>
      </div>

      {/* Feature list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
        {[
          ["📱", "WhatsApp messaging to guardians", "Your own Business number as sender"],
          ["👥", "Unlimited students & batches", "No cap on your coaching's growth"],
          ["💵", "Teacher salary management", "Track, mark paid, salary history"],
          ["🔔", "Auto fee reminders", "Never chase payments manually"],
          ["📊", "Advanced financial reports", "Monthly income, expense breakdown"],
          ["📢", "Batch broadcast", "One message to all guardians instantly"],
        ].map(([ic, title, sub]) => (
          <div key={title} style={{ display: "flex", gap: 10, padding: "9px 12px", background: C.bg, borderRadius: 10, alignItems: "flex-start" }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>{ic}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{title}</div>
              <div style={{ fontSize: 11, color: C.muted }}>{sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* How to upgrade - manual system */}
      <div style={{ background: C.successLight, border: `1px solid ${C.success}30`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.success, marginBottom: 10 }}>📞 How to Activate Pro</div>
        <div style={{ fontSize: 12, color: C.text, lineHeight: 2, marginBottom: 12 }}>
          1. Call or WhatsApp us at <strong>{SUPPORT.whatsapp}</strong><br />
          2. Tell us your coaching center name & email<br />
          3. Pay ৳299 via bKash / Nagad / Rocket<br />
          4. We activate your Pro within <strong>1 hour</strong>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a href={SUPPORT.whatsappLink} target="_blank" rel="noreferrer" style={{ flex: 1, background: "#25D366", color: "#fff", borderRadius: 10, padding: "11px 10px", fontSize: 13, fontWeight: 700, textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            💬 WhatsApp Us
          </a>
          <a href={`tel:${SUPPORT.phone}`} style={{ flex: 1, background: C.primary, color: "#fff", borderRadius: 10, padding: "11px 10px", fontSize: 13, fontWeight: 700, textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            📞 Call Us
          </a>
        </div>
      </div>

      <div style={{ fontSize: 11, color: C.muted, textAlign: "center", marginBottom: 14 }}>
        bKash · Nagad · Rocket · Bank Transfer accepted · Cancel anytime
      </div>


    </Modal>
  );
}

// ─── HELP & SUPPORT SECTION ───────────────────────────────────
function Help({ isPro, onUpgrade }) {
  const channels = [
    { icon: "💬", label: "WhatsApp Support", sub: "Chat with us directly", color: "#25D366", bg: "#E8F8EF", href: SUPPORT.whatsappLink, cta: SUPPORT.whatsapp },
    { icon: "📘", label: "Facebook Page", sub: "Tips, updates & community", color: "#1877F2", bg: "#E8F0FD", href: SUPPORT.facebook, cta: "facebook.com/coachlybd" },
    { icon: "▶️", label: "YouTube Tutorials", sub: "Step-by-step video guides", color: "#FF0000", bg: "#FDECEA", href: SUPPORT.youtube, cta: "youtube.com/@coachlybd" },
    { icon: "✉️", label: "Email Support", sub: "For detailed queries", color: "#EA4335", bg: "#FEF1F0", href: `mailto:${SUPPORT.email}`, cta: SUPPORT.email },
    { icon: "📝", label: "Help Blog", sub: "Articles & how-to guides", color: "#0369A1", bg: "#E0F0FB", href: SUPPORT.blog, cta: "coachlybd.app/blog" },
    { icon: "📞", label: "Phone Call", sub: "Talk to a real person", color: C.primary, bg: C.successLight, href: `tel:${SUPPORT.phone}`, cta: SUPPORT.phone },
  ];

  const faqs = [
    ["How do I add a new student?", "Go to Students tab → tap ➕ Add Student → fill the form and save."],
    ["Can a guardian pay for multiple months?", "Yes! Go to Fees → By Student view → tap ⚡ Pay Multiple Months. Select any months including future ones."],
    ["How does WhatsApp messaging work?", "Pro feature. You register your WhatsApp Business number. Messages are sent from your coaching center's own number — guardians see your name."],
    ["How do I upgrade to Pro?", `WhatsApp or call us at ${SUPPORT.whatsapp}. Pay ৳299 via bKash/Nagad and we activate within 1 hour.`],
    ["Can I use CoachlyBD on mobile?", "Yes! CoachlyBD is fully mobile-optimized. Works on any smartphone browser — no app install needed."],
    ["How do I record an advance payment?", "Fees → By Student → choose the student → tap any future month → select payment method. Done!"],
    ["Is my data safe?", "Yes. All data is encrypted and stored securely on our servers. We never share your data with third parties."],
    ["Can I have multiple coaching centers?", "Each account manages one coaching center. Contact us for multi-center enterprise plans."],
  ];

  const [openFaq, setOpenFaq] = useState(null);

  return (
    <div style={{ paddingBottom: 32 }}>
      <SectionHeader title="Help & Support" />

      {/* Contact channels */}
      <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 10 }}>📬 Contact Us</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
        {channels.map(ch => (
          <a key={ch.label} href={ch.href} target="_blank" rel="noreferrer" style={{ background: ch.bg, borderRadius: 14, padding: "14px 12px", textDecoration: "none", border: `1px solid ${ch.color}20`, display: "block" }}>
            <div style={{ fontSize: 24, marginBottom: 6 }}>{ch.icon}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{ch.label}</div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{ch.sub}</div>
            <div style={{ fontSize: 11, color: ch.color, fontWeight: 600 }}>{ch.cta}</div>
          </a>
        ))}
      </div>

      {/* Pro upgrade CTA */}
      {!isPro && (
        <div onClick={onUpgrade} style={{ background: `linear-gradient(135deg, ${C.accent}, #b56a0a)`, borderRadius: 16, padding: "16px 18px", cursor: "pointer", color: "#fff", display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
          <div style={{ fontSize: 28 }}>⭐</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>Upgrade to Pro</div>
            <div style={{ fontSize: 12, opacity: 0.9 }}>Call/WhatsApp {SUPPORT.whatsapp}</div>
            <div style={{ fontSize: 14, fontWeight: 800, marginTop: 2 }}>৳399/month</div>
          </div>
        </div>
      )}

      {/* FAQ */}
      <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 10 }}>❓ Frequently Asked Questions</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {faqs.map(([q, a], i) => (
          <div key={i} style={{ background: C.card, borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)" }}>
            <button onClick={() => setOpenFaq(openFaq === i ? null : i)} style={{ width: "100%", padding: "13px 16px", background: "none", border: "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", textAlign: "left", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text, lineHeight: 1.4 }}>{q}</span>
              <span style={{ fontSize: 16, color: C.muted, flexShrink: 0, transition: "transform 0.2s", transform: openFaq === i ? "rotate(180deg)" : "none" }}>▾</span>
            </button>
            {openFaq === i && (
              <div style={{ padding: "0 16px 14px", fontSize: 13, color: C.muted, lineHeight: 1.7, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                {a}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Version info */}
      <div style={{ textAlign: "center", marginTop: 24, padding: "16px", background: C.card, borderRadius: 14, boxShadow: "0 1px 6px rgba(0,0,0,0.05)" }}>
        <div style={{ fontSize: 22, marginBottom: 6 }}>📚</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: C.primary, fontFamily: "Georgia, serif" }}>CoachlyBD</div>
        <div style={{ fontSize: 12, color: C.muted }}>Made with ❤️ for Bangladesh</div>
        <div style={{ fontSize: 11, color: C.subtle, marginTop: 4 }}>© 2026 CoachlyBD · All rights reserved</div>
      </div>
    </div>
  );
}


// ─── EXAMS ────────────────────────────────────────────────────
function Exams({ students, batches, account, toast }) {
  const [tab, setTab] = useState("seatplan");
  // Seat Plan state
  const [rows, setRows] = useState(5);
  const [cols, setCols] = useState(6);
  const [seatMap, setSeatMap] = useState({}); // { "r-c": studentId }
  const [examName, setExamName] = useState("");
  const [examDate, setExamDate] = useState("");
  const [examBatch, setExamBatch] = useState("all");
  const [dragStudent, setDragStudent] = useState(null);
  const [dragSeat, setDragSeat] = useState(null);

  // Generate auto seat plan
  const autoAssign = () => {
    const eligible = examBatch === "all" ? students : students.filter(s => s.batch === examBatch);
    const shuffled = [...eligible].sort(() => Math.random() - 0.5);
    const newMap = {};
    let idx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (idx < shuffled.length) {
          newMap[`${r}-${c}`] = shuffled[idx].id;
          idx++;
        }
      }
    }
    setSeatMap(newMap);
    toast("✅ Seat plan generated!");
  };

  const clearSeat = (key) => {
    setSeatMap(m => { const nm = { ...m }; delete nm[key]; return nm; });
  };

  const studentById = (id) => students.find(s => s.id === id);

  // Drag-drop handlers
  const handleDragStart = (studentId) => setDragStudent(studentId);
  const handleSeatDragStart = (key) => { setDragSeat(key); setDragStudent(seatMap[key]); };
  const handleDropOnSeat = (key) => {
    if (!dragStudent) return;
    setSeatMap(m => {
      const nm = { ...m };
      if (dragSeat) delete nm[dragSeat]; // Remove from old seat
      // If target occupied, swap
      const prev = nm[key];
      nm[key] = dragStudent;
      if (prev && dragSeat) nm[dragSeat] = prev;
      return nm;
    });
    setDragStudent(null); setDragSeat(null);
  };

  // ── PDF generation via blob URL (no popup blocker issues) ──
  const openPrintWindow = (htmlContent, filename) => {
    const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // Admit Card PDF generation
  const downloadAdmitCard = (student, opts = {}) => {
    const batch = batches.find(b => b.name === student.batch);
    const logoSrc = account?.logoImage
      ? `<img src="${account.logoImage}" style="width:52px;height:52px;border-radius:12px;object-fit:cover;" />`
      : `<div class="logo-icon">${account?.logo || initials(account?.name || "CB")}</div>`;
    const photoSrc = student.photo
      ? `<img src="${student.photo}" style="width:90px;height:90px;border-radius:10px;object-fit:cover;border:3px solid ${opts.primary || "#16A34A"};" />`
      : `<div style="width:90px;height:90px;border-radius:10px;background:#DCFCE7;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:900;color:${opts.primary || "#16A34A"};border:3px solid ${opts.primary || "#16A34A"};">${(student.avatar || student.name[0])}</div>`;

    const primary = opts.primary || "#16A34A";
    const dark = opts.dark || "#14532D";

    // Template overlay mode
    if (opts.templateMode === "template" && opts.templateImg) {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Admit Card — ${student.name}</title>
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{background:#f0f4f8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;font-family:'Segoe UI',Arial,sans-serif}
          .wrap{position:relative;width:148mm;}
          .bg{width:100%;display:block;}
          .data{position:absolute;top:0;left:0;width:100%;height:100%;padding:12% 8% 6%;}
          .row{margin-bottom:6px;font-size:13px;font-weight:700;color:#0F172A}
          .photo{position:absolute;top:10%;right:6%;width:80px;height:80px;border-radius:8px;object-fit:cover;}
          @media print{body{background:#fff;padding:0}}
        </style></head><body>
        <div class="wrap">
          <img class="bg" src="${opts.templateImg}" />
          <div class="data">
            <div class="row">Roll: ${student.roll}</div>
            <div class="row">${student.name}</div>
            <div class="row">${student.batch}${batch?.fullName ? " — " + batch.fullName : ""}</div>
            <div class="row">${examName}</div>
            <div class="row">${examDate}</div>
            <div class="row">Guardian: ${student.guardian}</div>
          </div>
          ${student.photo ? `<img class="photo" src="${student.photo}" />` : ""}
        </div>
        <script>window.addEventListener('load',()=>{setTimeout(()=>window.print(),300)})</script>
      </body></html>`;
      openPrintWindow(html, `admit-card-${student.roll}`);
      return;
    }

    // Size dimensions
    const sizeMap = { A5: "148mm", A4: "210mm", ID_LANDSCAPE: "148mm" };
    const cardWidth = sizeMap[opts.ratio] || "148mm";

    // Design variants
    const headerBg = opts.design === "minimal"
      ? `background:#fff;border-bottom:4px solid ${primary};`
      : opts.design === "classic"
      ? `background:${primary};background:repeating-linear-gradient(45deg,${primary},${primary} 10px,${dark} 10px,${dark} 20px);`
      : `background:linear-gradient(135deg,${primary},${dark});`;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Admit Card — ${student.name}</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Segoe UI',Arial,sans-serif;background:#e8f0e8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
        .card{background:#fff;width:${cardWidth};box-shadow:0 8px 32px rgba(0,0,0,0.15);border:1px solid #ddd;overflow:hidden}
        .header{${headerBg}padding:18px 22px;display:flex;align-items:center;gap:14px;color:${opts.design === "minimal" ? primary : "#fff"}}
        .logo-icon{width:52px;height:52px;background:${opts.design === "minimal" ? primary + "20" : "rgba(255,255,255,0.2)"};border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:${opts.design === "minimal" ? primary : "#fff"};flex-shrink:0;border:2px solid ${opts.design === "minimal" ? primary + "30" : "rgba(255,255,255,0.3)"}}
        .school-name{font-size:18px;font-weight:900;line-height:1.2}
        .school-sub{font-size:11px;opacity:0.8;margin-top:2px}
        .body{display:flex;gap:0}
        .photo-col{width:110px;flex-shrink:0;padding:18px 0 18px 18px;display:flex;flex-direction:column;align-items:center;gap:10px}
        .roll-box{background:${opts.design === "minimal" ? primary : "#0F172A"};color:#fff;border-radius:8px;padding:6px 10px;font-size:13px;font-weight:900;letter-spacing:2px;text-align:center;width:100%}
        .details-col{flex:1;padding:18px}
        .exam-badge{background:${primary}20;color:${primary};display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:800;margin-bottom:12px;border:1px solid ${primary}30}
        table{width:100%;border-collapse:collapse}
        td{padding:7px 0;border-bottom:1px solid #F1F5F9;font-size:13px;vertical-align:top}
        td:first-child{color:#64748B;width:40%;font-weight:600}
        td:last-child{font-weight:700;color:#0F172A}
        .instructions{background:#FEF9EC;border-left:3px solid ${primary};padding:10px 14px;margin:0 18px 14px;font-size:11px;color:#78350F;line-height:1.9}
        .footer{background:#F8FAFC;padding:10px 18px;display:flex;justify-content:space-between;align-items:center;border-top:1px dashed #E2E8F0;font-size:11px;color:#94A3B8}
        .sig-box{border-top:1px solid #CBD5E1;width:110px;padding-top:4px;font-size:10px;color:#94A3B8;text-align:center;margin-top:16px}
        @media print{body{background:#fff;padding:0}.card{box-shadow:none;border:none;width:100%}}
      </style></head><body>
      <div class="card">
        <div class="header">
          ${logoSrc}
          <div>
            <div class="school-name">${account?.name || "Coaching Center"}</div>
            <div class="school-sub">${account?.address || ""} · ${account?.phone || ""}</div>
          </div>
        </div>
        <div class="body">
          <div class="photo-col">
            ${photoSrc}
            <div class="roll-box">Roll: ${student.roll}</div>
            <div class="sig-box">Student Signature</div>
          </div>
          <div class="details-col">
            <div class="exam-badge">📋 ADMIT CARD</div>
            <table>
              <tr><td>Student Name</td><td>${student.name}</td></tr>
              <tr><td>Batch</td><td>${student.batch}${batch?.fullName ? " — " + batch.fullName : ""}</td></tr>
              <tr><td>Subject</td><td>${student.subject || "—"}</td></tr>
              <tr><td>Exam</td><td>${examName}</td></tr>
              <tr><td>Date & Time</td><td>${examDate}</td></tr>
              <tr><td>Guardian</td><td>${student.guardian}</td></tr>
              <tr><td>Contact</td><td>${student.phone}</td></tr>
            </table>
          </div>
        </div>
        <div class="instructions">
          <strong>📌 Instructions:</strong> &nbsp;Bring this card to the exam hall. &nbsp;Arrive 15 min early. &nbsp;No mobile phones allowed. &nbsp;Write roll number on answer sheet. &nbsp;Present this card to the invigilator.
        </div>
        <div class="footer">
          <span>Generated: ${new Date().toLocaleDateString("en-BD")} · CoachlyBD</span>
          <div class="sig-box" style="margin:0;border-top:1px solid #CBD5E1;padding-top:4px">Principal / Seal</div>
        </div>
      </div>
      <script>window.addEventListener('load',()=>{setTimeout(()=>window.print(),300)})</script>
    </body></html>`;
    openPrintWindow(html, `admit-card-${student.roll}`);
  };

  // ID Card PDF
  const downloadIDCard = (student, opts = {}) => {
    const primary = opts.primary || "#1E293B";
    const accent = opts.accent || "#16A34A";
    const logoSrc = account?.logoImage
      ? `<img src="${account.logoImage}" style="width:48px;height:48px;border-radius:10px;object-fit:cover;" />`
      : `<div class="logo-icon">${account?.logo || initials(account?.name || "CB")}</div>`;
    const photoSrc = student.photo
      ? `<img src="${student.photo}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,0.5);" />`
      : `<div class="avatar">${student.avatar || student.name[0]}</div>`;
    const validYear = opts.validYear || CURRENT_YEAR;

    // Template overlay mode
    if (opts.templateMode === "template" && opts.templateImg) {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ID Card — ${student.name}</title>
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{background:#1a2a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;font-family:'Segoe UI',Arial,sans-serif}
          .wrap{position:relative;width:86mm;}
          .bg{width:100%;display:block;}
          .data{position:absolute;top:0;left:0;width:100%;height:100%;padding:38% 8% 8%;color:#0F172A}
          .name{font-size:14px;font-weight:900;margin-bottom:4px}
          .roll{font-size:12px;font-weight:700;margin-bottom:4px}
          .batch{font-size:11px;color:#444}
          .photo-overlay{position:absolute;top:5%;left:50%;transform:translateX(-50%);width:60px;height:60px;border-radius:50%;object-fit:cover;}
          @media print{body{background:#fff;padding:0}}
        </style></head><body>
        <div class="wrap">
          <img class="bg" src="${opts.templateImg}" />
          <div class="data">
            <div class="name">${student.name}</div>
            <div class="roll">Roll: ${student.roll}</div>
            <div class="batch">${student.batch} · ${student.subject || ""}</div>
          </div>
          ${student.photo ? `<img class="photo-overlay" src="${student.photo}" />` : ""}
        </div>
        <script>window.addEventListener('load',()=>{setTimeout(()=>window.print(),300)})</script>
      </body></html>`;
      openPrintWindow(html, `id-card-${student.roll}`);
      return;
    }

    // Size map
    const sizeMap = { CR80: "86mm", A6: "105mm", WIDE: "100mm" };
    const cardW = sizeMap[opts.ratio] || "86mm";

    // Background style
    const cardBg = opts.design === "gradient"
      ? `linear-gradient(145deg,${primary} 0%,${primary}CC 60%,${accent} 100%)`
      : opts.design === "flat"
      ? primary
      : "#fff";
    const textColor = opts.design === "bordered" ? primary : "#fff";
    const borderStyle = opts.design === "bordered" ? `border:3px solid ${primary};` : "";

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ID Card — ${student.name}</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Segoe UI',Arial,sans-serif;background:#1a2a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
        .card{background:${cardBg};${borderStyle}border-radius:12px;padding:18px;width:${cardW};color:${textColor};position:relative;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.5)}
        .card::before{content:'';position:absolute;top:-50px;right:-50px;width:160px;height:160px;background:${opts.design === "bordered" ? "transparent" : "rgba(255,255,255,0.06)"};border-radius:50%;pointer-events:none}
        .header{display:flex;align-items:center;gap:10px;margin-bottom:12px;position:relative;z-index:1}
        .logo-icon{width:40px;height:40px;background:${opts.design === "bordered" ? accent + "20" : "rgba(255,255,255,0.15)"};border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:${opts.design === "bordered" ? accent : "#fff"};flex-shrink:0;border:1.5px solid ${opts.design === "bordered" ? accent + "40" : "rgba(255,255,255,0.2)"}}
        .school-name{font-size:12px;font-weight:800;line-height:1.3}
        .school-sub{font-size:9px;opacity:0.6;margin-top:1px}
        .id-badge{background:${accent};color:#fff;border-radius:4px;padding:2px 8px;font-size:9px;font-weight:900;display:inline-block;letter-spacing:1px;margin-bottom:10px;position:relative;z-index:1}
        .photo-row{display:flex;justify-content:center;margin-bottom:10px;position:relative;z-index:1}
        .avatar{width:70px;height:70px;background:rgba(255,255,255,0.12);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;border:3px solid ${opts.design === "bordered" ? accent : "rgba(255,255,255,0.35)"}}
        .name{text-align:center;font-size:15px;font-weight:900;position:relative;z-index:1;margin-bottom:4px}
        .roll{text-align:center;background:${opts.design === "bordered" ? accent + "15" : "rgba(255,255,255,0.1)"};border-radius:6px;padding:5px;margin:6px 0;font-size:13px;font-weight:900;letter-spacing:2px;position:relative;z-index:1;border:1px solid ${opts.design === "bordered" ? accent + "30" : "rgba(255,255,255,0.15)"}}
        .info{font-size:10px;display:flex;flex-direction:column;gap:0;position:relative;z-index:1}
        .info-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid ${opts.design === "bordered" ? primary + "15" : "rgba(255,255,255,0.08)"}}
        .info-row span:first-child{opacity:0.55}
        .info-row span:last-child{font-weight:700}
        .barcode{text-align:center;margin-top:10px;font-size:8px;opacity:0.3;letter-spacing:2px;position:relative;z-index:1;font-family:monospace}
        .valid{text-align:center;font-size:9px;opacity:0.4;margin-top:3px;position:relative;z-index:1}
        @media print{body{background:#fff;padding:0}.card{box-shadow:none}}
      </style></head><body>
      <div class="card">
        <div class="header">
          ${logoSrc}
          <div>
            <div class="school-name">${account?.name || "Coaching Center"}</div>
            <div class="school-sub">${account?.address || "Student Identity Card"}</div>
          </div>
        </div>
        <div style="text-align:center;margin-bottom:10px;position:relative;z-index:1">
          <span class="id-badge">STUDENT IDENTITY CARD</span>
        </div>
        <div class="photo-row">${photoSrc}</div>
        <div class="name">${student.name}</div>
        <div class="roll">Roll No: ${student.roll}</div>
        <div class="info">
          <div class="info-row"><span>Batch</span><span>${student.batch}</span></div>
          <div class="info-row"><span>Subject</span><span>${student.subject || "—"}</span></div>
          <div class="info-row"><span>Guardian</span><span>${student.guardian}</span></div>
          <div class="info-row"><span>Phone</span><span>${student.phone}</span></div>
          <div class="info-row"><span>Enrolled</span><span>${student.joinDate || "2025"}</span></div>
        </div>
        <div class="barcode">|||&nbsp;||&nbsp;||||&nbsp;||&nbsp;|||&nbsp;${student.roll}&nbsp;|||&nbsp;||&nbsp;||||</div>
        <div class="valid">Valid: ${validYear} · ${account?.name || "CoachlyBD"}</div>
      </div>
      <script>window.addEventListener('load',()=>{setTimeout(()=>window.print(),300)})</script>
    </body></html>`;
    openPrintWindow(html, `id-card-${student.roll}`);
  };

  const seatedIds = new Set(Object.values(seatMap));
  const eligibleStudents = examBatch === "all" ? students : students.filter(s => s.batch === examBatch);
  const unseatedStudents = eligibleStudents.filter(s => !seatedIds.has(s.id));

  return (
    <div>
      <SectionHeader title="Exam Tools" />
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {[["seatplan", "🪑 Seat Plan"], ["admitcard", "📋 Admit Cards"], ["idcard", "🪪 ID Cards"], ["results", "🏆 Results"]].map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={{ flex: 1, padding: "9px 8px", borderRadius: 10, border: "none", fontSize: 12, fontWeight: 700, background: tab === v ? C.primary : C.bg, color: tab === v ? "#fff" : C.muted, cursor: "pointer" }}>{l}</button>
        ))}
      </div>

      {/* ══ SEAT PLAN ══ */}
      {tab === "seatplan" && (
        <div>
          {/* Config row */}
          <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 14, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 12 }}>⚙️ Seat Plan Setup</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Rows</label>
                <input type="number" min={1} max={15} value={rows} onChange={e => setRows(parseInt(e.target.value) || 1)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 14, fontWeight: 700, textAlign: "center", outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Columns</label>
                <input type="number" min={1} max={15} value={cols} onChange={e => setCols(parseInt(e.target.value) || 1)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 14, fontWeight: 700, textAlign: "center", outline: "none", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Filter Batch</label>
              <select value={examBatch} onChange={e => setExamBatch(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", background: C.white, fontFamily: FONT }}>
                <option value="all">All Batches</option>
                {batches.map(b => <option key={b.id} value={b.name}>{b.name} — {b.fullName}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Exam Name</label>
                <input value={examName} onChange={e => setExamName(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: FONT }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Date</label>
                <input type="date" value={examDate} onChange={e => setExamDate(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: FONT }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn full variant="primary" onClick={autoAssign}>🎲 Auto-Assign Seats</Btn>
              <Btn variant="soft" onClick={() => setSeatMap({})}>🗑️ Clear</Btn>
            </div>
          </div>

          {/* Drag-drop unassigned pool */}
          {unseatedStudents.length > 0 && (
            <div style={{ background: C.infoLight, borderRadius: 12, padding: "10px 14px", marginBottom: 14, border: `1px solid ${C.info}30` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.info, marginBottom: 8 }}>👤 Unassigned Students (drag to a seat)</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {unseatedStudents.map(s => (
                  <div key={s.id} draggable onDragStart={() => handleDragStart(s.id)}
                    style={{ background: C.white, border: `1.5px solid ${C.info}40`, borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "grab", color: C.text, userSelect: "none" }}>
                    {s.name} <span style={{ color: C.muted, fontSize: 10 }}>#{s.roll}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Grid */}
          <div style={{ background: C.card, borderRadius: 14, padding: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.06)", overflowX: "auto" }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: C.muted, marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
              <span>🏫 Exam Hall — {rows}×{cols} = {rows * cols} seats</span>
              <span style={{ color: C.success }}>{Object.keys(seatMap).length} assigned</span>
            </div>
            <div style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: C.muted, background: C.borderLight, borderRadius: 8, padding: "6px", marginBottom: 12 }}>📋 BLACKBOARD / FRONT</div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(70px, 1fr))`, gap: 6 }}>
              {Array.from({ length: rows }, (_, r) =>
                Array.from({ length: cols }, (_, c) => {
                  const key = `${r}-${c}`;
                  const sid = seatMap[key];
                  const student = sid ? studentById(sid) : null;
                  return (
                    <div key={key}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => handleDropOnSeat(key)}
                      draggable={!!student}
                      onDragStart={() => student && handleSeatDragStart(key)}
                      onClick={() => !student && null}
                      style={{
                        border: `2px dashed ${student ? C.success : C.border}`,
                        borderRadius: 10, padding: "6px 4px", minHeight: 64, textAlign: "center",
                        background: student ? C.successLight : C.bg,
                        cursor: student ? "grab" : "default",
                        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
                        transition: "all 0.1s", position: "relative"
                      }}>
                      <div style={{ fontSize: 9, color: C.muted, fontWeight: 600 }}>R{r + 1}-C{c + 1}</div>
                      {student ? (
                        <>
                          <div style={{ fontSize: 11, fontWeight: 700, color: C.success, lineHeight: 1.2, textAlign: "center" }}>{student.name.split(" ")[0]}</div>
                          <div style={{ fontSize: 10, color: C.muted }}>{student.roll}</div>
                          <button onClick={(e) => { e.stopPropagation(); clearSeat(key); }} style={{ position: "absolute", top: 2, right: 4, background: "none", border: "none", cursor: "pointer", fontSize: 10, color: C.danger, lineHeight: 1, padding: 0 }}>✕</button>
                        </>
                      ) : (
                        <div style={{ fontSize: 18, opacity: 0.3 }}>💺</div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══ ADMIT CARDS ══ */}
      {tab === "admitcard" && (
        <AdmitCardTab students={students} batches={batches} account={account}
          examName={examName} setExamName={setExamName}
          examDate={examDate} setExamDate={setExamDate}
          downloadAdmitCard={downloadAdmitCard} />
      )}

      {/* ══ ID CARDS ══ */}
      {tab === "idcard" && (
        <IDCardTab students={students} batches={batches} account={account}
          downloadIDCard={downloadIDCard} />
      )}

      {/* ══ RESULTS ENTRY ══ */}
      {tab === "results" && (
        <ExamResultsTab
          students={students}
          batches={batches}
          examName={examName}
          examDate={examDate}
          toast={toast}
          openPrintWindow={openPrintWindow}
          account={account}
        />
      )}
    </div>
  );
}

// ─── STAFF RESTRICTED VIEW ────────────────────────────────────
// ─── ADMIT CARD TAB ───────────────────────────────────────────
function AdmitCardTab({ students, batches, account, examName, setExamName, examDate, setExamDate, downloadAdmitCard }) {
  const [filterBatch, setFilterBatch] = useState("all");
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [cardStyle, setCardStyle] = useState({
    ratio: "A5", // A5 | A4 | ID_LANDSCAPE
    colorScheme: "green", // green | blue | maroon | dark | custom
    design: "modern", // modern | classic | minimal
    customColor: "#16A34A",
    templateImg: null,
  });
  const [templateMode, setTemplateMode] = useState("builtin"); // builtin | template

  const colorSchemes = {
    green:  { primary: "#16A34A", dark: "#14532D", label: "Green" },
    blue:   { primary: "#2563EB", dark: "#1E3A8A", label: "Blue" },
    maroon: { primary: "#9B1C1C", dark: "#4C0519", label: "Maroon" },
    dark:   { primary: "#1E293B", dark: "#0F172A", label: "Dark" },
    custom: { primary: cardStyle.customColor, dark: cardStyle.customColor, label: "Custom" },
  };

  const filtered = students.filter(s =>
    (filterBatch === "all" || s.batch === filterBatch) &&
    (search === "" || s.name.toLowerCase().includes(search.toLowerCase()) || s.roll.includes(search))
  );

  const handleDownload = (s) => {
    const scheme = colorSchemes[cardStyle.colorScheme];
    downloadAdmitCard(s, { ...cardStyle, ...scheme, templateMode });
  };

  const handleDownloadAll = () => {
    if (filtered.length === 0) return;
    filtered.forEach((s, i) => setTimeout(() => handleDownload(s), i * 600));
  };

  return (
    <div>
      {/* Exam config */}
      <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>📋 Exam Details</div>
          <Btn size="sm" variant={showSettings ? "primary" : "soft"} onClick={() => setShowSettings(s => !s)}>🎨 Card Design</Btn>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Exam Name</label>
            <input value={examName} onChange={e => setExamName(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: FONT }} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Exam Date</label>
            <input type="date" value={examDate} onChange={e => setExamDate(e.target.value)} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: FONT }} />
          </div>
        </div>

        {/* Design settings panel */}
        {showSettings && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
            {/* Mode: built-in vs template */}
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {[["builtin", "🎨 Built-in Designs"], ["template", "📁 Upload Template"]].map(([m, l]) => (
                <button key={m} onClick={() => setTemplateMode(m)} style={{ flex: 1, padding: "8px", borderRadius: 9, border: `1.5px solid ${templateMode === m ? C.primary : C.border}`, background: templateMode === m ? C.primaryLight : C.bg, color: templateMode === m ? C.primary : C.muted, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{l}</button>
              ))}
            </div>

            {templateMode === "builtin" ? (
              <>
                {/* Size/ratio */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>📐 Card Size</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["A5", "A5 (148×210mm)"], ["A4", "A4 Full Page"], ["ID_LANDSCAPE", "ID Landscape"]].map(([v, l]) => (
                      <button key={v} onClick={() => setCardStyle(s => ({ ...s, ratio: v }))} style={{ flex: 1, padding: "7px 6px", borderRadius: 8, border: `1.5px solid ${cardStyle.ratio === v ? C.primary : C.border}`, background: cardStyle.ratio === v ? C.primaryLight : C.bg, color: cardStyle.ratio === v ? C.primary : C.muted, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{l}</button>
                    ))}
                  </div>
                </div>
                {/* Color scheme */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>🎨 Color Scheme</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {Object.entries(colorSchemes).map(([k, v]) => (
                      k !== "custom" ? (
                        <button key={k} onClick={() => setCardStyle(s => ({ ...s, colorScheme: k }))} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, border: `2px solid ${cardStyle.colorScheme === k ? v.primary : C.border}`, background: cardStyle.colorScheme === k ? v.primary + "15" : C.bg, cursor: "pointer" }}>
                          <div style={{ width: 14, height: 14, borderRadius: "50%", background: v.primary }} />
                          <span style={{ fontSize: 12, fontWeight: 600, color: cardStyle.colorScheme === k ? v.primary : C.muted }}>{v.label}</span>
                        </button>
                      ) : (
                        <div key={k} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, border: `2px solid ${cardStyle.colorScheme === "custom" ? C.primary : C.border}`, background: C.bg, cursor: "pointer" }} onClick={() => setCardStyle(s => ({ ...s, colorScheme: "custom" }))}>
                          <input type="color" value={cardStyle.customColor} onChange={e => setCardStyle(s => ({ ...s, customColor: e.target.value, colorScheme: "custom" }))} style={{ width: 18, height: 18, border: "none", padding: 0, cursor: "pointer", borderRadius: "50%" }} />
                          <span style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>Custom</span>
                        </div>
                      )
                    ))}
                  </div>
                </div>
                {/* Design style */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>✨ Design Style</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["modern", "🔷 Modern"], ["classic", "📜 Classic"], ["minimal", "⬜ Minimal"]].map(([v, l]) => (
                      <button key={v} onClick={() => setCardStyle(s => ({ ...s, design: v }))} style={{ flex: 1, padding: "7px 6px", borderRadius: 8, border: `1.5px solid ${cardStyle.design === v ? C.primary : C.border}`, background: cardStyle.design === v ? C.primaryLight : C.bg, color: cardStyle.design === v ? C.primary : C.muted, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{l}</button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div style={{ background: C.bg, borderRadius: 12, padding: 16, border: `2px dashed ${C.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>📁 Upload Admit Card Template</div>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>
                  Upload a PNG/JPG template (A5 size recommended). Student data will be printed on top of it at fixed positions. Keep blank spaces for: Roll No, Name, Batch, Exam, Date, Guardian.
                </div>
                {cardStyle.templateImg ? (
                  <div style={{ position: "relative" }}>
                    <img src={cardStyle.templateImg} alt="template" style={{ width: "100%", borderRadius: 8, border: `1px solid ${C.border}` }} />
                    <button onClick={() => setCardStyle(s => ({ ...s, templateImg: null }))} style={{ position: "absolute", top: 6, right: 6, background: C.danger, border: "none", borderRadius: "50%", width: 24, height: 24, color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                    <div style={{ marginTop: 8, background: C.successLight, borderRadius: 8, padding: "8px 12px", fontSize: 12, color: C.success, fontWeight: 600 }}>✅ Template loaded — student data will overlay on download</div>
                  </div>
                ) : (
                  <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "20px", border: `2px dashed ${C.primary}`, borderRadius: 12, cursor: "pointer", background: C.primaryLight + "50" }}>
                    <span style={{ fontSize: 28 }}>🖼️</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.primary }}>Click to upload template</span>
                    <span style={{ fontSize: 11, color: C.muted }}>PNG, JPG — A5 size (148×210mm)</span>
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => {
                      const f = e.target.files[0]; if (!f) return;
                      const r = new FileReader(); r.onload = ev => setCardStyle(s => ({ ...s, templateImg: ev.target.result })); r.readAsDataURL(f);
                    }} />
                  </label>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Search + filter + download all */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search name or roll…" style={{ flex: 1, padding: "8px 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", fontFamily: FONT }} />
        <select value={filterBatch} onChange={e => setFilterBatch(e.target.value)} style={{ padding: "8px 10px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 12, background: C.white, outline: "none", fontFamily: FONT }}>
          <option value="all">All Batches</option>
          {batches.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
        </select>
      </div>
      {filtered.length > 1 && (
        <Btn full variant="primary" style={{ marginBottom: 10 }} onClick={handleDownloadAll}>
          📥 Download All {filtered.length} Admit Cards
        </Btn>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map(s => (
          <div key={s.id} style={{ background: C.card, borderRadius: 12, padding: "12px 16px", boxShadow: "0 1px 6px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 12 }}>
            {s.photo
              ? <img src={s.photo} alt={s.name} style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover", border: `2px solid ${C.primary}` }} />
              : <Av label={s.avatar} size={40} bg={C.primary} />}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{s.name}</div>
              <div style={{ fontSize: 12, color: C.muted }}>Roll {s.roll} · {s.batch} · {s.subject || "—"}</div>
            </div>
            <Btn size="sm" variant="primary" onClick={() => handleDownload(s)}>📄 Download</Btn>
          </div>
        ))}
        {filtered.length === 0 && <EmptyState icon="👥" title={students.length === 0 ? "No students yet" : "No match found"} sub={students.length === 0 ? "Add students first to generate admit cards" : "Try a different search or batch"} />}
      </div>
    </div>
  );
}

// ─── ID CARD TAB ──────────────────────────────────────────────
function IDCardTab({ students, batches, account, downloadIDCard }) {
  const [filterBatch, setFilterBatch] = useState("all");
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [cardStyle, setCardStyle] = useState({
    ratio: "CR80",    // CR80 (standard ID) | A6 | WIDE
    colorScheme: "dark",
    design: "gradient", // gradient | flat | bordered
    customColor: "#16A34A",
    templateImg: null,
    validYear: String(CURRENT_YEAR),
  });
  const [templateMode, setTemplateMode] = useState("builtin");

  const colorSchemes = {
    dark:   { primary: "#1E293B", accent: "#16A34A", label: "Dark Green" },
    navy:   { primary: "#1E3A8A", accent: "#3B82F6", label: "Navy Blue" },
    maroon: { primary: "#7F1D1D", accent: "#EF4444", label: "Maroon" },
    purple: { primary: "#4C1D95", accent: "#8B5CF6", label: "Purple" },
    custom: { primary: cardStyle.customColor, accent: cardStyle.customColor, label: "Custom" },
  };

  const filtered = students.filter(s =>
    (filterBatch === "all" || s.batch === filterBatch) &&
    (search === "" || s.name.toLowerCase().includes(search.toLowerCase()) || s.roll.includes(search))
  );

  const handleDownload = (s) => {
    const scheme = colorSchemes[cardStyle.colorScheme];
    downloadIDCard(s, { ...cardStyle, ...scheme, templateMode });
  };

  const handleDownloadAll = () => filtered.forEach((s, i) => setTimeout(() => handleDownload(s), i * 600));

  return (
    <div>
      {/* Design settings */}
      <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>🪪 ID Card Settings</div>
          <Btn size="sm" variant={showSettings ? "primary" : "soft"} onClick={() => setShowSettings(s => !s)}>🎨 Customize</Btn>
        </div>

        {showSettings && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {[["builtin", "🎨 Built-in Designs"], ["template", "📁 Upload Template"]].map(([m, l]) => (
                <button key={m} onClick={() => setTemplateMode(m)} style={{ flex: 1, padding: "8px", borderRadius: 9, border: `1.5px solid ${templateMode === m ? C.primary : C.border}`, background: templateMode === m ? C.primaryLight : C.bg, color: templateMode === m ? C.primary : C.muted, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{l}</button>
              ))}
            </div>

            {templateMode === "builtin" ? (
              <>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>📐 Card Size</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["CR80", "CR80 Standard (86×54mm)"], ["A6", "A6 Large (105×74mm)"], ["WIDE", "Wide (100×60mm)"]].map(([v, l]) => (
                      <button key={v} onClick={() => setCardStyle(s => ({ ...s, ratio: v }))} style={{ flex: 1, padding: "7px 4px", borderRadius: 8, border: `1.5px solid ${cardStyle.ratio === v ? C.primary : C.border}`, background: cardStyle.ratio === v ? C.primaryLight : C.bg, color: cardStyle.ratio === v ? C.primary : C.muted, fontSize: 10, fontWeight: 600, cursor: "pointer", lineHeight: 1.3, textAlign: "center" }}>{l}</button>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>🎨 Color Scheme</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {Object.entries(colorSchemes).map(([k, v]) => (
                      k !== "custom" ? (
                        <button key={k} onClick={() => setCardStyle(s => ({ ...s, colorScheme: k }))} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, border: `2px solid ${cardStyle.colorScheme === k ? v.primary : C.border}`, background: cardStyle.colorScheme === k ? v.primary + "15" : C.bg, cursor: "pointer" }}>
                          <div style={{ width: 14, height: 14, borderRadius: "50%", background: v.primary }} />
                          <span style={{ fontSize: 12, fontWeight: 600, color: cardStyle.colorScheme === k ? v.primary : C.muted }}>{v.label}</span>
                        </button>
                      ) : (
                        <div key={k} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, border: `2px solid ${cardStyle.colorScheme === "custom" ? C.primary : C.border}`, background: C.bg, cursor: "pointer" }} onClick={() => setCardStyle(s => ({ ...s, colorScheme: "custom" }))}>
                          <input type="color" value={cardStyle.customColor} onChange={e => setCardStyle(s => ({ ...s, customColor: e.target.value, colorScheme: "custom" }))} style={{ width: 18, height: 18, border: "none", padding: 0, cursor: "pointer" }} />
                          <span style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>Custom</span>
                        </div>
                      )
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>✨ Design Style</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["gradient", "🌈 Gradient"], ["flat", "⬛ Flat"], ["bordered", "🔲 Bordered"]].map(([v, l]) => (
                      <button key={v} onClick={() => setCardStyle(s => ({ ...s, design: v }))} style={{ flex: 1, padding: "7px 6px", borderRadius: 8, border: `1.5px solid ${cardStyle.design === v ? C.primary : C.border}`, background: cardStyle.design === v ? C.primaryLight : C.bg, color: cardStyle.design === v ? C.primary : C.muted, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{l}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: C.text, display: "block", marginBottom: 6 }}>📅 Valid Year</label>
                  <input value={cardStyle.validYear} onChange={e => setCardStyle(s => ({ ...s, validYear: e.target.value }))} style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: FONT }} placeholder="e.g. 2026" />
                </div>
              </>
            ) : (
              <div style={{ background: C.bg, borderRadius: 12, padding: 16, border: `2px dashed ${C.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>📁 Upload ID Card Template</div>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>Upload a PNG/JPG template (CR80 86×54mm or A6). Keep blank spaces for: photo, name, roll, batch, phone. Student data will overlay on download.</div>
                {cardStyle.templateImg ? (
                  <div style={{ position: "relative" }}>
                    <img src={cardStyle.templateImg} alt="template" style={{ width: "100%", borderRadius: 8, border: `1px solid ${C.border}` }} />
                    <button onClick={() => setCardStyle(s => ({ ...s, templateImg: null }))} style={{ position: "absolute", top: 6, right: 6, background: C.danger, border: "none", borderRadius: "50%", width: 24, height: 24, color: "#fff", fontSize: 12, cursor: "pointer" }}>✕</button>
                    <div style={{ marginTop: 8, background: C.successLight, borderRadius: 8, padding: "8px 12px", fontSize: 12, color: C.success, fontWeight: 600 }}>✅ Template loaded</div>
                  </div>
                ) : (
                  <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "20px", border: `2px dashed ${C.primary}`, borderRadius: 12, cursor: "pointer", background: C.primaryLight + "50" }}>
                    <span style={{ fontSize: 28 }}>🖼️</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.primary }}>Click to upload template</span>
                    <span style={{ fontSize: 11, color: C.muted }}>PNG, JPG — CR80 (86×54mm) recommended</span>
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => {
                      const f = e.target.files[0]; if (!f) return;
                      const r = new FileReader(); r.onload = ev => setCardStyle(s => ({ ...s, templateImg: ev.target.result })); r.readAsDataURL(f);
                    }} />
                  </label>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Search + filter */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search name or roll…" style={{ flex: 1, padding: "8px 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", fontFamily: FONT }} />
        <select value={filterBatch} onChange={e => setFilterBatch(e.target.value)} style={{ padding: "8px 10px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 12, background: C.white, outline: "none", fontFamily: FONT }}>
          <option value="all">All Batches</option>
          {batches.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
        </select>
      </div>
      {filtered.length > 1 && (
        <Btn full variant="soft" style={{ marginBottom: 10, color: C.purple, border: `1.5px solid ${C.purple}` }} onClick={handleDownloadAll}>
          📥 Download All {filtered.length} ID Cards
        </Btn>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map(s => (
          <div key={s.id} style={{ background: C.card, borderRadius: 12, padding: "12px 16px", boxShadow: "0 1px 6px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 12 }}>
            {s.photo
              ? <img src={s.photo} alt={s.name} style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover", border: `2px solid ${C.purple}` }} />
              : <Av label={s.avatar} size={40} bg={C.purple} />}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{s.name}</div>
              <div style={{ fontSize: 12, color: C.muted }}>Roll {s.roll} · {s.batch}</div>
            </div>
            <Btn size="sm" variant="soft" style={{ color: C.purple, border: `1.5px solid ${C.purple}` }} onClick={() => handleDownload(s)}>🪪 Download</Btn>
          </div>
        ))}
        {filtered.length === 0 && <EmptyState icon="🪪" title={students.length === 0 ? "No students yet" : "No match found"} sub={students.length === 0 ? "Add students first to generate ID cards" : "Try a different search or batch"} />}
      </div>
    </div>
  );
}

// ─── STAFF VIEW (Single unified role) ────────────────────────
// Staff can: view everything, record NEW fee payments (Mark Paid)
// Staff CANNOT: reverse payments, override fees, change amounts, 
//               edit students/teachers, access Settings
// This prevents the scenario where a manager "marks half" and pockets the difference
function StaffLoginPanel({ staffAccounts = [], onStaffLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) { setError("Enter username and password."); return; }
    setError(""); setLoading(true);
    await new Promise(r => setTimeout(r, 300));
    const acc = staffAccounts.find(s => s.username === username && s.password === password && s.active);
    setLoading(false);
    if (acc) { onStaffLogin(acc); }
    else { setError("Invalid username or password, or account is inactive."); }
  };

  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 4, fontFamily: "Georgia, serif" }}>Staff Sign In</div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Enter your staff credentials</div>
      {error && <div style={{ background: C.dangerLight, color: C.danger, padding: "10px 14px", borderRadius: 10, fontSize: 13, marginBottom: 14, fontWeight: 500 }}>{error}</div>}
      <Input label="Username" value={username} onChange={setUsername} placeholder="Enter username" prefix="👤" />
      <Input label="Password" value={password} onChange={setPassword} type="password" placeholder="Enter password" prefix="🔒" />
      <Btn full variant="primary" size="lg" onClick={handleLogin} disabled={loading}>
        {loading ? "Signing in..." : "Staff Sign In →"}
      </Btn>
      <div style={{ marginTop: 12, padding: "10px 12px", background: C.infoLight, borderRadius: 10, fontSize: 12, color: C.info }}>
        ℹ️ Staff accounts are created by the owner in Settings → Staff.
      </div>
    </div>
  );
}

function StaffView({ staffSession, students, batches, teachers, payments, setPayments, feeOverrides, toast, onLogout }) {
  const [activeTab, setActiveTab] = useState("Dashboard");
  const [activityLog, setActivityLog] = useState([]); // { time, action, detail }

  const NAV_ICONS = { Dashboard: "📊", Students: "👥", Batches: "📚", Teachers: "👨‍🏫", Fees: "💰", Exams: "📝", "My Log": "📋" };
  const NAV_TABS = ["Dashboard", "Students", "Batches", "Teachers", "Fees", "Exams", "My Log"];

  // Log only vital financial actions
  const logAction = (action, detail) => {
    setActivityLog(prev => [{ id: Date.now(), time: new Date(), action, detail, by: staffSession.name }, ...prev]);
  };

  // Wrap setPayments — logs every payment recorded; blocks reversal
  const staffSetPayments = (updaterOrVal) => {
    // staffMode Fees component never calls reverse (button hidden), but double-lock here
    setPayments(updaterOrVal);
  };

  const tabProps = {
    students, batches, teachers, payments,
    setPayments: staffSetPayments,
    feeOverrides,
    setFeeOverrides: () => {},          // staff cannot change fee overrides/discounts
    isPro: true, toast,
    account: null, setAccount: () => {},
    setStudents: () => {},              // staff cannot edit students
    setTeachers: () => {},              // staff cannot edit teachers/salaries
    setBatches: () => {},               // staff cannot edit batches/fees
    staffMode: true,                    // hides: reverse payment, fee override button, discount settings
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: getC().bg, fontFamily: FONT, colorScheme: darkMode ? "dark" : "light" }}>
      {/* Sidebar */}
      <div style={{ width: 236, background: C.sidebar, display: "flex", flexDirection: "column", height: "100vh", position: "fixed", left: 0, top: 0, zIndex: 200 }}>
        <div style={{ padding: "16px 14px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 34, height: 34, background: C.primary, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>📚</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>CoachlyBD</div>
              <div style={{ fontSize: 10, color: "#64748B" }}>Staff Portal</div>
            </div>
          </div>
        </div>

        {/* Staff badge */}
        <div style={{ margin: "10px 10px 4px", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, padding: "9px 12px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.accent, marginBottom: 2 }}>👔 STAFF MEMBER</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#E2E8F0" }}>{staffSession.name}</div>
          <div style={{ fontSize: 10, color: "#64748B" }}>@{staffSession.username}</div>
        </div>

        <nav style={{ flex: 1, padding: "4px 8px", overflowY: "auto" }}>
          {NAV_TABS.map(id => {
            const isActive = activeTab === id;
            const isLog = id === "My Log";
            return (
              <button key={id} onClick={() => setActiveTab(id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "8px 9px", borderRadius: 8, border: "none", background: isActive ? (isLog ? "rgba(139,92,246,0.15)" : "rgba(22,163,74,0.15)") : "transparent", cursor: "pointer", marginBottom: 1 }}>
                <div style={{ width: 26, height: 26, borderRadius: 6, background: isActive ? (isLog ? C.purple : C.primary) : "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>{NAV_ICONS[id]}</div>
                <span style={{ fontSize: 12, fontWeight: isActive ? 700 : 400, color: isActive ? "#fff" : "#94A3B8" }}>{id}</span>
                {isLog && activityLog.length > 0 && <span style={{ marginLeft: "auto", background: C.purple, color: "#fff", borderRadius: 10, fontSize: 9, fontWeight: 800, padding: "1px 6px", minWidth: 18, textAlign: "center" }}>{activityLog.length}</span>}
              </button>
            );
          })}
        </nav>

        {/* Today collection summary */}
        <DailyCollectionSummary payments={payments} students={students} staffName={staffSession.name} />

        <div style={{ padding: "10px 10px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <button onClick={onLogout} style={{ width: "100%", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)", borderRadius: 8, color: "#FCA5A5", padding: "8px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>⏻ Sign Out</button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, marginLeft: 236, padding: "20px 24px", minHeight: "100vh" }}>
        {/* Staff restriction banner */}
        <div style={{ background: "linear-gradient(90deg,#FEF3C7,#FFF7ED)", border: `1px solid ${C.warning}30`, borderRadius: 10, padding: "8px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
          <span>🔒</span>
          <div style={{ fontSize: 11, color: C.warning, fontWeight: 700 }}>
            Staff Mode — Cannot: reverse payments · change fee discounts · edit student/batch fees · access Settings
          </div>
        </div>

        {activeTab === "Dashboard"  && <Dashboard {...tabProps} onUpgrade={() => {}} setTab={setActiveTab} />}
        {activeTab === "Students"   && <Students  {...tabProps} readOnly />}
        {activeTab === "Batches"    && <Batches   {...tabProps} readOnly />}
        {activeTab === "Teachers"   && <Teachers  {...tabProps} readOnly />}
        {activeTab === "Fees"       && <Fees      {...tabProps} onPaymentLogged={(info) => logAction("💰 Fee Collected", `${info.studentName} · ${info.month} ${CURRENT_YEAR} · ${info.method} · ৳${info.amount}${info.bulk ? " (bulk)" : ""}`)} />}
        {activeTab === "Exams"      && <Exams students={students} batches={batches} account={null} toast={toast} />}
        {activeTab === "My Log"     && <StaffActivityLog log={activityLog} staffName={staffSession.name} payments={payments} students={students} />}
      </div>
    </div>
  );
}

// ─── STAFF ACTIVITY LOG ──────────────────────────────────────
// Shows only vital financial actions from the last 30 days
function StaffActivityLog({ log, staffName, payments, students }) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Build payment-based history from the payments state (survives page refresh within session)
  const paymentHistory = [];
  students.forEach(s => {
    MONTHS.forEach((m) => {
      const mk = `${m}-${CURRENT_YEAR}`;
      const p = payments[s.id]?.[mk];
      if (p?.status === "paid" && p?.recordedAt) {
        const date = new Date(p.recordedAt);
        if (date > thirtyDaysAgo) {
          paymentHistory.push({
            id: `${s.id}-${mk}`,
            time: date,
            action: "💰 Fee Collected",
            detail: `${s.name} · ${m} ${CURRENT_YEAR} · ${p.method} · ৳${p.recordedBy === "Staff" ? getEffectiveFee(s, mk, {}) : getEffectiveFee(s, mk, {})}`,
            by: p.recordedBy || "Staff",
            method: p.method,
            studentName: s.name,
            month: m,
          });
        }
      }
    });
  });

  // Merge live log (current session) with payment history
  const allEntries = [...log];
  paymentHistory.forEach(ph => {
    const alreadyInLog = log.some(l => l.detail.includes(ph.studentName) && l.detail.includes(ph.month));
    if (!alreadyInLog) allEntries.push(ph);
  });
  allEntries.sort((a, b) => new Date(b.time) - new Date(a.time));

  // Summary stats
  const totalCollected = paymentHistory.reduce((a, p) => {
    const s = students.find(st => st.name === p.studentName);
    const mk = `${p.month}-${CURRENT_YEAR}`;
    return a + (s ? getEffectiveFee(s, mk, {}) : 0);
  }, 0);

  const todayEntries = allEntries.filter(e => {
    const d = new Date(e.time);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });

  const todayTotal = todayEntries.reduce((a, e) => {
    if (!e.action.includes("Fee")) return a;
    const s = students.find(st => e.detail.includes(st.name));
    if (!s) return a;
    const m = MONTHS.find(mo => e.detail.includes(mo));
    if (!m) return a;
    return a + getEffectiveFee(s, `${m}-${CURRENT_YEAR}`, {});
  }, 0);

  const fmt = (date) => {
    const d = new Date(date);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHrs = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return `${diffDays}d ago · ${d.toLocaleDateString("en-BD", { day: "numeric", month: "short" })}`;
  };

  return (
    <div>
      <SectionHeader title="My Activity Log" />

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div style={{ background: C.successLight, borderRadius: 14, padding: "14px 16px" }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: C.success }}>৳{todayTotal.toLocaleString()}</div>
          <div style={{ fontSize: 11, color: C.success, fontWeight: 700, marginTop: 2 }}>Collected Today</div>
          <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{todayEntries.length} transaction(s)</div>
        </div>
        <div style={{ background: C.infoLight, borderRadius: 14, padding: "14px 16px" }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: C.info }}>৳{totalCollected.toLocaleString()}</div>
          <div style={{ fontSize: 11, color: C.info, fontWeight: 700, marginTop: 2 }}>Last 30 Days</div>
          <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{paymentHistory.length} payment(s)</div>
        </div>
      </div>

      {/* Notice */}
      <div style={{ background: C.accentLight, borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: C.warning, border: `1px solid ${C.accent}30` }}>
        📋 This log records <strong>vital financial actions only</strong> — fee collections in the last 30 days. The owner can see the same data in the Fees section with "recorded by" stamps.
      </div>

      {/* Log entries */}
      {allEntries.length === 0 ? (
        <EmptyState icon="📋" title="No activity yet" sub="Fee collections and other vital actions will appear here" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {allEntries.map((entry, i) => (
            <div key={entry.id || i} style={{ background: C.card, borderRadius: 12, padding: "12px 14px", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", borderLeft: `3px solid ${C.success}`, display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: C.successLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>💰</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{entry.action}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 1.5 }}>{entry.detail}</div>
              </div>
              <div style={{ fontSize: 11, color: C.muted, flexShrink: 0, textAlign: "right" }}>
                <div>{fmt(entry.time)}</div>
                {entry.by && <div style={{ fontSize: 10, color: C.subtle, marginTop: 1 }}>by {entry.by}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Daily collection summary widget shown in staff sidebar
function DailyCollectionSummary({ payments, students, staffName }) {
  const today = new Date().toLocaleDateString("en-BD");
  const todayPaidByStaff = [];
  students.forEach(s => {
    // Monthly fees
    MONTHS.forEach((m, i) => {
      const mk = `${m}-${CURRENT_YEAR}`;
      const p = payments[s.id]?.[mk];
      if (p?.status === "paid" && p?.recordedBy === staffName) {
        todayPaidByStaff.push({ student: s, month: m, method: p.method, fee: getEffectiveFee(s, mk, {}) });
      }
    });
    // Admission fees
    Object.entries(payments[s.id] || {}).forEach(([mk, p]) => {
      if (mk.startsWith("Admission-") && p?.status === "paid" && p?.recordedBy === staffName && p?.amount > 0) {
        todayPaidByStaff.push({ student: s, month: "Admission", method: p.method, fee: p.amount });
      }
    });
  });
  const total = todayPaidByStaff.reduce((a, x) => a + x.fee, 0);
  if (todayPaidByStaff.length === 0) return null;
  return (
    <div style={{ margin: "0 10px 10px", background: "rgba(22,163,74,0.08)", border: "1px solid rgba(22,163,74,0.15)", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.success, marginBottom: 6 }}>📋 My Collected Today</div>
      <div style={{ fontSize: 18, fontWeight: 900, color: "#fff" }}>৳{total.toLocaleString()}</div>
      <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 2 }}>{todayPaidByStaff.length} payment(s) · Hand to owner</div>
    </div>
  );
}

// Staff-specific Fees view: can ONLY mark unpaid months as paid, with clear restrictions


function StaffManager({ staffAccounts, setStaffAccounts, toast, account }) {
  const [modal, setModal] = useState(null);
  const blank = { username: "", password: "", name: "", active: true };
  const [form, setForm] = useState(blank);
  const fld = (k) => (v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.username || !form.password || !form.name) { toast("❌ Fill all required fields"); return; }
    if (form.password.length < 6) { toast("❌ Password must be at least 6 characters"); return; }
    const centerId = account?.id;
    if (modal === "add") {
      if (staffAccounts.find(s => s.username === form.username)) { toast("❌ Username already taken"); return; }
      const { data: row, error } = await supabase.from("staff_accounts").insert({
        center_id: centerId, name: form.name, username: form.username,
        password: form.password, role: "staff", active: true,
      }).select().single();
      if (error) { toast("❌ " + error.message); return; }
      setStaffAccounts(a => [...a, dbToStaff(row)]);
      toast("✅ Staff account created!");
    } else {
      const { error } = await supabase.from("staff_accounts").update({
        name: form.name, username: form.username, password: form.password,
      }).eq("id", modal.id);
      if (error) { toast("❌ " + error.message); return; }
      setStaffAccounts(a => a.map(x => x.id === modal.id ? { ...x, ...form } : x));
      toast("✅ Staff account updated!");
    }
    setModal(null);
  };

  const toggleActive = async (id) => {
    const acc = staffAccounts.find(s => s.id === id);
    if (!acc) return;
    const { error } = await supabase.from("staff_accounts").update({ active: !acc.active }).eq("id", id);
    if (error) { toast("❌ " + error.message); return; }
    setStaffAccounts(a => a.map(x => x.id === id ? { ...x, active: !x.active } : x));
  };

  const del = async (id) => {
    const { error } = await supabase.from("staff_accounts").delete().eq("id", id);
    if (error) { toast("❌ " + error.message); return; }
    setStaffAccounts(a => a.filter(x => x.id !== id));
    toast("🗑️ Staff removed");
    setModal(null);
  };

  return (
    <div style={{ background: C.card, borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>👥 Staff Accounts</div>
        <Btn size="sm" variant="primary" onClick={() => { setForm(blank); setModal("add"); }}>➕ Add Staff</Btn>
      </div>

      {/* Permission summary */}
      <div style={{ background: "#F0FDF4", borderRadius: 12, padding: 14, marginBottom: 14, border: "1px solid #BBF7D0" }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: C.success, marginBottom: 8 }}>✅ Staff Can Do</div>
        <div style={{ fontSize: 12, color: C.text, lineHeight: 2 }}>• View students, batches, teachers, dashboard<br />• Record fee payments (Mark Paid)<br />• Collect cash/bKash and record the method</div>
      </div>
      <div style={{ background: C.dangerLight, borderRadius: 12, padding: 14, marginBottom: 14, border: "1px solid #FECACA" }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: C.danger, marginBottom: 8 }}>🔒 Staff Cannot Do (Owner Only)</div>
        <div style={{ fontSize: 12, color: C.text, lineHeight: 2 }}>• Reverse or undo a recorded payment<br />• Change fee amounts or apply discounts<br />• Edit student, teacher, or batch records<br />• Access Settings, plan, or salary data</div>
      </div>

      {staffAccounts.length === 0 && <EmptyState icon="👥" title="No staff accounts yet" sub="Add staff who need access to record fee payments and view data" />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {staffAccounts.map(s => (
          <div key={s.id} style={{ borderRadius: 12, padding: "12px 14px", border: `1.5px solid ${s.active ? C.primary + "30" : C.border}`, background: s.active ? C.primaryLight + "40" : C.bg, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: s.active ? C.primary : C.muted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>👔</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{s.name}</div>
              <div style={{ fontSize: 12, color: C.muted }}>@{s.username}</div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Badge text={s.active ? "Active" : "Paused"} type={s.active ? "active" : "neutral"} small />
              <Btn size="sm" variant="soft" onClick={() => { setForm({ ...s }); setModal(s); }}>✏️</Btn>
              <Btn size="sm" variant={s.active ? "soft" : "success"} onClick={() => toggleActive(s.id)}>{s.active ? "Pause" : "Enable"}</Btn>
            </div>
          </div>
        ))}
      </div>

      {(modal === "add" || (modal && modal.id)) && (
        <Modal title={modal === "add" ? "Add Staff Account" : `Edit — ${modal.name}`} onClose={() => setModal(null)}>
          <Input label="Full Name" value={form.name} onChange={fld("name")} placeholder="e.g. Sumaiya Akter" required />
          <Input label="Username" value={form.username} onChange={fld("username")} placeholder="e.g. sumaiya" required />
          <Input label="Password" value={form.password} onChange={fld("password")} type="password" placeholder="Minimum 6 characters" required />
          <div style={{ background: C.infoLight, borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 12, color: C.info }}>
            This staff member will be able to view all data and record fee payments. They <strong>cannot</strong> reverse payments, change amounts, or edit records.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn full variant="primary" onClick={save}>{modal === "add" ? "Create Account" : "Save Changes"}</Btn>
            {modal !== "add" && <Btn variant="danger" onClick={() => del(modal.id)}>🗑️</Btn>}
            <Btn variant="soft" onClick={() => setModal(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}


// ─── FEE DUE REMINDER SYSTEM ─────────────────────────────────
// ══════════════════════════════════════════════════════
// DUE LIST — Full dedicated page with filters + bulk WhatsApp
// ══════════════════════════════════════════════════════
function DueListPage({ students, payments, batches, feeOverrides, setPayments, account, toast, setTab }) {
  const [filterBatch, setFilterBatch] = useState("all");
  const [filterMonth, setFilterMonth] = useState(CURRENT_MONTH);
  const [filterType, setFilterType] = useState("current"); // "current" | "overdue" | "all"
  const [selected, setSelected] = useState({}); // { studentId: true }
  const [dueSearch, setDueSearch] = useState("");
  const [msgTemplate, setMsgTemplate] = useState("Dear {parent},\n\n{name}'s fee for {month} (৳{amount}) is still unpaid.\n\nPlease pay by the 10th.\n\nThank you.");
  const [showBulkMsg, setShowBulkMsg] = useState(false);
  const [showMsgEdit, setShowMsgEdit] = useState(false);

  const monthKey = (mIdx) => `${MONTHS[mIdx]}-${CURRENT_YEAR}`;
  const curKey = monthKey(CURRENT_MONTH);

  // Build due list — all students with unpaid fees
  const buildDueList = () => {
    const q = dueSearch.trim().toLowerCase();
    const list = [];
    students.forEach(s => {
      if (filterBatch !== "all" && s.batch !== filterBatch) return;
      if (q && !s.name.toLowerCase().includes(q) && !(s.phone||"").includes(q) &&
          !(s.fatherName||"").toLowerCase().includes(q) && !(s.motherName||"").toLowerCase().includes(q) &&
          !(s.guardian||"").toLowerCase().includes(q)) return;
      const unpaidMonths = [];
      const checkMonths = filterType === "current"
        ? [CURRENT_MONTH]
        : filterType === "overdue"
        ? Array.from({ length: CURRENT_MONTH }, (_, i) => i)
        : Array.from({ length: CURRENT_MONTH + 1 }, (_, i) => i);

      checkMonths.forEach(i => {
        const mk = monthKey(i);
        if (payments[s.id]?.[mk]?.status === "unpaid") {
          unpaidMonths.push({ month: MONTHS[i], monthIdx: i, key: mk, amount: getEffectiveFee(s, mk, feeOverrides) });
        }
      });
      if (unpaidMonths.length > 0) {
        list.push({ ...s, unpaidMonths, totalDue: unpaidMonths.reduce((a, m) => a + m.amount, 0) });
      }
    });
    return list.sort((a, b) => b.totalDue - a.totalDue);
  };

  const dueList = buildDueList();
  const allSelected = dueList.length > 0 && dueList.every(s => selected[s.id]);
  const selectedCount = Object.keys(selected).filter(id => selected[id]).length;
  const totalDue = dueList.reduce((a, s) => a + s.totalDue, 0);
  const selectedDue = dueList.filter(s => selected[s.id]).reduce((a, s) => a + s.totalDue, 0);

  const toggleAll = () => {
    if (allSelected) setSelected({});
    else setSelected(Object.fromEntries(dueList.map(s => [s.id, true])));
  };

  const buildMsg = (s) => {
    const parent = s.fatherName || s.motherName || s.guardian || "Guardian";
    const monthsStr = s.unpaidMonths.map(m => m.month).join(", ");
    return msgTemplate
      .replace("{parent}", parent)
      .replace("{name}", s.name)
      .replace("{month}", monthsStr)
      .replace("{amount}", s.totalDue.toLocaleString())
      .replace("{batch}", s.batch);
  };

  const sendWhatsApp = (s) => {
    const phone = (s.phone || "").replace(/[^0-9]/g, "");
    const bd = phone.startsWith("0") ? "880" + phone.slice(1) : "880" + phone;
    window.open("https://wa.me/" + bd + "?text=" + encodeURIComponent(buildMsg(s)), "_blank");
  };

  const sendBulk = () => {
    const targets = dueList.filter(s => selected[s.id]);
    if (targets.length === 0) { toast("⚠️ Select students first"); return; }
    targets.forEach((s, i) => setTimeout(() => sendWhatsApp(s), i * 800));
    setShowBulkMsg(false);
    toast("📱 Opening WhatsApp for " + targets.length + " student(s)...");
  };

  const typeColors = { current: C.warning, overdue: C.danger, all: C.info };
  const col = typeColors[filterType] || C.warning;

  return (
    <div>
      {/* Header */}
      <div style={{ background: `linear-gradient(135deg, ${C.danger} 0%, #b91c1c 100%)`, borderRadius: 16, padding: "18px 20px", marginBottom: 18, color: "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 2 }}>Fee Collection — {MONTHS[CURRENT_MONTH]} {CURRENT_YEAR}</div>
            <div style={{ fontSize: 22, fontWeight: 900, fontFamily: "Georgia, serif" }}>🔴 Due List</div>
            <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4 }}>{dueList.length} student(s) with unpaid fees · ৳{totalDue.toLocaleString()} pending</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 28, fontWeight: 900, fontFamily: "Georgia, serif" }}>৳{totalDue.toLocaleString()}</div>
            <div style={{ fontSize: 11, opacity: 0.75 }}>Total Pending</div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ background: C.card, borderRadius: 14, padding: 14, marginBottom: 14, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {[["current", "This Month"], ["overdue", "Previous Months"], ["all", "All Unpaid"]].map(([v, l]) => (
            <button key={v} onClick={() => { setFilterType(v); setSelected({}); }}
              style={{ padding: "7px 14px", borderRadius: 20, border: "2px solid " + (filterType === v ? typeColors[v] : C.border), background: filterType === v ? typeColors[v] : C.bg, color: filterType === v ? "#fff" : C.muted, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
          {[{ id: "all", name: "all", fullName: "All Batches" }, ...batches].map(b => {
            const bDue = b.name === "all"
              ? dueList.length
              : dueList.filter(s => s.batch === b.name).length;
            const isActive = filterBatch === b.name;
            return (
              <button key={b.id || "all"} onClick={() => { setFilterBatch(b.name); setSelected({}); }}
                style={{ padding: "7px 14px", borderRadius: 20, border: "2px solid " + (isActive ? C.primary : C.border), background: isActive ? C.primary : C.bg, color: isActive ? "#fff" : C.text, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                {b.fullName || b.name}
                {bDue > 0 && <span style={{ background: isActive ? "rgba(255,255,255,0.25)" : C.danger, color: "#fff", borderRadius: 10, padding: "0px 6px", fontSize: 10, fontWeight: 800 }}>{bDue}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Batch breakdown summary */}
      {batches.length > 1 && filterBatch === "all" && dueList.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {batches.map(b => {
            const bList = dueList.filter(s => s.batch === b.name);
            if (bList.length === 0) return null;
            const bTotal = bList.reduce((a, s) => a + s.totalDue, 0);
            return (
              <div key={b.id} onClick={() => { setFilterBatch(b.name); setSelected({}); }}
                style={{ background: C.card, borderRadius: 10, padding: "8px 12px", border: "1.5px solid " + C.border, cursor: "pointer", flex: 1, minWidth: 120 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.muted }}>{b.fullName || b.name}</div>
                <div style={{ fontSize: 16, fontWeight: 900, color: C.danger }}>৳{bTotal.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{bList.length} student(s)</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Search bar */}
      <div style={{ marginBottom: 10 }}>
        <input value={dueSearch} onChange={e => setDueSearch(e.target.value)}
          placeholder="🔍 Search by name, phone, or guardian..."
          style={{ width: "100%", padding: "9px 14px", borderRadius: 10, border: "1.5px solid " + C.border, fontSize: 13, outline: "none", background: C.white, color: C.text, fontFamily: FONT, boxSizing: "border-box" }} />
      </div>

      {/* Bulk Actions Bar */}
      {dueList.length > 0 && (
        <div style={{ background: C.card, borderRadius: 12, padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
          <input type="checkbox" checked={allSelected} onChange={toggleAll}
            style={{ width: 16, height: 16, cursor: "pointer", accentColor: C.primary }} />
          <span style={{ fontSize: 13, color: C.muted, flex: 1 }}>
            {selectedCount > 0 ? `${selectedCount} selected — ৳${selectedDue.toLocaleString()} due` : "Select all / individual to bulk send"}
          </span>
          {selectedCount > 0 && (
            <>
              <button onClick={() => setShowBulkMsg(true)}
                style={{ background: "#25D366", border: "none", borderRadius: 8, padding: "7px 14px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                📱 WhatsApp {selectedCount}
              </button>
              <button onClick={() => setSelected({})}
                style={{ background: C.bg, border: "1px solid " + C.border, borderRadius: 8, padding: "7px 12px", color: C.muted, fontSize: 12, cursor: "pointer" }}>
                Clear
              </button>
            </>
          )}
          <button onClick={() => setShowMsgEdit(true)}
            style={{ background: C.bg, border: "1px solid " + C.border, borderRadius: 8, padding: "7px 12px", color: C.muted, fontSize: 12, cursor: "pointer" }}>
            ✏️ Edit Template
          </button>
        </div>
      )}

      {/* Due List */}
      {dueList.length === 0 ? (
        <div style={{ background: C.successLight, borderRadius: 16, padding: "32px 20px", textAlign: "center", border: "1px solid " + C.success + "30" }}>
          <div style={{ fontSize: 44, marginBottom: 10 }}>🎉</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.success }}>All fees paid!</div>
          <div style={{ fontSize: 13, color: C.success, opacity: 0.8, marginTop: 4 }}>No pending payments for the selected filter</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {dueList.map(s => (
            <div key={s.id} style={{ background: C.card, borderRadius: 12, padding: "12px 14px", border: "1.5px solid " + (selected[s.id] ? C.primary : C.border), boxShadow: "0 1px 6px rgba(0,0,0,0.04)", display: "flex", alignItems: "center", gap: 12 }}>
              <input type="checkbox" checked={!!selected[s.id]} onChange={() => setSelected(prev => ({ ...prev, [s.id]: !prev[s.id] }))}
                style={{ width: 16, height: 16, cursor: "pointer", accentColor: C.primary, flexShrink: 0 }} />
              <div style={{ width: 38, height: 38, borderRadius: 10, background: C.danger + "20", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: C.danger, flexShrink: 0 }}>
                {s.avatar || initials(s.name)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{s.name}</span>
                  <span style={{ fontSize: 11, background: C.borderLight, color: C.muted, padding: "1px 7px", borderRadius: 10, fontWeight: 600 }}>{s.batch}</span>
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                  {s.fatherName || s.motherName || s.guardian || ""} · {s.phone}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                  {s.unpaidMonths.map(m => (
                    <span key={m.key} style={{ fontSize: 10, background: C.dangerLight, color: C.danger, padding: "2px 7px", borderRadius: 6, fontWeight: 700 }}>
                      {m.month} ৳{m.amount.toLocaleString()}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 900, color: C.danger }}>৳{s.totalDue.toLocaleString()}</div>
                <div style={{ fontSize: 10, color: C.muted, marginBottom: 6 }}>{s.unpaidMonths.length} month(s) due</div>
                <button onClick={() => sendWhatsApp(s)}
                  style={{ background: "#25D366", border: "none", borderRadius: 8, padding: "6px 12px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                  📱 Remind
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bulk WhatsApp Confirm Modal */}
      {showBulkMsg && (
        <Modal title={"📱 Send WhatsApp to " + selectedCount + " student(s)"} onClose={() => setShowBulkMsg(false)}>
          <div style={{ background: C.bg, borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 12, color: C.muted, lineHeight: 1.8 }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 6 }}>Preview (first student):</div>
            <div style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", fontSize: 12 }}>
              {dueList.find(s => selected[s.id]) ? buildMsg(dueList.find(s => selected[s.id])) : ""}
            </div>
          </div>
          <div style={{ background: C.warningLight, borderRadius: 10, padding: "10px 12px", marginBottom: 14, fontSize: 12, color: C.warning, fontWeight: 600 }}>
            ⚠️ Will open WhatsApp {selectedCount} time(s) — one per student, 0.8s apart
          </div>
          <Btn full variant="primary" onClick={sendBulk} style={{ marginBottom: 8 }}>📱 Start Sending</Btn>
          <Btn full variant="soft" onClick={() => setShowBulkMsg(false)}>Cancel</Btn>
        </Modal>
      )}

      {/* Message Template Editor */}
      {showMsgEdit && (
        <Modal title="✏️ Edit Reminder Template" onClose={() => setShowMsgEdit(false)}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8, lineHeight: 1.7 }}>
            <strong>Variables:</strong> {"{name}"} = student name, {"{parent}"} = parent name, {"{month}"} = month(s), {"{amount}"} = total due, {"{batch}"} = batch name
          </div>
          <textarea value={msgTemplate} onChange={e => setMsgTemplate(e.target.value)}
            rows={7} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1.5px solid " + C.border, fontSize: 13, fontFamily: "monospace", resize: "vertical", outline: "none", boxSizing: "border-box", color: C.text, background: C.white }} />
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Btn variant="soft" onClick={() => setMsgTemplate("Dear {parent},\n\n{name}'s fee for {month} (৳{amount}) is still unpaid.\n\nPlease pay by the 10th.\n\nThank you.")}>Reset</Btn>
            <Btn variant="primary" full onClick={() => { setShowMsgEdit(false); toast("✅ Template saved!"); }}>Save Template</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

function FeeDueReminders({ students, payments, batches, isPro, setTab }) {
  const monthKey = `${MONTHS[CURRENT_MONTH]}-${CURRENT_YEAR}`;
  const prevMonthKey = `${MONTHS[CURRENT_MONTH - 1]}-${CURRENT_YEAR}`;

  // All overdue = unpaid in any past month
  const allOverdue = [];
  students.forEach(s => {
    const unpaidMonths = [];
    for (let i = 0; i < CURRENT_MONTH; i++) {
      const mk = `${MONTHS[i]}-${CURRENT_YEAR}`;
      if (payments[s.id]?.[mk]?.status === "unpaid") unpaidMonths.push(MONTHS[i]);
    }
    if (unpaidMonths.length > 0) allOverdue.push({ ...s, unpaidMonths, totalDue: unpaidMonths.length * s.fee });
  });

  // Current month due
  const currentDue = students.filter(s => payments[s.id]?.[monthKey]?.status === "unpaid");

  // WhatsApp reminder opener
  const sendReminder = (student, type) => {
    const phone = student.phone.replace(/[^0-9]/g, "");
    const bdPhone = phone.startsWith("0") ? "880" + phone.slice(1) : phone;
    let msg = "";
    if (type === "overdue") {
      const months = allOverdue.find(x => x.id === student.id)?.unpaidMonths || [];
      msg = `আদরের অভিভাবক,\n\n${student.name}-এর ${months.join(", ")} মাসের বেতন এখনও পরিশোধ হয়নি। মোট বকেয়া: ৳${(months.length * student.fee).toLocaleString()}।\n\nদয়া করে অতিসত্বর পরিশোধ করুন।\n\nধন্যবাদ।`;
    } else {
      msg = `আদরের অভিভাবক,\n\n${student.name}-এর ${MONTHS[CURRENT_MONTH]} মাসের বেতন (৳${student.fee.toLocaleString()}) এখনও পরিশোধ হয়নি।\n\nঅনুগ্রহ করে ১০ তারিখের মধ্যে পরিশোধ করুন।\n\nধন্যবাদ।`;
    }
    window.open(`https://wa.me/${bdPhone}?text=${encodeURIComponent(msg)}`, "_blank");
  };

  if (allOverdue.length === 0 && currentDue.length === 0) {
    return (
      <div style={{ background: C.successLight, borderRadius: 14, padding: "13px 16px", marginBottom: 12, border: `1px solid ${C.success}30`, display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 20 }}>🎉</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.success }}>All fees up to date!</div>
          <div style={{ fontSize: 12, color: C.success, opacity: 0.8 }}>No overdue or pending payments this month</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 12 }}>
      {/* Overdue from previous months */}
      {allOverdue.length > 0 && (
        <div style={{ background: C.dangerLight, borderRadius: 14, padding: "13px 15px", marginBottom: 10, border: `1px solid ${C.danger}20` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 800, color: C.danger, fontSize: 13 }}>🚨 {allOverdue.length} student(s) overdue — Previous months</div>
            <div style={{ fontSize: 11, background: C.danger, color: "#fff", borderRadius: 20, padding: "2px 8px", fontWeight: 700 }}>৳{allOverdue.reduce((a, s) => a + s.totalDue, 0).toLocaleString()} total</div>
          </div>
          {allOverdue.slice(0, 4).map(s => (
            <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.danger}15` }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{s.name} <span style={{ color: C.muted, fontSize: 11 }}>({s.batch})</span></div>
                <div style={{ fontSize: 11, color: C.danger }}>{s.unpaidMonths.join(", ")} · ৳{s.totalDue.toLocaleString()}</div>
              </div>
              <button onClick={() => sendReminder(s, "overdue")} style={{ background: "#25D366", border: "none", borderRadius: 8, padding: "5px 10px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                📱 Remind
              </button>
            </div>
          ))}
          {allOverdue.length > 4 && (
            <div style={{ fontSize: 12, color: C.danger, marginTop: 8, fontWeight: 600, cursor: "pointer", display: "flex", justifyContent: "space-between" }} onClick={() => setTab("Fees")}>
              <span>+{allOverdue.length - 4} more overdue students</span>
              <span>→ View Fees</span>
            </div>
          )}
        </div>
      )}

      {/* Current month due */}
      {currentDue.length > 0 && (
        <div style={{ background: C.warningLight, borderRadius: 14, padding: "13px 15px", marginBottom: 0, border: `1px solid ${C.warning}20` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 800, color: C.warning, fontSize: 13 }}>⏰ {currentDue.length} student(s) — {MONTHS[CURRENT_MONTH]} fee unpaid</div>
            <div style={{ fontSize: 11, background: C.warning, color: "#fff", borderRadius: 20, padding: "2px 8px", fontWeight: 700 }}>৳{currentDue.reduce((a, s) => a + s.fee, 0).toLocaleString()}</div>
          </div>
          {currentDue.slice(0, 3).map(s => (
            <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.warning}15` }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{s.name} <span style={{ color: C.muted, fontSize: 11 }}>({s.batch})</span></div>
                <div style={{ fontSize: 11, color: C.muted }}>Guardian: {s.guardian} · {s.phone}</div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: C.warning }}>৳{s.fee.toLocaleString()}</span>
                <button onClick={() => sendReminder(s, "current")} style={{ background: "#25D366", border: "none", borderRadius: 8, padding: "5px 10px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                  📱 Remind
                </button>
              </div>
            </div>
          ))}
          {currentDue.length > 3 && (
            <div style={{ fontSize: 12, color: C.warning, marginTop: 8, fontWeight: 600, cursor: "pointer", display: "flex", justifyContent: "space-between" }} onClick={() => setTab("Fees")}>
              <span>+{currentDue.length - 3} more</span>
              <span>→ View all in Fees</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── STUDENT PROFILE PAGE ────────────────────────────────────
function StudentProfile({ student, payments, batches, feeOverrides = {}, onClose, onEdit, toast }) {
  const batch = batches.find(b => b.name === student.batch);
  const [activeSection, setActiveSection] = useState("overview");

  const paidMonths = MONTHS.filter((m) => payments[student.id]?.[`${m}-${CURRENT_YEAR}`]?.status === "paid");
  const unpaidMonths = MONTHS.filter((m, i) => i <= CURRENT_MONTH && payments[student.id]?.[`${m}-${CURRENT_YEAR}`]?.status === "unpaid");
  const totalPaid = paidMonths.reduce((a, m) => a + getEffectiveFee(student, `${m}-${CURRENT_YEAR}`, feeOverrides), 0);
  const totalDue = unpaidMonths.reduce((a, m) => a + getEffectiveFee(student, `${m}-${CURRENT_YEAR}`, feeOverrides), 0);

  const sendWhatsApp = () => {
    const phone = student.phone.replace(/[^0-9]/g, "");
    const bdPhone = phone.startsWith("0") ? "880" + phone.slice(1) : phone;
    const msg = `আদরের অভিভাবক, ${student.name} সম্পর্কে আপনার সাথে যোগাযোগ করতে চাইছিলাম।`;
    window.open(`https://wa.me/${bdPhone}?text=${encodeURIComponent(msg)}`, "_blank");
  };

  const headerBg = batch?.color || C.primary;

  // Use a full custom overlay instead of Modal so we can have edge-to-edge header with close btn
  return (
    <div style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.white, borderRadius: 20, width: "100%", maxWidth: 520, maxHeight: "92vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.22)" }}>

        {/* Colored header — full width, close btn top-right */}
        <div style={{ background: `linear-gradient(135deg, ${headerBg}, ${headerBg}BB)`, padding: "20px 18px 18px", color: "#fff", position: "relative", flexShrink: 0 }}>
          {/* Close button */}
          <button onClick={onClose} style={{ position: "absolute", top: 12, right: 12, width: 30, height: 30, borderRadius: "50%", background: "rgba(0,0,0,0.25)", border: "none", color: "#fff", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>✕</button>

          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div style={{ flexShrink: 0 }}>
              {student.photo
                ? <img src={student.photo} alt={student.name} style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover", border: "3px solid rgba(255,255,255,0.5)" }} />
                : <div style={{ width: 72, height: 72, borderRadius: "50%", background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 800, border: "3px solid rgba(255,255,255,0.3)" }}>{student.avatar}</div>}
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingRight: 24 }}>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "Georgia, serif" }}>{student.name}</div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>Roll #{student.roll} · {student.batch} · {student.subject || "—"}</div>
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>Joined {student.joinDate || "—"}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                <button onClick={sendWhatsApp} style={{ background: "#25D366", border: "none", borderRadius: 8, padding: "6px 12px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>📱 WhatsApp</button>
                {onEdit && <button onClick={onEdit} style={{ background: "rgba(255,255,255,0.2)", border: "1px solid rgba(255,255,255,0.35)", borderRadius: 8, padding: "6px 12px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>✏️ Edit</button>}
              </div>
            </div>
          </div>

          {/* Quick stats */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
            {[
              [`৳${totalPaid.toLocaleString()}`, "Paid (YTD)"],
              [`৳${totalDue.toLocaleString()}`, "Outstanding"],
              [`${paidMonths.length}/${CURRENT_MONTH + 1}`, "Months Paid"]
            ].map(([v, l]) => (
              <div key={l} style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "8px 10px", textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>{v}</div>
                <div style={{ fontSize: 10, opacity: 0.8, marginTop: 1 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tab selector */}
        <div style={{ display: "flex", gap: 4, padding: "12px 16px 0", background: C.white, flexShrink: 0 }}>
          {[["overview", "📋 Overview"], ["payments", "💰 Payments"], ["contact", "📞 Contact"]].map(([v, l]) => (
            <button key={v} onClick={() => setActiveSection(v)} style={{ flex: 1, padding: "8px 4px", borderRadius: "8px 8px 0 0", border: "none", borderBottom: activeSection === v ? `3px solid ${headerBg}` : "3px solid transparent", fontSize: 12, fontWeight: 700, background: "transparent", color: activeSection === v ? headerBg : C.muted, cursor: "pointer", transition: "all 0.15s" }}>{l}</button>
          ))}
        </div>
        <div style={{ height: 1, background: C.border, flexShrink: 0 }} />

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>

          {activeSection === "overview" && (
            <div>
              <div style={{ background: C.bg, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                {[
                  ["Batch", student.batch + (batch?.fullName ? " — " + batch.fullName : "")],
                  ["Subject", student.subject || "—"],
                  ["Roll Number", "#" + student.roll],
                  ["Father's Name", student.fatherName || "—"],
                  ["Mother's Name", student.motherName || "—"],
                  ["Date of Birth", student.dob || "—"],
                  ["BC / NID No.", student.bcNumber || "—"],
                  ["Fee Type", student.defaultFeeType === "full" ? "Full Fee" : student.defaultFeeType === "half" ? "Half Fee (50%)" : student.defaultFeeType === "free" ? "Free (Waiver)" : "Custom — ৳" + student.customFeeAmount],
                  ["Monthly Fee", "৳" + student.fee.toLocaleString()],
                  ["Joined", student.joinDate || "—"]
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                    <span style={{ color: C.muted, fontWeight: 600 }}>{k}</span>
                    <span style={{ color: C.text, fontWeight: 700, textAlign: "right", maxWidth: "60%" }}>{v}</span>
                  </div>
                ))}
              </div>
              {batch && (
                <div style={{ background: `${headerBg}10`, borderRadius: 12, padding: 14, border: `1px solid ${headerBg}25` }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: headerBg, marginBottom: 6 }}>📚 {batch.fullName || batch.name}</div>
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.9 }}>
                    🕐 {batch.time || "—"}<br/>
                    📅 {Array.isArray(batch.days) ? batch.days.join(", ") : (batch.days || "—")}<br/>
                    🚪 {batch.room || "—"}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeSection === "payments" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {/* Summary bar */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <div style={{ background: C.successLight, borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: C.success }}>৳{totalPaid.toLocaleString()}</div>
                  <div style={{ fontSize: 11, color: C.success }}>Total Paid</div>
                </div>
                <div style={{ background: C.dangerLight, borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: C.danger }}>৳{totalDue.toLocaleString()}</div>
                  <div style={{ fontSize: 11, color: C.danger }}>Outstanding</div>
                </div>
              </div>
              {MONTHS.map((m, i) => {
                const mk = `${m}-${CURRENT_YEAR}`;
                const p = payments[student.id]?.[mk];
                const st = p?.status || "upcoming";
                const eff = getEffectiveFee(student, mk, feeOverrides);
                const isFuture = i > CURRENT_MONTH;
                return (
                  <div key={m} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: st === "paid" ? C.successLight : st === "unpaid" ? C.dangerLight : C.bg, borderRadius: 10, border: `1px solid ${st === "paid" ? C.success + "30" : st === "unpaid" ? C.danger + "30" : C.border}` }}>
                    <div style={{ width: 36, textAlign: "center", flexShrink: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: st === "paid" ? C.success : isFuture ? C.muted : C.text }}>{m.slice(0, 3)}</div>
                      <div style={{ fontSize: 9, color: C.muted, marginTop: 1 }}>{isFuture ? "Future" : i === CURRENT_MONTH ? "Now" : "Past"}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {st === "paid" && p && <div style={{ fontSize: 12, color: C.success, fontWeight: 600 }}>✅ {p.paidDate} · {p.method}{p.recordedBy ? ` · by ${p.recordedBy}` : ""}</div>}
                      {st === "unpaid" && <div style={{ fontSize: 12, color: C.danger, fontWeight: 600 }}>⚠️ {i < CURRENT_MONTH ? "Overdue" : "Due this month"}</div>}
                      {st === "upcoming" && <div style={{ fontSize: 12, color: C.muted }}>⏳ Not yet due</div>}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: st === "paid" ? C.success : isFuture ? C.muted : C.danger, flexShrink: 0 }}>৳{eff.toLocaleString()}</div>
                  </div>
                );
              })}
            </div>
          )}

          {activeSection === "contact" && (
            <div>
              <div style={{ background: C.bg, borderRadius: 12, padding: 14, marginBottom: 14 }}>
                {[["Student Name", student.name], ["Guardian Name", student.guardian || "—"], ["Phone Number", student.phone || "—"]].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                    <span style={{ color: C.muted, fontWeight: 600 }}>{k}</span>
                    <span style={{ color: C.text, fontWeight: 700 }}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={sendWhatsApp} style={{ flex: 1, background: "#25D366", border: "none", borderRadius: 12, padding: "13px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>📱 Open WhatsApp</button>
                <a href={`tel:${student.phone}`} style={{ flex: 1, background: C.info, borderRadius: 12, padding: "13px", color: "#fff", fontSize: 13, fontWeight: 700, textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>📞 Call Guardian</a>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}


// ─── YEAR ROLLOVER ────────────────────────────────────────────
function YearRollover({ students, batches, payments, setStudents, setPayments, setBatches, toast, onClose, account }) {
  const [step, setStep] = useState(1); // 1=preview, 2=batch-config, 3=confirm, 4=done
  const nextYear = CURRENT_YEAR + 1;
  const [promotions, setPromotions] = useState(() =>
    students.map(s => ({ id: s.id, name: s.name, currentBatch: s.batch, nextBatch: s.batch, action: "keep" }))
  );
  const [confirmText, setConfirmText] = useState("");

  const updatePromotion = (id, field, value) => {
    setPromotions(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
  };

  const executeRollover = async () => {
    if (confirmText.trim().toLowerCase() !== "rollover") return;

    // Apply promotions to Supabase
    const toRemove = promotions.filter(p => p.action === "remove").map(p => p.id);
    const toUpdate = promotions.filter(p => p.action !== "remove" && p.nextBatch !== p.currentBatch);

    // Delete removed students
    if (toRemove.length > 0) {
      await supabase.from("students").delete().in("id", toRemove);
    }
    // Update batch assignments
    for (const p of toUpdate) {
      await supabase.from("students").update({ batch: p.nextBatch }).eq("id", p.id);
    }
    // Reset/create payment rows for next year
    const keepIds = promotions.filter(p => p.action !== "remove").map(p => p.id);
    const payRows = [];
    keepIds.forEach(sid => {
      MONTHS.forEach(m => {
        payRows.push({ center_id: account?.id, student_id: sid, month_key: `${m}-${nextYear}`, status: "upcoming" });
      });
    });
    if (payRows.length > 0) {
      await supabase.from("payments").upsert(payRows, { onConflict: "student_id,month_key" });
    }

    // Update local state
    setStudents(prev => prev
      .filter(s => !toRemove.includes(s.id))
      .map(s => {
        const pr = promotions.find(p => p.id === s.id);
        return pr ? { ...s, batch: pr.nextBatch } : s;
      })
    );
    setPayments(prev => {
      const np = { ...prev };
      toRemove.forEach(id => delete np[id]);
      keepIds.forEach(sid => {
        if (!np[sid]) np[sid] = {};
        MONTHS.forEach(m => { np[sid][`${m}-${nextYear}`] = { status: "upcoming" }; });
      });
      return np;
    });

    toast(`🎉 Year Rollover complete! ${nextYear} session started.`);
    setStep(4);
  };

  const keepCount = promotions.filter(p => p.action === "keep").length;
  const removeCount = promotions.filter(p => p.action === "remove").length;
  const promoteCount = promotions.filter(p => p.action === "keep" && p.nextBatch !== p.currentBatch).length;

  return (
    <Modal title="📅 Year Rollover" onClose={onClose}>
      {/* Progress stepper */}
      <div style={{ display: "flex", gap: 0, marginBottom: 20 }}>
        {["Preview", "Batch Config", "Confirm"].map((label, i) => (
          <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 11, fontWeight: step > i + 1 ? 700 : step === i + 1 ? 700 : 400, color: step >= i + 1 ? C.primary : C.muted, borderBottom: `2px solid ${step >= i + 1 ? C.primary : C.border}`, paddingBottom: 6 }}>
            <div style={{ width: 22, height: 22, borderRadius: "50%", background: step > i + 1 ? C.primary : step === i + 1 ? C.primaryLight : C.bg, border: `2px solid ${step >= i + 1 ? C.primary : C.border}`, margin: "0 auto 4px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: step > i + 1 ? "#fff" : C.primary }}>
              {step > i + 1 ? "✓" : i + 1}
            </div>
            {label}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div>
          <div style={{ background: C.warningLight, borderRadius: 12, padding: 14, marginBottom: 14, border: `1px solid ${C.warning}30` }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.warning, marginBottom: 6 }}>⚠️ What Year Rollover Does</div>
            <div style={{ fontSize: 12, color: C.text, lineHeight: 2 }}>
              ✅ Resets all payment records for {nextYear}<br/>
              ✅ Moves students to new batches you configure<br/>
              ✅ Keeps all student names, contacts, photos<br/>
              ❌ Removes payment history from {CURRENT_YEAR}<br/>
              ❌ Students you mark "Remove" will be deleted
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
            {[[students.length, "Total Students", C.info], [batches.length, "Batches", C.purple], [payments ? Object.values(payments).reduce((a, p) => a + Object.values(p).filter(x => x.status === "paid").length, 0) : 0, "Paid Months (will reset)", C.warning]].map(([v, l, c]) => (
              <div key={l} style={{ background: `${c}15`, borderRadius: 12, padding: "12px 10px", textAlign: "center", border: `1px solid ${c}20` }}>
                <div style={{ fontSize: 22, fontWeight: 900, color: c }}>{v}</div>
                <div style={{ fontSize: 11, color: c, fontWeight: 600, marginTop: 2, lineHeight: 1.3 }}>{l}</div>
              </div>
            ))}
          </div>
          <Btn full variant="primary" onClick={() => setStep(2)}>Next: Configure Each Student →</Btn>
        </div>
      )}

      {step === 2 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>
            Set each student's batch for {nextYear} session:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto", paddingRight: 4 }}>
            {promotions.map(p => (
              <div key={p.id} style={{ background: p.action === "remove" ? C.dangerLight : C.bg, borderRadius: 10, padding: "10px 12px", border: `1px solid ${p.action === "remove" ? C.danger + "30" : C.border}`, display: "flex", gap: 10, alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: p.action === "remove" ? C.danger : C.text, textDecoration: p.action === "remove" ? "line-through" : "none" }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{p.currentBatch}</div>
                </div>
                {p.action !== "remove" ? (
                  <select value={p.nextBatch} onChange={e => updatePromotion(p.id, "nextBatch", e.target.value)}
                    style={{ padding: "5px 8px", borderRadius: 7, border: `1.5px solid ${C.border}`, fontSize: 12, background: "#fff", fontFamily: "inherit", fontWeight: 600 }}>
                    {batches.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                  </select>
                ) : (
                  <span style={{ fontSize: 11, color: C.danger, fontWeight: 700 }}>Will be removed</span>
                )}
                <button onClick={() => updatePromotion(p.id, "action", p.action === "remove" ? "keep" : "remove")}
                  style={{ background: p.action === "remove" ? C.success : C.danger, border: "none", borderRadius: 7, padding: "5px 8px", color: "#fff", fontSize: 11, cursor: "pointer", fontWeight: 700, flexShrink: 0 }}>
                  {p.action === "remove" ? "↩ Keep" : "✕ Remove"}
                </button>
              </div>
            ))}
          </div>
          <div style={{ background: C.infoLight, borderRadius: 10, padding: "10px 14px", marginTop: 12, fontSize: 12, color: C.info }}>
            Keeping <strong>{keepCount}</strong> students · Promoting to new batch: <strong>{promoteCount}</strong> · Removing: <strong style={{ color: C.danger }}>{removeCount}</strong>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Btn variant="soft" onClick={() => setStep(1)}>← Back</Btn>
            <Btn full variant="primary" onClick={() => setStep(3)}>Next: Final Confirmation →</Btn>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <div style={{ background: C.dangerLight, borderRadius: 14, padding: 16, marginBottom: 16, border: `1px solid ${C.danger}30` }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.danger, marginBottom: 8 }}>🔴 Final Warning — This Cannot Be Undone</div>
            <div style={{ fontSize: 12, color: C.text, lineHeight: 2 }}>
              • All <strong>{CURRENT_YEAR}</strong> payment history will be cleared<br/>
              • <strong>{removeCount}</strong> student(s) will be permanently removed<br/>
              • <strong>{keepCount}</strong> student(s) will move to {nextYear} session<br/>
              • Batch assignments will be updated
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>Type <strong style={{ color: C.danger }}>rollover</strong> to confirm:</label>
            <input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="Type: rollover"
              style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: `2px solid ${confirmText.toLowerCase() === "rollover" ? C.success : C.danger}`, fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit", fontWeight: 600 }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="soft" onClick={() => setStep(2)}>← Back</Btn>
            <Btn full variant="danger" disabled={confirmText.trim().toLowerCase() !== "rollover"} onClick={executeRollover}>
              🔁 Execute Year Rollover
            </Btn>
          </div>
        </div>
      )}

      {step === 4 && (
        <div style={{ textAlign: "center", padding: "16px 0" }}>
          <div style={{ fontSize: 56, marginBottom: 12 }}>🎉</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.success, fontFamily: "Georgia, serif", marginBottom: 6 }}>Rollover Complete!</div>
          <div style={{ fontSize: 14, color: C.muted, marginBottom: 20 }}>{nextYear} session is now active</div>
          <Btn full variant="primary" onClick={onClose}>Done</Btn>
        </div>
      )}
    </Modal>
  );
}


// ─── REPORTS / EOD HANDOVER ───────────────────────────────────
function generateEODReport(students, payments, batches, account, openPrintWindow) {
  const today = new Date();
  const todayStr = today.toLocaleDateString("en-BD", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const todayISO = today.toISOString().split("T")[0];

  // Collect today's payments (including admission fees)
  const todayPayments = [];
  students.forEach(s => {
    // Regular monthly fees
    MONTHS.forEach(m => {
      const mk = `${m}-${CURRENT_YEAR}`;
      const p = payments[s.id]?.[mk];
      if (p?.status === "paid" && p?.recordedAt) {
        const pDate = new Date(p.recordedAt).toISOString().split("T")[0];
        if (pDate === todayISO) {
          todayPayments.push({ student: s.name, batch: s.batch, month: m, method: p.method || "Cash", amount: p.amount || s.fee, by: p.recordedBy || "Owner", type: "fee" });
        }
      }
    });
    // Admission fees (month_key starts with "Admission-")
    Object.entries(payments[s.id] || {}).forEach(([mk, p]) => {
      if (mk.startsWith("Admission-") && p?.status === "paid" && p?.recordedAt) {
        const pDate = new Date(p.recordedAt).toISOString().split("T")[0];
        if (pDate === todayISO) {
          todayPayments.push({ student: s.name, batch: s.batch, month: "Admission Fee", method: p.method || "Cash", amount: p.amount || 0, by: p.recordedBy || "Owner", type: "admission" });
        }
      }
    });
  });

  const cashTotal = todayPayments.filter(p => p.method === "Cash").reduce((a, p) => a + p.amount, 0);
  const digitalTotal = todayPayments.filter(p => p.method !== "Cash").reduce((a, p) => a + p.amount, 0);
  const grandTotal = cashTotal + digitalTotal;

  const monthKey = `${MONTHS[CURRENT_MONTH]}-${CURRENT_YEAR}`;
  const monthPaid = students.filter(s => payments[s.id]?.[monthKey]?.status === "paid").length;
  const monthPending = students.filter(s => payments[s.id]?.[monthKey]?.status === "unpaid").length;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EOD Report — ${todayStr}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a}
    .header{background:linear-gradient(135deg,#16a34a,#14532d);color:#fff;border-radius:16px;padding:24px;margin-bottom:24px}
    .title{font-size:22px;font-weight:900;font-family:Georgia,serif;margin-bottom:4px}
    .sub{font-size:13px;opacity:0.85}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
    .card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 8px rgba(0,0,0,0.07);border-left:4px solid}
    .card.green{border-color:#16a34a}.card.orange{border-color:#f59e0b}.card.blue{border-color:#3b82f6}
    .card-val{font-size:26px;font-weight:900;font-family:Georgia,serif}
    .card-label{font-size:12px;color:#64748b;margin-top:2px}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 8px rgba(0,0,0,0.07)}
    th{background:#f1f5f9;padding:10px 14px;font-size:12px;font-weight:700;color:#475569;text-align:left}
    td{padding:10px 14px;font-size:13px;border-bottom:1px solid #f1f5f9}
    .method-cash{background:#dcfce7;color:#166534;padding:3px 8px;border-radius:6px;font-weight:700;font-size:11px}
    .method-digital{background:#dbeafe;color:#1e40af;padding:3px 8px;border-radius:6px;font-weight:700;font-size:11px}
    .footer{margin-top:24px;text-align:center;font-size:12px;color:#94a3b8}
    .summary-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f1f5f9;font-size:14px}
    .section-title{font-size:16px;font-weight:800;margin-bottom:12px;color:#0f172a}
    @media print{body{background:#fff;padding:0}.no-print{display:none}}
  </style></head><body>
  <div class="header">
    <div class="title">📊 End of Day Report</div>
    <div class="sub">${account?.name || "Coaching Center"} · ${todayStr}</div>
    <div class="sub" style="margin-top:4px;opacity:0.7">Generated at ${today.toLocaleTimeString("en-BD")}</div>
  </div>

  <div class="grid">
    <div class="card green"><div class="card-val" style="color:#16a34a">৳${grandTotal.toLocaleString()}</div><div class="card-label">Total Collected Today</div></div>
    <div class="card orange"><div class="card-val" style="color:#f59e0b">৳${cashTotal.toLocaleString()}</div><div class="card-label">Cash in Hand</div></div>
    <div class="card blue"><div class="card-val" style="color:#3b82f6">৳${digitalTotal.toLocaleString()}</div><div class="card-label">Digital (bKash/Nagad/etc)</div></div>
  </div>

  <div style="background:#fff;border-radius:12px;padding:16px;margin-bottom:24px;box-shadow:0 1px 8px rgba(0,0,0,0.07)">
    <div class="section-title">📅 ${MONTHS[CURRENT_MONTH]} ${CURRENT_YEAR} — Month Overview</div>
    <div class="summary-row"><span>Students paid</span><span style="font-weight:800;color:#16a34a">${monthPaid} / ${students.length}</span></div>
    <div class="summary-row"><span>Still pending</span><span style="font-weight:800;color:#f59e0b">${monthPending} students</span></div>
    <div class="summary-row" style="border:none"><span>Payments recorded today</span><span style="font-weight:800">${todayPayments.length}</span></div>
  </div>

  ${todayPayments.length > 0 ? `
  <div class="section-title">💰 Today's Collections (${todayPayments.length} records)</div>
  <table>
    <tr><th>Student</th><th>Batch</th><th>Month</th><th>Method</th><th>Amount</th><th>By</th></tr>
    ${todayPayments.map(p => `<tr><td><strong>${p.student}</strong></td><td>${p.batch}</td><td>${p.month}</td><td><span class="${p.method === "Cash" ? "method-cash" : "method-digital"}">${p.method}</span></td><td style="font-weight:800">৳${p.amount.toLocaleString()}</td><td>${p.by}</td></tr>`).join("")}
    <tr style="background:#f8fafc"><td colspan="4" style="font-weight:800;text-align:right">Total</td><td colspan="2" style="font-weight:900;font-size:15px;color:#16a34a">৳${grandTotal.toLocaleString()}</td></tr>
  </table>
  ` : `<div style="background:#f1f5f9;border-radius:12px;padding:24px;text-align:center;color:#94a3b8;font-weight:600">No payments recorded today yet</div>`}

  <div class="footer">CoachlyBD · ${account?.name || ""} · ${todayStr}</div>
  <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400))</script>
  </body></html>`;

  openPrintWindow(html, `eod-report-${todayISO}`);
}

function generateMonthlyReport(students, payments, batches, teachers, account, openPrintWindow) {
  const m = MONTHS[CURRENT_MONTH];
  const monthKey = `${m}-${CURRENT_YEAR}`;
  const paidStudents = students.filter(s => payments[s.id]?.[monthKey]?.status === "paid");
  const unpaidStudents = students.filter(s => payments[s.id]?.[monthKey]?.status === "unpaid");
  // Include admission fees collected this month
  const admissionTotal = students.reduce((a, s) => {
    const admKey = "Admission-" + CURRENT_YEAR;
    const ap = payments[s.id]?.[admKey];
    if (ap?.status === "paid" && ap?.amount) return a + ap.amount;
    return a;
  }, 0);
  const totalCollected = paidStudents.reduce((a, s) => a + s.fee, 0) + admissionTotal;
  const totalPending = unpaidStudents.reduce((a, s) => a + s.fee, 0);
  const totalSalary = teachers.reduce((a, t) => a + t.salary, 0);
  const netIncome = totalCollected - totalSalary;

  // By batch
  const batchSummary = batches.map(b => {
    const bs = students.filter(s => s.batch === b.name);
    const bPaid = bs.filter(s => payments[s.id]?.[monthKey]?.status === "paid");
    return { name: b.fullName || b.name, total: bs.length, paid: bPaid.length, collected: bPaid.reduce((a, s) => a + s.fee, 0) };
  });

  // By method
  const methodTotals = {};
  paidStudents.forEach(s => {
    const method = payments[s.id]?.[monthKey]?.method || "Unknown";
    methodTotals[method] = (methodTotals[method] || 0) + s.fee;
  });

  const today = new Date().toLocaleDateString("en-BD", { year: "numeric", month: "long", day: "numeric" });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Monthly Report — ${m} ${CURRENT_YEAR}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a}
    .header{background:linear-gradient(135deg,#1e293b,#0f172a);color:#fff;border-radius:16px;padding:24px;margin-bottom:24px}
    .title{font-size:24px;font-weight:900;font-family:Georgia,serif}
    .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
    .card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 8px rgba(0,0,0,0.07)}
    .section{background:#fff;border-radius:12px;padding:18px;box-shadow:0 1px 8px rgba(0,0,0,0.07);margin-bottom:18px}
    .sec-title{font-size:14px;font-weight:800;margin-bottom:12px}
    table{width:100%;border-collapse:collapse}
    th{font-size:12px;font-weight:700;color:#475569;padding:8px 0;border-bottom:2px solid #f1f5f9;text-align:left}
    td{padding:8px 0;font-size:13px;border-bottom:1px solid #f8fafc}
    .footer{text-align:center;font-size:12px;color:#94a3b8;margin-top:24px}
    @media print{body{background:#fff;padding:12px}}
  </style></head><body>
  <div class="header">
    <div style="font-size:13px;opacity:0.7;margin-bottom:4px">${account?.name || "Coaching Center"}</div>
    <div class="title">📊 Monthly Report</div>
    <div style="font-size:16px;font-weight:700;margin-top:4px;opacity:0.9">${m} ${CURRENT_YEAR}</div>
    <div style="font-size:12px;opacity:0.6;margin-top:6px">Generated: ${today}</div>
  </div>

  <div class="grid3">
    <div class="card" style="border-left:4px solid #16a34a"><div style="font-size:24px;font-weight:900;color:#16a34a;font-family:Georgia,serif">৳${totalCollected.toLocaleString()}</div><div style="font-size:12px;color:#64748b">Collected</div><div style="font-size:11px;color:#16a34a;margin-top:2px">${paidStudents.length} students</div></div>
    <div class="card" style="border-left:4px solid #f59e0b"><div style="font-size:24px;font-weight:900;color:#f59e0b;font-family:Georgia,serif">৳${totalPending.toLocaleString()}</div><div style="font-size:12px;color:#64748b">Pending</div><div style="font-size:11px;color:#f59e0b;margin-top:2px">${unpaidStudents.length} students</div></div>
    <div class="card" style="border-left:4px solid ${netIncome >= 0 ? "#16a34a" : "#ef4444"}"><div style="font-size:24px;font-weight:900;color:${netIncome >= 0 ? "#16a34a" : "#ef4444"};font-family:Georgia,serif">৳${netIncome.toLocaleString()}</div><div style="font-size:12px;color:#64748b">Net Income</div><div style="font-size:11px;color:#64748b;margin-top:2px">after ৳${totalSalary.toLocaleString()} salaries</div></div>
  </div>

  <div class="section">
    <div class="sec-title">🏫 Batch-wise Summary</div>
    <table>
      <tr><th>Batch</th><th>Students</th><th>Paid</th><th>Pending</th><th>Collected</th></tr>
      ${batchSummary.map(b => `<tr><td><strong>${b.name}</strong></td><td>${b.total}</td><td style="color:#16a34a;font-weight:700">${b.paid}</td><td style="color:#f59e0b;font-weight:700">${b.total - b.paid}</td><td style="font-weight:800">৳${b.collected.toLocaleString()}</td></tr>`).join("")}
    </table>
  </div>

  <div class="grid2">
    <div class="section">
      <div class="sec-title">💳 Payment Methods</div>
      ${Object.entries(methodTotals).map(([method, amt]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:13px"><span>${method}</span><span style="font-weight:800">৳${amt.toLocaleString()}</span></div>`).join("")}
    </div>
    <div class="section">
      <div class="sec-title">📊 Fee Collection Rate</div>
      <div style="font-size:40px;font-weight:900;color:#16a34a;font-family:Georgia,serif;text-align:center;margin:10px 0">${students.length > 0 ? Math.round(paidStudents.length / students.length * 100) : 0}%</div>
      <div style="background:#f1f5f9;border-radius:6px;height:10px;overflow:hidden"><div style="background:#16a34a;height:100%;width:${students.length > 0 ? Math.round(paidStudents.length / students.length * 100) : 0}%;border-radius:6px"></div></div>
      <div style="font-size:12px;color:#64748b;margin-top:8px;text-align:center">${paidStudents.length} of ${students.length} paid</div>
    </div>
  </div>

  <div class="footer">CoachlyBD · ${account?.name || ""} · ${m} ${CURRENT_YEAR} Report</div>
  <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400))</script>
  </body></html>`;
  openPrintWindow(html, `monthly-report-${m}-${CURRENT_YEAR}`);
}


// ─── EXAM RESULTS ENTRY ───────────────────────────────────────
function ExamResultsTab({ students, batches, examName, examDate, toast, openPrintWindow, account }) {
  const [selectedBatch, setSelectedBatch] = useState("all");
  const [results, setResults] = useState({}); // { studentId: { marks, total, grade } }
  const [totalMarks, setTotalMarks] = useState(100);

  const eligible = selectedBatch === "all" ? students : students.filter(s => s.batch === selectedBatch);

  const gradeFromPct = (pct) => {
    if (pct >= 80) return { grade: "A+", color: "#16a34a" };
    if (pct >= 70) return { grade: "A", color: "#16a34a" };
    if (pct >= 60) return { grade: "A-", color: "#2563eb" };
    if (pct >= 50) return { grade: "B", color: "#7c3aed" };
    if (pct >= 40) return { grade: "C", color: "#f59e0b" };
    if (pct >= 33) return { grade: "D", color: "#f97316" };
    return { grade: "F", color: "#ef4444" };
  };

  const setMark = (id, val) => {
    const num = Math.min(Number(val), totalMarks);
    if (isNaN(num) || val === "") { setResults(r => { const n = { ...r }; delete n[id]; return n; }); return; }
    const pct = Math.round((num / totalMarks) * 100);
    const { grade, color } = gradeFromPct(pct);
    setResults(r => ({ ...r, [id]: { marks: num, total: totalMarks, pct, grade, color } }));
  };

  const ranked = eligible
    .filter(s => results[s.id]?.marks !== undefined)
    .sort((a, b) => (results[b.id]?.marks || 0) - (results[a.id]?.marks || 0))
    .map((s, i) => ({ ...s, rank: i + 1 }));

  const enteredCount = eligible.filter(s => results[s.id] !== undefined).length;

  const downloadResults = () => {
    if (ranked.length === 0) { toast("⚠️ Enter some marks first"); return; }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Results — ${examName}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Segoe UI',Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a}
      .header{background:linear-gradient(135deg,#16a34a,#14532d);color:#fff;border-radius:16px;padding:22px;margin-bottom:20px;text-align:center}
      table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 8px rgba(0,0,0,0.07)}
      th{background:#0f172a;color:#fff;padding:12px 14px;font-size:12px;text-align:left}
      td{padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px}
      tr:nth-child(1) td{background:#fef9ec}
      tr:nth-child(2) td{background:#f8fafc}
      tr:nth-child(3) td{background:#f0fdf4}
      .rank-1{font-size:18px}.rank-2{font-size:16px}.rank-3{font-size:14px}
      @media print{body{background:#fff;padding:8px}}
    </style></head><body>
    <div class="header">
      <div style="font-size:14px;opacity:0.8;margin-bottom:4px">${account?.name || "Coaching Center"}</div>
      <div style="font-size:22px;font-weight:900;font-family:Georgia,serif">${examName}</div>
      <div style="font-size:13px;opacity:0.85;margin-top:4px">${examDate} · ${selectedBatch === "all" ? "All Batches" : selectedBatch}</div>
    </div>
    <table>
      <tr><th>Rank</th><th>Student</th><th>Batch</th><th>Roll</th><th>Marks</th><th>%</th><th>Grade</th></tr>
      ${ranked.map(s => `<tr><td class="rank-${s.rank <= 3 ? s.rank : ""}" style="font-weight:900">${s.rank === 1 ? "🥇" : s.rank === 2 ? "🥈" : s.rank === 3 ? "🥉" : s.rank}</td><td><strong>${s.name}</strong></td><td>${s.batch}</td><td>${s.roll}</td><td style="font-weight:800">${results[s.id]?.marks}/${totalMarks}</td><td>${results[s.id]?.pct}%</td><td style="font-weight:900;color:${results[s.id]?.color}">${results[s.id]?.grade}</td></tr>`).join("")}
    </table>
    <div style="margin-top:16px;text-align:center;font-size:12px;color:#94a3b8">CoachlyBD · ${account?.name || ""}</div>
    <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400))</script>
    </body></html>`;
    openPrintWindow(html, `results-${examName}`);
  };

  const shareWhatsApp = () => {
    if (ranked.length === 0) { toast("⚠️ Enter some marks first"); return; }
    const top3 = ranked.slice(0, 3).map(s => `${s.rank === 1 ? "🥇" : s.rank === 2 ? "🥈" : "🥉"} ${s.name} — ${results[s.id]?.marks}/${totalMarks} (${results[s.id]?.grade})`).join("\n");
    const msg = `📝 ${examName} Results\n📅 ${examDate}\n\n🏆 Top Students:\n${top3}\n\nTotal appeared: ${ranked.length}\nFor full results, contact us.\n\n— ${account?.name || "Coaching Center"}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
  };

  return (
    <div>
      <div style={{ background: C.card, borderRadius: 16, padding: 18, marginBottom: 14, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 2, minWidth: 120 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: C.muted, display: "block", marginBottom: 4 }}>FILTER BATCH</label>
            <select value={selectedBatch} onChange={e => setSelectedBatch(e.target.value)} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, background: "#fff", fontFamily: "inherit" }}>
              <option value="all">All Batches</option>
              {batches.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 80 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: C.muted, display: "block", marginBottom: 4 }}>TOTAL MARKS</label>
            <input type="number" value={totalMarks} onChange={e => setTotalMarks(Number(e.target.value) || 100)} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
          </div>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Enter marks out of {totalMarks} for each student · {enteredCount}/{eligible.length} entered</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 380, overflowY: "auto" }}>
          {eligible.map(s => {
            const r = results[s.id];
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: r ? `${r.color}10` : C.bg, borderRadius: 10, border: `1px solid ${r ? r.color + "30" : C.border}` }}>
                {s.photo ? <img src={s.photo} style={{ width: 34, height: 34, borderRadius: "50%", objectFit: "cover" }} alt="" /> : <Av label={s.avatar} size={34} bg={r ? r.color : C.muted} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{s.batch} · Roll {s.roll}</div>
                </div>
                {r && <div style={{ fontSize: 12, fontWeight: 800, color: r.color, textAlign: "center", minWidth: 40 }}>{r.grade}<div style={{ fontSize: 10, fontWeight: 600 }}>{r.pct}%</div></div>}
                <input type="number" min="0" max={totalMarks} value={r?.marks ?? ""} onChange={e => setMark(s.id, e.target.value)} placeholder="Marks"
                  style={{ width: 72, padding: "7px 8px", borderRadius: 8, border: `1.5px solid ${r ? r.color : C.border}`, fontSize: 14, fontWeight: 700, outline: "none", textAlign: "center", background: r ? `${r.color}08` : "#fff", color: r?.color || C.text, fontFamily: "inherit" }} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Ranking view */}
      {ranked.length > 0 && (
        <div style={{ background: C.card, borderRadius: 16, padding: 18, marginBottom: 14, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 12 }}>🏆 Rankings ({ranked.length} students)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ranked.slice(0, 10).map(s => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: s.rank <= 3 ? `${results[s.id].color}12` : C.bg, borderRadius: 10, border: `1px solid ${s.rank <= 3 ? results[s.id].color + "30" : C.border}` }}>
                <div style={{ width: 28, textAlign: "center", fontSize: s.rank <= 3 ? 18 : 13, fontWeight: 800, color: results[s.id].color, flexShrink: 0 }}>
                  {s.rank === 1 ? "🥇" : s.rank === 2 ? "🥈" : s.rank === 3 ? "🥉" : `#${s.rank}`}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{s.batch}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 14, fontWeight: 900, color: results[s.id].color }}>{results[s.id].grade}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{results[s.id].marks}/{totalMarks}</div>
                </div>
              </div>
            ))}
            {ranked.length > 10 && <div style={{ fontSize: 12, color: C.muted, textAlign: "center", padding: 8 }}>+{ranked.length - 10} more students · Download for full list</div>}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Btn full variant="primary" onClick={downloadResults} disabled={ranked.length === 0}>📄 Download Result Sheet</Btn>
        <Btn variant="success" onClick={shareWhatsApp} disabled={ranked.length === 0} style={{ background: "#25D366" }}>📱 Share</Btn>
      </div>
    </div>
  );
}


const NAV_ITEMS = [
  { id: "Dashboard", icon: "d", labelKey: "dashboard" },
  { id: "DueList",   icon: "!", labelKey: "dueList"   },
  { id: "Students",  icon: "s", labelKey: "students"  },
  { id: "Batches",   icon: "b", labelKey: "batches"   },
  { id: "Teachers",  icon: "t", labelKey: "teachers"  },
  { id: "Fees",      icon: "f", labelKey: "fees"      },
  { id: "Exams",     icon: "e", labelKey: "exams"     },
  { id: "Messages",  icon: "m", labelKey: "messages"  },
  { id: "Settings",  icon: "g", labelKey: "settings"  },
  { id: "Help",      icon: "h", labelKey: "help"      },
];

export default function CoachlyBD() {
  const [account, setAccount] = useState(null);
  const [isPro, setIsPro] = useState(false);
  const [activeTab, setActiveTab] = useState("Dashboard");
  const [students, setStudents] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [batches, setBatches] = useState([]);
  const [payments, setPayments] = useState({});
  const [toast, setToast] = useState(null);
  const [showPro, setShowPro] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [credits, setCredits] = useState({ used: 47, extra: 0 });
  const [showTopup, setShowTopup] = useState(false);
  // New: Staff Roles
  const [staffAccounts, setStaffAccounts] = useState([]);
  const [staffSession, setStaffSession] = useState(null); // active staff user
  // Fee Discounts
  const [feeOverrides, setFeeOverrides] = useState({}); // { studentId: { monthKey: { type, amount } } }
  // Loading state while fetching data from Supabase
  const [dbLoading, setDbLoading] = useState(false);
  // Theme and language
  const [darkMode, setDarkMode] = useState(() => { try { return localStorage.getItem("cbDark") === "1"; } catch(e) { return false; } });
  const [lang, setLang] = useState(() => { try { return localStorage.getItem("cbLang") || "en"; } catch(e) { return "en"; } });
  // Sync globals so all components can read without prop drilling
  _darkMode = darkMode;
  _lang = lang;

  const MONTHLY_CREDITS = isPro ? 200 : 0;
  const TOPUP_CREDITS = 100;
  const TOPUP_COST = 50;
    const creditTotal = MONTHLY_CREDITS + credits.extra;
  const creditLeft = Math.max(0, creditTotal - credits.used);
  const spendCredits = (n) => setCredits(c => ({ ...c, used: c.used + n }));

  // Apply theme — update C so all components automatically get dark/light colors
  C = darkMode ? C_DARK : { primary: "#16A34A", primaryDark: "#15803D", primaryLight: "#DCFCE7", accent: "#F59E0B", accentLight: "#FEF3C7", success: "#16A34A", successLight: "#DCFCE7", danger: "#EF4444", dangerLight: "#FEF2F2", warning: "#F59E0B", warningLight: "#FFFBEB", info: "#3B82F6", infoLight: "#EFF6FF", purple: "#8B5CF6", purpleLight: "#F5F3FF", sidebar: "#0F172A", bg: "#F8FAFC", card: "#FFFFFF", border: "#E2E8F0", borderLight: "#F1F5F9", text: "#0F172A", muted: "#64748B", subtle: "#94A3B8", white: "#FFFFFF", overlay: "rgba(15,23,42,0.55)" };

  const showToast = (msg) => setToast(msg);

  // ── Check existing Supabase session on mount ──
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        const { data: center } = await supabase
          .from("coaching_centers").select("*")
          .eq("user_id", session.user.id).single();
        if (center) {
          const acc = {
            id: center.id, userId: session.user.id, email: session.user.email,
            name: center.name, owner: center.owner, phone: center.phone,
            address: center.address, logo: center.logo, logoImage: center.logo_image,
            plan: center.plan, established: center.established,
            whatsappNumber: center.whatsapp_number,
          };
          setAccount(acc);
          setIsPro(acc.plan === "pro");
          setDbLoading(true);
          loadCenterData(center.id).then(data => {
            setBatches(data.batches); setStudents(data.students);
            setTeachers(data.teachers); setPayments(data.payments);
            setFeeOverrides(data.feeOverrides); setStaffAccounts(data.staffAccounts);
            setDbLoading(false);
          });
        }
      }
    });
    // Listen for auth changes (logout from another tab etc.)
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setAccount(null); setIsPro(false); setActiveTab("Dashboard");
        setStudents([]); setTeachers([]); setBatches([]);
        setPayments({}); setFeeOverrides({}); setStaffAccounts([]);
      }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const handleLogin = async (acc) => {
    setAccount(acc);
    setIsPro(acc.plan === "pro");
    // Load all data from Supabase for this center
    setDbLoading(true);
    try {
      const data = await loadCenterData(acc.id);
      setBatches(data.batches); setStudents(data.students);
      setTeachers(data.teachers); setPayments(data.payments);
      setFeeOverrides(data.feeOverrides); setStaffAccounts(data.staffAccounts);
    } catch (e) {
      showToast("⚠️ Error loading data: " + e.message);
    } finally {
      setDbLoading(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setAccount(null); setIsPro(false); setActiveTab("Dashboard");
    setStudents([]); setTeachers([]); setBatches([]);
    setPayments({}); setFeeOverrides({}); setStaffAccounts([]);
    setStaffSession(null);
  };

  const activatePro = async () => {
    if (!account?.id) return;
    const { error } = await supabase.from("coaching_centers")
      .update({ plan: "pro" }).eq("id", account.id);
    if (!error) {
      setIsPro(true); setAccount(a => ({ ...a, plan: "pro" }));
      setShowPro(false); showToast("🎉 Pro activated! All features unlocked.");
    }
  };

  // Show loading screen while fetching from Supabase
  if (dbLoading) return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(160deg, ${C.primary} 0%, #1a5c45 100%)`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
      <div style={{ width: 60, height: 60, background: C.accent, borderRadius: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30 }}>📚</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", fontFamily: "Georgia, serif" }}>CoachlyBD</div>
      <div style={{ display: "flex", gap: 8 }}>
        {[0,1,2].map(i => <div key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: "rgba(255,255,255,0.6)", animation: "pulse 1.2s ease-in-out " + (i*0.2) + "s infinite" }} />)}
      </div>
      <style>{`@keyframes pulse { 0%,100%{opacity:0.3;transform:scale(0.8)} 50%{opacity:1;transform:scale(1.2)} }`}</style>
      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>{T("loading")}</div>
    </div>
  );

  // Staff session takes priority — staff can log in without owner being present
  if (staffSession) {
    return <StaffView staffSession={staffSession} students={students} batches={batches} teachers={teachers} payments={payments} setPayments={setPayments} feeOverrides={feeOverrides} toast={showToast} onLogout={() => setStaffSession(null)} />;
  }

  if (!account) {
    return <LoginScreen onLogin={handleLogin} staffAccounts={staffAccounts} onStaffLogin={setStaffSession} />;
  }

  const tabProps = { students, setStudents, teachers, setTeachers, batches, setBatches, payments, setPayments, isPro, toast: showToast, account, setAccount, creditLeft, creditTotal, onTopup: () => setShowTopup(true), feeOverrides, setFeeOverrides, staffAccounts, setStaffAccounts, darkMode, setDarkMode, lang, setLang };
  const currentNav = NAV_ITEMS.find(n => n.id === activeTab) || NAV_ITEMS[0];

  const NAV_ICONS = {
    Dashboard: "📊", DueList: "🔴", Students: "👥", Batches: "📚", Teachers: "👨‍🏫",
    Fees: "💰", Exams: "📝", Messages: "💬", Settings: "⚙️", Help: "🆘"
  };

  const SidebarContent = () => (
    <div style={{ width: 240, background: getC().sidebar, display: "flex", flexDirection: "column", height: "100vh", position: "fixed", left: 0, top: 0, zIndex: 200 }}>
      <div style={{ padding: "18px 16px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, background: C.primary, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>📚</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>CoachlyBD</div>
            <div style={{ fontSize: 10, color: "#475569" }}>Management Platform</div>
          </div>

        </div>
      </div>

      <div style={{ margin: "10px 12px 6px", background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "10px 12px", border: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: C.primary, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{account.logo}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#E2E8F0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.name}</div>
            <div style={{ fontSize: 10, color: "#475569" }}>{isPro ? "⭐ Pro Plan" : "Free Plan"}</div>
          </div>
        </div>
      </div>

      <nav style={{ flex: 1, padding: "6px 10px", overflowY: "auto" }}>
        {NAV_ITEMS.map(item => {
          const isActive = activeTab === item.id;
          return (
            <button key={item.id} onClick={() => { setActiveTab(item.id); setSidebarOpen(false); }}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 8, border: "none", background: isActive ? "rgba(22,163,74,0.15)" : "transparent", cursor: "pointer", marginBottom: 2 }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, background: isActive ? C.primary : "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>
                {NAV_ICONS[item.id]}
              </div>
              <span style={{ fontSize: 13, fontWeight: isActive ? 600 : 400, color: isActive ? "#fff" : "#94A3B8" }}>{T(item.labelKey)}</span>
              {item.id === "Messages" && !isPro && <span style={{ marginLeft: "auto", background: "rgba(245,158,11,0.2)", color: C.accent, fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>PRO</span>}
            </button>
          );
        })}
      </nav>

      {!isPro && (
        <div onClick={() => setShowPro(true)} style={{ margin: "0 10px 10px", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, padding: "12px 14px", cursor: "pointer" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>⭐ Upgrade to Pro</div>
          <div style={{ fontSize: 10, color: "#64748B", marginTop: 2 }}>Call {SUPPORT.whatsapp}</div>
        </div>
      )}

      {isPro && (
        <div style={{ margin: "0 10px 10px", background: "rgba(22,163,74,0.08)", border: "1px solid rgba(22,163,74,0.15)", borderRadius: 10, padding: "10px 12px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#94A3B8", marginBottom: 5 }}>WhatsApp Credits</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: creditLeft < 30 ? C.danger : C.primary }}>{creditLeft}</span>
            <span style={{ fontSize: 11, color: "#475569" }}>/ {creditTotal}</span>
          </div>
          <div style={{ height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2, marginBottom: 6 }}>
            <div style={{ height: "100%", width: creditTotal > 0 ? Math.min(100, (creditLeft / creditTotal) * 100) + "%" : "0%", background: creditLeft < 30 ? C.danger : C.primary, borderRadius: 2 }} />
          </div>
          <button onClick={() => setShowTopup(true)} style={{ fontSize: 11, color: C.accent, background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 600 }}>+ Buy credits</button>
        </div>
      )}

      <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: "rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#CBD5E1", flexShrink: 0 }}>{initials(account.owner || account.name)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#CBD5E1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.owner}</div>
            <div style={{ fontSize: 10, color: "#64748B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.email}</div>
          </div>
        </div>
        <button onClick={handleLogout} style={{ width: "100%", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, color: "#FCA5A5", padding: "8px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          🚪 Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: getC().bg, fontFamily: FONT, colorScheme: darkMode ? "dark" : "light" }}>
      <GlobalStyles darkMode={darkMode} />
      <div className="desktop-sidebar"><SidebarContent /></div>

      {sidebarOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex" }} onClick={() => setSidebarOpen(false)}>
          <div style={{ position: "relative", width: 240, background: C.sidebar, height: "100%", overflowY: "auto", zIndex: 301, display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "14px 14px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 36, height: 36, background: C.primary, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>📚</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>CoachlyBD</div>
                <div style={{ fontSize: 10, color: "#475569" }}>Management Platform</div>
              </div>
              <button onClick={() => setSidebarOpen(false)} style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: "50%", width: 30, height: 30, color: "#fff", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>✕</button>
            </div>
            <nav style={{ flex: 1, padding: "6px 10px", overflowY: "auto" }}>
              {NAV_ITEMS.map(item => {
                const isActive = activeTab === item.id;
                return (
                  <button key={item.id} onClick={() => { setActiveTab(item.id); setSidebarOpen(false); }}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 8, border: "none", background: isActive ? "rgba(22,163,74,0.15)" : "transparent", cursor: "pointer", marginBottom: 2 }}>
                    <div style={{ width: 28, height: 28, borderRadius: 7, background: isActive ? C.primary : "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>
                      {NAV_ICONS[item.id]}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: isActive ? 600 : 400, color: isActive ? "#fff" : "#94A3B8" }}>{T(item.labelKey)}</span>
                    {item.id === "Messages" && !isPro && <span style={{ marginLeft: "auto", background: "rgba(245,158,11,0.2)", color: C.accent, fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>PRO</span>}
                  </button>
                );
              })}
            </nav>
            <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <button onClick={() => { setSidebarOpen(false); handleLogout(); }} style={{ width: "100%", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, color: "#FCA5A5", padding: "8px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                🚪 Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="main-content-area" style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ background: getC().card, borderBottom: "1px solid " + getC().border, padding: "0 24px", height: 58, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={() => setSidebarOpen(true)} className="mobile-only-btn" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: C.muted, padding: 4, marginRight: 4 }}>☰</button>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: getC().text }}>{T(currentNav.labelKey)}</div>
              <div style={{ fontSize: 11, color: getC().muted }}>{account.name}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Language toggle */}
            <button onClick={() => { const nl = lang === "en" ? "bn" : "en"; setLang(nl); try { localStorage.setItem("cbLang", nl); } catch(e){} }}
              style={{ padding: "5px 10px", borderRadius: 8, border: "1.5px solid " + getC().border, background: getC().card, color: getC().text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              {lang === "en" ? "বাং" : "EN"}
            </button>
            {/* Dark mode toggle */}
            <button onClick={() => { const nd = !darkMode; setDarkMode(nd); try { localStorage.setItem("cbDark", nd ? "1" : "0"); } catch(e){} }}
              title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
              style={{ width: 34, height: 34, borderRadius: 8, border: "1.5px solid " + getC().border, background: getC().card, color: getC().text, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {darkMode ? "☀️" : "🌙"}
            </button>
            {isPro
              ? <span style={{ background: getC().primaryLight, color: getC().primary, padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700 }}>⭐ Pro</span>
              : <Btn size="sm" variant="accent" onClick={() => setShowPro(true)}>⭐ Upgrade</Btn>
            }
            <div style={{ width: 34, height: 34, borderRadius: 8, background: getC().primaryLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: getC().primary }}>
              {initials(account.owner || account.name)}
            </div>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px 48px", background: getC().bg }}>
          {activeTab === "Dashboard" && <Dashboard {...tabProps} onUpgrade={() => setShowPro(true)} setTab={setActiveTab} />}
          {activeTab === "DueList"   && <DueListPage students={students} payments={payments} batches={batches} feeOverrides={feeOverrides} setPayments={setPayments} account={account} toast={showToast} setTab={setActiveTab} />}
          {activeTab === "Students"  && <Students  {...tabProps} feeOverrides={feeOverrides} />}
          {activeTab === "Batches"   && <Batches   {...tabProps} isPro={isPro} onUpgrade={() => setShowPro(true)} />}
          {activeTab === "Teachers"  && <Teachers  {...tabProps} />}
          {activeTab === "Fees"      && <Fees      {...tabProps} />}
          {activeTab === "Exams"     && <Exams     {...tabProps} />}
          {activeTab === "Messages"  && <Messages  {...tabProps} onUpgrade={() => setShowPro(true)} />}
          {activeTab === "Settings"  && <Settings  {...tabProps} onUpgrade={() => setShowPro(true)} onLogout={handleLogout} students={students} setStudents={setStudents} batches={batches} setBatches={setBatches} payments={payments} setPayments={setPayments} teachers={teachers} />}
          {activeTab === "Help"      && <Help isPro={isPro} onUpgrade={() => setShowPro(true)} />}
        </div>
      </div>

      {showPro && <ProModal onClose={() => setShowPro(false)} onActivate={activatePro} />}
      {showTopup && (
        <Modal title="Buy Message Credits" onClose={() => setShowTopup(false)}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>💳</div>
            <div style={{ background: "linear-gradient(135deg, " + C.primary + ", #15803D)", borderRadius: 14, padding: "18px 24px", color: "#fff", marginBottom: 16 }}>
              <div style={{ fontSize: 36, fontWeight: 900 }}>{TOPUP_CREDITS}</div>
              <div style={{ fontSize: 13, opacity: 0.85 }}>WhatsApp credits</div>
              <div style={{ height: 1, background: "rgba(255,255,255,0.15)", margin: "12px 0" }} />
              <div style={{ fontSize: 24, fontWeight: 800 }}>৳{TOPUP_COST}</div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>= ৳0.50 per message</div>
            </div>
            <div style={{ background: C.borderLight, borderRadius: 10, padding: 14, marginBottom: 14, textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: C.muted }}>Credits left</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{creditLeft}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, color: C.muted }}>After top-up</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.success }}>{creditLeft + TOPUP_CREDITS}</span>
              </div>
            </div>
            <div style={{ background: C.accentLight, borderRadius: 10, padding: 12, marginBottom: 14, textAlign: "left" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.warning, marginBottom: 4 }}>How to pay</div>
              <div style={{ fontSize: 12, color: C.text, lineHeight: 1.8 }}>
                1. bKash/Nagad to {SUPPORT.whatsapp}<br/>
                2. Send screenshot to our WhatsApp<br/>
                3. Credits added within 30 minutes
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <a href={SUPPORT.whatsappLink} target="_blank" rel="noreferrer" style={{ flex: 1, background: "#25D366", color: "#fff", borderRadius: 8, padding: "11px", fontSize: 13, fontWeight: 700, textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>💬 WhatsApp Us</a>

            </div>
          </div>
        </Modal>
      )}
      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
