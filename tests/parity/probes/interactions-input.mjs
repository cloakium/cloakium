// Trusted editing, form control, focus, pointer and drag interactions.
import {
  activeId,
  allTrusted,
  assertThat,
  assertTrusted,
  eventsOf,
  inputSummary,
  keySummary,
  pageProbe,
  readLog,
} from './interactions-support.mjs';
import {
  dragDropDoc,
  focusTabDoc,
  formControlsDoc,
  pointerScrollDoc,
  shortcutsDoc,
  typingDoc,
} from './interactions-fixtures.mjs';

const typing = pageProbe('interactions/typing-text', typingDoc, async ({ page }) => {
  const input = page.locator('#text');
  await input.click();
  await page.keyboard.type('ab c');
  const typedValue = await input.inputValue();

  const beforeInsert = await readLog(page);
  await page.keyboard.insertText('é中');
  const insertedValue = await input.inputValue();
  const afterInsert = await readLog(page);

  const keydownsBeforeInsert = eventsOf(beforeInsert, 'keydown').length;
  const keydownsAfterInsert = eventsOf(afterInsert, 'keydown').length;

  await page.keyboard.press('Control+a');
  await page.keyboard.type('XYZ');
  const replacedValue = await input.inputValue();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Q');

  const log = await readLog(page);
  const keydowns = eventsOf(log, 'keydown');
  const keyups = eventsOf(log, 'keyup');
  const beforeinput = eventsOf(log, 'beforeinput');
  const inputs = eventsOf(log, 'input');
  const selects = eventsOf(log, 'select');

  assertThat(typedValue === 'ab c', 'keyboard.type must insert text', typedValue);
  assertThat(insertedValue === 'ab cé中', 'keyboard.insertText must insert unicode text', insertedValue);
  assertThat(keydownsAfterInsert === keydownsBeforeInsert, 'insertText must not emit keydown', {
    keydownsBeforeInsert,
    keydownsAfterInsert,
  });
  assertThat(replacedValue === 'XYZ', 'Control+a and type must replace the field value', replacedValue);
  assertThat(await input.inputValue() === 'XQY', 'Backspace and ArrowLeft must edit deterministically', await input.inputValue());

  assertTrusted(keydowns, 'keydown');
  assertTrusted(keyups, 'keyup');
  assertTrusted(beforeinput, 'beforeinput');
  assertTrusted(inputs, 'input');
  assertTrusted(selects, 'select');

  return {
    typedValue,
    insertedValue,
    replacedValue,
    finalValue: await input.inputValue(),
    selection: await page.evaluate(() => {
      const field = document.getElementById('text');
      return [field.selectionStart, field.selectionEnd];
    }),
    keydownKeys: keydowns.map((entry) => entry.key),
    keyups: keySummary(log, 'keyup'),
    beforeinput: inputSummary(log, 'beforeinput'),
    inputs: inputSummary(log, 'input'),
    selects: eventsOf(log, 'select').map((entry) => ({ start: entry.start, end: entry.end, trusted: entry.trusted })),
    keydownsBeforeInsert,
    keydownsAfterInsert,
    inputTypes: [...new Set(inputs.map((entry) => entry.inputType))].sort(),
  };
});

