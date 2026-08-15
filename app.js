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
let cart = loadCart();           // { [productId]: { id, name, price, imageUrl, qty } }
let pendingAfterAuth = null;      // fn to run right after a successful sign-in
let authMode = "signin";          // "signin" | "signup"
let selectedImageFile = null;
let activeOrderId = null;

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
  } else {
    show(el("storeView"));
    hide(el("adminView"));
    el("modeLabel").textContent = "Posters, printed for your walls";
  }

  if (user && pendingAfterAuth){
    const fn = pendingAfterAuth;
    pendingAfterAuth = null;
    closeAuthModal();
    fn();
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
  show(el("authOverlay"));
}
function closeAuthModal(){ hide(el("authOverlay")); pendingAfterAuth = null; }

el("authClose").onclick = closeAuthModal;
el("authOverlay").addEventListener("click", (e) => { if (e.target === el("authOverlay")) closeAuthModal(); });

el("authToggleBtn").onclick = () => {
  authMode = authMode === "signin" ? "signup" : "signin";
  syncAuthModeUI();
};

function syncAuthModeUI(){
  if (authMode === "signin"){
    el("authTitle").textContent = "Sign in";
    el("authSub").textContent = "Sign in to place an order.";
    el("authSubmitBtn").textContent = "Sign in";
    el("authToggleText").textContent = "New here?";
    el("authToggleBtn").textContent = "Create an account";
  } else {
    el("authTitle").textContent = "Create account";
    el("authSub").textContent = "One quick step before checkout.";
    el("authSubmitBtn").textContent = "Create account";
    el("authToggleText").textContent = "Already have an account?";
    el("authToggleBtn").textContent = "Sign in instead";
  }
}

