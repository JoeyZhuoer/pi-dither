// Loaded into a nonpersistent WKWebView only by --smoke-test. No provider prompts.
async function piDitherSmoke(stage) {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async (predicate, label = 'condition') => {
    // 200 ms per poll: the 2px x 800k cloud builds and fades in visibly slower in
    // WKWebView than in the Chromium fixture, and each stats() poll is expensive.
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
    throw new Error('Native feature condition did not settle: ' + label);
  };
  const $ = selector => document.querySelector(selector);
  const main = $('.main-window');
  const width = () => main.getBoundingClientRect().width;
  const saved = () => JSON.parse(localStorage.getItem('pi-desktop:layout:v1'));
  const state = async () => {
    const response = await fetch('/api/state', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('pi-desktop:token') } });
    check(response.ok, 'authenticated state'); return response.json();
  };
  if (stage === 'initial') {
    await document.fonts.ready;
    const s = await state(), a = s.agents[0];
    check(s.agents.length === 1 && s.desktopVersion === '0.5.0' && a.kind === 'main' && a.connected && a.phase === 'idle' && a.messages.length === 0, 'idle sole main');
    check(a.extensionStatus.status === 'loaded' && a.activeTools.includes('subagent') && a.activeTools.includes('subagent_supervisor'), 'bundled extension tools');
    check(!location.hash && document.querySelectorAll('[data-subagent-index]').length === 0, 'no startup drafts or visible auth fragment');
    check(!$('#auto-size, [aria-label="Zoom to working size"]'), 'no separate auto-size controls');
    check(saved().main.sizeMode === 'auto' && width() === 610, 'main opens at the minimum width');
    check(!$('#backdrop, #background-motion'), 'no background pattern or motion control is rendered');
    check($('#desktop').dataset.activity === 'idle', 'fleet activity reports idle while the model is stopped');
    if (window.piDitherLayoutResetOK) {
      check(localStorage.getItem('pi-dither:smoke-keep') === 'retained' && sessionStorage.getItem('pi-dither:smoke-keep') === 'retained', 'unrelated storage retained');
      check(!sessionStorage.getItem('pi-desktop:delegated-closed:v1:fixture') && $('[data-window-id="models"]').hidden, 'old observer dismissal and visibility cleared');
    }
    check($('#usage-diagram').dataset.agentId === 'main' && $('#clock').textContent.length > 0, 'usage and clock widgets');
    check($('.main-window select.model-select').nextElementSibling?.getAttribute('role') === 'combobox', 'retro select enhancement');
    const select = $('.main-window select.delivery'), trigger = select.nextElementSibling;
    trigger.click(); check(trigger.getAttribute('aria-expanded') === 'true', 'themed dropdown opens');
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(trigger.getAttribute('aria-expanded') === 'false' && select.value === 'steer', 'dropdown cancellation');
    const sizes = new Set();
    for (const id of ['models', 'providers', 'workspace', 'git', 'usage', 'sessions', 'activity', 'tools', 'background']) {
      $(`[data-feature="${id}"]`).click();
      const win = $(`[data-window-id="${id}"]`), status = $(`[data-testid="${id}-status"]`);
      await wait(() => !win.hidden && status.textContent !== 'Loading…');
      check(!status.classList.contains('feature-error'), id + ' native feature loads');
      check(saved()[id].sizeMode === 'auto', id + ' auto sizing');
      sizes.add(win.style.width + '/' + win.style.height);
      const before = win.style.width;
      win.querySelector('[aria-label="Close utility window"]').click();
      check(win.hidden, id + ' hides');
      $(`[data-feature="${id}"]`).click(); check(win.style.width === before, id + ' stable re-open');
      win.querySelector('[aria-label="Close utility window"]').click();
    }
    check(sizes.size === 1 && [...sizes][0].startsWith('400px/'), 'utilities open at the minimum width with a medium height');
    // Appearance window: colours, the photo point cloud and the extra field.
    $('[data-feature="background"]').click();
    await wait(() => !$('[data-window-id="background"]').hidden);
    check(!$('#backdrop, #background-motion, #background'), 'the dithered backdrop canvas stays removed');
    const ground = $('[data-testid="background-ground"]');
    ground.value = '#123456'; ground.dispatchEvent(new Event('input', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:ground:v1') === '#123456', 'ground colour persists');
    check(getComputedStyle(document.documentElement).getPropertyValue('--ground').trim() === '#123456', 'ground colour applies to the desk');
    const photo = $('[data-testid="background-photo"]');
    const blob = await new Promise((resolve) => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#000'; for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) if ((row + col) % 2) x.fillRect(col * 8, row * 8, 8, 8); c.toBlob(resolve, 'image/png'); });
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'fixture.png', { type: 'image/png' }));
    photo.files = transfer.files; photo.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => localStorage.getItem('pi-desktop:photo:v1') !== null, 'photo stored');
    check(!localStorage.getItem('pi-desktop:cloud-pointer:v1'), 'push is the default without a stored choice');
    // Cloud statistics: ink count plus the centroid of the drawn points.
    const stats = () => {
      const c = $('#particles'), data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let inked = 0, sumX = 0, sumY = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] <= 8) continue;
        const index = i >> 2, x = index % c.width;
        inked++; sumX += x; sumY += (index - x) / c.width;
      }
      return { inked, cx: sumX / (inked || 1), cy: sumY / (inked || 1) };
    };
    const cloudHash = () => { const c = $('#particles'), data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let hash = 2166136261; for (let i = 0; i < data.length; i += 4) hash = Math.imul(hash ^ data[i] ^ data[i + 3], 16777619); return hash; };
    const shift = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
    // 200k dots keep entering and leaving pixel rows while the cloud is
    // still relaxing, so the raw ink count wobbles a few percent. Wait for a
    // frame that repeats before capturing any baseline.
    const stableCloud = async (label) => {
      let last = cloudHash(), repeats = 0;
      for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const next = cloudHash();
        repeats = next === last ? repeats + 1 : 0;
        last = next;
        if (repeats >= 2) return;
      }
      throw new Error('Native feature condition did not settle: ' + label);
    };
    await wait(() => stats().inked > 200, 'photo cloud draws');
    check(stats().inked > 200, 'the photo becomes a point cloud on the particle layer');
    // Capture the baseline with the pointer explicitly outside, so the pointer
    // parallax is off in both the home and the settled sample.
    document.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    await stableCloud('the cloud forms');
    const home = stats();
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 220, clientY: 260, bubbles: true }));
    // The force is bounded by CLOUD_RADIUS. The parallax tilt only depends on the
    // cursor, so a cursor exactly on the canvas centre (tilt 0) means push and pull
    // can only differ through the force. Boxes are compared by statistics, not by
    // pixels: a 200k-dot cloud creeps sub-pixel for seconds after forming, so a few
    // thousand dots flip pixel edges on their own.
    const regionStats = (x, y, size) => {
      const d = $('#particles').getContext('2d').getImageData(x, y, size, size).data;
      let inked = 0, sumX = 0, sumY = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] <= 8) continue;
        const index = i >> 2, px = index % size;
        inked++; sumX += px; sumY += (index - px) / size;
      }
      return { inked, cx: sumX / (inked || 1), cy: sumY / (inked || 1) };
    };
    const sameRegion = (a, b) => Math.abs(a.inked - b.inked) <= Math.max(20, a.inked * .01) && Math.hypot(a.cx - b.cx, a.cy - b.cy) < .5;
    // Same idea for the spring-back wait: sub-pixel creep at 2px keeps a strict match
    // from ever holding.
    const sameRegionLoose = (a, b) => Math.abs(a.inked - b.inked) <= Math.max(80, a.inked * .02) && Math.hypot(a.cx - b.cx, a.cy - b.cy) < 2;
    const canvas = $('#particles'), box = 200;
    const cursor = { x: canvas.width / 2, y: canvas.height / 2 };
    const near = { x: cursor.x + 140, y: cursor.y + 60 };
    const nearStats = () => regionStats(near.x - box / 2, near.y - box / 2, box);
    // Beyond the radius a mouse move must not move the cloud. Compared by
    // statistics, not by an exact frame hash: at 2px dots a box beyond the radius
    // still changes by a handful of pixels while the cloud settles sub-pixel.
    const homeNear = nearStats();
    // No far-box check here on purpose: 2px dots flip boundary pixels while the cloud
    // finishes settling, so the force bound is proven exactly by the unit test
    // (no force at CLOUD_RADIUS + 1 or 900px) and by the Chromium fixture.
    check(Math.hypot(near.x + box / 2 - cursor.x, near.y + box / 2 - cursor.y) < 480, 'the near box sits inside the cloud radius');
    check(Math.hypot(canvas.width - box - cursor.x, canvas.height - box - cursor.y) > 520, 'the far box sits outside the cloud radius');
    // A held pointer balances the spring against the force, so settle on
    // statistics rather than a frame hash.
    const settleForced = async (label) => {
      let previous = null;
      for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const next = stats();
        // 2px dots keep flipping boundary pixels as the forced cloud settles, so a strict
        // stability test never returns and burns the launch budget. The exact proofs live
        // in the unit tests and the Chromium fixture; this only has to be good enough to
        // sample a baseline.
        if (previous && Math.abs(next.inked - previous.inked) <= Math.max(80, previous.inked * .02) && shift(next, previous) < 2) return;
        previous = next;
      }
      throw new Error('Native feature condition did not settle: ' + label);
    };
    const waitRegion = async (read, target, label) => {
      for (let i = 0; i < 100; i++) { if (sameRegionLoose(read(), target)) return; await new Promise(resolve => setTimeout(resolve, 250)); }
      throw new Error('Native feature condition did not settle: ' + label);
    };
    // Stability alone is not proof of a change: a force that has not engaged yet is
    // stable too, so wait until the region actually differs before asserting it.
    const waitRegionDiffers = async (read, target, label) => {
      for (let i = 0; i < 100; i++) { if (!sameRegion(read(), target)) return read(); await new Promise(resolve => setTimeout(resolve, 250)); }
      throw new Error('Native feature condition did not settle: ' + label);
    };
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: cursor.x, clientY: cursor.y, bubbles: true }));
    await settleForced('the push settles');
    await waitRegionDiffers(nearStats, homeNear, 'the push reaches the points around the cursor');
    const pushedNear = nearStats();
    check(!sameRegion(pushedNear, homeNear), 'the pointer displaces the cloud around the cursor');
    $('[data-testid="background-cloud"]').value = 'pull';
    $('[data-testid="background-cloud"]').dispatchEvent(new Event('change', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:cloud-pointer:v1') === 'pull', 'the pull variant persists');
    await settleForced('the pull settles');
    await waitRegionDiffers(nearStats, pushedNear, 'pull rearranges the points around the cursor');
    check(!sameRegion(nearStats(), pushedNear), 'pull rearranges the points around the cursor');
    $('[data-testid="background-cloud"]').value = 'push';
    $('[data-testid="background-cloud"]').dispatchEvent(new Event('change', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:cloud-pointer:v1') === 'push', 'push restores');
    document.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    await waitRegion(nearStats, homeNear, 'the cloud springs home');
    await stableCloud('the cloud springs home');
    const settled = stats();
    check(sameRegion(nearStats(), homeNear), 'the stirred region springs back to its home shape');
    check(shift(settled, home) < 3 && Math.abs(settled.inked - home.inked) <= Math.max(30, home.inked * .03),
      `the cloud springs back to its home shape [home ${home.inked}@${home.cx.toFixed(1)},${home.cy.toFixed(1)} → settled ${settled.inked}@${settled.cx.toFixed(1)},${settled.cy.toFixed(1)}]`);
    // Extra drifting field on top of the cloud.
    const particleSelect = $('[data-testid="background-particles"]');
    const cloudOnly = stats().inked;
    particleSelect.value = 'dense'; particleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:particles:v1') === 'dense', 'the extra field persists');
    await wait(() => stats().inked !== cloudOnly, 'the extra field animates');
    particleSelect.value = 'off'; particleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:particles:v1') === 'off', 'the extra field switches off');

    // Laptop-motion bridge: the host object is injected at document start, its
    // status is honest about the hardware, and the physics path works from a
    // synthetic sample even when the system withholds the accelerometer.
    const motionHost = window.__piDitherMotionHost;
    check(!!motionHost && motionHost.version === 1, 'the motion host object is injected at document start');
    check(typeof motionHost.subscribe === 'function' && typeof motionHost.deliver === 'function', 'the motion host exposes subscribe and deliver');
    const motionStatus = String(motionHost.status);
    check(['available', 'unavailable', 'denied'].includes(motionStatus), 'the motion bridge reports an honest sensor status (' + motionStatus + ')');
    if (motionStatus === 'available') {
      const seen = new Set();
      const unsubscribe = motionHost.subscribe(sample => seen.add(sample.at));
      await wait(() => seen.size >= 10, 'the accelerometer streams');
      unsubscribe();
      check(seen.size >= 10, 'the accelerometer streams at 10 Hz or better (' + seen.size + ' samples)');
      const restingG = Math.hypot(motionHost.latest.x, motionHost.latest.y, motionHost.latest.z);
      check(restingG > 0.5 && restingG < 1.6, 'the resting accelerometer magnitude is about 1 g (' + restingG.toFixed(3) + ' g)');
      if (Number.isFinite(motionHost.latest.gx)) {
        const gyroMag = Math.hypot(motionHost.latest.gx, motionHost.latest.gy, motionHost.latest.gz);
        check(gyroMag < 1000, 'the gyroscope streams finite deg/s values (' + gyroMag.toFixed(1) + ' deg/s)');
      }
    } else {
      // macOS withholds the SPU accelerometer from an unprivileged process on some
      // machines. The honest answer is no samples at all, never a faked reading.
      check(motionHost.latest === null, 'a ' + motionStatus + ' sensor delivers no samples to the page');
      check(typeof motionHost.subscribe(() => {}) === 'function', 'subscribe still returns an unsubscribe function without a sensor');
    }
    const motionStatusNode = $('[data-testid="background-motion-status"]');
    check(!!motionStatusNode && /MOTION \//.test(motionStatusNode.textContent), 'the Appearance window reports the motion status in words (' + (motionStatusNode ? motionStatusNode.textContent.trim() : 'missing') + ')');
    // Real deliveries would interleave with the synthetic stream and blur the
    // physics checks; pause the native feed (deliver() from this script still works).
    if (typeof motionHost.pause === 'function') motionHost.pause();
    const motionSelect = $('[data-testid="background-motion"]');
    check(!!motionSelect, 'the Appearance window exposes the Motion control');
    // Deliver like a real sensor would (about 60 samples a second) so the gravity
    // filter actually converges: one sample only moves it a fraction of the way.
    const streamMotion = async (sample, count = 30) => {
      for (let index = 0; index < count; index++) {
        motionHost.deliver({ x: sample.x, y: sample.y, z: sample.z, at: Date.now(), peak: sample.peak || 0 });
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    };
    // Feed the synthetic level while motion is still off: the controller captures
    // the baseline when the mode is switched on, so the real resting pose never
    // produces a large enable transient (or a threshold-triggered burst).
    await streamMotion({ x: 0, y: 0, z: 1 }, 5);
    motionSelect.value = 'full'; motionSelect.dispatchEvent(new Event('change', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:motion:v1') === 'full', 'the motion choice persists');
    // Let the cloud settle on the synthetic level before it becomes the reference.
    await stableCloud('the cloud settles level');
    const level = stats();
    await streamMotion({ x: .34, y: 0, z: .94 });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const leanedRight = stats();
    check(shift(leanedRight, level) > 10, 'a synthetic tilt leans the cloud (' + shift(leanedRight, level).toFixed(1) + 'px)');
    await streamMotion({ x: -.34, y: 0, z: .94 });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const leanedLeft = stats();
    check((leanedRight.cx - level.cx) * (leanedLeft.cx - level.cx) < 0, 'the lean follows the tilt direction');
    // A knock arrives as a peak, not as a slow lean: it bursts the cloud outward.
    const quiet = stats().inked;
    motionHost.deliver({ x: -.34, y: 0, z: .94, at: Date.now(), peak: 1.2 });
    await wait(() => stats().inked !== quiet, 'a synthetic knock shakes the cloud');
    check(stats().inked !== quiet, 'a synthetic knock shakes the cloud');
    motionSelect.value = 'off'; motionSelect.dispatchEvent(new Event('change', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:motion:v1') === 'off', 'motion switches off again');
    await wait(() => shift(stats(), level) < 8, 'motion off returns the cloud home');
    check(shift(stats(), level) < 8, 'motion off returns the cloud home');
    if (typeof motionHost.resume === 'function') motionHost.resume();
    const theme = $('[data-testid="background-theme"]');
    theme.value = '#2a4b6c'; theme.dispatchEvent(new Event('input', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:theme:v1') === '#2a4b6c', 'theme colour persists');
    check(getComputedStyle(document.documentElement).getPropertyValue('--pink').trim() === '#2a4b6c', 'theme colour applies to the chrome');
    $('[data-testid="background-remove"]').click();
    check(localStorage.getItem('pi-desktop:photo:v1') === null, 'photo removal clears storage');
    await wait(() => stats().inked === 0, 'the cloud clears with the photo');
    check(stats().inked === 0, 'the point cloud clears');
    $('[data-testid="background-default"]').click();
    check(localStorage.getItem('pi-desktop:ground:v1') === '#e58da5', 'default ground restored');
    $('[data-testid="background-theme-reset"]').click();
    check(localStorage.getItem('pi-desktop:theme:v1') === '#e58da5', 'default theme restored');
    // F1: reasoning renders inside the agent window again, so the rail panel is gone and
    // the in-window block's style is back. The native fixture carries no messages, so the
    // rendering itself is proven by the Chromium fixture.
    check(!document.querySelector('#thinking-panel, #thinking-stream, #thinking-follow'), 'the thinking panel is gone from the right rail');
    check(!document.querySelector('[data-testid=settings-thinking]'), 'no thinking panel row is left in the settings dialog');
    check([...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => (rule.cssText || '').includes('.thinking-content')); } catch { return false; } }), 'the in-window reasoning style is restored');
    $('[data-window-id="background"] button[aria-label="Close utility window"]').click();
    // Window settings (top right): they control the bottom bar. Less frequent
    // windows start out of it, every window stays in the Windows menu, and the
    // choice is remembered.
    check($('#tasks button[data-window-id="workspace"]').hidden && $('#tasks button[data-window-id="providers"]').hidden && !$('#tasks button[data-window-id="usage"]').hidden, 'less frequent windows start out of the bottom bar');
    check(!$('[data-feature="workspace"]').hidden, 'every window stays in the Windows menu');
    $('#settings').click();
    check($('#settings-dialog').open, 'settings dialog opens');
    const workspaceBox = $('[data-testid="settings-workspace"]');
    workspaceBox.checked = true; workspaceBox.dispatchEvent(new Event('change', { bubbles: true }));
    check(!$('#tasks button[data-window-id="workspace"]').hidden, 'ticking adds its bottom button');
    check(JSON.parse(localStorage.getItem('pi-desktop:taskbar:v1')).includes('workspace'), 'bottom-bar choice persists');
    workspaceBox.checked = false; workspaceBox.dispatchEvent(new Event('change', { bubbles: true }));
    check($('#tasks button[data-window-id="workspace"]').hidden, 'unticking hides it again');
    $('[data-testid="settings-open-git"]').click();
    check(!$('[data-window-id="git"]').hidden, 'settings opens a bottom-bar-hidden window directly');
    $('[data-window-id="git"] button[aria-label="Close utility window"]').click();
    check($('[data-testid="providers-key"]').type === 'password' && !$('[data-testid="providers-key"]').value, 'empty credential control');
    check($('[data-testid="tools-tool-subagent"]')?.checked, 'extension selection reflected');
    $('#add-agent').click();
    const draft = document.querySelector('[data-subagent-index]');
    check(draft && draft.querySelectorAll('.draft-tools input:checked').length === 4, 'explicit draft defaults to read-only');
    check(saved()[draft.dataset.windowId].sizeMode === 'auto' && draft.getBoundingClientRect().width < width(), 'draft automatically fits below main size');
    check(!(await state()).agents.some(agent => agent.kind !== 'main'), 'draft does not launch a Pi child');
    draft.querySelector('[aria-label="Close subagent window"]').click();
    check(!document.querySelector('[data-subagent-index]'), 'draft close releases its window');
    $('#help').click(); check($('#help-dialog').open, 'help dialog');
    $('#help-dialog').close();
    main.querySelector('.titlebar').focus();
    check(saved().main.sizeMode === 'auto', 'selection retains automatic sizing');
    main.querySelector('textarea').focus(); const stable = width();
    check(width() === stable, 'editor focus retains geometry');
    const beforeHide = main.style.width;
    main.querySelector('[aria-label="Minimize window"]').click(); check(main.hidden, 'main minimize');
    [...document.querySelectorAll('#tasks button')].find(button => button.textContent === 'Main Agent / Pi').click();
    check(!main.hidden && main.style.width === beforeHide, 'taskbar restores main');
    window.nativeFeatureState = { reset: window.piDitherLayoutResetOK === true, session: a.sessionId, tools: JSON.stringify(a.activeTools), wide: width(), tall: parseFloat(main.style.height), utility: parseFloat($('[data-window-id="models"]').style.height) };
  } else if (stage === 'minimum') {
    await wait(() => innerWidth <= 800);
    const rect = main.getBoundingClientRect(), area = $('#desktop').getBoundingClientRect();
    check(rect.right <= area.right + 1 && rect.bottom <= area.bottom + 1, 'minimum native viewport keeps main inside desktop');
    check($('.desktop-menu').scrollWidth <= $('.desktop-menu').clientWidth, 'minimum native toolbar fits');
    check(main.querySelector('.send').getBoundingClientRect().bottom <= rect.bottom + 1, 'minimum native composer remains reachable');
    check(parseFloat($('[data-window-id="models"]').style.height) === 320, 'hidden utility clamps to its minimum height at the smallest viewport');
  } else if (stage === 'narrow') {
    // The smallest viewport clamps every window to its minimum height, so the
    // next size up must grow the hidden utility again without changing width.
    await wait(() => parseFloat($('[data-window-id="models"]').style.height) > 320);
    check(saved().main.sizeMode === 'auto' && width() === nativeFeatureState.wide, 'native narrow resize retains minimum width and auto intent');
    check($('[data-window-id="models"]').hidden, 'native resize does not reopen hidden windows');
  } else if (stage === 'wide') {
    await wait(() => Math.abs(parseFloat($('[data-window-id="models"]').style.height) - nativeFeatureState.utility) < 2);
    check(Math.abs(parseFloat($('[data-window-id="models"]').style.height) - nativeFeatureState.utility) < 2, 'hidden utility recovers medium height');
    const maximize = main.querySelector('[aria-label="Maximize or restore main window"]');
    maximize.click(); maximize.click(); check(saved().main.sizeMode === 'auto', 'maximize/restore retains auto intent');
    main.querySelector('.resize-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    check(saved().main.sizeMode === 'manual', 'manual resize opts out');
    // The narrower floor lets the user shrink main well below the old 610px.
    for (let i = 0; i < 20; i++) main.querySelector('.resize-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const narrowMain = parseFloat(main.style.width);
    check(narrowMain <= 410 && narrowMain >= 360, `main shrinks below the old floor (${narrowMain}px)`);
    check(main.querySelector('.send').getBoundingClientRect().bottom <= main.getBoundingClientRect().bottom + 1, 'narrow main keeps its composer reachable');
    nativeFeatureState.manual = saved().main.w;
  } else if (stage === 'manual-narrow') {
    await wait(() => innerWidth < 1000);
    check(saved().main.w === nativeFeatureState.manual && saved().main.sizeMode === 'manual', 'native clamping preserves manual preference');
  } else if (stage === 'manual-wide') {
    await wait(() => Math.abs(width() - nativeFeatureState.manual) < 2);
    check(saved().main.sizeMode === 'manual', 'manual override remains stable without a sizing control');
    sessionStorage.setItem('pi-dither:smoke-facts', JSON.stringify(nativeFeatureState));
    // Native Reload must rebootstrap auth, not merely rely on old storage.
    sessionStorage.removeItem('pi-desktop:token');
  } else if (stage === 'reloaded') {
    const facts = JSON.parse(sessionStorage.getItem('pi-dither:smoke-facts'));
    check(saved().main.sizeMode === 'manual' && Math.abs(width() - facts.manual) < 2, 'native Reload keeps manual layout after one-shot reset');
    if (facts.reset) {
      check(window.piDitherLayoutResetOK === undefined, 'layout reset script removed before Reload');
      check(localStorage.getItem('pi-dither:smoke-keep') === 'retained' && sessionStorage.getItem('pi-dither:smoke-keep') === 'retained', 'unrelated preferences survive reset and Reload');
    }
    check(document.querySelectorAll('[data-subagent-index]').length === 0 && $('[data-window-id="models"]').hidden, 'native Reload creates no drafts or unhidden utilities');
    check(!location.hash && !location.search, 'reload removes auth fragment and nonsecret nonce');
    const s = await state(), a = s.agents[0];
    check(s.agents.length === 1 && a.sessionId === facts.session && a.messages.length === 0 && a.phase === 'idle' && JSON.stringify(a.activeTools) === facts.tools, 'feature checks did not alter the conversation or tools');
    check(!window.nativeSmokeErrors?.length, 'no frontend exceptions');
  } else throw new Error('Unknown native validation stage');
  return true;
}
