/* =========================================================================
   THE WALL STORE — APP LOGIC
   Uses Firebase compat SDK (loaded in index.html) + config.js globals:
   OWNER_EMAILS, UPI_CONFIG, firebaseConfig
   ========================================================================= */

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
// Images are hosted on Cloudinary (free, no billing card needed) instead of
// Firebase Storage — see uploadImageToCloudinary() below and CLOUDINARY_CONFIG
// in config.js.

/* ---------------------------------------------------------------------- */
/* State                                                                   */
/* ---------------------------------------------------------------------- */
let currentUser = null;
let isOwner = false;
let products = [];               // live from Firestore
let sections = [];                // live from Firestore — admin-defined categories
let sizes = [];                   // live from Firestore — global size options
let cart = loadCart();           // { [productId]: { id, name, price, imageUrl, qty } }
let pendingAfterAuth = null;      // fn to run right after a successful sign-in
let authMode = "signin";          // "signin" | "signup"
let selectedImageFile = null;     // for the "add product" form
let selectedEditImageFile = null; // for the "edit product" form
let selectedQrImageFile = null;   // for admin payment settings
let selectedSizeImageFile = null; // for admin "add size" form
let activeOrderId = null;
let editingProductId = null;
let searchQuery = "";
let myOrdersUnsub = null;

// Which sections/sizes are checked in each form. Sets persist selections
// across re-renders triggered by live sections/sizes updates.
let addSectionsSelected = new Set();
let addSizesSelected = new Set();
let editSectionsSelected = new Set();
let editSizesSelected = new Set();

/* ---------------------------------------------------------------------- */
/* Helpers                                                                  */
/* ---------------------------------------------------------------------- */
function money(n){ return "₹" + Number(n || 0).toLocaleString("en-IN"); }
function el(id){ return document.getElementById(id); }
function show(elm){ elm.classList.remove("hidden"); }
function hide(elm){ elm.classList.add("hidden"); }

function toast(msg){
  const t = el("toast");
  t.textContent = msg;
  show(t);
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => hide(t), 3200);
}

function loadCart(){
  try{ return JSON.parse(localStorage.getItem("tws_cart") || "{}"); }
  catch(e){ return {}; }
}
function saveCart(){ localStorage.setItem("tws_cart", JSON.stringify(cart)); }

async function uploadImageToCloudinary(file){
  if (!CLOUDINARY_CONFIG.cloudName || CLOUDINARY_CONFIG.cloudName === "your_cloud_name"){
    throw new Error("Cloudinary isn't set up yet — see README step 3.");
  }
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/image/upload`;
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", CLOUDINARY_CONFIG.uploadPreset);
  form.append("folder", "the-wall-store");

  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok){
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || "Image upload failed");
  }
  const data = await res.json();
  return data.secure_url;
}

// Scrolling the page while a number input happens to be focused makes
// Chrome/Firefox silently increment/decrement its value. Blur any number
// input the instant a wheel event reaches it.
document.addEventListener("wheel", () => {
  const a = document.activeElement;
  if (a && a.tagName === "INPUT" && a.type === "number") a.blur();
}, { passive: true });

function escapeHtml(s){
  return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function parseKeywords(str){
  return (str || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/* ---------------------------------------------------------------------- */
/* Auth state                                                              */
/* ---------------------------------------------------------------------- */
auth.onAuthStateChanged((user) => {
  currentUser = user;
  isOwner = !!user && OWNER_EMAILS.includes((user.email || "").toLowerCase().trim());
  renderNav();

  if (isOwner){
    hide(el("storeView"));
    show(el("adminView"));
    el("modeLabel").textContent = "Admin dashboard";
    listenOrders();
    loadPaymentSettingsIntoForm();
  } else {
    show(el("storeView"));
    hide(el("adminView"));
    el("modeLabel").textContent = "Posters, printed for your walls";
  }

  if (user){
    const hadPending = !!pendingAfterAuth;
    const fn = pendingAfterAuth;
    pendingAfterAuth = null;
    if (!el("authOverlay").classList.contains("hidden")){
      closeAuthModal();
    }
    if (hadPending) fn();
  } else {
    if (myOrdersUnsub){ myOrdersUnsub(); myOrdersUnsub = null; }
  }
});

function renderNav(){
  const wrap = el("navActions");
  wrap.innerHTML = "";

  if (isOwner){
    const chip = document.createElement("span");
    chip.className = "user-chip";
    chip.textContent = currentUser.email;
    const out = document.createElement("button");
    out.className = "btn"; out.textContent = "Sign out";
    out.onclick = () => auth.signOut();
    wrap.append(chip, out);
    return;
  }

  // My Orders (signed-in customers only)
  if (currentUser){
    const ordersBtn = document.createElement("button");
    ordersBtn.className = "btn"; ordersBtn.textContent = "My orders";
    ordersBtn.onclick = openMyOrders;
    wrap.appendChild(ordersBtn);
  }

  // cart icon (always visible on store view)
  const cartBtn = document.createElement("button");
  cartBtn.className = "icon-btn"; cartBtn.title = "Cart"; cartBtn.id = "cartBtn";
  cartBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 3h2l2.4 12.4a2 2 0 0 0 2 1.6h7.2a2 2 0 0 0 2-1.6L21 8H6"/><circle cx="9" cy="21" r="1"/><circle cx="18" cy="21" r="1"/></svg><span class="badge-count hidden" id="cartCount">0</span>`;
  cartBtn.onclick = openCart;

  wrap.appendChild(cartBtn);

  if (currentUser){
    const chip = document.createElement("span");
    chip.className = "user-chip";
    chip.textContent = currentUser.email;
    const out = document.createElement("button");
    out.className = "btn"; out.textContent = "Sign out";
    out.onclick = () => auth.signOut();
    wrap.append(chip, out);
  } else {
    const signInBtn = document.createElement("button");
    signInBtn.className = "btn"; signInBtn.textContent = "Sign in";
    signInBtn.onclick = () => openAuthModal();
    wrap.appendChild(signInBtn);
  }

  updateCartBadge();
}

