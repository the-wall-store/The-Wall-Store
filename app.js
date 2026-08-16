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

const MIN_ORDER_VALUE = 50; // ₹ — fix #3

/* ---------------------------------------------------------------------- */
/* State                                                                   */
/* ---------------------------------------------------------------------- */
let currentUser = null;
let isOwner = false;
let products = [];
let sections = [];
let sizes = [];
let cart = loadCart();
let pendingAfterAuth = null;
let authMode = "signin";
let selectedImageFile = null;
let selectedEditImageFile = null;
let selectedQrImageFile = null;
let selectedSizeImageFile = null;
let editingProductId = null;
let searchQuery = "";
let myOrdersUnsub = null;
let activeStoreTab = "posters"; // "posters" | "collections" | a section id
let savedShippingProfile = null; // cached from users/{uid}
let pendingOrder = null; // { items, total, shipping } — held in memory until "I've paid"

let addSectionsSelected = new Set();
let addSizesSelected = new Set();
let addSizePrices = new Map(); // sizeId -> price string
let editSectionsSelected = new Set();
let editSizesSelected = new Set();
let editSizePrices = new Map();

let lastOrdersSnapshot = []; // most recent full orders list, for the unseen badge

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

function productMinPrice(p){
  const entries = Object.values(p.sizePrices || {});
  if (entries.length > 0) return Math.min(...entries);
  return p.price || 0;
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
    loadHelpSettingsIntoAdminForm();
  } else {
    show(el("storeView"));
    hide(el("adminView"));
    el("modeLabel").textContent = "Posters, printed for your walls";
  }

  if (user){
    const hadPending = !!pendingAfterAuth;
    const fn = pendingAfterAuth;
    pendingAfterAuth = null;
    if (!el("authOverlay").classList.contains("hidden")) closeAuthModal();
    if (hadPending) fn();
  } else {
    if (myOrdersUnsub){ myOrdersUnsub(); myOrdersUnsub = null; }
    savedShippingProfile = null;
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

  const helpBtn = document.createElement("button");
  helpBtn.className = "btn"; helpBtn.textContent = "Help";
  helpBtn.onclick = openHelp;
  wrap.appendChild(helpBtn);

  if (currentUser){
    const ordersBtn = document.createElement("button");
    ordersBtn.className = "btn"; ordersBtn.textContent = "My orders";
    ordersBtn.onclick = openMyOrders;
    wrap.appendChild(ordersBtn);
  }

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
  } catch(err){
    errBox.textContent = friendlyAuthError(err);
    show(errBox);
  } finally {
    el("authSubmitBtn").disabled = false;
  }
});

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
  renderStore();
  renderSizesAdminList();
  renderSizePricingList(el("productSizesList"), addSizesSelected, addSizePrices);
  renderSizePricingList(el("editProductSizesList"), editSizesSelected, editSizePrices);
}, (err) => console.error("sizes listener", err));

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

// Sizes need a price attached to each selection — separate renderer.
function renderSizePricingList(container, selectedSet, pricesMap){
  if (!container) return;
  container.innerHTML = "";
  if (sizes.length === 0){
    container.innerHTML = `<p class="empty-note">No sizes yet — add some in the Sizes tab.</p>`;
    return;
  }
  sizes.forEach(sz => {
    const row = document.createElement("div");
    row.className = "size-price-row";

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "checkbox-pill" + (selectedSet.has(sz.id) ? " on" : "");
    pill.textContent = sz.label;

    const priceInput = document.createElement("input");
    priceInput.type = "number";
    priceInput.min = "0";
    priceInput.step = "1";
    priceInput.className = "size-price-input" + (selectedSet.has(sz.id) ? "" : " hidden");
    priceInput.placeholder = `Price for ${sz.label}`;
    priceInput.value = pricesMap.has(sz.id) ? pricesMap.get(sz.id) : "";
    priceInput.addEventListener("input", () => pricesMap.set(sz.id, priceInput.value));

    pill.onclick = () => {
      if (selectedSet.has(sz.id)){
        selectedSet.delete(sz.id);
        pill.classList.remove("on");
        priceInput.classList.add("hidden");
      } else {
        selectedSet.add(sz.id);
        pill.classList.add("on");
        priceInput.classList.remove("hidden");
        priceInput.focus();
      }
    };

    row.append(pill, priceInput);
    container.appendChild(row);
  });
}

