/* ------------------------------------------------------------------
   transfer.js  -  peer-to-peer file & folder transfer over WebRTC.

   The "Send" device creates a 6-digit code (digits + QR) and hosts a room
   on the signaling broker (/api/ws). The "Receive" device enters the code
   (or opens the QR link). The broker relays only the WebRTC handshake;
   files then stream directly device-to-device over an encrypted channel.

   Phase 3:
   - Send whole folders (folder picker or drag-drop), preserving structure.
   - Receiver can pick a destination folder (File System Access API) so
     files stream straight to disk - no memory ceiling for huge files.
   - File-level resume: if a transfer is interrupted, reconnect and resend;
     files already fully written to the chosen folder are skipped.
   - Fallback (Firefox/Safari/mobile): each file downloads individually.

   Wire protocol over the data channel (both sides updated together):
     sender -> { kind:"file-start", path, name, size, type, index, total }
     recv   -> { kind:"file-ack", action:"send"|"skip" }
     sender -> <binary chunks...> then { kind:"file-end" }
     recv   -> { kind:"file-complete" }         (after write/close)
     sender -> { kind:"all-done" }              (after last file)
   ------------------------------------------------------------------ */
(function () {
  "use strict";

  var CHUNK = 64 * 1024;
  var HIGH_WATER = 8 * 1024 * 1024;
  var LOW_WATER = 1 * 1024 * 1024;
  var ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  // liveness / stall detection
  var PING_MS = 4000;             // keepalive ping cadence over the channel
  var WATCHDOG_MS = 3000;         // how often we check for a stall
  var STALL_MS = 15000;           // no activity this long => connection lost
  var CONNECT_TIMEOUT_MS = 30000; // negotiation must finish within this

  var SAS_EMOJI = [
    "\u{1F34E}", "\u{1F34C}", "\u{1F347}", "\u{1F353}", "\u{1F352}", "\u{1F34D}",
    "\u{1F680}", "\u{2B50}", "\u{1F525}", "\u{1F308}", "\u{26A1}", "\u{1F3B8}",
    "\u{1F431}", "\u{1F436}", "\u{1F98A}", "\u{1F438}", "\u{1F419}", "\u{1F41D}",
    "\u{1F34B}", "\u{1F511}", "\u{1F514}", "\u{1F3AF}", "\u{1F3B2}", "\u{1F9E9}"
  ];

  var SIGNAL_URL =
    (location.protocol === "https:" ? "wss" : "ws") +
    "://" + location.host + "/api/ws";

  // ---- state ----
  var role = null;
  var ws = null;
  var pc = null;
  var dc = null;
  var code = null;
  var hostRetries = 0;
  var incoming = null;      // receiver: current file being written
  var lastLoggedPct = -1;
  var sasShown = false;
  var pendingPrefill = null;
  var dirHandle = null;     // receiver: chosen destination directory
  var ackResolver = null;   // sender: awaits file-ack
  var completeResolver = null; // sender: awaits file-complete
  var drainResolver = null; // sender: awaits buffer drain (released on abort)
  var aborted = false;      // sender: peer/channel gone mid-send
  var ended = false;        // session finished/failed (banner shown once)
  var lastActivityAt = 0;   // last time any message arrived on the channel
  var pingTimer = null;
  var watchdogTimer = null;
  var connectTimer = null;

  var el = {};
  function $(id) { return document.getElementById(id); }

  function log(message) {
    try {
      window.parent.postMessage(
        { type: "lg-log", source: "transfer", label: "Transfer", message: String(message) },
        "*"
      );
    } catch (_) { /* ignore */ }
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  // ---- signaling ----
  function openWs(theCode, theRole) {
    role = theRole;
    code = theCode;
    try {
      ws = new WebSocket(SIGNAL_URL + "?code=" + theCode + "&role=" + theRole);
    } catch (e) {
      signalUnavailable();
      return;
    }
    ws.onerror = function () { signalUnavailable(); };
    ws.onmessage = onSignalMessage;
  }

  function signalUnavailable() {
    var msg =
      "Signaling server not reachable. The Transfer tool only works once the " +
      "site is deployed to Cloudflare (with the signaling Worker) - or via " +
      "`wrangler pages dev dist` locally.";
    if (role === "host") setSendStatus(msg);
    else setRecvStatus(msg);
    log("Signaling unavailable - deploy to Cloudflare to use Transfer.");
  }

  function sendSignal(payload) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "signal", payload: payload }));
    }
  }

  async function onSignalMessage(evt) {
    var m;
    try { m = JSON.parse(evt.data); } catch (_) { return; }

    switch (m.type) {
      case "created":
        el.codeDisplay.textContent = code;
        show(el.sendCodeArea);
        renderQr(code);
        setSendStatus("Waiting for the other device to enter the code...");
        log("Transfer code created: " + code);
        break;
      case "error":
        handleSignalError(m.reason || "unknown");
        break;
      case "joined":
        setRecvStatus("Code accepted. Establishing secure connection...");
        break;
      case "peer-ready":
        log("Peer found. Negotiating a direct connection...");
        ended = false;
        startConnectTimer();
        if (role === "host") await startAsHost();
        else startAsGuest();
        break;
      case "peer-left":
        handleConnectionLost(
          "The other device disconnected. Start over (or reconnect and resend) to resume."
        );
        break;
      case "signal":
        await handleSignal(m.payload);
        break;
    }
  }

  function handleSignalError(reason) {
    if (reason === "code-taken") {
      if (hostRetries < 4) { hostRetries++; startHost(); return; }
      setSendStatus("Could not allocate a code, please try again.");
    } else if (reason === "code-not-found") {
      setRecvStatus("No device is waiting on that code. Check the digits and try again.");
      resetReceiveUI();
    } else if (reason === "room-full") {
      setRecvStatus("That transfer already has two devices connected.");
      resetReceiveUI();
    } else {
      setRecvStatus("Connection error: " + reason);
    }
  }

  // ---- QR ----
  function deepLink(theCode) {
    var base;
    try { base = window.parent.location.origin + window.parent.location.pathname; }
    catch (_) { base = location.origin + "/"; }
    return base + "?tab=transfer&code=" + theCode;
  }

  function renderQr(theCode) {
    if (typeof qrcode === "undefined" || !el.qrBox) return;
    try {
      var qr = qrcode(0, "M");
      qr.addData(deepLink(theCode));
      qr.make();
      el.qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      show(el.qrWrap);
    } catch (_) { hide(el.qrWrap); }
  }

  // ---- WebRTC ----
  function createPeer() {
    pc = new RTCPeerConnection(ICE);
    pc.onicecandidate = function (e) {
      if (e.candidate) sendSignal({ candidate: e.candidate });
    };
    pc.onconnectionstatechange = function () {
      if (!pc) return;
      var st = pc.connectionState;
      log("Connection state: " + st);
      if (st === "connected") {
        clearConnectTimer();
      } else if (st === "disconnected") {
        // Transient: WebRTC may recover on its own within a few seconds.
        if (!ended) setConnStatus("Connection unstable - trying to recover...");
      } else if (st === "failed" || st === "closed") {
        handleConnectionLost("Connection lost (" + st + "). Start over to try again.");
      }
    };
  }

  async function startAsHost() {
    aborted = false;
    createPeer();
    dc = pc.createDataChannel("file");
    dc.binaryType = "arraybuffer";
    setupDataChannel();
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ sdp: pc.localDescription });
  }

  function startAsGuest() {
    createPeer();
    pc.ondatachannel = function (e) {
      dc = e.channel;
      dc.binaryType = "arraybuffer";
      setupDataChannel();
    };
  }

  async function handleSignal(payload) {
    if (!pc) return;
    if (payload.sdp) {
      await pc.setRemoteDescription(payload.sdp);
      if (payload.sdp.type === "offer") {
        var answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ sdp: pc.localDescription });
      }
    } else if (payload.candidate) {
      try { await pc.addIceCandidate(payload.candidate); } catch (_) { /* ignore */ }
    }
  }

  async function computeSas() {
    if (!pc || !pc.localDescription || !pc.remoteDescription) return null;
    var localSdp = pc.localDescription.sdp;
    var remoteSdp = pc.remoteDescription.sdp;
    var offer = pc.localDescription.type === "offer" ? localSdp : remoteSdp;
    var answer = pc.localDescription.type === "offer" ? remoteSdp : localSdp;
    var bytes = new TextEncoder().encode(offer + "\n--\n" + answer);
    var digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    var out = [];
    for (var i = 0; i < 5; i++) out.push(SAS_EMOJI[digest[i] % SAS_EMOJI.length]);
    return out.join(" ");
  }

  async function showSas() {
    if (sasShown) return;
    var sas = await computeSas();
    if (!sas) return;
    sasShown = true;
    if (role === "host") {
      el.sendSas.textContent = sas;
      show(el.sendVerify);
      setSendStatus("Connected. Verify the symbols below match, then continue.");
    } else {
      el.recvSas.textContent = sas;
      show(el.recvVerify);
      if (window.showDirectoryPicker) show(el.recvDest);
      else el.destNote.innerHTML =
        "This browser can't stream to a folder, so each file will download " +
        "individually. For folders & very large files, use desktop Chrome or Edge.";
    }
    log("Security check: " + sas);
  }

  function setupDataChannel() {
    dc.onopen = function () {
      log("Encrypted channel open.");
      aborted = false;
      clearConnectTimer();
      startTimers();
      showSas();
      if (role === "guest") {
        show(el.recvProgress);
        setRecvStatus("Connected. Waiting for files...");
      }
    };
    dc.onclose = function () {
      handleConnectionLost("Connection closed unexpectedly. Start over to try again.");
    };
    dc.onmessage = onDcMessage;
  }

  // ---- liveness / stall detection ----
  function markActivity() { lastActivityAt = Date.now(); }

  function startTimers() {
    lastActivityAt = Date.now();
    stopTimers();
    pingTimer = setInterval(function () { dcSend({ kind: "ping" }); }, PING_MS);
    watchdogTimer = setInterval(function () {
      if (!dc || dc.readyState !== "open") return;
      if (Date.now() - lastActivityAt > STALL_MS) {
        handleConnectionLost(
          "Connection lost - the other device stopped responding. " +
          "The transfer was interrupted. Start over to try again."
        );
      }
    }, WATCHDOG_MS);
  }

  function stopTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  }

  function startConnectTimer() {
    clearConnectTimer();
    connectTimer = setTimeout(function () {
      if (!dc || dc.readyState !== "open") {
        handleConnectionLost(
          "Couldn't establish a direct connection in time (the network may be " +
          "blocking peer-to-peer). Start over to try again."
        );
      }
    }, CONNECT_TIMEOUT_MS);
  }
  function clearConnectTimer() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  }

  function handleConnectionLost(msg) {
    if (ended) return;
    ended = true;
    aborted = true;
    clearConnectTimer();
    stopTimers();
    settleWaiters();
    incoming = null;
    if (el.sendDrop) el.sendDrop.classList.remove("busy");
    if (el.sendProgress) el.sendProgress.innerHTML = "";
    if (el.recvProgress) el.recvProgress.innerHTML = "";
    showBanner(msg);
    log(msg);
  }

  // ---- sender: waiters ----
  function waitAck() { return new Promise(function (r) { ackResolver = r; }); }
  function waitComplete() { return new Promise(function (r) { completeResolver = r; }); }
  function settleWaiters() {
    if (ackResolver) { var a = ackResolver; ackResolver = null; a("abort"); }
    if (completeResolver) { var c = completeResolver; completeResolver = null; c(); }
    if (drainResolver) { var d = drainResolver; drainResolver = null; d(); }
  }

  // ---- data channel messages ----
  async function onDcMessage(e) {
    markActivity();
    if (typeof e.data !== "string") {
      // binary chunk (receiver)
      if (!incoming) return;
      incoming.received += e.data.byteLength;
      setRecvProgress(incoming.meta.path, incoming.received, incoming.meta.size,
        incoming.meta.index, incoming.meta.total);
      maybeLogPct("Receiving " + incoming.meta.path, incoming.received, incoming.meta.size);
      if (incoming.writable) {
        var chunk = e.data;
        incoming.writeChain = incoming.writeChain.then(function () {
          return incoming.writable.write(chunk);
        });
      } else if (incoming.chunks) {
        incoming.chunks.push(e.data);
      }
      return;
    }

    var m;
    try { m = JSON.parse(e.data); } catch (_) { return; }

    switch (m.kind) {
      // ----- keepalive (both sides) -----
      case "ping":
        dcSend({ kind: "pong" });
        break;
      case "pong":
        break; // activity already marked above

      // ----- receiver side -----
      case "file-start":
        await onFileStart(m);
        break;
      case "file-end":
        await onFileEnd();
        break;
      case "all-done":
        el.recvProgress.innerHTML = "";
        hide(el.recvProgress);
        setRecvStatus("All files received.");
        log("Transfer complete.");
        break;

      // ----- sender side -----
      case "file-ack":
        if (ackResolver) { var a = ackResolver; ackResolver = null; a(m.action); }
        break;
      case "file-complete":
        if (completeResolver) { var c = completeResolver; completeResolver = null; c(); }
        break;
    }
  }

  // ---- receiver: per-file handling ----
  async function onFileStart(m) {
    incoming = { meta: m, received: 0, chunks: null, writable: null, writeChain: Promise.resolve() };
    lastLoggedPct = -1;

    var action = "send";
    if (dirHandle) {
      var existing = await existingSize(m.path);
      if (existing === m.size && m.size > 0) action = "skip";
    }

    if (action === "skip") {
      addListItem(el.recvList, m.path, "skipped", true);
      log("Already have " + m.path + " - skipping.");
      incoming = null;
      dcSend({ kind: "file-ack", action: "skip" });
      return;
    }

    if (dirHandle) {
      try {
        incoming.writable = await openWritable(m.path);
      } catch (err) {
        log("Could not open " + m.path + " for writing: " + err);
        incoming.chunks = []; // fall back to in-memory for this file
      }
    } else {
      incoming.chunks = [];
    }

    setRecvProgress(m.path, 0, m.size, m.index, m.total);
    log("Receiving " + m.path + " (" + fmtBytes(m.size) + ")");
    dcSend({ kind: "file-ack", action: "send" });
  }

  async function onFileEnd() {
    if (!incoming) { dcSend({ kind: "file-complete" }); return; }
    var meta = incoming.meta;
    try {
      if (incoming.writable) {
        await incoming.writeChain;
        await incoming.writable.close();
      } else if (incoming.chunks) {
        downloadBlob(new Blob(incoming.chunks, {
          type: meta.type || "application/octet-stream",
        }), meta.name);
      }
      addListItem(el.recvList, meta.path, "saved");
      log("Saved " + meta.path);
    } catch (err) {
      log("Error finishing " + meta.path + ": " + err);
    }
    incoming = null;
    dcSend({ kind: "file-complete" });
  }

  // ---- File System Access helpers ----
  async function dirFor(pathParts, create) {
    var dir = dirHandle;
    for (var i = 0; i < pathParts.length; i++) {
      if (!pathParts[i]) continue;
      dir = await dir.getDirectoryHandle(pathParts[i], { create: create });
    }
    return dir;
  }

  async function openWritable(relPath) {
    var parts = relPath.split("/");
    var name = parts.pop();
    var dir = await dirFor(parts, true);
    var fh = await dir.getFileHandle(name, { create: true });
    return await fh.createWritable(); // truncates existing (restarts partial files)
  }

  async function existingSize(relPath) {
    try {
      var parts = relPath.split("/");
      var name = parts.pop();
      var dir = await dirFor(parts, false);
      var fh = await dir.getFileHandle(name, { create: false });
      var f = await fh.getFile();
      return f.size;
    } catch (_) { return -1; }
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
  }

  // ---- sender ----
  async function sendItems(items) {
    if (!dc || dc.readyState !== "open") return;
    if (!items.length) return;
    aborted = false;
    el.sendDrop.classList.add("busy");
    var sent = 0;

    for (var i = 0; i < items.length; i++) {
      if (aborted) break;
      var file = items[i].file;
      var path = items[i].path;

      dcSend({
        kind: "file-start", path: path, name: file.name,
        size: file.size, type: file.type, index: i + 1, total: items.length,
      });
      var action = await waitAck();
      if (aborted || action === "abort") break;
      if (action === "skip") {
        addListItem(el.sendList, path, "skipped", true);
        log("Skipped (already there): " + path);
        continue;
      }

      await streamFile(file, path, i + 1, items.length);
      if (aborted) break;
      dcSend({ kind: "file-end" });
      await waitComplete();
      if (aborted) break;
      addListItem(el.sendList, path, "sent");
      sent++;
    }

    el.sendDrop.classList.remove("busy");
    if (aborted) {
      setSendStatus("Transfer interrupted. Reconnect and resend to resume.");
      return;
    }
    dcSend({ kind: "all-done" });
    el.sendProgress.innerHTML = "";
    setSendStatus("Done. Sent " + sent + " file" + (sent === 1 ? "" : "s") + ". You can send more.");
    log("All files sent.");
  }

  async function streamFile(file, path, index, total) {
    log("Sending " + path + " (" + fmtBytes(file.size) + ")");
    var offset = 0;
    lastLoggedPct = -1;
    while (offset < file.size) {
      if (aborted) return;
      if (dc.bufferedAmount > HIGH_WATER) await waitForDrain();
      if (aborted) return;
      var buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
      try { dc.send(buf); } catch (_) { aborted = true; return; }
      offset += buf.byteLength;
      setSendProgress(path, offset, file.size, index, total);
      maybeLogPct("Sending " + path, offset, file.size);
    }
  }

  function waitForDrain() {
    return new Promise(function (resolve) {
      if (aborted) return resolve();
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        drainResolver = null;
        dc.removeEventListener("bufferedamountlow", handler);
        resolve();
      };
      var handler = function () { finish(); };
      drainResolver = finish; // lets settleWaiters() release us on abort/loss
      dc.bufferedAmountLowThreshold = LOW_WATER;
      dc.addEventListener("bufferedamountlow", handler);
    });
  }

  function dcSend(obj) {
    try { if (dc && dc.readyState === "open") dc.send(JSON.stringify(obj)); }
    catch (_) { /* ignore */ }
  }

  function maybeLogPct(label, done, total) {
    var pct = Math.floor((done / total) * 100);
    if ((pct >= lastLoggedPct + 25 || pct === 100) && pct !== lastLoggedPct) {
      lastLoggedPct = pct;
      log(label + " - " + pct + "%");
    }
  }

  // ---- collecting files/folders on the sender ----
  function itemsFromFileList(fileList) {
    return Array.prototype.slice.call(fileList).map(function (f) {
      return { file: f, path: (f.webkitRelativePath || f.name) };
    });
  }

  async function itemsFromDataTransfer(dt) {
    var list = dt.items;
    var canWalk = list && list.length && typeof list[0].webkitGetAsEntry === "function";
    if (!canWalk) return itemsFromFileList(dt.files);
    var entries = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    var out = [];
    for (var j = 0; j < entries.length; j++) await walkEntry(entries[j], "", out);
    return out.length ? out : itemsFromFileList(dt.files);
  }

  function walkEntry(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (file) {
          out.push({ file: file, path: prefix + entry.name });
          resolve();
        }, function () { resolve(); });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        var readBatch = function () {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              (async function () {
                for (var k = 0; k < all.length; k++) {
                  await walkEntry(all[k], prefix + entry.name + "/", out);
                }
                resolve();
              })();
            } else {
              all = all.concat(Array.prototype.slice.call(batch));
              readBatch();
            }
          }, function () { resolve(); });
        };
        readBatch();
      } else { resolve(); }
    });
  }

  // ---- UI helpers ----
  function show(node) { if (node) node.classList.remove("hidden"); }
  function hide(node) { if (node) node.classList.add("hidden"); }
  function setSendStatus(t) { el.sendStatus.textContent = t; }
  function setRecvStatus(t) { el.recvStatus.textContent = t; }
  function setConnStatus(msg) {
    if (!msg) return;
    if (role === "host") setSendStatus(msg);
    else setRecvStatus(msg);
  }
  function showBanner(msg) {
    if (el.xferBannerMsg) el.xferBannerMsg.textContent = msg;
    show(el.xferBanner);
  }
  function hideBanner() { hide(el.xferBanner); }

  function progressMarkup(name, done, total, index, count) {
    var pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    var head = (index && count && count > 1) ? ("File " + index + " of " + count) : "In progress";
    return (
      '<div class="xfer-file">' +
        '<div class="xfer-file-head"><span>' + head + '</span></div>' +
        '<div class="xfer-file-row"><span class="xfer-file-name">' +
          escapeHtml(name) + '</span><span class="xfer-file-pct">' + pct + '%</span></div>' +
        '<div class="xfer-bar"><div class="xfer-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="xfer-file-sub">' + fmtBytes(done) + ' / ' + fmtBytes(total) + '</div>' +
      '</div>'
    );
  }
  function setSendProgress(name, done, total, i, n) {
    el.sendProgress.innerHTML = progressMarkup(name, done, total, i, n);
  }
  function setRecvProgress(name, done, total, i, n) {
    el.recvProgress.innerHTML = progressMarkup(name, done, total, i, n);
  }
  function addListItem(listEl, name, verb, muted) {
    var row = document.createElement("div");
    row.className = "xfer-list-item";
    var n = document.createElement("span");
    n.className = "name";
    n.textContent = name;
    var ok = document.createElement("span");
    ok.className = muted ? "skip" : "ok";
    ok.textContent = (muted ? "" : "\u2713 ") + verb;
    row.appendChild(n);
    row.appendChild(ok);
    listEl.appendChild(row);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- mode + actions ----
  function setMode(mode) {
    var sending = mode === "send";
    el.modeSend.classList.toggle("active", sending);
    el.modeReceive.classList.toggle("active", !sending);
    el.sendPanel.classList.toggle("hidden", !sending);
    el.receivePanel.classList.toggle("hidden", sending);
  }

  function startHost() {
    code = String(Math.floor(100000 + Math.random() * 900000));
    if (ws) { try { ws.close(); } catch (_) {} }
    sasShown = false;
    ended = false;
    aborted = false;
    hideBanner();
    openWs(code, "host");
  }

  function resetReceiveUI() {
    show(el.recvStart);
    hide(el.recvProgress);
  }

  function connectAsGuest(v) {
    if (!/^\d{6}$/.test(v)) { setRecvStatus("Enter the full 6-digit code."); return; }
    setMode("receive");
    el.codeInput.value = v;
    hide(el.recvStart);
    sasShown = false;
    ended = false;
    aborted = false;
    hideBanner();
    setRecvStatus("Connecting...");
    openWs(v, "guest");
  }

  function init() {
    [
      "modeSend", "modeReceive", "sendPanel", "receivePanel", "sendStart",
      "createBtn", "sendCodeArea", "codeDisplay", "qrWrap", "qrBox", "sendStatus",
      "sendVerify", "sendSas", "verifyConfirmBtn", "sendFileArea",
      "chooseFilesBtn", "chooseFolderBtn", "sendDrop", "sendFileInput",
      "sendFolderInput", "sendProgress", "sendList", "recvStart", "codeInput",
      "connectBtn", "recvStatus", "recvVerify", "recvSas", "recvDest", "destBtn",
      "destNote", "recvProgress", "recvList",
      "xferBanner", "xferBannerMsg", "xferResetBtn",
    ].forEach(function (id) { el[id] = $(id); });

    el.modeSend.addEventListener("click", function () { setMode("send"); });
    el.modeReceive.addEventListener("click", function () { setMode("receive"); });
    if (el.xferResetBtn) {
      el.xferResetBtn.addEventListener("click", function () { location.reload(); });
    }

    el.createBtn.addEventListener("click", function () {
      hostRetries = 0;
      hide(el.sendStart);
      startHost();
    });

    el.verifyConfirmBtn.addEventListener("click", function () {
      hide(el.sendVerify);
      show(el.sendFileArea);
      setSendStatus("Verified. Choose files or a folder to send.");
    });

    el.chooseFilesBtn.addEventListener("click", function () { el.sendFileInput.click(); });
    el.chooseFolderBtn.addEventListener("click", function () { el.sendFolderInput.click(); });
    el.sendFileInput.addEventListener("change", function () {
      if (this.files && this.files.length) sendItems(itemsFromFileList(this.files));
      this.value = "";
    });
    el.sendFolderInput.addEventListener("change", function () {
      if (this.files && this.files.length) sendItems(itemsFromFileList(this.files));
      this.value = "";
    });
    el.sendDrop.addEventListener("click", function () { el.sendFileInput.click(); });
    el.sendDrop.addEventListener("dragover", function (e) {
      e.preventDefault();
      el.sendDrop.classList.add("drop-zone--hover");
    });
    el.sendDrop.addEventListener("dragleave", function () {
      el.sendDrop.classList.remove("drop-zone--hover");
    });
    el.sendDrop.addEventListener("drop", async function (e) {
      e.preventDefault();
      el.sendDrop.classList.remove("drop-zone--hover");
      if (e.dataTransfer) {
        var items = await itemsFromDataTransfer(e.dataTransfer);
        if (items.length) sendItems(items);
      }
    });

    el.destBtn.addEventListener("click", async function () {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        el.destBtn.textContent = "Destination folder selected";
        el.destNote.innerHTML =
          "<strong>Streaming to disk.</strong> Files write straight into the " +
          "chosen folder; already-received files will be skipped on resume.";
      } catch (_) { /* user cancelled */ }
    });

    el.codeInput.addEventListener("input", function () {
      this.value = this.value.replace(/\D/g, "").slice(0, 6);
    });
    el.connectBtn.addEventListener("click", function () {
      connectAsGuest(el.codeInput.value.trim());
    });
    el.codeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") el.connectBtn.click();
    });

    window.addEventListener("message", function (ev) {
      var d = ev.data;
      if (d && d.type === "xfer-prefill" && /^\d{6}$/.test(String(d.code))) {
        connectAsGuest(String(d.code));
      }
    });

    try { window.parent.postMessage({ type: "xfer-ready" }, "*"); } catch (_) {}
    if (pendingPrefill) connectAsGuest(pendingPrefill);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
