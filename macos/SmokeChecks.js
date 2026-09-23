// Loaded into a nonpersistent WKWebView only by --smoke-test. No provider prompts.
async function piDitherSmoke(stage) {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async (predicate, label = 'condition') => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
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
    check(s.agents.length === 1 && s.desktopVersion === '0.4.0' && a.kind === 'main' && a.connected && a.phase === 'idle' && a.messages.length === 0, 'idle sole main');
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
    const blob = await new Promise((resolve) => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#fff'; x.beginPath(); x.arc(32, 32, 20, 0, Math.PI * 2); x.fill(); c.toBlob(resolve, 'image/png'); });
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'fixture.png', { type: 'image/png' }));
    photo.files = transfer.files; photo.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => localStorage.getItem('pi-desktop:photo:v1') !== null, 'photo stored');
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
    await wait(() => stats().inked > 200, 'photo cloud draws');
    check(stats().inked > 200, 'the photo becomes a point cloud on the particle layer');
    await new Promise(resolve => setTimeout(resolve, 2500));
    const home = stats();
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 220, clientY: 260, bubbles: true }));
    await wait(() => shift(stats(), home) > 2, 'the pointer pushes the cloud');
    check(shift(stats(), home) > 2, 'the pointer displaces the cloud');
    document.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    await wait(() => shift(stats(), home) < 3, 'the cloud springs home');
    check(shift(stats(), home) < 3 && Math.abs(stats().inked - home.inked) <= Math.max(30, home.inked * .03), 'the cloud springs back to its home shape');
    const settledHash = cloudHash();
    // The signed force switch mirrors the site's push/pull modes.
    check(!localStorage.getItem('pi-desktop:cloud-pointer:v1'), 'push is the default without a stored choice');
    const cloudSelect = $('[data-testid="background-cloud"]');
    cloudSelect.value = 'pull'; cloudSelect.dispatchEvent(new Event('change', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:cloud-pointer:v1') === 'pull', 'the pull variant persists');
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 220, clientY: 260, bubbles: true }));
    // The pull gathers mass toward the cursor, so compare pixels rather than the centroid.
    await wait(() => cloudHash() !== settledHash, 'pull moves the cloud');
    document.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    await wait(() => shift(stats(), home) < 3, 'pull springs home');
    cloudSelect.value = 'push'; cloudSelect.dispatchEvent(new Event('change', { bubbles: true }));
    // Extra drifting field on top of the cloud.
    const particleSelect = $('[data-testid="background-particles"]');
    const cloudOnly = stats().inked;
    particleSelect.value = 'dense'; particleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:particles:v1') === 'dense', 'the extra field persists');
    await wait(() => stats().inked !== cloudOnly, 'the extra field animates');
    particleSelect.value = 'off'; particleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    check(localStorage.getItem('pi-desktop:particles:v1') === 'off', 'the extra field switches off');
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