const shortcuts = pageProbe('interactions/typing-shortcuts', shortcutsDoc, async ({ page }) => {
  const field = page.locator('#field');
  await field.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ab');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  const selected = await page.evaluate(() => {
    const input = document.getElementById('field');
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd };
  });
  await page.keyboard.type('Z');
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  const beforeDelete = await page.evaluate(() => {
    const input = document.getElementById('field');
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd };
  });
  await page.keyboard.press('Delete');
  await page.keyboard.type('go');
  const formPromise = page.waitForFunction(() => window.__submitted > 0);
  await page.keyboard.press('Enter');
  await formPromise;

  const log = await readLog(page);
  const keydowns = eventsOf(log, 'keydown');
  const inputs = eventsOf(log, 'input');
  const selects = eventsOf(log, 'select');
  const submitted = await page.evaluate(() => ({ count: window.__submitted, trusted: window.__submitTrusted }));

  assertThat(selected.value === 'ab' && selected.start === 0 && selected.end === 2, 'Shift+ArrowLeft must extend the selection', selected);
  assertThat(beforeDelete.value === 'Z' && beforeDelete.start === 0 && beforeDelete.end === 1, 'Home and Shift+ArrowRight must select the value', beforeDelete);
  assertThat(await field.inputValue() === 'go', 'Delete and typing must leave the expected value', await field.inputValue());
  assertThat(submitted.count === 1, 'Enter must submit the form once', submitted);
  assertThat(submitted.trusted === true, 'submit event must be trusted', submitted);
  assertTrusted(keydowns, 'keydown');
  assertTrusted(inputs, 'input');
  assertTrusted(selects, 'select');

  const shiftArrow = keydowns.filter((entry) => entry.key === 'ArrowLeft' && entry.shift === true);
  const controlA = keydowns.filter((entry) => entry.key === 'a' && entry.ctrl === true);
  assertThat(shiftArrow.length === 2, 'two Shift+ArrowLeft keydowns expected', shiftArrow);
  assertThat(controlA.length === 1, 'one Control+a keydown expected', controlA);

  return {
    selected,
    beforeDelete,
    finalValue: await field.inputValue(),
    submitted,
    status: await page.locator('#status').textContent(),
    controlA: controlA.map((entry) => ({ key: entry.key, code: entry.code, trusted: entry.trusted })),
    shiftArrow: shiftArrow.map((entry) => ({ key: entry.key, code: entry.code, shift: entry.shift, trusted: entry.trusted })),
    enter: keydowns.filter((entry) => entry.key === 'Enter').map((entry) => ({ code: entry.code, trusted: entry.trusted })),
    inputTypes: [...new Set(inputs.map((entry) => entry.inputType))].sort(),
    selectionEvents: selects.map((entry) => ({ start: entry.start, end: entry.end, trusted: entry.trusted })),
  };
});