/* ---------------------------------------------------------------------- */
/* Store rendering: tabs + bestsellers + search                            */
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

  const bestsellers = products.filter(p => (p.tags || []).includes("bestseller"));
  const bestGrid = el("bestsellerGrid");
  bestGrid.innerHTML = "";
  if (bestsellers.length === 0){
    hide(el("bestsellerBlock"));
  } else {
    show(el("bestsellerBlock"));
    bestsellers.forEach(p => bestGrid.appendChild(productCard(p)));
  }

  renderStoreTabs();

  if (activeStoreTab !== "posters" && activeStoreTab !== "collections" &&
      !sections.some(s => s.id === activeStoreTab)){
    activeStoreTab = "posters";
  }

  let list, emptyMsg;
  if (activeStoreTab === "posters"){
    list = products.filter(p => (p.type || "poster") !== "collection");
    emptyMsg = "No posters up yet — check back soon.";
  } else if (activeStoreTab === "collections"){
    list = products.filter(p => p.type === "collection");
    emptyMsg = "No collections up yet — check back soon.";
  } else {
    list = products.filter(p => (p.sections || []).includes(activeStoreTab));
    emptyMsg = "Nothing in this section yet.";
  }

  const grid = el("activeTabGrid");
  grid.innerHTML = "";
  const emptyNote = el("activeTabEmptyNote");
  if (list.length === 0){
    emptyNote.textContent = emptyMsg;
    show(emptyNote);
  } else {
    hide(emptyNote);
    list.forEach(p => grid.appendChild(productCard(p)));
  }

  hide(el("emptyNote"));
}

function renderStoreTabs(){
  const wrap = el("storeTabs");
  wrap.innerHTML = "";
  const tabs = [
    { key: "posters", label: "All Posters" },
    { key: "collections", label: "All Collections" },
    ...sections.map(s => ({ key: s.id, label: s.name })),
  ];
  tabs.forEach(t => {
    const btn = document.createElement("button");
    btn.className = "store-tab" + (activeStoreTab === t.key ? " active" : "");
    btn.textContent = t.label;
    btn.onclick = () => { activeStoreTab = t.key; renderStore(); };
    wrap.appendChild(btn);
  });
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
  const hasSizes = (p.sizes || []).length > 0;
  const priceLabel = hasSizes ? `From ${money(productMinPrice(p))}` : money(p.price);

  card.innerHTML = `
    <div class="tape"></div>
    <div class="thumb-wrap">
      <img src="${p.imageUrl}" alt="${escapeHtml(p.name)}" loading="lazy">
      ${oos ? `<div class="stamp"><span>Sold out</span></div>` : ""}
      ${best ? `<div class="fav-tag">★ Bestseller</div>` : ""}
    </div>
    <h3>${escapeHtml(p.name)}</h3>
    <div class="price-row"><span class="price">${priceLabel}</span></div>
    <button class="add-btn" ${oos ? "disabled" : ""}>${oos ? "Out of stock" : (hasSizes ? "Select size" : "Add to cart")}</button>
  `;
  card.querySelector(".add-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (oos) return;
    if (hasSizes) openDetail(p);
    else addToCart(p, null);
  });
  card.addEventListener("click", () => openDetail(p));
  return card;
}

/* ---------------------------------------------------------------------- */
/* Product detail modal                                                    */
/* ---------------------------------------------------------------------- */
let detailSelectedSizeId = null;