el("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = el("authEmail").value.trim();
  const password = el("authPassword").value;
  const errBox = el("authError");
  hide(errBox);
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
/* Products — live listener + store rendering                             */
/* ---------------------------------------------------------------------- */
db.collection("products").orderBy("createdAt", "desc").onSnapshot((snap) => {
  products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderStore();
  renderAdminProducts();
}, (err) => {
  console.error("products listener", err);
});

function renderStore(){
  const grid = el("productGrid");
  const bestGrid = el("bestsellerGrid");
  grid.innerHTML = "";
  bestGrid.innerHTML = "";

  const bestsellers = products.filter(p => (p.tags || []).includes("bestseller"));

  // toggle bestseller section visibility
  const bestLabel = bestGrid.previousElementSibling;
  if (bestsellers.length === 0){
    hide(bestGrid); if (bestLabel) hide(bestLabel);
  } else {
    show(bestGrid); if (bestLabel) show(bestLabel);
    bestsellers.forEach(p => bestGrid.appendChild(productCard(p)));
  }

  if (products.length === 0){
    show(el("emptyNote"));
  } else {
    hide(el("emptyNote"));
    products.forEach(p => grid.appendChild(productCard(p)));
  }
}

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

function escapeHtml(s){
  return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

/* ---------------------------------------------------------------------- */
/* Product detail modal                                                    */
/* ---------------------------------------------------------------------- */
function openDetail(p){
  const oos = (p.tags || []).includes("out_of_stock");
  const best = (p.tags || []).includes("bestseller");
  el("detailContent").innerHTML = `
    <div class="thumb-wrap" style="aspect-ratio:3/4;">
      <img src="${p.imageUrl}" alt="${escapeHtml(p.name)}">
    </div>
    <div>
      ${best ? `<div class="fav-tag" style="position:static; display:inline-block; margin-bottom:10px;">★ Bestseller</div>` : ""}
      <h2 style="margin-top:0;">${escapeHtml(p.name)}</h2>
      <div class="price-row" style="font-size:20px; margin-bottom:14px;"><span class="price">${money(p.price)}</span></div>
      <p style="font-size:14px; line-height:1.6; color:var(--grey);">${escapeHtml(p.details || "No extra details for this print.")}</p>
      <button class="btn btn-solid" style="width:100%; margin-top:16px;" id="detailAddBtn" ${oos ? "disabled" : ""}>
        ${oos ? "Out of stock" : "Add to cart"}
      </button>
    </div>
  `;
  const btn = el("detailAddBtn");
  if (btn && !oos){
    btn.onclick = () => { addToCart(p); closeDetail(); };
  }
  show(el("detailOverlay"));
}
function closeDetail(){ hide(el("detailOverlay")); }
el("detailClose").onclick = closeDetail;
el("detailOverlay").addEventListener("click", (e) => { if (e.target === el("detailOverlay")) closeDetail(); });

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
  if (!currentUser){
    closeCart();
    openAuthModal(() => placeOrder());
    return;
  }
  placeOrder();
};

/* ---------------------------------------------------------------------- */
/* Checkout / order creation                                               */
/* ---------------------------------------------------------------------- */
async function placeOrder(){
  const err = el("cartError");
  hide(err);
  const items = Object.values(cart).map(i => ({
    productId: i.id, name: i.name, price: i.price, qty: i.qty,
  }));
  const total = cartTotal();
  const btn = el("placeOrderBtn");
  btn.disabled = true;
  btn.textContent = "Placing order…";
  try{
    const orderRef = await db.collection("orders").add({
      userId: currentUser.uid,
      userEmail: currentUser.email,
      items,
      total,
      status: "awaiting_verification",
      customerConfirmedPaid: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    activeOrderId = orderRef.id;
    cart = {};
    saveCart();
    updateCartBadge();
    closeCart();
    openCheckout(orderRef.id, total);
  } catch(e){
    console.error(e);
    err.textContent = "Couldn't place the order — please try again.";
    show(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Place order";
  }
}

function openCheckout(orderId, total){
  el("checkoutOrderId").textContent = "#" + orderId.slice(0, 6).toUpperCase();
  el("checkoutAmount").textContent = money(total);

  const holder = el("qrCanvasHolder");
  holder.innerHTML = "";
  const canvas = document.createElement("canvas");
  holder.appendChild(canvas);

  const upiUri = "upi://pay?" + [
    "pa=" + encodeURIComponent(UPI_CONFIG.upiId),
    "pn=" + encodeURIComponent(UPI_CONFIG.payeeName),
    "am=" + encodeURIComponent(total),
    "cu=INR",
    "tn=" + encodeURIComponent("Order " + orderId.slice(0, 6)),
  ].join("&");

  QRCode.toCanvas(canvas, upiUri, { width: 220, margin: 1 }, (err) => {
    if (err) console.error(err);
  });

  show(el("checkoutOverlay"));
}
function closeCheckout(){ hide(el("checkoutOverlay")); }
el("checkoutClose").onclick = closeCheckout;

el("confirmPaidBtn").onclick = async () => {
  if (!activeOrderId) { closeCheckout(); return; }
  const btn = el("confirmPaidBtn");
  btn.disabled = true;
  try{
    await db.collection("orders").doc(activeOrderId).update({ customerConfirmedPaid: true });
    toast("Thanks! We'll confirm your payment shortly.");
  } catch(e){
    console.error(e);
  } finally {
    btn.disabled = false;
    closeCheckout();
  }
};

/* ======================================================================= */
/* ADMIN — product management                                              */
/* ======================================================================= */
el("dropzone").addEventListener("click", () => el("productImage").click());
el("productImage").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedImageFile = file;
  const dz = el("dropzone");
  const reader = new FileReader();
  reader.onload = (ev) => {
    dz.classList.add("has-image");
    dz.innerHTML = `<img src="${ev.target.result}" alt="preview">`;
  };
  reader.readAsDataURL(file);
});

el("addProductForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = el("addProductError");
  hide(errBox);

  const name = el("productName").value.trim();
  const price = Number(el("productPrice").value);
  const details = el("productDetails").value.trim();

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
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    el("addProductForm").reset();
    selectedImageFile = null;
    const dz = el("dropzone");
    dz.classList.remove("has-image");
    dz.innerHTML = `<span>Click to choose an image</span>`;
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
      <td><button class="link-danger" data-act="delete">Delete</button></td>
    `;
    tr.querySelectorAll(".tag-pill").forEach(pill => {
      pill.onclick = () => toggleTag(p.id, pill.dataset.tag, tags.includes(pill.dataset.tag));
    });
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

/* ======================================================================= */
/* ADMIN — tabs + orders                                                   */
/* ======================================================================= */
document.querySelectorAll(".admin-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    if (target === "products"){
      show(el("adminProductsTab")); hide(el("adminOrdersTab"));
    } else {
      hide(el("adminProductsTab")); show(el("adminOrdersTab"));
    }
  });
});

let ordersUnsub = null;
function listenOrders(){
  if (ordersUnsub) return;
  ordersUnsub = db.collection("orders").orderBy("createdAt", "desc")
    .onSnapshot((snap) => {
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderOrders(orders);
    }, (err) => console.error("orders listener", err));
}

const STATUS_LABEL = {
  awaiting_verification: "Awaiting payment check",
  paid: "Payment verified",
  fulfilled: "Fulfilled",
  rejected: "Rejected",
};
const STATUS_CLASS = {
  awaiting_verification: "status-awaiting",
  paid: "status-paid",
  fulfilled: "status-fulfilled",
  rejected: "status-pending",
};

function renderOrders(orders){
  const wrap = el("ordersList");
  wrap.innerHTML = "";
  if (orders.length === 0){ show(el("ordersEmptyNote")); return; }
  hide(el("ordersEmptyNote"));

  orders.forEach(o => {
    const card = document.createElement("div");
    card.className = "order-card";
    const itemsStr = (o.items || []).map(i => `${i.name} ×${i.qty}`).join(", ");
    card.innerHTML = `
      <div class="order-head">
        <span>#${o.id.slice(0,6).toUpperCase()} · ${escapeHtml(o.userEmail || "")}</span>
        <span class="status-pill ${STATUS_CLASS[o.status] || ""}">${STATUS_LABEL[o.status] || o.status}</span>
      </div>
      <div class="order-items">${escapeHtml(itemsStr)}${o.customerConfirmedPaid ? " · buyer marked as paid" : ""}</div>
      <div style="font-family:var(--font-display); font-size:16px; margin-bottom:10px;">${money(o.total)}</div>
      <div class="row-actions" id="actions-${o.id}"></div>
    `;
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
      fulfillBtn.className = "btn btn-solid"; fulfillBtn.textContent = "Mark fulfilled";
      fulfillBtn.onclick = () => updateOrderStatus(o.id, "fulfilled");
      actions.appendChild(fulfillBtn);
    }
    wrap.appendChild(card);
  });
}

async function updateOrderStatus(orderId, status){
  try{
    await db.collection("orders").doc(orderId).update({ status });
    toast("Order updated");
  } catch(e){ console.error(e); toast("Couldn't update the order — try again."); }
}