function updateCartBadge(){
  const count = Object.values(cart).reduce((s, i) => s + i.qty, 0);
  const badge = el("cartCount");
  if (!badge) return;
  badge.textContent = count;
  if (count > 0) show(badge); else hide(badge);
}

/* ---------------------------------------------------------------------- */
/* Auth modal                                                               */
/* ---------------------------------------------------------------------- */
function openAuthModal(after){
  pendingAfterAuth = after || null;
  authMode = "signin";
  syncAuthModeUI();
  el("authForm").reset();
  hide(el("authError"));
  hide(el("authSuccess"));
  show(el("authOverlay"));
}
function closeAuthModal(){ hide(el("authOverlay")); }

el("authClose").onclick = () => { pendingAfterAuth = null; closeAuthModal(); };
el("authOverlay").addEventListener("click", (e) => { if (e.target === el("authOverlay")){ pendingAfterAuth = null; closeAuthModal(); } });

el("authToggleBtn").onclick = () => {
  authMode = authMode === "signin" ? "signup" : "signin";
  syncAuthModeUI();
};

function syncAuthModeUI(){
  hide(el("authSuccess"));
  if (authMode === "signin"){
    el("authTitle").textContent = "Sign in";
    el("authSub").textContent = "Sign in to place an order.";
    el("authSubmitBtn").textContent = "Sign in";
    el("authToggleText").textContent = "New here?";
    el("authToggleBtn").textContent = "Create an account";
    show(el("forgotPasswordRow"));
  } else {
    el("authTitle").textContent = "Create account";
    el("authSub").textContent = "One quick step before checkout.";
    el("authSubmitBtn").textContent = "Create account";
    el("authToggleText").textContent = "Already have an account?";
    el("authToggleBtn").textContent = "Sign in instead";
    hide(el("forgotPasswordRow"));
  }
}

el("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = el("authEmail").value.trim();
  const password = el("authPassword").value;
  const errBox = el("authError");
  hide(errBox);
  hide(el("authSuccess"));
  el("authSubmitBtn").disabled = true;
  try{
    if (authMode === "signin"){
      await auth.signInWithEmailAndPassword(email, password);
    } else {
      await auth.createUserWithEmailAndPassword(email, password);
    }
    // onAuthStateChanged handles the rest (closing modal, pending action)
  } catch(err){
    errBox.textContent = friendlyAuthError(err);
    show(errBox);
  } finally {
    el("authSubmitBtn").disabled = false;
  }
});

// Fix #8: forgotten passwords. Firebase's Email/Password provider comes
// with a built-in reset-email flow — no extra setup or paid tier needed.
el("forgotPasswordBtn").onclick = async () => {
  const email = el("authEmail").value.trim();
  const errBox = el("authError");
  const okBox = el("authSuccess");
  hide(errBox); hide(okBox);
  if (!email){
    errBox.textContent = "Enter your email above first, then tap \"Forgot password?\" again.";
    show(errBox);
    return;
  }
  try{
    await auth.sendPasswordResetEmail(email);
    okBox.textContent = "Reset link sent — check that inbox (and spam folder).";
    show(okBox);
  } catch(err){
    errBox.textContent = friendlyAuthError(err);
    show(errBox);
  }
};

function friendlyAuthError(err){
  const map = {
    "auth/email-already-in-use": "That email already has an account — try signing in instead.",
    "auth/invalid-email": "That email doesn't look right.",
    "auth/weak-password": "Password needs to be at least 6 characters.",
    "auth/wrong-password": "Wrong password. Try again.",
    "auth/user-not-found": "No account with that email yet — create one instead.",
    "auth/invalid-credential": "Email or password is incorrect.",
  };
  return map[err.code] || err.message;
}

/* ---------------------------------------------------------------------- */
/* Products, Sections, Sizes — live listeners                              */
/* ---------------------------------------------------------------------- */
db.collection("products").orderBy("createdAt", "desc").onSnapshot((snap) => {
  products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderStore();
  renderAdminProducts();
  renderSectionsAdminList();
  renderSizesAdminList();
}, (err) => console.error("products listener", err));

db.collection("sections").orderBy("createdAt", "asc").onSnapshot((snap) => {
  sections = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderStore();
  renderSectionsAdminList();
  renderCheckboxPills(el("productSectionsList"), sections, addSectionsSelected, s => s.name);
  renderCheckboxPills(el("editProductSectionsList"), sections, editSectionsSelected, s => s.name);
}, (err) => console.error("sections listener", err));

db.collection("sizes").orderBy("createdAt", "asc").onSnapshot((snap) => {
  sizes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderSizesAdminList();
  renderCheckboxPills(el("productSizesList"), sizes, addSizesSelected, s => s.label);
  renderCheckboxPills(el("editProductSizesList"), sizes, editSizesSelected, s => s.label);
}, (err) => console.error("sizes listener", err));

// Reusable toggle-pill renderer for "which sections/sizes apply" pickers.
function renderCheckboxPills(container, items, selectedSet, getLabel){
  if (!container) return;
  container.innerHTML = "";
  if (items.length === 0){
    container.innerHTML = `<p class="empty-note">None yet — add some from the admin tabs.</p>`;
    return;
  }
  items.forEach(item => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "checkbox-pill" + (selectedSet.has(item.id) ? " on" : "");
    pill.textContent = getLabel(item);
    pill.onclick = () => {
      if (selectedSet.has(item.id)) selectedSet.delete(item.id);
      else selectedSet.add(item.id);
      pill.classList.toggle("on");
    };
    container.appendChild(pill);
  });
}

/* ---------------------------------------------------------------------- */
/* Store rendering: sections + bestsellers + search                        */
/* ---------------------------------------------------------------------- */
function matchesSearch(p, q){
  if (p.name && p.name.toLowerCase().includes(q)) return true;
  if (p.details && p.details.toLowerCase().includes(q)) return true;
  if ((p.keywords || []).some(k => k.toLowerCase().includes(q))) return true;
  return false;
}