function openDetail(p){
  const oos = (p.tags || []).includes("out_of_stock");
  const best = (p.tags || []).includes("bestseller");
  const productSizes = (p.sizes || []).map(id => sizes.find(s => s.id === id)).filter(Boolean);
  detailSelectedSizeId = productSizes.length > 0 ? productSizes[0].id : null;

  function currentPrice(){
    if (!detailSelectedSizeId) return p.price || 0;
    return (p.sizePrices || {})[detailSelectedSizeId] ?? 0;
  }

  el("detailContent").innerHTML = `
    <div class="thumb-wrap detail-thumb">
      <img src="${p.imageUrl}" alt="${escapeHtml(p.name)}">
    </div>
    <div>
      ${best ? `<div class="fav-tag" style="position:static; display:inline-block; margin-bottom:10px;">★ Bestseller</div>` : ""}
      <h2 style="margin-top:0;">${escapeHtml(p.name)}</h2>
      <div class="price-row" style="font-size:20px; margin-bottom:14px;"><span class="price" id="detailPrice">${money(currentPrice())}</span></div>
      <p style="font-size:14px; line-height:1.6; color:var(--grey);">${escapeHtml(p.details || "No extra details for this print.")}</p>
      ${productSizes.length > 0 ? `
        <p style="font-family:var(--font-mono); font-size:11px; text-transform:uppercase; letter-spacing:1px; color:var(--grey); margin:16px 0 0;">Size — tap to select, tap the selected one again to see it to scale</p>
        <div class="size-pill-row" id="detailSizeRow"></div>
      ` : ""}
      <button class="btn btn-solid" style="width:100%; margin-top:16px;" id="detailAddBtn" ${oos ? "disabled" : ""}>
        ${oos ? "Out of stock" : "Add to cart"}
      </button>
    </div>
  `;

  if (productSizes.length > 0){
    const row = el("detailSizeRow");
    function renderPills(){
      row.innerHTML = "";
      productSizes.forEach(sz => {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "size-pill" + (sz.id === detailSelectedSizeId ? " selected" : "");
        pill.textContent = sz.label;
        pill.onclick = () => {
          if (detailSelectedSizeId === sz.id && sz.referenceImageUrl){
            openSizeRef(sz);
            return;
          }
          detailSelectedSizeId = sz.id;
          el("detailPrice").textContent = money(currentPrice());
          renderPills();
        };
        row.appendChild(pill);
      });
    }
    renderPills();
  }

  const btn = el("detailAddBtn");
  if (btn && !oos){
    btn.onclick = () => {
      const sz = productSizes.find(s => s.id === detailSelectedSizeId);
      addToCart(p, sz ? { id: sz.id, label: sz.label, price: currentPrice() } : null);
      closeDetail();
    };
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
/* Cart — keyed by product+size combo so different sizes are separate lines */
/* ---------------------------------------------------------------------- */
function addToCart(p, size){
  const key = size ? `${p.id}__${size.id}` : p.id;
  if (!cart[key]){
    cart[key] = {
      cartKey: key,
      productId: p.id,
      name: p.name + (size ? ` (${size.label})` : ""),
      sizeLabel: size ? size.label : null,
      price: size ? size.price : (p.price || 0),
      imageUrl: p.imageUrl,
      qty: 0,
    };
  }
  cart[key].qty += 1;
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
      if (item.qty <= 0) delete cart[item.cartKey];
      saveCart(); renderCart(); updateCartBadge();
    };
    row.querySelector(".remove").onclick = () => { delete cart[item.cartKey]; saveCart(); renderCart(); updateCartBadge(); };
    wrap.appendChild(row);
  });
  el("cartTotal").textContent = money(cartTotal());
}

function cartTotal(){
  return Object.values(cart).reduce((s, i) => s + i.price * i.qty, 0);
}

