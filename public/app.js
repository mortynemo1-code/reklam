/* Озвучивание рекламаций: сцена «экран зала».
   Озвучка: серверный Silero TTS (/api/tts → WAV) с подсветкой слов по
   расчётному таймингу и анимацией круга от реальной амплитуды звука;
   при недоступности сервера — откат на голос браузера (Web Speech API).
   CRUD рекламаций — через REST API (/api/reklamations). */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    rings: $("rings"),
    logo: $("logo"),
    kickerNum: $("kickerNum"),
    kickerLevel: $("kickerLevel"),
    problemBlock: $("problemBlock"),
    problemText: $("problemText"),
    titleWords: $("titleWords"),
    metaCur: $("metaCur"),
    metaTotal: $("metaTotal"),
    metaStatus: $("metaStatus"),
    barFill: $("barFill"),
    counter: $("counter"),
    btnSpeak: $("btnSpeak"),
    btnStop: $("btnStop"),
    btnPrev: $("btnPrev"),
    btnNext: $("btnNext"),
    btnManage: $("btnManage"),
    drawer: $("drawer"),
    drawerBackdrop: $("drawerBackdrop"),
    btnCloseDrawer: $("btnCloseDrawer"),
    editorForm: $("editorForm"),
    editorTitle: $("editorTitle"),
    editorError: $("editorError"),
    fText: $("fText"),
    fProblem: $("fProblem"),
    fLevel: $("fLevel"),
    fStatus: $("fStatus"),
    btnCancelEdit: $("btnCancelEdit"),
    itemList: $("itemList"),
    emptyHint: $("emptyHint"),
    stage: document.querySelector(".stage")
  };

  const STATUS_COLORS = {
    "принято": "#8FA0C9",
    "на голосовании": "#FF8C3D",
    "на доработке": "#7C8CFF",
    "на рассмотрении": "#8A93AD"
  };

  const BROWSER_RATE = 0.95;

  const state = {
    items: [],
    i: 0,
    editingId: null,
    playing: false,
    paused: false
  };

  // ── API ────────────────────────────────────────────────
  const api = {
    async list() {
      const r = await fetch("/api/reklamations");
      if (!r.ok) throw new Error("не удалось загрузить рекламации");
      return r.json();
    },
    async save(payload, id = null) {
      const r = await fetch(id ? `/api/reklamations/${id}` : "/api/reklamations", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "ошибка сохранения");
      return data;
    },
    async remove(id) {
      const r = await fetch(`/api/reklamations/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("ошибка удаления");
    }
  };

  // ── озвучка ────────────────────────────────────────────
  const speech = {
    phase: "idle",   // idle | loading | speaking
    mode: null,      // "server" | "browser"
    seq: 0,          // токен для отмены запросов в полёте
    rev: 0,

    // серверный режим
    audio: null,
    audioUrl: null,
    actx: null,
    analyser: null,
    tdBuf: null,
    schedule: [],    // время начала каждого слова текста, сек

    // браузерный режим (fallback)
    voices: null,
    starts: [],
    offset: 0,
    estStart: 0,
    gotBoundary: false,
    lastBoundary: 0,

    utterance(it) {
      // для речи — номер без ведущего нуля, чтобы не звучало «ноль один»
      const prefix = "Пункт " + (state.i + 1) + ". " + it.level + ". " +
        (it.problem ? it.problem + " " : "");
      return { prefix, body: it.text };
    },

    initAudio() {
      if (this.audio) return;
      this.audio = new Audio();
      this.audio.preload = "auto";
      this.audio.onended = () => this.finish();
    },

    ensureAnalyser() {
      try {
        if (!this.actx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          this.actx = new AC();
          const src = this.actx.createMediaElementSource(this.audio);
          this.analyser = this.actx.createAnalyser();
          this.analyser.fftSize = 1024;
          src.connect(this.analyser);
          this.analyser.connect(this.actx.destination);
          this.tdBuf = new Uint8Array(this.analyser.fftSize);
        }
        if (this.actx.state === "suspended") this.actx.resume();
      } catch { /* без анализатора круг работает на псевдоогибающей */ }
    },

    level() {
      if (!this.analyser) return null;
      this.analyser.getByteTimeDomainData(this.tdBuf);
      let s = 0;
      for (let i = 0; i < this.tdBuf.length; i++) {
        const v = (this.tdBuf[i] - 128) / 128;
        s += v * v;
      }
      return Math.sqrt(s / this.tdBuf.length);
    },

    // Модель не отдаёт тайминги слов, поэтому распределяем длительность
    // аудио по словам пропорционально их длине (плюс паузы на знаках).
    buildSchedule(prefix, body, duration) {
      const weight = (w) =>
        w.length + 1 + (/[.!?…]$/.test(w) ? 6 : /[,;:—]$/.test(w) ? 2.5 : 0);
      const pw = prefix.split(/\s+/).filter(Boolean).map(weight);
      const bw = body.split(/\s+/).filter(Boolean).map(weight);
      const total = pw.concat(bw).reduce((a, b) => a + b, 0) || 1;
      let acc = pw.reduce((a, b) => a + b, 0);
      this.schedule = bw.map((w) => {
        const t = (acc / total) * duration;
        acc += w;
        return t;
      });
    },

    async speak() {
      const it = current();
      if (!it) return;
      this.cancelAll();
      const mySeq = ++this.seq;
      const { prefix, body } = this.utterance(it);

      this.phase = "loading";
      renderControls();
      try {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: prefix + body })
        });
        if (!r.ok) throw new Error("tts " + r.status);
        const blob = await r.blob();
        if (this.seq !== mySeq) return; // пока грузили — нажали стоп/другой пункт

        this.initAudio();
        if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
        this.audioUrl = URL.createObjectURL(blob);
        this.audio.src = this.audioUrl;
        this.ensureAnalyser();
        await this.audio.play();
        if (this.seq !== mySeq) { this.audio.pause(); return; }

        this.buildSchedule(prefix, body, this.audio.duration || 1);
        this.mode = "server";
        this.phase = "speaking";
        state.playing = true;
        state.paused = false;
        setRev(0);
        renderControls();
      } catch {
        if (this.seq !== mySeq) return;
        this.speakBrowser(prefix, body);
      }
    },

    /* ── fallback: Web Speech API ── */
    pickVoice() {
      const synth = window.speechSynthesis;
      if (!synth) return null;
      if (!this.voices) this.voices = synth.getVoices() || [];
      const ru = this.voices.filter((v) => /^ru/i.test(v.lang || ""));
      return ru.find((v) => v.localService) || ru[0] || this.voices[0] || null;
    },

    speakBrowser(prefix, body) {
      const synth = window.speechSynthesis;
      if (!synth) { this.finish(); return; }
      synth.cancel();
      const u = new SpeechSynthesisUtterance(prefix + body);
      u.lang = "ru-RU";
      u.rate = BROWSER_RATE;
      u.pitch = 1;
      const v = this.pickVoice();
      if (v) u.voice = v;

      this.starts = [];
      let p = 0;
      body.split(" ").forEach((w) => { this.starts.push(p); p += w.length + 1; });
      this.offset = prefix.length;
      this.gotBoundary = false;

      u.onstart = () => {
        this.mode = "browser";
        this.phase = "speaking";
        this.estStart = performance.now();
        this.lastBoundary = performance.now();
        state.playing = true;
        state.paused = false;
        setRev(0);
        renderControls();
      };
      u.onboundary = (e) => {
        this.gotBoundary = true;
        this.lastBoundary = performance.now();
        rings.pulse = 1;
        const ci = (e.charIndex ?? 0) - this.offset;
        let n = 0;
        for (let k = 0; k < this.starts.length; k++) if (this.starts[k] <= ci) n = k + 1;
        if (ci < 0) n = 0;
        setRev(n);
      };
      u.onend = () => this.finish();
      u.onerror = () => this.finish();
      this.phase = "loading";
      renderControls();
      synth.speak(u);
    },

    finish() {
      this.phase = "idle";
      this.mode = null;
      state.playing = false;
      state.paused = false;
      const it = current();
      setRev(it ? it.text.split(" ").length : 0);
      renderControls();
    },

    toggle() {
      if (this.phase === "loading") return;
      if (state.playing && !state.paused) {
        if (this.mode === "server") this.audio.pause();
        else if (window.speechSynthesis) window.speechSynthesis.pause();
        state.paused = true;
      } else if (state.paused) {
        if (this.mode === "server") this.audio.play();
        else if (window.speechSynthesis) window.speechSynthesis.resume();
        state.paused = false;
      } else {
        this.speak();
        return;
      }
      renderControls();
    },

    cancelAll() {
      this.seq++;
      if (this.audio) {
        this.audio.pause();
        this.audio.currentTime = 0;
      }
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    },

    stop() {
      this.cancelAll();
      this.phase = "idle";
      this.mode = null;
      state.playing = false;
      state.paused = false;
      setRev(0);
      renderControls();
    }
  };

  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => { speech.voices = null; };
  }

  // ── анимация колец ─────────────────────────────────────
  const rings = {
    env: 0,
    pulse: 0,
    t: 0,
    ph: 0, // накопленная фаза волн: скорость растёт вместе с громкостью
    last: performance.now(),
    rm: window.matchMedia("(prefers-reduced-motion: reduce)").matches,

    tick(dt, now) {
      let target = 0.1 + 0.06 * Math.sin(this.t * 0.9);
      if (speech.phase === "speaking" && !state.paused) {
        if (speech.mode === "server") {
          // подсветка слов по расписанию, огибающая — по реальному сигналу
          const t = speech.audio.currentTime;
          let n = 0;
          for (let k = 0; k < speech.schedule.length; k++) if (speech.schedule[k] <= t) n = k + 1;
          setRev(n);
          const lv = speech.level();
          if (lv !== null) {
            target = Math.min(1, 0.12 + lv * 5.5);
          } else {
            const syl = 0.5 + 0.5 * Math.sin(this.t * 9.2) * Math.sin(this.t * 3.1 + 1.3);
            target = 0.5 + 0.3 * syl;
          }
        } else {
          const since = (now - speech.lastBoundary) / 1000;
          if (!speech.gotBoundary) {
            const wps = 2.5 * BROWSER_RATE;
            const el = (now - speech.estStart) / 1000;
            const n = Math.min(speech.starts.length, Math.floor(el * wps));
            setRev(n);
            if (Math.abs((el * wps) % 1) < 0.12) this.pulse = 1;
          }
          const syl = 0.5 + 0.5 * Math.sin(this.t * 9.2) * Math.sin(this.t * 3.1 + 1.3);
          target = 0.5 + 0.4 * this.pulse * Math.max(0, 1 - since * 1.4) + 0.25 * syl;
        }
      } else if (speech.phase === "loading") {
        target = 0.2 + 0.08 * Math.sin(this.t * 2.2);
      }
      this.pulse = Math.max(0, this.pulse - dt * 3.2);
      // быстрая атака, плавный спад — движение живое, но без дёрганья
      const k = target > this.env ? 1 - Math.pow(0.0001, dt) : 1 - Math.pow(0.008, dt);
      this.env += (target - this.env) * k;
      this.ph += dt * (0.9 + 1.6 * this.env);
    },

    draw() {
      const c = els.rings;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2, cy = h / 2, S = Math.min(w, h);
      const env = this.rm ? 0 : this.env;
      const breathe = this.rm ? 1 :
        (speech.phase === "idle" ? 1 + 0.035 * Math.sin(this.t * Math.PI / 2) :
          (speech.phase === "loading" ? 0.96 : 1 + 0.05 * env));
      const R0 = S * 0.29 * breathe;
      const lw = Math.max(1.6, S * 0.0035) * (1 + 0.5 * env);

      const grad = (r) => {
        const g = ctx.createLinearGradient(cx - r, cy + r, cx + r, cy - r);
        g.addColorStop(0, "#FF8C3D");
        g.addColorStop(1, "#1F3FF5");
        return g;
      };

      const gl = ctx.createRadialGradient(cx, cy, R0 * 0.1, cx, cy, R0 * 1.2);
      gl.addColorStop(0, "rgba(255,140,61," + (0.05 + 0.17 * env).toFixed(3) + ")");
      gl.addColorStop(0.55, "rgba(52,72,190," + (0.04 + 0.12 * env).toFixed(3) + ")");
      gl.addColorStop(1, "rgba(10,14,26,0)");
      ctx.fillStyle = gl;
      ctx.beginPath();
      ctx.arc(cx, cy, R0 * 1.2, 0, Math.PI * 2);
      ctx.fill();

      const alphas = [0.92, 0.6, 0.36, 0.2];
      for (let r = 0; r < 4; r++) {
        const R = R0 * (1 + 0.09 * r);
        const amp = env * R0 * (0.11 + 0.05 * r);
        const ph = this.ph - r * 0.55;
        ctx.strokeStyle = grad(R);
        ctx.globalAlpha = alphas[r];
        ctx.lineWidth = Math.max(1.4, lw * (1 - r * 0.14));
        this.path(ctx, cx, cy, R, amp, ph);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    path(ctx, cx, cy, R, amp, ph) {
      const N = 220, pts = [];
      for (let i = 0; i < N; i++) {
        const th = i / N * Math.PI * 2;
        const d = amp * (Math.sin(3 * th + ph) * 0.5 +
          Math.sin(5 * th - ph * 0.72) * 0.3 +
          Math.sin(2 * th + ph * 1.31) * 0.2);
        const rr = R + d;
        pts.push([cx + rr * Math.cos(th), cy + rr * Math.sin(th)]);
      }
      ctx.beginPath();
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let m = mid(pts[N - 1], pts[0]);
      ctx.moveTo(m[0], m[1]);
      for (let i = 0; i < N; i++) {
        const p = pts[i], nx = pts[(i + 1) % N], mm = mid(p, nx);
        ctx.quadraticCurveTo(p[0], p[1], mm[0], mm[1]);
      }
      ctx.closePath();
    },

    loop: (now) => {
      const dt = Math.min(0.05, (now - rings.last) / 1000);
      rings.last = now;
      rings.t += dt;
      rings.tick(dt, now);
      rings.draw();
      requestAnimationFrame(rings.loop);
    }
  };

  // ── рендеринг ──────────────────────────────────────────
  function current() {
    return state.items[state.i] || null;
  }

  function num(i) {
    return String(i + 1).padStart(2, "0");
  }

  function setRev(n) {
    if (n === speech.rev) return;
    speech.rev = n;
    const words = els.titleWords.children;
    for (let k = 0; k < words.length; k++) words[k].classList.toggle("on", k < n);
  }

  function renderStage() {
    const it = current();
    const has = !!it;
    els.stage.style.visibility = has ? "visible" : "hidden";
    els.emptyHint.hidden = has;
    if (!has) {
      els.counter.textContent = "00 / 00";
      return;
    }

    els.kickerNum.textContent = "Пункт " + num(state.i);
    els.kickerLevel.textContent = it.level;
    els.problemText.textContent = it.problem;
    els.problemBlock.style.display = it.problem ? "" : "none";
    els.metaCur.textContent = num(state.i);
    els.metaTotal.textContent = num(state.items.length - 1);
    els.metaStatus.textContent = it.status;
    els.metaStatus.style.color = STATUS_COLORS[it.status] || "#8A93AD";
    els.barFill.style.width = ((state.i + 1) / state.items.length * 100).toFixed(1) + "%";
    els.counter.textContent = num(state.i) + " / " + num(state.items.length - 1);

    speech.rev = -1;
    els.titleWords.innerHTML = "";
    it.text.split(" ").forEach((w) => {
      const s = document.createElement("span");
      s.className = "w";
      s.textContent = w;
      els.titleWords.appendChild(s);
    });
    setRev(0);
  }

  function renderControls() {
    els.btnSpeak.textContent =
      speech.phase === "loading" ? "Готовлю…" :
      (state.playing && !state.paused ? "Пауза" :
        (state.paused ? "Продолжить" : "Озвучить"));
    els.logo.classList.toggle("speaking", speech.phase === "speaking" && !state.paused);
  }

  function renderList() {
    els.itemList.innerHTML = "";
    state.items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = "item" + (i === state.i ? " active" : "");

      const top = document.createElement("div");
      top.className = "item-top";
      const n = document.createElement("span");
      n.className = "item-num";
      n.textContent = "Пункт " + num(i);
      const st = document.createElement("span");
      st.textContent = it.status;
      st.style.color = STATUS_COLORS[it.status] || "#8A93AD";
      top.append(n, st);

      const text = document.createElement("div");
      text.className = "item-text";
      text.textContent = it.text;

      const actions = document.createElement("div");
      actions.className = "item-actions";
      const bEdit = document.createElement("button");
      bEdit.className = "btn btn-ghost";
      bEdit.textContent = "Редактировать";
      bEdit.onclick = (e) => { e.stopPropagation(); startEdit(it); };
      const bDel = document.createElement("button");
      bDel.className = "btn btn-ghost btn-danger";
      bDel.textContent = "Удалить";
      bDel.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm("Удалить рекламацию «Пункт " + num(i) + "»?")) return;
        try {
          await api.remove(it.id);
          if (state.editingId === it.id) resetEditor();
          await reload(Math.min(state.i, state.items.length - 2));
        } catch (err) { showError(err.message); }
      };
      actions.append(bEdit, bDel);

      li.append(top, text, actions);
      li.onclick = () => { select(i); closeDrawer(); };
      els.itemList.appendChild(li);
    });
  }

  function renderAll() {
    renderStage();
    renderControls();
    renderList();
  }

  // ── действия ───────────────────────────────────────────
  function select(i) {
    speech.stop();
    state.i = Math.max(0, Math.min(i, state.items.length - 1));
    renderAll();
  }

  function go(d) {
    if (!state.items.length) return;
    const wasPlaying = (state.playing && !state.paused) || speech.phase === "loading";
    speech.stop();
    state.i = (state.i + d + state.items.length) % state.items.length;
    renderAll();
    if (wasPlaying) speech.speak();
  }

  async function reload(keepIndex = state.i) {
    state.items = await api.list();
    state.i = Math.max(0, Math.min(keepIndex, state.items.length - 1));
    renderAll();
  }

  // ── редактор ───────────────────────────────────────────
  function showError(msg) {
    els.editorError.textContent = msg;
    els.editorError.hidden = false;
  }

  function resetEditor() {
    state.editingId = null;
    els.editorForm.reset();
    els.editorTitle.textContent = "Новая рекламация";
    els.btnCancelEdit.hidden = true;
    els.editorError.hidden = true;
  }

  function startEdit(it) {
    state.editingId = it.id;
    els.editorTitle.textContent = "Редактирование";
    els.fText.value = it.text;
    els.fProblem.value = it.problem;
    els.fLevel.value = it.level;
    els.fStatus.value = it.status;
    els.btnCancelEdit.hidden = false;
    els.editorError.hidden = true;
    els.fText.focus();
  }

  els.editorForm.onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
      text: els.fText.value.trim(),
      problem: els.fProblem.value.trim(),
      level: els.fLevel.value,
      status: els.fStatus.value
    };
    if (!payload.text) return showError("текст рекламации не может быть пустым");
    try {
      const editing = state.editingId;
      await api.save(payload, editing);
      resetEditor();
      if (editing) {
        await reload();
      } else {
        await reload(1e9); // перейти к добавленной (последней) рекламации
      }
    } catch (err) { showError(err.message); }
  };

  els.btnCancelEdit.onclick = resetEditor;

  // ── панель рекламаций ──────────────────────────────────
  function openDrawer() {
    els.drawer.hidden = false;
    els.drawerBackdrop.hidden = false;
    renderList();
  }

  function closeDrawer() {
    els.drawer.hidden = true;
    els.drawerBackdrop.hidden = true;
  }

  els.btnManage.onclick = openDrawer;
  els.btnCloseDrawer.onclick = closeDrawer;
  els.drawerBackdrop.onclick = closeDrawer;

  // ── кнопки и клавиатура ────────────────────────────────
  els.btnSpeak.onclick = () => speech.toggle();
  els.btnStop.onclick = () => speech.stop();
  els.btnPrev.onclick = () => go(-1);
  els.btnNext.onclick = () => go(1);

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.code === "Space") { e.preventDefault(); speech.toggle(); }
    else if (e.code === "ArrowRight") go(1);
    else if (e.code === "ArrowLeft") go(-1);
    else if (e.code === "Escape") closeDrawer();
  });

  window.addEventListener("beforeunload", () => {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  });

  // ── старт ──────────────────────────────────────────────
  reload(0)
    .catch(() => {
      els.emptyHint.hidden = false;
      els.emptyHint.textContent = "Не удалось загрузить рекламации — проверьте, запущен ли сервер.";
      els.stage.style.visibility = "hidden";
    })
    .finally(() => requestAnimationFrame(rings.loop));
})();