function renderStore(){
  if (searchQuery){
    renderSearchResults();
    return;
  }
  hide(el("searchResultsWrap"));
  show(el("browseWrap"));

  // Bestsellers (tag-based, independent of sections)
  const bestsellers = products.filter(p => (p.tags || []).includes("bestseller"));
  const bestGrid = el("bestsellerGrid");
  bestGrid.innerHTML = "";
  if (bestsellers.length === 0){
    hide(el("bestsellerBlock"));
  } else {
    show(el("bestsellerBlock"));
    bestsellers.forEach(p => bestGrid.appendChild(productCard(p)));
  }

  // Admin-defined sections
  const container = el("sectionsContainer");
  container.innerHTML = "";
  const validSectionIds = new Set(sections.map(s => s.id));

  sections.forEach(sec => {
    const inSection = products.filter(p => (p.sections || []).includes(sec.id));
    if (inSection.length === 0) return; // don't show empty sections
    container.appendChild(sectionBlock(sec.name, inSection));
  });

  // Anything not filed into a (still-existing) section — keeps products
  // from silently disappearing, and covers the "no sections set up yet"
  // case with a friendly fallback.
  const leftover = products.filter(p => !(p.sections || []).some(id => validSectionIds.has(id)));
  if (leftover.length > 0){
    container.appendChild(sectionBlock(sections.length === 0 ? "All posters" : "More posters", leftover));
  }

  if (products.length === 0){
    show(el("emptyNote"));
  } else {
    hide(el("emptyNote"));
  }
}

function sectionBlock(label, items){
  const wrap = document.createElement("div");
  wrap.className = "store-section";
  const heading = document.createElement("p");
  heading.className = "section-label";
  heading.textContent = label;
  const grid = document.createElement("div");
  grid.className = "grid";
  items.forEach(p => grid.appendChild(productCard(p)));
  wrap.append(heading, grid);
  return wrap;
}

function renderSearchResults(){
  show(el("searchResultsWrap"));
  hide(el("browseWrap"));
  el("searchResultsLabel").textContent = `Search results for "${searchQuery}"`;
  const q = searchQuery.toLowerCase();
  const matches = products.filter(p => matchesSearch(p, q));
  const grid = el("searchResultsGrid");
  grid.innerHTML = "";
  if (matches.length === 0){
    show(el("searchEmptyNote"));
  } else {
    hide(el("searchEmptyNote"));
    matches.forEach(p => grid.appendChild(productCard(p)));
  }
}

let searchDebounce = null;
el("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = e.target.value.trim();
    el("searchClearBtn").classList.toggle("hidden", !searchQuery);
    renderStore();
  }, 150);
});
el("searchClearBtn").addEventListener("click", () => {
  el("searchInput").value = "";
  searchQuery = "";
  hide(el("searchClearBtn"));
  renderStore();
});

function productCard(p){
  const card = document.createElement("div");
  card.className = "card";
  const oos = (p.tags || []).includes("out_of_stock");
  const best = (p.tags || []).includes("bestseller");
  card.innerHTML = `
    <div class="tape"></div>
    <div class="thumb-wrap">
      <img src="${p.imageUrl}" alt="${escapeHtml(p.name)}" loading="lazy">
      ${oos ? `<div class="stamp"><span>Sold out</span></div>` : ""}
      ${best ? `<div class="fav-tag">★ Bestseller</div>` : ""}
    </div>
    <h3>${escapeHtml(p.name)}</h3>
    <div class="price-row"><span class="price">${money(p.price)}</span></div>
    <button class="add-btn" ${oos ? "disabled" : ""}>${oos ? "Out of stock" : "Add to cart"}</button>
  `;
  card.querySelector(".add-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!oos) addToCart(p);
  });
  card.addEventListener("click", () => openDetail(p));
  return card;
}

/* ---------------------------------------------------------------------- */
/* Product detail modal                                                    */
/* ---------------------------------------------------------------------- */
function openDetail(p){
  const oos = (p.tags || []).includes("out_of_stock");
  const best = (p.tags || []).includes("bestseller");
  const productSizes = (p.sizes || []).map(id => sizes.find(s => s.id === id)).filter(Boolean);

  el("detailContent").innerHTML = `
    <div class="thumb-wrap detail-thumb">
      <img src="${p.imageUrl}" alt="${escapeHtml(p.name)}">
    </div>
    <div>
      ${best ? `<div class="fav-tag" style="position:static; display:inline-block; margin-bottom:10px;">★ Bestseller</div>` : ""}
      <h2 style="margin-top:0;">${escapeHtml(p.name)}</h2>
      <div class="price-row" style="font-size:20px; margin-bottom:14px;"><span class="price">${money(p.price)}</span></div>
      <p style="font-size:14px; line-height:1.6; color:var(--grey);">${escapeHtml(p.details || "No extra details for this print.")}</p>
      ${productSizes.length > 0 ? `
        <p class="field label" style="font-family:var(--font-mono); font-size:11px; text-transform:uppercase; letter-spacing:1px; color:var(--grey); margin:16px 0 0;">Available sizes — tap to compare</p>
        <div class="size-pill-row" id="detailSizeRow"></div>
      ` : ""}
      <button class="btn btn-solid" style="width:100%; margin-top:16px;" id="detailAddBtn" ${oos ? "disabled" : ""}>
        ${oos ? "Out of stock" : "Add to cart"}
      </button>
    </div>
  `;

  if (productSizes.length > 0){
    const row = el("detailSizeRow");
    productSizes.forEach(sz => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "size-pill";
      pill.textContent = sz.label;
      if (sz.referenceImageUrl){
        pill.onclick = () => openSizeRef(sz);
      } else {
        pill.onclick = () => toast(`No size-reference image for "${sz.label}" yet.`);
      }
      row.appendChild(pill);
    });
  }

  const btn = el("detailAddBtn");
  if (btn && !oos){
    btn.onclick = () => { addToCart(p); closeDetail(); };
  }
  show(el("detailOverlay"));
}
function closeDetail(){ hide(el("detailOverlay")); }
el("detailClose").onclick = closeDetail;
el("detailOverlay").addEventListener("click", (e) => { if (e.target === el("detailOverlay")) closeDetail(); });