// Fix #3: minimum order value.
el("placeOrderBtn").onclick = () => {
  const err = el("cartError");
  if (Object.keys(cart).length === 0){
    err.textContent = "Your cart is empty.";
    show(err);
    return;
  }
  const total = cartTotal();
  if (total < MIN_ORDER_VALUE){
    err.textContent = `Minimum order is ${money(MIN_ORDER_VALUE)} — add a bit more to check out.`;
    show(err);
    return;
  }
  hide(err);
  if (!currentUser){
    closeCart();
    openAuthModal(() => openShippingModal());
    return;
  }
  closeCart();
  openShippingModal();
};

/* ---------------------------------------------------------------------- */
/* Shipping details — fix #6: confirm-saved-details screen                 */
/* ---------------------------------------------------------------------- */
async function openShippingModal(){
  hide(el("shippingError"));
  el("shippingForm").reset();

  try{
    const doc = await db.collection("users").doc(currentUser.uid).get();
    savedShippingProfile = doc.exists ? doc.data() : null;
  } catch(e){
    console.error("load shipping profile", e);
    savedShippingProfile = null;
  }

  if (savedShippingProfile && savedShippingProfile.name){
    showShippingConfirmView();
  } else {
    showShippingEditView();
  }
  show(el("shippingOverlay"));
}

function showShippingConfirmView(){
  const d = savedShippingProfile;
  el("shippingConfirmSummary").innerHTML =
    `${escapeHtml(d.name || "")}<br>${escapeHtml(d.phone || "")}<br>${escapeHtml(d.address || "")}<br>PIN ${escapeHtml(d.pincode || "")}`;
  show(el("shippingConfirmView"));
  hide(el("shippingFormView"));
}

function showShippingEditView(){
  if (savedShippingProfile){
    el("shipName").value = savedShippingProfile.name || "";
    el("shipPhone").value = savedShippingProfile.phone || "";
    el("shipAddress").value = savedShippingProfile.address || "";
    el("shipPincode").value = savedShippingProfile.pincode || "";
  }
  hide(el("shippingConfirmView"));
  show(el("shippingFormView"));
}

el("shippingEditBtn").onclick = showShippingEditView;

el("shippingConfirmBtn").onclick = () => {
  const d = savedShippingProfile;
  proceedToCheckout({ name: d.name, phone: d.phone, address: d.address, pincode: d.pincode });
};

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
  btn.textContent = "Continuing…";

  // Save the profile the moment we have valid details — independent of
  // whether the customer goes on to actually pay, so it's there next time
  // regardless. (Fix #6 — this used to only fire deep inside order
  // creation, which no longer happens at this step; see fix #9.)
  db.collection("users").doc(currentUser.uid).set(shipping, { merge: true }).catch((e) => {
    console.error("save shipping profile", e);
  });
  savedShippingProfile = shipping;

  proceedToCheckout(shipping);
  btn.disabled = false;
  btn.textContent = "Continue to payment";
});

function proceedToCheckout(shipping){
  const items = Object.values(cart).map(i => ({
    productId: i.productId, name: i.name, price: i.price, qty: i.qty, sizeLabel: i.sizeLabel || null,
  }));
  const total = cartTotal();
  pendingOrder = { items, total, shipping };
  closeShippingModal();
  openCheckout();
}

/* ---------------------------------------------------------------------- */
/* Checkout / payment screen — fix #9: nothing is saved to the database    */
/* until the customer taps "I've paid". Fix #8: UPI ID/payee name are      */
/* always shown as plain text too, and the help link is wired up.         */
/* ---------------------------------------------------------------------- */
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

