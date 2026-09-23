// Shared real-DOM checks for Chromium and the native WKWebView fixture.
export async function checkWindowsDOM({ DesktopWindows }) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const until = async predicate => {
    for (let i = 0; i < 80; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Window geometry did not settle');
  };
  const key = 'pi-desktop:layout:v1', saved = localStorage.getItem(key);
  localStorage.removeItem(key);
  const desktop = document.createElement('main'), tasks = document.createElement('footer');
  const mobile = matchMedia('(max-width:760px)').matches;
  desktop.style.cssText = `position:relative;width:${mobile ? '100%' : '1200px'};height:760px;`;
  document.body.append(desktop, tasks);
  const engine = new DesktopWindows(desktop, tasks);
  try {
    const main = engine.add({ id: 'main', kind: 'main', title: 'Main' });
    const input = document.createElement('textarea'); main.body.append(input);
    const initial = JSON.stringify(main.rect); input.focus(); assert(JSON.stringify(main.rect) === initial, 'typing does not resize controls');
    if (mobile) {
      const preferred = JSON.stringify(main.layoutRect);
      assert(engine.autoSize(main) === false, 'mobile uses stacked sizing');
      engine.resize(); assert(JSON.stringify(main.layoutRect) === preferred, 'mobile does not overwrite desktop preference');
      return 'mobile stacked layout preserves sizing preference';
    }
    assert(main.sizeMode === 'auto' && main.rect.w === 610, 'main opens at its roomy width');
    engine.place(main, { x: 20, y: 20, w: 380, h: 340 });
    assert(main.rect.w === 380 && main.rect.h === 340, 'main shrinks below the old 610x440 floor');
    engine.place(main, { x: 20, y: 20, w: 100, h: 100 });
    assert(main.rect.w === 360 && main.rect.h === 320, 'main floor is 360x320');
    engine.arrange(); main.task.click();
    assert(main.rect.w === 610 && main.rect.h === 456, 'Arrange fits main back to its roomy opening size');
    assert(!main.element.querySelector('[aria-label="Zoom to working size"]'), 'no separate sizing button');
    const child = engine.add({ id: 'child', kind: 'subagent', title: 'Child' });
    const observer = engine.add({ id: 'observer', kind: 'delegated', title: 'Observer' });
    assert(child.sizeMode === 'auto' && observer.sizeMode === 'auto', 'children and observers fit on creation');
    assert(main.rect.w === 610 && observer.rect.w === 400 && child.rect.w === 360, 'opening widths stay purpose-specific: main 610, observer 400, child 360');
    // Every kind bottoms out at the main 360x320 floor.
    engine.place(child, { x: 40, y: 120, w: 120, h: 90 });
    assert(child.rect.w === 360 && child.rect.h === 320, 'manual children share the main floor');
    engine.place(observer, { x: 600, y: 120, w: 120, h: 90 });
    assert(observer.rect.w === 360 && observer.rect.h === 320, 'delegated observers share the main floor');
    const dimensions = new Set();
    for (const id of ['models', 'providers', 'workspace', 'git', 'usage', 'sessions', 'activity', 'tools', 'background']) {
      const win = engine.add({ id, kind: 'utility', title: id, hidden: true });
      win.task.click();
      assert(win.sizeMode === 'auto' && win.rect.w === 400 && win.rect.h === 456, id + ' opens at minimum width and medium height');
      dimensions.add(win.rect.w + '/' + win.rect.h);
      win.element.querySelector('[aria-label="Close utility window"]').click(); assert(win.element.hidden, id + ' close remains hide');
    }
    assert(dimensions.size === 1 && [...dimensions][0] === '400/456', 'opening size is uniform: minimum width, medium height');
    const presets = new Set(['models', 'providers', 'workspace', 'git', 'usage', 'sessions', 'activity', 'tools', 'background'].map(id => { const rect = engine.defaultRect('utility', 0, id); return rect.w + '/' + rect.h; }));
    assert(presets.size === 9, 'compact presets stay purpose-specific');
    const models = engine.windows.get('models'); engine.show(models.id);
    const fixedWidth = models.rect.w, tall = models.rect.h;
    // Intentionally no synthetic window.resize: ResizeObserver must notice the container.
    desktop.style.width = '800px'; desktop.style.height = '560px';
    await until(() => models.rect.h < tall); assert(models.sizeMode === 'auto' && models.rect.w === fixedWidth, 'narrow fit stays automatic at the minimum width');
    desktop.style.width = '1200px'; desktop.style.height = '760px';
    await until(() => models.rect.h === tall);
    engine.place(models, { x: 25, y: 30, w: 700, h: 500 }); engine.save();
    desktop.style.width = '1000px'; await until(() => desktop.clientWidth === 1000);
    engine.resize(); assert(models.rect.w === 700 && models.sizeMode === 'manual', 'manual sizes win');
    engine.hide(models.id); const focus = engine.focused;
    desktop.style.width = '1200px'; engine.resize();
    assert(models.element.hidden && engine.focused === focus, 'native resize neither reveals nor focuses hidden windows');
    models.task.click(); assert(models.rect.w === 700, 'hide/show keeps manual geometry');
    engine.arrange(); models.task.click(); assert(models.sizeMode === 'auto' && models.rect.w === fixedWidth, 'Arrange resets old/manual geometry for automatic fitting');
    assert(JSON.parse(localStorage.getItem(key)).models.sizeMode === 'auto', 'auto intent is persisted');
    main.task.click();
    const beforeMax = main.rect.w;
    const maximize = main.element.querySelector('[aria-label="Maximize or restore main window"]');
    maximize.click(); maximize.click(); assert(main.sizeMode === 'auto' && main.rect.w === beforeMax, 'maximize/restore preserves automatic intent');
    engine.arrange(); assert([...engine.windows.values()].every(win => win.sizeMode === 'compact'), 'Arrange resets sizing intent');
    engine.place(engine.windows.get('tools'), { x: 60, y: 200, w: 100, h: 90 });
    const tools = engine.windows.get('tools').rect;
    assert(tools.w === 360 && tools.h === 320, 'utilities share the main floor');
    return 'roomy opening with a shared 360x320 floor, purpose-specific compact presets, native/container resize recovery, manual/hidden/focus preservation, maximize and Arrange passed';
  } finally {
    engine.destroy(); desktop.remove(); tasks.remove();
    if (saved === null) localStorage.removeItem(key); else localStorage.setItem(key, saved);
  }
}