function openSizeRef(sz){
  el("sizeRefTitle").textContent = sz.label;
  el("sizeRefImage").src = sz.referenceImageUrl;
  show(el("sizeRefOverlay"));
}
el("sizeRefClose").onclick = () => hide(el("sizeRefOverlay"));
el("sizeRefOverlay").addEventListener("click", (e) => { if (e.target === el("sizeRefOverlay")) hide(el("sizeRefOverlay")); });

/* ---------------------------------------------------------------------- */
/* Cart                                                                     */
/* ---------------------------------------------------------------------- */
function addToCart(p){
  if (!cart[p.id]){
    cart[p.id] = { id: p.id, name: p.name, price: p.price, imageUrl: p.imageUrl, qty: 0 };
  }
  cart[p.id].qty += 1;
  saveCart();
  updateCartBadge();
  toast(`Added "${p.name}" to cart`);
}

function openCart(){
  renderCart();
  show(el("cartOverlay"));
  show(el("cartDrawer"));
}
function closeCart(){
  hide(el("cartOverlay"));
  hide(el("cartDrawer"));
}
el("cartClose").onclick = closeCart;
el("cartOverlay").addEventListener("click", closeCart);

function renderCart(){
  const wrap = el("cartItems");
  wrap.innerHTML = "";
  const items = Object.values(cart);
  if (items.length === 0){
    wrap.innerHTML = `<p class="empty-note">Your cart is empty.</p>`;
  }
  items.forEach(item => {
    const row = document.createElement("div");
    row.className = "cart-row";
    row.innerHTML = `
      <img src="${item.imageUrl}" alt="${escapeHtml(item.name)}">
      <div class="ci-info">
        <h4>${escapeHtml(item.name)}</h4>
        <div class="qty-stepper">
          <button data-act="dec">−</button>
          <span>${item.qty}</span>
          <button data-act="inc">+</button>
        </div>
        <button class="remove">Remove</button>
      </div>
      <div class="row-price">${money(item.price * item.qty)}</div>
    `;
    row.querySelector('[data-act="inc"]').onclick = () => { item.qty++; saveCart(); renderCart(); updateCartBadge(); };
    row.querySelector('[data-act="dec"]').onclick = () => {
      item.qty--;
      if (item.qty <= 0) delete cart[item.id];
      saveCart(); renderCart(); updateCartBadge();
    };
    row.querySelector(".remove").onclick = () => { delete cart[item.id]; saveCart(); renderCart(); updateCartBadge(); };
    wrap.appendChild(row);
  });
  el("cartTotal").textContent = money(cartTotal());
}

function cartTotal(){
  return Object.values(cart).reduce((s, i) => s + i.price * i.qty, 0);
}

el("placeOrderBtn").onclick = () => {
  if (Object.keys(cart).length === 0){
    const err = el("cartError");
    err.textContent = "Your cart is empty.";
    show(err);
    return;
  }
  hide(el("cartError"));
  if (!currentUser){
    closeCart();
    openAuthModal(() => openShippingModal());
    return;
  }
  closeCart();
  openShippingModal();
};

/* ---------------------------------------------------------------------- */
/* Shipping details                                                        */
/* ---------------------------------------------------------------------- */
async function openShippingModal(){
  hide(el("shippingError"));
  el("shippingForm").reset();
  try{
    const doc = await db.collection("users").doc(currentUser.uid).get();
    if (doc.exists){
      const d = doc.data();
      el("shipName").value = d.name || "";
      el("shipPhone").value = d.phone || "";
      el("shipAddress").value = d.address || "";
      el("shipPincode").value = d.pincode || "";
    }
  } catch(e){
    console.error("prefill shipping", e);
  }
  show(el("shippingOverlay"));
}
function closeShippingModal(){ hide(el("shippingOverlay")); }
el("shippingClose").onclick = closeShippingModal;
el("shippingOverlay").addEventListener("click", (e) => { if (e.target === el("shippingOverlay")) closeShippingModal(); });

el("shippingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = el("shippingError");
  hide(errBox);

  const shipping = {
    name: el("shipName").value.trim(),
    phone: el("shipPhone").value.trim(),
    address: el("shipAddress").value.trim(),
    pincode: el("shipPincode").value.trim(),
  };
  if (!/^[0-9]{10}$/.test(shipping.phone)){
    errBox.textContent = "Enter a valid 10-digit phone number.";
    show(errBox);
    return;
  }
  if (!/^[0-9]{6}$/.test(shipping.pincode)){
    errBox.textContent = "Enter a valid 6-digit pincode.";
    show(errBox);
    return;
  }

  const btn = el("shippingSubmitBtn");
  btn.disabled = true;
  btn.textContent = "Placing order…";
  await placeOrder(shipping);
  btn.disabled = false;
  btn.textContent = "Continue to payment";
});