async function openCheckout(){
  if (!pendingOrder) return;
  el("checkoutSub").textContent = `${pendingOrder.items.reduce((s,i)=>s+i.qty,0)} item(s)`;
  el("checkoutAmount").textContent = money(pendingOrder.total);
  hide(el("upiTextRow"));
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
        "am=" + encodeURIComponent(pendingOrder.total),
        "cu=INR",
        "tn=" + encodeURIComponent("The Wall Store order"),
      ].join("&");
      QRCode.toCanvas(canvas, upiUri, { width: 220, margin: 1 }, (err) => {
        if (err) console.error(err);
      });
    }

    // Fix #8: always show the UPI ID / payee name as plain text too, not
    // just baked into the QR image data.
    if (settings.upiId){
      el("upiPayeeText").textContent = settings.payeeName || "The Wall Store";
      el("upiIdText").textContent = settings.upiId;
      show(el("upiTextRow"));
    }
  } catch(e){
    console.error("openCheckout render", e);
    holder.innerHTML = `<p class="empty-note" style="padding:20px 0;">Couldn't load the payment code — try closing and reopening checkout from your cart.</p>`;
  }
}
function closeCheckout(){ hide(el("checkoutOverlay")); }
el("checkoutClose").onclick = closeCheckout;
el("checkoutHelpBtn").onclick = () => { openHelp(); };

el("upiCopyBtn").onclick = () => {
  const text = el("upiIdText").textContent;
  navigator.clipboard?.writeText(text).then(() => toast("UPI ID copied")).catch(() => {});
};

