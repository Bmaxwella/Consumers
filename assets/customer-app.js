(function(global){
  'use strict';
  const U = global.OmniUtils;
  const DB = global.OmniDB;
  const UI = global.CustomerUI;
  const Cart = global.CustomerCart;
  const state = DB.state.cache;
  const maps = { market:null, delivery:null, profile:null };
  let deliveryDriverMarker = null;
  let deliveryDestinationMarker = null;
  let deliveryRoute = null;
  let location = null;
  let dropMode = false;
  let placingOrder = false;
  let currentUser = null;
  let renderTimer = null;
  let presenceTimer = null;
  let mapInteractionTimer = null;
  let liveUnsubscribers = [];
  const pendingRenders = new Set();
  const CUSTOMER_COLLECTIONS = ['publicVendors','products','orders','creditAccounts','vendorCreditSettings','customers','customerLocations','deliveryAssignments'];

  function customerId(){
    if(currentUser?.customerId) return currentUser.customerId;
    const id = currentUser?.userId || currentUser?.id || '';
    return id ? `customer_${id.replace(/^user_/,'')}` : '';
  }

  function customerProfile(){
    return rows('customers').find(row => row.id === customerId() || row.userId === (currentUser?.userId || currentUser?.id)) || {};
  }

  async function saveCustomerProfile(profile){
    const row = {...profile, id:customerId(), userId:currentUser?.userId || currentUser?.id || customerId(), active:true};
    if(location) { row.lat = location.lat; row.lng = location.lng; row.locationSource = location.source || 'manual'; }
    await DB.put('customers', row.id, row, {userId:row.userId || row.id});
    return row;
  }

  function renderAuthGate(){
    clearInterval(presenceTimer);
    presenceTimer = null;
    const app = document.getElementById('app');
    app.className = 'auth-root';
    app.innerHTML = `<main class="auth-screen"><section class="auth-card">
      <div class="auth-hero">
        <div class="brand-mark">OM</div>
        <div>
          <h1>OMNI Market</h1>
          <p>Shop approved local vendors, keep your orders synced, and use credit only when your vendor approves it.</p>
        </div>
        <div class="auth-stats">
          <span><b>Live</b> order updates</span>
          <span><b>Guest</b> ordering</span>
          <span><b>Credit</b> accounts</span>
        </div>
      </div>
      <div class="auth-form-card">
        <div class="auth-form-intro"><span class="eyebrow">Welcome</span><h2>Sign in or continue your way</h2><p>Use an account across devices, or shop immediately as a guest.</p></div>
        <div class="auth-tabs">
          <button class="btn primary active" data-auth-tab="login">Sign in</button>
          <button class="btn" data-auth-tab="signup">Create account</button>
          <button class="btn" data-auth-tab="guest">Guest</button>
        </div>
        <form id="signupPanel" class="auth-panel">
          <div class="form-grid">
            <div class="field"><label>Name</label><input id="suName" autocomplete="name" required></div>
            <div class="field"><label>Phone</label><input id="suPhone" inputmode="tel" autocomplete="tel" required></div>
            <div class="field"><label>Username</label><input id="suUser" autocomplete="username" required></div>
            <div class="field"><label>Password</label><input id="suPass" type="password" autocomplete="new-password" required></div>
          </div>
          <button class="btn primary">Create customer account</button>
        </form>
        <form id="loginPanel" class="auth-panel active">
          <div class="form-grid">
            <div class="field"><label>Username</label><input id="liUser" autocomplete="username" required></div>
            <div class="field"><label>Password</label><input id="liPass" type="password" autocomplete="current-password" required></div>
          </div>
          <button class="btn primary">Login</button>
        </form>
        <div id="guestPanel" class="auth-panel">
          <p class="muted">Continue without an account. Orders placed on this device can still be tracked here.</p>
          <button id="guestBtn" class="btn primary">Continue as guest</button>
        </div>
        <div class="relay-diagnostic"><span id="authRelayDot" class="dot"></span><div><b id="authRelayState">Connecting securely</b><small>Secure cloud service</small></div></div>
      </div>
    </section></main>`;
    UI.setStatus(DB.state.status);
    document.querySelectorAll('[data-auth-tab]').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('[data-auth-tab]').forEach(item => item.classList.toggle('active', item === btn));
      document.querySelectorAll('.auth-panel').forEach(panel => panel.classList.toggle('active', panel.id === `${btn.dataset.authTab}Panel`));
    });
    document.getElementById('signupPanel').onsubmit = async event => {
      event.preventDefault();
      await runAuth(async () => {
        const user = await global.OmniAuth.signUpCustomer({name:document.getElementById('suName').value.trim(), phone:document.getElementById('suPhone').value.trim(), username:document.getElementById('suUser').value.trim(), password:document.getElementById('suPass').value, customerId:customerId()});
        await saveCustomerProfile({name:document.getElementById('suName').value.trim(), phone:document.getElementById('suPhone').value.trim(), defaultAddress:customerProfile().defaultAddress || ''});
        return user;
      });
    };
    document.getElementById('loginPanel').onsubmit = async event => {
      event.preventDefault();
      await runAuth(() => global.OmniAuth.login(document.getElementById('liUser').value.trim(), document.getElementById('liPass').value));
    };
    document.getElementById('guestBtn').onclick = () => runAuth(() => global.OmniAuth.continueAsGuest(customerId()));
  }

  async function runAuth(action){
    try {
      currentUser = await action();
      startApp();
    } catch(error) {
      UI.toast(error.message || 'Could not continue','bad');
    }
  }

  function syncPresence(){
    if(!currentUser) return;
    DB.put('presence', currentUser.userId || currentUser.id, {
      id:currentUser.userId || currentUser.id,
      userId:currentUser.userId || currentUser.id,
      customerId:customerId(),
      username:currentUser.username || '',
      role:currentUser.role || 'guest',
      mode:'customer',
      view:UI.activeView?.() || 'market',
      online:true,
      updatedAt:Date.now()
    }, {userId:currentUser.userId || currentUser.id}).catch(() => {});
  }

  function startPresenceSync(){
    clearInterval(presenceTimer);
    syncPresence();
    presenceTimer = setInterval(syncPresence, 30000);
  }

  function isEditingField(){
    const el = document.activeElement;
    return el && ['INPUT','TEXTAREA','SELECT'].includes(el.tagName) && el.id !== 'search';
  }

  function isMapBusy(){
    const map = maps.market;
    const fullMap = document.getElementById('marketMapCard')?.classList.contains('map-fullscreen');
    return !!(dropMode || fullMap || map?._omniInteracting);
  }

  function viewUsesCollection(collection){
    const view = UI.activeView?.() || 'market';
    const dependencies = {
      market: new Set(['publicVendors','products']),
      cart: new Set(),
      orders: new Set(['orders','deliveryAssignments']),
      credit: new Set(['creditAccounts','vendorCreditSettings','publicVendors']),
      profile: new Set(['customers'])
    };
    return collection === 'search' || collection === 'deferred' || dependencies[view]?.has(collection);
  }

  function flushPendingRender(){
    if(!pendingRenders.size || isEditingField() || isMapBusy()) return;
    pendingRenders.clear();
    scheduleRender('deferred');
  }

  function captureViewFields(view){
    const container = document.getElementById(view);
    if(!container) return [];
    return [...container.querySelectorAll('input[id],select[id],textarea[id]')].map(field => ({id:field.id, value:field.value, checked:field.checked}));
  }

  function restoreViewFields(fields){
    fields.forEach(saved => {
      const field = document.getElementById(saved.id);
      if(!field) return;
      field.value = saved.value;
      if(field.type === 'checkbox' || field.type === 'radio') field.checked = saved.checked;
    });
  }

  function scheduleRender(collection){
    if(!currentUser || !document.getElementById('market')) return;
    if(collection === 'presence' || collection === 'events') return;
    if(!viewUsesCollection(collection)) return;
    if(isEditingField() || (UI.activeView?.() === 'market' && isMapBusy())) {
      pendingRenders.add(collection);
      return;
    }
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render(true);
    }, collection === 'search' ? 220 : 180);
  }

  function rows(name){ return (state[name] || []).filter(row => row.deleted !== true); }

  function parseProducts(vendor){
    return rows('products').filter(product => product.vendorId === vendor.id);
  }

  function productImages(product={}){
    const saved = U.parseJson(product.imagesJson || '[]', []);
    const images = [product.image || '', ...(Array.isArray(saved) ? saved : [])].filter(source => typeof source === 'string' && (/^https?:\/\//i.test(source) || /^data:image\//i.test(source)));
    return [...new Set(images)].slice(0,3);
  }

  function productAttributes(product={}){
    const saved = U.parseJson(product.attributesJson || '[]', []);
    return Array.isArray(saved) ? saved.filter(item => item && (item.name || item.value)).slice(0,6) : [];
  }

  function approvedVendor(v){
    return v && v.active !== false && v.suspended !== true && (
      (v.public === true && v.status === 'approved') ||
      v.adminApproved === true ||
      v.status === 'active'
    );
  }

  function sourceVendors(){
    return rows('publicVendors');
  }

  function visibleVendors(){
    return sourceVendors()
      .filter(approvedVendor)
      .sort((a,b) => {
        if(location && a.lat && a.lng && b.lat && b.lng) return U.distanceKm(location, a) - U.distanceKm(location, b);
        return Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
      });
  }

  function vendorById(id){ return sourceVendors().find(v => v.id === id); }
  function updateBadge(){ const el=document.getElementById('cartBadge'); if(el) el.textContent = Cart.lines.reduce((s,l)=>s+l.qty,0); }
  function imageFor(title){ return `https://placehold.co/480x320/e8f3ee/102033?text=${encodeURIComponent(title || 'OMNI')}`; }
  function distanceText(v){ return location && v.lat && v.lng ? `${U.distanceKm(location,{lat:+v.lat,lng:+v.lng}).toFixed(1)} km` : 'Latest'; }
  function locationText(){ return location ? `${location.source === 'gps' ? 'GPS' : 'Pinned'} location: ${Number(location.lat).toFixed(5)}, ${Number(location.lng).toFixed(5)}` : 'Showing latest approved vendors. Use GPS or drop a pin to sort nearby.'; }

  function vendorMatches(v, query){
    if(!query) return true;
    const products = parseProducts(v);
    return `${v.crName || ''} ${v.businessType || ''} ${v.whatsapp || ''}`.toLowerCase().includes(query)
      || products.some(p => `${p.name || ''} ${p.category || ''} ${p.description || ''} ${p.attributesJson || ''} ${p.sku || ''} ${p.barcode || ''}`.toLowerCase().includes(query));
  }

  function vendorIcon(v){
    const src = v.logo || v.shopfront || '';
    const label = U.esc(String(v.crName || 'V').slice(0,1).toUpperCase());
    return L.divIcon({
      className:'',
      iconSize:[40,40],
      iconAnchor:[20,40],
      popupAnchor:[0,-36],
      html:`<div class="vendor-map-icon">${src ? `<img src="${U.esc(src)}" alt="">` : label}</div>`
    });
  }

  function resetMarketMap(){
    if(!maps.market) return;
    try { maps.market.remove(); } catch {}
    maps.market = null;
  }

  function resetDeliveryMap(){
    if(!maps.delivery) return;
    try { maps.delivery.remove(); } catch {}
    maps.delivery=null; deliveryDriverMarker=null; deliveryDestinationMarker=null; deliveryRoute=null;
  }

  function ensureMap(){
    const mapEl = document.getElementById('marketMap');
    if(!mapEl || !global.L) return null;
    if(maps.market && maps.market.getContainer && maps.market.getContainer() === mapEl) { maps.market.invalidateSize(); return maps.market; }
    if(maps.market) resetMarketMap();
    L.Icon.Default.mergeOptions({
      iconRetinaUrl:'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      iconUrl:'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      shadowUrl:'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
    });
    maps.market = L.map(mapEl).setView([26.0667,50.5577], 11);
    maps.market._omniUserMoved = false;
    maps.market._omniAutoFramed = false;
    maps.market.on('zoomstart dragstart movestart', () => {
      maps.market._omniUserMoved = true;
      maps.market._omniInteracting = true;
      clearTimeout(mapInteractionTimer);
    });
    maps.market.on('zoomend dragend moveend', () => {
      clearTimeout(mapInteractionTimer);
      mapInteractionTimer = setTimeout(() => {
        if(maps.market) maps.market._omniInteracting = false;
        flushPendingRender();
      }, 700);
    });
    maps.market.on('click', event => {
      if(!dropMode) return;
      dropMode = false;
      setLocation({lat:event.latlng.lat, lng:event.latlng.lng, source:'pin'});
      UI.toast('Location pin dropped','ok');
      flushPendingRender();
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(maps.market);
    return maps.market;
  }

  function setLocation(next){
    location = next;
    if(maps.market) { maps.market._omniUserMoved = false; maps.market._omniAutoFramed = false; }
    if(UI.activeView?.() === 'market') renderMarket();
    ['checkoutLocationNote','profileLocationNote'].forEach(id => {
      const note = document.getElementById(id);
      if(note) note.textContent = locationText();
    });
    if(UI.activeView?.()==='profile') renderProfileLocationMap();
    if(currentUser) saveCustomerProfile(customerProfile()).catch(() => {});
  }

  function renderMarketMap(vendors){
    const mapEl = document.getElementById('marketMap');
    if(!mapEl) return;
    if(!global.L) {
      mapEl.innerHTML = '<div class="empty">Map library is still loading. Refresh if it does not appear.</div>';
      return;
    }
    const map = ensureMap();
    if(!map) return;
    const signature = JSON.stringify({
      location: location ? [Number(location.lat).toFixed(6), Number(location.lng).toFixed(6), location.source || ''] : null,
      vendors: vendors.filter(v => v.lat && v.lng).map(v => [v.id, Number(v.lat).toFixed(6), Number(v.lng).toFixed(6), v.logo || '', v.shopfront || ''])
    });
    if(map._omniMarkerSignature === signature) {
      setTimeout(() => map.invalidateSize(), 80);
      return;
    }
    map._omniMarkerSignature = signature;
    if(map._omniMarkers) map._omniMarkers.forEach(marker => map.removeLayer(marker));
    map._omniMarkers = [];
    if(location) {
      map._omniMarkers.push(L.circleMarker([location.lat, location.lng], {radius:8, color:'#1fc996', fillColor:'#1fc996', fillOpacity:.9}).addTo(map).bindPopup('Your location'));
    }
    vendors.filter(v => v.lat && v.lng).forEach(v => {
      const marker = L.marker([+v.lat, +v.lng], {icon:vendorIcon(v)}).addTo(map).bindPopup(`<b>${U.esc(v.crName || 'Vendor')}</b><br>${U.esc(v.businessType || '')}`);
      marker.on('click', () => renderVendorMenu(v.id));
      map._omniMarkers.push(marker);
    });
    if(!map._omniUserMoved && !map._omniAutoFramed) {
      if(map._omniMarkers.length > 1) map.fitBounds(L.featureGroup(map._omniMarkers).getBounds().pad(.2));
      else if(location) map.setView([location.lat, location.lng], 13);
      else if(vendors[0]?.lat && vendors[0]?.lng) map.setView([+vendors[0].lat, +vendors[0].lng], 12);
      map._omniAutoFramed = true;
    }
    setTimeout(() => map.invalidateSize(), 80);
  }

  function vendorDirectMatch(vendor,query){
    return !query || `${vendor.crName||''} ${vendor.businessType||''} ${vendor.whatsapp||''}`.toLowerCase().includes(query);
  }

  function matchingProducts(vendor,query){
    if(!query) return [];
    return parseProducts(vendor).filter(product=>product.active!==false&&`${product.name||''} ${product.category||''} ${product.description||''} ${product.attributesJson||''} ${product.sku||''} ${product.barcode||''}`.toLowerCase().includes(query));
  }

  function marketProductCard(result){
    const {product,vendor}=result, image=productImages(product)[0]||imageFor(product.name||'Product'), unavailable=product.stockMode==='track'&&Number(product.stockQty||0)<=0;
    return `<article class="card market-product-result"><img src="${U.esc(image)}" alt="${U.esc(product.name||'Product')}"><div><span class="product-category">${U.esc(product.category||'Product')}</span><h3>${U.esc(product.name)}</h3><p>${U.esc(vendor.crName||'Vendor')} · ${U.esc(distanceText(vendor))}</p><b>${U.money(product.price)}</b><div><button class="btn" data-open-vendor="${U.esc(vendor.id)}">View vendor</button><button class="btn primary" data-market-product="${U.esc(product.id)}" data-market-vendor="${U.esc(vendor.id)}" ${unavailable?'disabled':''}>${unavailable?'Out of stock':'Add'}</button></div></div></article>`;
  }

  function renderMarket(){
    const q = (document.getElementById('search')?.value || '').trim().toLowerCase();
    const allVendors = visibleVendors();
    const vendorResults = q ? allVendors.filter(vendor=>vendorDirectMatch(vendor,q)) : allVendors;
    const productResults = q ? allVendors.flatMap(vendor=>matchingProducts(vendor,q).map(product=>({vendor,product}))).sort((a,b)=>{const distanceA=location?U.distanceKm(location,a.vendor):Infinity,distanceB=location?U.distanceKm(location,b.vendor):Infinity;return distanceA-distanceB||String(a.product.name||'').localeCompare(String(b.product.name||''));}) : [];
    const resultVendorIds = new Set([...vendorResults.map(vendor=>vendor.id),...productResults.map(result=>result.vendor.id)]);
    const vendors = q ? allVendors.filter(vendor=>resultVendorIds.has(vendor.id)) : allVendors;
    const market = document.getElementById('market');
    if(!document.getElementById('marketMap')) {
      resetMarketMap();
      market.innerHTML = `
      <div class="toolbar">
        <button id="dropPinBtn" class="btn">Drop pin</button>
        <button id="clearLocationBtn" class="btn ghost" ${location ? '' : 'disabled'}>Clear location</button>
        <button id="fullMapBtn" class="btn ghost">Full screen map</button>
        <span id="locationNote" class="location-note"></span>
      </div>
      <div class="grid market-layout">
        <div id="marketMapCard" class="card pad map-card">
          <div class="head"><h2>Vendor Map</h2><span id="vendorCount" class="pill">0 vendors</span><div class="spacer"></div><button id="closeMapBtn" class="btn danger small map-close">Close</button></div>
          <div id="marketMap" class="market-map"></div>
        </div>
        <div class="card pad"><div class="head"><h2>Nearby List</h2></div><div id="vendorList" class="vendor-list"></div></div>
      </div>
      <div id="marketSearchResults"></div>
      <div id="marketVendorGrid" class="grid cols-3"></div>
      <div id="vendorMenu"></div>`;
      document.getElementById('dropPinBtn').onclick = event => {
        dropMode = !dropMode;
        event.currentTarget.textContent = dropMode ? 'Cancel pin' : 'Drop pin';
        UI.toast(dropMode ? 'Tap the map to drop your delivery location' : 'Pin placement cancelled', dropMode ? 'ok' : '');
        ensureMap();
        if(!dropMode) flushPendingRender();
      };
      document.getElementById('fullMapBtn').onclick = () => { document.getElementById('marketMapCard').classList.add('map-fullscreen'); setTimeout(() => maps.market?.invalidateSize(), 120); };
      document.getElementById('closeMapBtn').onclick = () => {
        document.getElementById('marketMapCard').classList.remove('map-fullscreen');
        setTimeout(() => { maps.market?.invalidateSize(); flushPendingRender(); }, 120);
      };
    }
    document.getElementById('clearLocationBtn').disabled = !location;
    document.getElementById('clearLocationBtn').onclick = () => { location = null; const profile={...customerProfile(),id:customerId(),userId:currentUser?.userId||currentUser?.id||customerId(),lat:0,lng:0,locationSource:''}; DB.put('customers',customerId(),profile,{userId:profile.userId}).catch(()=>{}); if(maps.market){ maps.market._omniAutoFramed = false; maps.market._omniUserMoved = false; } render(); };
    document.getElementById('locationNote').textContent = locationText();
    document.getElementById('vendorCount').textContent = `${vendors.length} vendor${vendors.length === 1 ? '' : 's'}`;
    document.getElementById('vendorList').innerHTML = vendors.length ? vendors.map(vendorRow).join('') : '<div class="empty">No approved vendors found.</div>';
    document.getElementById('marketSearchResults').innerHTML = q&&productResults.length?`<section class="market-result-section"><div class="head"><h2>Matching products & services</h2><span class="pill">${productResults.length}</span></div><div class="market-product-results">${productResults.map(marketProductCard).join('')}</div></section>`:'';
    document.getElementById('marketVendorGrid').innerHTML = `${q&&vendorResults.length?`<div class="market-result-heading"><h2>Matching vendors</h2><span class="pill">${vendorResults.length}</span></div>`:''}${vendorResults.map(vendorCard).join('') || (!productResults.length?emptyMarket(q):'')}`;
    document.querySelectorAll('[data-open-vendor]').forEach(btn => btn.onclick = () => renderVendorMenu(btn.dataset.openVendor));
    document.querySelectorAll('[data-market-product]').forEach(btn=>btn.onclick=()=>{const vendor=vendorById(btn.dataset.marketVendor),product=vendor&&parseProducts(vendor).find(item=>item.id===btn.dataset.marketProduct);if(product&&Cart.add(product,vendor)){UI.toast('Added to cart','ok');updateBadge();}});
    renderMarketMap(vendors);
  }

  function vendorCard(v){
    const img = v.shopfront || v.logo || imageFor(v.crName || 'Vendor');
    return `<article class="card vendor-tile"><img src="${U.esc(img)}" alt="${U.esc(v.crName || 'Vendor')}"><div class="body"><h3>${U.esc(v.crName || 'Vendor')}</h3><p class="muted">${U.esc(v.businessType || 'Vendor')} · ${U.esc(distanceText(v))}</p><span class="pill ok">Approved</span><button class="btn primary" data-open-vendor="${U.esc(v.id)}">View menu</button></div></article>`;
  }

  function vendorRow(v){
    return `<button class="mini-row" data-open-vendor="${U.esc(v.id)}" style="text-align:left"><img src="${U.esc(v.logo || v.shopfront || imageFor(v.crName || 'Vendor'))}" alt=""><span class="info"><h4>${U.esc(v.crName || 'Vendor')}</h4><p>${U.esc(v.businessType || '')} · ${U.esc(distanceText(v))}</p></span></button>`;
  }

  function emptyMarket(query){
    return `<div class="card empty" style="grid-column:1/-1"><h3>${query ? 'No matching vendors or products' : 'No approved vendors found yet'}</h3><p>${query ? 'Try another vendor, product, or service name.' : 'Approved public vendors will appear here automatically.'}</p></div>`;
  }

  function renderVendorMenu(vendorId){
    const vendor = vendorById(vendorId);
    const products = vendor ? parseProducts(vendor).filter(p => p.active !== false) : [];
    document.getElementById('vendorMenu').innerHTML = `<div class="card pad vendor-menu-panel"><div class="head"><h2>${U.esc(vendor?.crName || 'Menu')}</h2><span class="pill">${products.length} items</span><div class="spacer"></div><button class="btn ghost small" data-close-menu>Close</button></div><div class="product-grid">${products.map(product=>{
      const images=productImages(product); const attributes=productAttributes(product); const main=images[0]||imageFor(product.name||'Product'); const unavailable=product.stockMode==='track'&&Number(product.stockQty||0)<=0;
      return `<article class="card product customer-product"><div class="customer-product-media"><img class="customer-product-primary" src="${U.esc(main)}" alt="${U.esc(product.name||'Product')}">${images.length>1?`<div class="customer-product-thumbs">${images.slice(1).map(source=>`<img src="${U.esc(source)}" alt="">`).join('')}</div>`:''}${product.featured===true?'<span class="product-featured">Featured</span>':''}</div><div class="body"><span class="product-category">${U.esc(product.category||'General')}</span><h3>${U.esc(product.name)}</h3><p class="muted">${U.esc(product.description||'')}</p><div class="attribute-chips">${attributes.map(item=>`<span>${U.esc(item.name)}: ${U.esc(item.value)}</span>`).join('')}</div><div class="customer-product-price"><b>${U.money(product.price)}</b>${Number(product.compareAtPrice||0)>Number(product.price||0)?`<s>${U.money(product.compareAtPrice)}</s>`:''}<span>${U.esc(product.unit||'each')}</span></div><button class="btn primary" data-add="${U.esc(product.id)}" ${unavailable?'disabled':''}>${unavailable?'Out of stock':'Add to cart'}</button></div></article>`;
    }).join('') || '<div class="empty">No products yet.</div>'}</div></div>`;
    document.querySelector('[data-close-menu]').onclick = () => { document.getElementById('vendorMenu').innerHTML = ''; };
    document.querySelectorAll('[data-add]').forEach(btn => btn.onclick = () => {
      const product = products.find(p=>p.id===btn.dataset.add);
      if(product && Cart.add(product, vendor)) { UI.toast('Added to cart','ok'); updateBadge(); }
    });
    document.getElementById('vendorMenu').scrollIntoView({behavior:'smooth', block:'start'});
  }

  function renderCart(){
    const p = customerProfile();
    const payment = 'cash';
    document.getElementById('cart').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>Your Cart</h2><span class="pill">${Cart.lines.length} lines</span></div>${Cart.lines.map(line=>`<div class="cart-line"><span>${U.esc(line.name)} x ${line.qty}</span><button class="btn small danger" data-remove="${U.esc(line.productId)}">−</button><b>${U.money(line.price*line.qty)}</b></div>`).join('') || '<div class="empty">Cart is empty</div>'}<div class="total"><span>Total</span><span>${U.money(Cart.total())}</span></div></div><div class="card pad"><h2>Checkout</h2><div class="form"><div class="field"><label>Name</label><input id="coName" autocomplete="name" value="${U.esc(p.name || '')}"></div><div class="field"><label>Phone</label><input id="coPhone" inputmode="tel" autocomplete="tel" value="${U.esc(p.phone || '')}"></div><div class="field"><label>Address</label><textarea id="coAddress">${U.esc(p.defaultAddress || '')}</textarea></div><div id="checkoutLocationNote" class="location-note">${U.esc(locationText())}</div><div class="toolbar"><button id="checkoutGpsBtn" class="btn" type="button">Use GPS</button><button id="checkoutPinBtn" class="btn ghost" type="button">Drop pin on map</button></div><select id="coPayment" class="input"><option value="cash" ${payment==='cash'?'selected':''}>Cash</option><option value="benefit">Benefit</option><option value="credit">Credit</option></select><button id="placeOrderBtn" class="btn primary">Place order</button></div></div></div>`;
    document.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = () => { Cart.remove(btn.dataset.remove); updateBadge(); renderCart(); });
    document.getElementById('checkoutGpsBtn').onclick = locate;
    document.getElementById('checkoutPinBtn').onclick = () => { document.querySelector('[data-view="market"]').click(); setTimeout(() => document.getElementById('dropPinBtn')?.click(), 80); };
    document.getElementById('placeOrderBtn').onclick = placeOrder;
  }

  async function placeOrder(){
    if(placingOrder) return;
    if(!Cart.lines.length) return UI.toast('Cart is empty','bad');
    const profile = {id:customerId(), name:document.getElementById('coName').value.trim(), phone:document.getElementById('coPhone').value.trim(), defaultAddress:document.getElementById('coAddress').value.trim()};
    if(!profile.phone) return UI.toast('Phone is required','bad');
    if(!profile.defaultAddress && !location) return UI.toast('Add an address, use GPS, or drop a pin for delivery','bad');
    const paymentMethod = document.getElementById('coPayment').value;
    if(paymentMethod === 'credit') {
      const currentVendorId=Cart.lines[0].vendorId;
      const policy=rows('vendorCreditSettings').find(setting=>setting.vendorId===currentVendorId)||{enabled:true,maximumCreditLimit:0};
      const account = rows('creditAccounts').find(c => c.vendorId === currentVendorId && c.status === 'active' && c.adminApproved === true && (c.customerId === profile.id || c.phone === profile.phone));
      if(policy.enabled===false) return UI.toast('This vendor currently has customer credit disabled','bad');
      if(policy.allowDeliveryCredit===false) return UI.toast('This vendor does not allow credit for delivery orders','bad');
      if(!account) return UI.toast('Credit must be approved by this vendor before checkout','bad');
      const effectiveLimit=Number(policy.maximumCreditLimit||0)>0?Math.min(Number(account.creditLimit||0),Number(policy.maximumCreditLimit)):Number(account.creditLimit||0);
      if(Number(account.balance || 0) + Cart.total() > effectiveLimit) return UI.toast('This order exceeds your approved credit limit','bad');
    }
    placingOrder = true;
    const submit = document.getElementById('placeOrderBtn');
    if(submit) { submit.disabled = true; submit.textContent = 'Placing order...'; }
    try {
      await saveCustomerProfile(profile);
      const orderId = U.uid('order');
      const vendorId = Cart.lines[0].vendorId;
      const locationId = location ? U.uid('location') : '';
      const order = {id:orderId, vendorId, customerId:profile.id, customerName:profile.name || 'Guest', customerPhone:profile.phone, customerLocationId:locationId, customerAddress:profile.defaultAddress, customerLat:location?.lat || 0, customerLng:location?.lng || 0, status:'pending', paymentMethod, total:Cart.total(), source:'customer', createdAt:Date.now()};
      if(location) await DB.put('customerLocations', locationId, {id:locationId, customerId:profile.id, label:'Order location', address:profile.defaultAddress, lat:location.lat, lng:location.lng, source:location.source || 'pin'}, {userId:profile.id});
      await DB.put('orders', orderId, order, {userId:profile.id, vendorId});
      for(const line of Cart.lines) await DB.put('orderItems', U.uid('item'), {orderId, vendorId, productId:line.productId, nameSnapshot:line.name, priceSnapshot:line.price, qty:line.qty, total:line.price*line.qty}, {userId:profile.id, vendorId});
      await DB.event('customer_order_created','order',orderId,{vendorId, summary:`Customer order ${U.money(order.total)}`},{userId:profile.id, vendorId});
      Cart.clear(); updateBadge(); UI.toast('Order placed and synced','ok'); renderOrders();
      document.querySelector('[data-view="orders"]').click();
    } catch(error) {
      UI.toast(error.message || 'Order could not be saved','bad');
    } finally {
      placingOrder = false;
      if(submit?.isConnected) { submit.disabled = false; submit.textContent = 'Place order'; }
    }
  }

  function renderCustomerDeliveryMap(order,assignment){
    const element=document.getElementById('customerDeliveryMap');
    if(!element||!global.L||!order||!assignment)return;
    if(!maps.delivery||maps.delivery.getContainer()!==element){resetDeliveryMap();maps.delivery=L.map(element).setView([26.0667,50.5577],12);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(maps.delivery);maps.delivery._autoFramed=false;}
    const destination=Number(order.customerLat)&&Number(order.customerLng)?L.latLng(Number(order.customerLat),Number(order.customerLng)):null;
    const driver=Number(assignment.driverLat)&&Number(assignment.driverLng)?L.latLng(Number(assignment.driverLat),Number(assignment.driverLng)):null;
    if(destination){if(!deliveryDestinationMarker)deliveryDestinationMarker=L.marker(destination).addTo(maps.delivery).bindPopup('Delivery destination');else deliveryDestinationMarker.setLatLng(destination);}
    if(driver){if(!deliveryDriverMarker)deliveryDriverMarker=L.circleMarker(driver,{radius:10,color:'#102841',fillColor:'#1fc996',fillOpacity:1,weight:3}).addTo(maps.delivery).bindPopup(`${U.esc(assignment.driverName||'Driver')} · live location`);else deliveryDriverMarker.setLatLng(driver);}
    if(deliveryRoute){try{maps.delivery.removeLayer(deliveryRoute);}catch{}deliveryRoute=null;}
    if(driver&&destination)deliveryRoute=L.polyline([driver,destination],{color:'#2563eb',weight:5,opacity:.78,dashArray:'8 7'}).addTo(maps.delivery);
    if(!maps.delivery._autoFramed){if(driver&&destination)maps.delivery.fitBounds(L.latLngBounds([driver,destination]).pad(.2));else if(destination)maps.delivery.setView(destination,14);maps.delivery._autoFramed=true;}
    setTimeout(()=>maps.delivery?.invalidateSize(),80);
  }

  function activeCustomerDelivery(myOrders){
    const ids=new Set(myOrders.map(order=>order.id));
    return rows('deliveryAssignments').find(assignment=>ids.has(assignment.orderId)&&['accepted','picked_up'].includes(assignment.status))||null;
  }

  function renderOrders(){
    const myOrders = rows('orders').filter(o => o.customerId === customerId()).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
    const assignment=activeCustomerDelivery(myOrders),trackedOrder=assignment&&myOrders.find(order=>order.id===assignment.orderId);
    if(!assignment) resetDeliveryMap();
    document.getElementById('orders').innerHTML = `${assignment&&trackedOrder?`<section class="card pad customer-delivery-card"><div class="head"><div><span class="product-category">Live delivery</span><h2>${U.esc(assignment.driverName||'Your driver is on the way')}</h2><p class="muted">${assignment.driverPhone?`Driver phone: ${U.esc(assignment.driverPhone)} · `:''}${assignment.locationUpdatedAt?`Updated ${new Date(Number(assignment.locationUpdatedAt)).toLocaleTimeString()}`:'Waiting for the first location update'}</p></div><span class="pill ok">Out for delivery</span></div><div id="customerDeliveryMap" class="customer-delivery-map"></div></section>`:''}<div class="card pad"><div class="head"><h2>My Orders</h2></div>${UI.table(myOrders, [{key:'id',label:'Order'}, {key:'status',label:'Status'}, {key:'paymentMethod',label:'Payment'}, {key:'total',label:'Total',format:r=>U.money(r.total)}, {key:'customerAddress',label:'Address'}, {key:'createdAt',label:'Placed',format:r=>r.createdAt?new Date(Number(r.createdAt)).toLocaleString():'-'}])}</div>`;
    if(assignment&&trackedOrder) renderCustomerDeliveryMap(trackedOrder,assignment);
  }

  function renderCredit(){
    const profile = customerProfile();
    const accounts = rows('creditAccounts').filter(c => c.customerId === customerId() || (profile.phone && c.phone === profile.phone));
    const vendors = visibleVendors();
    document.getElementById('credit').innerHTML = `<div class="grid split"><div class="card pad"><div class="head"><h2>My Credit</h2></div>${UI.table(accounts, [{key:'vendorId',label:'Vendor',format:r=>vendorById(r.vendorId)?.crName || r.vendorId}, {key:'status',label:'Status'}, {key:'creditLimit',label:'Limit',format:r=>U.money(r.creditLimit)}, {key:'balance',label:'Balance',format:r=>U.money(r.balance)}])}</div><div class="card pad"><h2>Request credit</h2><div class="form"><div class="field"><label>Vendor</label><select id="creditVendor">${vendors.map(v=>`<option value="${U.esc(v.id)}">${U.esc(v.crName||v.id)}</option>`).join('')}</select></div><div class="field"><label>Phone</label><input id="creditPhone" value="${U.esc(profile.phone||'')}" inputmode="tel"></div><button id="requestCreditBtn" class="btn primary" ${vendors.length?'':'disabled'}>Send request</button></div><p class="muted">The selected vendor reviews your limit and payment terms.</p></div></div>`;
    document.getElementById('requestCreditBtn').onclick = async () => {
      const vendorId = document.getElementById('creditVendor').value;
      const phone = document.getElementById('creditPhone').value.trim();
      if(!vendorId || !phone) return UI.toast('Choose a vendor and add your phone','bad');
      if(accounts.some(a=>a.vendorId===vendorId && a.status!=='rejected')) return UI.toast('A credit account or request already exists for this vendor','bad');
      try {
        await DB.put('creditAccounts', U.uid('credit'), {vendorId, customerId:customerId(), customerName:profile.name||'', phone, status:'pending', adminApproved:false, creditLimit:0, balance:0}, {userId:customerId(), vendorId});
        UI.toast('Credit request sent','ok');
      } catch(error) { UI.toast(error.message || 'Request could not be saved','bad'); }
    };
  }

  function renderProfile(){
    const p = customerProfile();
    document.getElementById('profile').innerHTML = `<div class="card pad"><div class="head"><h2>Profile</h2><span class="pill">Optional account</span></div><div class="form-grid"><div class="field"><label>Name</label><input id="pName" value="${U.esc(p.name||'')}"></div><div class="field"><label>Phone</label><input id="pPhone" value="${U.esc(p.phone||'')}"></div><div class="field full"><label>Address</label><textarea id="pAddress">${U.esc(p.defaultAddress||'')}</textarea></div><div id="profileLocationNote" class="full location-note">${U.esc(locationText())}</div>${location?'<div id="profileLocationMap" class="profile-location-map full"></div>':''}<button id="profileGpsBtn" class="btn full" type="button">Use GPS location</button><button id="saveProfileBtn" class="btn primary full">Save profile</button></div></div>`;
    renderProfileLocationMap();
    document.getElementById('profileGpsBtn').onclick = locate;
    document.getElementById('saveProfileBtn').onclick = async () => {
      try {
        await saveCustomerProfile({name:document.getElementById('pName').value.trim(), phone:document.getElementById('pPhone').value.trim(), defaultAddress:document.getElementById('pAddress').value.trim()});
        UI.toast('Profile saved and synced','ok');
      } catch(error) { UI.toast(error.message || 'Profile could not be synced','bad'); }
    };
  }

  function renderProfileLocationMap(){
    const element=document.getElementById('profileLocationMap');
    if(!element||!location||!global.L)return;
    if(maps.profile){try{maps.profile.remove();}catch{}maps.profile=null;}
    maps.profile=L.map(element,{zoomControl:false,attributionControl:false,dragging:false,scrollWheelZoom:false,doubleClickZoom:false,touchZoom:false}).setView([location.lat,location.lng],15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(maps.profile);
    L.circleMarker([location.lat,location.lng],{radius:9,color:'#102841',fillColor:'#1fc996',fillOpacity:1,weight:3}).addTo(maps.profile);
    setTimeout(()=>maps.profile?.invalidateSize(),60);
  }

  function render(preserveFields=false){
    if(!currentUser || !document.getElementById('market')) return;
    updateBadge();
    const view = UI.activeView();
    const fields = preserveFields ? captureViewFields(view) : [];
    if(view==='market') renderMarket();
    if(view==='cart') renderCart();
    if(view==='orders') renderOrders();
    if(view==='credit') renderCredit();
    if(view==='profile') renderProfile();
    if(preserveFields) restoreViewFields(fields);
  }

  function locate(){
    if(!navigator.geolocation) return UI.toast('GPS unavailable','bad');
    navigator.geolocation.getCurrentPosition(pos => {
      setLocation({lat:pos.coords.latitude, lng:pos.coords.longitude, source:'gps'});
      UI.toast('Location updated','ok');
    }, err => UI.toast(err.message || 'Location denied','bad'), {enableHighAccuracy:true, timeout:12000, maximumAge:60000});
  }

  function startApp(){
    UI.shell(); UI.bindNav(render); DB.init(UI.setStatus);
    liveUnsubscribers.forEach(unsubscribe => unsubscribe());
    liveUnsubscribers = [];
    CUSTOMER_COLLECTIONS.forEach(name => { state[name] = []; });
    const scopeKey = customerId();
    const accepts = (name, row) => {
      if(name === 'publicVendors') return true;
      if(name === 'products') return true;
      if(name === 'orders') return row.customerId === customerId();
      if(name === 'creditAccounts') {
        const phone = customerProfile().phone || currentUser?.phone || '';
        return row.customerId === customerId() || !!(phone && row.phone === phone);
      }
      if(name === 'vendorCreditSettings') return true;
      if(name === 'customers') return row.id === customerId() || row.userId === (currentUser?.userId || currentUser?.id);
      if(name === 'customerLocations') return row.customerId === customerId();
      if(name === 'deliveryAssignments') return rows('orders').some(order=>order.id===row.orderId);
      return false;
    };
    CUSTOMER_COLLECTIONS.forEach(name => {
      const unsubscribe = DB.subscribe(name, (_rows, changed) => {
        if(name === 'customers' && changed && changed.deleted !== true && changed.id === customerId()) {
          location = Number(changed.lat) && Number(changed.lng) ? {lat:Number(changed.lat),lng:Number(changed.lng),source:changed.locationSource || 'database'} : null;
        }
        if(name === 'deliveryAssignments' && UI.activeView?.() === 'orders') {
          const myOrders=rows('orders').filter(order=>order.customerId===customerId()),assignment=activeCustomerDelivery(myOrders),order=assignment&&myOrders.find(item=>item.id===assignment.orderId);
          if(assignment&&order&&document.getElementById('customerDeliveryMap')) { renderCustomerDeliveryMap(order,assignment); return; }
        }
        scheduleRender(name);
      }, {includeDeleted:true, scopeKey, accept:row => accepts(name, row)});
      liveUnsubscribers.push(unsubscribe);
    });
    document.getElementById('search').oninput = () => scheduleRender('search');
    document.getElementById('app').onfocusout = () => setTimeout(flushPendingRender, 0);
    document.getElementById('locateBtn').onclick = locate;
    document.getElementById('logoutBtn').onclick = () => {
      global.OmniAuth.clearSession();
      currentUser = null;
      clearTimeout(renderTimer);
      clearInterval(presenceTimer);
      presenceTimer = null;
      liveUnsubscribers.forEach(unsubscribe => unsubscribe());
      liveUnsubscribers = [];
      pendingRenders.clear();
      resetMarketMap();
      resetDeliveryMap();
      if(maps.profile){try{maps.profile.remove();}catch{}maps.profile=null;}
      renderAuthGate();
    };
    const userMode = document.getElementById('userMode');
    if(userMode) userMode.textContent = currentUser?.role === 'customer' ? `Customer · ${currentUser.displayName || currentUser.username || ''}` : 'Guest mode';
    window.onresize = () => Object.values(maps).forEach(map => map?.invalidateSize());
    document.onkeydown = event => {
      if(event.key !== 'Escape') return;
      const card = document.getElementById('marketMapCard');
      if(card?.classList.contains('map-fullscreen')) card.classList.remove('map-fullscreen');
      if(dropMode) {
        dropMode = false;
        const button = document.getElementById('dropPinBtn');
        if(button) button.textContent = 'Drop pin';
      }
      maps.market?.invalidateSize();
      flushPendingRender();
    };
    startPresenceSync();
    render();
  }

  async function boot(){
    DB.init(UI.setStatus);
    const session = global.OmniAuth.savedSession();
    if(session?.userId) {
      try {
        const user = await DB.get('users', session.userId, 8000);
        if(user && user.deleted !== true && user.active !== false && ['customer','guest'].includes(user.role)) {
          currentUser = {...session, ...user, userId:user.id};
          global.OmniAuth.saveSession(currentUser);
          startApp();
          return;
        }
      } catch {}
      global.OmniAuth.clearSession();
    }
    currentUser = null;
    renderAuthGate();
  }

  boot();
})(window);