/* ---------------------------------------------------------------------- */
/* Checkout / order creation                                               */
/* ---------------------------------------------------------------------- */
async function placeOrder(shipping){
  const items = Object.values(cart).map(i => ({
    productId: i.id, name: i.name, price: i.price, qty: i.qty,
  }));
  const total = cartTotal();

  let orderId;
  try{
    const orderRef = await db.collection("orders").add({
      userId: currentUser.uid,
      userEmail: currentUser.email,
      items,
      total,
      shipping,
      status: "awaiting_verification",
      customerConfirmedPaid: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    orderId = orderRef.id;
  } catch(e){
    console.error("placeOrder", e);
    toast("Couldn't place the order — please try again.");
    return;
  }

  db.collection("users").doc(currentUser.uid).set(shipping, { merge: true }).catch((e) => {
    console.error("save shipping profile", e);
  });

  cart = {};
  saveCart();
  updateCartBadge();
  closeShippingModal();
  activeOrderId = orderId;
  openCheckout(orderId, total);
}

async function getPaymentSettings(){
  try{
    const doc = await db.collection("settings").doc("payment").get();
    if (doc.exists){
      const d = doc.data();
      return {
        upiId: d.upiId || UPI_CONFIG.upiId,
        payeeName: d.payeeName || UPI_CONFIG.payeeName,
        qrImageUrl: d.qrImageUrl || null,
      };
    }
  } catch(e){
    console.error("getPaymentSettings", e);
  }
  return { upiId: UPI_CONFIG.upiId, payeeName: UPI_CONFIG.payeeName, qrImageUrl: null };
}

async function openCheckout(orderId, total){
  el("checkoutOrderId").textContent = "#" + orderId.slice(0, 6).toUpperCase();
  el("checkoutAmount").textContent = money(total);
  show(el("checkoutOverlay"));

  const holder = el("qrCanvasHolder");
  holder.innerHTML = `<p class="empty-note" style="padding:20px 0;">Loading payment code…</p>`;

  try{
    const settings = await getPaymentSettings();
    holder.innerHTML = "";

    if (settings.qrImageUrl){
      const img = document.createElement("img");
      img.src = settings.qrImageUrl;
      img.alt = "Payment QR code";
      img.style.width = "220px";
      img.style.height = "220px";
      img.style.objectFit = "cover";
      holder.appendChild(img);
    } else {
      const canvas = document.createElement("canvas");
      holder.appendChild(canvas);
      const upiUri = "upi://pay?" + [
        "pa=" + encodeURIComponent(settings.upiId),
        "pn=" + encodeURIComponent(settings.payeeName),
        "am=" + encodeURIComponent(total),
        "cu=INR",
        "tn=" + encodeURIComponent("Order " + orderId.slice(0, 6)),
      ].join("&");
      QRCode.toCanvas(canvas, upiUri, { width: 220, margin: 1 }, (err) => {
        if (err) console.error(err);
      });
    }
  } catch(e){
    console.error("openCheckout render", e);
    holder.innerHTML = `<p class="empty-note" style="padding:20px 0;">Couldn't load the payment code — your order is saved either way. Try reopening it from "My orders".</p>`;
  }
}
function closeCheckout(){ hide(el("checkoutOverlay")); }
el("checkoutClose").onclick = closeCheckout;
el("viewMyOrdersFromCheckout").onclick = () => { closeCheckout(); openMyOrders(); };

el("confirmPaidBtn").onclick = async () => {
  if (!activeOrderId) { closeCheckout(); return; }
  const btn = el("confirmPaidBtn");
  btn.disabled = true;
  try{
    await db.collection("orders").doc(activeOrderId).update({ customerConfirmedPaid: true });
    toast("Thanks! We'll confirm your payment shortly.");
  } catch(e){
    console.error(e);
    toast("Couldn't save that — please try again.");
  } finally {
    btn.disabled = false;
    closeCheckout();
  }
};

/* ---------------------------------------------------------------------- */
/* My orders (customer) — fix #2                                          */
/* ---------------------------------------------------------------------- */
// Previously this used .where(userId).orderBy(createdAt) in a single
// one-off .get(). Firestore requires a composite index for an equality
// filter combined with orderBy on a different field — without deploying
// that index, the query throws and the customer just saw "couldn't load
// your orders" (their order existed the whole time). Fixed by querying
// with only the equality filter (needs no special index) and sorting
// client-side, and made it a live listener so status changes (paid /
// rejected / delivered) update instantly while the page is open.
function openMyOrders(){
  show(el("myOrdersOverlay"));
  const wrap = el("myOrdersList");
  hide(el("myOrdersEmptyNote"));
  wrap.innerHTML = `<p class="empty-note">Loading your orders…</p>`;

  if (myOrdersUnsub) myOrdersUnsub();
  myOrdersUnsub = db.collection("orders")
    .where("userId", "==", currentUser.uid)
    .onSnapshot((snap) => {
      let orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      orders.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      wrap.innerHTML = "";
      if (orders.length === 0){
        show(el("myOrdersEmptyNote"));
        return;
      }
      hide(el("myOrdersEmptyNote"));
      orders.forEach(o => wrap.appendChild(orderCard(o, { adminActions: false })));
    }, (err) => {
      console.error("openMyOrders", err);
      wrap.innerHTML = `<p class="empty-note">Couldn't load your orders — please try again.</p>`;
    });
}
function closeMyOrders(){
  hide(el("myOrdersOverlay"));
  if (myOrdersUnsub){ myOrdersUnsub(); myOrdersUnsub = null; }
}
el("myOrdersClose").onclick = closeMyOrders;
el("myOrdersOverlay").addEventListener("click", (e) => { if (e.target === el("myOrdersOverlay")) closeMyOrders(); });

/* ======================================================================= */
/* ADMIN — product management                                              */
/* ======================================================================= */
el("dropzone").addEventListener("click", () => el("productImage").click());
el("productImage").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedImageFile = file;
  const dz = el("dropzone");
  const preview = el("dropzonePreview");
  const reader = new FileReader();
  reader.onload = (ev) => {
    dz.classList.add("has-image");
    preview.innerHTML = `<img src="${ev.target.result}" alt="preview">`;
  };
  reader.readAsDataURL(file);
});

function resetAddProductForm(){
  el("addProductForm").reset();
  selectedImageFile = null;
  const dz = el("dropzone");
  dz.classList.remove("has-image");
  el("dropzonePreview").innerHTML = `<span id="dropzoneText">Click to choose an image</span>`;
  addSectionsSelected = new Set();
  addSizesSelected = new Set();
  renderCheckboxPills(el("productSectionsList"), sections, addSectionsSelected, s => s.name);
  renderCheckboxPills(el("productSizesList"), sizes, addSizesSelected, s => s.label);
}