// This is the ONLY place an order document gets created — only after the
// customer explicitly confirms they've paid. Fixes #9: previously the
// order was written the moment checkout opened, so unpaid/abandoned
// checkouts still showed up for the admin and in "My orders".
el("confirmPaidBtn").onclick = async () => {
  if (!pendingOrder || !currentUser) { closeCheckout(); return; }
  const btn = el("confirmPaidBtn");
  btn.disabled = true;
  btn.textContent = "Placing order…";
  try{
    await db.collection("orders").add({
      userId: currentUser.uid,
      userEmail: currentUser.email,
      items: pendingOrder.items,
      total: pendingOrder.total,
      shipping: pendingOrder.shipping,
      status: "awaiting_verification",
      customerConfirmedPaid: true,
      seenByAdmin: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    cart = {};
    saveCart();
    updateCartBadge();
    pendingOrder = null;
    closeCheckout();
    toast("Order placed! We'll verify your payment and confirm shortly.");
  } catch(e){
    console.error("confirmPaid order create", e);
    toast("Couldn't place the order — please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "I've paid";
  }
};

/* ---------------------------------------------------------------------- */
/* My orders (customer)                                                    */
/* ---------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------- */
/* Help / Contact page (customer) — feature #4                            */
/* ---------------------------------------------------------------------- */
function contactHref(value){
  const v = (value || "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "mailto:" + v;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[+\d][\d\s-]{6,}$/.test(v)) return "tel:" + v.replace(/[^\d+]/g, "");
  return null;
}

async function openHelp(){
  show(el("helpOverlay"));
  el("helpContactsWrap").innerHTML = `<p class="empty-note">Loading…</p>`;
  el("helpContentWrap").textContent = "";
  try{
    const doc = await db.collection("settings").doc("help").get();
    const d = doc.exists ? doc.data() : {};
    const contacts = d.contacts || [];
    const contactsWrap = el("helpContactsWrap");
    contactsWrap.innerHTML = "";
    if (contacts.length > 0){
      const row = document.createElement("div");
      row.className = "contact-card-row";
      contacts.forEach(c => {
        const href = contactHref(c.value);
        const card = document.createElement(href ? "a" : "div");
        card.className = "contact-card";
        if (href){ card.href = href; card.target = "_blank"; card.rel = "noopener"; }
        card.innerHTML = `<span class="contact-label">${escapeHtml(c.label || "Contact")}</span><span class="contact-value">${escapeHtml(c.value || "")}</span>`;
        row.appendChild(card);
      });
      contactsWrap.appendChild(row);
    }
    el("helpContentWrap").textContent = d.content || "";
  } catch(e){
    console.error("openHelp", e);
    el("helpContactsWrap").innerHTML = "";
    el("helpContentWrap").textContent = "Couldn't load the help page right now — please try again.";
  }
}
el("helpClose").onclick = () => hide(el("helpOverlay"));
el("helpOverlay").addEventListener("click", (e) => { if (e.target === el("helpOverlay")) hide(el("helpOverlay")); });
el("footerHelpBtn").onclick = openHelp;

/* ======================================================================= */
/* ADMIN — product management                                              */
/* ======================================================================= */
function setupTypeToggle(containerId){
  const container = el(containerId);
  container.querySelectorAll("input[type=radio]").forEach(radio => {
    radio.addEventListener("change", () => {
      container.querySelectorAll(".type-pill").forEach(p => p.classList.remove("on"));
      radio.closest(".type-pill").classList.add("on");
    });
  });
}
setupTypeToggle("addTypeToggle");
setupTypeToggle("editTypeToggle");
function getSelectedType(containerId){
  const checked = el(containerId).querySelector("input[type=radio]:checked");
  return checked ? checked.value : "poster";
}
function setSelectedType(containerId, type){
  const container = el(containerId);
  container.querySelectorAll("input[type=radio]").forEach(radio => {
    radio.checked = radio.value === type;
    radio.closest(".type-pill").classList.toggle("on", radio.checked);
  });
}

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
  setSelectedType("addTypeToggle", "poster");
  addSectionsSelected = new Set();
  addSizesSelected = new Set();
  addSizePrices = new Map();
  renderCheckboxPills(el("productSectionsList"), sections, addSectionsSelected, s => s.name);
  renderSizePricingList(el("productSizesList"), addSizesSelected, addSizePrices);
}

el("addProductForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = el("addProductError");
  hide(errBox);

  const name = el("productName").value.trim();
  const basePrice = Number(el("productPrice").value) || 0;
  const details = el("productDetails").value.trim();
  const keywords = parseKeywords(el("productKeywords").value);
  const type = getSelectedType("addTypeToggle");
  const sizeIds = Array.from(addSizesSelected);

  if (!selectedImageFile){
    errBox.textContent = "Please choose an image.";
    show(errBox);
    return;
  }
  if (!name){
    errBox.textContent = "Please add a name.";
    show(errBox);
    return;
  }

  const sizePrices = {};
  if (sizeIds.length > 0){
    for (const id of sizeIds){
      const val = Number(addSizePrices.get(id));
      if (!val || val <= 0){
        const sz = sizes.find(s => s.id === id);
        errBox.textContent = `Set a valid price for "${sz ? sz.label : "a selected size"}".`;
        show(errBox);
        return;
      }
      sizePrices[id] = val;
    }
  } else if (!basePrice || basePrice <= 0){
    errBox.textContent = "Add a base price, or pick at least one size with a price.";
    show(errBox);
    return;
  }

  const btn = el("addProductBtn");
  btn.disabled = true;
  btn.textContent = "Uploading…";

  try{
    const imageUrl = await uploadImageToCloudinary(selectedImageFile);

    await db.collection("products").add({
      name, price: basePrice, details,
      imageUrl,
      type,
      tags: [],
      keywords,
      sections: Array.from(addSectionsSelected),
      sizes: sizeIds,
      sizePrices,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    resetAddProductForm();
    toast("Product added");
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
    const hasSizes = (p.sizes || []).length > 0;
    let priceCell;
    if (hasSizes){
      const vals = Object.values(p.sizePrices || {});
      priceCell = vals.length ? `${money(Math.min(...vals))}–${money(Math.max(...vals))}` : "—";
    } else {
      priceCell = money(p.price);
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><img src="${p.imageUrl}" alt=""></td>
      <td>${escapeHtml(p.name)}</td>
      <td style="text-transform:capitalize;">${escapeHtml(p.type || "poster")}</td>
      <td>${priceCell}</td>
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
    toast("Deleted");
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
  setSelectedType("editTypeToggle", p.type || "poster");
  const dz = el("editDropzone");
  dz.classList.add("has-image");
  el("editDropzonePreview").innerHTML = `<img src="${p.imageUrl}" alt="current image">`;

  editSectionsSelected = new Set(p.sections || []);
  editSizesSelected = new Set(p.sizes || []);
  editSizePrices = new Map(Object.entries(p.sizePrices || {}));
  renderCheckboxPills(el("editProductSectionsList"), sections, editSectionsSelected, s => s.name);
  renderSizePricingList(el("editProductSizesList"), editSizesSelected, editSizePrices);

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
  const basePrice = Number(el("editProductPrice").value) || 0;
  const details = el("editProductDetails").value.trim();
  const keywords = parseKeywords(el("editProductKeywords").value);
  const type = getSelectedType("editTypeToggle");
  const sizeIds = Array.from(editSizesSelected);

  if (!name){
    errBox.textContent = "Please add a name.";
    show(errBox);
    return;
  }

  const sizePrices = {};
  if (sizeIds.length > 0){
    for (const id of sizeIds){
      const val = Number(editSizePrices.get(id));
      if (!val || val <= 0){
        const sz = sizes.find(s => s.id === id);
        errBox.textContent = `Set a valid price for "${sz ? sz.label : "a selected size"}".`;
        show(errBox);
        return;
      }
      sizePrices[id] = val;
    }
  } else if (!basePrice || basePrice <= 0){
    errBox.textContent = "Add a base price, or pick at least one size with a price.";
    show(errBox);
    return;
  }

  const btn = el("editProductSaveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try{
    const update = {
      name, price: basePrice, details, keywords, type,
      sections: Array.from(editSectionsSelected),
      sizes: sizeIds,
      sizePrices,
    };
    if (selectedEditImageFile){
      update.imageUrl = await uploadImageToCloudinary(selectedEditImageFile);
    }
    await db.collection("products").doc(editingProductId).update(update);
    closeEditProduct();
    toast("Product updated");
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
/* ADMIN — sections                                                        */
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
      <span class="list-count">${count} item${count === 1 ? "" : "s"}</span>
      <button class="link-danger" type="button">Delete</button>
    `;
    row.querySelector("button").onclick = async () => {
      if (!confirm(`Delete section "${s.name}"? Products in it stay listed, just ungrouped.`)) return;
      try{ await db.collection("sections").doc(s.id).delete(); toast("Section deleted"); }
      catch(e){ console.error(e); toast("Couldn't delete — try again."); }
    };
    wrap.appendChild(row);
  });
}

/* ---------------------------------------------------------------------- */
/* ADMIN — sizes                                                           */
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
      <span class="list-count">${count} item${count === 1 ? "" : "s"}</span>
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
/* ADMIN — tabs (+ unseen-orders badge, fix #5)                            */
/* ======================================================================= */
const ADMIN_TABS = {
  products: "adminProductsTab",
  sections: "adminSectionsTab",
  sizes: "adminSizesTab",
  orders: "adminOrdersTab",
  settings: "adminSettingsTab",
  help: "adminHelpTab",
};
document.querySelectorAll(".admin-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    Object.values(ADMIN_TABS).forEach(id => hide(el(id)));
    show(el(ADMIN_TABS[tab.dataset.tab]));
    if (tab.dataset.tab === "orders") markOrdersSeen();
  });
});

async function markOrdersSeen(){
  const unseen = lastOrdersSnapshot.filter(o => o.seenByAdmin !== true);
  if (unseen.length === 0) return;
  try{
    const batch = db.batch();
    unseen.forEach(o => batch.update(db.collection("orders").doc(o.id), { seenByAdmin: true }));
    await batch.commit();
  } catch(e){
    console.error("markOrdersSeen", e);
  }
}

/* ---------------------------------------------------------------------- */
/* ADMIN — orders board                                                    */
/* ---------------------------------------------------------------------- */
let ordersUnsub = null;
function listenOrders(){
  if (ordersUnsub) return;
  ordersUnsub = db.collection("orders").orderBy("createdAt", "desc")
    .onSnapshot((snap) => {
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      lastOrdersSnapshot = orders;
      renderOrdersBoard(orders);
      renderOrdersBadge(orders);
    }, (err) => console.error("orders listener", err));
}

function renderOrdersBadge(orders){
  const unseenCount = orders.filter(o => o.seenByAdmin !== true).length;
  const badge = el("ordersBadge");
  badge.textContent = unseenCount;
  badge.classList.toggle("hidden", unseenCount === 0);
}

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

// Customer-facing labels + messages (fix #2/#7). Rejected explicitly
// mentions email because the admin has confirmed they manually send one
// for rejections — every other status only promises what's actually true
// (visible right here on this page).
const CUSTOMER_STATUS = {
  awaiting_verification: { label: "Payment not verified yet", cls: "msg-awaiting", msg: "We haven't verified your payment yet — we check these regularly and will update this page once confirmed." },
  paid: { label: "Order confirmed", cls: "msg-paid", msg: "Order placed successfully! Your payment is verified and we're getting it ready." },
  fulfilled: { label: "Delivered", cls: "msg-fulfilled", msg: "This order has been delivered. Thanks for shopping with us!" },
  rejected: { label: "Order rejected", cls: "msg-rejected", msg: "Your order has been rejected. Check your email to know more." },
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
      <span>#${o.id.slice(0,6).toUpperCase()}${adminActions ? " · " + escapeHtml(o.userEmail || "") : ""}${adminActions && o.seenByAdmin !== true ? ' <span class="tab-badge">new</span>' : ""}</span>
      <span class="status-pill ${pillClass}">${pillLabel}</span>
    </div>
    ${!adminActions ? `<div class="order-customer-msg ${cs.cls}">${escapeHtml(cs.msg)}</div>` : ""}
    <div class="order-items">${escapeHtml(itemsStr)}</div>
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

/* ---------------------------------------------------------------------- */
/* ADMIN — help page (feature #4)                                          */
/* ---------------------------------------------------------------------- */
function addContactRow(label, value){
  const wrap = el("contactsEditor");
  const row = document.createElement("div");
  row.className = "contact-edit-row";
  row.innerHTML = `
    <input type="text" placeholder="Label (e.g. WhatsApp)" class="contact-label-input" value="${escapeHtml(label || "")}">
    <input type="text" placeholder="Value (phone, email, link...)" class="contact-value-input" value="${escapeHtml(value || "")}">
    <button type="button" class="link-danger">Remove</button>
  `;
  row.querySelector("button").onclick = () => row.remove();
  wrap.appendChild(row);
}
el("addContactRowBtn").onclick = () => addContactRow("", "");

function collectContacts(){
  return Array.from(el("contactsEditor").querySelectorAll(".contact-edit-row")).map(row => ({
    label: row.querySelector(".contact-label-input").value.trim(),
    value: row.querySelector(".contact-value-input").value.trim(),
  })).filter(c => c.label || c.value);
}

async function loadHelpSettingsIntoAdminForm(){
  try{
    const doc = await db.collection("settings").doc("help").get();
    const d = doc.exists ? doc.data() : {};
    el("helpContent").value = d.content || "";
    el("contactsEditor").innerHTML = "";
    (d.contacts && d.contacts.length ? d.contacts : [{ label: "", value: "" }]).forEach(c => addContactRow(c.label, c.value));
  } catch(e){
    console.error("loadHelpSettingsIntoAdminForm", e);
  }
}

el("helpSettingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = el("helpError");
  hide(errBox);
  const btn = el("helpSaveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try{
    await db.collection("settings").doc("help").set({
      content: el("helpContent").value,
      contacts: collectContacts(),
    }, { merge: true });
    toast("Help page saved");
  } catch(err){
    console.error(err);
    errBox.textContent = "Couldn't save — check your connection and try again.";
    show(errBox);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save help page";
  }
});
