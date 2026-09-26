(function(){
  "use strict";

  /* ================= constants ================= */
  var TAU_LAYER_URL = 'https://gisn.tel-aviv.gov.il/arcgis/rest/services/IView2/MapServer/787/query';
  // ערכי t_sug של פחי אריזות / כתומים. רשימה מדויקת עם IN ולא "LIKE ... OR LIKE" -
  // חומת האש של העירייה חוסמת את התבנית OR+LIKE (נראית כמו SQL injection) והבקשה נכשלת ב-CORS.
  var TAU_PACKAGING_TYPES = ['מתקן אריזות (מונף)', 'מתקן אריזות (סולארי)', 'מיכל לאיסוף אריזות', 'מיכלון / מיכל כתום (מרכז מחזור)'];
  var TAU_PACKAGING_WHERE = "t_sug IN (" + TAU_PACKAGING_TYPES.map(function(s){ return "'" + s + "'"; }).join(',') + ")";
  var DEFAULT_CENTER = {lat:32.0853, lon:34.7818}; // Tel Aviv-Yafo, כיכר רבין - נקודת ברירת מחדל בלבד
  var PROXIMITY_M = 80; // מרחק מקסימלי מותר בין המשתמש לפח כדי לאשר סריקה
  var STORAGE_KEY = 'ecobuddy_v2';

  var REWARDS = [
    {id:'coffee', name:'קפה חינם – קפה כתום', cost:50, emoji:'☕'},
    {id:'tree', name:'נטיעת עץ על שמך', cost:80, emoji:'🌳'},
    {id:'discount', name:'10% הנחה בסופר האורגני', cost:120, emoji:'🥕'},
    {id:'movie', name:'כרטיס קולנוע מוזל', cost:300, emoji:'🎬'}
  ];
  var FRIENDS = [
    {name:'נועה', points:410}, {name:'איתי', points:365}, {name:'שירה', points:298},
    {name:'דניאל', points:150}, {name:'מאיה', points:95}
  ];
  var FOCUS_LABEL = {home:'מפה 📍', rewards:'תגמולים 🎁', leaderboard:'לוח מובילים 🏆', profile:'הפרופיל שלך'};
  var FALLBACK_NUDGES = {
    home:['פח כתום מחכה לך רק כמה צעדים מפה — זה הרגע למחזר את הבקבוק! ♻️','רואה שאתה עוקב אחרי המפה — יש נקודת מחזור קרובה במיוחד עכשיו.'],
    rewards:['עוד קצת ואתה בקפה חינם ☕ כל בקבוק מקרב אותך לתגמול הבא.','שווה למחזר עוד בקבוק אחד — אתה קרוב לתגמול הבא ברשימה.'],
    leaderboard:['נועה קצת לפניך בטבלה… בקבוק אחד יכול לצמצם את הפער 💪','אתה במגמת עלייה בלוח המובילים — תמשיך ככה ותעקוף את הבא בתור.'],
    profile:['הרצף שלך נראה מעולה — אל תשבור אותו היום 🔥','כל בקבוק סופר. אתה כבר בדרך לסמל הבא באוסף שלך.']
  };
  var BADGES = [
    {id:'first', emoji:'♻️', title:'הבקבוק הראשון', on:function(){ return state.totalBottles >= 1; }},
    {id:'ten', emoji:'🧺', title:'אספן מתחיל (10)', on:function(){ return state.totalBottles >= 10; }},
    {id:'streak3', emoji:'🔥', title:'רצף ירוק (3 ימים)', on:function(){ return state.streak >= 3; }},
    {id:'streak7', emoji:'🌟', title:'שבוע מושלם (7 ימים)', on:function(){ return state.streak >= 7; }},
    {id:'twentyfive', emoji:'🏅', title:'אלוף המחזור (25)', on:function(){ return state.totalBottles >= 25; }},
    {id:'reward', emoji:'🎁', title:'תגמול ראשון', on:function(){ return state.redeemedCount >= 1; }}
  ];

  /* ================= state ================= */
  function todayStr(){ return fmtDate(new Date()); }
  function fmtDate(d){ return d.toISOString().slice(0,10); }
  function addDays(dateStr, delta){ var d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+delta); return fmtDate(d); }

  function defaultState(){
    return {
      points:0, totalBottles:0, streak:0, lastRecycleDate:null, recycleLog:[],
      redeemedCount:0, tabVisits:{home:1, rewards:0, leaderboard:0, profile:0},
      customBins:[], settings:{apiKey:'', model:'claude-haiku-4-5-20251001', useAI:false}
    };
  }
  function loadState(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return defaultState();
      var parsed = JSON.parse(raw);
      var def = defaultState();
      return Object.assign(def, parsed, {
        tabVisits: Object.assign(def.tabVisits, parsed.tabVisits || {}),
        recycleLog: parsed.recycleLog || def.recycleLog,
        customBins: parsed.customBins || def.customBins,
        settings: Object.assign(def.settings, parsed.settings || {})
      });
    }catch(e){ return defaultState(); }
  }
  function saveState(){ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){} }
  var state = loadState();

  /* ================= helpers ================= */
  function $(sel, root){ return (root||document).querySelector(sel); }
  function $all(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }
  function el(tag, cls, html){ var e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; }
  function escapeHtml(str){ return String(str).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function haversine(lat1,lon1,lat2,lon2){
    var R=6371000, toRad=function(d){return d*Math.PI/180;};
    var dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
    var a=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  function fmtDist(m){ return m < 1000 ? Math.round(m)+' מ׳' : (m/1000).toFixed(1)+' ק"מ'; }

  var toastTimer = null;
  function showToast(msg){
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.hidden = true; }, 2800);
  }

  function topFocusTab(){
    var v = state.tabVisits, best='home', max=-1;
    ['home','rewards','leaderboard','profile'].forEach(function(k){ if((v[k]||0) > max){ max=v[k]||0; best=k; } });
    return best;
  }

  /* ================= geolocation ================= */
  var userPos = null; // {lat, lon, accuracy}
  var hasCenteredOnUser = false;

  function setLocationStatus(status){
    var b = $('#loc-banner'), t = $('#loc-banner-text'), retry = $('#loc-retry');
    b.classList.remove('ok','warn');
    retry.hidden = true;
    if(status === 'locating'){ t.textContent = 'מאתר מיקום…'; }
    else if(status === 'active'){ b.classList.add('ok'); t.textContent = 'המיקום שלך פעיל — המפה מציגה מרחק אמיתי'; }
    else if(status === 'denied'){ b.classList.add('warn'); t.textContent = 'אין הרשאת מיקום — מציג ברירת מחדל: תל אביב-יפו'; retry.hidden = false; }
    else if(status === 'unsupported'){ b.classList.add('warn'); t.textContent = 'הדפדפן לא תומך במיקום — מציג ברירת מחדל'; }
  }

  function startGeolocation(){
    if(!('geolocation' in navigator)){ setLocationStatus('unsupported'); loadBinsFor(DEFAULT_CENTER, true); return; }
    setLocationStatus('locating');
    navigator.geolocation.watchPosition(function(pos){
      userPos = {lat:pos.coords.latitude, lon:pos.coords.longitude, accuracy:pos.coords.accuracy};
      setLocationStatus('active');
      updateUserMarker();
      loadBinsFor(userPos, false);
    }, function(){
      setLocationStatus('denied');
      loadBinsFor(DEFAULT_CENTER, true);
    }, {enableHighAccuracy:true, maximumAge:15000, timeout:12000});
  }
  $('#loc-retry').addEventListener('click', startGeolocation);

  /* ================= bins data (Tel Aviv open data) ================= */
  var tauBins = [];
  var tauFetchFailed = false;
  var lastFetchCenter = null, lastFetchTime = 0;

  async function fetchTauBins(lat, lon, radiusM){
    var dLat = radiusM/111320;
    var dLon = radiusM/(111320*Math.cos(lat*Math.PI/180));
    var geometry = {xmin:lon-dLon, ymin:lat-dLat, xmax:lon+dLon, ymax:lat+dLat, spatialReference:{wkid:4326}};
    var params = new URLSearchParams({
      where: TAU_PACKAGING_WHERE,
      outFields:'oid,shem_rechov,ms_bait,t_sug,ms_mechalim,UniqueId',
      geometry: JSON.stringify(geometry),
      geometryType:'esriGeometryEnvelope', inSR:'4326', spatialRel:'esriSpatialRelIntersects',
      returnGeometry:'true', f:'geojson', resultRecordCount:'500'
    });
    var res = await fetch(TAU_LAYER_URL + '?' + params.toString());
    if(!res.ok) throw new Error('tau-http-'+res.status);
    var gj = await res.json();
    if(gj.error) throw new Error('tau-api-error');
    return (gj.features || []).filter(function(f){ return f.geometry && f.geometry.coordinates; }).map(function(f){
      var p = f.properties || {};
      return {
        id: 'tau-' + (p.UniqueId || p.oid),
        name: (p.shem_rechov || 'רחוב לא ידוע') + (p.ms_bait ? ' ' + p.ms_bait : ''),
        type: p.t_sug || 'מתקן אריזות',
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        source:'tau'
      };
    });
  }

  async function loadBinsFor(center, isFallback){
    var now = Date.now();
    if(lastFetchCenter && haversine(lastFetchCenter.lat,lastFetchCenter.lon,center.lat,center.lon) < 150 && (now-lastFetchTime) < 20000){
      renderAll(); return;
    }
    lastFetchCenter = {lat:center.lat, lon:center.lon};
    lastFetchTime = now;
    try{
      var bins = await fetchTauBins(center.lat, center.lon, isFallback ? 2500 : 1200);
      if(bins.length === 0){ bins = await fetchTauBins(center.lat, center.lon, 3500); }
      tauBins = bins; tauFetchFailed = false;
    }catch(e){ tauFetchFailed = true; }
    renderAll();
  }

  function getAllBins(){ return tauBins.concat(state.customBins || []); }
  function findBinById(id){ return getAllBins().find(function(b){ return b.id === id; }); }
  function currentPosOrDefault(){ return userPos || DEFAULT_CENTER; }
  function sortedBinsByDistance(){
    var pos = currentPosOrDefault();
    return getAllBins().map(function(b){
      return Object.assign({}, b, {dist: haversine(pos.lat, pos.lon, b.lat, b.lon)});
    }).sort(function(a,b){ return a.dist - b.dist; });
  }

  /* ================= leaflet map ================= */
  var map, userMarker, binsLayer;
  function initMap(){
    map = L.map('leaflet-map', {zoomControl:false, attributionControl:true}).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lon], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    binsLayer = L.layerGroup().addTo(map);
  }
  function updateUserMarker(){
    if(!userPos) return;
    var ll = [userPos.lat, userPos.lon];
    if(!userMarker){
      var icon = L.divIcon({className:'', html:'<div class="you-icon"></div>', iconSize:[16,16], iconAnchor:[8,8]});
      userMarker = L.marker(ll, {icon:icon, zIndexOffset:1000}).addTo(map);
    } else {
      userMarker.setLatLng(ll);
    }
    if(!hasCenteredOnUser){ map.setView(ll, 16); hasCenteredOnUser = true; }
  }
  function binIcon(isCustom){
    var color = isCustom ? 'var(--primary)' : 'var(--accent)';
    return L.divIcon({
      className:'bin-icon' + (isCustom ? ' custom' : ''),
      html:'<svg viewBox="0 0 24 24" fill="currentColor" stroke="white" stroke-width="1"><path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12Z"/></svg>',
      iconSize:[26,26], iconAnchor:[13,26]
    });
  }
  function renderBinsOnMap(bins){
    binsLayer.clearLayers();
    bins.forEach(function(b){
      var marker = L.marker([b.lat,b.lon], {icon: binIcon(b.source==='custom')});
      var distTxt = b.dist != null ? fmtDist(b.dist) : '';
      var gmaps = 'https://www.google.com/maps/dir/?api=1&destination=' + b.lat + ',' + b.lon;
      var html = '<div class="popup-title">' + escapeHtml(b.name) + '</div>' +
        '<div class="popup-sub">' + escapeHtml(b.type || '') + (distTxt ? ' · ' + distTxt : '') + '</div>' +
        '<div class="popup-actions">' +
        '<a href="' + gmaps + '" target="_blank" rel="noopener">נווט</a>' +
        '<button data-sticker-id="' + escapeHtml(b.id) + '">מדבקת QR</button>' +
        '</div>';
      marker.bindPopup(html);
      marker.on('popupopen', function(e){
        var btn = e.popup.getElement().querySelector('[data-sticker-id]');
        if(btn) btn.addEventListener('click', function(){ openSticker(b.id); });
      });
      marker.addTo(binsLayer);
    });
  }

  /* ================= render: top bar ================= */
  function renderTop(){ $('#topbar-points').textContent = state.points; $('#topbar-streak').textContent = state.streak; }

  /* ================= render: home ================= */
  var WEEKDAY_HE = ['יום ראשון','יום שני','יום שלישי','יום רביעי','יום חמישי','יום שישי','שבת'];
  function renderHome(){
    var now = new Date();
    var h = now.getHours();
    var greet = h < 5 ? 'לילה טוב' : h < 12 ? 'בוקר טוב' : h < 18 ? 'צהריים טובים' : 'ערב טוב';
    $('#home-greeting').textContent = greet + ', שחף';
    $('#home-date').textContent = WEEKDAY_HE[now.getDay()];

    var list = sortedBinsByDistance();
    renderBinsOnMap(list);
    if(userPos) updateUserMarker();

    var nearestCard = $('#nearest-card'), noBins = $('#no-bins-banner');
    if(list.length === 0){
      nearestCard.hidden = true; noBins.hidden = false;
    } else {
      noBins.hidden = true; nearestCard.hidden = false;
      $('#nearest-name').textContent = list[0].name;
      $('#nearest-dist').textContent = fmtDist(list[0].dist);
    }

    var rowsWrap = $('#points-list');
    rowsWrap.innerHTML = '';
    list.slice(1, 6).forEach(function(p){
      var row = el('div', 'point-row' + (p.source==='custom' ? ' custom' : ''));
      row.innerHTML =
        '<div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/></svg></div>' +
        '<div class="meta"><div class="name">'+escapeHtml(p.name)+'</div><div class="dist">'+fmtDist(p.dist)+'</div></div>';
      var actions = el('div','row-actions');
      var stickerBtn = el('button','icon-btn-sm','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>');
      stickerBtn.addEventListener('click', function(){ openSticker(p.id); });
      actions.appendChild(stickerBtn);
      row.appendChild(actions);
      rowsWrap.appendChild(row);
    });

    if(tauFetchFailed && list.length === 0){
      showToast('לא הצלחנו לטעון את מאגר הנתונים הפתוח של תל אביב כרגע. נסה שוב מאוחר יותר.');
    }
  }

  /* ================= render: rewards ================= */
  function renderRewards(){
    $('#rewards-points').textContent = state.points;
    var list = $('#rewards-list'); list.innerHTML = '';
    REWARDS.forEach(function(r){
      var afford = state.points >= r.cost;
      var card = el('div', 'reward-card');
      card.innerHTML = '<div class="emoji">'+r.emoji+'</div><div class="meta"><div class="name">'+r.name+'</div><div class="cost">'+r.cost+' נקודות</div></div>';
      var btn = el('button', 'btn btn-sm ' + (afford ? 'btn-primary' : 'btn-ghost'), 'מימוש');
      btn.disabled = !afford;
      btn.addEventListener('click', function(){
        if(state.points < r.cost) return;
        state.points -= r.cost; state.redeemedCount++;
        saveState(); renderAll();
        showToast('מומש: ' + r.name + ' ' + r.emoji);
      });
      card.appendChild(btn); list.appendChild(card);
    });
  }

  /* ================= render: leaderboard ================= */
  function renderLeaderboard(){
    var rows = FRIENDS.map(function(f){ return {name:f.name, points:f.points, me:false}; });
    rows.push({name:'אתה', points:state.points, me:true});
    rows.sort(function(a,b){ return b.points - a.points; });
    var list = $('#lb-list'); list.innerHTML = '';
    rows.forEach(function(r,i){
      var row = el('div', 'lb-row' + (r.me ? ' me' : ''));
      row.innerHTML = '<div class="lb-rank">'+(i+1)+'</div><div class="lb-avatar">'+r.name.charAt(0)+'</div>' +
        '<div class="lb-name">'+r.name+'</div><div class="lb-points num">'+r.points+'</div>';
      list.appendChild(row);
    });
    var myIndex = rows.findIndex(function(r){ return r.me; });
    var note = $('#lb-note');
    if(myIndex === 0){ note.textContent = 'אתה במקום הראשון! תמשיך למחזר כדי לשמור על ההובלה 🏆'; }
    else{
      var ahead = rows[myIndex-1], gap = ahead.points - state.points, bottles = Math.max(1, Math.ceil(gap/10));
      note.textContent = 'אתה במקום ' + (myIndex+1) + '. עוד ' + bottles + ' בקבוקים בערך ותעקוף את ' + ahead.name + '.';
    }
  }

  /* ================= render: profile ================= */
  function renderProfile(){
    $('#p-points').textContent = state.points;
    $('#p-bottles').textContent = state.totalBottles;
    $('#p-streak').textContent = state.streak;

    var cal = $('#cal'); cal.innerHTML = '';
    for(var i=6;i>=0;i--){
      var day = addDays(todayStr(), -i);
      var d = new Date(day+'T00:00:00');
      var done = state.recycleLog.indexOf(day) !== -1;
      var wrap = el('div','cal-day');
      wrap.innerHTML = '<div class="cal-dot'+(done?' done':'')+'">'+(done?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L19 7"/></svg>':'')+'</div>' +
        '<div class="d">'+['א','ב','ג','ד','ה','ו','ש'][d.getDay()]+'</div>';
      cal.appendChild(wrap);
    }

    var badgesEl = $('#badges'); badgesEl.innerHTML = '';
    BADGES.forEach(function(b){
      var on = b.on();
      var card = el('div', 'badge'+(on?' on':''));
      card.innerHTML = '<div class="ic">'+b.emoji+'</div><div class="t">'+b.title+'</div>';
      badgesEl.appendChild(card);
    });

    var cbList = $('#custom-bins-list'); cbList.innerHTML = '';
    (state.customBins||[]).forEach(function(b){
      var row = el('div','point-row custom');
      row.innerHTML = '<div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/></svg></div>' +
        '<div class="meta"><div class="name">'+escapeHtml(b.name)+'</div><div class="dist">'+b.lat.toFixed(4)+', '+b.lon.toFixed(4)+'</div></div>';
      var actions = el('div','row-actions');
      var stickerBtn = el('button','icon-btn-sm','QR');
      stickerBtn.style.fontSize='10px'; stickerBtn.style.fontWeight='800';
      stickerBtn.addEventListener('click', function(){ openSticker(b.id); });
      var delBtn = el('button','icon-btn-sm','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M19 5 5 19"/></svg>');
      delBtn.addEventListener('click', function(){
        state.customBins = state.customBins.filter(function(x){ return x.id !== b.id; });
        saveState(); renderAll(); showToast('הנקודה הוסרה');
      });
      actions.appendChild(stickerBtn); actions.appendChild(delBtn);
      row.appendChild(actions);
      cbList.appendChild(row);
    });

    $('#settings-api-key').value = state.settings.apiKey || '';
    $('#settings-model').value = state.settings.model || 'claude-haiku-4-5-20251001';
    $('#settings-use-ai').checked = !!state.settings.useAI;
  }

  function renderAll(){ renderTop(); renderHome(); renderRewards(); renderLeaderboard(); renderProfile(); }

  /* ================= tabs ================= */
  function setTab(tab){
    $all('.screen').forEach(function(s){ s.classList.remove('active'); });
    $('#screen-' + tab).classList.add('active');
    $all('.nav-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.tab === tab); });
    state.tabVisits[tab] = (state.tabVisits[tab] || 0) + 1;
    saveState();
    if(tab === 'home' && map){ setTimeout(function(){ map.invalidateSize(); }, 50); }
  }
  $all('.nav-btn').forEach(function(btn){ btn.addEventListener('click', function(){ setTab(btn.dataset.tab); }); });

  /* ================= custom bins ================= */
  $('#cb-use-location').addEventListener('click', function(){
    if(!userPos){ showToast('עדיין אין מיקום זמין'); return; }
    $('#cb-lat').value = userPos.lat.toFixed(6);
    $('#cb-lon').value = userPos.lon.toFixed(6);
  });
  $('#cb-add').addEventListener('click', function(){
    var name = $('#cb-name').value.trim();
    var lat = parseFloat($('#cb-lat').value);
    var lon = parseFloat($('#cb-lon').value);
    if(!name){ showToast('צריך שם לנקודה'); return; }
    if(isNaN(lat) || isNaN(lon)){ showToast('קואורדינטות לא תקינות'); return; }
    state.customBins.push({id:'custom-'+Date.now(), name:name, lat:lat, lon:lon, source:'custom', type:'נקודה שהוספת ידנית'});
    saveState();
    $('#cb-name').value=''; $('#cb-lat').value=''; $('#cb-lon').value='';
    renderAll(); showToast('הנקודה נוספה ✓');
  });

  /* ================= settings ================= */
  $('#settings-save').addEventListener('click', function(){
    state.settings.apiKey = $('#settings-api-key').value.trim();
    state.settings.model = $('#settings-model').value.trim() || 'claude-haiku-4-5-20251001';
    state.settings.useAI = $('#settings-use-ai').checked;
    saveState();
    showToast('ההגדרות נשמרו');
  });

  /* ================= reset ================= */
  $('#reset-btn').addEventListener('click', function(){
    var keepSettings = state.settings, keepCustom = state.customBins;
    state = defaultState();
    state.settings = keepSettings; state.customBins = keepCustom;
    saveState(); renderAll();
    showToast('נתוני הדמו אופסו');
  });

  /* ================= scan (real camera + jsQR) ================= */
  var scanOverlay = $('#scan-overlay');
  var scanVideo = $('#scan-video');
  var scanFrame = $('#scan-frame');
  var scanMsgEl = $('#scan-msg');
  var scanSubEl = $('#scan-sub');
  var scanOverlayMsg = $('#scan-overlay-msg');
  var scanCanvas = document.createElement('canvas');
  var scanCtx = scanCanvas.getContext('2d', {willReadFrequently:true});
  var mediaStream = null;
  var scanning = false;

  function resetScanUI(){
    scanFrame.classList.remove('success','error');
    scanOverlayMsg.hidden = true; scanOverlayMsg.innerHTML='';
    scanVideo.hidden = false;
    $('#scan-line').hidden = false;
    scanMsgEl.textContent = 'כוון את המצלמה לקוד ה-QR שעל הפח';
    scanSubEl.textContent = 'המערכת תבדוק גם שאתה בקרבת הפח (עד ' + PROXIMITY_M + ' מ׳)';
  }

  async function openScan(){
    scanOverlay.hidden = false;
    resetScanUI();
    scanMsgEl.textContent = 'מבקש הרשאת מצלמה…';
    try{
      mediaStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}, audio:false});
      scanVideo.srcObject = mediaStream;
      await scanVideo.play();
      scanning = true;
      requestAnimationFrame(tick);
      scanMsgEl.textContent = 'כוון את המצלמה לקוד ה-QR שעל הפח';
    }catch(err){
      scanVideo.hidden = true;
      $('#scan-line').hidden = true;
      scanFrame.classList.add('error');
      scanOverlayMsg.hidden = false;
      scanOverlayMsg.innerHTML = '<svg class="xmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M19 5 5 19"/></svg><div>אין גישה למצלמה</div>';
      scanMsgEl.textContent = 'צריך לאשר הרשאת מצלמה בדפדפן';
      scanSubEl.textContent = 'אפשר להשתמש בכפתור ההדגמה למטה בינתיים';
    }
  }
  function stopStream(){
    if(mediaStream){ mediaStream.getTracks().forEach(function(t){ t.stop(); }); mediaStream = null; }
    scanning = false;
  }
  function closeScan(){ scanOverlay.hidden = true; stopStream(); }

  function tick(){
    if(!scanning) return;
    if(scanVideo.readyState === scanVideo.HAVE_ENOUGH_DATA && scanVideo.videoWidth){
      scanCanvas.width = scanVideo.videoWidth; scanCanvas.height = scanVideo.videoHeight;
      scanCtx.drawImage(scanVideo, 0, 0, scanCanvas.width, scanCanvas.height);
      var imageData = scanCtx.getImageData(0,0,scanCanvas.width, scanCanvas.height);
      var code = (typeof jsQR === 'function') ? jsQR(imageData.data, imageData.width, imageData.height, {inversionAttempts:'dontInvert'}) : null;
      if(code && code.data){ handleDecoded(code.data); return; }
    }
    requestAnimationFrame(tick);
  }

  function handleDecoded(text){
    scanning = false;
    var m = /^ecobuddy:(.+)$/.exec(text.trim());
    if(!m){ showScanError('קוד לא מוכר. ודא שזו מדבקת EcoBuddy תקנית.', true); return; }
    var bin = findBinById(m[1]);
    if(!bin){ showScanError('לא מצאנו את הפח הזה במאגר הנוכחי.', true); return; }
    if(userPos){
      var d = haversine(userPos.lat, userPos.lon, bin.lat, bin.lon);
      if(d > PROXIMITY_M){ showScanError('נראה שאתה במרחק ' + fmtDist(d) + ' מהפח (' + bin.name + '). התקרב ונסה שוב.', true); return; }
      finishScanSuccess(bin, true);
    } else {
      finishScanSuccess(bin, false);
    }
  }
  function showScanError(msg, allowRetry){
    stopStream();
    scanVideo.hidden = true; $('#scan-line').hidden = true;
    scanFrame.classList.add('error');
    scanOverlayMsg.hidden = false;
    scanOverlayMsg.innerHTML = '<svg class="xmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M19 5 5 19"/></svg>';
    scanMsgEl.textContent = msg;
    scanSubEl.textContent = allowRetry ? 'אפשר לסגור ולנסות שוב' : '';
  }
  function finishScanSuccess(bin, verified){
    stopStream();
    var today = todayStr();
    var wasYesterday = state.lastRecycleDate === addDays(today, -1);
    var alreadyToday = state.lastRecycleDate === today;
    var bonus = 0;
    if(!alreadyToday){
      state.streak = wasYesterday ? state.streak + 1 : 1;
      state.lastRecycleDate = today;
      if(state.recycleLog.indexOf(today) === -1) state.recycleLog.push(today);
      if(state.recycleLog.length > 60) state.recycleLog = state.recycleLog.slice(-60);
      if(state.streak >= 3) bonus = 5;
    }
    var earned = 10 + bonus;
    state.points += earned; state.totalBottles += 1;
    saveState(); renderAll();

    scanFrame.classList.remove('error'); scanFrame.classList.add('success');
    scanVideo.hidden = true; $('#scan-line').hidden = true;
    scanOverlayMsg.hidden = false;
    scanOverlayMsg.innerHTML = '<svg class="checkmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L19 7"/></svg><div class="earn">+' + earned + '</div>';
    scanMsgEl.textContent = 'מוחזר בהצלחה ב-' + bin.name;
    scanSubEl.textContent = verified ? 'המרחק אומת מול המיקום שלך ♻️' : 'לא אומת מרחק (אין הרשאת מיקום) — נזקף לזכותך בכל זאת';
    setTimeout(function(){ closeScan(); showToast('בקבוק מוחזר! יש לך ' + state.points + ' נקודות ♻️'); }, 1700);
  }

  $('#home-scan-btn').addEventListener('click', openScan);
  $('#nav-scan-btn').addEventListener('click', openScan);
  $('#scan-close').addEventListener('click', closeScan);
  $('#scan-demo-btn').addEventListener('click', function(){
    var list = sortedBinsByDistance();
    if(list.length === 0){ showToast('אין נקודות זמינות — הוסף אחת בעמוד הפרופיל'); return; }
    finishScanSuccess(list[0], !!userPos);
  });

  /* ================= sticker generator ================= */
  var stickerOverlay = $('#sticker-overlay');
  function openSticker(binId){
    var bin = findBinById(binId);
    if(!bin){ showToast('הנקודה לא נמצאה'); return; }
    $('#sticker-name').textContent = bin.name;
    var holder = $('#qr-canvas-holder'); holder.innerHTML = '';
    new QRCode(holder, {text:'ecobuddy:' + bin.id, width:200, height:200, correctLevel: QRCode.CorrectLevel.M});
    stickerOverlay.hidden = false;
  }
  $('#sticker-close').addEventListener('click', function(){ stickerOverlay.hidden = true; });
  $('#sticker-print').addEventListener('click', function(){ window.print(); });

  /* ================= EcoBuddy chat ================= */
  var ecoOverlay = $('#eco-overlay');
  var chatBody = $('#chat-body');
  var chatChips = $('#chat-chips');
  var chatText = $('#chat-text');
  var apiTurns = [];
  var openedOnce = false;

  function addMsg(role, text){
    var m = el('div', 'msg ' + (role==='user'?'user':'bot'), '');
    m.textContent = text; chatBody.appendChild(m);
    chatBody.scrollTop = chatBody.scrollHeight;
    return m;
  }
  function addTyping(){
    var m = el('div', 'msg bot typing', '<span></span><span></span><span></span>');
    chatBody.appendChild(m); chatBody.scrollTop = chatBody.scrollHeight;
    return m;
  }
  function personaSystem(focus){
    var focusText = {
      home:'המשתמש הכי גולש במפה, אז דגש על נגישות ומרחק לנקודת מחזור.',
      rewards:'המשתמש הכי גולש בעמוד התגמולים, אז דגש על תמריץ כלכלי ומה שחסר לו לתגמול הבא.',
      leaderboard:'המשתמש הכי גולש בלוח המובילים, אז דגש על נורמה חברתית ותחרות ידידותית מול חברים.',
      profile:'המשתמש הכי גולש בפרופיל שלו, אז דגש על ההתקדמות האישית, הרצף והסמלים שלו.'
    }[focus];
    return 'אתה EcoBuddy, עוזר AI חברותי בתוך אפליקציית מחזור בקבוקי פלסטיק בישראל. ' +
      'ענה תמיד בעברית, בטון חם ולא רשמי, עד 2-3 משפטים קצרים, עם לכל היותר אימוג׳י אחד, בלי מארקדאון. ' +
      'נתוני המשתמש: ' + state.points + ' נקודות, רצף של ' + state.streak + ' ימים, ' + state.totalBottles + ' בקבוקים ממוחזרים בסך הכל. ' + focusText;
  }
  async function callClaude(turns, systemText){
    if(!(state.settings.useAI && state.settings.apiKey)) return null;
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{
        'content-type':'application/json',
        'x-api-key': state.settings.apiKey,
        'anthropic-version':'2023-06-01',
        'anthropic-dangerous-direct-browser-access':'true'
      },
      body: JSON.stringify({model: state.settings.model || 'claude-haiku-4-5-20251001', max_tokens:220, system: systemText, messages: turns})
    });
    if(!res.ok){ var t = await res.text().catch(function(){return '';}); throw new Error('api-'+res.status+' '+t.slice(0,150)); }
    var json = await res.json();
    var text = (json.content && json.content[0] && json.content[0].text) ? json.content[0].text : '';
    return text.trim();
  }
  function fallbackReply(focus){
    var arr = FALLBACK_NUDGES[focus] || FALLBACK_NUDGES.home;
    return arr[Math.floor(Math.random()*arr.length)];
  }
  function renderChips(focus){
    var options = {
      home:'איפה הכי קרוב לי למחזר עכשיו?', rewards:'כמה נקודות אני צריך לקפה חינם?',
      leaderboard:'כמה בקבוקים אני צריך כדי לעקוף את נועה?', profile:'איזה סמל הכי קרוב אצלי?'
    };
    chatChips.innerHTML = '';
    var chip = el('button','chip-btn', options[focus]);
    chip.addEventListener('click', function(){ chatText.value = options[focus]; sendChat(); });
    chatChips.appendChild(chip);
  }
  function openEco(){
    ecoOverlay.hidden = false;
    var focus = topFocusTab();
    $('#eco-focus').textContent = 'מתאים נאדג׳ים לפי: ' + FOCUS_LABEL[focus];
    renderChips(focus);
    if(!openedOnce){
      openedOnce = true;
      var typingEl = addTyping();
      var system = personaSystem(focus);
      apiTurns = [{role:'user', content:'תן ברכת פתיחה קצרה ומותאמת אישית.'}];
      callClaude(apiTurns, system).then(function(text){
        typingEl.remove();
        if(text === null){ addMsg('bot', fallbackReply(focus)); apiTurns = []; return; }
        addMsg('bot', text); apiTurns.push({role:'assistant', content:text});
      }).catch(function(){ typingEl.remove(); addMsg('bot', fallbackReply(focus)); showToast('AI לא זמין כרגע — מציג הודעה כללית'); apiTurns = []; });
    }
  }
  function closeEco(){ ecoOverlay.hidden = true; }
  function sendChat(){
    var text = chatText.value.trim();
    if(!text) return;
    addMsg('user', text); chatText.value = '';
    var focus = topFocusTab();
    apiTurns.push({role:'user', content:text});
    var typingEl = addTyping();
    callClaude(apiTurns, personaSystem(focus)).then(function(reply){
      typingEl.remove();
      if(reply === null){ addMsg('bot', fallbackReply(focus)); return; }
      addMsg('bot', reply); apiTurns.push({role:'assistant', content:reply});
    }).catch(function(){ typingEl.remove(); addMsg('bot', fallbackReply(focus)); showToast('AI לא זמין כרגע — מציג הודעה כללית'); });
  }
  $('#eco-fab').addEventListener('click', openEco);
  $('#eco-close').addEventListener('click', closeEco);
  $('#chat-send').addEventListener('click', sendChat);
  chatText.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });

  /* ================= boot ================= */
  initMap();
  renderAll();
  startGeolocation();

  if('serviceWorker' in navigator){ /* no service worker shipped yet — kept simple for a personal project */ }
})();