const formControls = pageProbe('interactions/form-controls', formControlsDoc, async ({ page }) => {
  const check = page.locator('#check');
  await check.click();
  const checkedOn = await page.evaluate(() => document.getElementById('check').checked);
  await check.click();
  const checkedOff = await page.evaluate(() => document.getElementById('check').checked);

  await page.locator('#radio-a').click();
  const radioAFirst = await page.evaluate(() => document.getElementById('radio-a').checked);
  await page.locator('#radio-b').click();
  const radios = await page.evaluate(() => ({
    a: document.getElementById('radio-a').checked,
    b: document.getElementById('radio-b').checked,
    value: document.querySelector('input[name="group"]:checked').value,
  }));

  const select = page.locator('#select');
  await select.selectOption('c');
  const afterSelectOption = await page.evaluate(() => document.getElementById('select').value);
  const selectOptionChange = (await readLog(page)).filter((entry) => entry.type === 'change' && entry.id === 'select').at(-1);
  assertThat(selectOptionChange, 'selectOption must emit a change event');
  await select.focus();
  await page.keyboard.press('ArrowUp');
  const afterArrowUp = await page.evaluate(() => document.getElementById('select').value);
  const afterArrowLog = await readLog(page);
  const arrowChange = afterArrowLog.filter((entry) => entry.type === 'change' && entry.id === 'select').at(-1);
  const arrowInput = afterArrowLog.filter((entry) => entry.type === 'input' && entry.id === 'select').at(-1);
  assertThat(arrowChange && arrowInput, 'ArrowUp must emit input and change events for the select', { arrowChange, arrowInput });

  const range = page.locator('#range');
  await range.focus();
  await page.keyboard.press('ArrowRight');
  const rangeValue = await page.evaluate(() => document.getElementById('range').value);

  const textarea = page.locator('#ta');
  await textarea.click();
  await page.keyboard.type('line1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line2');
  const textareaValue = await textarea.inputValue();

  const log = await readLog(page);
  const changes = eventsOf(log, 'change');
  const inputs = eventsOf(log, 'input');
  const checkChanges = changes.filter((entry) => entry.id === 'check');
  const radioChange = changes.filter((entry) => entry.id === 'radio-b').at(-1);
  const textareaInputs = inputs.filter((entry) => entry.id === 'ta');

  assertThat(checkedOn === true && checkedOff === false, 'checkbox clicks must toggle checked state', { checkedOn, checkedOff });
  assertThat(radioAFirst === true && radios.a === false && radios.b === true && radios.value === 'b', 'radio group must switch on click', { radioAFirst, radios });
  assertThat(afterSelectOption === 'c', 'selectOption must set the select value', afterSelectOption);
  assertThat(afterArrowUp === 'b' && arrowChange.trusted === true, 'keyboard must change the select with a trusted change event', { afterArrowUp, arrowChange });
  assertThat(rangeValue === '6', 'ArrowRight must increment the range input', rangeValue);
  assertThat(textareaValue === 'line1\nline2', 'Enter must insert a textarea line break', textareaValue);
  assertThat(allTrusted(changes.filter((entry) => entry.id !== 'select')), 'change events from clicks and keyboard must be trusted', changes);
  assertThat(allTrusted(inputs.filter((entry) => entry.id !== 'select')), 'input events from clicks and keyboard must be trusted', inputs);
  assertThat(checkChanges.length === 2 && checkChanges[0].checked === true && checkChanges[1].checked === false, 'checkbox change sequence must be trusted and ordered', checkChanges);
  assertThat(radioChange.trusted === true && radioChange.checked === true, 'radio change must be trusted', radioChange);
  assertThat(textareaInputs.some((entry) => entry.inputType === 'insertLineBreak'), 'textarea line break inputType expected', textareaInputs);

  return {
    checkbox: { checkedOn, checkedOff, changes: checkChanges.map((entry) => ({ checked: entry.checked, trusted: entry.trusted })) },
    radios,
    select: {
      afterSelectOption,
      selectOptionChangeTrusted: selectOptionChange.trusted,
      afterArrowUp,
      arrowChangeTrusted: arrowChange.trusted,
      arrowInputTrusted: arrowInput.trusted,
      arrowInputType: arrowInput.inputType,
    },
    range: {
      value: rangeValue,
      inputTrusted: inputs.filter((entry) => entry.id === 'range').at(-1).trusted,
    },
    textarea: {
      value: textareaValue,
      inputTypes: textareaInputs.map((entry) => entry.inputType),
      trusted: allTrusted(textareaInputs),
    },
  };
});

const focusTab = pageProbe('interactions/focus-tab', focusTabDoc, async ({ page }) => {
  await page.locator('#first').click();
  const order = [await activeId(page)];
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press('Tab');
    order.push(await activeId(page));
  }
  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.press('Shift+Tab');
    order.push(await activeId(page));
  }

  const log = await readLog(page);
  const focusin = eventsOf(log, 'focusin');
  const focus = eventsOf(log, 'focus');
  const focusout = eventsOf(log, 'focusout');
  const hasFocus = await page.evaluate(() => document.hasFocus());
  const linkFocused = await page.evaluate(() => document.querySelector('#link:focus') !== null);
  const expected = ['first', 'button', 'box', 'last', 'box', 'button', 'first', 'link'];

  assertThat(JSON.stringify(order) === JSON.stringify(expected), 'Tab and Shift+Tab focus order must match the DOM', { order, expected });
  assertThat(hasFocus === true, 'document must hold focus after a real click', hasFocus);
  assertThat(!order.includes('disabled'), 'disabled input must never receive focus', order);
  assertThat(linkFocused === true, '#link must be focused at the end of the sequence', linkFocused);
  assertTrusted(focusin, 'focusin');
  assertTrusted(focusout, 'focusout');
  assertThat(allTrusted(focus), 'focus events must be trusted', focus);

  return {
    order,
    hasFocus,
    linkFocused,
    focusinIds: focusin.map((entry) => entry.id),
    focusoutIds: focusout.map((entry) => entry.id),
    trusted: { focus: allTrusted(focus), focusin: allTrusted(focusin), focusout: allTrusted(focusout) },
    keydowns: keySummary(log, 'keydown'),
  };
});

