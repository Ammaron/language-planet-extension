// Shows each packaged notice in full, read from the files that ship in the extension.
// Page strings are localized by shared/i18n.js, which applies itself on extension pages.
for (const section of document.querySelectorAll('.license[data-file]')) {
  const pre = section.querySelector('pre');
  fetch(section.getAttribute('data-file'))
    .then(response => (response.ok ? response.text() : Promise.reject(new Error('missing'))))
    .then((text) => { pre.textContent = text; })
    .catch(() => { pre.textContent = section.getAttribute('data-file'); });
}