el("addProductForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = el("addProductError");
  hide(errBox);

  const name = el("productName").value.trim();
  const price = Number(el("productPrice").value);
  const details = el("productDetails").value.trim();
  const keywords = parseKeywords(el("productKeywords").value);

  if (!selectedImageFile){
    errBox.textContent = "Please choose an image.";
    show(errBox);
    return;
  }
  if (!name || !price || price <= 0){
    errBox.textContent = "Please add a name and a valid price.";
    show(errBox);
    return;
  }

  const btn = el("addProductBtn");
  btn.disabled = true;
  btn.textContent = "Uploading…";

  try{
    const imageUrl = await uploadImageToCloudinary(selectedImageFile);

    await db.collection("products").add({
      name, price, details,
      imageUrl,
      tags: [],
      keywords,
      sections: Array.from(addSectionsSelected),
      sizes: Array.from(addSizesSelected),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    resetAddProductForm();
    toast("Poster added");
  } catch(err){
    console.error(err);
    errBox.textContent = "Upload failed — check your connection and try again.";
    show(errBox);
  } finally {
    btn.disabled = false;
    btn.textContent = "Add product";
  }
});

function renderAdminProducts(){
  const body = el("adminProductRows");
  body.innerHTML = "";
  if (products.length === 0){ show(el("adminEmptyNote")); return; }
  hide(el("adminEmptyNote"));

  products.forEach(p => {
    const tags = p.tags || [];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><img src="${p.imageUrl}" alt=""></td>
      <td>${escapeHtml(p.name)}</td>
      <td>${money(p.price)}</td>
      <td>
        <div class="row-actions">
          <button class="tag-pill bestseller ${tags.includes("bestseller") ? "on" : ""}" data-tag="bestseller">★ Bestseller</button>
          <button class="tag-pill oos ${tags.includes("out_of_stock") ? "on" : ""}" data-tag="out_of_stock">Out of stock</button>
        </div>
      </td>
      <td>
        <div class="row-actions">
          <button class="link-edit" data-act="edit">Edit</button>
          <button class="link-danger" data-act="delete">Delete</button>
        </div>
      </td>
    `;
    tr.querySelectorAll(".tag-pill").forEach(pill => {
      pill.onclick = () => toggleTag(p.id, pill.dataset.tag, tags.includes(pill.dataset.tag));
    });
    tr.querySelector('[data-act="edit"]').onclick = () => openEditProduct(p);
    tr.querySelector('[data-act="delete"]').onclick = () => deleteProduct(p.id, p.name);
    body.appendChild(tr);
  });
}

async function toggleTag(productId, tag, isOn){
  try{
    await db.collection("products").doc(productId).update({
      tags: isOn
        ? firebase.firestore.FieldValue.arrayRemove(tag)
        : firebase.firestore.FieldValue.arrayUnion(tag),
    });
  } catch(e){ console.error(e); toast("Couldn't update that — try again."); }
}

async function deleteProduct(productId, name){
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
  try{
    await db.collection("products").doc(productId).delete();
    toast("Poster deleted");
  } catch(e){ console.error(e); toast("Couldn't delete — try again."); }
}

/* ---------------------------------------------------------------------- */
/* ADMIN — edit product                                                    */
/* ---------------------------------------------------------------------- */
el("editDropzone").addEventListener("click", () => el("editProductImage").click());
el("editProductImage").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedEditImageFile = file;
  const dz = el("editDropzone");
  const preview = el("editDropzonePreview");
  const reader = new FileReader();
  reader.onload = (ev) => {
    dz.classList.add("has-image");
    preview.innerHTML = `<img src="${ev.target.result}" alt="preview">`;
  };
  reader.readAsDataURL(file);
});

function openEditProduct(p){
  editingProductId = p.id;
  selectedEditImageFile = null;
  hide(el("editProductError"));
  el("editProductName").value = p.name || "";
  el("editProductPrice").value = p.price || "";
  el("editProductDetails").value = p.details || "";
  el("editProductKeywords").value = (p.keywords || []).join(", ");
  const dz = el("editDropzone");
  dz.classList.add("has-image");
  el("editDropzonePreview").innerHTML = `<img src="${p.imageUrl}" alt="current image">`;

  editSectionsSelected = new Set(p.sections || []);
  editSizesSelected = new Set(p.sizes || []);
  renderCheckboxPills(el("editProductSectionsList"), sections, editSectionsSelected, s => s.name);
  renderCheckboxPills(el("editProductSizesList"), sizes, editSizesSelected, s => s.label);

  show(el("editProductOverlay"));
}
function closeEditProduct(){ hide(el("editProductOverlay")); editingProductId = null; }
el("editProductClose").onclick = closeEditProduct;
el("editProductOverlay").addEventListener("click", (e) => { if (e.target === el("editProductOverlay")) closeEditProduct(); });

el("editProductForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = el("editProductError");
  hide(errBox);
  if (!editingProductId) return;

  const name = el("editProductName").value.trim();
  const price = Number(el("editProductPrice").value);
  const details = el("editProductDetails").value.trim();
  const keywords = parseKeywords(el("editProductKeywords").value);

  if (!name || !price || price <= 0){
    errBox.textContent = "Please add a name and a valid price.";
    show(errBox);
    return;
  }

  const btn = el("editProductSaveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try{
    const update = {
      name, price, details, keywords,
      sections: Array.from(editSectionsSelected),
      sizes: Array.from(editSizesSelected),
    };
    if (selectedEditImageFile){
      update.imageUrl = await uploadImageToCloudinary(selectedEditImageFile);
    }
    await db.collection("products").doc(editingProductId).update(update);
    closeEditProduct();
    toast("Poster updated");
  } catch(err){
    console.error(err);
    errBox.textContent = "Couldn't save changes — check your connection and try again.";
    show(errBox);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save changes";
  }
});

/* ---------------------------------------------------------------------- */
/* ADMIN — sections (feature #3)                                          */
/* ---------------------------------------------------------------------- */
el("addSectionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = el("addSectionError");
  hide(errBox);
  const name = el("sectionName").value.trim();
  if (!name){ errBox.textContent = "Give the section a name."; show(errBox); return; }
  try{
    await db.collection("sections").add({ name, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    el("addSectionForm").reset();
    toast("Section added");
  } catch(err){
    console.error(err);
    errBox.textContent = "Couldn't add that section — try again.";
    show(errBox);
  }
});

function renderSectionsAdminList(){
  const wrap = el("sectionsListWrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (sections.length === 0){ show(el("sectionsEmptyNote")); return; }
  hide(el("sectionsEmptyNote"));
  sections.forEach(s => {
    const count = products.filter(p => (p.sections || []).includes(s.id)).length;
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `
      <span class="list-name">${escapeHtml(s.name)}</span>
      <span class="list-count">${count} poster${count === 1 ? "" : "s"}</span>
      <button class="link-danger" type="button">Delete</button>
    `;
    row.querySelector("button").onclick = async () => {
      if (!confirm(`Delete section "${s.name}"? Posters in it stay listed, just ungrouped.`)) return;
      try{ await db.collection("sections").doc(s.id).delete(); toast("Section deleted"); }
      catch(e){ console.error(e); toast("Couldn't delete — try again."); }
    };
    wrap.appendChild(row);
  });
}

/* ---------------------------------------------------------------------- */
/* ADMIN — sizes (feature #6)                                             */
/* ---------------------------------------------------------------------- */
el("sizeDropzone").addEventListener("click", () => el("sizeImage").click());
el("sizeImage").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedSizeImageFile = file;
  const dz = el("sizeDropzone");
  const preview = el("sizeDropzonePreview");
  const reader = new FileReader();
  reader.onload = (ev) => {
    dz.classList.add("has-image");
    preview.innerHTML = `<img src="${ev.target.result}" alt="preview">`;
  };
  reader.readAsDataURL(file);
});

el("addSizeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = el("addSizeError");
  hide(errBox);
  const label = el("sizeLabel").value.trim();
  if (!label){ errBox.textContent = "Give the size a label."; show(errBox); return; }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "Saving…";
  try{
    let referenceImageUrl = null;
    if (selectedSizeImageFile){
      referenceImageUrl = await uploadImageToCloudinary(selectedSizeImageFile);
    }
    await db.collection("sizes").add({ label, referenceImageUrl, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    el("addSizeForm").reset();
    selectedSizeImageFile = null;
    const dz = el("sizeDropzone");
    dz.classList.remove("has-image");
    el("sizeDropzonePreview").innerHTML = `<span>Click to upload a reference image</span>`;
    toast("Size added");
  } catch(err){
    console.error(err);
    errBox.textContent = "Couldn't add that size — try again.";
    show(errBox);
  } finally {
    btn.disabled = false;
    btn.textContent = "Add size";
  }
});

function renderSizesAdminList(){
  const wrap = el("sizesListWrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (sizes.length === 0){ show(el("sizesEmptyNote")); return; }
  hide(el("sizesEmptyNote"));
  sizes.forEach(s => {
    const count = products.filter(p => (p.sizes || []).includes(s.id)).length;
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `
      ${s.referenceImageUrl ? `<img src="${s.referenceImageUrl}" alt="">` : `<div style="width:44px;height:44px;border:1px dashed var(--grey);flex:none;"></div>`}
      <span class="list-name">${escapeHtml(s.label)}</span>
      <span class="list-count">${count} poster${count === 1 ? "" : "s"}</span>
      <button class="link-danger" type="button">Delete</button>
    `;
    row.querySelector("button").onclick = async () => {
      if (!confirm(`Delete size "${s.label}"?`)) return;
      try{ await db.collection("sizes").doc(s.id).delete(); toast("Size deleted"); }
      catch(e){ console.error(e); toast("Couldn't delete — try again."); }
    };
    wrap.appendChild(row);
  });
}

/* ======================================================================= */
/* ADMIN — tabs                                                            */
/* ======================================================================= */
const ADMIN_TABS = {
  products: "adminProductsTab",
  sections: "adminSectionsTab",
  sizes: "adminSizesTab",
  orders: "adminOrdersTab",
  settings: "adminSettingsTab",
};
document.querySelectorAll(".admin-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    Object.values(ADMIN_TABS).forEach(id => hide(el(id)));
    show(el(ADMIN_TABS[tab.dataset.tab]));
  });
});

/* ---------------------------------------------------------------------- */
/* ADMIN — orders board                                                    */
/* ---------------------------------------------------------------------- */
let ordersUnsub = null;
function listenOrders(){
  if (ordersUnsub) return;
  ordersUnsub = db.collection("orders").orderBy("createdAt", "desc")
    .onSnapshot((snap) => {
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderOrdersBoard(orders);
    }, (err) => console.error("orders listener", err));
}

// Admin-facing labels (what YOU see on the board)
const STATUS_LABEL = {
  awaiting_verification: "Received",
  paid: "Payment verified",
  fulfilled: "Delivered",
  rejected: "Rejected",
};
const STATUS_CLASS = {
  awaiting_verification: "status-awaiting",
  paid: "status-paid",
  fulfilled: "status-fulfilled",
  rejected: "status-rejected",
};
const BOARD_COLUMNS = [
  { key: "awaiting_verification", label: "Received" },
  { key: "paid", label: "Payment verified" },
  { key: "fulfilled", label: "Delivered" },
  { key: "rejected", label: "Rejected" },
];

// Customer-facing labels + reassurance messages (fix #2). No "check your
// email" line — no email actually goes out yet, so this only shows what's
// true: what they'll see right here on this page.
const CUSTOMER_STATUS = {
  awaiting_verification: { label: "Payment not verified yet", cls: "msg-awaiting", msg: "We haven't verified your payment yet — we check these regularly and will update this page once confirmed." },
  paid: { label: "Order confirmed", cls: "msg-paid", msg: "Order placed successfully! Your payment is verified and we're getting it ready." },
  fulfilled: { label: "Delivered", cls: "msg-fulfilled", msg: "This order has been delivered. Thanks for shopping with us!" },
  rejected: { label: "Order rejected", cls: "msg-rejected", msg: "This order was rejected — we couldn't verify the payment. If you think that's a mistake, please get in touch with us directly." },
};

function renderOrdersBoard(orders){
  const board = el("ordersBoard");
  board.innerHTML = "";

  if (orders.length === 0){
    show(el("ordersEmptyNote"));
    return;
  }
  hide(el("ordersEmptyNote"));

  const groups = { awaiting_verification: [], paid: [], fulfilled: [], rejected: [] };
  orders.forEach(o => { (groups[o.status] || groups.awaiting_verification).push(o); });

  BOARD_COLUMNS.forEach(c => {
    const col = document.createElement("div");
    col.className = "orders-col";
    col.innerHTML = `
      <div class="orders-col-head"><span>${c.label}</span><span class="count">${groups[c.key].length}</span></div>
      <div class="orders-col-body" id="col-${c.key}"></div>
    `;
    board.appendChild(col);
    const body = col.querySelector(`#col-${c.key}`);
    if (groups[c.key].length === 0){
      body.innerHTML = `<p class="empty-note" style="padding:16px 0;">Nothing here.</p>`;
    } else {
      groups[c.key].forEach(o => body.appendChild(orderCard(o, { adminActions: true })));
    }
  });
}

// Shared order card, used by both the admin board and "My orders".
function orderCard(o, opts){
  const adminActions = !!(opts && opts.adminActions);
  const card = document.createElement("div");
  card.className = "order-card";
  const itemsStr = (o.items || []).map(i => `${i.name} ×${i.qty}`).join(", ");
  const s = o.shipping || null;
  const cs = CUSTOMER_STATUS[o.status] || CUSTOMER_STATUS.awaiting_verification;
  const pillLabel = adminActions ? (STATUS_LABEL[o.status] || o.status) : cs.label;
  const pillClass = STATUS_CLASS[o.status] || "";

  card.innerHTML = `
    <div class="order-head">
      <span>#${o.id.slice(0,6).toUpperCase()}${adminActions ? " · " + escapeHtml(o.userEmail || "") : ""}</span>
      <span class="status-pill ${pillClass}">${pillLabel}</span>
    </div>
    ${!adminActions ? `<div class="order-customer-msg ${cs.cls}">${escapeHtml(cs.msg)}</div>` : ""}
    <div class="order-items">${escapeHtml(itemsStr)}${o.customerConfirmedPaid ? " · buyer marked as paid" : ""}</div>
    ${s ? `<div class="order-shipping">${escapeHtml(s.name || "")}<br>${escapeHtml(s.phone || "")}<br>${escapeHtml(s.address || "")}<br>PIN ${escapeHtml(s.pincode || "")}</div>` : ""}
    <div class="order-total">${money(o.total)}</div>
    <div class="row-actions" id="actions-${o.id}"></div>
  `;

  if (adminActions){
    const actions = card.querySelector(`#actions-${o.id}`);
    if (o.status === "awaiting_verification"){
      const payBtn = document.createElement("button");
      payBtn.className = "btn btn-blue"; payBtn.textContent = "Mark paid";
      payBtn.onclick = () => updateOrderStatus(o.id, "paid");
      const rejectBtn = document.createElement("button");
      rejectBtn.className = "btn btn-red"; rejectBtn.textContent = "Reject";
      rejectBtn.onclick = () => updateOrderStatus(o.id, "rejected");
      actions.append(payBtn, rejectBtn);
    } else if (o.status === "paid"){
      const fulfillBtn = document.createElement("button");
      fulfillBtn.className = "btn btn-solid"; fulfillBtn.textContent = "Mark delivered";
      fulfillBtn.onclick = () => updateOrderStatus(o.id, "fulfilled");
      actions.appendChild(fulfillBtn);
    }
  }

  return card;
}

async function updateOrderStatus(orderId, status){
  try{
    await db.collection("orders").doc(orderId).update({ status });
    toast("Order updated");
  } catch(e){ console.error(e); toast("Couldn't update the order — try again."); }
}

/* ---------------------------------------------------------------------- */
/* ADMIN — payment settings                                                */
/* ---------------------------------------------------------------------- */
el("qrDropzone").addEventListener("click", () => el("qrImageInput").click());
el("qrImageInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedQrImageFile = file;
  const dz = el("qrDropzone");
  const preview = el("qrDropzonePreview");
  const reader = new FileReader();
  reader.onload = (ev) => {
    dz.classList.add("has-image");
    preview.innerHTML = `<img src="${ev.target.result}" alt="preview">`;
  };
  reader.readAsDataURL(file);
});