const pointerScroll = pageProbe('interactions/scroll-hover', pointerScrollDoc, async ({ page }) => {
  // Baseline pointer position: headed windows open under the OS cursor, so the
  // first move would otherwise emit a pointerover for whatever is under it.
  // Move to a known neutral point, wait for that move, then clear the log.
  await page.mouse.move(900, 400);
  await page.waitForFunction(() => window.__log.some((entry) => entry.type === 'mousemove' && entry.clientX === 900 && entry.clientY === 400));
  await page.evaluate(() => { window.__log = []; });

  const hoverTarget = page.locator('#hover-target');
  await hoverTarget.hover();
  const hoverMatches = await page.evaluate(() => document.querySelector('#hover-target:hover') !== null);

  const clickTarget = page.locator('#click-target');
  await clickTarget.click();
  await clickTarget.dblclick();
  const beforeWheel = await readLog(page);
  const clickEntries = eventsOf(beforeWheel, 'click');
  const dblclickEntries = eventsOf(beforeWheel, 'dblclick');
  const pointerDown = eventsOf(beforeWheel, 'pointerdown').at(-1);
  assertThat(pointerDown, 'a pointerdown must be observed');
  assertThat(eventsOf(beforeWheel, 'wheel').length === 0, 'no wheel must occur before the wheel step');

  const viewport = await page.evaluate(() => ({ innerWidth, innerHeight, scrollHeight: document.documentElement.scrollHeight }));
  await page.mouse.wheel(0, 200);
  const scrollY = await page.evaluate(() => window.__settledScroll());
  const afterScroll = await readLog(page);
  const wheel = eventsOf(afterScroll, 'wheel').at(-1);
  const scroll = eventsOf(afterScroll, 'scroll').at(-1);
  assertThat(wheel && scroll, 'wheel and scroll events must be observed', { wheel, scroll });

  await page.locator('#bottom').scrollIntoViewIfNeeded();
  const bottomInViewport = await page.evaluate(() => {
    const rect = document.getElementById('bottom').getBoundingClientRect();
    return rect.top >= 0 && rect.top < innerHeight;
  });
  await page.locator('#bottom').hover();
  const bottomHover = await page.evaluate(() => document.querySelector('#bottom:hover') !== null);

  const rawPointerOver = eventsOf(afterScroll, 'pointerover').map((entry) => ({
    id: entry.id,
    pointerType: entry.pointerType,
    trusted: entry.trusted,
    x: entry.clientX,
    y: entry.clientY,
    scrollY: entry.scrollY,
  }));
  // Headed Chromium can re-dispatch pointerover for an unchanged target around
  // each synthetic press when the browser has earlier window history; collapse
  // consecutive duplicates for the contract and keep the raw list diagnostic.
  const pointerOver = [];
  for (const entry of rawPointerOver) {
    if (!pointerOver.length || pointerOver.at(-1).id !== entry.id) {
      pointerOver.push({ id: entry.id, pointerType: entry.pointerType, trusted: entry.trusted, scrollY: entry.scrollY });
    }
  }

  assertThat(hoverMatches === true, 'hover must set the CSS :hover state', hoverMatches);
  assertThat(clickEntries.length === 3 && clickEntries.at(-1).detail === 2 && clickEntries.at(-1).id === 'click-target', 'click/dblclick sequence must match', clickEntries);
  assertThat(dblclickEntries.length === 1 && dblclickEntries[0].detail === 2, 'one dblclick with detail 2 expected', dblclickEntries);
  assertThat(pointerDown.pointerType === 'mouse' && pointerDown.button === 0, 'pointerdown must be a primary mouse button', pointerDown);
  assertThat(wheel.deltaY === 200 && wheel.deltaMode === 0 && wheel.trusted === true, 'wheel must deliver the requested delta', wheel);
  assertThat(scrollY > 0, 'wheel must scroll the document', { scrollY, viewport });
  assertThat(scroll.trusted === true, 'scroll event must be trusted', scroll);
  assertThat(bottomInViewport === true && bottomHover === true, 'scrollIntoViewIfNeeded must reveal and allow hover', { bottomInViewport, bottomHover });
  assertTrusted(clickEntries, 'click');
  assertTrusted(dblclickEntries, 'dblclick');
  assertTrusted(rawPointerOver, 'pointerover');
  assertThat(JSON.stringify(pointerOver.map((entry) => entry.id)) === JSON.stringify(['hover-target', 'click-target', 'spacer']), 'hover/click/scroll must produce the expected pointerover targets', pointerOver);
  assertThat(pointerOver.every((entry) => entry.trusted === true), 'pointerover transitions must be trusted', pointerOver);
  assertTrusted(eventsOf(afterScroll, 'mouseover'), 'mouseover');

  return {
    hoverMatches,
    bottomHover,
    clickCount: clickEntries.length,
    clickDetails: clickEntries.map((entry) => ({ id: entry.id, detail: entry.detail, button: entry.button, trusted: entry.trusted })),
    dblclick: { count: dblclickEntries.length, detail: dblclickEntries[0].detail, trusted: dblclickEntries[0].trusted },
    pointerDown: { pointerType: pointerDown.pointerType, button: pointerDown.button, trusted: pointerDown.trusted },
    pointerOver,
    pointerOverRaw: rawPointerOver,
    wheel: { deltaY: wheel.deltaY, deltaMode: wheel.deltaMode, trusted: wheel.trusted },
    scrollY,
    scrollTrusted: scroll.trusted,
    viewport,
    bottomInViewport,
  };
}, {
  diagnostics: {
    pointerOverRaw: 'headed X11 window-history boundary dispatch duplicates vs semantic target transitions tested separately',
  },
});