async function loadPaymentSettingsIntoForm(){
  try{
    const doc = await db.collection("settings").doc("payment").get();
    const d = doc.exists ? doc.data() : {};
    el("settingUpiId").value = d.upiId || "";
    el("settingPayeeName").value = d.payeeName || "";
    const dz = el("qrDropzone");
    const preview = el("qrDropzonePreview");
    if (d.qrImageUrl){
      dz.classList.add("has-image");
      preview.innerHTML = `<img src="${d.qrImageUrl}" alt="current QR">`;
    } else {
      dz.classList.remove("has-image");
      preview.innerHTML = `<span id="qrDropzoneText">Click to upload a QR image</span>`;
    }
  } catch(e){
    console.error("loadPaymentSettingsIntoForm", e);
  }
}

el("paymentSettingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = el("settingsError");
  hide(errBox);

  const upiId = el("settingUpiId").value.trim();
  const payeeName = el("settingPayeeName").value.trim() || "The Wall Store";

  const btn = el("settingsSaveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try{
    const update = { upiId, payeeName };
    if (selectedQrImageFile){
      update.qrImageUrl = await uploadImageToCloudinary(selectedQrImageFile);
    }
    await db.collection("settings").doc("payment").set(update, { merge: true });
    selectedQrImageFile = null;
    toast("Payment settings saved");
  } catch(err){
    console.error(err);
    errBox.textContent = "Couldn't save settings — check your connection and try again.";
    show(errBox);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save payment settings";
  }
});