const dragDrop = pageProbe('interactions/drag-drop', dragDropDoc, async ({ page }) => {
  const dragSource = page.locator('#drag-source');
  const dropTarget = page.locator('#drop-target');
  await dragSource.dragTo(dropTarget);

  const log = await readLog(page);
  const dropState = await page.evaluate(() => ({
    text: window.__drop.text,
    types: window.__drop.types,
    dropped: window.__drop.dropped,
    textContent: document.getElementById('drop-target').textContent,
    marker: document.getElementById('drop-target').dataset.dropped || null,
  }));
  const types = ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'];

  assertThat(dropState.text === 'cloakium-payload', 'drop must receive the dragstart payload', dropState);
  assertThat(dropState.types === 'text/plain', 'drop must receive text/plain', dropState);
  assertThat(dropState.dropped === true && dropState.marker === 'yes', 'drop handler must run', dropState);
  assertThat(dropState.textContent === 'Dropped cloakium-payload', 'drop must update the target content', dropState);
  for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) {
    assertTrusted(eventsOf(log, type), type);
  }

  return {
    dropState,
    eventCounts: Object.fromEntries(types.map((type) => [type, eventsOf(log, type).length])),
    trusted: Object.fromEntries(types.map((type) => [type, allTrusted(eventsOf(log, type))])),
    dropTargetIds: eventsOf(log, 'drop').map((entry) => entry.id),
  };
});


export const inputProbes = [typing, shortcuts, formControls, focusTab, pointerScroll, dragDrop];
